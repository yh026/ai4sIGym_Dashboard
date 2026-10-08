'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createReleaseIntent, digest } = require('./release-plan.cjs');
const { createNetlifyBridge, validateArtifact, inventoryDigest } = require('./netlify-bridge.cjs');

function fixture() {
  const site = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973';
  const project = { demo_id: 'demo-a', slug: 'a', content_digest: digest('a') };
  const baseline = { environment: 'production', site_id: site, state: 'ready', branch: 'main',
    context: 'production', commit_ref: 'c'.repeat(40), deploy_id: 'a'.repeat(24),
    receipt_digest: digest('receipt'), inventory_digest: digest('inventory'), projects: [project], publication_overrides: [] };
  const current = { baseline, preview: null, catalog: [{ demo_id: 'demo-a', slug: 'a' }],
    selection: [{ demo_id: 'demo-a', include_in_production: true, include_in_preview: false }],
    now: '2026-10-07T01:00:00.000Z' };
  const intent = createReleaseIntent(current);
  const files = new Map(Object.entries({
    'index.html': '<html>Reviewed homepage</html>', 'robots.txt': 'User-agent: *\nAllow: /\n',
    '_headers': '/deploy-receipt.json\n  Cache-Control: no-store\n',
    'demos/a/index.html': '<html>Scientific result</html>',
    'manifest.json': JSON.stringify({ schema_version: 3, audience: 'production', demos: [
      { demo_id: 'demo-a', slug: 'a', status: 'Live', public_page_permission: 'Public',
        pages: [{ role: 'insight', path: 'demos/a/index.html' }] }] }),
    'deploy-receipt.json': JSON.stringify({ target: 'production', audience: 'production',
      intent_digest: intent.intent_digest, baseline_deploy_id: baseline.deploy_id }),
  }).map(([path, text]) => [path, Buffer.from(text)]));
  const artifact = { schema: 1, intent_digest: intent.intent_digest, files };
  const reviewedArtifactDigest = digest([...files].map(([path, bytes]) => ({ path, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') })).sort((a, b) => a.path.localeCompare(b.path)));
  const rendererEvidence = { projects: structuredClone(intent.projects), preserved_overrides: [],
    catalog_pages_regenerated: true, unselected_routes_absent: true, source_files_unchanged: true };
  return { current, intent, artifact, reviewedArtifactDigest, rendererEvidence };
}

function mockService(input, options = {}) {
  const calls = [], candidateId = 'd'.repeat(24);
  let published = input.intent.baseline.deploy_id;
  const validated = validateArtifact(input.intent, input.artifact, input.reviewedArtifactDigest);
  const deploy = { id: candidateId, site_id: input.intent.site_id, state: 'ready', context: 'deploy-preview',
    published_at: null, commit_ref: null, title: 'Reviewed project release ' + input.intent.intent_digest.slice(7, 19), required: [] };
  const listing = Object.entries(validated.files).map(([path, sha]) => ({ path, sha, deploy_id: candidateId }));
  const fetchImpl = async (url, request) => {
    calls.push({ path: new URL(url).pathname + new URL(url).search, method: request.method,
      body: request.body && JSON.parse(request.body) });
    let result;
    if (request.method === 'POST' && url.endsWith('/restore')) { published = candidateId; result = {}; }
    else if (request.method === 'POST' && url.endsWith('/deploys')) result = deploy;
    else if (url.includes('/files?deploy_id=')) result = options.alterInventory ? [...listing].slice(1) : listing;
    else if (url.endsWith('/deploys/' + candidateId)) result = deploy;
    else result = { id: input.intent.site_id, published_deploy: { id: options.changedBaseline ? 'e'.repeat(24) : published,
      commit_ref: input.intent.baseline.commit_ref } };
    return { ok: true, status: 200, json: async () => result };
  };
  const bridge = createNetlifyBridge({ token: 'local-only-test-token-do-not-use', fetchImpl, sleep: async () => {} });
  return { bridge, calls };
}

test('prepare creates only a draft and verifies exact immutable inventory without publishing', async () => {
  const input = fixture(), service = mockService(input);
  const candidate = await service.bridge.prepare(input);
  assert.equal(candidate.draft, true);
  const writes = service.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1); assert.equal(writes[0].body.draft, true);
  assert.equal(writes[0].body.async, true);
  assert.equal(service.calls.some(call => call.path.endsWith('/restore')), false);
});

test('resume verifies the exact existing draft and does not send another create request', async () => {
  const input = fixture(), service = mockService(input);
  const candidate = await service.bridge.prepare({ ...input, resumeCandidateId: 'd'.repeat(24) });
  assert.equal(candidate.deploy_id, 'd'.repeat(24));
  assert.equal(service.calls.some(call => call.method !== 'GET'), false);
  assert.equal(candidate.isolation_evidence.context, 'deploy-preview');
});

test('publish requires exact confirmation and rechecks baseline and candidate before the only production write', async () => {
  const input = fixture(), service = mockService(input);
  const candidate = await service.bridge.prepare(input);
  await assert.rejects(service.bridge.publish({ ...input, candidate, confirmation: 'yes' }), /explicit confirmation/);
  assert.equal(service.calls.some(call => call.path.endsWith('/restore')), false);
  const result = await service.bridge.publish({ ...input, candidate, confirmation: input.intent.intent_digest });
  assert.equal(result.published, true);
  assert.equal(service.calls.filter(call => call.path.endsWith('/restore')).length, 1);
  const lastWrite = service.calls.findLastIndex(call => call.method !== 'GET');
  assert.equal(service.calls[lastWrite - 1].path, '/api/v1/sites/' + input.intent.site_id);
});

test('changed production prevents draft creation and publication', async () => {
  const input = fixture(), original = mockService(input), candidate = await original.bridge.prepare(input);
  const changed = mockService(input, { changedBaseline: true });
  await assert.rejects(changed.bridge.prepare(input), /production changed/);
  await assert.rejects(changed.bridge.publish({ ...input, candidate, confirmation: input.intent.intent_digest }), /production changed/);
  assert.equal(changed.calls.some(call => call.method !== 'GET'), false);
});

test('candidate byte mismatch prevents publish and no request retries an uncertain write', async () => {
  const input = fixture(), original = mockService(input), candidate = await original.bridge.prepare(input);
  const changed = mockService(input, { alterInventory: true });
  await assert.rejects(changed.bridge.publish({ ...input, candidate, confirmation: input.intent.intent_digest }), /bytes changed/);
  assert.equal(changed.calls.some(call => call.method !== 'GET'), false);
  let writes = 0;
  const bridge = createNetlifyBridge({ token: 'local-only-test-token-do-not-use', fetchImpl: async (url, options) => {
    if (options.method === 'POST') { writes++; throw new Error('network error with private URL'); }
    return { ok: true, json: async () => ({ id: input.intent.site_id,
      published_deploy: { id: input.intent.baseline.deploy_id, commit_ref: input.intent.baseline.commit_ref } }) };
  } });
  await assert.rejects(bridge.prepare(input), /status must be reconciled/);
  assert.equal(writes, 1);
});

test('artifact validation rejects changed bytes, extra project routes and invalid production receipt', () => {
  for (const mutate of [a => a.files.set('index.html', Buffer.from('changed')),
    a => a.files.set('demos/unpublished/index.html', Buffer.from('hidden')),
    a => a.files.set('deploy-receipt.json', Buffer.from('{}'))]) {
    const input = fixture(); mutate(input.artifact);
    assert.throws(() => validateArtifact(input.intent, input.artifact, input.reviewedArtifactDigest), /reviewed bytes/);
  }
  assert.equal(inventoryDigest({ '/a': 'a', '/b': 'b' }), inventoryDigest({ '/b': 'b', '/a': 'a' }));
});
