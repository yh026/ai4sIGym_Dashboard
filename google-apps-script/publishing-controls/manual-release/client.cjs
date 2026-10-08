'use strict';
const crypto = require('node:crypto');
const { unpack, stable } = require('./capsule.cjs');
const DOMAIN = 'ais-manual-release-api-v1\n';
function identity(env = process.env) {
  return { site_id: env.SITE_ID, build_id: env.BUILD_ID, deploy_id: env.DEPLOY_ID,
    commit_ref: env.COMMIT_REF, branch: env.BRANCH, context: env.CONTEXT };
}
function createClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date().toISOString(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const secret = env.AI4S_PREVIEW_CALLBACK_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Release API signing secret is unavailable.');
  let url;
  try { url = new URL(env.REGISTRY_URL); if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw 0; }
  catch { throw new Error('Release API URL is invalid.'); }
  url.searchParams.set('action', 'manual_release');
  async function call(action, data = {}) {
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
  }
  async function upload(prepared, binding = {}) {
    const { capsule, chunks } = prepared;
    async function uploadStatus() {
      let result;
      // Only this read-only reconciliation operation has bounded polling. Claims,
      // release decisions and deployment acknowledgements are never retried here.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await call('upload_status', { ...binding, capsule_id: capsule.id }); break; }
        catch (error) { if (attempt === 2) throw error; await wait([250, 750][attempt]); }
      }
      const actual = result.capsule, originalFields = {};
      for (const key of Object.keys(capsule)) originalFields[key] = actual?.[key];
      if (stable(originalFields) !== stable(capsule)) throw new Error('Release upload status has a different capsule identity.');
      const indices = result.uploaded_indices;
      if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= chunks.length)
        || new Set(indices).size !== indices.length || typeof result.complete !== 'boolean'
        || result.complete && indices.length !== chunks.length) throw new Error('Release upload status is invalid.');
      return { indices: new Set(indices), complete: result.complete };
    }
    let acknowledged = new Set(), begin;
    try { begin = await call('begin_capsule', { ...binding, capsule }); }
    catch {
      const status = await uploadStatus();
      if (status.complete) return capsule.id;
      acknowledged = status.indices;
    }
    if (begin && begin.capsule_id !== capsule.id) throw new Error('Release capsule identity mismatch.');
    for (let index = 0; index < chunks.length; index++) {
      if (acknowledged.has(index)) continue;
      const part = { ...binding, capsule_id: capsule.id, index,
        sha256: capsule.chunks[index].sha256, base64: chunks[index].toString('base64') };
      try { await call('put_chunk', part); }
      catch {
        let status = await uploadStatus(); acknowledged = status.indices;
        if (acknowledged.has(index)) continue;
        // One resend of exactly the same immutable bytes is allowed only after
        // the store authoritatively reports this chunk as missing.
        try { await call('put_chunk', part); }
        catch (error) {
          status = await uploadStatus(); acknowledged = status.indices;
          if (!acknowledged.has(index)) throw new Error(error.code === 'release_busy'
            ? 'Immutable chunk upload remains unconfirmed because another Registry operation holds the metadata lock. Wait for that operation to finish, then check upload status before resuming.'
            : 'Immutable chunk upload remains unconfirmed. Check upload status before resuming.');
        }
      }
    }
    try { await call('complete_capsule', { ...binding, capsule_id: capsule.id }); }
    catch {
      if (!(await uploadStatus()).complete) throw new Error('Release capsule completion remains unconfirmed. Check upload status before resuming.');
    }
    return capsule.id;
  }
  async function download(capsuleId, binding = {}) {
    const result = await call('read_capsule', { ...binding, capsule_id: capsuleId });
    const capsule = result.capsule; if (capsule?.id !== capsuleId) throw new Error('Release capsule identity mismatch.');
    const chunks = [];
    for (let index = 0; index < capsule.chunks.length; index++) {
      const part = await call('read_chunk', { ...binding, capsule_id: capsuleId, index });
      if (part.sha256 !== capsule.chunks[index].sha256 || typeof part.base64 !== 'string') throw new Error('Release chunk identity mismatch.');
      chunks.push(Buffer.from(part.base64, 'base64'));
    }
    return { capsule, files: unpack(capsule, chunks) };
  }
  return { call, upload, download };
}
module.exports = { DOMAIN, identity, createClient };
