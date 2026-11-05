'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { unpack, stable, CHUNK_SIZE, MAX_BYTES } = require('./capsule.cjs');
const { enabled, valid, matches, createCache } = require('./cache.cjs');
const { createLimiter, mapConcurrent } = require('./concurrency.cjs');
const { startStage, latencySummary } = require('./metrics.cjs');
const DOMAIN = 'ais-manual-release-api-v1\n';
function identity(env = process.env) {
  return { site_id: env.SITE_ID, build_id: env.BUILD_ID, deploy_id: env.DEPLOY_ID,
    commit_ref: env.COMMIT_REF, branch: env.BRANCH, context: env.CONTEXT };
}
function createClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date().toISOString(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  cache = enabled(env) ? createCache() : null, log = console.log } = {}) {
  const secret = env.AI4S_PREVIEW_CALLBACK_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Release API signing secret is unavailable.');
  const concurrency = Number(env.AIS_RELEASE_TRANSFER_CONCURRENCY || 2);
  if (![1, 2].includes(concurrency)) throw new Error('Release transfer concurrency must be 1 or 2.');
  const limited = createLimiter(concurrency);
  let url;
  try { url = new URL(env.REGISTRY_URL); if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw 0; }
  catch { throw new Error('Release API URL is invalid.'); }
  url.searchParams.set('action', 'manual_release');
  function call(action, data = {}) { return limited(async () => {
    const payload = JSON.stringify({ schema: 1, ...identity(env), ...data, action, sent_at: now() });
    const signature = crypto.createHmac('sha256', secret).update(DOMAIN + payload).digest('hex');
    let response, result;
    try { response = await fetchImpl(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature }), signal: AbortSignal.timeout(120000) });
      result = await response.json(); }
    catch { throw new Error('Release API request was not confirmed. Check status before retrying.'); }
    if (!response.ok || result?.ok !== true) {
      const error = new Error('Release API rejected ' + action + ': '
        + String(result?.error || 'request failed').replace(/https?:\/\/\S+/g, '[URL]').slice(0, 250));
      if (result?.code === 'release_busy') error.code = 'release_busy';
      throw error;
    }
    return result;
  }); }
  function cacheOutput(capsule, chunks) {
    if (!cache || capsule.kind !== 'production') return;
    const finish = startStage('cache_output', log); let cached = 0, bytes = 0;
    for (let index = 0; index < chunks.length; index++) {
      try { if (cache.put(capsule.chunks[index], chunks[index])) { cached++; bytes += chunks[index].length; } } catch {}
    }
    finish({ chunks: chunks.length, cached_chunks: cached, cached_bytes: bytes });
  }
  async function upload(prepared, binding = {}) {
    const { capsule, chunks } = prepared;
    const finish = startStage('upload', log), latencies = [];
    let attempts = 0, sentBytes = 0, statusReads = 0, busy = 0, completed = false;
    const acknowledged = new Set();
    async function putChunk(part) {
      const start = performance.now(); attempts++; sentBytes += chunks[part.index].length;
      try { await call('put_chunk', part); acknowledged.add(part.index); }
      catch (error) { if (error.code === 'release_busy') busy++; throw error; }
      finally { latencies.push(performance.now() - start); }
    }
    async function uploadStatus() {
      let result;
      // Only this read-only reconciliation operation has bounded polling. Claims,
      // release decisions and deployment acknowledgements are never retried here.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { statusReads++; result = await call('upload_status', { ...binding, capsule_id: capsule.id }); break; }
        catch (error) { if (attempt === 2) throw error; await wait([250, 750][attempt]); }
      }
      const actual = result.capsule, originalFields = {};
      for (const key of Object.keys(capsule)) originalFields[key] = actual?.[key];
      if (stable(originalFields) !== stable(capsule)) throw new Error('Release upload status has a different capsule identity.');
      const indices = result.uploaded_indices;
      if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= chunks.length)
        || new Set(indices).size !== indices.length || typeof result.complete !== 'boolean'
        || result.complete && indices.length !== chunks.length) throw new Error('Release upload status is invalid.');
      // Status snapshots can precede another worker's acknowledgement. Committed
      // immutable chunks never disappear, so merge rather than replace progress.
      for (const index of indices) acknowledged.add(index);
      return { complete: result.complete };
    }
    // Serialize unknown-outcome reconciliation, including the permitted resend.
    // Each worker obtains a fresh authoritative snapshot after its own failed PUT.
    let recovery = Promise.resolve(), recoveryError;
    function reconcile(part) {
      const next = recovery.then(async () => {
        if (recoveryError) throw recoveryError;
        try {
          await uploadStatus();
          if (acknowledged.has(part.index)) return;
          // Exactly one resend, only after the store reports these bytes missing.
          try { await putChunk(part); }
          catch (error) {
            await uploadStatus();
            if (!acknowledged.has(part.index)) throw new Error(error.code === 'release_busy'
              ? 'Immutable chunk upload remains unconfirmed because another Registry operation holds the metadata lock. Wait for that operation to finish, then check upload status before resuming.'
              : 'Immutable chunk upload remains unconfirmed. Check upload status before resuming.');
          }
        } catch (error) { recoveryError = error; throw error; }
      });
      recovery = next.catch(() => {});
      return next;
    }
    try {
      let begin;
      try { begin = await call('begin_capsule', { ...binding, capsule }); }
      catch {
        const status = await uploadStatus();
        if (status.complete) { completed = true; cacheOutput(capsule, chunks); return capsule.id; }
      }
      if (begin && begin.capsule_id !== capsule.id) throw new Error('Release capsule identity mismatch.');
      await mapConcurrent(chunks, concurrency, async (_, index) => {
        if (acknowledged.has(index)) return;
        const part = { ...binding, capsule_id: capsule.id, index,
          sha256: capsule.chunks[index].sha256, base64: chunks[index].toString('base64') };
        try { await putChunk(part); }
        catch { await reconcile(part); }
      });
      try { await call('complete_capsule', { ...binding, capsule_id: capsule.id }); }
      catch {
        if (!(await uploadStatus()).complete) throw new Error('Release capsule completion remains unconfirmed. Check upload status before resuming.');
      }
      completed = true;
      cacheOutput(capsule, chunks);
      return capsule.id;
    } finally {
      finish({ status: completed ? 'complete' : 'unconfirmed', kind: capsule.kind, concurrency,
        archive_bytes: capsule.archive_size, chunks: chunks.length, acknowledged_chunks: acknowledged.size,
        chunk_attempts: attempts, attempted_bytes: sentBytes, status_reads: statusReads,
        release_busy: busy, ...latencySummary(latencies) });
    }
  }
  async function download(capsuleId, binding = {}) {
    const finish = startStage('download', log), latencies = [];
    let hits = 0, downloaded = 0, completed = false, capsule;
    try {
      const result = await call('read_capsule', { ...binding, capsule_id: capsuleId });
      capsule = result.capsule; if (capsule?.id !== capsuleId) throw new Error('Release capsule identity mismatch.');
      if (capsule.chunk_size !== CHUNK_SIZE || !Array.isArray(capsule.chunks) || !capsule.chunks.length
        || capsule.chunks.length > Math.ceil(MAX_BYTES / CHUNK_SIZE)
        || capsule.chunks.some((item, index) => !valid(item) || item.index !== index)
        || !Number.isSafeInteger(capsule.archive_size) || capsule.archive_size > MAX_BYTES
        || capsule.chunks.reduce((sum, item) => sum + item.size, 0) !== capsule.archive_size) {
        throw new Error('Release capsule descriptor is invalid.');
      }
      const chunks = await mapConcurrent(capsule.chunks, concurrency, async (expected, index) => {
        let bytes;
        try { bytes = cache?.get(expected); } catch {}
        if (matches(bytes, expected)) { hits++; }
        else {
          const start = performance.now(); let part;
          try { part = await call('read_chunk', { ...binding, capsule_id: capsuleId, index }); }
          finally { latencies.push(performance.now() - start); }
          if (part.sha256 !== expected.sha256 || typeof part.base64 !== 'string') throw new Error('Release chunk identity mismatch.');
          bytes = Buffer.from(part.base64, 'base64');
          if (!matches(bytes, expected)) throw new Error('Release chunk content mismatch.');
          downloaded += bytes.length;
        }
        return bytes;
      });
      // Retain the full archive, provenance and per-file validation on cache hits.
      const files = unpack(capsule, chunks);
      if (cache) {
        for (let index = 0; index < chunks.length; index++) {
          try { cache.put(capsule.chunks[index], chunks[index]); } catch {}
        }
      }
      log('Release download: ' + hits + '/' + chunks.length + ' cached chunks; '
        + downloaded + ' bytes downloaded from Drive.');
      completed = true;
      return { capsule, files };
    } finally {
      finish({ status: completed ? 'complete' : 'failed', capsule_id: capsuleId, kind: capsule?.kind,
        concurrency, chunks: capsule?.chunks?.length, cached_chunks: hits, downloaded_bytes: downloaded,
        ...latencySummary(latencies) });
    }
  }
  return { call, upload, download };
}
module.exports = { DOMAIN, identity, createClient };
