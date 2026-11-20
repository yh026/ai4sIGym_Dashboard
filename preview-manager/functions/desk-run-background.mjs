import { getJob, requireOk, SITE, storeFor } from '../server/store.mjs';
import { validTicket } from '../server/dispatch.mjs';
import { runJob } from '../server/native.mjs';
import { runRelease } from '../server/releases.mjs';
export default async function (req, context) {
  const id = new URL(req.url).searchParams.get('id'),
    key = process.env.GYM_PREVIEW_DEPLOY_TOKEN;
  requireOk(
    context.site?.id === SITE && req.method === 'POST' && validTicket(key, id, req.headers.get('x-gym-job')),
    'Invalid invocation',
    403,
  );
  const db = storeFor(),
    job = await getJob(db, id);
  if (job.phase === 'queued') await (job.releaseMode ? runRelease : runJob)(db, key, job.id);
}
