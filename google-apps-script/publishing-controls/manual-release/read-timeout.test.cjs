'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('./client.cjs');
const { pack } = require('./capsule.cjs');
const files = new Map([['index.html', Buffer.from('verified release')]]);
const prepared = pack(files, { kind: 'production' }, 'slow-read-capsule');

function slowTransport(t, duration) {
  const deadlines = new WeakMap(), calls = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    deadlines.set(controller.signal, { milliseconds, controller });
    return controller.signal;
  });
  const client = createClient({ cache: null, log: () => {},
    env: { REGISTRY_URL: 'https://script.google.com/macros/s/test/exec',
      AI4S_PREVIEW_CALLBACK_SECRET: 'slow-read-test-only-secret-123456789' },
    fetchImpl: async (_, options) => {
      const message = JSON.parse(JSON.parse(options.body).payload); calls.push(message.action);
      const { milliseconds, controller } = deadlines.get(options.signal);
      const elapsed = message.action === 'read_capsule' ? 1000 : duration;
      if (elapsed >= milliseconds) controller.abort(new DOMException('Simulated slow response', 'TimeoutError'));
      options.signal.throwIfAborted();
      const result = message.action === 'read_capsule' ? { capsule: prepared.capsule }
        : message.action === 'read_chunk' ? { sha256: prepared.capsule.chunks[message.index].sha256,
          base64: prepared.chunks[message.index].toString('base64') } : {};
      return { ok: true, json: async () => ({ ok: true, ...result }) };
    } });
  return { client, calls };
}

test('a 138-second successful chunk read survives the transport deadline and verifies all bytes', async t => {
  const h = slowTransport(t, 138000);
  assert.deepEqual((await h.client.download(prepared.capsule.id)).files, files);
  assert.deepEqual(h.calls, ['read_capsule', 'read_chunk']);
});

test('an excessively slow read remains bounded without automatic retries', async t => {
  const h = slowTransport(t, 241000);
  await assert.rejects(h.client.download(prepared.capsule.id), /request was not confirmed/);
  assert.deepEqual(h.calls, ['read_capsule', 'read_chunk']);
});

test('a slow release decision retains its original deadline and is never retried', async t => {
  const h = slowTransport(t, 138000);
  await assert.rejects(h.client.call('claim_production'), /request was not confirmed/);
  assert.deepEqual(h.calls, ['claim_production']);
});
