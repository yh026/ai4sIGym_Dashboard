import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateChanges, validateDependencies, canWrite, safePath } from '../shared/package.mjs';
import {
  SITE,
  ORIGIN,
  CHUNK,
  contextFor,
  effectivePreviews,
  availableNewDemo,
  read,
  getJob,
  partKey,
  describeFiles,
  requireOk,
  summary,
} from './store.mjs';

export async function api(token, route, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const method = options.method || 'GET';
    const response = await fetch('https://api.netlify.com/api/v1' + route, {
      ...options,
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...options.headers },
      signal: AbortSignal.timeout(200000),
    });
    if (response.ok) {
      const body = await response.text();
      return body ? JSON.parse(body) : null;
    }
    const retryable =
      response.status === 429 || (method !== 'POST' && [502, 503, 504].includes(response.status));
    if (!retryable || attempt >= 8)
      throw Object.assign(new Error('Netlify ' + method + ' ' + route + ' HTTP ' + response.status), {
        httpStatus: response.status,
      });
    const retry = response.headers.get('retry-after');
    const seconds = retry && (/^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000);
    await response.body?.cancel();
    await sleep(
      Math.max(seconds > 0 ? seconds * 1000 : 0, Math.min(2 ** attempt * 900, 30000)) + Math.random() * 500,
    );
  }
}
export async function protectedSite(token) {
  const site = await api(token, '/sites/' + SITE);
  requireOk(
    site.id === SITE &&
      site.name === 'aisigym' &&
      site.sso_login &&
      ['all', 'non_production'].includes(site.sso_login_context),
    'Enable team login protection for non-production deploys in Netlify.',
    409,
  );
  return site;
}
function checkDraft(d, title) {
  requireOk(
    d.site_id === SITE &&
      /^[a-f0-9]{24}$/.test(d.id) &&
      !d.published_at &&
      d.context === 'deploy-preview' &&
      d.draft !== false &&
      d.title === title,
    'Netlify returned a different deployment than the requested private draft.',
    409,
  );
  requireOk(
    !['failed', 'error', 'canceled', 'rejected'].includes(d.state),
    'Netlify reported a draft state of ' + d.state,
    502,
  );
}
export async function uploadedBlob(db, job, file) {
  const buffers = [];
  for (let n = 0; n < Math.ceil(file.size / CHUNK); n++) {
    const buffer = await db.get(partKey(job, file.sha1, n), { type: 'arrayBuffer' });
    requireOk(
      buffer?.byteLength === Math.min(CHUNK, file.size - n * CHUNK),
      'Upload incomplete for ' + file.path,
      409,
    );
    buffers.push(buffer);
  }
  return new Blob(buffers);
}
export async function verifyBlob(blob, file) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  requireOk(
    bytes.length === file.size && createHash('sha1').update(bytes).digest('hex') === file.sha1,
    'Checksum mismatch for ' + file.path,
    422,
  );
  return bytes;
}
export async function deployFileBlob(token, deploy, path, file) {
  requireOk(/^[a-f0-9]{24}$/.test(deploy), 'Invalid source deployment.', 409);
  const route = safePath(path).split('/').map(encodeURIComponent).join('/');
  const media = 'application/vnd.bitballoon.v1.raw';
  const reply = await fetch('https://api.netlify.com/api/v1/deploys/' + deploy + '/files' + route, {
    redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, Accept: media, 'Content-Type': media },
    signal: AbortSignal.timeout(120000),
  });
  requireOk(
    reply.ok,
    'Could not read the existing file ' + path + ' from its deployment (HTTP ' + reply.status + ').',
    409,
  );
  const blob = await reply.blob();
  await verifyBlob(blob, { ...file, path });
  return blob;
}
export const materializeDraft = (request) => materializeFiles(request, false);
// Called only after an explicit owner publication and a durable site-wide claim.
export const publishVerifiedFiles = (request) => materializeFiles(request, true);

function checkPublicDeploy(deploy, title) {
  requireOk(
    deploy.site_id === SITE &&
      /^[a-f0-9]{24}$/.test(deploy.id) &&
      deploy.context === 'production' &&
      deploy.draft !== true &&
      deploy.title === title,
    'Netlify returned an unexpected Production deployment.',
    409,
  );
  if (['failed', 'error', 'canceled', 'rejected'].includes(deploy.state))
    throw Object.assign(new Error('Netlify rejected the Production deployment (' + deploy.state + ').'), {
      status: 502,
      terminalDeployment: deploy.id,
    });
}
async function materializeFiles(
  {
    token,
    title,
    next,
    publicId,
    probePath,
    load,
    incoming = [],
    hasNewFiles = false,
    progress = {},
    checkpoint,
  },
  publish,
) {
  const check = publish ? checkPublicDeploy : checkDraft;
  const job = { ...progress };
  const save = async (patch) => {
    await checkpoint(patch);
    Object.assign(job, patch);
  };
  let draft;
  const recovering = Boolean(job.requested || job.deploy);
  if (job.deploy) draft = await api(token, '/deploys/' + job.deploy);
  else {
    if (job.requested) {
      if (publish) {
        const active = (await protectedSite(token)).published_deploy;
        if (active.id !== publicId) {
          const current = await api(token, '/deploys/' + active.id);
          if (current.title === title) draft = current;
        }
      }
      if (!draft) {
        const rows = await api(token, '/sites/' + SITE + '/deploys?per_page=100');
        draft = rows.find((d) => d.title === title);
      }
      requireOk(draft, 'Netlify is confirming the previous deployment request. Try again shortly.', 409);
    } else {
      if (publish) {
        const site = await protectedSite(token);
        requireOk(
          site.published_deploy.id === publicId &&
            !site.published_deploy.locked &&
            site.sso_login_context === 'non_production' &&
            site.build_settings?.stop_builds === true,
          'Check the current Production deployment and publishing settings before retrying.',
          409,
        );
      }
      await save({ phase: 'processing', requested: true });
      try {
        const route = '/sites/' + SITE + '/deploys' + (publish ? '?title=' + encodeURIComponent(title) : '');
        draft = await api(token, route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draft: !publish,
            async: true,
            title,
            files: Object.fromEntries(Object.entries(next).map(([p, f]) => [p, f.sha1])),
          }),
        });
      } catch (err) {
        // A rejected request did not create a deployment. An uncertain network
        // response must be reconciled by title before attempting a second POST.
        if (err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 408)
          await save({ requested: false });
        throw err;
      }
    }
    check(draft, title);
    await save({ deploy: draft.id });
  }
  check(draft, title);
  const poll = async () => {
    await sleep(650);
    draft = await api(token, '/deploys/' + job.deploy);
    check(draft, title);
  };
  const deadline = Date.now() + 12 * 60000;
  while (draft.state === 'preparing') {
    requireOk(Date.now() < deadline, 'Netlify is still checking the file hashes. Try again shortly.', 504);
    await poll();
  }
  requireOk(
    !draft.required_functions?.length && (Array.isArray(draft.required) || draft.state === 'ready'),
    'Netlify returned an incomplete draft manifest.',
    502,
  );
  let promised = job.required;
  if (!promised) {
    promised = draft.required || [];
    requireOk(
      !recovering || promised.length || draft.state !== 'uploading' || !hasNewFiles,
      'This draft’s upload list has expired. Submit the package again.',
      409,
    );
    await save({ required: promised, phase: 'processing', error: null });
  }
  const required =
    draft.state === 'ready'
      ? []
      : promised.filter(
          (hash) => !job.uploadLog?.[hash] && (!draft.required?.length || draft.required.includes(hash)),
        );
  const uploadLog = { ...(job.uploadLog || {}) };
  const toSend = new Map(incoming.map((f) => [f.sha1, f]));
  const nativeFile = async (hash) => {
    const f =
      toSend.get(hash) ||
      Object.entries(next)
        .filter(([, v]) => v.sha1 === hash)
        .map(([path, v]) => ({ ...v, path }))[0];
    requireOk(f, 'Netlify requested an unrecognized file hash.');
    const b = await load(f);
    requireOk(b, 'Netlify needs a fresh copy of ' + f.path, 409);
    const bytes = await verifyBlob(b, f);
    await api(
      token,
      '/deploys/' + job.deploy + '/files' + f.path.split('/').map(encodeURIComponent).join('/'),
      { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    uploadLog[hash] = { path: f.path, size: f.size, sha1: hash };
  };
  for (let i = 0; i < required.length; i += 4) {
    const done = await Promise.allSettled(required.slice(i, i + 4).map(nativeFile));
    await save({ uploadLog: { ...uploadLog } });
    const failure = done.find((d) => d.status === 'rejected');
    if (failure) throw failure.reason;
  }
  while (draft.state !== 'ready') {
    requireOk(Date.now() < deadline, 'Netlify is still preparing the preview. Try again shortly.', 504);
    await poll();
  }
  const rows = await api(token, '/deploys/' + job.deploy + '/files');
  const canonical = new Map(Object.entries(next).map(([path, file]) => [path.toLowerCase(), file]));
  requireOk(
    rows.length === canonical.size &&
      new Set(rows.map((r) => r.path.toLowerCase())).size === canonical.size &&
      rows.every(
        (r) =>
          r.site_id === SITE &&
          r.deploy_id === job.deploy &&
          canonical.get(r.path.toLowerCase())?.sha1 === r.sha &&
          (!publish || canonical.get(r.path.toLowerCase()).size === r.size),
      ),
    'The deployed files differ from the preview manifest.',
    502,
  );
  const origin = 'https://' + draft.id + '--aisigym.netlify.app';
  if (publish) {
    for (;;) {
      const site = await protectedSite(token);
      if (site.published_deploy.id === draft.id) break;
      requireOk(
        site.published_deploy.id === publicId && Date.now() < deadline,
        'Netlify has not confirmed that this deployment is serving Production. Check this operation again.',
        409,
      );
      await sleep(650);
    }
  } else {
    const protection = await fetch(origin + probePath, { method: 'HEAD', redirect: 'manual' });
    requireOk([401, 403].includes(protection.status), 'The draft failed its private-access check.', 502);
    requireOk(
      (await protectedSite(token)).published_deploy.id === publicId,
      'Production changed while this preview was being prepared. Review the changes again.',
      409,
    );
  }
  const log = Object.values(uploadLog);
  return {
    id: draft.id,
    origin: publish ? ORIGIN : origin,
    created: draft.ready_at || new Date().toISOString(),
    files: rows.length,
    uploadedBytes: log.reduce((sum, f) => sum + f.size, 0),
    uploadLog: log,
  };
}
export async function runJob(db, token, id, sources = new Map()) {
  let job = await getJob(db, id);
  if (job.phase === 'ready') return job.result;
  const lockKey = 'workers/' + id;
  const previous = await db.getWithMetadata(lockKey, { type: 'json' });
  requireOk(!previous || previous.data.until < Date.now(), 'This upload is already processing.', 409);
  const nonce = randomUUID();
  const lock = await db.setJSON(
    lockKey,
    { nonce, until: Date.now() + 18 * 60 * 1000 },
    previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true },
  );
  requireOk(lock.modified, 'This upload is already processing.', 409);
  const save = async (patch) => {
    job = { ...job, ...patch };
    await db.setJSON('jobs/' + id, job);
  };
  const finish = async (receipt) => {
    await save({ phase: 'ready', result: summary(receipt), error: null });
    if (job.channel !== 'cli') {
      try {
        const chunks = (await db.list({ prefix: 'parts/' + job.id + '/' })).blobs;
        for (let i = 0; i < chunks.length; i += 8)
          await Promise.all(chunks.slice(i, i + 8).map((row) => db.delete(row.key)));
      } catch {
        await save({ cleanupPending: true });
      }
    }
    return job.result;
  };
  try {
    const site = await protectedSite(token);
    const ctx = await contextFor(db);
    const { base, catalog, heads } = ctx;
    requireOk(
      site.published_deploy.id === (job.publicRevision || job.production) &&
        base.deployment.deploy_id === job.production,
      'Production has changed. Refresh the catalog before submitting.',
      409,
    );
    const currentHead = await db.getWithMetadata('heads/' + job.slug, { type: 'json' });
    if (currentHead?.data?.job === id) {
      if (job.registration)
        await db.setJSON('versions/' + job.slug + '/' + currentHead.data.id, currentHead.data, {
          onlyIfNew: true,
        });
      return await finish(currentHead.data);
    }
    if (job.registration && job.deploy && currentHead?.data?.registration?.firstVersion === job.deploy) {
      const first = await read(db, 'versions/' + job.slug + '/' + job.deploy);
      requireOk(first?.job === id, 'The first Preview is still being recorded. Retry this upload.', 409);
      return await finish(first);
    }
    const demo = job.registration ? availableNewDemo(job.registration, ctx) : catalog[job.slug];
    requireOk(demo, 'This demo is unavailable. Refresh the desk.', 409);
    const rawParent = currentHead?.data || ctx.upstream[job.slug];
    const effective = effectivePreviews(rawParent ? { [job.slug]: rawParent } : {}, ctx.live, job.production);
    requireOk(
      (effective[job.slug]?.id || job.production) === job.parent &&
        (heads[job.slug]?.id || job.production) === job.parent,
      'A newer preview is available for this demo. Review the changes again.',
      409,
    );
    // Each attempt works against the same site-wide file list, including drafts of
    // other demos that were current at the moment this candidate was assembled.
    const snapshotKey = 'snapshots/' + job.id;
    let current = await read(db, snapshotKey);
    if (!current) {
      const saved = await db.setJSON(snapshotKey, ctx.files, { onlyIfNew: true });
      current = saved.modified ? ctx.files : await read(db, snapshotKey);
    }
    validateChanges(demo, job.files, job.remove, current);
    const next = { ...current };
    for (const path of job.remove) delete next[path];
    for (const { path, sha1, size } of job.files) next[path] = { sha1, size };
    const cache = new Map();
    const load = async (file) => {
      if (sources.has(file.sha1)) return sources.get(file.sha1);
      if (cache.has(file.sha1)) return cache.get(file.sha1);
      if (job.need.includes(file.sha1)) return uploadedBlob(db, job, file);
      const stored = await db.get('validated-text/' + file.sha1, { type: 'blob' });
      if (stored) return stored;
      const original =
        current[file.path]?.sha1 === file.sha1
          ? [file.path, current[file.path]]
          : Object.entries(current).find(([, f]) => f.sha1 === file.sha1);
      if (!original) return null;
      const [path, entry] = original;
      const deploy =
        entry.sourceDeploy ||
        Object.values(heads).find((h) => h.overlay[path]?.sha1 === entry.sha1)?.id ||
        job.production;
      return deployFileBlob(token, deploy, path, file);
    };
    const content = [];
    for (const f of job.files.filter((f) => /\.(html?|css)$/i.test(f.path))) {
      if (!job.remove.length && current[f.path]?.sha1 === f.sha1 && current[f.path].size === f.size) continue;
      const b = await load(f);
      requireOk(b, 'Include this page in the package: ' + f.path, 409);
      await verifyBlob(b, f);
      cache.set(f.sha1, b);
      content.push({ ...f, blob: b });
    }
    const retained = { ...current };
    if (job.remove.length) {
      // References elsewhere also matter when an external dataset or shared image is removed.
      const crossDemo = job.remove.some((p) => !p.startsWith('/demos/' + job.slug + '/'));
      for (const [path, f] of Object.entries(current)) {
        if (
          !/\.(html?|css)$/i.test(path) ||
          (!crossDemo && !canWrite(demo, path)) ||
          job.remove.includes(path) ||
          content.some((c) => c.path === path)
        )
          continue;
        const b = await load({ ...f, path });
        requireOk(b, 'A page needed for dependency checks is missing: ' + path, 409);
        retained[path] = { ...f, blob: b };
      }
    }
    await validateDependencies(content, { ...next, ...retained }, job.remove);
    for (const f of content) await db.set('validated-text/' + f.sha1, f.blob, { onlyIfNew: true });
    const transfer = await materializeDraft({
      token,
      title: 'Gym private preview ' + id,
      next,
      publicId: job.publicRevision || job.production,
      probePath: demo.pages.insight.path,
      load,
      incoming: job.files,
      hasNewFiles: job.need.length > 0,
      progress: job,
      checkpoint: save,
    });
    const pages = Object.fromEntries(
      Object.entries(demo.pages).map(([role, p]) => [role, transfer.origin + p.path]),
    );
    const overlay = { ...(heads[job.slug]?.overlay || {}) },
      removed = new Set(heads[job.slug]?.removed || []);
    for (const p of job.remove) {
      delete overlay[p];
      removed.add(p);
    }
    for (const f of job.files) {
      overlay[f.path] = { sha1: f.sha1, size: f.size };
      removed.delete(f.path);
    }
    const registration = job.registration
      ? { ...job.registration, firstVersion: transfer.id }
      : currentHead?.data?.registration;
    const receipt = {
      id: transfer.id,
      slug: job.slug,
      job: id,
      executor: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'netlify-function' : 'owner-cli',
      parent: job.parent,
      production: job.production,
      created: transfer.created,
      actor: job.actor,
      ...(registration && { registration }),
      pages,
      url: pages.insight,
      overlay,
      removed: [...removed],
      changes: describeFiles(job.files, job.remove, current),
      uploadedBytes: transfer.uploadedBytes,
      incomingBytes:
        job.channel === 'cli'
          ? 0
          : job.need.reduce((n, h) => n + job.files.find((file) => file.sha1 === h).size, 0),
      uploadLog: transfer.uploadLog,
      verifiedFiles: transfer.files,
    };
    const versionKey = 'versions/' + job.slug + '/' + transfer.id;
    // A losing first registration must never become a selectable version of the winner.
    if (!job.registration) {
      // A later edit can arrive immediately after the first head wins its address.
      if (registration && currentHead.data.id === registration.firstVersion)
        await db.setJSON('versions/' + job.slug + '/' + registration.firstVersion, currentHead.data, {
          onlyIfNew: true,
        });
      await db.setJSON(versionKey, receipt, { onlyIfNew: true });
    }
    const won = await db.setJSON(
      'heads/' + job.slug,
      receipt,
      currentHead ? { onlyIfMatch: currentHead.etag } : { onlyIfNew: true },
    );
    requireOk(won.modified, 'A newer preview was saved first. Refresh and review it.', 409);
    if (job.registration) await db.setJSON(versionKey, receipt, { onlyIfNew: true });
    return await finish(receipt);
  } catch (err) {
    await save({ phase: 'error', error: String(err.message).slice(0, 400) });
    throw err;
  } finally {
    const held = await read(db, lockKey);
    if (held?.nonce === nonce) await db.delete(lockKey);
  }
}
