/** Flat migration setup and evidence. No Sheet writes or build Hooks. */
var FLAT_V3_CONFIG_FILE_ID = '__FLAT_V3_CONFIG_FILE_ID__';
var FLAT_V3_MIGRATION_ID = 'drive-flat-layout-20261002';
function flatV3Automation_() {
  return {
    auto_publish_target: PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off',
    hourly_trigger_count: ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'hourlySandbox'; }).length
  };
}
function flatV3Paused_() {
  var state = flatV3Automation_();
  if (state.auto_publish_target !== 'off' || state.hourly_trigger_count !== 0) throw new Error('Pause sandbox automation before installing flat mounts');
}
function flatV3PreviewState_() {
  var state = previewState_(), safe = {};
  ['phase','revision','request_id','requested_at','attempts','http_status','deploy_id','commit_ref','ready_at'].forEach(function(key) {
    if (state[key] !== undefined && ['string','number','boolean'].includes(typeof state[key])) safe[key] = state[key];
  });
  return safe;
}
function flatV3SaveJson_(name, value) {
  var directory = folder_(DriveApp.getFolderById(SANDBOX.drive_root_id), 'imports');
  return directory.createFile(Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name)).getId();
}
function flatV3ReadAdminJson_(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(id) || id.indexOf('__') === 0) throw new Error('Configure a valid flat migration file ID');
  var file = sourceFile_(id);
  if (sourceParentPath_(file) !== 'imports' || file.getMimeType() !== 'application/json') throw new Error('Flat migration JSON must be in backend imports');
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}
var FLAT_V3_AUTOMATION = 'AIS_FLAT_V3_ORIGINAL_AUTOMATION';
var FLAT_V3_RUNTIME_CHECKS = 'AIS_FLAT_V3_RUNTIME_CHECKS';
function flatBeginV3() { return locked_(function() {
  var ss = sandboxGuard_(), properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty(FLAT_V3_AUTOMATION)) {
    var automation = flatV3Automation_();
    if (!['off','preview'].includes(automation.auto_publish_target) || automation.hourly_trigger_count > 1) throw new Error('Review unexpected automation before flattening');
    properties.setProperty(FLAT_V3_AUTOMATION, JSON.stringify(automation));
  }
  disableSandboxAutomation(); flatV3Paused_();
  var snapshot = checkedSnapshot_('', false), existing = properties.getProperty('AIS_FLAT_V3_BASELINE_FILE');
  if (existing) {
    var prior = flatV3ReadAdminJson_(existing);
    if (prior.migration_id !== FLAT_V3_MIGRATION_ID || prior.snapshot_sha256 !== hash_(V3.stable(snapshot))) throw new Error('Existing flat baseline differs');
    console.log('Flat baseline file: ' + existing); return existing;
  }
  var baseline = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, exported_at: new Date().toISOString(),
    root_id: '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH', develop_sheet_id: ss.getId(), backend_root_id: SANDBOX.drive_root_id,
    snapshot_file_id: properties.getProperty('SANDBOX_SNAPSHOT_FILE'), snapshot_sha256: hash_(V3.stable(snapshot)),
    snapshot: snapshot, mount_config: projectMounts_(), preview_state: flatV3PreviewState_(),
    input_hash: hash_(V3.stable(readInput_(ss))), automation: JSON.parse(properties.getProperty(FLAT_V3_AUTOMATION)) };
  if (baseline.input_hash !== snapshot.input_hash) throw new Error('Sheet changed during flat baseline export');
  var id = flatV3SaveJson_('drive-flat-v3-baseline-20261002.json', baseline);
  properties.setProperty('AIS_FLAT_V3_BASELINE_FILE', id);
  console.log('Flat baseline file: ' + id); return id;
}); }
function flatV3Config_() {
  var config = flatV3ReadAdminJson_(FLAT_V3_CONFIG_FILE_ID);
  if (config.schema !== 1 || config.migration_id !== FLAT_V3_MIGRATION_ID
    || config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'
    || config.develop_sheet_id !== SANDBOX.spreadsheet_id || config.backend_root_id !== SANDBOX.drive_root_id
    || !config.mount_config || config.mount_config.schema !== 3 || config.mount_config.root_id !== config.root_id) throw new Error('Unexpected flat migration configuration');
  validateFlatMounts_(config.mount_config);
  if (Utilities.newBlob(JSON.stringify(config.mount_config)).getBytes().length > 9000) throw new Error('Flat mount configuration exceeds the property size budget');
  var baselineId = PropertiesService.getScriptProperties().getProperty('AIS_FLAT_V3_BASELINE_FILE');
  if (!baselineId || config.baseline_file_id !== baselineId) throw new Error('Flat configuration does not reference the exported baseline');
  return config;
}
function flatV3SaveVerification_(report) {
  var fileId = flatV3SaveJson_('drive-flat-v3-verification-20261002-' + Date.now() + '.json', report);
  console.log('Flat bindings PASS; revision ' + report.registry_revision + '; ' + report.binding_count + ' bindings; ' + report.unique_file_count + ' files; report ' + fileId);
  return fileId;
}
function flatResumeV3() { return locked_(function() {
  var properties = PropertiesService.getScriptProperties(), resumed = properties.getProperty('AIS_FLAT_V3_RESUMED');
  if (resumed) {
    var previous = JSON.parse(resumed);
    if (V3.stable(previous.automation) !== V3.stable(flatV3Automation_())) throw new Error('Restored automation has changed; review it manually');
    console.log('Flat preview automation already restored'); return previous;
  }
  var context = flatV3RuntimeContext_(), saved = JSON.parse(properties.getProperty(FLAT_V3_RUNTIME_CHECKS) || '{}');
  if (saved.context_hash !== context.hash || !saved.checks) throw new Error('Complete all flat runtime checks before restoring automation');
  ['sync','manifest','samples'].forEach(function(operation) {
    var proof = saved.checks[operation];
    if (!proof) throw new Error('Missing flat runtime check: ' + operation);
    var report = flatV3ReadAdminJson_(proof.file_id);
    if (hash_(V3.stable(report)) !== proof.sha256 || report.result !== 'PASS'
      || report.context_hash !== context.hash || report.operation !== operation) throw new Error('Flat runtime report changed');
  });
  var original = JSON.parse(properties.getProperty(FLAT_V3_AUTOMATION) || 'null');
  if (!original || V3.stable(original) !== V3.stable(context.baseline.automation)
    || !['off','preview'].includes(original.auto_publish_target)
    || ![0,1].includes(original.hourly_trigger_count)) throw new Error('Invalid original preview automation');
  if (original.auto_publish_target === 'preview') {
    var state = previewState_();
    if (state.phase !== 'ready' || state.revision !== context.binding.registry_revision) throw new Error('Existing preview is not ready for the verified revision');
  }
  if (original.hourly_trigger_count === 1) ScriptApp.newTrigger('hourlySandbox').timeBased().everyHours(1).create();
  properties.setProperty('AI4S_AUTO_PUBLISH_TARGET', original.auto_publish_target);
  var record = { context_hash: context.hash, resumed_at: new Date().toISOString(), automation: flatV3Automation_() };
  if (V3.stable(record.automation) !== V3.stable(original)) throw new Error('Preview automation restoration did not match the baseline');
  properties.setProperty('AIS_FLAT_V3_RESUMED', JSON.stringify(record));
  console.log('Flat preview automation restored; target ' + original.auto_publish_target + '; hourly triggers ' + original.hourly_trigger_count);
  return record;
}); }
