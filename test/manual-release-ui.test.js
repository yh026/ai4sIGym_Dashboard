'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createReleaseIntent, stable} = require('../google-apps-script/publishing-controls/production-release/release-plan.cjs');
const {validateHook} = require('../google-apps-script/publishing-controls/manual-release/hook.cjs');
const code = fs.readFileSync(path.join(__dirname, '../google-apps-script/publishing-controls/manual-release/ManualReleaseUi.gs'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const NOW = '2026-10-08T08:00:00.000Z';
const SITE = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973';
const sha = digit => 'sha256:' + digit.repeat(64);
const productionDeploy = 'a'.repeat(24), previewDeploy = 'b'.repeat(24);
const reviewHook = 'https://api.netlify.com/build_hooks/' + 'c'.repeat(24);
const productionHook = 'https://api.netlify.com/build_hooks/' + 'd'.repeat(24);
const ids = ['demo-add', 'demo-update', 'demo-remove', 'demo-keep'];

function harness() {
  let clock = Date.parse(NOW), sequence = 0, lockDepth = 0;
  let hookStatus = 202, hookError = null;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const events = [], posts = [], reads = [], reviews = new Map(), requests = new Map();
  const properties = new Map(Object.entries({AIS_RELEASE_ROOT_FOLDER_ID: 'release-folder-test',
    AIS_RELEASE_REVIEW_HOOK: reviewHook, AIS_RELEASE_PRODUCTION_HOOK: productionHook,
    AIS_RELEASE_RENDERER_DIGEST: sha('f'), AI4S_PREVIEW_CALLBACK_SECRET: 'ui-test-signing-secret',
    AIS_RELEASE_ACTIVE_PRODUCTION_CAPSULE_ID: 'capsule-production'}));
  const propertyApi = {getProperty: name => properties.get(name) || null,
    setProperty(name, value) { events.push('property:' + name); properties.set(name, value); return propertyApi; },
    deleteProperty(name) { properties.delete(name); return propertyApi; }};
  const selection = ids.map(id => ({demo_id: id, includeProduction: id !== 'demo-remove', includePreview: id !== 'demo-keep'}));
  const catalog = ids.map(id => ({demo_id: id, slug: id.replace(/^demo-/, ''), title: id.replace(/^demo-/, '').toUpperCase()}));
  const snapshots = {production: {environment: 'production', site_id: SITE, deploy_id: productionDeploy,
    state: 'ready', commit_ref: '1'.repeat(40), inventory_digest: sha('1'), receipt_digest: sha('2'),
    branch: 'main', context: 'production', publication_overrides: [], projects: ids.slice(1).map(id => ({demo_id: id,
      slug: id.replace(/^demo-/, ''), content_digest: sha('3')}))},
  preview: {environment: 'preview', site_id: SITE, deploy_id: previewDeploy, state: 'ready', commit_ref: '2'.repeat(40),
    inventory_digest: sha('4'), receipt_digest: sha('5'), branch: 'develop', context: 'branch-deploy',
    verified: true, registry_revision: sha('6'), projects: ids.filter(id => id !== 'demo-remove').map(id => ({demo_id: id,
      slug: id.replace(/^demo-/, ''), content_digest: sha(id === 'demo-update' ? '7' : '3')}))}};
  const productionReceipt = {deploy_id: productionDeploy, target: 'production', audience: 'production', site_id: SITE};
  const previewState = {phase: 'ready', deploy_id: previewDeploy, request_id: 'preview-request-1234', revision: sha('6')};
  const capsules = {production: {id: 'capsule-production', complete: true, provenance: {deploy_id: productionDeploy}},
    preview: {id: 'capsule-preview', complete: true, provenance: {deploy_id: previewDeploy,
      request_id: previewState.request_id, registry_revision: previewState.revision}}};
  const rows = selection.map(s => [s.demo_id, s.demo_id === 'demo-add' ? 'Not published' : 'Published',
    s.demo_id === 'demo-remove' ? 'Not published' : 'Published', '', '', '', '', '', '', '', '']);
  const context = vm.createContext({Date: Clock, Number, JSON, Object, encodeURIComponent,
    SANDBOX: {site_id: SITE}, REGISTRY_UI: {productionReceiptUrl: 'https://aisigym.netlify.app/deploy-receipt.json'},
    V3: {stable}, PropertiesService: {getScriptProperties: () => propertyApi},
    Utilities: {getUuid: () => 'ui-identity-' + (++sequence), computeHmacSha256Signature: (payload, secret) =>
      [...crypto.createHmac('sha256', secret).update(payload).digest()].map(byte => byte > 127 ? byte - 256 : byte)},
    registryPublishingSelection_: () => clone(selection), registryPublishingCatalog_: () => clone(catalog),
    registryPublishingState_: () => ({getRange: () => ({getValues: () => clone(rows)})}),
    registryReleaseStoreGetActive_: name => clone(capsules[name]),
    registryReleaseStoreGetReview_: id => clone(reviews.get(id)), registryReleaseStoreGetRequest_: id => clone(requests.get(id)),
    registryReleaseStoreCreateReview_(review) {
      assert.ok(lockDepth > 0, 'review decision must be persisted under a lock');
      assert.equal(review.phase, 'requested'); assert.equal(review.site_id, SITE);
      assert.ok(!reviews.has(review.id)); events.push('create-review'); reviews.set(review.id, clone(review));
    },
    registryReleaseStoreCreateRequest_(request) {
      assert.ok(lockDepth > 0, 'explicit release decision must be persisted under a lock');
      const review = reviews.get(request.review_id); assert.ok(review);
      assert.equal(request.phase, 'requested'); assert.equal(request.baseline_deploy_id, review.baseline_deploy_id);
      assert.equal(request.branch, request.kind === 'review' ? 'codex/manual-production-review' : 'main');
      assert.equal(request.target, request.kind === 'review' ? 'production-review' : 'production');
      if (request.kind === 'production') {
        assert.equal(review.phase, 'ready'); assert.equal(request.candidate_capsule_id, review.candidate_capsule_id);
        assert.equal(request.artifact_digest, review.artifact_digest);
      } else assert.equal(request.id, review.request_id);
      assert.ok(!requests.has(request.id)); events.push('create-request:' + request.kind);
      requests.set(request.id, {...clone(request), ui_created: true});
    },
    registryPublishingJson_(url) { reads.push(url); return clone(productionReceipt); },
    registryPublishingVerifyReceipt_(receipt, target) { assert.equal(receipt.target, target); },
    registryUiMessage_: error => String(error.message || error), previewState_: () => clone(previewState),
    locked_(fn) { assert.equal(lockDepth, 0, 'unexpected nested lock'); lockDepth++; try { return fn(); } finally { lockDepth--; } },
    UrlFetchApp: {fetch(url, options) {
      events.push('post-hook'); posts.push({url, ...clone(options)});
      const envelope = JSON.parse(options.payload), body = JSON.parse(envelope.payload);
      assert.ok(requests.has(body.request_id), 'request must exist before its hook is called');
      assert.equal(envelope.signature, crypto.createHmac('sha256', properties.get('AI4S_PREVIEW_CALLBACK_SECRET'))
        .update('ais-manual-release-hook-v1\n' + envelope.payload).digest('hex'));
      if (hookError) throw hookError;
      return {getResponseCode: () => hookStatus};
    }},
  });
  vm.runInContext(code, context);
  function readyReview(patch = {}) {
    const selected = selection.map(s => ({demo_id: s.demo_id, include_in_production: s.includeProduction, include_in_preview: s.includePreview}));
    const plan = createReleaseIntent({catalog, selection: selected, baseline: snapshots.production, preview: snapshots.preview, now: NOW});
    const review = {id: 'ready-review-1234', schema: 1, site_id: SITE, created_at: NOW,
      expires_at: '2026-10-08T10:00:00.000Z', ready_at: NOW, phase: 'ready', request_id: 'review-request-1234',
      selection: selected, catalog: clone(catalog), baseline_capsule_id: capsules.production.id, preview_capsule_id: capsules.preview.id,
      baseline_deploy_id: productionDeploy, preview_deploy_id: previewDeploy, renderer_digest: sha('f'),
      candidate_capsule_id: 'candidate-capsule-1234', artifact_digest: sha('8'), review_deploy_id: 'e'.repeat(24), plan,
      ...patch};
    reviews.set(review.id, clone(review)); properties.set('AIS_RELEASE_CURRENT_REVIEW_ID', review.id); return review;
  }
  return {context, selection, catalog, snapshots, productionReceipt, previewState, capsules, properties, posts, reads, events, reviews, requests,
    readyReview, clock: value => { clock = Date.parse(value); }, hookStatus: value => { hookStatus = value; }, hookError: value => { hookError = value; }};
}

function assertNoProduction(h) {
  assert.equal(h.posts.filter(post => post.url.startsWith(productionHook)).length, 0);
  assert.equal([...h.requests.values()].filter(request => request.kind === 'production').length, 0);
}

test('real release-plan projects and removals yield Add, Update, Remove, and Keep rows', () => {
  const h = harness(), review = h.readyReview();
  assert.equal(review.plan.changes, undefined, 'the real intent has projects/removals, not a synthetic changes field');
  const rows = clone(h.context.registryManualChangeRows_(review));
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.demo_id, row.action])), {
    'demo-add': 'Add', 'demo-update': 'Update', 'demo-remove': 'Remove', 'demo-keep': 'Keep',
  });
  const view = h.context.registryManualReviewView_(review);
  assert.equal(view.change_count, 3); assert.equal(view.production_enabled, true);
});

test('status reads never create requests or invoke either hook', () => {
  const h = harness(); h.readyReview();
  const before = clone([...h.requests.values()]);
  h.context.registryManualSummary_(); h.context.registryManualCurrentReview_(); h.context.registryManualPendingRequest_();
  assert.equal(h.posts.length, 0); assert.deepEqual([...h.requests.values()], before);
});

test('Review creates only an isolated review request and sends its hook once', () => {
  const h = harness(), first = h.context.registryManualReviewProduction();
  assert.equal(first.phase, 'preparing'); assert.equal(first.production_enabled, false);
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].url, reviewHook + '?trigger_branch=codex%2Fmanual-production-review');
  const body = JSON.parse(JSON.parse(h.posts[0].payload).payload);
  assert.equal(body.target, 'production-review'); assert.equal(body.branch, 'codex/manual-production-review');
  assert.ok(h.events.indexOf('create-request:review') < h.events.indexOf('post-hook'));
  const second = h.context.registryManualReviewProduction();
  assert.equal(second.id, first.id); assert.equal(h.posts.length, 1);
  assertNoProduction(h);
});

test('slow review persistence keeps exact lifetimes and produces a valid Netlify hook', () => {
  const h = harness();
  let clock = Date.parse(NOW);
  h.properties.set('AI4S_PREVIEW_CALLBACK_SECRET', 'ui-test-signing-secret-at-least-32-characters');
  const delay = (object, key, milliseconds) => {
    const original = object[key];
    object[key] = (...args) => {
      h.clock(new Date(clock += milliseconds).toISOString());
      return original(...args);
    };
  };
  delay(h.context.Utilities, 'getUuid', 175);
  delay(h.context, 'registryPublishingCatalog_', 1300);
  delay(h.context, 'registryReleaseStoreCreateReview_', 24000);
  delay(h.context, 'registryReleaseStoreCreateRequest_', 6500);
  h.context.registryManualReviewProduction();
  const review = [...h.reviews.values()][0], request = [...h.requests.values()][0];
  assert.equal(Date.parse(review.expires_at) - Date.parse(review.created_at), 2 * 60 * 60 * 1000);
  assert.equal(request.created_at, review.created_at);
  assert.equal(Date.parse(request.expires_at) - Date.parse(request.created_at), 30 * 60 * 1000);
  const accepted = validateHook({NETLIFY:'true', SITE_ID:SITE, CONTEXT:'branch-deploy',
    BRANCH:'codex/manual-production-review', COMMIT_REF:'1'.repeat(40), BUILD_ID:'review-build-1234',
    DEPLOY_ID:'e'.repeat(24), INCOMING_HOOK_BODY:h.posts[0].payload,
    AI4S_PREVIEW_CALLBACK_SECRET:h.properties.get('AI4S_PREVIEW_CALLBACK_SECRET')}, 'production-review', clock);
  assert.equal(accepted.request_id, request.id);
  assertNoProduction(h);
});

test('production expiry derives from the creation timestamp despite delayed UUID and save', () => {
  const h = harness(), review = h.readyReview();
  let clock = Date.parse(NOW);
  h.properties.set('AI4S_PREVIEW_CALLBACK_SECRET', 'ui-test-signing-secret-at-least-32-characters');
  const uuid = h.context.Utilities.getUuid;
  h.context.Utilities.getUuid = () => { h.clock(new Date(clock += 175).toISOString()); return uuid(); };
  const save = h.context.registryReleaseStoreCreateRequest_;
  h.context.registryReleaseStoreCreateRequest_ = request => {
    h.clock(new Date(clock += 24000).toISOString()); return save(request);
  };
  h.context.registryManualConfirmProduction(review.id);
  const request = [...h.requests.values()][0];
  assert.equal(Date.parse(request.expires_at) - Date.parse(request.created_at), 15 * 60 * 1000);
  const accepted = validateHook({NETLIFY:'true', SITE_ID:SITE, CONTEXT:'production', BRANCH:'main',
    COMMIT_REF:'1'.repeat(40), BUILD_ID:'production-build-1234', DEPLOY_ID:'e'.repeat(24),
    INCOMING_HOOK_BODY:h.posts[0].payload,
    AI4S_PREVIEW_CALLBACK_SECRET:h.properties.get('AI4S_PREVIEW_CALLBACK_SECRET')}, 'production', clock);
  assert.equal(accepted.request_id, request.id);
});

test('only explicit Confirm submits the exact candidate and blocks a second confirmation', () => {
  const h = harness(), review = h.readyReview();
  h.context.registryManualSummary_(); assertNoProduction(h);
  const result = h.context.registryManualConfirmProduction(review.id);
  assert.match(result.message, /requested/i); assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, productionHook + '?trigger_branch=main');
  const sent = JSON.parse(JSON.parse(h.posts[0].payload).payload);
  assert.equal(sent.candidate_capsule_id, review.candidate_capsule_id); assert.equal(sent.artifact_digest, review.artifact_digest);
  assert.equal(sent.baseline_deploy_id, review.baseline_deploy_id); assert.equal(sent.review_id, review.id);
  assert.throws(() => h.context.registryManualConfirmProduction(review.id), /already in progress/);
  assert.equal(h.posts.length, 1);
});

test('changing either checkbox after review blocks confirmation without creating a release', () => {
  for (const field of ['includeProduction', 'includePreview']) {
    const h = harness(), review = h.readyReview(); h.selection[0][field] = !h.selection[0][field];
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /Selection changed/); assertNoProduction(h);
  }
});

test('changed active production or preview capsule blocks a reviewed release', () => {
  for (const environment of ['production', 'preview']) {
    const h = harness(), review = h.readyReview(); h.capsules[environment].id += '-new';
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /changed/); assertNoProduction(h);
  }
});

test('changed public production receipt cannot be ignored even when the stored capsule is unchanged', () => {
  const h = harness(), review = h.readyReview(); h.productionReceipt.deploy_id = '9'.repeat(24);
  assert.throws(() => h.context.registryManualConfirmProduction(review.id), /reconciliation|Production changed/);
  assertNoProduction(h);
});

test('changed current preview request or deploy identity blocks confirmation', () => {
  for (const field of ['request_id', 'deploy_id', 'revision']) {
    const h = harness(), review = h.readyReview(); h.previewState[field] = 'changed';
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /Update preview first/); assertNoProduction(h);
  }
});

test('all three review expiry bounds prevent a production request', () => {
  for (const field of ['expires_at', 'plan', 'ready_at']) {
    const h = harness(), review = h.readyReview();
    if (field === 'plan') review.plan.expires_at = '2026-10-08T07:59:00.000Z';
    else review[field] = field === 'ready_at' ? '2026-10-08T07:00:00.000Z' : '2026-10-08T07:59:00.000Z';
    h.reviews.set(review.id, review);
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /expired/); assertNoProduction(h);
  }
});

test('an unchanged release cannot be submitted', () => {
  const h = harness(), review = h.readyReview();
  review.plan.projects.forEach(project => { project.action = 'keep'; }); review.plan.removals = [];
  h.reviews.set(review.id, review);
  assert.throws(() => h.context.registryManualConfirmProduction(review.id), /No production changes/); assertNoProduction(h);
});

test('a prepared but not successfully deployed review cannot publish', () => {
  const h = harness(), review = h.readyReview({phase: 'prepared'});
  assert.equal(h.context.registryManualReviewView_(review).phase, 'preparing');
  assert.throws(() => h.context.registryManualConfirmProduction(review.id), /Wait for the release preview/); assertNoProduction(h);
});

test('expired preparation allows a fresh review without a production request', () => {
  const h = harness(), review = h.readyReview({phase: 'requested', expires_at: '2026-10-08T07:59:00.000Z'});
  const view = h.context.registryManualReviewView_(review);
  assert.equal(view.phase, 'expired'); assert.match(view.production_disabled_reason, /expired/);
  const next = h.context.registryManualReviewProduction();
  assert.notEqual(next.id, review.id); assert.equal(next.phase, 'preparing'); assertNoProduction(h);
});

test('failed production request exposes its actionable error', () => {
  const h = harness();
  h.requests.set('failed-request', {phase:'failed', error:'Candidate verification failed.'});
  h.properties.set('AIS_RELEASE_ACTIVE_REQUEST_ID', 'failed-request');
  assert.equal(h.context.registryManualSummary_().production_error, 'Candidate verification failed.');
  assertNoProduction(h);
});

test('a pending requested or claimed production request prevents new reviews and duplicate confirmations', () => {
  for (const phase of ['requested', 'claimed']) {
    const h = harness(), review = h.readyReview();
    h.requests.set('already-pending', {id: 'already-pending', kind: 'production', phase});
    h.properties.set('AIS_RELEASE_ACTIVE_REQUEST_ID', 'already-pending');
    assert.throws(() => h.context.registryManualReviewProduction(), /already in progress/);
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /already in progress/);
    assert.equal(h.posts.length, 0);
  }
});

test('uncertain hook responses retain the durable production request and never retry automatically', () => {
  for (const failure of ['http', 'network']) {
    const h = harness(), review = h.readyReview();
    if (failure === 'http') h.hookStatus(502); else h.hookError(new Error('Network timeout'));
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /not acknowledged|timeout/);
    assert.ok(h.properties.get('AIS_RELEASE_ACTIVE_REQUEST_ID')); assert.equal(h.posts.length, 1);
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /already in progress/);
    assert.equal(h.posts.length, 1);
  }
});

test('invalid transport configuration is rejected before a durable production request is created', () => {
  for (const [field, value] of [['AIS_RELEASE_PRODUCTION_HOOK', ''], ['AIS_RELEASE_PRODUCTION_HOOK', 'https://example.test/'], ['AI4S_PREVIEW_CALLBACK_SECRET', '']]) {
    const h = harness(), review = h.readyReview(); h.properties.set(field, value);
    assert.throws(() => h.context.registryManualConfirmProduction(review.id), /not configured|not connected|connection/i);
    assert.equal(h.properties.get('AIS_RELEASE_ACTIVE_REQUEST_ID'), undefined);
    assertNoProduction(h);
  }
});

test('wrong or missing review identity cannot submit a production request', () => {
  const h = harness(); h.readyReview();
  assert.throws(() => h.context.registryManualConfirmProduction('other-review'), /Review the changes again/);
  assert.throws(() => h.context.registryManualConfirmProduction(''), /Review the changes again/); assertNoProduction(h);
});
