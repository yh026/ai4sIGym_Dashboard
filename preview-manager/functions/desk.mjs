import { createHash } from 'node:crypto';
import { protectedSite } from '../server/native.mjs';
import { publicRenderer } from '../server/public-catalog.mjs';
import { dispatch } from '../server/dispatch.mjs';
import { deskCatalog, saveReviewCheck } from '../server/catalog.mjs';
import { beginRelease, releaseState, reviewedPreview } from '../server/releases.mjs';
import {
  SITE,
  ALIAS,
  PUBLIC_STATE,
  CHUNK,
  access,
  authorized,
  previewCatalog,
  contextFor,
  getJob,
  makeJob,
  read,
  partKey,
  requireOk,
  storeFor,
} from '../server/store.mjs';

export const config = { path: '/.netlify/functions/desk' };
const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
const emailValid = (x) => typeof x === 'string' && /^[^@/\s]+@[^@/\s]+\.[^@/\s]+$/.test(x) && x.length <= 254;
export default async function desk(req, context) {
  try {
    requireOk(context.site?.id === SITE, 'This management site is unavailable.', 403);
    const url = new URL(req.url),
      action = url.searchParams.get('action');
    const db = storeFor(),
      who = await access(db, context.user);
    const method = {
      overview: 'GET',
      state: 'GET',
      'new-demo-state': 'GET',
      checklist: 'POST',
      status: 'GET',
      begin: 'POST',
      part: 'PUT',
      finish: 'POST',
      grant: 'POST',
      'release-state': 'GET',
      'production-state': 'GET',
      'production-status': 'GET',
      'production-preview': 'GET',
      'production-begin': 'POST',
      'reviewed-preview': 'GET',
      'release-begin': 'POST',
      'release-retry': 'POST',
    }[action];
    requireOk(method === req.method, 'This action or HTTP method is unsupported.', 405);
    if (method !== 'GET') {
      requireOk(
        req.headers.get('origin') === url.origin && req.headers.get('x-gym-preview') === '1',
        'Open the preview desk and try again.',
        403,
      );
    }
    if (action === 'overview' || action === 'state')
      return json(
        await deskCatalog(db, who, url.searchParams.get('slug'), { overview: action === 'overview' }),
      );
    if (action === 'checklist') return json(await saveReviewCheck(db, who, await req.json()));
    if (action === 'new-demo-state') {
      requireOk(who.owner, 'Only the owner can add a new demo.', 403);
      const { base, files } = await contextFor(db);
      return json({ production: base.deployment.deploy_id, files });
    }
    if (action === 'grant') {
      requireOk(who.owner, 'Only the owner can manage upload access.', 403);
      const { catalog } = await previewCatalog(db);
      const body = await req.json();
      const email = String(body.email || '')
        .trim()
        .toLowerCase();
      requireOk(
        emailValid(email) &&
          Array.isArray(body.slugs) &&
          body.slugs.every((slug) => Object.hasOwn(catalog, slug)),
        'Enter a valid email address and choose demos from the catalog.',
      );
      if (body.slugs.length) await db.setJSON('access/' + email, { email, slugs: [...new Set(body.slugs)] });
      else await db.delete('access/' + email);
      return json({ ok: true });
    }
    const live = action.startsWith('production-');
    if (live)
      requireOk(
        url.hostname === ALIAS + '--aisigym.netlify.app',
        'Open the current management desk to manage public Production.',
        403,
      );
    if (action === 'production-status') {
      requireOk(who.owner, 'Only the owner can inspect the Production connection.', 403);
      const [{ base }, site, record] = await Promise.all([
        previewCatalog(db),
        protectedSite(process.env.GYM_PREVIEW_DEPLOY_TOKEN),
        read(db, PUBLIC_STATE),
      ]);
      requireOk(record?.connection, 'Production has not been connected.', 409);
      return json({
        connection: record.connection,
        revision: record.revision,
        serving: site.published_deploy.id,
        stoppedBuilds: site.build_settings.stop_builds,
        protection: site.sso_login_context,
        operations: record.operations.length,
        pending: record.pending || null,
        catalogRenderer: publicRenderer(base).source_digest,
      });
    }
    if (action === 'production-state' || action === 'release-state') {
      const state = await releaseState(
        db,
        who,
        url.searchParams.get('slug'),
        url.searchParams.get('preview'),
        url.searchParams.get('receipt'),
        live ? 'production' : undefined,
        url.searchParams.get('history') === '1',
      );
      if (live) {
        const site = await protectedSite(process.env.GYM_PREVIEW_DEPLOY_TOKEN);
        state.serving = site.published_deploy.id;
        state.available =
          state.serving === state.revision &&
          !site.published_deploy.locked &&
          site.build_settings?.stop_builds === true &&
          site.sso_login_context === 'non_production';
      }
      return json(state);
    }
    if (action === 'reviewed-preview' || action === 'production-preview')
      return json(
        await reviewedPreview(
          db,
          who,
          url.searchParams.get('slug'),
          url.searchParams.get('preview'),
          live ? 'production' : undefined,
        ),
      );
    if (action === 'begin' || action === 'release-begin' || action === 'production-begin') {
      const body = await req.json();
      const job =
        action === 'begin'
          ? await makeJob(db, who, body)
          : await beginRelease(db, who, body, live ? 'production' : undefined);
      return json({ id: job.id, need: job.need, chunkBytes: CHUNK });
    }
    const job = await getJob(db, url.searchParams.get('id'));
    if (job.releaseMode) requireOk(who.owner, 'Only the owner can access private releases.', 403);
    if (action === 'release-retry')
      requireOk(job.releaseMode && who.owner, 'Choose an owner release to retry.', 403);
    requireOk(
      authorized(who, job.slug) && (who.owner || who.id === job.actor),
      'Your account does not have access to this upload.',
      403,
    );
    if (action === 'part') {
      requireOk(job.phase === 'uploading', 'This upload has already been submitted.', 409);
      const sha = url.searchParams.get('sha'),
        rawPart = url.searchParams.get('part'),
        n = Number(rawPart);
      const f = job.files.find((f) => f.sha1 === sha);
      requireOk(
        f &&
          job.need.includes(sha) &&
          /^\d+$/.test(rawPart) &&
          Number.isSafeInteger(n) &&
          n >= 0 &&
          n < Math.ceil(f.size / CHUNK),
        'This upload chunk is invalid.',
      );
      const bytes = await req.arrayBuffer();
      requireOk(
        bytes.byteLength === Math.min(CHUNK, f.size - n * CHUNK),
        'The upload chunk size does not match the file.',
      );
      const digest = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      const key = partKey(job, sha, n);
      const saved = await db.set(key, bytes, { onlyIfNew: true, metadata: { sha256: digest } });
      if (!saved.modified)
        requireOk(
          (await db.getMetadata(key))?.metadata?.sha256 === digest,
          'This chunk differs from the previous upload. Submit the file again.',
          409,
        );
      return json({ bytes: bytes.byteLength });
    }
    const activeWorker =
      job.releaseMode && job.phase === 'processing' && action === 'finish'
        ? await read(db, 'workers/' + job.id)
        : null;
    const shouldQueue =
      (action === 'finish' &&
        (job.phase === 'uploading' ||
          (job.releaseMode && job.phase === 'processing' && !(activeWorker?.until > Date.now())))) ||
      (action === 'release-retry' && job.phase === 'error');
    if (shouldQueue) {
      // If the browser repeats finish, preserve a worker's progress.
      const current = await db.getWithMetadata('jobs/' + job.id, { type: 'json' });
      if (current.data.phase === job.phase)
        await db.setJSON(
          'jobs/' + job.id,
          { ...current.data, phase: 'queued' },
          { onlyIfMatch: current.etag },
        );
    }
    const latest = action === 'finish' || action === 'release-retry' ? await getJob(db, job.id) : job;
    await dispatch(db, latest, req, context);
    return json({
      id: latest.id,
      phase: latest.phase,
      result: latest.result || null,
      error: latest.error || null,
      cloud: Boolean(process.env.GYM_PREVIEW_DEPLOY_TOKEN),
    });
  } catch (e) {
    return json(
      {
        error: e.status
          ? e.message
          : e.message?.includes('Netlify Blobs')
            ? 'Netlify storage is temporarily unavailable. Try again shortly.'
            : String(e.message).slice(0, 260),
      },
      e.status || 400,
    );
  }
}
