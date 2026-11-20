import { catalogFromBaseline, fileMap, localReferences, safePath } from '../shared/package.mjs';
import { api, deployFileBlob, protectedSite } from './native.mjs';
import { IMPORTED_PREVIEW, SITE, currentHeads, productionCatalog, read, requireOk } from './store.mjs';

const roles = ['insight', 'workflow', 'dataset'];
const isText = (path) => /\.(?:html?|css)$/i.test(path);

// Old page links open the original immutable deploy. Future private drafts
// inherit only demo content and the shared assets those pages actually use.
export async function importedCatalog({ base, source, rows, manifest, heads, readText }) {
  const byPath = fileMap(base.files);
  const catalog = catalogFromBaseline(base);
  const legacy = catalogFromBaseline({ production_manifest: manifest, files: rows });
  const files = Object.fromEntries(rows.map(({ path, sha, size }) => [path, { sha1: sha, size }]));
  const imported = {};
  const occupied = new Map();
  for (const head of Object.values(heads)) {
    for (const [path, file] of Object.entries(head.overlay)) occupied.set(path, file.sha1);
    for (const path of head.removed) occupied.set(path, null);
  }
  for (const [slug, demo] of Object.entries(catalog)) {
    if (heads[slug]) continue;
    const old = legacy[slug];
    requireOk(old, 'The old Preview is missing ' + slug + '.', 409);
    const origin = 'https://' + source.id + '--aisigym.netlify.app';
    const pages = {};
    for (const role of roles) {
      const path = old.pages[role]?.path;
      requireOk(
        path && files[path] && demo.pages[role]?.path === path,
        'Unmatched ' + role + ' page for ' + slug + '.',
        409,
      );
      pages[role] = origin + path.split('/').map(encodeURIComponent).join('/');
    }
    const overlay = {};
    const removed = Object.keys(demo.files).filter((path) => !files[path]);
    const add = (path) => {
      if (files[path].sha1 !== byPath[path]?.sha1 || files[path].size !== byPath[path]?.size)
        overlay[path] = files[path];
    };
    for (const path of new Set([...Object.keys(old.files), ...Object.keys(demo.files)])) {
      if (files[path]) add(path);
    }
    const queue = Object.keys(overlay).filter(isText);
    const visited = new Set(queue);
    for (const path of queue) {
      for (const ref of localReferences(await readText(path, files[path]), path)) {
        const target = new URL(ref, origin + path);
        if (target.origin !== origin || !target.pathname.startsWith('/assets/')) continue;
        const shared = safePath(decodeURIComponent(target.pathname));
        requireOk(files[shared], 'Missing referenced Preview asset ' + shared + '.', 409);
        add(shared);
        if (overlay[shared] && isText(shared) && !visited.has(shared)) {
          visited.add(shared);
          queue.push(shared);
        }
      }
    }
    for (const path of [...Object.keys(overlay), ...removed]) {
      const hash = overlay[path]?.sha1 ?? null;
      requireOk(
        !occupied.has(path) || occupied.get(path) === hash,
        'Conflicting Preview ownership for ' + path + '.',
        409,
      );
      occupied.set(path, hash);
    }
    const identical = !removed.length && !Object.keys(overlay).length;
    imported[slug] = {
      slug,
      id: source.id,
      parent: base.deployment.deploy_id,
      production: base.deployment.deploy_id,
      created: source.ready_at || source.created_at,
      executor: 'imported-preview',
      pages,
      url: pages.insight,
      overlay,
      removed,
      ...(identical
        ? {
            carriedReviewVersion:
              base.project_file_index?.[slug]?.content_digest || base.deployment.deploy_id,
          }
        : {}),
    };
  }
  return {
    schema: 1,
    site: SITE,
    sourceDeploy: source.id,
    production: base.deployment.deploy_id,
    heads: imported,
    sourceFiles: rows.length,
    retained: Object.keys(heads).sort(),
  };
}

export async function adoptPreview(db, token, id, apply = false) {
  requireOk(/^[a-f0-9]{24}$/.test(id), 'Specify the fixed deployment ID of the old Preview.');
  const existing = await read(db, IMPORTED_PREVIEW);
  if (existing) {
    requireOk(
      existing.sourceDeploy === id,
      'The old Preview has already been imported from a different deployment.',
      409,
    );
    return { status: 'already imported', record: existing };
  }
  const [{ base, catalog }, site, source] = await Promise.all([
    productionCatalog(db),
    protectedSite(token),
    api(token, '/deploys/' + id),
  ]);
  requireOk(
    site.published_deploy.id === base.deployment.deploy_id,
    'Production has changed since the catalog was registered.',
    409,
  );
  requireOk(
    source.id === id &&
      id !== site.published_deploy.id &&
      source.site_id === SITE &&
      source.state === 'ready' &&
      source.context === 'branch-deploy' &&
      source.branch === 'develop' &&
      !source.draft &&
      !source.published_at,
    'Choose a ready develop branch deployment of this site.',
    409,
  );
  const [gate, rows, heads] = await Promise.all([
    fetch('https://' + id + '--aisigym.netlify.app/', { method: 'HEAD', redirect: 'manual' }),
    api(token, '/deploys/' + id + '/files'),
    currentHeads(db, Object.keys(catalog)),
  ]);
  requireOk([401, 403].includes(gate.status), 'The old Preview must require sign-in.', 409);
  requireOk(
    Array.isArray(rows) &&
      rows.length &&
      rows.every(
        (f) =>
          f.site_id === SITE &&
          f.deploy_id === id &&
          f.path === safePath(f.path) &&
          /^[a-f0-9]{40}$/.test(f.sha) &&
          Number.isSafeInteger(f.size) &&
          f.size >= 0,
      ) &&
      new Set(rows.map((f) => f.path.toLowerCase())).size === rows.length,
    'Invalid source file inventory.',
    409,
  );
  const manifestFile = rows.find((f) => f.path === '/manifest.json');
  requireOk(manifestFile, 'The old Preview has no demo manifest.', 409);
  const readText = async (path, file) => (await deployFileBlob(token, id, path, file)).text();
  const manifest = JSON.parse(await readText(manifestFile.path, { ...manifestFile, sha1: manifestFile.sha }));
  const record = await importedCatalog({ base, source, rows, manifest, heads, readText });
  if (!apply) return { status: 'dry run', record };
  requireOk(
    (await protectedSite(token)).published_deploy.id === record.production,
    'Production changed while reading the Preview.',
    409,
  );
  const saved = await db.setJSON(IMPORTED_PREVIEW, record, { onlyIfNew: true });
  if (!saved.modified) {
    const winner = await read(db, IMPORTED_PREVIEW);
    requireOk(winner?.sourceDeploy === id, 'Another Preview was already imported.', 409);
    return { status: 'already imported', record: winner };
  }
  return { status: 'imported', record };
}
