'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
const CONFIG = 'flat-config-file-000000001';

function fixture() {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const input = { metadata: ['preserve original fields'], pages: ['original source link'] };
  const oldMap = { root_id: ROOT, mounts: [{ id: 'develop', project_id: 'project', logical_path: 'projects/example' }] };
  const properties = new Map([
    ['AIS_PROJECT_MOUNTS_V1', JSON.stringify(oldMap)], ['AI4S_AUTO_PUBLISH_TARGET', 'preview'],
    ['SANDBOX_SNAPSHOT_FILE', 'snapshot-file-00000000000001'],
    ['AI4S_REGISTRY_ACCESS_TOKEN', 'DO-NOT-EXPORT-TOKEN'],
    ['AI4S_NETLIFY_PREVIEW_BUILD_HOOK', 'DO-NOT-EXPORT-HOOK'],
  ]);
  const descriptor = { id: 'page-example-insight', file_id: 'html-source-000000000000001',
    parent_path: 'projects/example/example-draft-v1', sha256: 'a'.repeat(64), size: 1234,
    mime_type: 'text/html', modified_at: '2026-10-02T01:00:00.000Z' };
  const snapshot = { manifest: { registry_revision: 'sha256:' + 'b'.repeat(64), demos: [{ demo_id: 'demo-example' }] },
    files: [descriptor, { ...descriptor, id: 'shared-resource-reference' }], input_hash: hash(JSON.stringify(input)) };
  const actual = copy(descriptor), records = new Map(), logs = [], reads = [], writes = [];
  const env = { triggerCount: 1, failSave: false, input, snapshot, actual, next: 1 };
  const context = vm.createContext({
    console: { log: message => logs.push(message) },
    SANDBOX: { spreadsheet_id: 'develop-sheet-0000000000001', drive_root_id: 'backend-root-00000000000001' },
    V3: { stable: JSON.stringify }, hash_: hash,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.has(key) ? properties.get(key) : null,
      setProperty: (key, value) => { writes.push(key); properties.set(key, value); },
      deleteProperty: key => { writes.push(key); properties.delete(key); },
    }) },
    ScriptApp: { newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => { env.triggerCount++; } }) }) }), getProjectTriggers: () => Array.from({ length: env.triggerCount }, () => ({ getHandlerFunction: () => 'hourlySandbox' })) },
    DriveApp: { getFolderById: id => ({ id }) },
    Utilities: { newBlob: (data, mime, name) => ({ data, mime, name, getBytes: () => [...Buffer.from(data)] }),
      base64Decode: data => [...Buffer.from(data, 'base64')] },
    folder_: () => ({ createFile: blob => {
      if (env.failSave) throw new Error('Evidence save failed');
      const id = 'evidence-file-' + String(env.next++).padStart(20, '0');
      records.set(id, { json: JSON.parse(blob.data), mime: blob.mime, parent: 'imports', name: blob.name });
      return { getId: () => id };
    } }),
    sourceFile_: id => {
      const record = records.get(id);
      if (!record) throw new Error('Missing fixture file');
      return { record, getMimeType: () => record.mime,
        getBlob: () => ({ getDataAsString: () => JSON.stringify(record.json) }) };
    },
    sourceParentPath_: file => file.record.parent,
    sandboxGuard_: () => ({ getId: () => 'develop-sheet-0000000000001' }),
    checkedSnapshot_: (revision, all) => { env.checkedAll = all; return copy(env.snapshot); }, currentSnapshot_: () => copy(env.snapshot),
    readInput_: () => copy(env.input), locked_: fn => fn(),
    previewState_: () => ({ phase: 'ready', revision: env.snapshot.manifest.registry_revision,
      deploy_id: 'approved-deploy', hook: 'DO-NOT-EXPORT-STATE-HOOK', secret: 'DO-NOT-EXPORT-STATE-SECRET' }),
    source_: (id, previous) => {
      reads.push({ id, previous });
      if (env.failOnFileId === id) throw new Error('Interrupted source read');
      return copy(env.actuals ? env.actuals.get(id) : env.actual);
    },
    assertStamp_: expected => {
      env.stampReads = (env.stampReads || 0) + 1;
      const actual = env.actuals ? env.actuals.get(expected.file_id) : env.actual;
      if (expected.modified_at !== actual.modified_at) throw new Error('Source changed');
    },
    disableSandboxAutomation: () => { env.triggerCount = 0; properties.set('AI4S_AUTO_PUBLISH_TARGET', 'off'); },
    publishPreview: () => { throw new Error('Build is forbidden'); },
    syncSandbox: () => { throw new Error('Sheet mutation is forbidden'); },
  });
  vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'), context);
  vm.runInContext(read('google-apps-script/migration/FlatLayoutOperations.gs'), context);
  vm.runInContext(read('google-apps-script/migration/FlatLayoutVerification.gs'), context);
  vm.runInContext(read('google-apps-script/migration/FlatLayoutRuntimeCheck.gs'), context);
  context.FLAT_V3_CONFIG_FILE_ID = CONFIG;
  const mountConfig = { schema: 3, root_id: ROOT, mounts: [{ id: 'version',
    ancestor_chain: ['project', 'demo-html', ROOT], bindings: [{logical_path: descriptor.parent_path, file_ids: [descriptor.file_id]}] }] };
  function prepare() {
    const baselineId = context.flatBeginV3();
    records.set(CONFIG, { parent: 'imports', mime: 'application/json', json: { schema: 1,
      migration_id: 'drive-flat-layout-20261002', root_id: ROOT,
      develop_sheet_id: context.SANDBOX.spreadsheet_id, backend_root_id: context.SANDBOX.drive_root_id,
      baseline_file_id: baselineId, mount_config: mountConfig } });
    properties.set('AI4S_AUTO_PUBLISH_TARGET', 'off'); env.triggerCount = 0;
    return baselineId;
  }
  return { context, env, properties, records, logs, reads, writes, oldMap, mountConfig, prepare };
}

test('flat begin pauses existing preview and exports an idempotent metadata-only baseline without credentials', () => {
  const h = fixture(), id = h.context.flatBeginV3(), baseline = h.records.get(id).json;
  assert.equal(h.env.checkedAll, false); assert.equal(h.reads.length, 0);
  assert.equal(h.env.triggerCount, 0); assert.equal(h.properties.get('AI4S_AUTO_PUBLISH_TARGET'), 'off');
  assert.deepEqual(baseline.automation, { auto_publish_target: 'preview', hourly_trigger_count: 1 });
  assert.deepEqual(baseline.snapshot, h.env.snapshot); assert.deepEqual(baseline.mount_config, h.oldMap);
  assert.equal(JSON.stringify(baseline).includes('DO-NOT-EXPORT'), false);
  assert.equal(h.context.flatBeginV3(), id); assert.equal(h.records.size, 1);
  assert.equal(JSON.parse(h.properties.get('AIS_FLAT_V3_ORIGINAL_AUTOMATION')).hourly_trigger_count, 1);
});

test('a failed flat baseline export remains paused and retry retains the original preview schedule', () => {
  const h = fixture(); h.env.failSave = true;
  assert.throws(() => h.context.flatBeginV3(), /Evidence save failed/);
  assert.equal(h.env.triggerCount, 0); assert.equal(h.properties.get('AI4S_AUTO_PUBLISH_TARGET'), 'off');
  h.env.failSave = false;
  const id = h.context.flatBeginV3();
  assert.equal(h.records.get(id).json.automation.hourly_trigger_count, 1);
});

function batchFixture(count = 13) {
  const h = fixture(), original = h.env.snapshot.files[0];
  h.env.snapshot.files = Array.from({ length: count }, (_, index) => ({ ...original,
    id: 'page-' + index, file_id: 'source-file-' + String(index).padStart(20, '0'), size: 1234 + index }));
  h.env.actuals = new Map(h.env.snapshot.files.map(file => [file.file_id, copy(file)]));
  h.prepare();
  return h;
}

test('bounded V3 verification resumes an installed map, hashes at most twelve files and finalizes exact coverage', () => {
  const h = batchFixture();
  h.properties.set('AIS_PROJECT_MOUNTS_V1', JSON.stringify(h.mountConfig));
  assert.equal(h.context.flatBeginV3Verification().verified, 0);
  assert.equal(h.reads.length, 0);
  assert.equal(h.context.flatVerifyV3Chunk().verified, 12);
  assert.equal(h.reads.length, 12);
  assert.throws(() => h.context.flatFinalizeV3Verification(), /every source chunk/);
  assert.equal(h.context.flatBeginV3Verification().verified, 12);
  assert.equal(h.context.flatVerifyV3Chunk().verified, 13);
  assert.equal(h.reads.length, 13);
  const reportId = h.context.flatFinalizeV3Verification(), report = h.records.get(reportId).json;
  assert.equal(report.binding_count, 13); assert.equal(report.unique_file_count, 13);
  assert.equal(report.chunk_reports.length, 2); assert.equal(h.reads.length, 13);
  assert.equal(h.env.stampReads, 13);
  assert.equal(h.context.flatFinalizeV3Verification(), reportId);
  assert.equal(h.context.flatVerifyV3Chunk().phase, 'complete');
  assert.equal(h.reads.length, 13);
  const progress = JSON.parse(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'));
  assert.equal(progress.phase, 'complete'); assert.equal(progress.report_file_id, reportId);
});

test('bounded V3 chunks retain the cursor after partial read or evidence-save failure and retry only that chunk', () => {
  for (const failure of ['read', 'save']) {
    const h = batchFixture(25); h.context.flatBeginV3Verification(); h.context.flatVerifyV3Chunk();
    if (failure === 'read') h.env.failOnFileId = h.env.snapshot.files[16].file_id;
    else h.env.failSave = true;
    assert.throws(() => h.context.flatVerifyV3Chunk(), /Interrupted source read|Evidence save failed/);
    let progress = JSON.parse(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'));
    assert.equal(progress.next_index, 12); assert.equal(progress.chunks.length, 1);
    h.env.failOnFileId = null; h.env.failSave = false;
    const previousReads = h.reads.length;
    assert.equal(h.context.flatVerifyV3Chunk().verified, 24);
    assert.equal(h.reads.length - previousReads, 12);
    assert.equal(h.context.flatVerifyV3Chunk().verified, 25);
    progress = JSON.parse(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'));
    assert.equal(progress.chunks.length, 3);
    assert.equal(h.records.get(h.context.flatFinalizeV3Verification()).json.binding_count, 25);
  }
});

test('bounded V3 verification fails closed when snapshot, input, config or baseline changes between chunks', () => {
  const cases = [
    h => { h.env.input.pages.push('changed'); },
    h => { h.env.snapshot.files[0].size += 1; },
    h => { h.records.get(CONFIG).json.unreviewed_change = true; },
    h => { const id = h.properties.get('AIS_FLAT_V3_BASELINE_FILE'); h.records.get(id).json.exported_at = 'changed'; },
    h => { h.properties.set('AIS_PROJECT_MOUNTS_V1', JSON.stringify(h.oldMap)); },
  ];
  for (const change of cases) {
    const h = batchFixture(); h.context.flatBeginV3Verification(); h.context.flatVerifyV3Chunk();
    const progress = h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'), reads = h.reads.length;
    change(h); assert.throws(() => h.context.flatVerifyV3Chunk());
    assert.equal(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'), progress); assert.equal(h.reads.length, reads);
  }
});

test('bounded V3 finalizer rejects tampered chunk proof and source changes after hashing', () => {
  for (const change of ['proof', 'stamp', 'coverage']) {
    const h = batchFixture(1); h.context.flatBeginV3Verification(); h.context.flatVerifyV3Chunk();
    const progress = JSON.parse(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS'));
    if (change === 'proof') h.records.get(progress.chunks[0].file_id).json.files[0].sha256 = 'd'.repeat(64);
    if (change === 'stamp') h.env.actuals.get(h.env.snapshot.files[0].file_id).modified_at = '2026-10-03T01:00:00.000Z';
    if (change === 'coverage') { progress.chunks = []; h.properties.set('AIS_FLAT_V3_VERIFY_PROGRESS', JSON.stringify(progress)); }
    assert.throws(() => h.context.flatFinalizeV3Verification(), /proof changed|Source changed|Incomplete/);
    assert.equal(JSON.parse(h.properties.get('AIS_FLAT_V3_VERIFY_PROGRESS')).phase, 'hashing');
  }
});

function runtimeFixture() {
  const h = fixture(), text = '<html><head></head><body>unchanged</body></html>', descriptor = h.env.snapshot.files[0];
  h.env.snapshot.manifest.registry_instance = 'sandbox';
  h.env.snapshot.files = ['page-battery-curve-shape-explorer-dataset', 'card-battery-curve-shape-explorer', 'res-tbb-cluster-explorer-2-0']
    .map((id, index) => ({ ...descriptor, id, file_id: 'source-file-' + String(index).padStart(20, '0'), kind: index ? 'resource' : 'page', size: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') }));
  h.env.actuals = new Map(h.env.snapshot.files.map(file => [file.file_id, copy(file)]));
  h.context.hash_ = value => crypto.createHash('sha256').update(Array.isArray(value) ? Buffer.from(value) : value).digest('hex');
  h.prepare(); h.context.flatBeginV3Verification(); h.context.flatVerifyV3Chunk(); h.context.flatFinalizeV3Verification();
  h.context.syncSandbox = () => copy(h.env.snapshot.manifest);
  h.context.doGet = event => {
    assert.equal(event.parameter.token, 'DO-NOT-EXPORT-TOKEN');
    const response = event.parameter.action === 'manifest' ? { ok: true, ...copy(h.env.snapshot.manifest) }
      : { ok: true, id: event.parameter.id, registry_instance: 'sandbox', registry_revision: h.env.snapshot.manifest.registry_revision,
        ...(event.parameter.action === 'page' ? { html: text } : { base64: Buffer.from(text).toString('base64') }) };
    return { getContent: () => JSON.stringify(response) };
  };
  return h;
}
test('flat runtime evidence gates preview-only restoration and repeated resume adds no trigger', () => {
  const h = runtimeFixture();
  assert.throws(() => h.context.flatResumeV3(), /Complete all flat runtime checks/);
  h.context.flatV3RuntimeCheck(); h.context.flatV3RuntimeManifestCheck();
  assert.throws(() => h.context.flatResumeV3(), /Missing flat runtime check: samples/);
  h.context.flatV3RuntimeSamplesCheck();
  const record = h.context.flatResumeV3();
  assert.equal(record.automation.auto_publish_target, 'preview'); assert.equal(h.env.triggerCount, 1);
  assert.equal(h.context.flatResumeV3().context_hash, record.context_hash); assert.equal(h.env.triggerCount, 1);
  assert.equal(JSON.stringify(h.logs).includes('DO-NOT-EXPORT'), false);
  assert.equal(JSON.stringify([...h.records.values()]).includes('DO-NOT-EXPORT'), false);
});
test('flat restoration fails closed on tampered runtime proof and preserves a previously disabled schedule', () => {
  const tampered = runtimeFixture(); tampered.context.flatV3RuntimeCheck(); tampered.context.flatV3RuntimeManifestCheck(); tampered.context.flatV3RuntimeSamplesCheck();
  const saved = JSON.parse(tampered.properties.get('AIS_FLAT_V3_RUNTIME_CHECKS'));
  tampered.records.get(saved.checks.manifest.file_id).json.result = 'FAILED';
  assert.throws(() => tampered.context.flatResumeV3(), /report changed/); assert.equal(tampered.env.triggerCount, 0);
  const h = fixture(); h.env.triggerCount = 0; h.properties.set('AI4S_AUTO_PUBLISH_TARGET', 'off'); h.prepare();
  assert.equal(h.records.get(h.properties.get('AIS_FLAT_V3_BASELINE_FILE')).json.automation.hourly_trigger_count, 0);
});
