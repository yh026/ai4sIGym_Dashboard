'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('./client.cjs');
const { pack, CHUNK_SIZE } = require('./capsule.cjs');
const env = { REGISTRY_URL: 'https://script.google.com/macros/s/test/exec',
  AI4S_PREVIEW_CALLBACK_SECRET: 'read-recovery-test-only-secret-123456789', AIS_RELEASE_TRANSFER_CONCURRENCY: '1' };
const prepared = pack(new Map([['index.html', Buffer.from('verified input')]]), { kind: 'preview' }, 'read-recovery-capsule');
function harness(source = prepared, behavior = () => null, cache = null) {
  const calls = [], waits = [];
  const client = createClient({ env, cache, wait: async ms => waits.push(ms), log: () => {}, fetchImpl: async (_, options) => {
    const message = JSON.parse(JSON.parse(options.body).payload); calls.push(message);
    const special = await behavior(message, calls); if (special) return special;
    const result = message.action === 'read_capsule' ? { capsule: source.capsule }
      : { sha256: source.capsule.chunks[message.index].sha256, base64: source.chunks[message.index].toString('base64') };
    return { ok: true, status: 200, json: async () => ({ ok: true, ...result }) };
  } });
  return { client, calls, waits };
}

test('a pinned read survives a lost response and a transient HTTP error, then verifies its bytes', async () => {
  let attempts = 0;
  const h = harness(prepared, message => {
    if (message.action !== 'read_chunk') return;
    if (++attempts === 1) throw new TypeError('Network interrupted');
    if (attempts === 2) return { ok: false, status: 503, json: async () => { throw new SyntaxError('upstream HTML'); } };
  });
  assert.equal((await h.client.download(prepared.capsule.id, { request_id: 'pinned-request' })).files.get('index.html').toString(), 'verified input');
  assert.equal(attempts, 3); assert.equal(h.waits.length, 2);
  assert.ok(h.calls.every(call => call.capsule_id === prepared.capsule.id && call.request_id === 'pinned-request'));
});

test('authorization rejection and corrupt content are never retried', async () => {
  const failures = [
    { ok: false, status: 403, json: async () => { throw new SyntaxError('forbidden'); } },
    { ok: true, status: 200, json: async () => ({ ok: false, error: 'Authorization revoked.' }) },
    { ok: true, status: 200, json: async () => ({ ok: true, sha256: '0'.repeat(64), base64: '' }) },
  ];
  for (const failure of failures) {
    const h = harness(prepared, message => message.action === 'read_chunk' ? failure : null);
    await assert.rejects(h.client.download(prepared.capsule.id));
    assert.equal(h.calls.filter(call => call.action === 'read_chunk').length, 1);
    assert.equal(h.waits.length, 0);
  }
});

test('verified chunks survive a later interrupted read and the next download rechecks its descriptor', async () => {
  const source = pack(new Map([['assets/data.bin', crypto.randomBytes(CHUNK_SIZE + 1000)]]), { kind: 'preview' }, 'partial-input-cache');
  const saved = new Map(), cache = { get: item => saved.get(item.sha256), put: (item, bytes) => saved.set(item.sha256, bytes) };
  const h = harness(source, message => { if (message.action === 'read_chunk' && message.index === 1) throw new TypeError('Interrupted'); }, cache);
  await assert.rejects(h.client.download(source.capsule.id), /request was not confirmed/);
  assert.equal(h.calls.filter(call => call.action === 'read_chunk' && call.index === 1).length, 3);
  assert.deepEqual(saved.get(source.capsule.chunks[0].sha256), source.chunks[0]);
  assert.equal(saved.has(source.capsule.chunks[1].sha256), false);
  const next = harness(source, () => null, cache);
  assert.equal((await next.client.download(source.capsule.id)).files.get('assets/data.bin').length, CHUNK_SIZE + 1000);
  assert.deepEqual(next.calls.map(call => [call.action, call.index]), [['read_capsule', undefined], ['read_chunk', 1]]);
});
