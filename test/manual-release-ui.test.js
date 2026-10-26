'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createReleaseIntent, stable} = require('../google-apps-script/publishing-controls/production-release/release-plan.cjs');
const {validateHook, confirmationDigest} = require('../google-apps-script/publishing-controls/manual-release/hook.cjs');
const code = fs.readFileSync(path.join(__dirname, '../google-apps-script/publishing-controls/manual-release/ManualReleaseUi.gs'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const NOW = '2026-10-08T08:00:00.000Z';
const SITE = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973';
const sha = digit => 'sha256:' + digit.repeat(64);
const productionDeploy = 'a'.repeat(24), previewDeploy = 'b'.repeat(24);
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
    AIS_RELEASE_PRODUCTION_HOOK: productionHook,
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
  const productionReceipt = {deploy_id: productionDeploy, target: 'production', audience: 'production', site_id: SITE,
    projects: clone(snapshots.production.projects), publication_overrides: [], renderer_digest: sha('f')};
  const previewState = {phase: 'ready', deploy_id: previewDeploy, request_id: 'preview-request-1234', revision: sha('6')};
  const capsules = {production: {id: 'capsule-production', complete: true, provenance: {deploy_id: productionDeploy}},
    preview: {id: 'capsule-preview', complete: true, provenance: {deploy_id: previewDeploy,
      request_id: previewState.request_id, registry_revision: previewState.revision, renderer_digest: sha('f'),
      project_snapshots: {standard: clone(snapshots.preview.projects),without_tbb_resources: clone(snapshots.preview.projects)}}}};
  const rows = selection.map(s => [s.demo_id, s.demo_id === 'demo-add' ? 'Not published' : 'Published',
    s.demo_id === 'demo-remove' ? 'Not published' : 'Published', '', '', '', '', '', '', '', '']);
  const context = vm.createContext({Date: Clock, Number, JSON, Object, encodeURIComponent,
    SANDBOX: {site_id: SITE}, REGISTRY_UI: {productionReceiptUrl: 'https://aisigym.netlify.app/deploy-receipt.json'},
    V3: {stable}, PropertiesService: {getScriptProperties: () => propertyApi},
    Utilities: {getUuid: () => 'ui-identity-' + (++sequence), computeHmacSha256Signature: (payload, secret) =>
      [...crypto.createHmac('sha256', secret).update(payload).digest()].map(byte => byte > 127 ? byte - 256 : byte)},
    registryPublishingSelection_: () => clone(selection), registryPublishingCatalog_: () => clone(catalog),
    registryPublishingState_: () => ({getRange: () => ({getValues: () => clone(rows)})}),
    registryReleaseStoreConfirmationDigest_: confirmationDigest,
    registryReleaseStoreGetActive_: name => clone(capsules[name]),
    registryReleaseStoreGetReview_: id => clone(reviews.get(id)), registryReleaseStoreGetRequest_: id => clone(requests.get(id)),
    registryReleaseStoreCreateReview_(review) {
      assert.ok(lockDepth > 0, 'review decision must be persisted under a lock');
      assert.equal(review.phase, 'ready'); assert.equal(review.schema, 2); assert.equal(review.site_id, SITE);
      assert.ok(!reviews.has(review.id)); events.push('create-review'); reviews.set(review.id, clone(review));
    },
    registryReleaseStoreCreateRequest_(request) {
      assert.ok(lockDepth > 0, 'explicit release decision must be persisted under a lock');
      const review = reviews.get(request.review_id); assert.ok(review);
      assert.equal(request.phase, 'requested'); assert.equal(request.baseline_deploy_id, review.baseline_deploy_id);
      assert.equal(request.branch,'main'); assert.equal(request.target,'production');
      assert.equal(request.schema,2); assert.equal(request.kind,'production');
      assert.equal(request.preview_capsule_id,review.preview_capsule_id);
      assert.equal(request.confirmation_digest,confirmationDigest(review));
      assert.equal(request.candidate_capsule_id,undefined);
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
    const view=context.registryManualReviewProduction(),review=reviews.get(view.id);
    Object.assign(review,patch); review.confirmation_digest=confirmationDigest(review);return clone(review);
  }
  return {context, selection, catalog, snapshots, productionReceipt, previewState, capsules, properties, posts, reads, events, reviews, requests,
    readyReview, clock: value => { clock = Date.parse(value); }, hookStatus: value => { hookStatus = value; }, hookError: value => { hookError = value; }};
}

function assertNoProduction(h) {
  assert.equal(h.posts.filter(post => post.url.startsWith(productionHook)).length, 0);
  assert.equal([...h.requests.values()].filter(request => request.kind === 'production').length, 0);
}

test('publication preparation is immediate and never creates a request or starts a build',()=>{
  const h=harness(),view=h.context.registryManualReviewProduction();
  assert.equal(view.phase,'ready');assert.equal(view.production_enabled,true);assert.equal(view.change_count,3);
  assert.deepEqual(Object.fromEntries(view.changes.map(r=>[r.demo_id,r.action])),{
    'demo-add':'Add','demo-update':'Update','demo-remove':'Remove','demo-keep':'Keep'});
  assert.equal(view.preview_url,'https://develop--aisigym.netlify.app/');
  assert.equal(h.posts.length,0);assert.equal(h.requests.size,0);
});
test('opening and status reads do not create a confirmation or publication request',()=>{
  const h=harness();h.context.registryManualSummary_();
  assert.equal(h.posts.length,0);assert.equal(h.reviews.size,0);assert.equal(h.requests.size,0);
});
test('one explicit confirmation sends one signed schema-2 main request with fixed develop identity',()=>{
  const h=harness(),review=h.readyReview();
  h.properties.set('AI4S_PREVIEW_CALLBACK_SECRET','ui-test-signing-secret-with-at-least-32-chars');
  h.context.registryManualConfirmProduction(review.id);
  assert.equal(h.posts.length,1);const post=h.posts[0],body=JSON.parse(JSON.parse(post.payload).payload);
  assert.ok(post.url.startsWith(productionHook));assert.match(post.url,/trigger_branch=main$/);
  assert.equal(body.preview_capsule_id,h.capsules.preview.id);assert.equal(body.confirmation_digest,confirmationDigest(review));
  assert.equal(body.candidate_capsule_id,undefined);
  const env={NETLIFY:'true',SITE_ID:SITE,CONTEXT:'production',BRANCH:'main',COMMIT_REF:'1'.repeat(40),
    BUILD_ID:'main-build-1234',DEPLOY_ID:'c'.repeat(24),AI4S_PREVIEW_CALLBACK_SECRET:h.properties.get('AI4S_PREVIEW_CALLBACK_SECRET'),INCOMING_HOOK_BODY:post.payload};
  assert.equal(validateHook(env,'production',Date.parse(NOW)).request_id,body.request_id);
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/in progress/);assert.equal(h.posts.length,1);
});
test('slow UUID creation and persistence preserve the exact hook lifetime',()=>{
  const h=harness(),review=h.readyReview();
  h.context.Utilities.getUuid=()=>{h.clock('2026-10-08T08:00:03.000Z');return 'slow-request-1234';};
  h.context.registryManualConfirmProduction(review.id);
  const body=JSON.parse(JSON.parse(h.posts[0].payload).payload);
  assert.equal(Date.parse(body.expires_at)-Date.parse(body.requested_at),15*60000);
});
test('either changed checkbox invalidates the confirmation',()=>{
  for(const field of ['includeProduction','includePreview']){
    const h=harness(),review=h.readyReview();h.selection[0][field]=!h.selection[0][field];
    assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/Selection changed/);assertNoProduction(h);
  }
});
test('changed catalog or confirmation fields cannot be silently published',()=>{
  const h=harness(),review=h.readyReview();h.catalog[0].title='Edited';
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/Project details changed/);assertNoProduction(h);
  const other=harness(),r=other.readyReview();other.reviews.get(r.id).preview_deploy_id='c'.repeat(24);
  assert.throws(()=>other.context.registryManualConfirmProduction(r.id),/confirmation changed/);assertNoProduction(other);
});
test('changed active capsules, public production or current preview identity block confirmation',()=>{
  for(const mutate of [h=>h.capsules.production.id='new-production',h=>h.capsules.preview.id='new-preview',
    h=>h.productionReceipt.deploy_id='c'.repeat(24),h=>h.previewState.phase='accepted',
    h=>h.previewState.request_id='new-preview-request',h=>h.previewState.revision=sha('a')]){
    const h=harness(),review=h.readyReview();mutate(h);
    assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/changed|Update preview|reconciliation/);assertNoProduction(h);
  }
});
test('expired confirmations and unknown or historical review identities cannot publish',()=>{
  const h=harness(),review=h.readyReview();h.clock('2026-10-08T08:30:00.000Z');
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/expired/);assertNoProduction(h);
  assert.throws(()=>h.context.registryManualConfirmProduction('other'),/confirmation again/);
  h.reviews.get(review.id).schema=1;assert.equal(h.context.registryManualCurrentReview_(),null);
});
test('a legacy preview requires one explicit Update to save publication metadata',()=>{
  const h=harness();delete h.capsules.preview.provenance.project_snapshots;
  assert.throws(()=>h.context.registryManualReviewProduction(),/Update preview once/);assertNoProduction(h);
  assert.equal(h.context.registryManualNeedsPreviewArtifact_(h.previewState,h.previewState.revision),true);
});
test('equal project bytes have no publication action; renderer changes remain visible',()=>{
  const h=harness();h.selection.forEach(s=>{s.includeProduction=s.demo_id!=='demo-add';s.includePreview=false;});
  const r=h.readyReview();assert.equal(h.context.registryManualReviewView_(r).production_enabled,false);
  assert.throws(()=>h.context.registryManualConfirmProduction(r.id),/No production changes/);assertNoProduction(h);
  h.capsules.preview.provenance.renderer_digest=sha('9');
  const view=h.context.registryManualReviewProduction();assert.equal(view.change_count,1);
  assert.equal(view.changes.at(-1).title,'Website layout');assert.equal(view.production_enabled,true);
});
test('a pending or uncertain production request prevents new preparation and duplicate submission',()=>{
  const h=harness(),review=h.readyReview();h.hookError(new Error('Connection timed out'));
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/timed out/);
  assert.equal(h.requests.size,1);assert.equal(h.posts.length,1);
  assert.throws(()=>h.context.registryManualReviewProduction(),/in progress/);
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/in progress/);assert.equal(h.posts.length,1);
});
test('missing production hook blocks requests while the retired review hook is unnecessary',()=>{
  const h=harness();assert.equal(h.context.registryManualConfigured_(),true);
  const review=h.readyReview();h.properties.delete('AIS_RELEASE_PRODUCTION_HOOK');
  assert.throws(()=>h.context.registryManualConfirmProduction(review.id),/not connected/);assertNoProduction(h);
});
test('failed publication exposes its error without retrying',()=>{
  const h=harness();h.requests.set('failed-request',{kind:'production',phase:'failed',error:'Build failed before publication'});
  h.properties.set('AIS_RELEASE_ACTIVE_REQUEST_ID','failed-request');
  assert.equal(h.context.registryManualSummary_().production_error,'Build failed before publication');assert.equal(h.posts.length,0);
});
