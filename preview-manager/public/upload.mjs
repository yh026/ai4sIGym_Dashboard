const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function callDesk(action, { method = 'GET', params = {}, body, binary = false } = {}) {
  const search = new URLSearchParams({ action, ...params });
  const res = await fetch('/.netlify/functions/desk?' + search, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(method === 'GET'
        ? {}
        : { 'X-Gym-Preview': '1', 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  let reply;
  try {
    reply = await res.json();
  } catch {
    throw new Error('Your session expired or the service is unavailable. Refresh the page.');
  }
  if (!res.ok) throw new Error(reply.error || 'HTTP ' + res.status);
  return reply;
}
async function sendMissingParts(job, files, onProgress) {
  const { id, need } = job;
  const byHash = new Map(files.map((f) => [f.sha1, f])),
    queue = [];
  const chunkBytes = job.chunkBytes || job.chunkSize;
  if (need.length && !(Number.isSafeInteger(chunkBytes) && chunkBytes > 0))
    throw Error('Invalid upload chunk size.');
  const neededBytes = need.reduce((sum, hash) => {
    if (!byHash.has(hash)) throw Error('The service requested a file missing from this package.');
    return sum + byHash.get(hash).size;
  }, 0);
  let uploadedBytes = 0,
    fileRequests = 0;
  for (const sha of need) {
    const f = byHash.get(sha);
    for (let p = 0; p * chunkBytes < f.size; p++)
      queue.push({ sha, part: p, blob: f.blob.slice(p * chunkBytes, (p + 1) * chunkBytes) });
  }
  const notify = (message) => onProgress({ message, uploadedBytes, neededBytes, fileRequests });
  notify(need.length ? 'Uploading new content' : 'Reusing existing files');
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (next < queue.length) {
        const part = queue[next++];
        let retries = 0;
        for (;;) {
          try {
            fileRequests++;
            await callDesk('part', {
              method: 'PUT',
              params: { id, sha: part.sha, part: part.part },
              binary: true,
              body: part.blob,
            });
            break;
          } catch (e) {
            if (++retries > 2) throw e;
            await wait(500 * retries);
          }
        }
        uploadedBytes += part.blob.size;
        notify('Uploading new content');
      }
    }),
  );
  return { uploadedBytes, neededBytes, fileRequests };
}
export async function submitPackage({ slug, base, files, remove = [], registration, onProgress = () => {} }) {
  const job = await callDesk('begin', {
    method: 'POST',
    body: {
      slug,
      base,
      files: files.map(({ path, size, sha1 }) => ({ path, size, sha1 })),
      remove,
      registration,
    },
  });
  const { id } = job;
  const totals = await sendMissingParts(job, files, onProgress);
  const notify = (message) => onProgress({ message, ...totals });
  let status = await callDesk('finish', { method: 'POST', params: { id } });
  notify(
    status.cloud
      ? 'Files received. Preparing the Preview…'
      : 'Files saved to Netlify. Waiting for the preview processor…',
  );
  const deadline = Date.now() + 18 * 60000;
  for (;;) {
    if (status.phase === 'ready') return status.result;
    if (status.phase === 'error') throw new Error(status.error);
    if (Date.now() > deadline)
      throw new Error('Upload saved. Refresh the desk to check the processing result.');
    await wait(2000);
    status = await callDesk('status', { params: { id } });
  }
}

// Private releases use the same part/finish/status transport as normal uploads.
export async function resumeRelease(id, onProgress = () => {}, { finish = false, retry = false } = {}) {
  let status = await callDesk(retry ? 'release-retry' : finish ? 'finish' : 'status', {
    method: retry || finish ? 'POST' : 'GET',
    params: { id },
  });
  const deadline = Date.now() + 18 * 60000;
  for (;;) {
    if (status.phase === 'ready') return status.result;
    if (status.phase === 'error') throw new Error(status.error || 'The release failed.');
    onProgress({ message: 'Preparing the release…' });
    if (Date.now() > deadline)
      throw new Error('The operation is still processing. Open Release receipts to check it.');
    await wait(2000);
    status = await callDesk('status', { params: { id } });
  }
}
export async function submitRelease({ body, files = [], onProgress = () => {}, onJob = () => {} }) {
  const job = await callDesk(body.destination ? 'production-begin' : 'release-begin', {
    method: 'POST',
    body,
  });
  onJob({ id: job.id, phase: 'uploading' });
  const totals = await sendMissingParts(job, files, onProgress);
  onProgress({ message: 'Package received. Preparing the release…', ...totals });
  onJob({ id: job.id, phase: 'processing' });
  return resumeRelease(job.id, onProgress, { finish: true });
}
