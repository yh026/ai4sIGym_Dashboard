/**
 * Editor-only retirement of the original V2 backend. No Hook, Drive content,
 * Sheet content, credential or V3 setting is changed by these helpers.
 * The retirement marker is durable; there is intentionally no resume helper.
 */
var LEGACY_V2_RETIREMENT_PROPERTY = 'AI4S_LEGACY_RETIREMENT_V1';
var LEGACY_V2_RETIREMENT_SCRIPT_ID = '1rzHiAoGH3Ed8_I_c5YcqQk5Z-FGrfaO-idI4wr05yigoZaxZSod3sJTl';
var LEGACY_V2_RETIREMENT_SHEET_ID = '1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE';
var LEGACY_V2_RETIREMENT_ROOT_ID = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';

function legacyV2IsRetired_() {
  // A malformed/nonempty marker also fails closed for automatic publishing.
  return Boolean(PropertiesService.getScriptProperties().getProperty(LEGACY_V2_RETIREMENT_PROPERTY));
}

function legacyV2AssertActive_() {
  if (legacyV2IsRetired_()) throw new Error('This V2 backend is retired. Automation and publishing must remain disabled.');
}

function legacyV2RetirementContext_() {
  if (ScriptApp.getScriptId() !== LEGACY_V2_RETIREMENT_SCRIPT_ID) {
    throw new Error('Retirement is restricted to the original V2 Apps Script.');
  }
  var ss = registryV2Spreadsheet_();
  if (ss.getId() !== LEGACY_V2_RETIREMENT_SHEET_ID) {
    throw new Error('Retirement is restricted to the original V2 Registry Sheet.');
  }
  var cfg = registryV2OperationalConfig_(ss);
  if (folderIdFromUrl_(cfg.drive_folder_url) !== LEGACY_V2_RETIREMENT_ROOT_ID) {
    throw new Error('The original V2 Registry does not point to the expected AIS root.');
  }
  return { props: PropertiesService.getScriptProperties() };
}

function legacyV2RetirementState_(props) {
  var raw = props.getProperty(LEGACY_V2_RETIREMENT_PROPERTY);
  if (!raw) return null;
  var state = JSON.parse(raw);
  if (state.schema !== 1 || state.script_id !== LEGACY_V2_RETIREMENT_SCRIPT_ID
      || state.sheet_id !== LEGACY_V2_RETIREMENT_SHEET_ID || state.root_id !== LEGACY_V2_RETIREMENT_ROOT_ID) {
    throw new Error('Stored retirement state belongs to another backend or schema.');
  }
  return state;
}

function legacyV2RetirementTriggerRecords_() {
  return ScriptApp.getProjectTriggers().map(function (trigger) {
    return { handler: trigger.getHandlerFunction(), event_type: String(trigger.getEventType()),
      source: String(trigger.getTriggerSource()), unique_id: trigger.getUniqueId() };
  });
}

function legacyV2RetirementCheck_(props, state) {
  if (!state) throw new Error('The legacy retirement marker is missing.');
  var triggers = legacyV2RetirementTriggerRecords_();
  if (props.getProperty('AI4S_AUTO_PUBLISH_TARGET') !== 'off' || triggers.length) {
    throw new Error('Legacy retirement is incomplete: auto publishing must be off and installed triggers must be zero.');
  }
  return { ok: true, script_id: state.script_id, sheet_id: state.sheet_id,
    auto_publish_target: 'off', remaining_installed_triggers: 0,
    trigger_scope: 'executing-user', phase: state.phase };
}

/** Capture prior nonsecret automation state, disable it, and verify the result. */
function retireLegacyV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('A V2 operation is still running; retry retirement after it finishes.');
  try {
    var ctx = legacyV2RetirementContext_(), props = ctx.props;
    var state = legacyV2RetirementState_(props);
    if (!state) {
      var target = props.getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off';
      state = { schema: 1, script_id: LEGACY_V2_RETIREMENT_SCRIPT_ID,
        sheet_id: LEGACY_V2_RETIREMENT_SHEET_ID, root_id: LEGACY_V2_RETIREMENT_ROOT_ID,
        started_at: new Date().toISOString(), phase: 'retiring',
        previous_auto_publish_target: ['off', 'preview', 'production'].indexOf(target) >= 0 ? target : 'unrecognized',
        previous_triggers: legacyV2RetirementTriggerRecords_(), trigger_scope: 'executing-user' };
      // Persist the marker/baseline before any removal, including partial failures.
      props.setProperty(LEGACY_V2_RETIREMENT_PROPERTY, JSON.stringify(state));
    }
    props.setProperty('AI4S_AUTO_PUBLISH_TARGET', 'off');
    ScriptApp.getProjectTriggers().forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    legacyV2RetirementCheck_(props, state);
    state.phase = 'retired';
    if (!state.retired_at) state.retired_at = new Date().toISOString();
    state.last_verified_at = new Date().toISOString();
    props.setProperty(LEGACY_V2_RETIREMENT_PROPERTY, JSON.stringify(state));
    var result = legacyV2RetirementCheck_(props, state);
    console.log(JSON.stringify(result));
    return result;
  } finally { lock.releaseLock(); }
}

/** Read-only verification; this never reinstalls or re-enables anything. */
function verifyLegacyV2Retirement() {
  var ctx = legacyV2RetirementContext_(), state = legacyV2RetirementState_(ctx.props);
  var result = legacyV2RetirementCheck_(ctx.props, state);
  if (state.phase !== 'retired') throw new Error('Retirement has not completed successfully; rerun retireLegacyV2.');
  console.log(JSON.stringify(result));
  return result;
}
