import { createHash } from 'node:crypto';
import { api, deployFileBlob, protectedSite, publishVerifiedFiles } from './native.mjs';
import {
  SITE,
  ORIGIN,
  OWNER,
  PUBLIC_ROOT,
  PUBLIC_STATE,
  productionCatalog,
  read,
  requireOk,
  inventory,
} from './store.mjs';

const sorted = (rows) => rows.sort(([a], [b]) => a.localeCompare(b, 'en'));

// Handoff only reads the live site. Its single write initializes the desk's private records.
export async function connectProduction(db, token, owner, expected) {
  requireOk(owner.id === OWNER && owner.owner, 'Only the owner can connect Production.', 403);
  const { base } = await productionCatalog(db);
  const site = await protectedSite(token);
  const current = site.published_deploy;
  requireOk(
    current.id === expected &&
      current.context === 'production' &&
      current.state === 'ready' &&
      !current.locked &&
      site.sso_login_context === 'non_production' &&
      site.build_settings?.stop_builds === true,
    'The active deployment or the site publishing settings differ from the handoff.',
    409,
  );
  const existing = await read(db, PUBLIC_STATE);
  if (existing) {
    requireOk(
      existing.revision === current.id,
      'The desk and the public site have different revisions.',
      409,
    );
    return existing.connection;
  }
  requireOk(
    base.deployment.deploy_id === expected,
    'The public deployment differs from the registered inventory.',
    409,
  );
  const files = await api(token, '/deploys/' + expected + '/files');
  const actual = sorted(files.map((f) => [f.path, f.sha, f.size]));
  const planned = sorted(
    Object.entries(inventory(base, {})).map(([p, f]) => [p.toLowerCase(), f.sha1, f.size]),
  );
  requireOk(
    files.every((f) => f.site_id === SITE && f.deploy_id === expected) &&
      JSON.stringify(
        actual.map(([p, h, n]) => [p.toLowerCase(), h, n]).sort(([a], [b]) => a.localeCompare(b, 'en')),
      ) === JSON.stringify(planned),
    'The public file inventory differs from the registered baseline.',
    409,
  );
  const connection = {
    site: SITE,
    origin: ORIGIN,
    baseline: expected,
    files: files.length,
    inventoryDigest: createHash('sha256').update(JSON.stringify(actual)).digest('hex'),
    connected: new Date().toISOString(),
  };
  requireOk(
    (await protectedSite(token)).published_deploy.id === expected,
    'Production changed during handoff.',
    409,
  );
  const result = await db.setJSON(
    PUBLIC_STATE,
    {
      connection,
      publicId: expected,
      revision: expected,
      released: {},
      synced: {},
      operations: [],
    },
    { onlyIfNew: true },
  );
  requireOk(result.modified, 'Another owner session connected the desk. Refresh its state.', 409);
  return connection;
}

export async function reserveProduction(db, ctx, plan) {
  const { state, record } = ctx;
  requireOk(
    state.connection?.site === SITE && !state.pending && record,
    'Another Production operation is pending.',
    409,
  );
  await db.setJSON(PUBLIC_ROOT + 'plans/' + plan.receipt.id, plan);
  const result = await db.setJSON(
    PUBLIC_STATE,
    { ...state, pending: plan.receipt.id },
    { onlyIfMatch: record.etag },
  );
  requireOk(result.modified, 'Production changed before this operation acquired the release slot.', 409);
}

export async function finishProduction(db, token, job, save) {
  const record = await db.getWithMetadata(PUBLIC_STATE, { type: 'json' });
  const state = record?.data;
  requireOk(
    state?.pending === job.id && state.revision === job.revision && state.connection.site === SITE,
    'This operation does not hold the Production release slot.',
    409,
  );
  const plan = await read(db, PUBLIC_ROOT + 'plans/' + job.id);
  requireOk(plan?.receipt.id === job.id, 'The verified release plan is unavailable.', 409);
  const { released, synced, files, receipt } = plan;
  const candidate = receipt.production;
  let progress = job.publicTransfer || {};
  const checkpoint = async (patch) => {
    progress = { ...progress, ...patch };
    await save({ publicTransfer: progress });
  };
  let live;
  try {
    live = await publishVerifiedFiles({
      token,
      title: 'Instrumentation Gym Production ' + job.id,
      publicId: job.revision,
      next: files,
      progress,
      checkpoint,
      load: async (file) => {
        requireOk(
          !/\.mp4$/i.test(file.path),
          'Netlify is still indexing the verified video. Retry this operation.',
          409,
        );
        return deployFileBlob(token, candidate.id, file.path, file);
      },
    });
  } catch (error) {
    // A definite rejection before a deploy exists can release the slot. An
    // uncertain response retains the claim so the same job reconciles by title.
    if (error.terminalDeployment && (await protectedSite(token)).published_deploy.id === job.revision) {
      progress = {};
      await save({ publicTransfer: progress });
    }
    if (!progress.requested && !progress.deploy) {
      const { pending, ...idle } = state;
      await db.setJSON(PUBLIC_STATE, idle, { onlyIfMatch: record.etag });
    }
    throw error;
  }
  const pagesAt = (pages) =>
    Object.fromEntries(Object.entries(pages || {}).map(([r, url]) => [r, ORIGIN + new URL(url).pathname]));
  const publicDemoPages = Object.fromEntries(
    Object.entries(candidate.demoPages).map(([s, pages]) => [s, pagesAt(pages)]),
  );
  receipt.target = 'production';
  receipt.verifiedCandidate = candidate.id;
  receipt.created = live.created;
  receipt.production = {
    ...live,
    pages: pagesAt(candidate.pages),
    demoPages: publicDemoPages,
    url: candidate.url ? ORIGIN + new URL(candidate.url).pathname : null,
    uploadedBytes: candidate.uploadedBytes + live.uploadedBytes,
    uploadLog: [...candidate.uploadLog, ...live.uploadLog],
  };
  if (receipt.rollback)
    receipt.rollback.preservedPages = Object.fromEntries(
      Object.entries(receipt.rollback.preservedPages).map(([slug, pages]) => [slug, pagesAt(pages)]),
    );
  for (const s of job.slugs)
    if (released[s])
      released[s] = {
        ...released[s],
        id: live.id,
        created: live.created,
        pages: publicDemoPages[s],
        url: publicDemoPages[s].insight,
      };
  await db.setJSON(
    PUBLIC_ROOT + 'snapshots/' + job.id,
    { revision: live.id, created: live.created, released, catalogFiles: plan.catalogFiles || {} },
    { onlyIfNew: true },
  );
  await db.setJSON(PUBLIC_ROOT + 'receipts/' + job.id, receipt, { onlyIfNew: true });
  const won = await db.setJSON(
    PUBLIC_STATE,
    {
      connection: state.connection,
      publicId: state.publicId,
      revision: live.id,
      released,
      synced,
      operations: [...state.operations, job.id],
      catalogFiles: plan.catalogFiles || {},
    },
    { onlyIfMatch: record.etag },
  );
  requireOk(won.modified, 'Reopen this operation to reconcile the active public deployment.', 409);
  return receipt;
}
