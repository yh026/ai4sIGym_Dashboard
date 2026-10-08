/** AIS Registry daily controls and staged project publishing. */
var REGISTRY_UI = {
  controlSheetId: 202609250,
  stateSheet: '_ControlState',
  stateProperty: 'AIS_REGISTRY_UI_STATE_V1',
  previewUrl: 'https://develop--aisigym.netlify.app/',
  productionUrl: 'https://aisigym.netlify.app/',
  productionReceiptUrl: 'https://aisigym.netlify.app/deploy-receipt.json',
  keys: ['preview_state', 'preview_checked_at', 'last_sync_at', 'last_sync_result',
    'last_error', 'production_deploy', 'production_checked_at', 'automation']
};

function registryUiOnOpen_() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('AIS Control')
    .addItem('Open control panel', 'registryUiOpenControlPanel')
    .addItem('Open actions', 'registryUiOpenSidebar')
    .addSeparator()
    .addItem('Update preview', 'registryPublishingUpdatePreviewFromMenu')
    .addItem('Review changes', 'registryPublishingReviewProductionFromMenu')
    .addItem('Refresh status', 'registryPublishingRefreshStatusFromMenu')
    .addSubMenu(ui.createMenu('Advanced tables')
      .addItem('Project metadata', 'registryUiShowProjects')
      .addItem('Page sources', 'registryUiShowPages')
      .addItem('Website assets', 'registryUiShowResources')
      .addItem('Data and instrument options', 'registryUiShowOptions')
      .addItem('Development versions', 'registryUiShowVersions'))
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Return to daily view', 'registryUiReturnToDailyView')
      .addSeparator()
      .addItem('Validate and sync only', 'syncSandbox')
      .addItem('Retry failed or unverified preview', 'retryPreviewAfterFailure')
      .addItem('Enable hourly status checks', 'registryManualEnableStatusChecks')
      .addItem('Disable hourly status checks', 'disableSandboxAutomation')
      .addSeparator()
      .addItem('Initialize backend', 'initializeSandbox')
      .addItem('Import pilot projects', 'importPilot')
      .addItem('Import next project', 'importNextProject'))
    .addToUi();
  // Simple onOpen: no Drive reads, network requests, sync, state writes or triggers.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getId() !== SANDBOX.spreadsheet_id) return;
  var sheet = ss.getSheets().filter(function(s) { return s.getSheetId() === REGISTRY_UI.controlSheetId; })[0];
  if (sheet) ss.setActiveSheet(sheet);
}

function registryUiSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SANDBOX.spreadsheet_id);
  if (ss.getId() !== SANDBOX.spreadsheet_id) throw new Error('Open the AIS Instrumentation Gym Registry first.');
  return ss;
}

function registryUiOpenControlPanel() {
  var ss = registryUiSpreadsheet_();
  var sheet = ss.getSheets().filter(function(s) { return s.getSheetId() === REGISTRY_UI.controlSheetId; })[0];
  if (!sheet) throw new Error('The control panel is not installed.');
  ss.setActiveSheet(sheet);
}

/** Explicit workbook-level visibility change; never called from onOpen. */
function registryUiReturnToDailyView() {
  var ss = registryUiSpreadsheet_();
  var panel = ss.getSheets().filter(function(s) { return s.getSheetId() === REGISTRY_UI.controlSheetId; })[0];
  if (!panel) throw new Error('The control panel is not installed.');
  panel.showSheet();
  ss.setActiveSheet(panel);
  ['Pages', 'Resources', 'Versions', 'Options'].forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (sheet && sheet.getSheetId() !== panel.getSheetId() && !sheet.isSheetHidden()) sheet.hideSheet();
  });
  ss.toast('Advanced tables hidden. Daily controls are ready.', 'AIS Control', 5);
}

/** One-time presentation installation, using an embedded PNG with no network asset. */
function registryUiInstallActionButton() {
  var ss = registryUiSpreadsheet_();
  var panel = ss.getSheets().filter(function(s) { return s.getSheetId() === REGISTRY_UI.controlSheetId; })[0];
  if (!panel) throw new Error('The control panel is not installed.');
  var cell = panel.getRange('A3'), label = cell.getDisplayValue();
  if (!['', 'Edit projects', 'Open actions'].includes(label)) throw new Error('The action-button cell contains unexpected content.');
  var title = 'AIS_REGISTRY_ACTION_BUTTON_V1';
  var owned = panel.getImages().filter(function(image) { return image.getAltTextTitle() === title; });
  var bytes = Utilities.base64Decode(REGISTRY_UI_ACTION_BUTTON_PNG);
  if (bytes.length < 100 || bytes.length > 200000) throw new Error('The embedded action-button image is invalid.');
  var blob = Utilities.newBlob(bytes, 'image/png', 'ais-open-actions.png');
  var button = owned.length ? owned[0].replace(blob) : panel.insertImage(blob, 1, 3, 8, 2);
  button.setAltTextTitle(title).setAltTextDescription('Open AIS Control actions')
    .setAnchorCell(cell).setAnchorCellXOffset(8).setAnchorCellYOffset(2)
    .setWidth(376).setHeight(30).assignScript('registryUiOpenSidebar');
  if (button.getScript() !== 'registryUiOpenSidebar') throw new Error('The action button could not be assigned.');
  // Only remove additional images bearing this exact installer-owned marker.
  owned.slice(1).forEach(function(image) { image.remove(); });
  cell.clearContent().setNote('Open the AIS Control actions sidebar. This button does not run a build.');
  return {result: owned.length ? 'updated' : 'installed', anchor: 'A3',
    action: 'registryUiOpenSidebar', width: 376, height: 30, removed_owned_duplicates: Math.max(0, owned.length - 1)};
}

function registryUiShowSheet_(name) {
  var ss = registryUiSpreadsheet_(), sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('The ' + name + ' table is missing.');
  sheet.showSheet();
  ss.setActiveSheet(sheet);
}
function registryUiShowProjects() { registryUiShowSheet_('Projects'); }
function registryUiShowPages() { registryUiShowSheet_('Pages'); }
function registryUiShowResources() { registryUiShowSheet_('Resources'); }
function registryUiShowOptions() { registryUiShowSheet_('Options'); }
function registryUiShowVersions() { registryUiShowSheet_('Versions'); }

function registryUiStored_() {
  var value = PropertiesService.getScriptProperties().getProperty(REGISTRY_UI.stateProperty);
  if (!value) return {};
  try { var result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : {}; }
  catch (_) { return {}; }
}
function registryUiSave_(value) {
  PropertiesService.getScriptProperties().setProperty(REGISTRY_UI.stateProperty, JSON.stringify(value));
}
function registryUiPatch_(patch) {
  // Only this short property merge holds the shared lock; never include network I/O.
  return locked_(function() {
    var current = registryUiStored_();
    Object.keys(patch).forEach(function(key) { current[key] = patch[key]; });
    registryUiSave_(current);
    return current;
  });
}
function registryUiMessage_(value) {
  return String(value && value.message || value || '')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[link]')
    .replace(/\b(token|secret|signature|authorization|api[_ -]?key|hook)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 220);
}
function registryUiTime_(value) {
  var time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function registryUiPhase_(phase) {
  return ({ready: 'Preview ready', requested: 'Preview requested', accepted: 'Awaiting verified preview',
    failed: 'Preview request failed', replaced: 'Preview needs verification',
    'retry-approved': 'Preview retry approved'})[phase] || 'Not built';
}
function registryUiLatestSync_(ss, stored) {
  var result = {at: registryUiTime_(stored.last_sync_at), result: registryUiMessage_(stored.last_sync_result)};
  var sheet = ss.getSheetByName('_SandboxAudit');
  if (!sheet) return result;
  var rows = sheet.getDataRange().getValues();
  for (var i = rows.length - 1; i > 0; i--) {
    if (rows[i][1] !== 'sync') continue;
    var at = registryUiTime_(rows[i][0]);
    if (at && (!result.at || at > result.at)) result = {at: at, result: 'Validated and synced'};
    break;
  }
  return result;
}

/** Returns only presentation fields; never returns tokens, hooks or raw state. */
function registryUiLegacyGetStatus_() {
  var ss = registryUiSpreadsheet_(), stored = registryUiStored_(), state = previewState_();
  var sync = registryUiLatestSync_(ss, stored);
  var target = PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET');
  var triggerCount = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'hourlySandbox'; }).length;
  var automation = target === 'preview' && triggerCount === 1 ? 'Hourly preview sync enabled'
    : target === 'preview' ? 'Hourly preview sync needs checking (' + triggerCount + ' triggers)'
    : 'Hourly preview sync disabled';
  return {
    phase: ['ready', 'requested', 'accepted', 'failed', 'replaced', 'retry-approved'].includes(state.phase) ? state.phase : '',
    preview_state: registryUiPhase_(state.phase),
    preview_checked_at: new Date().toISOString(),
    preview_ready_at: registryUiTime_(state.ready_at),
    preview_deploy: /^[a-f0-9]{24}$/.test(state.deploy_id || '') ? state.deploy_id : '',
    last_sync_at: sync.at, last_sync_result: sync.result || 'No sync recorded',
    last_error: registryUiMessage_(stored.last_error),
    production_deploy: /^[a-f0-9]{24}$/.test(stored.production_deploy || '') ? stored.production_deploy : '',
    production_checked_at: registryUiTime_(stored.production_checked_at),
    production_warning: registryUiMessage_(stored.production_warning),
    automation: automation, preview_url: REGISTRY_UI.previewUrl, production_url: REGISTRY_UI.productionUrl
  };
}

function registryUiStateSheet_() {
  var sheet = registryUiSpreadsheet_().getSheetByName(REGISTRY_UI.stateSheet);
  if (!sheet) throw new Error('The control state table is not installed.');
  var headers = sheet.getRange(1, 1, 1, 3).getValues()[0];
  if (headers.join('|') !== 'Key|Value|Checked at') throw new Error('The control state table has unexpected headers.');
  return sheet;
}
function registryUiLegacyWriteStatus_(status) {
  var sheet = registryUiStateSheet_(), checked = status.preview_checked_at;
  var rows = [['Key', 'Value', 'Checked at']].concat(REGISTRY_UI.keys.map(function(key) {
    var value = status[key] || '';
    // Force literal text, including backend error messages from external content.
    if (/^[=+@-]/.test(String(value))) value = "'" + value;
    var at = key.indexOf('production_') === 0 ? status.production_checked_at : checked;
    return [key, value, at || ''];
  }));
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  return status;
}

/** Explicit refresh checks the public production receipt by GET only. */
function registryUiRefreshStatus() { return registryPublishingRefreshStatus(); }

function registryUiUpdatePreview() { return registryPublishingUpdatePreview(); }

function registryUiUpdatePreviewFromMenu() {
  var status = registryUiUpdatePreview();
  registryUiSpreadsheet_().toast(status.last_sync_result + '. ' + status.preview_state + '.', 'AIS Control', 8);
}
function registryUiRefreshStatusFromMenu() {
  var status = registryUiRefreshStatus();
  registryUiSpreadsheet_().toast(status.preview_state + '. ' + (status.production_warning || 'Status refreshed.'), 'AIS Control', 8);
}

function registryUiOpenSidebar() {
  registryUiSpreadsheet_();
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(registryUiSidebarHtml_()).setTitle('AIS Control'));
}
function registryUiSidebarHtml_() { return __AIS_SIDEBAR_HTML__; }

// Embedded local button artwork: 376 x 30 pixels, no external image request.
var REGISTRY_UI_ACTION_BUTTON_PNG = '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';

