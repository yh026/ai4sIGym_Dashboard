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
const CONFIG = 'category-config-file-000000001';

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
    ScriptApp: { getProjectTriggers: () => Array.from({ length: env.triggerCount }, () => ({ getHandlerFunction: () => 'hourlySandbox' })) },
    DriveApp: { getFolderById: id => ({ id }) },
    Utilities: { newBlob: (data, mime, name) => ({ data, mime, name }) },
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
    checkedSnapshot_: () => copy(env.snapshot), currentSnapshot_: () => copy(env.snapshot),
    readInput_: () => copy(env.input), locked_: fn => fn(),
    previewState_: () => ({ phase: 'ready', revision: env.snapshot.manifest.registry_revision,
      deploy_id: 'approved-deploy', hook: 'DO-NOT-EXPORT-STATE-HOOK', secret: 'DO-NOT-EXPORT-STATE-SECRET' }),
    source_: (id, previous) => { reads.push({ id, previous }); return copy(env.actual); },
    assertStamp_: expected => { if (expected.modified_at !== env.actual.modified_at) throw new Error('Source changed'); },
    publishPreview: () => { throw new Error('Build is forbidden'); },
    syncSandbox: () => { throw new Error('Sheet mutation is forbidden'); },
  });
  vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'), context);
  vm.runInContext(read('google-apps-script/migration/CategoryDevelopOperations.gs'), context);
  context.CATEGORY_V3_CONFIG_FILE_ID = CONFIG;
  const mountConfig = { schema: 2, root_id: ROOT, mounts: [{ id: 'version',
    ancestor_chain: ['project', 'demo-html', ROOT], logical_path: descriptor.parent_path }] };
  function prepare() {
    const baselineId = context.categoryExportV3();
    records.set(CONFIG, { parent: 'imports', mime: 'application/json', json: { schema: 1,
      migration_id: 'drive-category-20261002', root_id: ROOT,
      develop_sheet_id: context.SANDBOX.spreadsheet_id, backend_root_id: context.SANDBOX.drive_root_id,
      baseline_file_id: baselineId, mount_config: mountConfig } });
    properties.set('AI4S_AUTO_PUBLISH_TARGET', 'off'); env.triggerCount = 0;
    return baselineId;
  }
  return { context, env, properties, records, logs, reads, writes, oldMap, mountConfig, prepare };
}

test('V3 export saves full snapshot and nonsecret state, is idempotent and leaves automation alone', () => {
  const h = fixture(), id = h.context.categoryExportV3();
  const baseline = h.records.get(id).json;
  assert.deepEqual(baseline.snapshot, h.env.snapshot);
  assert.deepEqual(baseline.mount_config, h.oldMap);
  assert.equal(baseline.automation.auto_publish_target, 'preview');
  assert.equal(baseline.automation.hourly_trigger_count, 1);
  assert.equal(JSON.stringify(baseline).includes('DO-NOT-EXPORT'), false);
  assert.equal(h.context.categoryExportV3(), id);
  assert.equal(h.records.size, 1);
  assert.deepEqual(h.logs, ['Baseline file: ' + id, 'Baseline file: ' + id]);
  assert.deepEqual(h.writes, ['AIS_CATEGORY_V3_BASELINE_FILE']);
  assert.equal(h.properties.get('AI4S_AUTO_PUBLISH_TARGET'), 'preview');
});

test('V3 installer freshly hashes each unique source and preserves snapshot, Sheet, state and source bindings', () => {
  const h = fixture(); h.prepare();
  const before = JSON.stringify(h.env.snapshot), pointer = h.properties.get('SANDBOX_SNAPSHOT_FILE');
  const reportId = h.context.categoryInstallV3(), report = h.records.get(reportId).json;
  assert.deepEqual(JSON.parse(h.properties.get('AIS_PROJECT_MOUNTS_V1')), h.mountConfig);
  assert.equal(report.result, 'PASS'); assert.equal(report.binding_count, 2); assert.equal(report.unique_file_count, 1);
  assert.equal(h.reads.length, 1); assert.equal(h.reads[0].previous, undefined);
  assert.equal(JSON.stringify(h.env.snapshot), before); assert.equal(h.properties.get('SANDBOX_SNAPSHOT_FILE'), pointer);
  assert.deepEqual(h.writes, ['AIS_CATEGORY_V3_BASELINE_FILE', 'AIS_PROJECT_MOUNTS_V1']);
  const second = h.context.categoryVerifyV3();
  assert.equal(h.records.get(second).json.result, 'PASS'); assert.equal(h.reads.length, 2);
  assert.deepEqual(h.writes, ['AIS_CATEGORY_V3_BASELINE_FILE', 'AIS_PROJECT_MOUNTS_V1']);
});

test('V3 installer rolls mapping back when bytes, parent, timestamps or evidence saving differ', () => {
  for (const change of ['sha256', 'parent_path', 'modified_at', 'size', 'mime_type', 'save']) {
    const h = fixture(); h.prepare(); const previous = h.properties.get('AIS_PROJECT_MOUNTS_V1');
    if (change === 'save') h.env.failSave = true;
    else h.env.actual[change] = change === 'size' ? 999 : 'unexpected';
    assert.throws(() => h.context.categoryInstallV3(), /changed|save failed/);
    assert.equal(h.properties.get('AIS_PROJECT_MOUNTS_V1'), previous, change);
  }
});

test('V3 installer requires paused automation and an unchanged baseline and configuration identity', () => {
  const cases = [
    h => { h.env.triggerCount = 1; },
    h => { h.properties.set('AI4S_AUTO_PUBLISH_TARGET', 'preview'); },
    h => { h.env.input.pages.push('unreviewed change'); },
    h => { h.env.snapshot.files[0].sha256 = 'c'.repeat(64); },
    h => { h.records.get(CONFIG).json.backend_root_id = 'wrong-root'; },
    h => { h.records.get(CONFIG).json.baseline_file_id = 'wrong-baseline-file-000001'; },
    h => { h.records.get(CONFIG).parent = 'outside'; },
  ];
  for (const change of cases) {
    const h = fixture(); h.prepare(); const before = h.properties.get('AIS_PROJECT_MOUNTS_V1');
    change(h); assert.throws(() => h.context.categoryInstallV3());
    assert.equal(h.properties.get('AIS_PROJECT_MOUNTS_V1'), before);
  }
});
