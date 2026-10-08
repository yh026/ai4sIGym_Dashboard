'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pack, unpack, hash, CHUNK_SIZE, readDirectory } = require('./capsule.cjs');
const { validateHook, DOMAIN, SITE_ID, REVIEW_BRANCH } = require('./hook.cjs');
const { createClient } = require('./client.cjs');
const { productionBuild, artifactDigest, capsuleSource } = require('./build.cjs');
const { exportSuccessfulBuild, reportFailedBuild } = require('./plugin.cjs');
const NOW = '2026-10-08T08:00:00.000Z';
const secret = 'test-signing-key-never-used-outside-tests-123456';
const env = () => ({ NETLIFY: 'true', SITE_ID, BRANCH: 'main', CONTEXT: 'production',
  COMMIT_REF: 'a'.repeat(40), BUILD_ID: 'build-test', DEPLOY_ID: 'b'.repeat(24),
  AI4S_PREVIEW_CALLBACK_SECRET: secret, REGISTRY_URL: 'https://script.google.com/macros/s/test/exec?token=fake' });
const request = () => ({ schema: 1, target: 'production', site_id: SITE_ID, branch: 'main',
  review_id: 'review-123456', request_id: 'request-123456', requested_at: NOW,
  expires_at: '2026-10-08T08:30:00.000Z', candidate_capsule_id: 'capsule-123456',
  artifact_digest: 'sha256:' + 'c'.repeat(64), baseline_deploy_id: 'd'.repeat(24) });
const sign = value => { const payload = JSON.stringify(value); return JSON.stringify({ payload,
  signature: crypto.createHmac('sha256', secret).update(DOMAIN + payload).digest('hex') }); };
const manifest = () => ({ schema_version: 3, taxonomy: {}, demos: [] });
const candidateFiles = () => new Map([
  ['index.html', Buffer.from('<h1>Reviewed content</h1>')],
  ['manifest.json', Buffer.from(JSON.stringify(manifest()))],
  ['deploy-receipt.json', Buffer.from(JSON.stringify({ schema: 1, target: 'production', audience: 'production',
    platform: 'netlify', baseline_deploy_id: 'd'.repeat(24), publication_overrides: [], projects: [] }))],
]);

test('capsule roundtrip retains every byte and chunks oversized compressed artifacts', () => {
  const files = new Map([['index.html', Buffer.from('hello')], ['assets/random.bin', crypto.randomBytes(CHUNK_SIZE + 1000)]]);
  const prepared = pack(files, { kind: 'candidate' });
  assert.equal(prepared.chunks.length, 2);
  assert.deepEqual(unpack(prepared.capsule, prepared.chunks), files);
});
test('capsule rejects chunk corruption, altered metadata, unsafe and colliding paths', () => {
  const prepared = pack(new Map([['index.html', Buffer.from('hello')]]), { kind: 'candidate' });
  const damaged = Buffer.from(prepared.chunks[0]); damaged[5] ^= 1;
  assert.throws(() => unpack(prepared.capsule, [damaged]), /chunk mismatch/);
  assert.throws(() => unpack({ ...prepared.capsule, provenance: { kind: 'production' } }, prepared.chunks), /identity/);
  for (const name of ['../secret', '/absolute', 'a//b', 'a/./b']) assert.throws(() => pack(new Map([[name, Buffer.from('x')]]), {}), /unsafe/);
  assert.throws(() => pack(new Map([['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]), {}), /collision/);
});
test('production only accepts signed current manual request with exact environment identity', () => {
  const e = env(); e.INCOMING_HOOK_BODY = sign(request());
  assert.equal(validateHook(e, 'production', Date.parse(NOW)).request_id, request().request_id);
  assert.equal(validateHook({ ...e, INCOMING_HOOK_BODY: encodeURIComponent(e.INCOMING_HOOK_BODY) }, 'production', Date.parse(NOW)).review_id, request().review_id);
  for (const change of [{ INCOMING_HOOK_BODY: '' }, { BRANCH: 'develop' }, { CONTEXT: 'branch-deploy' }, { NETLIFY: 'false' }, { SITE_ID: 'wrong' }]) {
    assert.throws(() => validateHook({ ...e, ...change }, 'production', Date.parse(NOW)));
  }
  assert.throws(() => validateHook({ ...e, INCOMING_HOOK_BODY: JSON.stringify({ payload: '{}', signature: '0'.repeat(64) }) }, 'production', Date.parse(NOW)), /signature/);
  for (const changed of [{ ...request(), expires_at: NOW }, { ...request(), requested_at: '2026-10-09T08:00:00.000Z' },
    { ...request(), target: 'production-review' }, { ...request(), artifact_digest: '' }]) {
    assert.throws(() => validateHook({ ...e, INCOMING_HOOK_BODY: sign(changed) }, 'production', Date.parse(NOW)));
  }
});
test('review branch can only render a review and cannot claim production', () => {
  const r = { ...request(), target: 'production-review', branch: REVIEW_BRANCH };
  const e = { ...env(), BRANCH: REVIEW_BRANCH, CONTEXT: 'branch-deploy', INCOMING_HOOK_BODY: sign(r) };
  assert.equal(validateHook(e, 'production-review', Date.parse(NOW)).target, 'production-review');
  assert.throws(() => validateHook(e, 'production', Date.parse(NOW)), /context/);
});
test('unsigned production stops before network calls or any output mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-nohook-')); const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'existing'), 'unchanged');
  let calls = 0;
  try {
    await assert.rejects(productionBuild({ env: env(), client: { call() { calls++; } }, checkout: dir, now: NOW }), /manual publishing request/);
    assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(dist, 'existing'), 'utf8'), 'unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('production consumes only exact reviewed capsule and stamps receipt without changing scientific files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-production-'));
  const files = candidateFiles(), digest = artifactDigest(files);
  const r = { ...request(), artifact_digest: digest };
  const prepared = pack(files, { kind: 'candidate', review_id: r.review_id, artifact_digest: digest }, r.candidate_capsule_id);
  const calls = [];
  const client = { async call(action, value) { calls.push(action); return { release: value }; }, async download() { return { capsule: prepared.capsule, files }; },
    async upload(value) { calls.push('upload_production'); assert.equal(value.capsule.kind, 'production'); } };
  try {
    const e = { ...env(), INCOMING_HOOK_BODY: sign(r) };
    await productionBuild({ env: e, client, checkout: dir, now: NOW });
    assert.deepEqual(calls, ['claim_production', 'upload_production']);
    const built = readDirectory(path.join(dir, 'dist'));
    assert.deepEqual(built.get('index.html'), files.get('index.html'));
    const receipt = JSON.parse(built.get('deploy-receipt.json'));
    assert.equal(receipt.publication_method, 'manual-build'); assert.equal(receipt.deploy_id, e.DEPLOY_ID);
    assert.equal(receipt.reviewed_artifact_digest, digest);
    const production = pack(built, { kind: 'production', site_id: e.SITE_ID, build_id: e.BUILD_ID,
      deploy_id: e.DEPLOY_ID, commit_ref: e.COMMIT_REF, branch: e.BRANCH, context: e.CONTEXT });
    assert.equal(capsuleSource({ capsule: production.capsule, files: built }, 'production').metadata.id, e.DEPLOY_ID);
    // This output is a valid next release's production source, avoiding the stale Git archive.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('changed reviewed candidate is rejected before writing dist', async () => {
  const files = candidateFiles(), digest = artifactDigest(files), r = { ...request(), artifact_digest: digest };
  const prepared = pack(files, { kind: 'candidate', review_id: r.review_id, artifact_digest: digest }, r.candidate_capsule_id);
  const changed = new Map(files); changed.set('index.html', Buffer.from('unreviewed'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tamper-'));
  try {
    await assert.rejects(productionBuild({ env: { ...env(), INCOMING_HOOK_BODY: sign(r) }, now: NOW, checkout: dir,
      client: { async call(action, value) { return { release: value }; }, async download() { return { capsule: prepared.capsule, files: changed }; } } }), /candidate bytes differ/);
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('client signs each bounded request and does not retry uncertain responses', async () => {
  let calls = 0;
  const client = createClient({ env: env(), now: () => NOW, fetchImpl: async (url, options) => {
    calls++; const body = JSON.parse(options.body), parsed = JSON.parse(body.payload);
    assert.equal(parsed.action, 'claim_production'); assert.equal(parsed.sent_at, NOW);
    assert.equal(body.signature, crypto.createHmac('sha256', secret).update('ais-manual-release-api-v1\n' + body.payload).digest('hex'));
    assert.equal(url.searchParams.get('action'), 'manual_release'); throw new Error('uncertain');
  } });
  await assert.rejects(client.call('claim_production'), /not confirmed/); assert.equal(calls, 1);
});
test('nonmanual preview never exports a publishable capsule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-preview-'));
  const e = { ...env(), BRANCH: 'develop', CONTEXT: 'branch-deploy' };
  fs.writeFileSync(path.join(dir, 'deploy-receipt.json'), JSON.stringify({ schema: 1, target: 'preview', audience: 'preview', verified: false,
    site_id: e.SITE_ID, build_id: e.BUILD_ID, deploy_id: e.DEPLOY_ID, commit_ref: e.COMMIT_REF, branch: e.BRANCH, context: e.CONTEXT }));
  try { assert.equal((await exportSuccessfulBuild({ env: e, publishDir: dir })).reason, 'not-manual-preview'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('failure callback is signed-request-bound and never sends raw build errors', async () => {
  const calls = [], e = { ...env(), INCOMING_HOOK_BODY: sign(request()) };
  const client = { async call(action, data) { calls.push({ action, data }); } };
  assert.equal((await reportFailedBuild({ env: e, client, now: Date.parse(NOW), beforeDeployment: true })).sent, true);
  assert.equal(calls[0].action, 'deployment_failed'); assert.equal(calls[0].data.kind, 'production');
  assert.equal(calls[0].data.request_id, request().request_id);
  assert.equal(calls[0].data.before_deployment, true);
  assert.equal((await reportFailedBuild({ env: env(), client, now: Date.parse(NOW), beforeDeployment: true })).sent, false);
  assert.equal((await reportFailedBuild({ env: e, client, now: Date.parse(NOW), beforeDeployment: false })).sent, false);
  assert.equal(calls.length, 1);
});
test('expired request can report its failure but can never publish', () => {
  const e = { ...env(), INCOMING_HOOK_BODY: sign(request()) }, late = Date.parse(NOW) + 45 * 60000;
  assert.throws(() => validateHook(e, 'production', late), /expired/);
  assert.equal(validateHook(e, 'production', late, { failureReport: true }).request_id, request().request_id);
  assert.throws(() => validateHook(e, 'production', late + 120 * 60000, { failureReport: true }), /expired/);
});
