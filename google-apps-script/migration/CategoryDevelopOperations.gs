/** One-time category migration helpers. No Sheet writes, sync or build Hooks. */
var CATEGORY_V3_CONFIG_FILE_ID = '__CATEGORY_V3_CONFIG_FILE_ID__';
var CATEGORY_V3_MIGRATION_ID = 'drive-category-20261002';
function categoryV3Automation_() {
  return {
    auto_publish_target: PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off',
    hourly_trigger_count: ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'hourlySandbox'; }).length
  };
}
function categoryV3Paused_() {
  var state = categoryV3Automation_();
  if (state.auto_publish_target !== 'off' || state.hourly_trigger_count !== 0) throw new Error('Pause sandbox automation before installing category mounts');
}
function categoryV3PreviewState_() {
  var state = previewState_(), safe = {};
  ['phase','revision','request_id','requested_at','attempts','http_status','deploy_id','commit_ref','ready_at'].forEach(function(key) {
    if (state[key] !== undefined && ['string','number','boolean'].includes(typeof state[key])) safe[key] = state[key];
  });
  return safe;
}
function categoryV3SaveJson_(name, value) {
  var directory = folder_(DriveApp.getFolderById(SANDBOX.drive_root_id), 'imports');
  return directory.createFile(Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name)).getId();
}
function categoryV3ReadAdminJson_(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(id) || id.indexOf('__') === 0) throw new Error('Configure a valid category migration file ID');
  var file = sourceFile_(id);
  if (sourceParentPath_(file) !== 'imports' || file.getMimeType() !== 'application/json') throw new Error('Category migration JSON must be in backend imports');
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}
function categoryExportV3() { return locked_(function() {
  var ss = sandboxGuard_(), properties = PropertiesService.getScriptProperties();
  var snapshot = checkedSnapshot_('', true), existing = properties.getProperty('AIS_CATEGORY_V3_BASELINE_FILE');
  if (existing) {
    var prior = categoryV3ReadAdminJson_(existing);
    if (prior.migration_id !== CATEGORY_V3_MIGRATION_ID || prior.snapshot_sha256 !== hash_(V3.stable(snapshot))) throw new Error('Existing category baseline differs; preserve it and review the migration state');
    console.log('Baseline file: ' + existing); return existing;
  }
  var baseline = {
    schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, exported_at: new Date().toISOString(),
    root_id: '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH', develop_sheet_id: ss.getId(), backend_root_id: SANDBOX.drive_root_id,
    snapshot_file_id: properties.getProperty('SANDBOX_SNAPSHOT_FILE'), snapshot_sha256: hash_(V3.stable(snapshot)),
    snapshot: snapshot, mount_config: projectMounts_(), preview_state: categoryV3PreviewState_(),
    input_hash: hash_(V3.stable(readInput_(ss))), automation: categoryV3Automation_()
  };
  if (baseline.input_hash !== snapshot.input_hash) throw new Error('Sheet changed during baseline export');
  var fileId = categoryV3SaveJson_('drive-category-v3-baseline-20261002.json', baseline);
  properties.setProperty('AIS_CATEGORY_V3_BASELINE_FILE', fileId);
  console.log('Baseline file: ' + fileId); return fileId;
}); }
function categoryV3Config_() {
  var config = categoryV3ReadAdminJson_(CATEGORY_V3_CONFIG_FILE_ID);
  if (config.schema !== 1 || config.migration_id !== CATEGORY_V3_MIGRATION_ID
    || config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'
    || config.develop_sheet_id !== SANDBOX.spreadsheet_id || config.backend_root_id !== SANDBOX.drive_root_id
    || !config.mount_config || config.mount_config.schema !== 2 || config.mount_config.root_id !== config.root_id) throw new Error('Unexpected category migration configuration');
  validateCategoryMounts_(config.mount_config);
  var baselineId = PropertiesService.getScriptProperties().getProperty('AIS_CATEGORY_V3_BASELINE_FILE');
  if (!baselineId || config.baseline_file_id !== baselineId) throw new Error('Category configuration does not reference the exported baseline');
  return config;
}
function categoryV3VerifyBindings_(config, ss) {
  var properties = PropertiesService.getScriptProperties(), baseline = categoryV3ReadAdminJson_(config.baseline_file_id);
  if (baseline.schema !== 1 || baseline.migration_id !== CATEGORY_V3_MIGRATION_ID
    || baseline.root_id !== config.root_id || baseline.develop_sheet_id !== SANDBOX.spreadsheet_id
    || baseline.backend_root_id !== SANDBOX.drive_root_id || !baseline.snapshot
    || !Array.isArray(baseline.snapshot.files) || !baseline.snapshot.files.length
    || baseline.snapshot_sha256 !== hash_(V3.stable(baseline.snapshot))) throw new Error('Invalid category baseline');
  if (V3.stable(projectMounts_()) !== V3.stable(config.mount_config)) throw new Error('Installed category mounts differ from the reviewed configuration');
  var current = currentSnapshot_(), fingerprint = hash_(V3.stable(readInput_(ss)));
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(current)) !== baseline.snapshot_sha256 || fingerprint !== baseline.input_hash
    || fingerprint !== current.input_hash) throw new Error('Snapshot or Sheet input changed since baseline export');
  var observed = {}, files = [];
  current.files.forEach(function(expected) {
    // Omit the previous descriptor so every unique file is freshly hashed.
    var actual = observed[expected.file_id] || (observed[expected.file_id] = source_(expected.file_id));
    ['file_id','parent_path','sha256','size','mime_type','modified_at'].forEach(function(key) {
      if (actual[key] !== expected[key]) throw new Error('Category source binding changed: ' + expected.id + ' (' + key + ')');
    });
    files.push({ id: expected.id, file_id: actual.file_id, logical_parent_path: actual.parent_path,
      sha256: actual.sha256, size: actual.size, mime_type: actual.mime_type, modified_at: actual.modified_at });
  });
  current.files.forEach(assertStamp_);
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(currentSnapshot_())) !== baseline.snapshot_sha256
    || hash_(V3.stable(readInput_(ss))) !== fingerprint) throw new Error('Source snapshot or Sheet input changed during verification');
  return { schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, verified_at: new Date().toISOString(),
    result: 'PASS', registry_revision: current.manifest.registry_revision,
    project_count: current.manifest.demos.length, binding_count: files.length,
    unique_file_count: Object.keys(observed).length, baseline_file_id: config.baseline_file_id,
    config_file_id: CATEGORY_V3_CONFIG_FILE_ID, snapshot_file_id: baseline.snapshot_file_id,
    input_hash: fingerprint, snapshot_sha256: baseline.snapshot_sha256,
    mount_config_sha256: hash_(V3.stable(config.mount_config)), files: files,
    preview_state: categoryV3PreviewState_(), automation: categoryV3Automation_() };
}
function categoryV3SaveVerification_(report) {
  var fileId = categoryV3SaveJson_('drive-category-v3-verification-20261002-' + Date.now() + '.json', report);
  console.log('Category bindings PASS; revision ' + report.registry_revision + '; ' + report.binding_count + ' bindings; ' + report.unique_file_count + ' files; report ' + fileId);
  return fileId;
}
function categoryInstallV3() { return locked_(function() {
  var ss = sandboxGuard_(); categoryV3Paused_();
  var config = categoryV3Config_(), properties = PropertiesService.getScriptProperties();
  var previous = properties.getProperty('AIS_PROJECT_MOUNTS_V1');
  try {
    properties.setProperty('AIS_PROJECT_MOUNTS_V1', JSON.stringify(config.mount_config));
    return categoryV3SaveVerification_(categoryV3VerifyBindings_(config, ss));
  } catch (error) {
    if (previous === null) properties.deleteProperty('AIS_PROJECT_MOUNTS_V1');
    else properties.setProperty('AIS_PROJECT_MOUNTS_V1', previous);
    throw error;
  }
}); }
function categoryVerifyV3() { return locked_(function() {
  var ss = sandboxGuard_(); categoryV3Paused_();
  return categoryV3SaveVerification_(categoryV3VerifyBindings_(categoryV3Config_(), ss));
}); }
