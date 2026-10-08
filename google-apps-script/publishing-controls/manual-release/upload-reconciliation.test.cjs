'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createClient } = require('./client.cjs');
const { pack } = require('./capsule.cjs');
const prepared = () => pack(new Map([['index.html', Buffer.from('immutable reviewed content')]]), { kind: 'candidate' });
function harness(behavior = {}) {
  const value = prepared(), calls = [], waits = [], stored = new Set(); let complete = false;
  const state = { value, calls, waits, stored, get complete() { return complete; }, set complete(value) { complete = value; } };
  const client = createClient({ env: { REGISTRY_URL: 'https://script.google.com/macros/s/test/exec?token=fake',
    AI4S_PREVIEW_CALLBACK_SECRET: 'local-test-only-capsule-signing-secret-123456' },
  now: () => '2026-10-08T08:00:00.000Z', wait: async milliseconds => { waits.push(milliseconds); },
  fetchImpl: async (url, options) => {
    const message = JSON.parse(JSON.parse(options.body).payload); calls.push(message);
    let result;
    if (behavior[message.action]) result = await behavior[message.action](message, state);
    else if (message.action === 'begin_capsule') result = { capsule_id: value.capsule.id };
    else if (message.action === 'put_chunk') { stored.add(message.index); result = {}; }
    else if (message.action === 'complete_capsule') { complete = true; result = {}; }
    else if (message.action === 'upload_status') result = { capsule: value.capsule, uploaded_indices: [...stored], complete };
    else throw new Error('Unexpected operation');
    return { ok: true, json: async () => ({ ok: true, ...result }) };
  } });
  return { ...state, client, value, count: action => calls.filter(call => call.action === action).length,
    run: () => client.upload(value, { review_id: 'review-test', request_id: 'request-test' }) };
}
test('lost chunk acknowledgement reads persisted status without retransmitting stored bytes', async () => {
  const s = harness({ put_chunk(message, state) { state.stored.add(message.index); throw new Error('connection lost after write'); } });
  assert.equal(await s.run(), s.value.capsule.id);
  assert.equal(s.count('put_chunk'), 1); assert.equal(s.count('upload_status'), 1); assert.equal(s.count('complete_capsule'), 1);
});
test('authoritatively missing chunk permits exactly one resend with identical bytes', async () => {
  const s = harness({ put_chunk(message, state) {
    if (state.calls.filter(call => call.action === 'put_chunk').length === 1) throw new Error('write never arrived');
    state.stored.add(message.index); return {};
  } });
  await s.run();
  assert.deepEqual(s.calls.map(call => call.action), ['begin_capsule', 'put_chunk', 'upload_status', 'put_chunk', 'complete_capsule']);
  const writes = s.calls.filter(call => call.action === 'put_chunk');
  assert.equal(writes[0].base64, writes[1].base64); assert.equal(writes[0].sha256, writes[1].sha256);
  assert.equal(writes[0].capsule_id, writes[1].capsule_id); assert.equal(writes[0].index, writes[1].index);
});
test('a lost resend acknowledgement is reconciled without a third write', async () => {
  const s = harness({ put_chunk(message, state) {
    if (state.calls.filter(call => call.action === 'put_chunk').length === 2) state.stored.add(message.index);
    throw new Error('unknown response');
  } });
  await s.run(); assert.equal(s.count('put_chunk'), 2); assert.equal(s.count('upload_status'), 2);
});
test('persistent missing acknowledgement stops after one resend without completing capsule', async () => {
  const s = harness({ put_chunk() { throw new Error('unavailable'); } });
  await assert.rejects(s.run(), /chunk upload remains unconfirmed/);
  assert.equal(s.count('put_chunk'), 2); assert.equal(s.count('complete_capsule'), 0);
});
test('a busy metadata lock reports a useful failure without more chunk or publication retries', async () => {
  const s = harness({ put_chunk() { return { ok: false, code: 'release_busy', retryable: true, error: 'Release metadata is busy.' }; } });
  await assert.rejects(s.run(), /another Registry operation holds the metadata lock/);
  assert.equal(s.count('put_chunk'), 2); assert.equal(s.count('upload_status'), 2);
  assert.equal(s.count('complete_capsule'), 0); assert.equal(s.count('deployment_succeeded'), 0);
});
test('unavailable status permits only bounded read attempts and no blind retransmission', async () => {
  const s = harness({ put_chunk() { throw new Error('unknown'); }, upload_status() { throw new Error('unavailable'); } });
  await assert.rejects(s.run(), /not confirmed/);
  assert.equal(s.count('put_chunk'), 1); assert.equal(s.count('upload_status'), 3);
  assert.deepEqual(s.waits, [250, 750]); assert.equal(s.count('complete_capsule'), 0);
});
test('changed capsule identity or malformed uploaded indices never authorize a resend', async () => {
  for (const kind of ['identity', 'duplicates', 'out-of-range', 'false-complete']) {
    const s = harness({ put_chunk() { throw new Error('unknown'); }, upload_status(message, state) {
      return { capsule: kind === 'identity' ? { ...state.value.capsule, archive_sha256: '0'.repeat(64) } : state.value.capsule,
        uploaded_indices: kind === 'duplicates' ? [0, 0] : kind === 'out-of-range' ? [1] : [], complete: kind === 'false-complete' };
    } });
    await assert.rejects(s.run(), /upload status/); assert.equal(s.count('put_chunk'), 1); assert.equal(s.count('complete_capsule'), 0);
  }
});
test('lost begin acknowledgement can recover the same descriptor without repeating begin', async () => {
  const s = harness({ begin_capsule() { throw new Error('stored but response lost'); } });
  await s.run(); assert.equal(s.count('begin_capsule'), 1); assert.equal(s.count('put_chunk'), 1);
});
test('lost complete acknowledgement is accepted only when authoritative status is complete', async () => {
  const s = harness({ complete_capsule(message, state) { state.complete = true; throw new Error('response lost'); } });
  await s.run(); assert.equal(s.count('complete_capsule'), 1); assert.equal(s.count('upload_status'), 1);
  const missing = harness({ complete_capsule() { throw new Error('never completed'); } });
  await assert.rejects(missing.run(), /completion remains unconfirmed/); assert.equal(missing.count('complete_capsule'), 1);
});
test('production claim and success acknowledgement remain single-attempt operations', async () => {
  for (const action of ['claim_production', 'deployment_succeeded']) {
    const s = harness({ [action]() { throw new Error('unknown outcome'); } });
    await assert.rejects(s.client.call(action, { request_id: 'request-test' }), /not confirmed/);
    assert.equal(s.count(action), 1); assert.equal(s.count('upload_status'), 0);
  }
});
