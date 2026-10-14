/** Editor-only post-migration checks. Run each public function separately.
 * These call the existing authenticated doGet implementation internally; they
 * do not add a public endpoint or prove the deployed HTTP transport or ACLs. */
function flatV3RuntimeContext_() {
  var context = flatV3BatchContext_(sandboxGuard_(), false);
  if (flatV3BatchProgress_(context).phase !== 'complete') throw new Error('Complete bounded source verification before checking runtime');
  return context;
}
function flatV3RuntimeBefore_() {
  return { context: flatV3RuntimeContext_(), preview_state: PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE'), started: Date.now() };
}
function flatV3RuntimeFinish_(before, operation, checks) {
  var after = flatV3RuntimeContext_();
  if (after.hash !== before.context.hash || PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE') !== before.preview_state) throw new Error('Runtime check changed the snapshot, input or preview state');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, result: 'PASS',
    operation: operation, scope: 'editor-runtime-only', registry_revision: after.binding.registry_revision,
    context_hash: after.hash, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - before.started, checks: checks };
  var id = flatV3SaveJson_('drive-flat-v3-runtime-' + operation + '-' + Date.now() + '.json', report);
  var properties = PropertiesService.getScriptProperties(), saved = JSON.parse(properties.getProperty(FLAT_V3_RUNTIME_CHECKS) || '{}');
  if (saved.context_hash !== after.hash) saved = { context_hash: after.hash, checks: {} };
  saved.checks[operation] = { file_id: id, sha256: hash_(V3.stable(report)) };
  properties.setProperty(FLAT_V3_RUNTIME_CHECKS, JSON.stringify(saved));
  console.log('Flat runtime ' + operation + ' PASS; ' + report.elapsed_ms + ' ms; revision ' + report.registry_revision + '; report ' + id);
  return { result: report.result, operation: operation, elapsed_ms: report.elapsed_ms, report_file_id: id };
}
function flatV3RuntimeCheck() {
  var before = flatV3RuntimeBefore_(), started = Date.now();
  // syncSandbox owns its normal lock; do not wrap it in another locked_ call.
  // Automation remains paused and no publishing function is invoked.
  var manifest = syncSandbox();
  if (V3.stable(manifest) !== V3.stable(before.context.snapshot.manifest)) throw new Error('Normal sync changed the manifest');
  return flatV3RuntimeFinish_(before, 'sync', [{ operation: 'syncSandbox', elapsed_ms: Date.now() - started, unchanged: true }]);
}
function flatV3RuntimeRequest_(snapshot, action, id) {
  var token = PropertiesService.getScriptProperties().getProperty('AI4S_REGISTRY_ACCESS_TOKEN');
  if (!token) throw new Error('Existing registry token is missing');
  var output = doGet({ parameter: { token: token, schema: '3', audience: 'preview', action: action,
    id: id || '', registry_revision: snapshot.manifest.registry_revision } });
  var response = JSON.parse(output.getContent());
  if (response.ok !== true) throw new Error('Internal registry API check failed for ' + action);
  return response;
}
function flatV3RuntimeManifestCheck() { return locked_(function() {
  var before = flatV3RuntimeBefore_(), started = Date.now(), snapshot = before.context.snapshot;
  var response = flatV3RuntimeRequest_(snapshot, 'manifest');
  if (V3.stable(response) !== V3.stable(Object.assign({ ok: true }, snapshot.manifest))) throw new Error('Internal manifest differs from the verified snapshot');
  return flatV3RuntimeFinish_(before, 'manifest', [{ operation: 'manifest', elapsed_ms: Date.now() - started,
    project_count: snapshot.manifest.demos.length, binding_count: snapshot.files.length, unchanged: true }]);
}); }
function flatV3RuntimeSamplesCheck() { return locked_(function() {
  var before = flatV3RuntimeBefore_(), snapshot = before.context.snapshot;
  // Exercise dataset-page, cover-image and nested skill-resource mounts with
  // small representative files, keeping this separate from the manifest scan.
  var ids = ['page-battery-curve-shape-explorer-dataset', 'card-battery-curve-shape-explorer', 'res-tbb-cluster-explorer-2-0'];
  var checks = ids.map(function(id) {
    var file = snapshot.files.find(function(entry) { return entry.id === id; });
    if (!file) throw new Error('Representative source is absent from the verified snapshot');
    var started = Date.now(), action = file.kind === 'page' ? 'page' : 'resource';
    var response = flatV3RuntimeRequest_(snapshot, action, file.id);
    if (response.id !== file.id || response.registry_instance !== snapshot.manifest.registry_instance
      || response.registry_revision !== snapshot.manifest.registry_revision) throw new Error('Internal API returned mismatched source metadata');
    var bytes = file.kind === 'page' ? Utilities.newBlob(response.html).getBytes() : Utilities.base64Decode(response.base64);
    if (bytes.length !== file.size || hash_(bytes) !== file.sha256) throw new Error('Internal API returned different source bytes');
    return { id: file.id, kind: file.kind, sha256: file.sha256, size: file.size, elapsed_ms: Date.now() - started };
  });
  return flatV3RuntimeFinish_(before, 'samples', checks);
}); }
