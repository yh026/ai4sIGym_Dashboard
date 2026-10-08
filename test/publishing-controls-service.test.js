'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const base = path.join(__dirname, '../google-apps-script/publishing-controls');
const code = ['PublishingControlsModel.gs', 'RegistryPublishing.gs'].map(file => fs.readFileSync(path.join(base, file), 'utf8')).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = digit => 'sha256:' + digit.repeat(64);
const prodDeploy = 'a'.repeat(24), prevDeploy = 'b'.repeat(24);
const previewUrl = 'https://develop--aisigym.netlify.app/';
const productionUrl = 'https://aisigym.netlify.app/';

function harness() {
  const ids = Array.from({length: 13}, (_, i) => 'demo-' + String(i + 1).padStart(3, '0'));
  const sheets = {}, writes = [], fetches = [], events = [], properties = new Map();
  let syncFailure = '', writeFailure = '', lockDepth = 0;
  let signed = {phase: 'ready', revision: sha('c'), deploy_id: prevDeploy, request_id: 'reviewed-request',
    ready_at: '2026-10-05T06:37:51.827Z'};
  const ui = {};
  class Sheet {
    constructor(name, data) { this.name = name; this.data = clone(data); sheets[name] = this; }
    getRange(row, col, height = 1, width = 1) {
      const sheet = this;
      function read(map) { return Array.from({length: height}, (_, i) => Array.from({length: width}, (_, j) =>
        map(sheet.data[row - 1 + i]?.[col - 1 + j] ?? ''))); }
      const range = {
        getValues: () => read(v => typeof v === 'string' && v.startsWith('=') ? 'Formula result' : v),
        getFormulas: () => read(v => typeof v === 'string' && v.startsWith('=') ? v : ''),
        setValues(values) {
          assert.equal(values.length, height); values.forEach(r => assert.equal(r.length, width));
          if (writeFailure === sheet.name) { writeFailure = ''; throw new Error('Injected range write failure'); }
          writes.push({sheet: sheet.name, row, col, height, width});
          for (let i = 0; i < height; i++) {
            sheet.data[row - 1 + i] ||= [];
            for (let j = 0; j < width; j++) sheet.data[row - 1 + i][col - 1 + j] = values[i][j];
          }
          return range;
        },
        clearContent() { return range.setValues(Array.from({length: height}, () => Array(width).fill(''))); },
      };
      return range;
    }
    getDataRange() {
      let lastRow = 0, lastCol = 0;
      this.data.forEach((r, i) => r.forEach((v, j) => { if (v !== '' && v !== undefined) { lastRow = Math.max(lastRow, i + 1); lastCol = Math.max(lastCol, j + 1); } }));
      return this.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, 1));
    }
  }
  new Sheet('Control panel', Array.from({length: 22}, (_, i) => {
    const row = Array(13).fill('');
    if (i === 8) { row[3] = 'Include in production'; row[5] = 'Include in preview'; row[12] = 'demo_id'; }
    if (i > 8) { row[3] = true; row[5] = true; row[12] = ids[i - 9]; }
    return row;
  }));
  const stateHeaders = ['demo_id', 'Production status', 'Preview status', 'Production route', 'Preview route',
    'Checked at', 'Preferred version', 'Production digest', 'Preview digest', 'Production deploy', 'Preview deploy'];
  new Sheet('_PublishingState', [stateHeaders, ...ids.map(id => [id, 'Not checked', 'Not checked', '', '', '', id + '-v1', '', '', '', ''])]);
  new Sheet('Project files', [...Array.from({length: 4}, () => Array(11).fill('')), ...ids.map((id, i) => {
    const row = Array(11).fill(''); row[0] = String(i + 1).padStart(3, '0'); row[1] = 'Project ' + (i + 1); row[10] = id; return row;
  })]);
  new Sheet('Versions', [['Version ID', 'demo_id', 'Layout', 'State', 'Permission', 'Use in develop', 'Collection', 'Snapshot digest', 'Check'],
    ...ids.map(id => [id + '-v1', id, 'three-page', 'Draft', 'Preview only', true, '', sha('d'), 'Validated'])]);
  new Sheet('Projects', [Array(20).fill('Header'), ...ids.map(id => {
    const row = Array(20).fill(''); row[1] = 'Preview ready'; row[2] = '=HYPERLINK("https://example.test/","Open Preview")';
    row[17] = id; row[18] = id + '-v1'; return row;
  })]);
  for (const name of ['_Pages', '_Resources', '_Snapshots', '_SandboxAudit']) new Sheet(name, [['ID', 'Value'], ['old', 'unchanged']]);
  function manifest(audience, selectedIds = ids, revision = sha('c')) {
    return {audience, registry_revision: revision, demos: selectedIds.map(id => ({demo_id: id, slug: id.slice(5)})),
      bundles: selectedIds.map(id => ({demo_id: id, version_id: id + '-v1', snapshot_digest: sha('d')}))};
  }
  const snapshots = {'snapshot-original': {manifest: manifest('preview')}};
  properties.set('SANDBOX_SNAPSHOT_FILE', 'snapshot-original');
  const propertyApi = {getProperty: key => properties.get(key) || null,
    setProperty: (key, value) => { properties.set(key, value); return propertyApi; },
    deleteProperty: key => { properties.delete(key); return propertyApi; }};
  const receipts = {
    production: {schema: 1, platform: 'netlify', site_id: 'expected-site', target: 'production', audience: 'production',
      revision_bound: true, branch: 'main', context: 'production', deploy_id: prodDeploy, registry_revision: sha('a')},
    preview: {schema: 1, platform: 'netlify', site_id: 'expected-site', target: 'preview', audience: 'preview',
      revision_bound: true, branch: 'develop', context: 'branch-deploy', deploy_id: prevDeploy,
      registry_revision: sha('c'), request_id: signed.request_id},
  };
  const routes = new Map([
    [productionUrl + 'deploy-receipt.json', () => receipts.production],
    ['https://' + prodDeploy + '--aisigym.netlify.app/deploy-receipt.json', () => receipts.production],
    ['https://' + prodDeploy + '--aisigym.netlify.app/manifest.json', () => manifest('production')],
    [previewUrl + 'deploy-receipt.json', () => receipts.preview],
  ]);
  const context = vm.createContext({
    console, Date, Number, JSON,
    SANDBOX: {site_id: 'expected-site'},
    REGISTRY_UI: {previewUrl, productionUrl, productionReceiptUrl: productionUrl + 'deploy-receipt.json'},
    PropertiesService: {getScriptProperties: () => propertyApi},
    Utilities: {getUuid: () => 'review-uuid'},
    SpreadsheetApp: {flush: () => events.push('flush')},
    registryUiSpreadsheet_: () => ({getSheetByName: name => sheets[name], toast: () => {}}),
    registryUiPatch_: patch => Object.assign(ui, clone(patch)),
    registryUiMessage_: error => String(error.message || error),
    registryUiWriteStatus_: value => value,
    registryUiGetStatus: () => ({...ui, preview_state: signed.phase}),
    previewState_: () => clone(signed),
    currentSnapshot_: () => clone(snapshots[properties.get('SANDBOX_SNAPSHOT_FILE')]),
    tableRows_: (_, name) => sheets[name].getDataRange().getValues(),
    objects_: rows => rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, i) => [key, row[i]]))),
    locked_: fn => { lockDepth++; try { return fn(); } finally { lockDepth--; } },
    V3: {stable: JSON.stringify},
    UrlFetchApp: {fetch: (url, options) => {
      fetches.push({url, ...clone(options)});
      const route = routes.get(url);
      if (!route) throw new Error('Unexpected network request: ' + url);
      const body = route();
      return {getResponseCode: () => body.status || 200, getContentText: () => JSON.stringify(body)};
    }},
    syncSandbox_: () => {
      events.push('sync');
      if (syncFailure === 'early') throw new Error('Injected early sync failure');
      const active = sheets.Versions.data.slice(1).filter(row => row[5] === true).map(row => row[1]);
      const nextManifest = manifest('preview', active, sha('e'));
      snapshots['snapshot-next'] = {manifest: nextManifest};
      for (const row of sheets.Projects.data.slice(1)) { row[1] = 'Validated; preview pending'; row[2] = ''; row[18] = active.includes(row[17]) ? row[17] + '-v1' : ''; }
      for (const row of sheets.Versions.data.slice(1)) if (row[5]) { row[7] = sha('e'); row[8] = 'Validated'; }
      for (const name of ['_Pages', '_Resources']) sheets[name].data = [['ID', 'Value'], ['new', 'generated'], ['extra', 'generated']];
      for (const name of ['_Snapshots', '_SandboxAudit']) sheets[name].data.push(['new', 'generated']);
      properties.set('SANDBOX_SNAPSHOT_FILE', 'snapshot-next');
      if (syncFailure === 'late') throw new Error('Injected late sync failure');
      return clone(nextManifest);
    },
    publishPreview: () => { events.push('publish-preview'); signed = {...signed, phase: 'requested', revision: sha('e'), request_id: 'next-request'}; },
  });
  vm.runInContext(code, context);
  return {context, ids, sheets, writes, fetches, events, properties, receipts, routes,
    setSigned: value => { signed = clone(value); }, getSigned: () => clone(signed),
    setSyncFailure: value => { syncFailure = value; }, setWriteFailure: value => { writeFailure = value; },
    setSelection: (i, column, value) => { sheets['Control panel'].data[i + 9][column === 'preview' ? 5 : 3] = value; },
    lockDepth: () => lockDepth, manifest,
  };
}
function allSheetValues(h) { return Object.fromEntries(Object.entries(h.sheets).map(([name, s]) => [name, clone(s.getDataRange().getValues())])); }

test('editing a staged checkbox and refreshing never changes canonical build inputs', () => {
  const h = harness(), before = clone(h.sheets.Versions.data);
  h.setSelection(0, 'preview', false); h.context.registryPublishingRefreshStatus();
  assert.deepEqual(h.sheets.Versions.data, before);
  assert.equal(h.events.includes('sync'), false); assert.equal(h.events.includes('publish-preview'), false);
  assert.ok(h.fetches.every(call => call.method === 'get'));
  assert.equal(h.sheets._PublishingState.data[1][2], 'Published');
});

test('existing sync uses active Versions rather than staged checkbox edits', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  assert.equal(h.context.syncSandbox_().demos.length, 13);
  const result = h.context.locked_(h.context.registryPublishingApplyPreview_);
  assert.equal(result.demos.length, 12); assert.equal(h.sheets.Versions.data[1][5], false);
});

test('explicit preview update applies selection, publishes preview, and never sends a production request', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  h.context.registryPublishingUpdatePreview();
  assert.equal(h.sheets.Versions.data[1][5], false);
  assert.equal(h.events.filter(e => e === 'sync').length, 1);
  assert.equal(h.events.filter(e => e === 'publish-preview').length, 1);
  assert.ok(h.fetches.every(call => call.method === 'get'));
  // While the new build is pending, the verified old deployment remains published.
  assert.equal(h.sheets._PublishingState.data[1][2], 'Published');
});

test('excluded project retains preferred version and can be re-enabled', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  h.context.locked_(h.context.registryPublishingApplyPreview_);
  assert.equal(h.sheets.Projects.data[1][18], '');
  assert.equal(h.sheets._PublishingState.data[1][6], h.ids[0] + '-v1');
  h.setSelection(0, 'preview', true); h.context.locked_(h.context.registryPublishingApplyPreview_);
  assert.equal(h.sheets.Versions.data[1][5], true);
});

test('all preview projects may be excluded without deleting data or production selection', () => {
  const h = harness(); h.ids.forEach((_, i) => h.setSelection(i, 'preview', false));
  const result = h.context.locked_(h.context.registryPublishingApplyPreview_);
  assert.equal(result.demos.length, 0);
  assert.ok(h.sheets.Versions.data.slice(1).every(row => row[5] === false));
  assert.ok(h.sheets['Control panel'].data.slice(9).every(row => row[3] === true));
  assert.ok(h.sheets._PublishingState.data.slice(1).every(row => row[6]));
});

for (const phase of ['early', 'late']) test('failed ' + phase + ' sync restores active inputs, generated tables, formulas and snapshot pointer', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  h.sheets._PublishingState.data[1][6] = h.ids[0] + '-old-preference';
  const before = allSheetValues(h), originalFormula = h.sheets.Projects.data[1][2];
  h.setSyncFailure(phase);
  assert.throws(() => h.context.locked_(h.context.registryPublishingApplyPreview_), /Injected .* sync failure/);
  assert.deepEqual(allSheetValues(h), before);
  assert.equal(h.sheets.Projects.data[1][2], originalFormula);
  assert.equal(h.properties.get('SANDBOX_SNAPSHOT_FILE'), 'snapshot-original');
  assert.equal(h.events.includes('publish-preview'), false);
});

test('a write failure after preferred-version capture also rolls back cleanly', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  h.sheets._PublishingState.data[1][6] = h.ids[0] + '-old-preference';
  const before = allSheetValues(h); h.setWriteFailure('Versions');
  assert.throws(() => h.context.locked_(h.context.registryPublishingApplyPreview_), /Injected range write failure/);
  assert.deepEqual(allSheetValues(h), before); assert.equal(h.events.includes('sync'), false);
});

test('invalid or duplicate version choice fails before mutating any sheet', () => {
  const h = harness(); h.sheets.Versions.data.push([...h.sheets.Versions.data[1]]);
  assert.throws(() => h.context.locked_(h.context.registryPublishingApplyPreview_), /Multiple development versions/);
  assert.equal(h.writes.length, 0);
});

test('invalid staged checkbox fails before network, sync or publishing', () => {
  const h = harness(); h.setSelection(0, 'preview', 'FALSE');
  assert.throws(() => h.context.registryPublishingUpdatePreview(), /booleans/);
  assert.equal(h.fetches.length, 0); assert.equal(h.events.length, 0);
});

test('preview refresh requires the live receipt to match deploy, revision and request', () => {
  for (const field of ['deploy_id', 'registry_revision', 'request_id']) {
    const h = harness();
    assert.equal(h.context.registryPublishingRefreshPreview_().known, true);
    h.receipts.preview[field] = field === 'deploy_id' ? 'f'.repeat(24) : 'different';
    assert.equal(h.context.registryPublishingRefreshPreview_().known, false, field);
  }
});

test('a 500 preview read returns unknown instead of freshening a cached deployment', () => {
  const h = harness(); h.context.registryPublishingRefreshPreview_();
  h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 500}));
  assert.equal(h.context.registryPublishingRefreshPreview_().known, false);
  h.context.registryPublishingRefreshStatus();
  assert.ok(h.sheets._PublishingState.data.slice(1).every(row => row[2] === 'Not checked' && row[5] === ''));
});

test('Team protection 401 displays signed callback evidence with its original time and explicit staleness', () => {
  const h = harness(); h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  const result = h.context.registryPublishingRefreshPreview_();
  assert.equal(result.known, true); assert.equal(result.stale, true);
  assert.equal(result.source, 'signed_callback'); assert.equal(result.checked_at, h.getSigned().ready_at);
  assert.equal(result.projects.length, 13); assert.match(result.warning, /last signed verification/);
  const summary = h.context.registryPublishingRefreshStatus();
  assert.equal(h.sheets._PublishingState.data[1][5], h.getSigned().ready_at);
  assert.equal(summary.publishing.preview_stale, true);
  assert.equal(summary.publishing.production_enabled, false);
});

test('401 fallback requires exact signed snapshot revision and a valid ready timestamp', () => {
  for (const change of [h => h.setSigned({...h.getSigned(), revision: sha('a')}),
    h => h.setSigned({...h.getSigned(), ready_at: ''}), h => h.setSigned({...h.getSigned(), phase: 'replaced'})]) {
    const h = harness(); h.context.registryPublishingRefreshPreview_(); change(h);
    h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
    assert.equal(h.context.registryPublishingRefreshPreview_().known, false);
  }
});

test('pending-build 401 retains only cached signed evidence without advancing its checked time', () => {
  const h = harness(); h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  const original = h.context.registryPublishingRefreshPreview_();
  h.setSigned({...h.getSigned(), phase: 'accepted', request_id: 'new-request', revision: sha('f')});
  const result = h.context.registryPublishingRefreshPreview_();
  assert.equal(result.known, true); assert.equal(result.stale, true);
  assert.equal(result.checked_at, original.checked_at); assert.equal(result.deploy_id, prevDeploy);
  const cache = JSON.parse(h.properties.get('AIS_PUBLISHING_PREVIEW_ACTUAL_V1'));
  cache.source = 'unverified'; h.properties.set('AIS_PUBLISHING_PREVIEW_ACTUAL_V1', JSON.stringify(cache));
  assert.equal(h.context.registryPublishingRefreshPreview_().known, false);
});

test('pending-build 401 retains signed-artifact membership as historical, never as the latest preview', () => {
  const h = harness(); h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  const original = h.context.registryPublishingRefreshPreview_();
  const cache = {...JSON.parse(h.properties.get('AIS_PUBLISHING_PREVIEW_ACTUAL_V1')), source: 'signed_artifact'};
  h.properties.set('AIS_PUBLISHING_PREVIEW_ACTUAL_V1', JSON.stringify(cache));
  h.setSigned({...h.getSigned(), phase: 'accepted', request_id: 'next-request', revision: sha('f')});
  const status = h.context.registryPublishingRefreshStatus();
  const saved = JSON.parse(h.properties.get('AIS_PUBLISHING_PREVIEW_ACTUAL_V1'));
  assert.equal(saved.known, true); assert.equal(saved.stale, true); assert.equal(saved.source, 'signed_artifact');
  assert.equal(saved.checked_at, original.checked_at); assert.equal(saved.deploy_id, prevDeploy);
  assert.equal(saved.request_id, original.request_id); assert.equal(saved.registry_revision, original.registry_revision);
  assert.equal(status.preview_state, 'accepted', 'pending build status remains separate from historical membership');
  assert.equal(status.publishing.preview_stale, true); assert.equal(status.publishing.production_enabled, false);
  assert.ok(h.sheets._PublishingState.data.slice(1).every(row => row[2] === 'Published' && row[5] === original.checked_at));
});

test('a later successful live receipt read clears stale status', () => {
  const h = harness(); h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  assert.equal(h.context.registryPublishingRefreshPreview_().stale, true);
  h.routes.set(previewUrl + 'deploy-receipt.json', () => h.receipts.preview);
  assert.equal(h.context.registryPublishingRefreshPreview_().stale, false);
});

test('pending builds retain cached actual membership only while the live receipt still matches', () => {
  const h = harness(); h.context.registryPublishingRefreshPreview_();
  h.setSigned({...h.getSigned(), phase: 'accepted', request_id: 'new-request', revision: sha('f')});
  assert.equal(h.context.registryPublishingRefreshPreview_().known, true);
  h.receipts.preview.deploy_id = 'c'.repeat(24);
  assert.equal(h.context.registryPublishingRefreshPreview_().known, false);
});

test('production refresh failure marks unknown without overwriting deployed membership as empty', () => {
  const h = harness(); h.context.registryPublishingRefreshStatus();
  const old = h.properties.get('AIS_PUBLISHING_PRODUCTION_ACTUAL_V1');
  h.routes.set(productionUrl + 'deploy-receipt.json', () => ({status: 500}));
  h.context.registryPublishingRefreshStatus();
  assert.ok(h.sheets._PublishingState.data.slice(1).every(row => row[1] === 'Not checked'));
  assert.equal(h.properties.get('AIS_PUBLISHING_PRODUCTION_ACTUAL_V1'), old);
});

test('status stores ISO UTC for the sheet to render once in Singapore time', () => {
  const h = harness(); h.context.registryPublishingRefreshStatus();
  assert.match(h.sheets._PublishingState.data[1][5], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('Last checked uses the older actual verification time and is never minted by display refresh', () => {
  const h = harness(), production = {known: true, projects: [], checked_at: '2026-10-07T07:00:00.000Z'},
    preview = {known: true, projects: [], checked_at: '2026-10-05T06:37:51.827Z'};
  h.context.registryPublishingWriteStates_(production, preview);
  assert.equal(h.sheets._PublishingState.data[1][5], preview.checked_at);
  production.checked_at = '2026-10-04T07:00:00.000Z';
  h.context.registryPublishingWriteStates_(production, preview);
  assert.equal(h.sheets._PublishingState.data[1][5], production.checked_at);
});

test('protected-preview historical status allows a review plan but disables production even with transport configured', () => {
  const h = harness(); h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  h.properties.set('AIS_PRODUCTION_RELEASE_BRIDGE_URL', previewUrl + '.netlify/functions/registry-production-release');
  const review = h.context.registryPublishingReviewProduction();
  assert.equal(review.changes.length, 13); assert.equal(review.production_enabled, false);
  assert.match(review.production_disabled_reason, /last signed verification/);
  assert.throws(() => h.context.registryPublishingConfirmProduction(review.id), /not been freshly verified/);
  assert.ok(h.fetches.every(call => call.method === 'get'));
});

test('freshly prepared review cannot publish if preview becomes protected before confirmation', () => {
  const h = harness(); h.properties.set('AIS_PRODUCTION_RELEASE_BRIDGE_URL', previewUrl + '.netlify/functions/registry-production-release');
  const review = h.context.registryPublishingReviewProduction(); assert.equal(review.production_enabled, true);
  h.routes.set(previewUrl + 'deploy-receipt.json', () => ({status: 401}));
  assert.throws(() => h.context.registryPublishingConfirmProduction(review.id), /not been freshly verified/);
  assert.ok(h.fetches.every(call => call.method === 'get'));
});

test('preparing production review is read-only and missing transport fails closed', () => {
  const h = harness(), before = clone(h.sheets.Versions.data);
  const review = h.context.registryPublishingReviewProduction();
  assert.equal(review.production_enabled, false);
  const fetchCount = h.fetches.length;
  assert.throws(() => h.context.registryPublishingConfirmProduction(review.id), /not connected/);
  assert.equal(h.fetches.length, fetchCount);
  assert.ok(h.fetches.every(call => call.method === 'get'));
  assert.deepEqual(h.sheets.Versions.data, before); assert.equal(h.events.includes('publish-preview'), false);
});

test('production review retains the public version when preview inclusion is off, even before the preview removal deploys', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  const review = h.context.registryPublishingReviewProduction();
  assert.equal(review.changes.find(row => row.demo_id === h.ids[0]).action, 'Keep current production');
  assert.equal(review.changes.find(row => row.demo_id === h.ids[1]).action, 'Use reviewed preview');
  assert.equal(h.sheets._PublishingState.data[1][2], 'Published');
  assert.equal(h.events.includes('sync'), false);
});

test('production review cannot add a project from deployed preview when preview inclusion is off', () => {
  const h = harness(); h.setSelection(0, 'preview', false);
  h.routes.set('https://' + prodDeploy + '--aisigym.netlify.app/manifest.json',
    () => h.manifest('production', h.ids.slice(1)));
  assert.throws(() => h.context.registryPublishingReviewProduction(), /no production version to retain/);
  assert.equal(h.properties.has('AIS_PUBLISHING_PRODUCTION_REVIEW_V1'), false);
  assert.ok(h.fetches.every(call => call.method === 'get'));
});

test('production review requires included preview content and cannot silently retain an existing public version', () => {
  const h = harness(); h.context.currentSnapshot_ = () => ({manifest: h.manifest('preview', h.ids.slice(1))});
  assert.throws(() => h.context.registryPublishingReviewProduction(), /Update preview with demo-001/);
  assert.equal(h.properties.has('AIS_PUBLISHING_PRODUCTION_REVIEW_V1'), false);
  assert.equal(h.events.includes('publish-preview'), false);
});

test('expired, malformed and future review timestamps fail before transport lookup or network', () => {
  for (const created_at of ['invalid', new Date(Date.now() - 20 * 60 * 1000).toISOString(), new Date(Date.now() + 60000).toISOString()]) {
    const h = harness(); h.properties.set('AIS_PUBLISHING_PRODUCTION_REVIEW_V1', JSON.stringify({id: 'review-id', created_at}));
    assert.throws(() => h.context.registryPublishingConfirmProduction('review-id'), /expired/);
    assert.equal(h.fetches.length, 0);
  }
});

test('a changed staged selection invalidates an already prepared production review', () => {
  const h = harness(), review = h.context.registryPublishingReviewProduction();
  h.properties.set('AIS_PRODUCTION_RELEASE_BRIDGE_URL', previewUrl + '.netlify/functions/registry-production-release');
  h.setSelection(0, 'production', false);
  const fetchCount = h.fetches.length;
  assert.throws(() => h.context.registryPublishingConfirmProduction(review.id), /Selection changed/);
  assert.equal(h.fetches.length, fetchCount);
});
