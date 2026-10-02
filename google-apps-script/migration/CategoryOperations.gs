/** One-time category migration. No helper calls a build Hook or publishing function. */
var CATEGORY_V2_CONFIG_FILE_ID = '1W9GZ4aP3HUIZGJJTkpj74d7Nozut3jfQ';
var CATEGORY_V2_STATE_PROPERTY = 'AI4S_CATEGORY_MIGRATION_V1';
var CATEGORY_V2_ROOT_ID = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
var CATEGORY_V2_SHEET_ID = '1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE';

function categoryLockedV2_(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('A V2 operation is still running; retry after it finishes.');
  try { return action(); } finally { lock.releaseLock(); }
}
function categoryContextV2_() {
  var ss = registryV2Spreadsheet_(), cfg = registryV2OperationalConfig_(ss);
  if (ss.getId() !== CATEGORY_V2_SHEET_ID || folderIdFromUrl_(cfg.drive_folder_url) !== CATEGORY_V2_ROOT_ID) {
    throw new Error('Category migration is bound to the original V2 Registry and AIS root only.');
  }
  return { ss: ss, cfg: cfg, props: PropertiesService.getScriptProperties() };
}
function categoryStateV2_(ctx) {
  var state = JSON.parse(ctx.props.getProperty(CATEGORY_V2_STATE_PROPERTY) || '{}');
  if (state.root_id && (state.root_id !== CATEGORY_V2_ROOT_ID || state.sheet_id !== CATEGORY_V2_SHEET_ID)) {
    throw new Error('Category migration state belongs to another Registry.');
  }
  return state;
}
function categorySaveStateV2_(ctx, state) {
  ctx.props.setProperty(CATEGORY_V2_STATE_PROPERTY, JSON.stringify(state));
}
function categoryHumanV2_(ss) {
  var sheet = ss.getSheetByName('Projects');
  var range = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn());
  var values = range.getValues(), formulas = range.getFormulas(), headers = values[0];
  return values.map(function (row, i) {
    return row.map(function (value, j) {
      return i && (headers[j] === 'Readiness' || headers[j] === 'Preview URL')
        ? null : [value, formulas[i][j]];
    });
  });
}
function categoryContentV2_(ctx) {
  var snapshot = registryV2Snapshot_(ctx.ss, ctx.cfg, 'production');
  return { site: snapshot.site, taxonomy: snapshot.taxonomy, demos: snapshot.demos };
}
function categorySourcesV2_() {
  return collectDemos_(DriveApp.getFolderById(CATEGORY_V2_ROOT_ID)).map(function (item) {
    return { project_id: item.folderId, legacy_folder_name: item.folderName,
      source_folder_id: item.sourceFolderId || item.folderId, page_id: item.file.getId(),
      page_ids: (item.pageFiles || [item.file]).map(function (f) { return f.getId(); }).sort(),
      image_ids: (item.imageFiles || []).map(function (f) { return f.getId(); }).sort(),
      provenance_id: item.provFile ? item.provFile.getId() : '' };
  }).sort(function (a, b) { return a.project_id.localeCompare(b.project_id); });
}
function categoryFileIdsV2_(sources, archives) {
  var ids = {};
  sources.forEach(function (s) {
    s.page_ids.concat(s.image_ids, s.provenance_id ? [s.provenance_id] : []).forEach(function (id) { ids[id] = true; });
  });
  Object.keys(archives).forEach(function (id) {
    archives[id].file_ids.forEach(function (fileId) { ids[fileId] = true; });
  });
  return Object.keys(ids).sort();
}
function categoryHashesV2_(ids) {
  var hashes = {};
  ids.forEach(function (id) {
    var file = DriveApp.getFileById(id), mime = file.getMimeType();
    if (mime.indexOf('application/vnd.google-apps.') === 0) {
      // Archived native documents are retained by identity/metadata. They are
      // not build HTML and their Drive blob is not the native document bytes.
      var modified = file.getLastUpdated(), size = Number(file.getSize());
      if (!modified || !isFinite(modified.getTime()) || !isFinite(size) || size < 0) {
        throw new Error('Native archive metadata is unavailable: ' + id);
      }
      hashes[id] = { kind: 'native-metadata', id: id, name: file.getName(), mime: mime,
        modified_at: modified.toISOString(), size: size };
      return;
    }
    var bytes = file.getBlob().getBytes();
    hashes[id] = { kind: 'sha256', name: file.getName(), mime: mime, size: bytes.length,
      sha256: bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)) };
  });
  return hashes;
}
function categoryTriggersV2_() {
  return ScriptApp.getProjectTriggers().map(function (trigger) {
    return { handler: trigger.getHandlerFunction(), event_type: String(trigger.getEventType()),
      source: String(trigger.getTriggerSource()), unique_id: trigger.getUniqueId() };
  });
}
function categoryPauseV2_(ctx) {
  ctx.props.setProperty('AI4S_AUTO_PUBLISH_TARGET', 'off');
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncDrive'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}
function categoryBaselineV2_(state) {
  if (!state.baseline_file_id) throw new Error('Run categoryBeginV2 before moving folders.');
  var text = DriveApp.getFileById(state.baseline_file_id).getBlob().getDataAsString('UTF-8');
  if (sha256Hex_(text) !== state.baseline_sha256) throw new Error('Category baseline file was changed.');
  return JSON.parse(text);
}

/** Pause the original hourly sync and export a fresh, non-secret baseline. Idempotent. */
function categoryBeginV2() {
  return categoryLockedV2_(function () {
    var ctx = categoryContextV2_(), state = categoryStateV2_(ctx);
    if (state.baseline_file_id) {
      categoryBaselineV2_(state);
      console.log('Category baseline already recorded; phase=' + state.phase + '; file=' + state.baseline_file_id);
      return;
    }
    if (!state.started_at) {
      if (ctx.props.getProperty('AI4S_CATEGORY_LAYOUT_V1')) throw new Error('Begin must run before installing the category layout.');
      var triggers = categoryTriggersV2_();
      var sync = triggers.filter(function (t) { return t.handler === 'syncDrive'; });
      if (sync.some(function (t) { return t.event_type !== 'CLOCK'; })) throw new Error('Unexpected non-clock sync trigger; no automation changed.');
      var previous = ctx.props.getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off';
      state = { schema: 1, root_id: CATEGORY_V2_ROOT_ID, sheet_id: CATEGORY_V2_SHEET_ID,
        started_at: new Date().toISOString(), phase: 'pausing', triggers: triggers,
        previous_sync_count: sync.length,
        previous_auto_target: ['off', 'preview', 'production'].indexOf(previous) >= 0 ? previous : 'unsupported' };
      categorySaveStateV2_(ctx, state);
    }
    categoryPauseV2_(ctx);
    state.phase = 'paused'; categorySaveStateV2_(ctx, state);
    var archives = registryV2Archives_(), sources = categorySourcesV2_();
    if (Object.keys(archives).length !== 15 || sources.length !== 15) throw new Error('Expected 15 legacy V2 sources; migration remains paused.');
    var baseline = { schema: 1, root_id: CATEGORY_V2_ROOT_ID, sheet_id: CATEGORY_V2_SHEET_ID,
      created_at: new Date().toISOString(), human: categoryHumanV2_(ctx.ss), content: categoryContentV2_(ctx),
      sources: sources, archives: archives, hashes: categoryHashesV2_(categoryFileIdsV2_(sources, archives)),
      automation: { triggers: state.triggers, previous_sync_count: state.previous_sync_count,
        previous_auto_target: state.previous_auto_target }, previous_category_layout: null };
    var text = JSON.stringify(baseline);
    var file = DriveApp.getFolderById(CATEGORY_V2_ROOT_ID).createFile(Utilities.newBlob(text,
      'application/json', 'category-v2-baseline-2026-10-02.json'));
    state.baseline_file_id = file.getId(); state.baseline_sha256 = sha256Hex_(text); state.phase = 'baseline-ready';
    categorySaveStateV2_(ctx, state);
    console.log('V2 sync paused; automatic publishing off; baseline file=' + file.getId()
      + '; sources=' + sources.length + '; file_contracts=' + Object.keys(baseline.hashes).length + '; no build triggered.');
  });
}

/** Install only the approved category mapping; existing archive pins are untouched. */
function categoryInstallV2() {
  return categoryLockedV2_(function () {
    var ctx = categoryContextV2_(), state = categoryStateV2_(ctx), baseline = categoryBaselineV2_(state);
    if (state.phase === 'resumed') throw new Error('Category migration already resumed.');
    categoryPauseV2_(ctx);
    state.phase = 'installing'; delete state.verified_at; categorySaveStateV2_(ctx, state);
    var config = JSON.parse(DriveApp.getFileById(CATEGORY_V2_CONFIG_FILE_ID).getBlob().getDataAsString('UTF-8'));
    if (config.schema !== 1 || config.root_id !== CATEGORY_V2_ROOT_ID || config.original_sheet_id !== CATEGORY_V2_SHEET_ID
        || !config.v2_layout || config.v2_layout.projects.length !== baseline.sources.length) throw new Error('Unexpected category configuration.');
    var expected = {};
    baseline.sources.forEach(function (s) { expected[s.project_id] = s; });
    config.v2_layout.projects.forEach(function (m) {
      if (!expected[m.project_id] || m.legacy_folder_name !== expected[m.project_id].legacy_folder_name
          || m.archive_id !== baseline.archives[m.project_id].archive_id) throw new Error('Category mapping changes a legacy identity.');
    });
    var previous = ctx.props.getProperty('AI4S_CATEGORY_LAYOUT_V1');
    try {
      ctx.props.setProperty('AI4S_CATEGORY_LAYOUT_V1', JSON.stringify(config.v2_layout));
      registryV2CategoryLayout_(CATEGORY_V2_ROOT_ID);
      if (stableJson_(categorySourcesV2_()) !== stableJson_(baseline.sources)) throw new Error('Category mapping changes collected source identities.');
    } catch (error) {
      if (previous) ctx.props.setProperty('AI4S_CATEGORY_LAYOUT_V1', previous);
      else ctx.props.deleteProperty('AI4S_CATEGORY_LAYOUT_V1');
      throw error;
    }
    state.config_file_id = CATEGORY_V2_CONFIG_FILE_ID;
    state.layout_sha256 = sha256Hex_(stableJson_(config.v2_layout));
    state.phase = 'installed'; delete state.verified_at;
    categorySaveStateV2_(ctx, state); registryV2InvalidateSnapshotMarkers_();
    console.log('V2 category mapping installed; identities unchanged; sync remains paused; no build triggered.');
  });
}

function categoryCheckV2_(ctx, state, verifyHashes) {
  var baseline = categoryBaselineV2_(state), layout = registryV2CategoryLayout_(CATEGORY_V2_ROOT_ID);
  if (!layout || sha256Hex_(stableJson_(layout)) !== state.layout_sha256) throw new Error('Installed category mapping changed.');
  if (stableJson_(registryV2Archives_()) !== stableJson_(baseline.archives)) throw new Error('Legacy archive pins changed.');
  layout.projects.forEach(function (m) {
    var project = DriveApp.getFolderById(m.project_id), archive = DriveApp.getFolderById(m.archive_id);
    if (project.getName() !== m.folder_name || archive.getName() !== m.archive_name
        || registryV2SyncParentIds_(project, layout.demo_html_id, 'numbered project').length !== 1
        || registryV2SyncParentIds_(archive, layout.archive_id, 'numbered archive').length !== 1) throw new Error('Category move is not complete.');
    registryV2CheckedArchive_(project, CATEGORY_V2_ROOT_ID, baseline.archives[m.project_id]);
  });
  if (stableJson_(baseline.human) !== stableJson_(categoryHumanV2_(ctx.ss))) throw new Error('V2 human fields changed.');
  if (stableJson_(baseline.content) !== stableJson_(categoryContentV2_(ctx))) throw new Error('V2 public manifest content changed.');
  if (stableJson_(baseline.sources) !== stableJson_(categorySourcesV2_())) throw new Error('V2 source identities changed.');
  if (verifyHashes && stableJson_(baseline.hashes) !== stableJson_(categoryHashesV2_(Object.keys(baseline.hashes)))) throw new Error('V2 source bytes or native document metadata changed.');
  return baseline;
}

/** Verify ancestry, editor/public content, raw source bytes and native archive metadata. */
function categoryVerifyV2() {
  return categoryLockedV2_(function () {
    var ctx = categoryContextV2_(), state = categoryStateV2_(ctx);
    if (state.phase === 'resumed') throw new Error('Category migration already resumed.');
    categoryPauseV2_(ctx);
    state.phase = 'verifying'; delete state.verified_at; categorySaveStateV2_(ctx, state);
    var baseline = categoryCheckV2_(ctx, state, true);
    state.phase = 'verified'; state.verified_at = new Date().toISOString();
    categorySaveStateV2_(ctx, state);
    var nativeCount = Object.keys(baseline.hashes).filter(function (id) {
      return baseline.hashes[id].kind === 'native-metadata';
    }).length;
    console.log('V2 verified: ' + baseline.sources.length + ' unchanged projects; '
      + (Object.keys(baseline.hashes).length - nativeCount) + ' byte-identical raw files; '
      + nativeCount + ' unchanged native-document metadata contracts; human fields/public manifest unchanged; no build triggered.');
  });
}

/** Restore only previously present hourly sync and a non-production auto target. */
function categoryResumeV2() {
  return categoryLockedV2_(function () {
    var ctx = categoryContextV2_(), state = categoryStateV2_(ctx);
    if (state.phase === 'resumed') { console.log('V2 category migration already resumed.'); return; }
    if (state.phase !== 'verified' || !state.verified_at) throw new Error('Run categoryVerifyV2 successfully before resuming.');
    categoryCheckV2_(ctx, state, false);
    categoryPauseV2_(ctx);
    if (state.previous_sync_count > 0) ScriptApp.newTrigger('syncDrive').timeBased().everyHours(1).create();
    var target = state.previous_auto_target === 'preview' ? 'preview' : 'off';
    ctx.props.setProperty('AI4S_AUTO_PUBLISH_TARGET', target);
    state.phase = 'resumed'; state.resumed_at = new Date().toISOString(); state.restored_auto_target = target;
    categorySaveStateV2_(ctx, state);
    console.log('V2 hourly sync ' + (state.previous_sync_count > 0 ? 'restored' : 'remains absent')
      + '; automatic publishing=' + target + (state.previous_auto_target === 'production' ? '; prior production target kept off' : '')
      + '; no build triggered.');
  });
}
