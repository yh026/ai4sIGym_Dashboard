'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const statusFixture = path.join(root, 'fixtures', 'manifest-status-matrix.json');
const fallbackHtml = path.join(root, 'fixtures', 'demo-minimal.html');
const STATUS_REVISION = `sha256:${'2'.repeat(64)}`;

function statusBuild(context, branch, extraEnv = {}) {
  const env = { ...process.env };
  [
    'INCOMING_HOOK_BODY', 'INCOMING_HOOK_TITLE', 'INCOMING_HOOK_URL',
    'MOCK_FILE_REGISTRY_REVISION', 'MOCK_FINAL_REGISTRY_REVISION',
  ].forEach(key => { delete env[key]; });
  Object.assign(env, {
    NETLIFY: 'true',
    CONTEXT: context,
    BRANCH: branch,
    COMMIT_REF: 'a'.repeat(40),
    BUILD_ID: 'build-test-123',
    DEPLOY_ID: 'deploy-test-456',
    SITE_ID: '33333333-4444-4555-8666-777777777777',
    MOCK_MANIFEST: statusFixture,
    MOCK_HTML_FALLBACK: fallbackHtml,
  }, extraEnv);
  return spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
}

function previewHookBody(registryRevision = STATUS_REVISION) {
  return JSON.stringify({
    schema: 1,
    target: 'preview',
    branch: 'develop',
    registry_revision: registryRevision,
    request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    requested_at: '2026-08-11T01:02:03.004Z',
  });
}

function builtManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
}

function deployReceipt() {
  return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'deploy-receipt.json'), 'utf8'));
}

test('mock build completes and publishes a safe seven-department manifest', () => {
  const env = { ...process.env };
  [
    'NETLIFY', 'CONTEXT', 'BRANCH', 'COMMIT_REF', 'BUILD_ID', 'DEPLOY_ID',
    'INCOMING_HOOK_BODY', 'INCOMING_HOOK_TITLE', 'INCOMING_HOOK_URL',
    'MOCK_MANIFEST', 'MOCK_HTML_FALLBACK', 'MOCK_FILE_REGISTRY_REVISION',
    'MOCK_FINAL_REGISTRY_REVISION',
  ].forEach(key => { delete env[key]; });
  const result = spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
  assert.equal(manifest.taxonomy_version, 4);
  assert.equal(manifest.domains.length, 7);
  assert.equal(manifest.demos.length, 3);
  assert.equal(manifest.demos.some(demo => demo.slug === 'ai-for-science-demos'), false);
  assert.equal(manifest.demos.some(demo => (
    demo.file_id || demo.file_check || demo.picture_file_id || demo.preview_file_id || demo.thumbnail_file_id
  )), false);
  const receipt = deployReceipt();
  assert.equal(receipt.platform, 'local-mock');
  assert.equal(receipt.verified, false);
  assert.equal(receipt.revision_bound, true);
  assert.equal('request_id' in receipt, false);
});

test('mock builds enforce the Production and develop Preview status matrix', () => {
  const routeExists = slug => fs.existsSync(
    path.join(root, 'dist', 'demos', slug, 'index.html'),
  );

  const production = statusBuild('production', 'main');
  assert.equal(production.status, 0, production.stdout + production.stderr);
  assert.deepEqual(builtManifest().demos.map(demo => demo.slug), ['status-live']);
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), false);
  assert.equal(routeExists('status-archived'), false);
  assert.match(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /\/deploy-receipt\.json[\s\S]*X-Robots-Tag: noindex, nofollow/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /\/\*\n/,
  );
  assert.equal(deployReceipt().verified, false);
  assert.equal(deployReceipt().target, 'production');
  assert.equal(deployReceipt().registry_revision, STATUS_REVISION);

  const preview = statusBuild('branch-deploy', 'develop');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(
    builtManifest().demos.map(demo => demo.slug).sort(),
    ['status-draft', 'status-live'],
  );
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), true);
  assert.equal(routeExists('status-archived'), false);
  assert.equal(routeExists('status-missing'), false);
  assert.equal(routeExists('status-unreadable'), false);
  assert.equal(routeExists('status-unknown'), false);
  assert.match(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /X-Robots-Tag: noindex, nofollow/,
  );
  assert.equal(deployReceipt().verified, false);
  assert.equal(deployReceipt().target, 'preview');
  assert.equal(deployReceipt().revision_bound, true);
});

test('verified Preview Hook build emits a matching secret-free deploy receipt', () => {
  const result = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/DO_NOT_PUBLISH_THIS_SECRET',
    REGISTRY_URL: 'https://example.invalid/exec?token=DO_NOT_PUBLISH_THIS_SECRET',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = deployReceipt();
  assert.equal(receipt.verified, true);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.request_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(receipt.requested_at, '2026-08-11T01:02:03.004Z');
  assert.equal(receipt.registry_revision, STATUS_REVISION);
  assert.equal(receipt.context, 'branch-deploy');
  assert.equal(receipt.site_id, '33333333-4444-4555-8666-777777777777');
  assert.equal(receipt.commit_ref, 'a'.repeat(40));
  assert.doesNotMatch(
    JSON.stringify(receipt), /DO_NOT_PUBLISH_THIS_SECRET|build_hooks|token=/,
  );
});

test('verified Preview fails on stale manifest, file, or final Registry revision', () => {
  const staleManifest = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(`sha256:${'4'.repeat(64)}`),
  });
  assert.notEqual(staleManifest.status, 0);
  assert.match(staleManifest.stdout + staleManifest.stderr, /Initial manifest.*does not match/);

  const staleFile = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    MOCK_FILE_REGISTRY_REVISION: `sha256:${'3'.repeat(64)}`,
  });
  assert.notEqual(staleFile.status, 0);
  assert.match(staleFile.stdout + staleFile.stderr, /Project file.*does not match/);

  const staleFinal = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    MOCK_FINAL_REGISTRY_REVISION: `sha256:${'3'.repeat(64)}`,
  });
  assert.notEqual(staleFinal.status, 0);
  assert.match(staleFinal.stdout + staleFinal.stderr, /Final manifest.*does not match/);
});

test('malformed Preview Hook payload fails without echoing body contents', () => {
  const result = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: JSON.stringify({
      ...JSON.parse(previewHookBody()),
      unexpected_secret: 'DO_NOT_ECHO_THIS_SECRET',
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /unsupported fields/);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO_THIS_SECRET/);
});
