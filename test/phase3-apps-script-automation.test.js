'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(
  path.join(root, 'fixtures', 'preview-automation-contract.json'), 'utf8',
));

function loadAppsScript() {
  const filename = path.join(root, 'google-apps-script', 'Code.gs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

function fakeUtilities(uuid = contract.hook_payload.request_id) {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest(),
        byte => (byte > 127 ? byte - 256 : byte));
    },
    getUuid: () => uuid,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function revision(digit) {
  return `sha256:${String(digit).repeat(64)}`;
}

test('Registry revisions detect Preview add, update and removal but ignore Archived-only edits', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  script.readCategories_ = () => ['Physics'];
  const cfg = { site_title: 'Gym', site_tagline: 'Safe Preview' };
  let demos = [
    { file_id: 'live', title: 'Live', status: 'Live', file_check: 'ok',
      last_modified: '2026-08-11T00:00:00.000Z' },
    { file_id: 'draft-a', title: 'Draft A', status: 'Draft', file_check: 'ok',
      last_modified: '2026-08-11T00:00:00.000Z' },
    { file_id: 'archived', title: 'Archived', status: 'Archived', file_check: 'ok',
      last_modified: '2026-08-11T00:00:00.000Z' },
  ];
  script.readDemos_ = () => demos;

  const initial = script.registrySnapshot_({}, cfg, 'preview').registry_revision;
  demos[2].title = 'Archived edit';
  assert.equal(script.registrySnapshot_({}, cfg, 'preview').registry_revision, initial);

  demos[1].last_modified = '2026-08-11T00:00:01.000Z';
  const updated = script.registrySnapshot_({}, cfg, 'preview').registry_revision;
  assert.notEqual(updated, initial);

  demos = demos.filter(demo => demo.file_id !== 'draft-a');
  const removed = script.registrySnapshot_({}, cfg, 'preview').registry_revision;
  assert.notEqual(removed, updated);

  demos.push({ file_id: 'draft-b', title: 'Draft B', status: 'Draft', file_check: 'ok',
    last_modified: '2026-08-11T00:00:02.000Z' });
  const added = script.registrySnapshot_({}, cfg, 'preview').registry_revision;
  assert.notEqual(added, removed);
  assert.match(added, /^sha256:[0-9a-f]{64}$/);
});

test('Drive timestamp comparison detects exact sub-minute changes', () => {
  const script = loadAppsScript();
  const stored = new Date('2026-08-11T01:02:03.100Z');
  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T01:02:03.999Z')), true);
  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T01:02:04.000Z')), true);
  assert.equal(script.driveStampChanged_(stored, ''), true);
  assert.equal(script.driveStampChanged_('', stored), true);
});

test('Apps Script emits exactly the checked-in build contract and keeps one request across retries', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  const now = Date.parse(contract.hook_payload.requested_at);
  let state = script.observePreviewDesired_(
    script.emptyPreviewPublishState_(), 'develop', contract.hook_payload.registry_revision,
  );
  state = script.requestPreviewRevision_(state, now);

  assert.deepEqual(plain(script.previewBuildPayload_(state)), contract.hook_payload);
  const requestId = state.requestId;
  state = script.recordPreviewAttempt_(state, { ok: false, status: 503, error: 'temporary' }, now);
  assert.equal(state.attempts, 1);
  assert.equal(state.requestId, requestId);
  assert.equal(state.nextAttemptAt, now + 60 * 60 * 1000);

  state = script.observePreviewDesired_(state, 'develop', contract.hook_payload.registry_revision);
  state = script.recordPreviewAttempt_(state, { ok: true, status: 202, error: '' },
    state.nextAttemptAt);
  assert.equal(state.attempts, 2);
  assert.equal(state.requestId, requestId);
  assert.equal(state.accepted, contract.hook_payload.registry_revision);
  assert.equal(script.previewPublishPhase_(state), 'accepted');

  const next = script.observePreviewDesired_(state, 'develop', revision('2'));
  assert.equal(next.ready, state.ready, 'the last ready revision remains useful audit state');
  assert.equal(next.requested, '');
  assert.equal(next.requestId, '');
  assert.equal(next.attempts, 0);
});

test('receipt adoption requires the exact develop Branch Deploy identity', () => {
  const script = loadAppsScript();
  const expected = {
    branch: 'develop',
    revision: contract.hook_payload.registry_revision,
    requestId: contract.hook_payload.request_id,
  };
  const valid = contract.ready_receipt;
  assert.equal(script.previewReceiptMatches_(valid, expected), true);

  const mutations = [
    { schema: 2 },
    { verified: false },
    { revision_bound: false },
    { target: 'production' },
    { audience: 'production' },
    { context: 'production' },
    { context: 'deploy-preview' },
    { branch: 'main' },
    { registry_revision: revision('9') },
    { request_id: '99999999-2222-4333-8444-555555555555' },
  ];
  mutations.forEach(change => {
    assert.equal(script.previewReceiptMatches_({ ...valid, ...change }, expected), false,
      JSON.stringify(change));
  });
  const withoutContext = { ...valid };
  delete withoutContext.context;
  assert.equal(script.previewReceiptMatches_(withoutContext, expected), false);
});

test('Preview maintenance is idempotent from accepted through ready', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  const wanted = contract.hook_payload.registry_revision;
  const start = Date.parse(contract.hook_payload.requested_at);
  let stored = script.emptyPreviewPublishState_();
  let ready = false;
  const posts = [];

  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2Snapshot_ = () => ({
    audience: 'preview', registry_revision: wanted, demos: [],
  });
  script.readPreviewPublishState_ = () => stored;
  script.writePreviewPublishState_ = state => { stored = plain(state); return state; };
  script.checkPreviewReceipt_ = (cfg, expected) => ({
    ok: ready,
    configured: true,
    ready,
    status: ready ? 200 : 404,
    receipt: ready ? { request_id: expected.requestId } : null,
    error: ready ? '' : 'not ready',
  });
  script.configuredBuildRequest_ = () => ({
    ok: true, target: 'preview', branch: 'develop', hookUrl: 'redacted',
  });
  script.triggerBuildRequest_ = (request, payload) => {
    posts.push(plain(payload));
    return { ok: true, status: 202, target: request.target, branch: request.branch };
  };

  const cfg = { auto_publish_target: 'preview', preview_branch: 'develop' };
  const accepted = script.maintainPreviewPublish_({}, cfg, { now: start });
  assert.equal(accepted.attempted, true);
  assert.equal(accepted.phase, 'accepted');
  assert.equal(posts.length, 1);

  const cooldown = script.maintainPreviewPublish_({}, cfg, { now: start + 1000 });
  assert.equal(cooldown.attempted, false);
  assert.equal(posts.length, 1);
  assert.equal(cooldown.state.requestId, accepted.state.requestId);

  ready = true;
  const reconciled = script.maintainPreviewPublish_({}, cfg, { now: start + 2000 });
  assert.equal(reconciled.phase, 'ready');
  assert.equal(reconciled.becameReady, true);
  assert.equal(posts.length, 1, 'receipt reconciliation must not POST again');

  const noChange = script.maintainPreviewPublish_({}, cfg, { now: start + 3000 });
  assert.equal(noChange.phase, 'ready');
  assert.equal(noChange.attempted, false);
  assert.equal(posts.length, 1);
});

test('failed Preview requests retry only when due and preserve their request ID', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  const wanted = revision('3');
  const start = Date.parse('2026-08-11T02:00:00.000Z');
  let stored = script.emptyPreviewPublishState_();
  const posts = [];

  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2Snapshot_ = () => ({
    audience: 'preview', registry_revision: wanted, demos: [],
  });
  script.readPreviewPublishState_ = () => stored;
  script.writePreviewPublishState_ = state => { stored = plain(state); return state; };
  script.checkPreviewReceipt_ = () => ({
    ok: false, configured: true, ready: false, status: 404, error: 'not ready',
  });
  script.configuredBuildRequest_ = () => ({
    ok: true, target: 'preview', branch: 'develop', hookUrl: 'redacted',
  });
  script.triggerBuildRequest_ = (request, payload) => {
    posts.push(plain(payload));
    return posts.length === 1
      ? { ok: false, status: 503, error: 'temporary' }
      : { ok: true, status: 202, error: '' };
  };

  const cfg = { auto_publish_target: 'preview', preview_branch: 'develop' };
  const failed = script.maintainPreviewPublish_({}, cfg, { now: start });
  assert.equal(failed.state.attempts, 1);
  assert.equal(posts.length, 1);
  const requestId = posts[0].request_id;

  script.maintainPreviewPublish_({}, cfg, { now: start + 60 * 60 * 1000 - 1 });
  assert.equal(posts.length, 1);

  const retried = script.maintainPreviewPublish_({}, cfg,
    { now: start + 60 * 60 * 1000 });
  assert.equal(retried.attempted, true);
  assert.equal(retried.state.attempts, 2);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].request_id, requestId);
  assert.equal(posts[1].registry_revision, wanted);
});

test('automation off creates no request, while an explicit manual request remains possible', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  let stored = script.emptyPreviewPublishState_();
  let posts = 0;
  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2Snapshot_ = () => ({
    audience: 'preview', registry_revision: revision('4'), demos: [],
  });
  script.readPreviewPublishState_ = () => stored;
  script.writePreviewPublishState_ = state => { stored = plain(state); return state; };
  script.checkPreviewReceipt_ = () => ({
    ok: false, configured: true, ready: false, status: 404, error: 'not ready',
  });
  script.configuredBuildRequest_ = () => ({
    ok: true, target: 'preview', branch: 'develop', hookUrl: 'redacted',
  });
  script.triggerBuildRequest_ = () => { posts += 1; return { ok: true, status: 202 }; };

  const cfg = { auto_publish_target: 'off', preview_branch: 'develop' };
  const automatic = script.maintainPreviewPublish_({}, cfg,
    { now: Date.parse('2026-08-11T03:00:00.000Z') });
  assert.equal(automatic.attempted, false);
  assert.equal(automatic.state.requested, '');
  assert.equal(posts, 0);

  const manual = script.maintainPreviewPublish_({}, cfg, {
    now: Date.parse('2026-08-11T03:01:00.000Z'), forceRequest: true,
  });
  assert.equal(manual.attempted, true);
  assert.equal(posts, 1);
});
