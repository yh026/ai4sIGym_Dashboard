'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');
const { createClient } = require('./client.cjs');
const { pack, unpack, CHUNK_SIZE } = require('./capsule.cjs');

const files = new Map([['index.html', Buffer.from('reviewed page')],
  ['assets/video.mp4', crypto.randomBytes(2 * CHUNK_SIZE + 1000)]]);
const prepared = pack(files, { kind: 'production' }, 'production-capsule');
const other = { ...prepared, capsule: { ...prepared.capsule, id: 'preview-capsule' } };
const env = { REGISTRY_URL: 'https://script.google.com/macros/s/test/exec',
  AI4S_PREVIEW_CALLBACK_SECRET: 'transfer-test-only-signing-secret-123456789' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(behavior = {}, concurrency = 2) {
  const calls = [], logs = [], stored = new Map(); let active = 0, peak = 0, statusActive = 0, statusPeak = 0, complete = false;
  const state = { calls, logs, stored, get complete() { return complete; },
    get peak() { return peak; }, get statusPeak() { return statusPeak; },
    count: action => calls.filter(message => message.action === action).length };
  async function normal(message) {
    if (message.action === 'read_capsule') return { capsule: message.capsule_id === other.capsule.id ? other.capsule : prepared.capsule };
    if (message.action === 'read_chunk') return { sha256: prepared.capsule.chunks[message.index].sha256,
      base64: prepared.chunks[message.index].toString('base64') };
    if (message.action === 'begin_capsule') return { capsule_id: prepared.capsule.id };
    if (message.action === 'put_chunk') {
      assert.deepEqual(Buffer.from(message.base64, 'base64'), prepared.chunks[message.index]);
      assert.equal(message.sha256, prepared.capsule.chunks[message.index].sha256);
      stored.set(message.index, Buffer.from(message.base64, 'base64')); return {};
    }
    if (message.action === 'upload_status') return { capsule: prepared.capsule, uploaded_indices: [...stored.keys()], complete };
    if (message.action === 'complete_capsule') {
      assert.equal(stored.size, prepared.chunks.length); complete = true; return {};
    }
    throw new Error('Unexpected action: ' + message.action);
  }
  const client = createClient({ env: { ...env, AIS_RELEASE_TRANSFER_CONCURRENCY: String(concurrency) }, cache: null,
    log: value => logs.push(value), wait: async () => {}, fetchImpl: async (_, options) => {
      const message = JSON.parse(JSON.parse(options.body).payload); calls.push(message);
      active++; peak = Math.max(peak, active);
      if (message.action === 'upload_status') { statusActive++; statusPeak = Math.max(statusPeak, statusActive); }
      try {
        const result = await (behavior[message.action] ? behavior[message.action](message, state, () => normal(message)) : normal(message));
        return { ok: true, json: async () => ({ ok: true, ...result }) };
      } finally { active--; if (message.action === 'upload_status') statusActive--; }
    } });
  return { client, state };
}

test('two pinned downloads share one request budget and preserve bytes despite out-of-order completion', async () => {
  const gate = deferred(), finished = [];
  const h = harness({ async read_chunk(message, state, normal) {
    if (message.capsule_id === prepared.capsule.id && message.index === 0) await gate.promise;
    if (message.capsule_id === other.capsule.id) gate.resolve();
    finished.push(message.capsule_id + ':' + message.index); return normal();
  } });
  const results = await Promise.all([h.client.download(prepared.capsule.id), h.client.download(other.capsule.id)]);
  assert.equal(h.state.peak, 2);
  assert.notEqual(finished[0], prepared.capsule.id + ':0');
  for (const result of results) assert.deepEqual(result.files, files);
  assert.equal(h.state.count('read_chunk'), prepared.chunks.length * 2);
});

test('concurrent lost acknowledgements reconcile serially and resend only missing identical chunks', async () => {
  const initial = deferred(); let initialCount = 0;
  const h = harness({ async put_chunk(message, state, normal) {
    const attempts = state.calls.filter(call => call.action === 'put_chunk' && call.index === message.index).length;
    if (message.index < 2 && attempts === 1) {
      if (message.index === 0) await normal();
      if (++initialCount === 2) initial.resolve();
      await initial.promise; throw new Error('response lost');
    }
    return normal();
  }, async upload_status(message, state, normal) {
    const snapshot = await normal(); await tick(); return snapshot;
  } });
  await h.client.upload(prepared);
  assert.equal(h.state.peak, 2); assert.equal(h.state.statusPeak, 1);
  assert.equal(h.state.calls.filter(call => call.action === 'put_chunk' && call.index === 0).length, 1);
  assert.equal(h.state.calls.filter(call => call.action === 'put_chunk' && call.index === 1).length, 2);
  assert.equal(h.state.count('complete_capsule'), 1);
  const metrics = h.state.logs.filter(line => line.startsWith('Release metrics: ')).map(line => JSON.parse(line.slice(17)));
  assert.equal(metrics.at(-1).acknowledged_chunks, prepared.chunks.length);
  assert.equal(metrics.at(-1).attempted_bytes, prepared.capsule.archive_size + prepared.chunks[1].length);
});

test('fatal upload failure drains in-flight writes and never completes or caches a partial archive', async () => {
  const pending = deferred(), failed = deferred(); let settled = false;
  const h = harness({ async put_chunk(message, state, normal) {
    if (message.index === 0) throw new Error('write never arrived');
    if (message.index === 1) await pending.promise;
    return normal();
  }, async upload_status(message, state, normal) {
    if (state.count('upload_status') === 2) failed.resolve(); return normal();
  } });
  const running = h.client.upload(prepared);
  running.then(() => { settled = true; }, () => { settled = true; });
  await failed.promise; await tick();
  assert.equal(settled, false);
  pending.resolve();
  await assert.rejects(running, /chunk upload remains unconfirmed/);
  const countAtFailure = h.state.calls.length; await tick();
  assert.equal(h.state.calls.length, countAtFailure);
  assert.equal(h.state.count('complete_capsule'), 0);
  assert.equal(h.state.calls.some(call => call.action === 'put_chunk' && call.index === 2), false);
});

test('busy chunk metadata uses authoritative missing status and the same bounded resend during concurrent upload', async () => {
  const h = harness({ async put_chunk(message, state, normal) {
    const attempts = state.calls.filter(call => call.action === 'put_chunk' && call.index === message.index).length;
    if (message.index === 0 && attempts === 1) return { ok: false, code: 'release_busy', error: 'Metadata is busy.' };
    return normal();
  } });
  await h.client.upload(prepared);
  assert.equal(h.state.peak, 2);
  assert.equal(h.state.count('upload_status'), 1);
  assert.equal(h.state.calls.filter(call => call.action === 'put_chunk' && call.index === 0).length, 2);
  assert.ok(h.state.logs.some(line => line.includes('"release_busy":1')));
  assert.equal(h.state.count('complete_capsule'), 1);
});

test('corrupt downloads drain started reads and stop assigning new chunks', async () => {
  const pending = deferred(), damaged = deferred(); let settled = false;
  const h = harness({ async read_chunk(message, state, normal) {
    if (message.index === 0) { damaged.resolve(); return { sha256: '0'.repeat(64), base64: '' }; }
    await pending.promise; return normal();
  } });
  const running = h.client.download(prepared.capsule.id);
  running.then(() => { settled = true; }, () => { settled = true; });
  await damaged.promise; await tick(); assert.equal(settled, false);
  pending.resolve(); await assert.rejects(running, /chunk identity mismatch/);
  assert.equal(h.state.count('read_chunk'), 2);
});

test('serial fallback and concurrent upload produce the same verified artifact', async () => {
  for (const limit of [1, 2]) {
    const h = harness({}, limit); await h.client.upload(prepared);
    assert.equal(h.state.peak, limit);
    assert.deepEqual(unpack(prepared.capsule, prepared.chunks.map((_, index) => h.state.stored.get(index))), files);
    assert.equal(h.state.calls[0].action, 'begin_capsule');
    assert.equal(h.state.calls.at(-1).action, 'complete_capsule');
  }
  for (const limit of ['0', '3', 'invalid']) {
    assert.throws(() => createClient({ env: { ...env, AIS_RELEASE_TRANSFER_CONCURRENCY: limit } }), /concurrency/);
  }
});
