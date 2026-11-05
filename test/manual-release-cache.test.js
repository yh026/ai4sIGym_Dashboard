'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = '../google-apps-script/publishing-controls/manual-release/';
const { pack } = require(base + 'capsule.cjs');
const { createClient } = require(base + 'client.cjs');
const { createCache, enabled, cacheLifecycle } = require(base + 'cache.cjs');
const env = { AI4S_PREVIEW_CALLBACK_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  REGISTRY_URL: 'https://script.google.com/macros/s/test/exec', NETLIFY: 'true',
  BRANCH: 'main', CONTEXT: 'production' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cache = createCache(path.join(directory, 'chunks'));
  let prepared = pack(new Map([['index.html', Buffer.from('first version')]]), { kind: 'preview' }, 'same-id');
  let rejected = false; const calls = [], logs = [];
  const client = createClient({ env, cache, log: text => logs.push(text), fetchImpl: async (_, options) => {
    const request = JSON.parse(JSON.parse(options.body).payload); calls.push(request.action);
    if (rejected) return { ok: true, json: async () => ({ ok: false, error: 'Authorization revoked.' }) };
    const result = request.action === 'read_capsule' ? { capsule: prepared.capsule }
      : { sha256: prepared.capsule.chunks[request.index].sha256, base64: prepared.chunks[request.index].toString('base64') };
    return { ok: true, json: async () => ({ ok: true, ...result }) };
  }});
  return { directory, cache, client, calls, logs, current: () => prepared,
    replace: value => { prepared = value; }, reject: () => { rejected = true; } };
}
test('cold then warm build reuses exact bytes but always reads the authorized descriptor', async t => {
  const f = fixture(t);
  const cold = await f.client.download('same-id');
  const warm = await f.client.download('same-id');
  assert.deepEqual(warm.files, cold.files);
  assert.deepEqual(f.calls, ['read_capsule', 'read_chunk', 'read_capsule']);
  assert.match(f.logs.filter(line => line.startsWith('Release download: '))[1], /1\/1 cached chunks; 0 bytes/);
  // Simulate a separate build restoring only the on-disk directory.
  const reloaded = createCache(path.join(f.directory, 'chunks'));
  assert.deepEqual(reloaded.get(f.current().capsule.chunks[0]), f.current().chunks[0]);
});
test('client accepts larger Preview descriptors but rejects the same Production size before downloading', async t => {
  const f=fixture(t), original=f.current(), size=264*1024*1024;
  const capsule={...original.capsule,archive_size:size,unpacked_size:size,
    chunks:Array.from({length:33},(_,index)=>({index,size:8388608,sha256:'a'.repeat(64)}))};
  f.replace({...original,capsule,chunks:Array(33).fill(original.chunks[0])});
  await assert.rejects(f.client.download('same-id'), /content mismatch/);
  assert.ok(f.calls.includes('read_chunk'));
  f.calls.length=0;
  f.replace({...original,capsule:{...capsule,kind:'production',provenance:{kind:'production'}}});
  await assert.rejects(f.client.download('same-id'), /descriptor is invalid/);
  assert.deepEqual(f.calls,['read_capsule']);
});
test('fresh descriptor changes invalidate bytes even when a capsule ID is reused', async t => {
  const f = fixture(t); await f.client.download('same-id');
  f.replace(pack(new Map([['index.html', Buffer.from('new Drive content')]]), { kind: 'preview' }, 'same-id'));
  const result = await f.client.download('same-id');
  assert.equal(result.files.get('index.html').toString(), 'new Drive content');
  assert.equal(f.calls.filter(x => x === 'read_chunk').length, 2);
});
test('corruption, missing cache and unwritable cache fall back to Drive', async t => {
  const f = fixture(t); await f.client.download('same-id');
  const file = path.join(f.directory, 'chunks', f.current().capsule.chunks[0].sha256);
  fs.writeFileSync(file, Buffer.alloc(f.current().chunks[0].length));
  await f.client.download('same-id');
  fs.rmSync(path.join(f.directory, 'chunks'), { recursive: true });
  await f.client.download('same-id');
  fs.rmSync(path.join(f.directory, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(f.directory, 'chunks'), 'not a directory');
  await f.client.download('same-id');
  assert.equal(f.calls.filter(x => x === 'read_chunk').length, 4);
});
test('warm cache cannot bypass authorization or archive/provenance verification', async t => {
  const f = fixture(t); await f.client.download('same-id');
  f.current().capsule.provenance = { kind: 'production' };
  await assert.rejects(f.client.download('same-id'), /identity/);
  f.reject(); await assert.rejects(f.client.download('same-id'), /Authorization revoked/);
});
test('store rejects unsafe keys and symlinks, prunes bytes without following links', async t => {
  const f = fixture(t); await f.client.download('same-id');
  const item = f.current().capsule.chunks[0], target = path.join(f.directory, 'outside');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(f.directory, 'chunks', 'foreign'));
  assert.equal(f.cache.get({ ...item, sha256: '../../outside' }), null);
  assert.equal(f.cache.put(item, Buffer.from('bad bytes')), false);
  f.cache.prune(0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(f.cache.get(item), null);
  fs.symlinkSync(target, path.join(f.directory, 'chunks', item.sha256));
  assert.equal(f.cache.get(item), null);
});
test('cache is limited to explicit main production builds and cache service failures are nonfatal', async () => {
  assert.equal(enabled(env), true);
  for (const patch of [{ BRANCH: 'feature/review' }, { BRANCH: 'develop' }, { CONTEXT: 'branch-deploy' }, { NETLIFY: 'false' }, { AIS_RELEASE_CACHE: 'off' }]) {
    assert.equal(enabled({ ...env, ...patch }), false);
  }
  const calls = [], logs = [];
  const utils = { cache: { restore: async dir => { calls.push(dir); throw new Error('Unavailable'); } } };
  await cacheLifecycle('restore', { env, utils, log: text => logs.push(text) });
  assert.equal(calls.length, 1); assert.match(logs[0], /fallback/);
  await cacheLifecycle('restore', { env: { ...env, BRANCH: 'develop' }, utils });
  assert.equal(calls.length, 1);
});

test('completed new Production is reusable by the next build without reading its bytes from Drive', async t => {
  const f = fixture(t);
  const prepared = pack(new Map([['index.html', Buffer.from('newly published version')]]), { kind: 'production' }, 'new-production');
  const calls = [];
  const client = createClient({ env, cache: f.cache, log: () => {}, fetchImpl: async (_, options) => {
    const request = JSON.parse(JSON.parse(options.body).payload); calls.push(request.action);
    if (request.action === 'complete_capsule') assert.equal(f.cache.get(prepared.capsule.chunks[0]), null);
    return { ok: true, json: async () => ({ ok: true, capsule_id: prepared.capsule.id }) };
  } });
  await client.upload(prepared);
  assert.deepEqual(calls, ['begin_capsule', 'put_chunk', 'complete_capsule']);
  // A later client has only the restored bytes and must still read its newly
  // authorized descriptor. No release identity/permission is taken from cache.
  const restored = createCache(path.join(f.directory, 'chunks'));
  const next = createClient({ env, cache: restored, log: () => {}, fetchImpl: async (_, options) => {
    const request = JSON.parse(JSON.parse(options.body).payload);
    assert.equal(request.action, 'read_capsule');
    return { ok: true, json: async () => ({ ok: true, capsule: prepared.capsule }) };
  } });
  assert.equal((await next.download(prepared.capsule.id)).files.get('index.html').toString(), 'newly published version');
});

test('unconfirmed archives do not populate the output cache; cache write failure cannot fail a confirmed upload', async t => {
  const f = fixture(t), prepared = pack(new Map([['index.html', Buffer.from('new output')]]), { kind: 'production' });
  let complete = false;
  const fetchImpl = async (_, options) => {
    const request = JSON.parse(JSON.parse(options.body).payload);
    if (request.action === 'complete_capsule' && !complete) throw new Error('not confirmed');
    const result = request.action === 'upload_status'
      ? { capsule: prepared.capsule, uploaded_indices: [0], complete }
      : { capsule_id: prepared.capsule.id };
    return { ok: true, json: async () => ({ ok: true, ...result }) };
  };
  const failed = createClient({ env, cache: f.cache, log: () => {}, fetchImpl });
  await assert.rejects(failed.upload(prepared), /completion remains unconfirmed/);
  assert.equal(f.cache.get(prepared.capsule.chunks[0]), null);
  complete = true;
  const logs = [];
  const confirmed = createClient({ env, cache: { put() { throw new Error('disk unavailable'); } }, log: text => logs.push(text), fetchImpl });
  assert.equal(await confirmed.upload(prepared), prepared.capsule.id);
  assert.ok(logs.some(line => line.includes('"stage":"cache_output"') && line.includes('"cached_chunks":0')));
});

test('capacity pruning retains recently used content instead of older chunks', t => {
  const f = fixture(t), old = f.current(), recent = pack(new Map([['index.html', Buffer.from('latest output')]]), { kind: 'production' });
  f.cache.put(old.capsule.chunks[0], old.chunks[0]);
  fs.utimesSync(path.join(f.directory, 'chunks', old.capsule.chunks[0].sha256), 1, 1);
  f.cache.put(recent.capsule.chunks[0], recent.chunks[0]);
  f.cache.prune(recent.chunks[0].length);
  assert.equal(f.cache.get(old.capsule.chunks[0]), null);
  assert.deepEqual(f.cache.get(recent.capsule.chunks[0]), recent.chunks[0]);
});
