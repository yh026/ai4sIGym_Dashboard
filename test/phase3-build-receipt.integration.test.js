'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(
  path.join(root, 'fixtures', 'preview-automation-contract.json'), 'utf8',
));

test('a verified mock develop build publishes a matching no-store ready receipt', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4s-phase3-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceManifest = JSON.parse(fs.readFileSync(
    path.join(root, 'fixtures', 'manifest-status-matrix.json'), 'utf8',
  ));
  sourceManifest.audience = 'preview';
  sourceManifest.registry_revision = contract.hook_payload.registry_revision;
  const manifestPath = path.join(temp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(sourceManifest));

  const secretSentinel = 'DO_NOT_PUBLISH_THIS_SECRET';
  const result = spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NETLIFY: 'true',
      CONTEXT: 'branch-deploy',
      BRANCH: 'develop',
      COMMIT_REF: contract.ready_receipt.commit_ref,
      BUILD_ID: contract.ready_receipt.build_id,
      DEPLOY_ID: contract.ready_receipt.deploy_id,
      SITE_ID: contract.ready_receipt.site_id,
      REGISTRY_URL: `https://example.invalid/exec?token=${secretSentinel}`,
      INCOMING_HOOK_URL: `https://api.netlify.com/build_hooks/${secretSentinel}`,
      INCOMING_HOOK_BODY: JSON.stringify(contract.hook_payload),
      MOCK_MANIFEST: manifestPath,
      MOCK_HTML_FALLBACK: path.join(root, 'fixtures', 'demo-minimal.html'),
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const receiptText = fs.readFileSync(path.join(root, 'dist', 'deploy-receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.target, 'preview');
  assert.equal(receipt.audience, 'preview');
  assert.equal(receipt.context, 'branch-deploy');
  assert.equal(receipt.branch, 'develop');
  assert.equal(receipt.registry_revision, contract.hook_payload.registry_revision);
  assert.equal(receipt.request_id, contract.hook_payload.request_id);
  assert.equal(receipt.requested_at, contract.hook_payload.requested_at);
  assert.equal(receipt.commit_ref, contract.ready_receipt.commit_ref);
  assert.equal(receipt.build_id, contract.ready_receipt.build_id);
  assert.equal(receipt.deploy_id, contract.ready_receipt.deploy_id);
  assert.equal(receipt.site_id, contract.ready_receipt.site_id);
  assert.equal(receipt.platform, 'netlify');
  assert.equal(new Date(receipt.built_at).toISOString(), receipt.built_at);
  assert.doesNotMatch(receiptText, new RegExp(secretSentinel, 'i'));
  assert.doesNotMatch(receiptText, /build_hooks|token=/i);

  const headers = fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8');
  assert.match(headers, /\/deploy-receipt\.json\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store/);
});
