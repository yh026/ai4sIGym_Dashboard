'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  previewCallbackUrl,
  signedEnvelope,
  fetchWithTimeout,
  deliverPreviewCallback,
} = require('../netlify/plugins/preview-ready');

const SITE_ID = '33333333-4444-4555-8666-777777777777';
const SECRET = 'callback-secret-with-at-least-thirty-two-characters';

function previewReceipt(verified = true) {
  const receipt = {
    schema: 1,
    verified,
    revision_bound: true,
    target: 'preview',
    audience: 'preview',
    registry_revision: `sha256:${'1'.repeat(64)}`,
    built_at: '2026-08-11T01:04:05.006Z',
    platform: 'netlify',
    context: 'branch-deploy',
    branch: 'develop',
    site_id: SITE_ID,
    commit_ref: '2'.repeat(40),
    build_id: 'build-0123456789abcdef',
    deploy_id: 'deploy-0123456789abcdef',
  };
  if (verified) {
    receipt.request_id = '11111111-2222-4333-8444-555555555555';
    receipt.requested_at = '2026-08-11T01:02:03.004Z';
  }
  return receipt;
}

function receiptDirectory(t, receipt) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4s-callback-plugin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'deploy-receipt.json'), JSON.stringify(receipt));
  return directory;
}

function environment(extra = {}) {
  return {
    CONTEXT: 'branch-deploy',
    BRANCH: 'develop',
    SITE_ID,
    REGISTRY_URL: 'https://script.google.com/macros/s/example/exec?token=DO_NOT_SEND&audience=preview',
    AI4S_PREVIEW_CALLBACK_SECRET: SECRET,
    ...extra,
  };
}

test('callback endpoint strips every Registry query parameter before adding only its action', () => {
  const callback = new URL(previewCallbackUrl(
    'https://script.google.com/macros/s/example/exec?token=secret&action=file&id=drive-id#part',
  ));
  assert.equal(callback.origin + callback.pathname,
    'https://script.google.com/macros/s/example/exec');
  assert.deepEqual([...callback.searchParams.entries()], [['action', 'preview_callback']]);
  assert.equal(callback.hash, '');
});

test('signed envelope covers the exact raw payload string without containing the secret', () => {
  const receipt = previewReceipt();
  const envelope = signedEnvelope(receipt, SECRET, '2026-08-11T01:05:06.007Z');
  assert.equal(
    envelope.signature,
    crypto.createHmac('sha256', SECRET).update(envelope.payload, 'utf8').digest('hex'),
  );
  assert.equal(JSON.parse(envelope.payload).receipt.deploy_id, receipt.deploy_id);
  assert.doesNotMatch(envelope.payload, new RegExp(SECRET));
});

test('callback transport has a hard timeout even when the network never settles', async () => {
  const started = Date.now();
  await assert.rejects(
    fetchWithTimeout(() => new Promise(() => {}), 'https://example.invalid/callback', {}, 10),
    /timed out/,
  );
  assert.ok(Date.now() - started < 500, 'callback timeout must remain bounded');
});

test('develop onSuccess retries briefly and requires an exact JSON acknowledgement', async t => {
  const receipt = previewReceipt();
  const publishDir = receiptDirectory(t, receipt);
  const requests = [];
  const waits = [];
  const result = await deliverPreviewCallback({
    env: environment(),
    publishDir,
    siteId: SITE_ID,
    callbackAt: '2026-08-11T01:05:06.007Z',
    wait: async milliseconds => { waits.push(milliseconds); },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) return { ok: false, json: async () => ({}) };
      if (requests.length === 2) return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({
          ok: true, event: 'preview_callback', deploy_id: receipt.deploy_id,
        }),
      };
    },
  });

  assert.deepEqual(result, { sent: true, attempts: 3, deployId: receipt.deploy_id });
  assert.deepEqual(waits, [250, 500]);
  assert.equal(requests.length, 3);
  requests.forEach(request => {
    assert.equal(request.options.method, 'POST');
    assert.equal(request.url,
      'https://script.google.com/macros/s/example/exec?action=preview_callback');
    assert.doesNotMatch(request.url, /token|DO_NOT_SEND/);
    const outer = JSON.parse(request.options.body);
    assert.equal(
      outer.signature,
      crypto.createHmac('sha256', SECRET).update(outer.payload, 'utf8').digest('hex'),
    );
  });
});

test('production and Deploy Preview contexts never callback', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not run'); };
  for (const env of [
    environment({ CONTEXT: 'production', BRANCH: 'main' }),
    environment({ CONTEXT: 'deploy-preview', BRANCH: 'develop' }),
    environment({ CONTEXT: 'branch-deploy', BRANCH: 'feature/example' }),
  ]) {
    const result = await deliverPreviewCallback({ env, fetchImpl, publishDir: '/not/read' });
    assert.equal(result.reason, 'not-develop-branch-deploy');
  }
  assert.equal(calls, 0);
});

test('an unverified develop Git deploy also callbacks so stale ready state can be demoted', async t => {
  const receipt = previewReceipt(false);
  receipt.deploy_id = 'deploy-unverified-2';
  const publishDir = receiptDirectory(t, receipt);
  let inner;
  const result = await deliverPreviewCallback({
    env: environment(), publishDir, siteId: SITE_ID,
    callbackAt: '2026-08-11T01:05:06.007Z',
    fetchImpl: async (url, options) => {
      inner = JSON.parse(JSON.parse(options.body).payload);
      return {
        ok: true,
        json: async () => ({
          ok: true, event: 'preview_callback', deploy_id: receipt.deploy_id,
        }),
      };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(inner.receipt.verified, false);
  assert.equal('request_id' in inner.receipt, false);
});
