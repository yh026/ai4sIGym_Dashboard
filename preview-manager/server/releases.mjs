import { reserveProduction, finishProduction } from './production.mjs';
import { releaseCatalogFiles } from './public-catalog.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { canWrite, localReferences, validateChanges, validateDependencies } from '../shared/package.mjs';
import { deployFileBlob, materializeDraft, protectedSite, uploadedBlob, verifyBlob } from './native.mjs';
import { isRollback, prepareRollback, releaseRoot, rollbackOptions, snapshotKey } from './rollback.mjs';
import {
  IMPORTED_PREVIEW,
  SITE,
  ORIGIN,
  PUBLIC_ROOT,
  PUBLIC_STATE,
  effectivePreviews,
  OWNER,
  currentHeads,
  getJob,
  inventory,
  metadata,
  previewCatalog,
  read,
  requireOk,
} from './store.mjs';

const versionKey = (root, slug, id) => root + 'versions/' + slug + '/' + id;
const fixedId = /^[a-f0-9]{24}$/;
const isText = (path) => /\.(?:html?|css)$/i.test(path);
const originOf = (id) => 'https://' + id + '--aisigym.netlify.app';
const assertOwner = (who) =>
  requireOk(who?.owner && who.id === OWNER, 'Only the owner can publish or restore releases.', 403);
const pagesAt = (id, demo) =>
  Object.fromEntries(
    Object.entries(demo.pages).map(([role, p]) => [
      role,
      originOf(id) + p.path.split('/').map(encodeURIComponent).join('/'),
    ]),
  );
const visible = (head) => ({
  id: head.id,
  slug: head.slug,
  pages: head.pages,
  url: head.url,
  created: head.created,
});

async function context(db, onlySlug, target) {
  const live = target === 'production';
  const root = live ? PUBLIC_ROOT : releaseRoot;
  const { base, catalog, privateHeads } = await previewCatalog(db);
  if (onlySlug !== undefined) requireOk(Object.hasOwn(catalog, onlySlug), 'Choose a registered demo.', 404);
  const [record, upstream] = await Promise.all([
    db.getWithMetadata(root + 'state', { type: 'json' }),
    currentHeads(db, onlySlug === undefined ? Object.keys(catalog) : [onlySlug], privateHeads),
  ]);
  const publicId = base.deployment.deploy_id;
  const state = record?.data || { publicId, revision: publicId, released: {}, synced: {}, operations: [] };
  requireOk(
    state.publicId === publicId,
    'The registered public baseline changed. Refresh the release workspace.',
    409,
  );
  if (live) requireOk(state.connection?.site === SITE, 'Production has not been connected.', 409);
  const previews = effectivePreviews(upstream, state, publicId);
  return { base, catalog, record, state, upstream, previews, live, root };
}

async function pinnedHead(db, ctx, slug, value) {
  requireOk(
    Object.hasOwn(ctx.catalog, slug) && typeof value === 'string',
    'Choose a registered demo and a fixed Preview.',
  );
  let id = value.trim();
  if (!fixedId.test(id)) {
    let u, pathname;
    try {
      u = new URL(id);
      pathname = decodeURIComponent(u.pathname);
    } catch {
      requireOk(false, 'Paste a fixed Preview link or its deployment ID.');
    }
    id = u.hostname.split('--')[0];
    const routes = Object.values(ctx.catalog[slug].pages).map((p) =>
      p.path.replace(/(?:\/index)?\.html$|\/$/, ''),
    );
    const current = pathname.replace(/(?:\/index)?\.html$|\/$/, '');
    requireOk(
      fixedId.test(id) &&
        u.origin === originOf(id) &&
        !u.username &&
        !u.password &&
        (u.pathname === '/' || routes.includes(current)),
      'This fixed Preview link does not belong to the selected demo.',
    );
  }
  if (ctx.previews[slug]?.id === id) return ctx.previews[slug];
  if (ctx.upstream[slug]?.id === id) return ctx.upstream[slug];
  const [normal, archived, imported] = await Promise.all([
    read(db, 'versions/' + slug + '/' + id),
    read(db, versionKey(ctx.root, slug, id)),
    read(db, IMPORTED_PREVIEW),
  ]);
  const committed = archived && ctx.state.operations.includes(archived.releaseId) ? archived : null;
  const found = [normal, committed, imported?.heads?.[slug]].find((h) => h?.id === id && h.slug === slug);
  requireOk(
    found && found.production === ctx.base.deployment.deploy_id,
    'This demo has no registered Preview with that version.',
    404,
  );
  return found;
}

export async function reviewedPreview(db, who, slug, value, target) {
  assertOwner(who);
  const ctx = await context(db, slug, target);
  return { preview: visible(await pinnedHead(db, ctx, slug, value)) };
}

function filesForDirectRelease(ctx, slug) {
  const released = ctx.state.released;
  const first = ctx.catalog[slug].previewOnly && !released[slug] && ctx.previews[slug];
  return inventory(ctx.base, first ? { ...released, [slug]: first } : released);
}

export async function releaseState(db, who, slug, pinned, receiptId, target, includeHistory = false) {
  assertOwner(who);
  const ctx = await context(db, undefined, target),
    { base, state, root } = ctx;
  const selected = slug || Object.keys(ctx.catalog)[0];
  requireOk(Object.hasOwn(ctx.catalog, selected), 'Choose a registered demo.', 404);
  const currentPreviewId = ctx.previews[selected]?.id || state.publicId;
  if (pinned) ctx.previews[selected] = await pinnedHead(db, ctx, selected, pinned);
  const catalog = Object.fromEntries(
    Object.entries(ctx.catalog).map(([s, d]) => [
      s,
      {
        slug: s,
        title: d.title,
        pages: d.pages,
        readOnlyPaths: d.readOnlyPaths,
        writableExternalPaths: d.writableExternalPaths,
        ...(d.previewOnly && { previewOnly: true }),
      },
    ]),
  );
  const compact = (heads) => Object.fromEntries(Object.entries(heads).map(([s, h]) => [s, visible(h)]));
  const files = filesForDirectRelease(ctx, selected);
  const receiptIds = state.operations.slice(-12).reverse();
  if (receiptId && !receiptIds.includes(receiptId) && state.operations.includes(receiptId))
    receiptIds.push(receiptId);
  const receipts = await Promise.all(receiptIds.map((id) => read(db, root + 'receipts/' + id)));
  const archive = [];
  if (ctx.live && (includeHistory || receiptId)) {
    const prior = await read(db, releaseRoot + 'state');
    const ids = prior?.operations || [];
    const shown = ids.slice(-12).reverse();
    if (ids.includes(receiptId) && !shown.includes(receiptId)) shown.push(receiptId);
    archive.push(
      ...(await Promise.all(shown.map((id) => read(db, releaseRoot + 'receipts/' + id)))).filter(Boolean),
    );
  }
  return {
    archive,
    target: ctx.live ? 'production' : 'rehearsal',
    pending: state.pending || null,
    production: state.publicId,
    revision: state.revision,
    productionUrl: ctx.live ? ORIGIN : state.operations.length ? originOf(state.revision) : null,
    selected,
    currentPreviewId,
    catalog,
    previews: compact(ctx.previews),
    reviewPreviews: compact(ctx.live ? ctx.previews : ctx.upstream),
    released: compact(state.released),
    files,
    receipts: receipts.filter(Boolean),
    rollback: await rollbackOptions(db, ctx, selected),
  };
}

export async function beginRelease(db, who, body = {}, target) {
  assertOwner(who);
  const ctx = await context(db, undefined, target),
    { base, catalog, state, previews, upstream, root } = ctx;
  if (ctx.live) {
    requireOk(body.destination === ORIGIN, 'Confirm the public Production destination before submitting.');
    requireOk(!state.pending, 'An earlier Production operation is still pending. Open its receipt.', 409);
  }
  const mode = body.mode;
  requireOk(['promote', 'direct'].includes(mode) || isRollback(mode), 'Choose a release action.');
  if (mode === 'promote')
    requireOk(
      body.selection && typeof body.selection === 'object' && !Array.isArray(body.selection),
      'Choose one or more registered demos.',
    );
  requireOk(
    body.revision === state.revision,
    ctx.live
      ? 'A newer Production release is available. Refresh before submitting.'
      : 'A newer private release is available. Refresh before submitting.',
    409,
  );
  let rollback;
  if (isRollback(mode)) {
    requireOk(Object.hasOwn(catalog, body.slug), 'Choose a registered demo.');
    requireOk(!body.files && !body.remove && !body.selection, 'Rollbacks use files from a retained release.');
    rollback = await prepareRollback(db, ctx, mode, body.slug, body.target);
  }
  const slugs =
    rollback?.details.affectedSlugs || (mode === 'direct' ? [body.slug] : Object.keys(body.selection || {}));
  requireOk(
    slugs.length && slugs.every((s) => Object.hasOwn(catalog, s)),
    'Choose one or more registered demos.',
  );
  const slug = slugs[0],
    files = mode === 'direct' ? body.files : [],
    remove = mode === 'direct' ? (body.remove ?? []) : [];
  requireOk(
    Array.isArray(files) && Array.isArray(remove) && files.length <= 10000,
    'Invalid release file list.',
  );
  const incoming = metadata(files),
    need = [];
  if (mode === 'direct') {
    requireOk(
      (previews[slug]?.id || state.publicId) === body.base,
      'The Preview changed. Refresh before replacing it.',
      409,
    );
    requireOk(incoming.length || remove.length, 'Choose a package to release.');
    const prodFiles = filesForDirectRelease(ctx, slug);
    validateChanges(catalog[slug], incoming, remove, prodFiles);
    const known = new Map(
      [...Object.values(inventory(base, previews)), ...Object.values(prodFiles)].map((f) => [f.sha1, f.size]),
    );
    for (const f of incoming) {
      requireOk(
        !known.has(f.sha1) || known.get(f.sha1) === f.size,
        'The size does not match this file digest: ' + f.path,
        422,
      );
      if (!known.has(f.sha1)) need.push(f.sha1);
      known.set(f.sha1, f.size);
    }
  }
  const selected =
    mode === 'promote'
      ? Object.fromEntries(
          await Promise.all(slugs.map(async (s) => [s, await pinnedHead(db, ctx, s, body.selection[s])])),
        )
      : {};
  const id = randomUUID();
  const job = {
    id,
    slug,
    slugs,
    releaseMode: mode,
    ...(ctx.live
      ? { target: 'production' }
      : { publicRevision: (await read(db, PUBLIC_STATE))?.revision || state.publicId }),
    revision: state.revision,
    production: state.publicId,
    parent: previews[slug]?.id || state.publicId,
    upstream: upstream[slug]?.id || state.publicId,
    actor: who.id,
    created: new Date().toISOString(),
    files: incoming,
    remove,
    need,
    phase: 'uploading',
    ...(rollback && { rollback: rollback.details }),
  };
  await db.setJSON(
    root + 'inputs/' + id,
    {
      released: state.released,
      previews,
      selected,
      ...(rollback && { rollbackHeads: rollback.heads, rollbackCatalogFiles: rollback.catalogFiles }),
    },
    { onlyIfNew: true },
  );
  await db.setJSON('jobs/' + id, job, { onlyIfNew: true });
  return job;
}

function headAt(demo, id, base, overlay, removed, created) {
  const pages = pagesAt(id, demo);
  return {
    slug: demo.slug,
    id,
    production: base.deployment.deploy_id,
    created,
    pages,
    url: pages.insight,
    overlay,
    removed,
  };
}
function changedHead(old, job) {
  const overlay = { ...(old?.overlay || {}) },
    removed = new Set(old?.removed || []);
  for (const p of job.remove) {
    delete overlay[p];
    removed.add(p);
  }
  for (const { path, sha1, size } of job.files) {
    overlay[path] = { sha1, size };
    removed.delete(path);
  }
  return { id: old?.id || job.production, overlay, removed: [...removed] };
}

// Apply the same public TBB navigation and download policy recorded in the
// Production baseline, without importing its private notebook artifacts.
async function forPublication(base, demo, source, load, remember) {
  const overlay = { ...source.overlay },
    removed = new Set(source.removed);
  if (
    base.production_publication_overrides?.some(
      (o) => o.id === 'hide-tbb-notebook-resources-v1' && o.demo_slug === demo.slug,
    )
  ) {
    const prefix = '/demos/' + demo.slug + '/';
    const hidden = (p) =>
      p.startsWith(prefix) && /^(?:resources\/|workflow-resources(?:\.|\/|$))/i.test(p.slice(prefix.length));
    for (const p of Object.keys(overlay))
      if (hidden(p)) {
        delete overlay[p];
      }
    for (const p of Object.keys(demo.files)) if (hidden(p)) removed.add(p);
    for (const { path } of Object.values(demo.pages)) {
      if (!overlay[path]) continue;
      const file = { path, ...overlay[path], sourceDeploy: source.id };
      const body = await (await load(file)).text();
      const href = posix.relative(posix.dirname(path), prefix + 'workflow-resources.html');
      const anchor = '<a href="' + href + '">Notebook &amp; skills</a>';
      if (!body.includes(anchor)) continue;
      const blob = new Blob([body.replaceAll(anchor, '')]);
      const sha1 = createHash('sha1')
        .update(new Uint8Array(await blob.arrayBuffer()))
        .digest('hex');
      overlay[path] = { sha1, size: blob.size };
      await remember(sha1, blob);
    }
  }
  for (const p of Object.keys(overlay)) {
    requireOk(
      canWrite(demo, p) ||
        (p.startsWith('/assets/') && !base.files.some((f) => f.path === p && f.sha1 !== overlay[p].sha1)),
      'The reviewed version changes a file outside this demo: ' + p,
      409,
    );
  }
  for (const p of removed)
    requireOk(canWrite(demo, p), 'The reviewed version removes a file outside this demo: ' + p, 409);
  return { ...source, overlay, removed: [...removed] };
}

function pathChanges(before, after) {
  return {
    updated: Object.keys(after).filter((p) => after[p].sha1 !== before[p]?.sha1),
    removed: Object.keys(before).filter((p) => !after[p]),
  };
}
// A shared path must have the same bytes for every selected review. Keep
// paths belonging to another released demo at the version already in use.
function verifyReviewedFiles(base, catalog, selected, released, before, after) {
  const { updated, removed } = pathChanges(before, after);
  const changed = [...updated, ...removed];
  const baseline = inventory(base, {});
  const same = (a, b) => a?.sha1 === b?.sha1 && a?.size === b?.size;
  for (const [slug, demo] of Object.entries(catalog)) {
    const head = released[slug];
    const removals = new Set(head?.removed);
    const reviewing = selected.includes(slug);
    const paths = reviewing ? new Set([...changed, ...Object.keys(head.overlay), ...removals]) : changed;
    for (const p of paths) {
      const overlay = head?.overlay?.[p];
      if (!overlay && !removals.has(p) && !Object.hasOwn(demo.files, p) && !canWrite(demo, p)) continue;
      const expected = reviewing ? (removals.has(p) ? undefined : (overlay ?? baseline[p])) : before[p];
      requireOk(
        same(expected, after[p]),
        'The selected Previews conflict with the files for ' + slug + ': ' + p,
        409,
      );
    }
  }
  return {
    added: updated.filter((p) => !before[p]).length,
    replaced: updated.filter((p) => before[p]).length,
    removed: removed.length,
  };
}
async function checkDependencies(before, after, load) {
  const { updated, removed } = pathChanges(before, after);
  const changedText = new Set(updated.filter(isText));
  for (const path of changedText) {
    const file = { ...after[path], path };
    const blob = await load(file);
    await verifyBlob(blob, file);
    await validateDependencies([{ ...file, blob }], after);
  }
  if (!removed.length) return;
  const deleted = new Set(removed);
  for (const [path, f] of Object.entries(after)) {
    if (!isText(path) || changedText.has(path)) continue;
    const blob = await load({ ...f, path });
    for (const ref of localReferences(await blob.text(), path)) {
      const url = new URL(ref, 'https://desk.invalid' + path);
      if (url.origin !== 'https://desk.invalid') continue;
      const route = decodeURIComponent(url.pathname).replace(/\/$/, '/index.html');
      const alternatives = [route, route + '/index.html', route + '.html'];
      requireOk(
        !alternatives.some((p) => deleted.has(p)) || alternatives.some((p) => after[p]),
        'A removed file is still linked by ' + path + ': ' + ref,
        409,
      );
    }
  }
}

function transferView(transfer, slugs, catalog, files) {
  const present = slugs.filter((s) => files[catalog[s].pages.insight.path]);
  const demoPages = Object.fromEntries(present.map((s) => [s, pagesAt(transfer.id, catalog[s])]));
  const pages = demoPages[present[0]] || {};
  return { ...transfer, demoPages, pages, url: pages.insight || null };
}

export async function runRelease(db, token, id, sources = new Map()) {
  let job = await getJob(db, id);
  requireOk(job.releaseMode && job.actor === OWNER, 'This job is not an owner release.', 403);
  if (job.phase === 'ready') return job.result;
  const lockKey = 'workers/' + id,
    nonce = randomUUID();
  const previous = await db.getWithMetadata(lockKey, { type: 'json' });
  requireOk(!previous || previous.data.until < Date.now(), 'This release is already processing.', 409);
  requireOk(
    (
      await db.setJSON(
        lockKey,
        { nonce, until: Date.now() + 18 * 60000 },
        previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true },
      )
    ).modified,
    'This release is already processing.',
    409,
  );
  const save = async (patch) => {
    job = { ...job, ...patch };
    await db.setJSON('jobs/' + id, job);
  };
  const finish = async (receipt) => {
    await save({ phase: 'ready', result: receipt, error: null });
    try {
      const { blobs } = await db.list({ prefix: 'parts/' + id + '/' });
      await Promise.all(blobs.map((p) => db.delete(p.key)));
    } catch {
      await save({ cleanupPending: true });
    }
    return receipt;
  };
  try {
    const ctx = await context(db, undefined, job.target),
      { base, catalog, state, root } = ctx;
    const expectedPublic = ctx.live ? job.revision : job.publicRevision || job.production;
    if (state.operations.includes(id)) return await finish(await read(db, root + 'receipts/' + id));
    if (ctx.live && state.pending === id) return await finish(await finishProduction(db, token, job, save));
    requireOk(!state.pending, 'Another Production operation is pending.', 409);
    requireOk(
      job.revision === state.revision,
      'Another release completed first. Refresh and review the current revision.',
      409,
    );
    requireOk(
      (await protectedSite(token)).published_deploy.id === expectedPublic &&
        state.publicId === job.production,
      'Public Production changed. Refresh before releasing.',
      409,
    );
    const input = await read(db, root + 'inputs/' + id),
      direct = job.releaseMode === 'direct',
      rollback = job.rollback;
    requireOk(input, 'The fixed release inputs are missing.', 409);
    if (direct)
      requireOk(
        (ctx.previews[job.slug]?.id || state.publicId) === job.parent,
        'The selected Preview changed. Refresh before synchronizing.',
        409,
      );
    const follow = direct ? [job.slug] : rollback?.syncedSlugs || [];
    if (rollback) {
      requireOk(
        input.rollbackHeads && follow.every((s) => ctx.previews[s]?.id === input.previews[s]?.id),
        'A pending Preview changed. Refresh before restoring this release.',
        409,
      );
    }
    const before = inventory(base, input.released, { sources: true }),
      previews = inventory(base, input.previews, { sources: true });
    const originals = new Map();
    for (const files of [previews, before])
      for (const [path, f] of Object.entries(files)) originals.set(f.sha1, { ...f, path });
    for (const head of Object.values(input.selected))
      for (const [path, f] of Object.entries(head.overlay))
        originals.set(f.sha1, { ...f, path, sourceDeploy: head.id });
    if (rollback)
      for (const head of Object.values(input.rollbackHeads))
        for (const [path, f] of Object.entries(head.overlay))
          if (!originals.has(f.sha1))
            originals.set(f.sha1, { ...f, path, sourceDeploy: rollback.targetRevision });
    const incoming = new Map(job.files.map((f) => [f.sha1, f]));
    const generated = new Map();
    const load = async (f) => {
      if (generated.has(f.sha1)) return generated.get(f.sha1);
      if (sources.has(f.sha1)) return sources.get(f.sha1);
      if (job.need.includes(f.sha1)) return uploadedBlob(db, job, incoming.get(f.sha1));
      const stored = await db.get('validated-text/' + f.sha1, { type: 'blob' });
      if (stored) return stored;
      const original = originals.get(f.sha1) || f;
      return deployFileBlob(token, original.sourceDeploy || job.production, original.path, {
        ...original,
        sha1: f.sha1,
        size: f.size,
      });
    };
    const remember = async (hash, blob) => {
      generated.set(hash, blob);
      await db.set('validated-text/' + hash, blob, { onlyIfNew: true });
    };
    const nextHeads = { ...(rollback ? input.rollbackHeads : input.released) };
    if (!rollback)
      for (const s of job.slugs) {
        const previous = input.released[s] || (catalog[s].previewOnly ? input.previews[s] : null);
        const source = direct ? changedHead(previous, job) : input.selected[s];
        nextHeads[s] = await forPublication(base, catalog[s], source, load, remember);
      }
    const next = inventory(base, nextHeads, { sources: true });
    const fileChanges =
      job.releaseMode === 'promote'
        ? verifyReviewedFiles(base, catalog, job.slugs, nextHeads, before, next)
        : null;
    let catalogFiles = {};
    if (ctx.live) {
      catalogFiles =
        job.releaseMode === 'rollback-site'
          ? input.rollbackCatalogFiles
          : await releaseCatalogFiles({ base, catalog, state, nextHeads, job, load, remember });
      requireOk(catalogFiles, 'The retained site catalog is missing.', 409);
    }
    Object.assign(before, state.catalogFiles || {});
    Object.assign(next, catalogFiles);
    await checkDependencies(before, next, load);
    const stage = async (name, files, fetchFile, slugs = job.slugs) => {
      if (job[name]?.completed) return job[name].completed;
      const completed = await materializeDraft({
        token,
        title: 'Gym private release ' + id + ' ' + name,
        next: files,
        publicId: expectedPublic,
        probePath: catalog[slugs[0]].pages.insight.path,
        load: fetchFile,
        incoming: job.files.filter((f) => files[f.path]?.sha1 === f.sha1),
        hasNewFiles: name === 'productionDraft' && job.need.length > 0,
        progress: job[name],
        checkpoint: (patch) => save({ phase: 'processing', [name]: { ...job[name], ...patch } }),
      });
      const result = transferView(completed, slugs, catalog, files);
      await save({ [name]: { ...job[name], completed: result } });
      return result;
    };
    const production = await stage('productionDraft', next, load);
    // A native match can skip a PUT even for content not yet known to this desk.
    // Count received bytes only after checking the submitted file itself.
    const transferred = new Set(production.uploadLog.map((f) => f.sha1));
    for (const hash of job.need)
      if (!transferred.has(hash)) {
        const file = incoming.get(hash);
        await verifyBlob(await load(file), file);
      }
    const released = { ...nextHeads },
      synced = { ...state.synced };
    for (const s of job.slugs) {
      const h = nextHeads[s];
      if (!h && catalog[s].previewOnly) {
        delete released[s];
        delete synced[s];
        continue;
      }
      released[s] = headAt(
        catalog[s],
        production.id,
        base,
        h?.overlay || {},
        h?.removed || [],
        production.created,
      );
    }
    if (ctx.live)
      for (const s of job.slugs) {
        if (released[s] && catalog[s].previewOnly)
          released[s].firstPublished =
            nextHeads[s]?.firstPublished || state.released[s]?.firstPublished || job.created;
      }
    let preview = null;
    if (follow.length) {
      const previewHeads = { ...input.previews };
      for (const s of follow) previewHeads[s] = released[s];
      const prepared = inventory(base, previewHeads, { sources: true });
      for (const p of new Set([...Object.keys(next), ...Object.keys(prepared)]))
        if (follow.some((s) => canWrite(catalog[s], p) || Object.hasOwn(released[s].overlay, p)))
          requireOk(
            next[p]?.sha1 === prepared[p]?.sha1,
            'A shared file conflicts with the released demo: ' + p,
            409,
          );
      const prodHashes = new Set(Object.values(next).map((f) => f.sha1));
      const loadPreview = async (f) => {
        // Newly sent file bytes are already present in the verified first draft.
        // A second transfer of that video would invalidate the release contract.
        requireOk(
          !(/\.mp4$/i.test(f.path) && prodHashes.has(f.sha1)),
          'Netlify has not made the released video reusable yet. Retry this private release.',
          409,
        );
        return load(f);
      };
      preview = await stage('previewDraft', prepared, loadPreview, follow);
      for (const s of follow) {
        synced[s] = {
          ...headAt(catalog[s], preview.id, base, released[s].overlay, released[s].removed, preview.created),
          upstream: direct ? job.upstream : input.previews[s].upstream,
          releaseId: id,
          verifiedFiles: preview.files,
        };
        await db.setJSON(versionKey(root, s, preview.id), synced[s], { onlyIfNew: true });
      }
    } else if (!rollback && job.slugs.length === 1) {
      const h = input.selected[job.slug];
      preview = {
        ...visible(h),
        origin: originOf(h.id),
        files: h.verifiedFiles ?? null,
        uploadedBytes: 0,
        uploadLog: [],
        demoPages: Object.fromEntries(job.slugs.map((s) => [s, input.selected[s].pages])),
      };
    }
    const receipt = {
      id,
      mode: job.releaseMode,
      slugs: job.slugs,
      created: production.created,
      sourceVersions: Object.fromEntries(Object.entries(input.selected).map(([s, h]) => [s, h.id])),
      ...(fileChanges && {
        sourcePreviews: Object.fromEntries(job.slugs.map((s) => [s, visible(input.selected[s])])),
        fileChanges,
      }),
      channel: job.channel === 'cli' ? 'cli' : 'browser',
      incomingBytes:
        job.channel === 'cli' ? 0 : job.need.reduce((sum, hash) => sum + incoming.get(hash).size, 0),
      incomingFiles: job.channel === 'cli' ? [] : job.need.map((hash) => incoming.get(hash)),
      production,
      preview,
      ...(rollback && {
        rollback: {
          ...rollback,
          preservedPages: Object.fromEntries(
            (rollback.preservedSlugs || []).map((s) => [s, pagesAt(production.id, catalog[s])]),
          ),
        },
      }),
    };
    requireOk(
      (await protectedSite(token)).published_deploy.id === expectedPublic,
      'Production changed while verifying the release.',
      409,
    );
    if (follow.length) {
      const latest = await currentHeads(db, follow);
      requireOk(
        follow.every((s) => (latest[s]?.id || state.publicId) === synced[s].upstream),
        'A newer Preview arrived before synchronization. Refresh and review it.',
        409,
      );
    }
    if (ctx.live) {
      await reserveProduction(db, ctx, { receipt, released, synced, files: next, catalogFiles });
      return await finish(await finishProduction(db, token, job, save));
    }
    await db.setJSON(
      snapshotKey(id),
      { revision: production.id, created: production.created, released },
      { onlyIfNew: true },
    );
    await db.setJSON(root + 'receipts/' + id, receipt, { onlyIfNew: true });
    const won = await db.setJSON(
      root + 'state',
      {
        publicId: state.publicId,
        revision: production.id,
        released,
        synced,
        operations: [...state.operations, id],
      },
      ctx.record ? { onlyIfMatch: ctx.record.etag } : { onlyIfNew: true },
    );
    requireOk(won.modified, 'Another release completed first. Refresh and review the current revision.', 409);
    return await finish(receipt);
  } catch (error) {
    await save({ phase: 'error', error: String(error.message).slice(0, 400) });
    throw error;
  } finally {
    if ((await read(db, lockKey))?.nonce === nonce) await db.delete(lockKey);
  }
}
