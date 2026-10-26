/** AIS Registry daily controls and staged project publishing. */
var REGISTRY_UI_BUTTON_ARTWORK = __AIS_CONTROL_BUTTON_ARTWORK__;
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
    .addSeparator()
    .addItem('Update preview', 'registryPublishingUpdatePreviewFromMenu')
    .addItem('Publish to production', 'registryPublishingReviewProductionFromMenu')
    .addItem('Refresh status', 'registryPublishingRefreshStatusFromMenu')
    .addSubMenu(ui.createMenu('Advanced tables')
      .addItem('Project metadata', 'registryUiShowProjects')
      .addItem('Page sources', 'registryUiShowPages')
      .addItem('Website assets', 'registryUiShowResources')
      .addItem('Data and instrument options', 'registryUiShowOptions')
      .addItem('Development versions', 'registryUiShowVersions'))
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Return to daily view', 'registryUiReturnToDailyView')
      .addItem('Restore action buttons', 'registryUiInstallActionButtons')
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

/** Explicit, repeatable presentation installation; never runs a build or edits project data. */
function registryUiInstallActionButtons() {
  var panel = registryPublishingPanel_();
  if (panel.getSheetId() !== REGISTRY_UI.controlSheetId) throw new Error('The control panel has an unexpected identity.');
  var row = panel.getRange('A4:L4');
  if (row.getValues()[0].concat(row.getFormulas()[0]).some(function(value) { return value !== ''; })) {
    throw new Error('The action row A4:L4 contains content. Move it before installing buttons.');
  }
  var actions = [
    {key: 'preview', label: '更新预览', anchor: 'A4', column: 1, script: 'registryPublishingUpdatePreviewFromMenu'},
    {key: 'production', label: '发布正式版', anchor: 'E4', column: 5, script: 'registryUiPublishProductionDialog'},
    {key: 'refresh', label: '刷新状态', anchor: 'I4', column: 9, script: 'registryPublishingRefreshStatusFromMenu'}
  ];
  // Validate all embedded assets before making any worksheet change.
  actions.forEach(function(action) {
    var bytes = Utilities.base64Decode(REGISTRY_UI_BUTTON_ARTWORK[action.key] || '');
    var signature = bytes.slice(0, 8).map(function(value) { return value & 255; }).join(',');
    if (bytes.length < 100 || bytes.length > 200000 || signature !== '137,80,78,71,13,10,26,10') {
      throw new Error('Invalid action-button artwork: ' + action.key);
    }
    action.blob = Utilities.newBlob(bytes, 'image/png', 'ais-' + action.key + '.png');
    action.title = 'AIS_CONTROL_ACTION_' + action.key.toUpperCase() + '_V1';
  });
  var existing = panel.getImages(), duplicates = [];
  if (panel.getRowHeight(4) < 56) panel.setRowHeight(4, 56);
  actions.forEach(function(action) {
    var owned = existing.filter(function(image) { return image.getAltTextTitle() === action.title; });
    var button = owned.length ? owned[0].replace(action.blob) : panel.insertImage(action.blob, action.column, 4, 8, 10);
    button.setAltTextTitle(action.title).setAltTextDescription(action.label)
      .setAnchorCell(panel.getRange(action.anchor)).setAnchorCellXOffset(8).setAnchorCellYOffset(10)
      .setWidth(220).setHeight(36).assignScript(action.script);
    if (button.getScript() !== action.script) throw new Error('The action button could not be assigned: ' + action.key);
    duplicates = duplicates.concat(owned.slice(1));
  });
  // Remove only known installer-owned controls, after all three bindings are verified.
  existing.filter(function(image) { return image.getAltTextTitle() === 'AIS_REGISTRY_ACTION_BUTTON_V1'; })
    .concat(duplicates).forEach(function(image) { image.remove(); });
  var result = {buttons: actions.map(function(action) { return {anchor: action.anchor, action: action.script}; })};
  console.log(JSON.stringify(result));
  return result;
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


/** Native confirmation also works when Sheets cannot load the HTML sidebar.
 * No lock is held while the operator reads the dialog. Confirm revalidates all
 * pinned sources and selections and never retries an uncertain hook response.
 */
function registryUiPublishProductionDialog() {
  registryUiSpreadsheet_();
  var ui=SpreadsheetApp.getUi();
  try {
    var review=registryPublishingReviewProduction();
    if(!review.production_enabled) {
      ui.alert('Publish to production',review.production_disabled_reason||'Publishing is unavailable.',ui.ButtonSet.OK);return;
    }
    var lines=review.changes.filter(function(c){return ['Add','Update','Remove'].indexOf(c.action)!==-1;})
      .map(function(c){return c.action+': '+(c.title||c.demo_id);});
    var answer=ui.alert('Publish to production?',lines.join('\n')+
      '\n\nPublish these selected changes from the develop preview you checked? No or Close cancels.',ui.ButtonSet.YES_NO);
    if(answer!==ui.Button.YES)return;
    var result=registryPublishingConfirmProduction(review.id);
    ui.alert('Publish to production',result.message,ui.ButtonSet.OK);
  } catch(error) {
    ui.alert('Publish to production',registryUiMessage_(error)+'\n\nUse Refresh status before trying again.',ui.ButtonSet.OK);
  }
}
