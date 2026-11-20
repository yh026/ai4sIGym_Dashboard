import { createHmac, timingSafeEqual } from 'node:crypto';
import { ALIAS, requireOk } from './store.mjs';
function signature(key, id, time) {
  return createHmac('sha256', key)
    .update('gym-preview-worker-v1/' + id + '/' + time)
    .digest('hex');
}
export function validTicket(key, id, header) {
  if (!key || typeof header !== 'string') return false;
  const [time, value] = header.split('.');
  if (
    !/^\d{13}$/.test(time) ||
    !/^\w{64}$/.test(value || '') ||
    Math.abs(Number(time) - Date.now()) > 5 * 60000
  )
    return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(signature(key, id, time)));
}
export async function dispatch(db, job, req, context) {
  const key = process.env.GYM_PREVIEW_DEPLOY_TOKEN;
  if (!key || job.phase !== 'queued') return;
  const origin = new URL(req.url).origin;
  requireOk(
    [ALIAS, context.deploy?.id].includes(new URL(origin).hostname.split('--')[0]) &&
      /^https:\/\/[a-z0-9-]+--aisigym\.netlify\.app$/.test(origin),
    'This hostname does not belong to the preview desk.',
    403,
  );
  const name = 'dispatch/' + job.id,
    now = Date.now();
  const current = await db.getWithMetadata(name, { type: 'json' });
  if (current?.data.at > now - 60000) return;
  const sent = await db.setJSON(
    name,
    { at: now },
    current ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
  );
  if (!sent.modified) return;
  const res = await fetch(origin + '/.netlify/functions/desk-run-background?id=' + job.id, {
    method: 'POST',
    redirect: 'error',
    headers: {
      cookie: req.headers.get('cookie') || '',
      origin,
      'X-Gym-Job': now + '.' + signature(key, job.id, now),
    },
    signal: AbortSignal.timeout(15000),
  });
  await res.body?.cancel();
  if (res.status !== 202) {
    await db.delete(name);
    throw Object.assign(
      new Error('The background worker could not accept the upload (HTTP ' + res.status + ').'),
      { status: 502 },
    );
  }
}
