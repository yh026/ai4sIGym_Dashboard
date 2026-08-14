'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAppsScript() {
  const filename = path.join(__dirname, '..', 'google-apps-script', 'Code.gs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest(),
        byte => (byte > 127 ? byte - 256 : byte));
    },
  };
  return context;
}

function iterator(values) {
  let index = 0;
  return {
    hasNext: () => index < values.length,
    next: () => values[index++],
  };
}

function propertyStore(script) {
  const values = {};
  const api = {
    getProperty: key => values[key] ?? null,
    getProperties: () => ({ ...values }),
    setProperty: (key, value) => { values[key] = String(value); return api; },
    setProperties: (entries, deleteAllOthers) => {
      assert.equal(deleteAllOthers, false,
        'fingerprint writes must never delete credentials or Preview state');
      Object.entries(entries).forEach(([key, value]) => { values[key] = String(value); });
      return api;
    },
    deleteProperty: key => { delete values[key]; return api; },
  };
  script.PropertiesService = { getScriptProperties: () => api };
  return values;
}

function mutableEntry(options) {
  const state = {
    id: options.id,
    name: options.name,
    mime: options.mime,
    modified: options.modified ?? Date.parse('2026-08-14T00:00:00.000Z'),
    created: options.created ?? Date.parse('2026-08-13T00:00:00.000Z'),
    parents: options.parents || [],
    text: options.text || '',
    blobReads: 0,
  };
  return {
    state,
    getId: () => state.id,
    getName: () => state.name,
    getMimeType: () => state.mime,
    getLastUpdated: () => new Date(state.modified),
    getDateCreated: () => new Date(state.created),
    getParents: () => iterator(state.parents),
    getSize: () => Buffer.byteLength(state.text),
    getBlob: () => {
      state.blobReads += 1;
      return { getDataAsString: () => state.text };
    },
  };
}

function demoItem(entries = {}) {
  const root = entries.root || mutableEntry({
    id: 'root-folder-12345', name: 'Root', mime: 'application/vnd.google-apps.folder',
  });
  const folder = entries.folder || mutableEntry({
    id: 'demo-folder-12345', name: 'demo-one',
    mime: 'application/vnd.google-apps.folder', parents: [root],
  });
  const page = entries.page || mutableEntry({
    id: 'page-file-12345', name: 'demo-one.html', mime: 'text/html', parents: [folder],
    text: '<html><title>Demo one</title><script type="application/json" id="ai4s-meta">'
      + '{"description":"A structured dataset."}</script></html>',
  });
  const provenance = entries.provenance || mutableEntry({
    id: 'provenance-file-12345', name: 'PROVENANCE.md', mime: 'text/markdown',
    parents: [folder], text: '---\nstory:\n  question: What is shown?\n---\n',
  });
  const image = entries.image || mutableEntry({
    id: 'card-image-12345', name: 'card.png', mime: 'image/png', parents: [folder],
    text: 'png',
  });
  return {
    root, folder, page, provenance, image,
    item: {
      rootId: root.getId(), folderId: folder.getId(), folderName: folder.getName(), folder,
      file: page, pageFiles: [page], provFile: provenance, picFile: image,
      imageFiles: [image], card: null, stamp: page.getLastUpdated(), notes: [],
    },
  };
}

function sourceRecord(fileId, fileCheck = 'ok', dateAdded = '2026-08-13T00:00:00.000Z') {
  return { file_id: fileId, file_check: fileCheck, date_added: dateAdded };
}

function verifiedRegistryState(script, sources) {
  const header = Array.from(script.REGISTRY_V2_HEADERS._Registry);
  const values = [header, ...sources.map(source => (
    header.map(key => source[key] ?? '')
  ))];
  return { _Registry: {
    rows: values.length,
    columns: header.length,
    values,
    formulas: values.map(row => row.map(() => '')),
  } };
}

function commitFingerprint(script, cache, item, source) {
  return script.registryV2WriteIngestCache_(
    cache, [item], verifiedRegistryState(script, [source]),
  );
}

test('unchanged Drive metadata reuses the bound _Registry result without blob downloads', () => {
  const script = loadAppsScript();
  propertyStore(script);
  const demo = demoItem();

  const cold = script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId());
  const first = script.registryV2ItemRecord_(demo.item, {});
  assert.equal(first.title, 'Demo one');
  assert.equal(demo.page.state.blobReads, 1);
  assert.equal(demo.provenance.state.blobReads, 1);
  const source = sourceRecord(demo.page.getId(), first.file_check, first.date_added);
  assert.equal(commitFingerprint(script, cold, demo.item, source), true);
  assert.ok(Object.keys(cold.properties.getProperties()).some(key =>
    key.includes('v2-sheet-12345') && key.includes(demo.root.getId())
      && key.includes(demo.page.getId())),
  'the per-file property key must be namespaced by sheet, root and page');

  const secondItem = demoItem(demo).item;
  const warm = script.registryV2PrepareIngestCache_(
    [secondItem], 'v2-sheet-12345', demo.root.getId());
  const second = script.registryV2ExistingItemRecord_(secondItem, source, {});
  assert.equal(second.file_check, first.file_check);
  assert.equal(second.date_added, first.date_added);
  assert.equal(demo.page.state.blobReads, 1, 'the unchanged HTML must not be downloaded again');
  assert.equal(demo.provenance.state.blobReads, 1,
    'the unchanged PROVENANCE card must not be downloaded again');
  assert.equal(script.registryV2IngestCacheStats_([secondItem]).hits, 1);
  assert.equal(commitFingerprint(script, warm, secondItem, source), true);
});

test('Script Property read, set, or delete failures only make the cache cold', async t => {
  await t.test('read failure', () => {
    const script = loadAppsScript();
    script.PropertiesService = { getScriptProperties: () => ({
      getProperties: () => { throw new Error('properties unavailable'); },
    }) };
    const demo = demoItem();
    const cache = script.registryV2PrepareIngestCache_(
      [demo.item], 'v2-sheet-12345', demo.root.getId());
    assert.equal(cache.enabled, false);
    script.registryV2ExistingItemRecord_(demo.item,
      sourceRecord(demo.page.getId()), {});
    assert.equal(demo.page.state.blobReads, 1);
    assert.ok(demo.item.registryIngestContract,
      'property failure must not disable the final Drive contract check');
    demo.page.state.modified += 1;
    assert.throws(() => script.registryV2VerifyItemContracts_([demo.item]),
      /changed during Drive scan/);
  });

  await t.test('set failure', () => {
    const script = loadAppsScript();
    propertyStore(script);
    const demo = demoItem();
    const cache = script.registryV2PrepareIngestCache_(
      [demo.item], 'v2-sheet-12345', demo.root.getId());
    const record = script.registryV2ItemRecord_(demo.item, {});
    cache.properties.setProperties = () => { throw new Error('quota'); };
    assert.doesNotThrow(() => {
      assert.equal(commitFingerprint(script, cache, demo.item,
        sourceRecord(demo.page.getId(), record.file_check, record.date_added)), false);
    });
  });

  await t.test('delete failure', () => {
    const script = loadAppsScript();
    propertyStore(script);
    const demo = demoItem();
    let cache = script.registryV2PrepareIngestCache_(
      [demo.item], 'v2-sheet-12345', demo.root.getId());
    const record = script.registryV2ItemRecord_(demo.item, {});
    commitFingerprint(script, cache, demo.item,
      sourceRecord(demo.page.getId(), record.file_check, record.date_added));
    cache = script.registryV2PrepareIngestCache_(
      [], 'v2-sheet-12345', demo.root.getId());
    cache.properties.deleteProperty = () => { throw new Error('quota'); };
    assert.doesNotThrow(() => {
      assert.equal(script.registryV2WriteIngestCache_(
        cache, [], verifiedRegistryState(script, [])), true);
    });
  });
});

test('cache corruption, version/namespace mismatch, and cleanup remain fail-closed', () => {
  const script = loadAppsScript();
  const values = propertyStore(script);
  values.AI4S_REGISTRY_ACCESS_TOKEN = 'must-survive';
  values.AI4S_PREVIEW_PUBLISH_STATE_V2 = 'must-survive';
  const demo = demoItem();
  let cache = script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId());
  const record = script.registryV2ItemRecord_(demo.item, {});
  const source = sourceRecord(demo.page.getId(), record.file_check, record.date_added);
  commitFingerprint(script, cache, demo.item, source);
  const key = Object.keys(values).find(name =>
    name.startsWith(script.REGISTRY_V2_INGEST_CACHE_PREFIX));
  values[key] = JSON.stringify({ schema: 99, input_fp: 'bad', output_fp: 'bad' });

  let item = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([item], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(item, source, {});
  assert.equal(demo.page.state.blobReads, 2, 'a corrupt or wrong-version value is a cold miss');

  cache = script.registryV2PrepareIngestCache_([], 'other-sheet-67890', demo.root.getId());
  script.registryV2WriteIngestCache_(cache, [], verifiedRegistryState(script, []));
  assert.equal(values.AI4S_REGISTRY_ACCESS_TOKEN, 'must-survive');
  assert.equal(values.AI4S_PREVIEW_PUBLISH_STATE_V2, 'must-survive');
  assert.ok(Object.prototype.hasOwnProperty.call(values, key),
    'cleanup in another sheet namespace cannot delete this cache key');

  cache = script.registryV2PrepareIngestCache_([], 'v2-sheet-12345', demo.root.getId());
  script.registryV2WriteIngestCache_(cache, [], verifiedRegistryState(script, []));
  assert.equal(values.AI4S_REGISTRY_ACCESS_TOKEN, 'must-survive');
  assert.equal(values.AI4S_PREVIEW_PUBLISH_STATE_V2, 'must-survive');
  assert.equal(Object.prototype.hasOwnProperty.call(values, key), false,
    'same-namespace eviction removes only its fingerprint');
});

test('a changed or unhealthy machine output cannot reuse an otherwise matching input hash', () => {
  const script = loadAppsScript();
  propertyStore(script);
  const demo = demoItem();
  const cold = script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId());
  const first = script.registryV2ItemRecord_(demo.item, {});
  const source = sourceRecord(demo.page.getId(), first.file_check, first.date_added);
  commitFingerprint(script, cold, demo.item, source);

  let item = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([item], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(item,
    { ...source, file_check: 'ok — machine cell changed' }, {});
  assert.equal(demo.page.state.blobReads, 2,
    'the output hash must bind a hit to the current _Registry value');

  item = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([item], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(item,
    { ...source, file_check: 'ok — page unreadable' }, {});
  assert.equal(demo.page.state.blobReads, 3,
    'unreadable output is never cacheable even when its input metadata is unchanged');
});

test('HTML, PROVENANCE, image, identity and parent metadata invalidate or fail the fast path', () => {
  const script = loadAppsScript();
  propertyStore(script);
  const demo = demoItem();
  let cache = script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId());
  const first = script.registryV2ItemRecord_(demo.item, {});
  const source = sourceRecord(demo.page.getId(), first.file_check, first.date_added);
  commitFingerprint(script, cache, demo.item, source);

  demo.page.state.modified += 1;
  let changed = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([changed], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(changed, source, {});
  assert.equal(demo.page.state.blobReads, 2, 'an HTML modification must be parsed');
  assert.equal(demo.provenance.state.blobReads, 2);

  cache = script.registryV2PrepareIngestCache_(
    [changed], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(changed, source, {});
  commitFingerprint(script, cache, changed, source);
  demo.provenance.state.modified += 1;
  changed = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([changed], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(changed, source, {});
  assert.equal(demo.page.state.blobReads, 3, 'a PROVENANCE modification must re-parse the pair');

  cache = script.registryV2PrepareIngestCache_(
    [changed], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(changed, source, {});
  commitFingerprint(script, cache, changed, source);
  demo.image.state.modified += 1;
  changed = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([changed], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(changed, source, {});
  assert.equal(demo.page.state.blobReads, 4, 'a card metadata change must invalidate the item');

  const verified = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([verified], 'v2-sheet-12345', demo.root.getId());
  demo.page.state.parents = [demo.root];
  assert.throws(() => script.registryV2VerifyItemContracts_([verified]),
    /moved outside its collected folder|changed during Drive scan/);
});

test('a provenance change after multi-page selection is rejected and stale selector content is never imported', () => {
  const script = loadAppsScript();
  propertyStore(script);
  const demo = demoItem();
  demo.item.selectionProvenanceContract = script.registryV2SyncFileContract_(
    demo.provenance, demo.folder.getId(), 'selector');
  demo.item.card = { story: { headline: 'stale selection-only content' } };
  demo.provenance.state.text = '---\nstory:\n  headline: Fresh provenance content\n---\n';
  demo.provenance.state.modified += 1;

  assert.throws(() => script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId()),
  /changed after selecting the primary HTML page/);

  delete demo.item.selectionProvenanceContract;
  const read = script.readDemo_(demo.item);
  assert.equal(read.card.story.headline, 'Fresh provenance content');
  assert.notEqual(read.card.story.headline, demo.item.card.story.headline);
});

test('missing entries are evicted so a recovered or replacement HTML is parsed again', () => {
  const script = loadAppsScript();
  const values = propertyStore(script);
  const demo = demoItem();
  let cache = script.registryV2PrepareIngestCache_(
    [demo.item], 'v2-sheet-12345', demo.root.getId());
  const first = script.registryV2ItemRecord_(demo.item, {});
  const source = sourceRecord(demo.page.getId(), first.file_check, first.date_added);
  commitFingerprint(script, cache, demo.item, source);
  assert.ok(Object.keys(values).some(key => key.startsWith(script.REGISTRY_V2_INGEST_CACHE_PREFIX)));

  cache = script.registryV2PrepareIngestCache_([], 'v2-sheet-12345', demo.root.getId());
  script.registryV2WriteIngestCache_(cache, [], verifiedRegistryState(script, []));
  assert.equal(Object.keys(values).some(key =>
    key.startsWith(script.REGISTRY_V2_INGEST_CACHE_PREFIX)), false);

  const recovered = demoItem(demo).item;
  script.registryV2PrepareIngestCache_([recovered], 'v2-sheet-12345', demo.root.getId());
  script.registryV2ExistingItemRecord_(recovered,
    sourceRecord(demo.page.getId(), 'missing', first.date_added), {});
  assert.equal(demo.page.state.blobReads, 2);

  const replacementPage = mutableEntry({
    id: 'replacement-page-67890', name: 'demo-one.html', mime: 'text/html',
    parents: [demo.folder], text: '<html><title>Replacement</title></html>',
  });
  const replacement = demoItem({ ...demo, page: replacementPage }).item;
  script.registryV2PrepareIngestCache_([replacement], 'v2-sheet-12345', demo.root.getId());
  const record = script.registryV2ItemRecord_(replacement, {});
  assert.equal(record.file_id, 'replacement-page-67890');
  assert.equal(replacementPage.state.blobReads, 1);
});

test('Preview reconciliation can reuse a post-verified V2 snapshot while automation is off', () => {
  const script = loadAppsScript();
  const wanted = `sha256:${'8'.repeat(64)}`;
  const supplied = { audience: 'preview', registry_revision: wanted, demos: [] };
  script.registryV2Snapshot_ = () => { throw new Error('must not compile the workbook again'); };
  script.readPreviewPublishState_ = () => script.emptyPreviewPublishState_();
  script.writePreviewPublishState_ = state => state;
  script.checkPreviewReceipt_ = () => ({
    ok: false, configured: true, ready: false, status: 404, error: 'not ready',
  });

  const result = script.maintainPreviewPublish_({}, {
    auto_publish_target: 'off', preview_branch: 'develop',
  }, { snapshot: supplied, allowAutoRequest: true, allowAttempt: true, now: 1 });

  assert.equal(result.snapshot, supplied);
  assert.equal(result.state.desired, wanted);
  assert.equal(result.attempted, false);
  assert.equal(result.state.requested, '');
});

test('a new post-sync revision cannot adopt a late callback for the old desired revision', () => {
  const script = loadAppsScript();
  const oldRevision = `sha256:${'7'.repeat(64)}`;
  const newRevision = `sha256:${'8'.repeat(64)}`;
  const prior = script.emptyPreviewPublishState_();
  prior.branch = 'develop';
  prior.desired = oldRevision;
  prior.requested = oldRevision;
  prior.requestId = '11111111-2222-4333-8444-555555555555';
  prior.requestedAt = '2026-08-14T00:00:00.000Z';
  prior.accepted = oldRevision;
  script.readPreviewPublishState_ = () => prior;
  script.writePreviewPublishState_ = state => state;
  script.registryV2Snapshot_ = () => { throw new Error('must use post-sync revision'); };
  script.checkPreviewReceipt_ = (cfg, expected) => {
    assert.equal(expected.revision, newRevision);
    assert.equal(expected.requestId, '', 'the stale request identity must be cleared first');
    return { ok: false, configured: true, ready: false, status: 404, error: 'not ready' };
  };

  const result = script.maintainPreviewPublish_({}, {
    auto_publish_target: 'off', preview_branch: 'develop',
  }, { snapshot: { audience: 'preview', registry_revision: newRevision }, now: 1 });

  assert.equal(result.state.desired, newRevision);
  assert.equal(result.state.requested, '');
  assert.notEqual(result.state.ready, newRevision);
  assert.equal(result.attempted, false);
});

test('an explicit Preview request always compiles live instead of accepting a sync snapshot', () => {
  const script = loadAppsScript();
  const wanted = `sha256:${'9'.repeat(64)}`;
  let liveCompiles = 0;
  script.registryV2Snapshot_ = () => {
    liveCompiles += 1;
    return { audience: 'preview', registry_revision: wanted, demos: [] };
  };
  script.readPreviewPublishState_ = () => script.emptyPreviewPublishState_();
  script.writePreviewPublishState_ = state => state;
  script.previewRequestId_ = () => '11111111-2222-4333-8444-555555555555';
  script.checkPreviewReceipt_ = () => ({
    ok: false, configured: true, ready: false, status: 404, error: 'not ready',
  });
  script.configuredBuildRequest_ = () => ({
    ok: true, target: 'preview', branch: 'develop', hookUrl: 'redacted',
  });
  script.triggerBuildRequest_ = () => ({ ok: true, status: 202 });

  const result = script.maintainPreviewPublish_({}, {
    auto_publish_target: 'off', preview_branch: 'develop',
  }, {
    snapshot: { audience: 'preview', registry_revision: `sha256:${'1'.repeat(64)}` },
    forceRequest: true, allowAttempt: true, now: 1,
  });

  assert.equal(liveCompiles, 1);
  assert.equal(result.attempted, true);
  assert.equal(result.state.requested, wanted);
});

test('a supplied sync snapshot requires an explicit Preview audience', () => {
  const script = loadAppsScript();
  script.registryV2Snapshot_ = () => { throw new Error('must inspect supplied snapshot'); };
  assert.throws(() => script.maintainPreviewPublish_({}, {
    auto_publish_target: 'off', preview_branch: 'develop',
  }, { snapshot: { registry_revision: `sha256:${'1'.repeat(64)}` }, now: 1 }),
  /invalid registry_revision/);
});
