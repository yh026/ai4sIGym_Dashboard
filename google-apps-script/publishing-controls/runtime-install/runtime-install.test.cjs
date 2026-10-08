'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {SOURCE_NAMES, assembleRuntime, buildRuntime, writeRuntime} = require('./bundle.cjs');
const root = path.resolve(__dirname, '..');
const sources = () => Object.fromEntries(SOURCE_NAMES.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function runtime() {
  const bundle = buildRuntime();
  const context = vm.createContext({UrlFetchApp: {fetch() { throw new Error('Unexpected network call'); }}});
  vm.runInContext(Object.values(bundle.files).join('\n'), context);
  return {bundle, context};
}

function previewPublisher() {
  const {context} = runtime();
  const revision = 'sha256:' + 'a'.repeat(64), posts = [];
  let state = {phase: 'ready', revision, deploy_id: 'b'.repeat(24), request_id: 'previous-request', attempts: 3};
  let capsule = null, lockDepth = 0, onFetch;
  context.console = {log() {}};
  context.sandboxGuard_ = () => ({});
  context.PropertiesService = {getScriptProperties: () => ({getProperty: key => key === 'AI4S_NETLIFY_PREVIEW_BUILD_HOOK'
    ? 'https://api.netlify.com/build_hooks/' + 'c'.repeat(24) : null})};
  context.checkedSnapshot_ = () => ({manifest: {registry_revision: revision}});
  context.previewState_ = () => ({...state});
  context.savePreviewState_ = value => { state = {...value}; };
  context.registryReleaseStoreGetActive_ = () => capsule;
  context.Utilities = {getUuid: () => 'fresh-explicit-preview-request'};
  context.audit_ = () => {};
  context.locked_ = fn => {
    if (lockDepth) throw new Error('Another sandbox operation is running');
    lockDepth++; try { return fn(); } finally { lockDepth--; }
  };
  context.UrlFetchApp = {fetch(url, options) {
    assert.equal(lockDepth, 1); assert.equal(state.phase, 'requested');
    posts.push({url, ...options}); if (onFetch) onFetch(); return {getResponseCode: () => 202};
  }};
  return {context, posts, revision, state: () => state, setState(value) { state = {...state, ...value}; },
    setCapsule(value) { capsule = value; }, onFetch(value) { onFetch = value; }};
}

test('runtime is deterministic and every output is covered by a byte digest', () => {
  const first = buildRuntime(), second = buildRuntime();
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first.files).sort(), ['Code.gs', 'ManualRelease.gs', 'RegistryUi.gs']);
  for (const [name, text] of Object.entries(first.files)) {
    assert.equal(first.manifest.files[name].bytes, Buffer.byteLength(text));
    assert.equal(first.manifest.files[name].sha256, digest(text));
  }
  assert.doesNotMatch(JSON.stringify(first.manifest), /\/Users\/|\.local\//);
});

test('assembled public Review and Confirm functions call the manual release adapter', () => {
  const {context} = runtime(), calls = [];
  context.registryManualReviewProduction = () => { calls.push('review'); return {phase: 'preparing'}; };
  context.registryManualConfirmProduction = id => { calls.push(['confirm', id]); return {message: 'requested'}; };
  assert.equal(context.registryPublishingReviewProduction().phase, 'preparing');
  assert.deepEqual(calls, ['review']);
  assert.equal(context.registryPublishingConfirmProduction('review-id').message, 'requested');
  assert.deepEqual(calls, ['review', ['confirm', 'review-id']]);
});

test('assembled opening and hourly handlers only enter menu/status functions', () => {
  const {context} = runtime(), calls = [];
  context.registryUiOnOpen_ = () => calls.push('menu');
  context.registryPublishingRefreshStatus = () => calls.push('status');
  context.publishPreview = () => { throw new Error('Unexpected deployment'); };
  context.syncSandbox = () => { throw new Error('Unexpected sync'); };
  context.onOpen(); context.hourlySandbox();
  assert.deepEqual(calls, ['menu', 'status']);
});

test('sidebar HTML is generated from the current source, not a stale embedded copy', () => {
  const {context} = runtime();
  assert.equal(context.registryUiSidebarHtml_(), fs.readFileSync(path.join(root, 'sidebar.html'), 'utf8'));
  assert.match(context.registryUiSidebarHtml_(), /Publish to production/);
});

test('manual API dispatcher routes to the signed release store', () => {
  const {context} = runtime(); let received;
  context.registryReleaseStoreHandlePost_ = event => { received = event; return 'release-store'; };
  const event = {parameter: {action: 'manual_release'}, postData: {contents: 'signed envelope'}};
  assert.equal(context.doPost(event), 'release-store'); assert.equal(received, event);
});

test('status adapter preserves manual enrichment and read-only reconciliation', () => {
  const {context} = runtime(), calls = [];
  context.locked_ = fn => { calls.push('lock'); return fn(); };
  context.registryReleaseStoreReconcileProduction_ = () => calls.push('reconcile');
  context.registryPublishingLegacyRefreshStatus_ = () => { calls.push('refresh'); return {ok: true}; };
  assert.equal(context.registryPublishingRefreshStatus().ok, true);
  assert.deepEqual(calls, ['lock', 'reconcile', 'refresh']);
  context.registryUiLegacyGetStatus_ = () => ({preview_state: 'Preview ready'});
  context.registryManualEnrichStatus_ = s => ({...s, publishing: {production_state: 'Published'}});
  assert.equal(context.registryUiGetStatus().publishing.production_state, 'Published');
});

test('changed or duplicate adapter markers stop assembly instead of silently retaining old publishing', () => {
  const missing = sources(); missing['RegistryPublishing.gs'] = missing['RegistryPublishing.gs'].replace('function registryPublishingConfirmProduction(', 'function changedConfirm(');
  assert.throws(() => assembleRuntime(missing), /expected one adapter function/);
  const duplicate = sources(); duplicate['RegistryPublishing.gs'] += '\nfunction registryPublishingReviewProduction() {}\n';
  assert.throws(() => assembleRuntime(duplicate), /expected one adapter function/);
});

test('automatic hourly publication and embedded credential values are rejected', () => {
  const automatic = sources(); automatic['runtime-install/base/Code.gs'] = automatic['runtime-install/base/Code.gs']
    .replace('function hourlySandbox(){registryPublishingRefreshStatus();}', 'function hourlySandbox(){publishPreview();}');
  assert.throws(() => assembleRuntime(automatic), /hourly handler/);
  const credential = sources(); credential['runtime-install/base/Code.gs'] += '\nvar unexpectedHook = "https://api.netlify.com/build_hooks/' + 'a'.repeat(24) + '";\n';
  assert.throws(() => assembleRuntime(credential), /hook value/);
});

test('local output contains exactly the three installable files and integrity manifest', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-runtime-install-'));
  try {
    const manifest = writeRuntime(directory);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['Code.gs', 'ManualRelease.gs', 'RegistryUi.gs', 'runtime-manifest.json']);
    for (const [name, metadata] of Object.entries(manifest.files)) assert.equal(digest(fs.readFileSync(path.join(directory, name))), metadata.sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'))), manifest);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  assert.throws(() => writeRuntime(path.join(__dirname, 'base')), /overwrite versioned/);
});

test('explicit Update creates a fresh artifact build for a previously ready preview lacking its capsule', () => {
  const h = previewPublisher();
  assert.equal(h.context.publishPreview().phase, 'ready'); assert.equal(h.posts.length, 0);
  const result = h.context.publishPreview(true);
  assert.equal(result.phase, 'accepted'); assert.equal(h.posts.length, 1);
  assert.equal(result.attempts, 1, 'a completed old build must not exhaust the new artifact request');
  assert.equal(JSON.parse(h.posts[0].payload).request_id, 'fresh-explicit-preview-request');
  assert.equal(JSON.parse(h.posts[0].payload).target, 'preview');
});

test('a matching completed preview capsule preserves normal ready-state deduplication', () => {
  const h = previewPublisher(), state = h.state();
  h.setCapsule({complete: true, provenance: {deploy_id: state.deploy_id, request_id: state.request_id, registry_revision: state.revision}});
  assert.equal(h.context.publishPreview(true).phase, 'ready'); assert.equal(h.posts.length, 0);
});

test('pending requests stay single even when the explicit artifact-refresh flag is passed again', () => {
  const h = previewPublisher();
  h.onFetch(() => assert.throws(() => h.context.publishPreview(true), /Another sandbox operation/));
  h.context.publishPreview(true); h.context.publishPreview(true);
  assert.equal(h.posts.length, 1); assert.equal(h.state().phase, 'accepted');
  h.setState({phase: 'requested'}); h.context.publishPreview(true); assert.equal(h.posts.length, 1);
});

test('artifact refresh cannot bypass the failed-request guard or refresh a different revision', () => {
  const h = previewPublisher(); h.setState({phase: 'failed'});
  assert.equal(h.context.publishPreview(true).phase, 'failed'); assert.equal(h.posts.length, 0);
  assert.equal(h.context.registryManualNeedsPreviewArtifact_({...h.state(), phase: 'ready'}, 'other-revision'), false);
});

test('stale or incomplete preview capsules require explicit artifact refresh', () => {
  const h = previewPublisher(), state = h.state();
  const valid = {complete: true, provenance: {deploy_id: state.deploy_id, request_id: state.request_id, registry_revision: state.revision}};
  for (const key of ['deploy_id', 'request_id', 'registry_revision']) {
    h.setCapsule({...valid, provenance: {...valid.provenance, [key]: 'old'}});
    assert.equal(h.context.registryManualNeedsPreviewArtifact_(state, state.revision), true);
  }
  h.setCapsule({...valid, complete: false});
  assert.equal(h.context.registryManualNeedsPreviewArtifact_(state, state.revision), true);
});
