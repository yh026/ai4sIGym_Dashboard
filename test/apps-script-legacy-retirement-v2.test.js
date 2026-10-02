'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helper = fs.readFileSync(path.join(__dirname, '../google-apps-script/migration/LegacyV2Retirement.gs'), 'utf8');
const SCRIPT = '1rzHiAoGH3Ed8_I_c5YcqQk5Z-FGrfaO-idI4wr05yigoZaxZSod3sJTl';
const SHEET = '1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE';
const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
const KEY = 'AI4S_LEGACY_RETIREMENT_V1';
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
  const props = { AI4S_AUTO_PUBLISH_TARGET: 'preview', AI4S_API_TOKEN: 'never-export-this',
    AI4S_DATED_ARCHIVES_V1: 'original archive baseline', AI4S_CATEGORY_MIGRATION_V1: 'original category baseline' };
  const state = { script: SCRIPT, sheet: SHEET, root: ROOT, locked: false, lockAvailable: true,
    triggers: [{ handler: 'syncDrive', id: 'hourly-trigger' }], failDelete: false, writes: [], logs: [], ...overrides };
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] ?? null,
      setProperty: (key, value) => { state.writes.push(key); props[key] = value; } }) },
    ScriptApp: { getScriptId: () => state.script,
      getProjectTriggers: () => state.triggers.map(t => ({
        getHandlerFunction: () => t.handler, getEventType: () => 'CLOCK',
        getTriggerSource: () => 'CLOCK', getUniqueId: () => t.id,
      })),
      deleteTrigger: t => {
        if (state.failDelete) throw new Error('Trigger deletion unavailable');
        state.triggers = state.triggers.filter(existing => existing.id !== t.getUniqueId());
      },
    },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (state.lockAvailable) state.locked = true; return state.lockAvailable; },
      releaseLock: () => { state.locked = false; },
    }) },
    registryV2Spreadsheet_: () => ({ getId: () => state.sheet }),
    registryV2OperationalConfig_: () => ({ drive_folder_url: state.root }),
    folderIdFromUrl_: value => value,
    console: { log: value => state.logs.push(value) },
  });
  vm.runInContext(helper, ctx);
  return { ctx, props, state };
}

test('retirement records the existing hourly automation without secrets and disables it', () => {
  const h = fixture();
  const result = h.ctx.retireLegacyV2();
  assert.equal(result.ok, true);
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.equal(h.state.triggers.length, 0);
  assert.equal(h.state.locked, false);
  const saved = JSON.parse(h.props[KEY]);
  assert.equal(saved.previous_auto_publish_target, 'preview');
  assert.deepEqual(saved.previous_triggers, [{ handler: 'syncDrive', event_type: 'CLOCK', source: 'CLOCK', unique_id: 'hourly-trigger' }]);
  assert.equal(saved.trigger_scope, 'executing-user');
  assert.equal(saved.phase, 'retired');
  assert.ok(saved.retired_at);
  assert.equal(h.props.AI4S_API_TOKEN, 'never-export-this');
  assert.equal(h.props.AI4S_DATED_ARCHIVES_V1, 'original archive baseline');
  assert.equal(h.props.AI4S_CATEGORY_MIGRATION_V1, 'original category baseline');
  assert.doesNotMatch(h.props[KEY] + h.state.logs.join(''), /never-export-this/);
  assert.deepEqual([...new Set(h.state.writes)].sort(), ['AI4S_AUTO_PUBLISH_TARGET', KEY].sort());
});

test('retirement is idempotent and preserves the first baseline when a trigger reappears', () => {
  const h = fixture(); h.ctx.retireLegacyV2();
  const before = JSON.parse(h.props[KEY]);
  h.state.triggers.push({ handler: 'syncDrive', id: 'unexpected-new-trigger' });
  h.props.AI4S_AUTO_PUBLISH_TARGET = 'production';
  h.ctx.retireLegacyV2();
  const after = JSON.parse(h.props[KEY]);
  assert.deepEqual(after.previous_triggers, before.previous_triggers);
  assert.equal(after.previous_auto_publish_target, 'preview');
  assert.equal(after.retired_at, before.retired_at);
  assert.equal(h.state.triggers.length, 0);
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
});

test('retirement removes every installed legacy trigger and never restores an unsafe target', () => {
  const h = fixture({ triggers: [{ handler: 'syncDrive', id: 'a' }, { handler: 'publishSite', id: 'b' }] });
  h.props.AI4S_AUTO_PUBLISH_TARGET = 'production';
  h.ctx.retireLegacyV2();
  assert.equal(h.state.triggers.length, 0);
  assert.equal(JSON.parse(h.props[KEY]).previous_auto_publish_target, 'production');
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.throws(() => h.ctx.legacyV2AssertActive_(), /retired/);
});

for (const [key, wrong] of [['script', 'v3-script'], ['sheet', 'v3-sheet'], ['root', 'another-root']]) {
  test(`wrong ${key} is rejected before any mutation`, () => {
    const h = fixture({ [key]: wrong });
    assert.throws(() => h.ctx.retireLegacyV2(), /restricted|expected AIS root/);
    assert.equal(h.state.writes.length, 0);
    assert.equal(h.state.triggers.length, 1);
    assert.equal(h.state.locked, false);
  });
}

test('a running operation blocks retirement before any mutation', () => {
  const h = fixture({ lockAvailable: false });
  assert.throws(() => h.ctx.retireLegacyV2(), /still running/);
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.triggers.length, 1);
});

test('partial failure leaves auto publishing off and the durable baseline for a safe retry', () => {
  const h = fixture({ failDelete: true });
  assert.throws(() => h.ctx.retireLegacyV2(), /deletion unavailable/);
  assert.equal(h.props.AI4S_AUTO_PUBLISH_TARGET, 'off');
  assert.equal(JSON.parse(h.props[KEY]).phase, 'retiring');
  assert.equal(h.state.locked, false);
  assert.throws(() => h.ctx.verifyLegacyV2Retirement(), /incomplete/);
  h.state.failDelete = false;
  h.ctx.retireLegacyV2();
  assert.equal(h.ctx.verifyLegacyV2Retirement().ok, true);
});

test('verification only reads state and rejects missing state, new triggers, or auto publishing', () => {
  const h = fixture();
  assert.throws(() => h.ctx.verifyLegacyV2Retirement(), /marker is missing/);
  h.ctx.retireLegacyV2();
  const originalWrites = h.state.writes.length;
  assert.equal(h.ctx.verifyLegacyV2Retirement().ok, true);
  assert.equal(h.state.writes.length, originalWrites);
  h.state.triggers.push({ handler: 'syncDrive', id: 'new' });
  assert.throws(() => h.ctx.verifyLegacyV2Retirement(), /incomplete/);
  h.state.triggers = [];
  h.props.AI4S_AUTO_PUBLISH_TARGET = 'preview';
  assert.throws(() => h.ctx.verifyLegacyV2Retirement(), /incomplete/);
  assert.equal(h.state.writes.length, originalWrites);
});

test('malformed retirement state fails closed without overwriting the original evidence', () => {
  const h = fixture();
  h.props[KEY] = '{invalid';
  assert.throws(() => h.ctx.legacyV2AssertActive_(), /retired/);
  assert.throws(() => h.ctx.retireLegacyV2());
  assert.equal(h.props[KEY], '{invalid');
  assert.equal(h.state.writes.length, 0);
});

test('helper has no network, file, Sheet-write or bulk credential access API', () => {
  assert.doesNotMatch(helper, /UrlFetchApp|DriveApp|setValues?\s*\(|getProperties\s*\(|newTrigger\s*\(/);
  assert.equal(fixture().ctx.legacyV2IsRetired_(), false);
});
