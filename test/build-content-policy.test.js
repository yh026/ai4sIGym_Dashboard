'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBuildContentPolicy,
  resolvePreviewHookReceipt,
  requireMatchingRegistryRevision,
  createDeployReceipt,
  deployHeaders,
  scopedRegistryUrl,
  isPublishableDemo,
} = require('../build.js');

const STATUS_REVISION = `sha256:${'2'.repeat(64)}`;

const verifiedPreviewPayload = {
  schema: 1,
  target: 'preview',
  branch: 'develop',
  registry_revision: STATUS_REVISION,
  request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  requested_at: '2026-08-11T01:02:03.004Z',
};

test('only the stable develop Branch Deploy gets Preview content', () => {
  assert.equal(resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'develop',
  }).audience, 'preview');

  for (const env of [
    { NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'main' },
    { NETLIFY: 'true', CONTEXT: 'deploy-preview', BRANCH: 'develop' },
    { NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'main' },
    { NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'feature/example' },
    {},
  ]) {
    assert.equal(resolveBuildContentPolicy(env).audience, 'production');
  }
});

test('a Netlify production deploy is locked to main', () => {
  assert.throws(
    () => resolveBuildContentPolicy({
      NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'develop',
    }),
    /production.*main/i,
  );
});

test('Preview Hook payload is optional for Git builds but strict when Hook metadata is present', () => {
  const policy = resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'develop',
  });
  assert.equal(resolvePreviewHookReceipt({}, policy).verified, false);

  const verified = resolvePreviewHookReceipt({
    INCOMING_HOOK_BODY: JSON.stringify(verifiedPreviewPayload),
  }, policy);
  assert.deepEqual(verified, {
    verified: true,
    registryRevision: STATUS_REVISION,
    requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    requestedAt: '2026-08-11T01:02:03.004Z',
  });

  assert.throws(
    () => resolvePreviewHookReceipt({ INCOMING_HOOK_TITLE: 'Preview' }, policy),
    /payload is missing/i,
  );
  assert.throws(
    () => resolvePreviewHookReceipt({ INCOMING_HOOK_BODY: '{broken' }, policy),
    /valid JSON/i,
  );
  assert.throws(
    () => resolvePreviewHookReceipt({ INCOMING_HOOK_BODY: '[]' }, policy),
    /JSON object/i,
  );
});

test('verified Preview payload requires exact safe fields and never echoes rejected values', () => {
  const policy = resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'develop',
  });
  const invalid = [
    { ...verifiedPreviewPayload, schema: 2 },
    { ...verifiedPreviewPayload, target: 'production' },
    { ...verifiedPreviewPayload, branch: 'main' },
    { ...verifiedPreviewPayload, registry_revision: 'short' },
    { ...verifiedPreviewPayload, request_id: 'bad request id' },
    { ...verifiedPreviewPayload, requested_at: '2026-02-31T01:02:03.004Z' },
    { ...verifiedPreviewPayload, unexpected: 'TOP_SECRET_SENTINEL' },
  ];
  invalid.forEach(payload => {
    let error;
    try {
      resolvePreviewHookReceipt({ INCOMING_HOOK_BODY: JSON.stringify(payload) }, policy);
    } catch (caught) { error = caught; }
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /TOP_SECRET_SENTINEL/);
  });
  assert.throws(
    () => resolvePreviewHookReceipt({ INCOMING_HOOK_BODY: 'x'.repeat(2049) }, policy),
    /too large/i,
  );

  const production = resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'main',
  });
  assert.equal(resolvePreviewHookReceipt({ INCOMING_HOOK_BODY: '{}' }, production).verified, false);
});

test('registry revision comparison fails closed without exposing either revision', () => {
  assert.equal(
    requireMatchingRegistryRevision(STATUS_REVISION, '', 'Initial manifest'),
    STATUS_REVISION,
  );
  assert.equal(
    requireMatchingRegistryRevision(STATUS_REVISION, STATUS_REVISION, 'Project file'),
    STATUS_REVISION,
  );
  assert.throws(
    () => requireMatchingRegistryRevision('', STATUS_REVISION, 'Project file'),
    /did not return registry_revision/,
  );
  let mismatch;
  try {
    requireMatchingRegistryRevision(
      `sha256:${'3'.repeat(64)}`, `sha256:${'4'.repeat(64)}`, 'Final manifest',
    );
  } catch (error) { mismatch = error; }
  assert.ok(mismatch instanceof Error);
  assert.match(mismatch.message, /does not match/);
  assert.doesNotMatch(mismatch.message, /sha256:[34]+/);
});

test('public deploy receipt is allowlisted and Preview/receipt headers discourage indexing', () => {
  const policy = resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'develop',
  });
  const trigger = resolvePreviewHookReceipt({
    INCOMING_HOOK_BODY: JSON.stringify(verifiedPreviewPayload),
  }, policy);
  const receipt = createDeployReceipt({
    COMMIT_REF: 'a'.repeat(40),
    BUILD_ID: 'build-123',
    DEPLOY_ID: 'deploy-456',
    REGISTRY_URL: 'https://example.invalid/exec?token=TOP_SECRET_SENTINEL',
    INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/TOP_SECRET_SENTINEL',
    INCOMING_HOOK_BODY: 'TOP_SECRET_SENTINEL',
  }, policy, trigger, STATUS_REVISION, '2026-08-11T02:03:04.005Z');

  assert.equal(receipt.verified, true);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.request_id, verifiedPreviewPayload.request_id);
  assert.equal(receipt.registry_revision, verifiedPreviewPayload.registry_revision);
  assert.equal(receipt.context, 'branch-deploy');
  assert.equal(receipt.commit_ref, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(receipt), /TOP_SECRET_SENTINEL|build_hooks|token=/i);

  const previewHeaders = deployHeaders(policy);
  assert.match(previewHeaders, /\/deploy-receipt\.json[\s\S]*Cache-Control: no-store/);
  assert.match(previewHeaders, /\/\*\n  X-Robots-Tag: noindex, nofollow/);
  const productionHeaders = deployHeaders({ audience: 'production' });
  assert.match(productionHeaders, /\/deploy-receipt\.json/);
  assert.doesNotMatch(productionHeaders, /\/\*\n/);
});

test('registry requests override stale status and audience parameters', () => {
  const base = 'https://example.invalid/exec?token=secret&status=all&status=Draft'
    + '&audience=preview&registry_revision=stale-revision';
  const production = { audience: 'production' };
  const preview = { audience: 'preview' };

  const productionManifest = new URL(scopedRegistryUrl(base, 'manifest', production));
  assert.equal(productionManifest.searchParams.get('token'), 'secret');
  assert.equal(productionManifest.searchParams.get('action'), 'manifest');
  assert.equal(productionManifest.searchParams.get('audience'), 'production');
  assert.equal(productionManifest.searchParams.has('status'), false);
  assert.equal(productionManifest.searchParams.has('id'), false);
  assert.equal(productionManifest.searchParams.has('registry_revision'), false);

  const previewFile = new URL(scopedRegistryUrl(
    base, 'file', preview, 'draft-id', STATUS_REVISION,
  ));
  assert.equal(previewFile.searchParams.get('action'), 'file');
  assert.equal(previewFile.searchParams.get('audience'), 'preview');
  assert.equal(previewFile.searchParams.get('id'), 'draft-id');
  assert.equal(previewFile.searchParams.get('registry_revision'), STATUS_REVISION);
  assert.equal(previewFile.searchParams.has('status'), false);
});

test('Production publishes only healthy Live rows; Preview additionally permits Draft', () => {
  const rows = [
    { name: 'live', status: 'Live', file_check: 'ok' },
    { name: 'draft', status: 'Draft', file_check: 'ok — no provenance.md' },
    { name: 'archived', status: 'Archived', file_check: 'ok' },
    { name: 'unknown', status: 'Published', file_check: 'ok' },
    { name: 'blank', status: '', file_check: 'ok' },
    { name: 'missing', status: 'Live', file_check: 'missing' },
    { name: 'unreadable', status: 'Live', file_check: 'ok — provenance unreadable' },
    { name: 'empty', status: 'Live', file_check: 'ok — page empty' },
    { name: 'asset-warning', status: 'Live', file_check: 'check assets: missing-image.png' },
  ];

  assert.deepEqual(
    rows.filter(row => isPublishableDemo(row, { audience: 'production' })).map(row => row.name),
    ['live', 'asset-warning'],
  );
  assert.deepEqual(
    rows.filter(row => isPublishableDemo(row, { audience: 'preview' })).map(row => row.name),
    ['live', 'draft', 'asset-warning'],
  );
});
