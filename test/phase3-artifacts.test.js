'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const fixturePaths = [
  path.join(root, 'fixtures', 'preview-auto-e2e-v1.html'),
  path.join(root, 'fixtures', 'preview-auto-e2e-v2.html'),
];
const contractPath = path.join(root, 'fixtures', 'preview-automation-contract.json');
const runbookPath = path.join(root, 'docs', 'phase3-preview-automation-runbook.md');

function read(filename) {
  return fs.readFileSync(filename, 'utf8');
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

test('develop-only HTML fixtures are inert, synthetic and version-distinct', () => {
  const pages = fixturePaths.map(read);

  pages.forEach((html, index) => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1, 'only the metadata JSON script is allowed');
    assert.match(scripts[0][1], /\btype=["']application\/json["']/i);
    assert.match(scripts[0][1], /\bid=["']ai4s-meta["']/i);
    assert.doesNotMatch(html, /\b(?:src|href|action|formaction)\s*=/i);
    assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i);
    assert.doesNotMatch(html, /@import\b|url\s*\(/i);

    const metadata = JSON.parse(scripts[0][2]);
    assert.equal(metadata.data_source, 'Synthetic placeholder');
    assert.equal(metadata.training, 'None / rule-based');
    assert.match(metadata.data_notes, /No real data/i);
    assert.match(html, new RegExp(`AI4S_PREVIEW_AUTO_E2E_V${index + 1}`));
  });

  assert.match(pages[0], /Version 1/);
  assert.doesNotMatch(pages[0], /AI4S_PREVIEW_AUTO_E2E_V2/);
  assert.match(pages[1], /Version 2/);
  assert.doesNotMatch(pages[1], /AI4S_PREVIEW_AUTO_E2E_V1/);
  assert.equal(
    pages[0].match(/<title>([^<]+)<\/title>/i)[1],
    pages[1].match(/<title>([^<]+)<\/title>/i)[1],
    'V1 and V2 must update the same logical page',
  );
});

test('the checked-in cross-layer contract uses the exact safe Preview envelope', () => {
  const contract = JSON.parse(read(contractPath));
  const payload = contract.hook_payload;
  const accepted = contract.accepted;
  const receipt = contract.ready_receipt;

  assert.equal(contract.schema, 1);
  assert.deepEqual(sortedKeys(payload), [
    'branch', 'registry_revision', 'request_id', 'requested_at', 'schema', 'target',
  ]);
  assert.equal(payload.schema, 1);
  assert.equal(payload.target, 'preview');
  assert.equal(payload.branch, 'develop');
  assert.match(payload.registry_revision, /^sha256:[0-9a-f]{64}$/);
  assert.match(payload.request_id, /^[0-9a-f-]{36}$/i);
  assert.equal(new Date(payload.requested_at).toISOString(), payload.requested_at);

  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.request_id, payload.request_id);
  assert.equal(accepted.registry_revision, payload.registry_revision);
  assert.ok(accepted.http_status >= 200 && accepted.http_status < 300);

  assert.equal(receipt.schema, 1);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.target, 'preview');
  assert.equal(receipt.audience, 'preview');
  assert.equal(receipt.context, 'branch-deploy');
  assert.equal(receipt.branch, 'develop');
  assert.equal(receipt.request_id, payload.request_id);
  assert.equal(receipt.requested_at, payload.requested_at);
  assert.equal(receipt.registry_revision, payload.registry_revision);
});

test('Phase 3 artifacts contain no credential-shaped values', () => {
  const material = [...fixturePaths, contractPath, runbookPath]
    .map(filename => `${path.relative(root, filename)}\n${read(filename)}`)
    .join('\n');
  const forbidden = [
    /https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9_-]{8,}/i,
    /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\?[^\s#]*token=[^\s&#]+/i,
    /\bnfp_[A-Za-z0-9_-]{16,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  forbidden.forEach(pattern => assert.doesNotMatch(material, pattern));
});

test('runbook locks the real canary to develop and preserves the recorded Production baseline', () => {
  const runbook = read(runbookPath);
  assert.match(runbook, /Git `main` \| `6c5488d9959cb4469c7f8960fb8cff6cdffba0aa`/);
  assert.match(runbook, /Netlify published Production Deploy \| `6a7554bf39cf8b00085699ef`/);
  assert.match(runbook, /auto_publish_target=off/);
  assert.match(runbook, /Set only `auto_publish_target=preview`/);
  assert.match(runbook, /^### Add$/m);
  assert.match(runbook, /^### Update$/m);
  assert.match(runbook, /^### Recoverable delete$/m);
  assert.match(runbook, /do not create a second Drive file/i);
  assert.match(runbook, /row, file ID and slug must\s+be unchanged/i);
  assert.match(runbook, /Repeated no-change syncs do not create Deploys/);
  assert.match(runbook, /stable alias is the ready signal/);
  assert.match(runbook, /restore `auto_publish_target=off`/);
  assert.match(runbook, /Never use the Production Hook as a recovery mechanism/);
});
