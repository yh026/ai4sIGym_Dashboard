import { canWrite } from '../shared/package.mjs';
import { inventory, read, requireOk } from './store.mjs';

export const releaseRoot = 'private-releases/v1/';
export const snapshotKey = (operation, root = releaseRoot) => root + 'snapshots/' + operation;
export const isRollback = (mode) => mode === 'rollback-demo' || mode === 'rollback-site';

function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (p) => before[p]?.sha1 !== after[p]?.sha1 || before[p]?.size !== after[p]?.size,
  );
}

// Only the committed operation list establishes history membership. A job that
// lost the version check may also have written an immutable snapshot.
async function retained(db, { base, state, root = releaseRoot }) {
  if (!state.operations.length) return [];
  const ids = state.operations;
  const result = [];
  for (let end = ids.length - 1; end > 0; end -= 12) {
    const start = Math.max(0, end - 12);
    const batch = await Promise.all(
      ids.slice(start, end).map(async (id, offset) => {
        const saved = await read(db, snapshotKey(id, root));
        if (saved) return saved;
        // Older releases saved their complete Production input with the next job.
        const [receipt, successor] = await Promise.all([
          read(db, root + 'receipts/' + id),
          read(db, root + 'inputs/' + ids[start + offset + 1]),
        ]);
        requireOk(
          receipt?.production?.id && successor?.released,
          'A retained release record is incomplete.',
          409,
        );
        return { revision: receipt.production.id, created: receipt.created, released: successor.released };
      }),
    );
    result.push(...batch.reverse());
  }
  result.push({
    revision: state.publicId,
    created: base.deployment.published_at || null,
    released: {},
    baseline: true,
  });
  return result;
}

function demoHeads(ctx, snapshot, slug, before) {
  const heads = { ...ctx.state.released };
  const old = snapshot.released[slug];
  const current = heads[slug];
  const overlay = { ...old?.overlay };
  const demo = ctx.catalog[slug];
  // Keep shared files in use by the current site. A conflicting shared revision
  // cannot be restored on behalf of just one demo.
  for (const [p, file] of Object.entries(overlay)) {
    if (!canWrite(demo, p) && before[p] && before[p].sha1 !== file.sha1) return null;
  }
  for (const [p, file] of Object.entries(current?.overlay || {})) {
    if (!canWrite(demo, p) && !overlay[p]) overlay[p] = file;
  }
  if (old || Object.keys(overlay).length) {
    heads[slug] = { ...(old || current), overlay, removed: old?.removed || [] };
  } else delete heads[slug];
  return heads;
}

function demosForPaths(ctx, paths, oldHeads, newHeads) {
  return Object.keys(ctx.catalog).filter((s) =>
    paths.some(
      (p) =>
        canWrite(ctx.catalog[s], p) ||
        Object.hasOwn(ctx.catalog[s].files, p) ||
        Object.hasOwn(oldHeads[s]?.overlay || {}, p) ||
        Object.hasOwn(newHeads[s]?.overlay || {}, p),
    ),
  );
}

function plan(ctx, snapshot, mode, slug, before) {
  const single = mode === 'rollback-demo';
  const heads = single ? demoHeads(ctx, snapshot, slug, before) : snapshot.released;
  if (!heads) return null;
  const next = inventory(ctx.base, heads);
  const paths = changes(before, next).sort();
  if (!paths.length) return null;
  if (single) {
    const historical = inventory(ctx.base, snapshot.released);
    if (changes(historical, next).some((p) => canWrite(ctx.catalog[slug], p))) return null;
    if (paths.some((p) => !canWrite(ctx.catalog[slug], p) && (before[p] || !p.startsWith('/assets/'))))
      return null;
  }
  const slugs = single ? [slug] : demosForPaths(ctx, paths, ctx.state.released, heads);
  requireOk(slugs.length, 'The historical changes could not be matched to a registered demo.', 409);
  return {
    heads,
    key: JSON.stringify(paths.map((p) => [p, next[p]?.sha1, next[p]?.size])),
    option: {
      revision: snapshot.revision,
      created: snapshot.created,
      baseline: Boolean(snapshot.baseline),
      changedFiles: paths.length,
      slugs,
    },
  };
}

export async function rollbackOptions(db, ctx, slug) {
  const before = inventory(ctx.base, ctx.state.released),
    options = { site: [], demo: [] };
  const seen = { site: new Set(), demo: new Set() };
  for (const snapshot of await retained(db, ctx)) {
    for (const scope of ['site', 'demo']) {
      const result = plan(ctx, snapshot, 'rollback-' + scope, slug, before);
      if (result && !seen[scope].has(result.key)) {
        options[scope].push(result.option);
        seen[scope].add(result.key);
      }
    }
  }
  return options;
}

export async function prepareRollback(db, ctx, mode, slug, target) {
  requireOk(
    typeof target === 'string' && /^[a-f0-9]{24}$/.test(target),
    'Choose a retained release version.',
  );
  const snapshot = (await retained(db, ctx)).find((candidate) => candidate.revision === target);
  requireOk(snapshot, 'This version is outside the retained release history.', 404);
  const result = plan(ctx, snapshot, mode, slug, inventory(ctx.base, ctx.state.released));
  requireOk(result, 'Choose a different retained version compatible with this rollback scope.', 409);
  const preservedSlugs =
    mode === 'rollback-demo'
      ? demosForPaths(
          ctx,
          changes(inventory(ctx.base, snapshot.released), inventory(ctx.base, result.heads)),
          snapshot.released,
          result.heads,
        ).filter((s) => s !== slug)
      : [];
  // Only a Preview following the current Production contents can advance with
  // the rollback. An independent or newer review draft keeps its fixed version.
  const syncedSlugs = result.option.slugs.filter((s) => {
    if (ctx.catalog[s].previewOnly && !result.heads[s]) return false;
    const active = ctx.state.synced[s],
      production = ctx.state.released[s];
    if (!active || !production || ctx.previews[s]?.id !== active.id) return false;
    return !changes(inventory(ctx.base, { [s]: production }), inventory(ctx.base, { [s]: active })).length;
  });
  return {
    heads: result.heads,
    catalogFiles: snapshot.catalogFiles || {},
    details: {
      scope: mode === 'rollback-site' ? 'site' : 'demo',
      fromRevision: ctx.state.revision,
      targetRevision: target,
      changedFiles: result.option.changedFiles,
      affectedSlugs: result.option.slugs,
      syncedSlugs,
      preservedSlugs,
    },
  };
}
