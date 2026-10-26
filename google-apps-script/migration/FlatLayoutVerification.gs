/** Bounded flat verification. Each operation fits a separate Apps Script run. */
var FLAT_V3_VERIFY_PROGRESS = 'AIS_FLAT_V3_VERIFY_PROGRESS';
var FLAT_V3_VERIFY_CHUNK_SIZE = 12;
function flatV3BatchContext_(ss, install) {
  flatV3Paused_();
  var config = flatV3Config_(), properties = PropertiesService.getScriptProperties();
  var baseline = flatV3ReadAdminJson_(config.baseline_file_id);
  if (baseline.schema !== 1 || baseline.migration_id !== FLAT_V3_MIGRATION_ID
    || baseline.root_id !== config.root_id || baseline.develop_sheet_id !== SANDBOX.spreadsheet_id
    || baseline.backend_root_id !== SANDBOX.drive_root_id || !baseline.snapshot
    || !Array.isArray(baseline.snapshot.files) || !baseline.snapshot.files.length
    || baseline.snapshot_sha256 !== hash_(V3.stable(baseline.snapshot))) throw new Error('Invalid flat baseline');
  var snapshot = currentSnapshot_(), inputHash = hash_(V3.stable(readInput_(ss)));
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(snapshot)) !== baseline.snapshot_sha256 || inputHash !== baseline.input_hash
    || inputHash !== snapshot.input_hash) throw new Error('Snapshot or Sheet input changed since baseline export');
  var installed = projectMounts_();
  if (V3.stable(installed) !== V3.stable(config.mount_config)) {
    if (!install || V3.stable(installed) !== V3.stable(baseline.mount_config)) throw new Error('Installed flat mounts differ from the approved configuration');
    properties.setProperty('AIS_PROJECT_MOUNTS_V1', JSON.stringify(config.mount_config));
  }
  var binding = { migration_id: FLAT_V3_MIGRATION_ID, baseline_file_id: config.baseline_file_id,
    config_file_id: FLAT_V3_CONFIG_FILE_ID, config_sha256: hash_(V3.stable(config)),
    baseline_sha256: hash_(V3.stable(baseline)), snapshot_file_id: baseline.snapshot_file_id,
    snapshot_sha256: baseline.snapshot_sha256, input_hash: inputHash,
    mount_config_sha256: hash_(V3.stable(config.mount_config)),
    registry_revision: snapshot.manifest.registry_revision, binding_count: snapshot.files.length };
  return { config: config, baseline: baseline, snapshot: snapshot, binding: binding, hash: hash_(V3.stable(binding)) };
}
function flatV3BatchProgress_(context) {
  var raw = PropertiesService.getScriptProperties().getProperty(FLAT_V3_VERIFY_PROGRESS);
  if (!raw) throw new Error('Run flatBeginV3Verification first');
  var progress = JSON.parse(raw);
  if (progress.schema !== 1 || progress.context_hash !== context.hash
    || V3.stable(progress.binding) !== V3.stable(context.binding)
    || !['hashing','complete'].includes(progress.phase)
    || !Number.isInteger(progress.next_index) || progress.next_index < 0
    || progress.next_index > context.snapshot.files.length || !Array.isArray(progress.chunks)) throw new Error('Flat verification context or progress changed');
  var cursor = 0;
  progress.chunks.forEach(function(chunk) {
    if (chunk.start !== cursor || !Number.isInteger(chunk.end) || chunk.end <= cursor
      || chunk.end > Math.min(cursor + FLAT_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length)
      || typeof chunk.file_id !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Invalid flat verification chunk index');
    cursor = chunk.end;
  });
  if (cursor !== progress.next_index) throw new Error('Incomplete flat verification progress');
  return progress;
}
function flatV3WriteProgress_(progress) {
  var text = JSON.stringify(progress);
  if (text.length >= 8500) throw new Error('Flat verification progress exceeds the bounded property size');
  PropertiesService.getScriptProperties().setProperty(FLAT_V3_VERIFY_PROGRESS, text);
}
function flatBeginV3Verification() { return locked_(function() {
  var context = flatV3BatchContext_(sandboxGuard_(), true);
  var properties = PropertiesService.getScriptProperties(), progress;
  if (properties.getProperty(FLAT_V3_VERIFY_PROGRESS)) progress = flatV3BatchProgress_(context);
  else {
    progress = { schema: 1, context_hash: context.hash, binding: context.binding,
      phase: 'hashing', next_index: 0, chunks: [] };
    flatV3WriteProgress_(progress);
  }
  console.log('Flat verification ' + progress.phase + '; verified ' + progress.next_index + '/' + context.snapshot.files.length + ' bindings');
  return { phase: progress.phase, verified: progress.next_index, total: context.snapshot.files.length };
}); }
function flatV3VerifiedFile_(expected, actual) {
  ['file_id','parent_path','sha256','size','mime_type','modified_at'].forEach(function(key) {
    if (actual[key] !== expected[key]) throw new Error('Flat source binding changed: ' + expected.id + ' (' + key + ')');
  });
  return { id: expected.id, file_id: actual.file_id, logical_parent_path: actual.parent_path,
    sha256: actual.sha256, size: actual.size, mime_type: actual.mime_type, modified_at: actual.modified_at };
}
function flatVerifyV3Chunk() { return locked_(function() {
  var ss = sandboxGuard_(), context = flatV3BatchContext_(ss, false), progress = flatV3BatchProgress_(context);
  var start = progress.next_index, end = Math.min(start + FLAT_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length);
  if (progress.phase === 'complete' || start === end) {
    console.log('All source hashes verified; phase ' + progress.phase + '; use flatFinalizeV3Verification');
    return { phase: progress.phase, verified: start, total: context.snapshot.files.length };
  }
  var observed = {}, files = context.snapshot.files.slice(start, end).map(function(expected) {
    var actual = observed[expected.file_id] || (observed[expected.file_id] = source_(expected.file_id));
    return flatV3VerifiedFile_(expected, actual);
  });
  if (flatV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Flat verification context changed during chunk');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, context_hash: context.hash,
    verified_at: new Date().toISOString(), start: start, end: end, files: files };
  var fileId = flatV3SaveJson_('drive-flat-v3-chunk-' + start + '-' + end + '-' + Date.now() + '.json', report);
  // A failed or timed-out chunk never advances the cursor without saved proof.
  progress.chunks.push({ start: start, end: end, file_id: fileId, sha256: hash_(V3.stable(report)) });
  progress.next_index = end;
  flatV3WriteProgress_(progress);
  console.log('Flat hashes verified ' + end + '/' + context.snapshot.files.length + '; chunk ' + fileId);
  return { phase: progress.phase, verified: end, total: context.snapshot.files.length };
}); }
function flatFinalizeV3Verification() { return locked_(function() {
  var ss = sandboxGuard_(), context = flatV3BatchContext_(ss, false), progress = flatV3BatchProgress_(context);
  if (progress.phase === 'complete') {
    console.log('Flat verification already complete; report ' + progress.report_file_id); return progress.report_file_id;
  }
  if (progress.next_index !== context.snapshot.files.length) throw new Error('Verify every source chunk before finalizing');
  var files = [], uniqueFiles = {};
  progress.chunks.forEach(function(chunk) {
    var saved = flatV3ReadAdminJson_(chunk.file_id);
    if (hash_(V3.stable(saved)) !== chunk.sha256 || saved.schema !== 1
      || saved.migration_id !== FLAT_V3_MIGRATION_ID || saved.context_hash !== context.hash
      || saved.start !== chunk.start || saved.end !== chunk.end || !Array.isArray(saved.files)
      || saved.files.length !== chunk.end - chunk.start) throw new Error('Flat chunk proof changed or is incomplete');
    saved.files.forEach(function(actual, offset) {
      var expected = context.snapshot.files[chunk.start + offset];
      if (actual.id !== expected.id) throw new Error('Flat chunk contains the wrong logical identity');
      var checked = flatV3VerifiedFile_(expected, { file_id: actual.file_id,
        parent_path: actual.logical_parent_path, sha256: actual.sha256, size: actual.size,
        mime_type: actual.mime_type, modified_at: actual.modified_at });
      uniqueFiles[actual.file_id] = true; files.push(checked);
    });
  });
  if (files.length !== context.snapshot.files.length) throw new Error('Flat source coverage is incomplete');
  context.snapshot.files.forEach(assertStamp_);
  if (flatV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Flat verification context changed during finalization');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, verified_at: new Date().toISOString(),
    result: 'PASS', registry_revision: context.binding.registry_revision,
    project_count: context.snapshot.manifest.demos.length, binding_count: files.length,
    unique_file_count: Object.keys(uniqueFiles).length, baseline_file_id: context.config.baseline_file_id,
    config_file_id: FLAT_V3_CONFIG_FILE_ID, snapshot_file_id: context.binding.snapshot_file_id,
    input_hash: context.binding.input_hash, snapshot_sha256: context.binding.snapshot_sha256,
    mount_config_sha256: context.binding.mount_config_sha256, files: files,
    chunk_reports: progress.chunks, preview_state: flatV3PreviewState_(), automation: flatV3Automation_() };
  var fileId = flatV3SaveVerification_(report);
  progress.phase = 'complete'; progress.report_file_id = fileId;
  flatV3WriteProgress_(progress);
  return fileId;
}); }
