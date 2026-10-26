'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
const PROJECT = 'project-folder-12345';
const PAGE = 'legacy-page-12345';
const html = '<!doctype html><title>Reviewed scientific result</title><p>Original bytes.</p>';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => ({ hasNext: () => values.length > 0, next: () => values.shift() });

function fixture() {
  const entries = {};
  const props = { AI4S_AUTO_PUBLISH_TARGET: 'off', AI4S_PRODUCTION_BRANCH: 'main' };
  function entry(id, name, parent, mime = 'application/vnd.google-apps.folder', text = '') {
    const state = { id, name, parent, mime, text };
    const value = {
      state,
      getId: () => id,
      getName: () => state.name,
      getMimeType: () => state.mime,
      getLastUpdated: () => new Date('2026-09-25T00:00:00Z'),
      getDateCreated: () => new Date('2026-09-01T00:00:00Z'),
      getSize: () => Buffer.byteLength(state.text),
      getBlob: () => ({ getDataAsString: () => state.text }),
      getParents: () => iterator([].concat(state.parent || []).map(id => entries[id])),
      getFiles: () => iterator(Object.values(entries).filter(e =>
        [].concat(e.state.parent || []).includes(id) && e.state.mime !== 'application/vnd.google-apps.folder')),
      getFolders: () => iterator(Object.values(entries).filter(e =>
        [].concat(e.state.parent || []).includes(id) && e.state.mime === 'application/vnd.google-apps.folder')),
    };
    entries[id] = value;
    return value;
  }
  entry(ROOT, 'AISInstrumentationGym');
  entry('other-root-12345', 'Other');
  entry(PROJECT, 'tbb_cluster_explorer', ROOT);
  entry('archive-folder-12345', 'archive', PROJECT);
  entry('date-folder-12345', '2026-09-25', 'archive-folder-12345');
  entry(PAGE, 'tbb_cluster_explorer.html', 'date-folder-12345', 'text/html', html);
  props.AI4S_DATED_ARCHIVES_V1 = JSON.stringify({ [PROJECT]: {
    root_id: ROOT, project_id: PROJECT, archive_id: 'archive-folder-12345',
    date_id: 'date-folder-12345', date: '2026-09-25', page_id: PAGE, file_ids: [PAGE],
  } });
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] ?? null }) },
    DriveApp: {
      getFolderById: id => { if (!entries[id]) throw new Error('Unknown Drive folder'); return entries[id]; },
      getFileById: id => { if (!entries[id]) throw new Error('Unknown Drive file'); return entries[id]; },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algorithm, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google-apps-script/Code.gs'), 'utf8'), ctx);
  ctx.logEvent_ = () => {};
  const config = {
    root_id: ROOT, demo_html_id: 'html-category-12345', archive_id: 'archive-category-12345',
    projects: [{ project_id: PROJECT, legacy_folder_name: 'tbb_cluster_explorer',
      folder_name: '001-tbb', archive_id: 'archive-folder-12345', archive_name: '001-tbb' }],
  };
  function enable() {
    entry(config.demo_html_id, 'demo_html', ROOT);
    entry(config.archive_id, 'archive', ROOT);
    props.AI4S_CATEGORY_LAYOUT_V1 = JSON.stringify(config);
  }
  function move() {
    entries[PROJECT].state.parent = config.demo_html_id;
    entries[PROJECT].state.name = '001-tbb';
    entries['archive-folder-12345'].state.parent = config.archive_id;
    entries['archive-folder-12345'].state.name = '001-tbb';
  }
  function collect() { return ctx.collectDemos_(entries[ROOT]); }
  function contract(item = collect()[0]) {
    item.registryIngestSpreadsheetId = 'registry-sheet-12345';
    return ctx.registryV2IngestContract_(item);
  }
  return { ctx, entries, props, entry, config, enable, move, collect, contract };
}

test('category migration preserves legacy primary page, logical folder, identity and exact HTML bytes', () => {
  const h = fixture();
  // A second HTML makes preservation of the legacy folder/page name significant.
  h.entry('secondary-page-12345', 'workflow.html', 'date-folder-12345', 'text/html', '<title>Workflow</title>');
  const before = h.collect()[0];
  const beforeBytes = before.file.getBlob().getDataAsString();
  h.enable();
  const staged = h.collect()[0];
  h.move();
  const after = h.collect()[0];
  for (const item of [staged, after]) {
    assert.equal(item.folderId, before.folderId);
    assert.equal(item.folderName, before.folderName);
    assert.equal(item.file.getId(), before.file.getId());
    assert.equal(item.sourceFolderId, before.sourceFolderId);
    assert.equal(h.ctx.slugify_(item.folderName), h.ctx.slugify_(before.folderName));
    assert.equal(item.file.getBlob().getDataAsString(), beforeBytes);
  }
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.equal(h.props.AI4S_PRODUCTION_BRANCH, 'main');
});

test('category allowlist does not auto-ingest arbitrary root/category folders or Draft descendants', () => {
  const h = fixture(); h.enable(); h.move();
  for (const parent of [ROOT, h.config.demo_html_id, PROJECT]) {
    const id = 'unknown-' + parent;
    h.entry(id, 'New project', parent);
    h.entry('page-' + id, 'insight.html', id, 'text/html', html);
    assert.equal(h.ctx.registryDriveFile_({ drive_folder_url: ROOT }, 'page-' + id, 'page'), null);
    assert.equal(h.ctx.registryV2DriveInfo_({ drive_folder_url: ROOT }, 'page-' + id, 'page'), null);
  }
  assert.deepEqual(Array.from(h.collect(), item => item.file.getId()), [PAGE]);
});

test('relocated archives retain pinned response file authorization without opening other archived files', () => {
  const h = fixture(); h.enable(); h.move();
  const cfg = { drive_folder_url: ROOT };
  assert.equal(h.ctx.registryDriveFile_(cfg, PAGE, 'page').getId(), PAGE);
  assert.deepEqual(Array.from(h.ctx.registryV2DriveInfo_(cfg, PAGE, 'page').parent_ids), ['date-folder-12345']);
  h.entry('unapproved-file-12345', 'other.html', 'date-folder-12345', 'text/html', html);
  assert.equal(h.ctx.registryDriveFile_(cfg, 'unapproved-file-12345', 'page'), null);
  assert.equal(h.ctx.registryV2DriveInfo_(cfg, 'unapproved-file-12345', 'page'), null);
});

test('mapped direct project pages work during staged archive movement', () => {
  const h = fixture(); h.enable(); h.move();
  h.entries[PAGE].state.parent = PROJECT;
  assert.equal(h.collect()[0].sourceFolderId, PROJECT);
  assert.equal(h.ctx.registryDriveFile_({ drive_folder_url: ROOT }, PAGE, 'page').getId(), PAGE);
  assert.deepEqual(Array.from(h.ctx.registryV2DriveInfo_({ drive_folder_url: ROOT }, PAGE, 'page').parent_ids), [PROJECT]);
});

test('physical reparenting and numbering invalidate fingerprints without changing logical selection', () => {
  const h = fixture(); h.enable();
  const before = h.contract();
  h.move();
  const after = h.contract();
  assert.equal(before.folder.name, after.folder.name);
  assert.equal(before.selected_page_id, after.selected_page_id);
  assert.deepEqual(plain(before.pages), plain(after.pages));
  assert.notEqual(h.ctx.registryV2IngestFingerprint_(before), h.ctx.registryV2IngestFingerprint_(after));
  const staleItem = h.collect()[0];
  staleItem.folderName = '001-tbb';
  assert.throws(() => h.contract(staleItem), /logical name changed/);
});

test('moving only the dated archive container invalidates its physical fingerprint', () => {
  const h = fixture(); h.enable();
  const before = h.contract();
  h.entries['archive-folder-12345'].state.parent = h.config.archive_id;
  h.entries['archive-folder-12345'].state.name = '001-tbb';
  const after = h.contract();
  assert.deepEqual(plain(before.folder), plain(after.folder));
  assert.deepEqual(plain(before.pages), plain(after.pages));
  assert.notEqual(h.ctx.registryV2IngestFingerprint_(before), h.ctx.registryV2IngestFingerprint_(after));
});

test('mapped projects and categories fail closed if moved, renamed, missing or multiply parented', async t => {
  for (const [label, mutate] of [
    ['category outside root', h => { h.entries[h.config.demo_html_id].state.parent = 'other-root-12345'; }],
    ['archive category outside root', h => { h.entries[h.config.archive_id].state.parent = 'other-root-12345'; }],
    ['category renamed', h => { h.entries[h.config.demo_html_id].state.name = 'new name'; }],
    ['ambiguous category', h => { h.entries[h.config.demo_html_id].state.parent = [ROOT, 'other-root-12345']; }],
    ['project outside category', h => { h.entries[PROJECT].state.parent = 'other-root-12345'; }],
    ['project arbitrary rename', h => { h.entries[PROJECT].state.name = 'not approved'; }],
    ['ambiguous project', h => { h.entries[PROJECT].state.parent = [ROOT, h.config.demo_html_id]; }],
    ['project missing', h => { delete h.entries[PROJECT]; }],
  ]) await t.test(label, () => {
    const h = fixture(); h.enable(); h.move(); mutate(h);
    assert.throws(h.collect);
  });
});

test('moved archives, dates, and substituted archive identities fail closed', async t => {
  for (const [label, mutate] of [
    ['archive outside approved category', h => { h.entries['archive-folder-12345'].state.parent = 'other-root-12345'; }],
    ['archive arbitrary rename', h => { h.entries['archive-folder-12345'].state.name = 'unapproved'; }],
    ['archive ambiguous parent', h => { h.entries['archive-folder-12345'].state.parent = [PROJECT, h.config.archive_id]; }],
    ['date moved', h => { h.entries['date-folder-12345'].state.parent = PROJECT; }],
    ['date ambiguous parent', h => { h.entries['date-folder-12345'].state.parent = ['archive-folder-12345', PROJECT]; }],
    ['date renamed', h => { h.entries['date-folder-12345'].state.name = '2026-10-02'; }],
    ['pinned page moved', h => { h.entries[PAGE].state.parent = 'other-root-12345'; }],
    ['archive ID replaced', h => { h.config.projects[0].archive_id = 'other-archive-12345'; h.props.AI4S_CATEGORY_LAYOUT_V1 = JSON.stringify(h.config); }],
  ]) await t.test(label, () => {
    const h = fixture(); h.enable(); h.move(); mutate(h);
    assert.throws(h.collect);
    assert.equal(h.ctx.registryDriveFile_({ drive_folder_url: ROOT }, PAGE, 'page'), null);
  });
});

test('malformed or duplicate category mappings fail before collecting a partial inventory', async t => {
  for (const [label, mutate] of [
    ['root mismatch', c => { c.root_id = 'other-root-12345'; }],
    ['duplicate project', c => { c.projects.push({ ...c.projects[0] }); }],
    ['missing legacy name', c => { delete c.projects[0].legacy_folder_name; }],
    ['missing archive name', c => { delete c.projects[0].archive_name; }],
    ['duplicate category', c => { c.archive_id = c.demo_html_id; }],
  ]) await t.test(label, () => {
    const h = fixture(); h.enable(); mutate(h.config);
    h.props.AI4S_CATEGORY_LAYOUT_V1 = JSON.stringify(h.config);
    assert.throws(h.collect);
  });
});

test('removing the category property after rolling folders back restores the original scan', () => {
  const h = fixture();
  const before = plain(h.contract());
  h.enable(); h.move();
  h.entries[PROJECT].state.parent = ROOT;
  h.entries[PROJECT].state.name = 'tbb_cluster_explorer';
  h.entries['archive-folder-12345'].state.parent = PROJECT;
  h.entries['archive-folder-12345'].state.name = 'archive';
  delete h.props.AI4S_CATEGORY_LAYOUT_V1;
  assert.deepEqual(plain(h.contract()), before);
});

function operationFixture(autoTarget = 'off', syncCount = 1) {
  const h = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google-apps-script/migration/CategoryOperations.gs'), 'utf8'), h.ctx);
  h.props.AI4S_AUTO_PUBLISH_TARGET = autoTarget;
  h.props.AI4S_MIGRATION_BASELINE_FILE = 'original-archive-baseline';
  h.props.AI4S_REGISTRY_ACCESS_TOKEN = 'credential-never-export';
  const writes = [], files = {}, logs = [], triggers = [], sources = [], archives = {};
  for (let i = 0; i < 15; i++) {
    const id = 'project-' + i;
    sources.push({ project_id: id, legacy_folder_name: 'Legacy ' + i,
      source_folder_id: 'date-' + i, page_id: 'page-' + i, page_ids: ['page-' + i], image_ids: [], provenance_id: '' });
    archives[id] = { archive_id: 'archive-' + i, file_ids: ['page-' + i] };
  }
  h.props.AI4S_DATED_ARCHIVES_V1 = JSON.stringify(archives);
  h.ctx.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => h.props[key] ?? null,
    setProperty: (key, value) => { writes.push(key); h.props[key] = value; },
    deleteProperty: key => { writes.push(key); delete h.props[key]; },
  }) };
  function trigger(handler) {
    const t = { getHandlerFunction: () => handler, getEventType: () => 'CLOCK',
      getTriggerSource: () => 'CLOCK', getUniqueId: () => handler + '-' + triggers.length };
    triggers.push(t); return t;
  }
  for (let i = 0; i < syncCount; i++) trigger('syncDrive');
  trigger('unrelatedJob');
  h.ctx.ScriptApp = {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: value => { triggers.splice(triggers.indexOf(value), 1); },
    newTrigger: handler => ({ timeBased: () => ({ everyHours: hours => ({ create: () => {
      assert.equal(hours, 1); return trigger(handler);
    } }) }) }),
  };
  h.ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  h.ctx.console = { log: value => logs.push(value) };
  h.ctx.UrlFetchApp = { fetch: () => assert.fail('Migration must never call a build Hook') };
  h.ctx.Utilities.newBlob = (text, mime, name) => ({ text, mime, name });
  const values = [['Status', 'Readiness', 'Preview URL', 'Project Title', 'demo_id'],
    ['Live', 'Ready', 'https://preview.invalid/', 'Reviewed title', 'demo-original']];
  const formulas = values.map(row => row.map(() => ''));
  const ss = { getId: () => h.ctx.CATEGORY_V2_SHEET_ID, getSheetByName: () => ({
    getLastRow: () => values.length, getLastColumn: () => values[0].length,
    getRange: () => ({ getValues: () => values, getFormulas: () => formulas }),
  }) };
  h.ctx.registryV2Spreadsheet_ = () => ss;
  h.ctx.registryV2OperationalConfig_ = () => ({ drive_folder_url: ROOT, access_token: 'credential-never-export' });
  h.ctx.registryV2Snapshot_ = () => ({ site: { title: 'Science' }, taxonomy: {}, demos: [{ id: 'demo-original' }] });
  h.ctx.categorySourcesV2_ = () => sources;
  h.ctx.categoryHashesV2_ = ids => Object.fromEntries(ids.map(id => [id, { sha256: 'unchanged', size: 100 }]));
  h.entries[ROOT].createFile = blob => {
    const id = 'baseline-' + Object.keys(files).length;
    files[id] = blob;
    h.entry(id, blob.name, ROOT, blob.mime, blob.text);
    return h.entries[id];
  };
  return { ...h, writes, files, logs, triggers, sources, archives, values, formulas,
    state: () => JSON.parse(h.props.AI4S_CATEGORY_MIGRATION_V1) };
}

test('categoryBeginV2 pauses only existing sync automation and exports no credentials or previous baseline changes', () => {
  const h = operationFixture('preview');
  h.ctx.categoryBeginV2();
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.deepEqual(h.triggers.map(t => t.getHandlerFunction()), ['unrelatedJob']);
  assert.equal(h.state().previous_auto_target, 'preview');
  assert.equal(h.state().previous_sync_count, 1);
  assert.equal(h.state().phase, 'baseline-ready');
  assert.equal(Object.keys(h.files).length, 1);
  const text = Object.values(h.files)[0].text;
  assert.doesNotMatch(text, /credential-never-export|access_token|REGISTRY_ACCESS_TOKEN/);
  assert.equal(h.props.AI4S_MIGRATION_BASELINE_FILE, 'original-archive-baseline');
  assert.ok(h.writes.every(key => key === 'AI4S_CATEGORY_MIGRATION_V1' || key === 'AI4S_AUTO_PUBLISH_TARGET'));
  h.ctx.categoryBeginV2();
  assert.equal(Object.keys(h.files).length, 1, 'rerun must not overwrite or duplicate a recorded baseline');
});

test('category begin exports every human column/formula while excluding only two derived result columns', () => {
  const h = operationFixture();
  h.formulas[1][3] = '=CONCAT("Reviewed ","title")';
  h.ctx.categoryBeginV2();
  const baseline = JSON.parse(Object.values(h.files)[0].text);
  assert.deepEqual(baseline.human[1], [['Live', ''], null, null,
    ['Reviewed title', '=CONCAT("Reviewed ","title")'], ['demo-original', '']]);
});

test('a failed baseline read leaves automation paused and retry preserves the original automation record', () => {
  const h = operationFixture('preview');
  const getHashes = h.ctx.categoryHashesV2_;
  h.ctx.categoryHashesV2_ = () => { throw new Error('Drive read interrupted'); };
  assert.throws(() => h.ctx.categoryBeginV2(), /Drive read interrupted/);
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.equal(h.state().previous_auto_target, 'preview');
  h.ctx.categoryHashesV2_ = getHashes;
  h.ctx.categoryBeginV2();
  assert.equal(h.state().previous_sync_count, 1);
  assert.equal(h.state().previous_auto_target, 'preview');
});

test('resume requires verification and restores only previously existing non-production automation', async t => {
  for (const [target, count, expected] of [['preview', 1, 'preview'], ['production', 1, 'off'], ['off', 0, 'off']]) {
    await t.test(target + '/' + count, () => {
      const h = operationFixture(target, count);
      h.ctx.categoryBeginV2();
      assert.throws(() => h.ctx.categoryResumeV2(), /categoryVerifyV2/);
      const state = h.state(); state.phase = 'verified'; state.verified_at = '2026-10-02T00:00:00Z';
      h.props.AI4S_CATEGORY_MIGRATION_V1 = JSON.stringify(state);
      let checks = 0;
      h.ctx.categoryCheckV2_ = () => { checks++; };
      h.ctx.categoryResumeV2();
      assert.equal(checks, 1);
      assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, expected);
      assert.equal(h.triggers.filter(t => t.getHandlerFunction() === 'syncDrive').length, count);
      assert.equal(h.triggers.filter(t => t.getHandlerFunction() === 'unrelatedJob').length, 1);
      h.ctx.categoryResumeV2();
      assert.equal(h.triggers.filter(t => t.getHandlerFunction() === 'syncDrive').length, count);
      assert.equal(h.props.AI4S_MIGRATION_BASELINE_FILE, 'original-archive-baseline');
    });
  }
});

test('verification failure never marks the category migration verified or restores triggers', () => {
  const h = operationFixture('preview'); h.ctx.categoryBeginV2();
  const state = h.state(); state.phase = 'verified'; state.verified_at = 'earlier-verification';
  h.props.AI4S_CATEGORY_MIGRATION_V1 = JSON.stringify(state);
  h.ctx.categoryCheckV2_ = () => { throw new Error('Source bytes changed'); };
  assert.throws(() => h.ctx.categoryVerifyV2(), /Source bytes changed/);
  assert.notEqual(h.state().phase, 'verified');
  assert.equal(h.state().verified_at, undefined);
  assert.throws(() => h.ctx.categoryResumeV2(), /categoryVerifyV2/);
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.equal(h.triggers.filter(t => t.getHandlerFunction() === 'syncDrive').length, 0);
});

test('baseline tampering is detected before install or verification can proceed', () => {
  const h = operationFixture(); h.ctx.categoryBeginV2();
  h.entries[h.state().baseline_file_id].state.text += ' ';
  assert.throws(() => h.ctx.categoryInstallV2(), /baseline file was changed/);
  assert.throws(() => h.ctx.categoryBaselineV2_(h.state()), /baseline file was changed/);
});

test('raw files receive byte hashes while native archived Docs receive explicit metadata contracts without export', () => {
  const h = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google-apps-script/migration/CategoryOperations.gs'), 'utf8'), h.ctx);
  const native = h.entry('native-doc-12345', 'satellite_image_quantization', 'date-folder-12345',
    'application/vnd.google-apps.document');
  native.getSize = () => 8225;
  native.getBlob = () => assert.fail('Native Google Docs must not be downloaded or silently converted');
  h.entries[PAGE].getBlob = () => ({ getBytes: () => Array.from(Buffer.from(html)) });
  h.ctx.Utilities.computeDigest = (algorithm, bytes) => Array.from(crypto.createHash('sha256').update(Buffer.from(bytes)).digest());
  const hashes = plain(h.ctx.categoryHashesV2_([PAGE, native.getId()]));
  assert.deepEqual(hashes[native.getId()], { kind: 'native-metadata', id: native.getId(),
    name: 'satellite_image_quantization', mime: 'application/vnd.google-apps.document',
    modified_at: '2026-09-25T00:00:00.000Z', size: 8225 });
  assert.equal(hashes[PAGE].kind, 'sha256');
  assert.equal(hashes[PAGE].sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.equal(hashes[native.getId()].sha256, undefined);
  native.getLastUpdated = () => new Date('2026-10-02T00:00:00Z');
  assert.notDeepEqual(plain(h.ctx.categoryHashesV2_([native.getId()])), { [native.getId()]: hashes[native.getId()] });
});
