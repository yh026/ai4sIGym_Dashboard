/** One-time September 2026 migration. No build Hook is called by these helpers. */
function datedMigrationConfig_() {
  var config = JSON.parse(DriveApp.getFileById('13pcmqFeD_RvtI9Wi-8hm9GxuNjRiNEro').getBlob().getDataAsString('UTF-8'));
  if (config.schema !== 1 || config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'
      || Object.keys(config.archives).length !== 15) throw new Error('Unexpected migration configuration');
  return config;
}
function migrationFileHashes_(config, requireArchived) {
  var out = {};
  Object.keys(config.archives).forEach(function(id) {
    var entry = config.archives[id];
    entry.file_ids.forEach(function(fileId) {
      var f = DriveApp.getFileById(fileId);
      if (requireArchived && !hasDirectParentOrThrow_(f, entry.date_id, 'archived file')) throw new Error('File not archived: ' + fileId);
      if (f.getMimeType().indexOf('application/vnd.google-apps.') === 0) return;
      out[fileId] = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, f.getBlob().getBytes()));
    });
  });
  return out;
}
function migrationHumanValues_(ss) {
  var sh = ss.getSheetByName('Projects'), values = sh.getRange('A1:R16').getValues(), formulas = sh.getRange('A1:R16').getFormulas();
  return values.map(function(row,i) { return row.map(function(value,j) { return j===1||j===2 ? null : [value,formulas[i][j]]; }); });
}
function migrationPublicContent_(ss,cfg) {
  var snapshot = registryV2Snapshot_(ss,cfg,'production');
  return {site:snapshot.site,taxonomy:snapshot.taxonomy,demos:snapshot.demos};
}
function configureArchiveMigration() {
  var config = datedMigrationConfig_(), p = PropertiesService.getScriptProperties(), ss = registryV2Spreadsheet_();
  if (ss.getId() !== config.original_sheet_id) throw new Error('Wrong migration script');
  var cfg = registryV2OperationalConfig_(ss);
  if (folderIdFromUrl_(cfg.drive_folder_url) !== config.root_id) throw new Error('Wrong production root');
  if (!p.getProperty('AI4S_MIGRATION_PREVIOUS_SYNC_COUNT')) {
    var triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction()==='syncDrive'; });
    p.setProperty('AI4S_MIGRATION_PREVIOUS_SYNC_COUNT',String(triggers.length));
    p.setProperty('AI4S_MIGRATION_PREVIOUS_AUTO_TARGET',p.getProperty('AI4S_AUTO_PUBLISH_TARGET')||'off');
    triggers.forEach(function(t) { ScriptApp.deleteTrigger(t); });
    p.setProperty('AI4S_AUTO_PUBLISH_TARGET','off');
  }
  if (!p.getProperty('AI4S_MIGRATION_BASELINE_FILE')) {
    var baseline = {human:migrationHumanValues_(ss),content:migrationPublicContent_(ss,cfg),hashes:migrationFileHashes_(config,false),created_at:new Date().toISOString()};
    var backup = DriveApp.getFolderById(config.backup_folder_id).createFile(Utilities.newBlob(JSON.stringify(baseline),'application/json','production-content-before-migration.json'));
    p.setProperty('AI4S_MIGRATION_BASELINE_FILE',backup.getId());
  }
  p.setProperty('AI4S_DATED_ARCHIVES_V1',JSON.stringify(config.archives));
  console.log('15 legacy projects pinned; hourly sync paused; no build triggered. Baseline: '+p.getProperty('AI4S_MIGRATION_BASELINE_FILE'));
}
function verifyArchiveMigration() {
  var config=datedMigrationConfig_(),p=PropertiesService.getScriptProperties(),ss=registryV2Spreadsheet_(),cfg=registryV2OperationalConfig_(ss);
  var baseline=JSON.parse(DriveApp.getFileById(p.getProperty('AI4S_MIGRATION_BASELINE_FILE')).getBlob().getDataAsString('UTF-8'));
  if(stableJson_(baseline.human)!==stableJson_(migrationHumanValues_(ss)))throw new Error('Production human fields changed');
  if(stableJson_(baseline.content)!==stableJson_(migrationPublicContent_(ss,cfg)))throw new Error('Production manifest content changed');
  var hashes=migrationFileHashes_(config,true);
  if(stableJson_(baseline.hashes)!==stableJson_(hashes))throw new Error('Archived file bytes changed');
  p.setProperty('AI4S_MIGRATION_VERIFIED',new Date().toISOString());
  console.log('Verified: 15 original projects, unchanged human fields and Production manifest content, '+Object.keys(hashes).length+' unchanged archived files.');
}
function resumeArchiveSync() {
  var p=PropertiesService.getScriptProperties();
  if(!p.getProperty('AI4S_MIGRATION_VERIFIED'))throw new Error('Verify migration first');
  ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='syncDrive';}).forEach(function(t){ScriptApp.deleteTrigger(t);});
  if(Number(p.getProperty('AI4S_MIGRATION_PREVIOUS_SYNC_COUNT'))>0)ScriptApp.newTrigger('syncDrive').timeBased().everyHours(1).create();
  p.setProperty('AI4S_AUTO_PUBLISH_TARGET',p.getProperty('AI4S_MIGRATION_PREVIOUS_AUTO_TARGET')||'off');
  console.log('Original hourly sync restored; automatic publishing: '+p.getProperty('AI4S_AUTO_PUBLISH_TARGET'));
}
