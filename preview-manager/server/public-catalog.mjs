import { createHash } from 'node:crypto';
import rendererTools from '../../google-apps-script/publishing-controls/production-release/catalog-renderer.cjs';
import artifactTools from '../../google-apps-script/publishing-controls/production-release/artifact-renderer.cjs';
import { inventory, requireOk } from './store.mjs';

function registration(demo, date, order) {
  return {
    demo_id: 'demo-' + demo.slug,
    entry_type: 'project',
    slug: demo.slug,
    title: demo.title,
    department_id: demo.department_id,
    status: 'Live',
    public_page_permission: 'Public',
    featured: false,
    sort_order: order,
    card_summary: '',
    subtopic_id: '',
    task_ids: [],
    method_ids: [],
    data_type_ids: [],
    instrument_type_ids: [],
    audience: '',
    data_source_label: '',
    card_asset: null,
    date_added: date,
    pages: Object.entries(demo.pages).map(([role, page]) => ({
      role,
      state: 'Ready',
      path: page.path.slice(1),
    })),
  };
}
let deploymentSources;
export function useCatalogSources(sources) {
  deploymentSources = sources;
}
export function publicRenderer(base) {
  return rendererTools.loadCatalogRenderer(
    process.cwd(),
    base.production_manifest.release.renderer_digest,
    deploymentSources,
  );
}
export async function releaseCatalogFiles({ base, catalog, state, nextHeads, job, load, remember }) {
  const baseline = inventory(base, {}, { sources: true });
  const newSlugs = (heads) =>
    Object.keys(heads)
      .filter((s) => catalog[s].previewOnly)
      .sort();
  const added = newSlugs(nextHeads),
    previous = newSlugs(state.released);
  const changed = JSON.stringify(added) !== JSON.stringify(previous);
  let overlays = { ...state.catalogFiles };
  let manifest = structuredClone(base.production_manifest);
  if (added.length) {
    if (!changed && overlays['/manifest.json']) {
      manifest = await (await load({ ...overlays['/manifest.json'], path: '/manifest.json' }))
        .text()
        .then(JSON.parse);
    } else {
      const order = Math.max(0, ...manifest.demos.map((d) => d.sort_order));
      const additions = added.map((s, i) =>
        registration(
          catalog[s],
          nextHeads[s].firstPublished || state.released[s]?.firstPublished || job.created,
          order + i + 1,
        ),
      );
      const rendered = publicRenderer(base).render(manifest, job.created, additions);
      manifest = rendered.manifest;
      const home = await load({ ...baseline['/index.html'], path: '/index.html' });
      const original = Buffer.from(await home.arrayBuffer());
      const withMap = artifactTools.restoreMapMarkup(rendered.files.get('index.html'), original);
      rendered.files.set('index.html', artifactTools.restoreIntroductionMarkup(withMap, original));
      overlays = {};
      for (const [name, bytes] of rendered.files) await add('/' + name, bytes);
    }
  } else overlays = {};
  const release = {
    mode: 'netlify-management-desk',
    operation: job.id,
    previous_deploy_id: job.revision,
    action: job.releaseMode,
    demos: job.slugs,
    created: job.created,
  };
  manifest.generated = job.created;
  manifest.release = { ...release, publication_overrides: base.production_publication_overrides || [] };
  await add('/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  await add(
    '/deploy-receipt.json',
    Buffer.from(
      JSON.stringify(
        {
          ...release,
          manifest_sha1: overlays['/manifest.json']?.sha1 || baseline['/manifest.json'].sha1,
          publication_overrides: base.production_publication_overrides || [],
        },
        null,
        2,
      ) + '\n',
    ),
  );
  return overlays;
  async function add(name, bytes) {
    requireOk(baseline[name], 'The catalog renderer returned an unregistered site page: ' + name, 409);
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (baseline[name].sha1 === hash) {
      delete overlays[name];
      return;
    }
    overlays[name] = { sha1: hash, size: bytes.length };
    await remember(hash, new Blob([bytes]));
  }
}
