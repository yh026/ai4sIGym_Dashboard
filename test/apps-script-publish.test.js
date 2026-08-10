const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAppsScript() {
  const filename = path.join(__dirname, '..', 'google-apps-script', 'Code.gs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

function columnNumber(letters) {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => (
      Array.from({ length: this.columnCount }, (_, columnOffset) => (
        this.sheet.valueAt(this.row + rowOffset, this.column + columnOffset)
      ))
    ));
  }

  getFormulas() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => (
      Array.from({ length: this.columnCount }, (_, columnOffset) => (
        this.sheet.formulaAt(this.row + rowOffset, this.column + columnOffset)
      ))
    ));
  }

  setValues(rows) {
    rows.forEach((values, rowOffset) => values.forEach((value, columnOffset) => {
      this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, value);
    }));
    return this;
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.column, value);
    return this;
  }

  setFontWeight() { return this; }
  setBackground() { return this; }
  setNote() { return this; }
  setDataValidation() { return this; }
}

class FakeSheet {
  constructor(rows, formulas = {}) {
    this.cells = rows.map(row => row.slice());
    this.formulas = { ...formulas };
  }

  valueAt(row, column) {
    return this.cells[row - 1]?.[column - 1] ?? '';
  }

  formulaAt(row, column) {
    return this.formulas[`${row}:${column}`] || '';
  }

  setCell(row, column, value) {
    while (this.cells.length < row) this.cells.push([]);
    while (this.cells[row - 1].length < column) this.cells[row - 1].push('');
    this.cells[row - 1][column - 1] = value;
    const key = `${row}:${column}`;
    if (typeof value === 'string' && value.startsWith('=')) this.formulas[key] = value;
    else delete this.formulas[key];
  }

  getLastRow() {
    let last = 0;
    this.cells.forEach((row, index) => {
      if (row.some(value => value !== '' && value != null)) last = index + 1;
    });
    return last;
  }

  getRange(rowOrA1, column, rowCount, columnCount) {
    if (typeof rowOrA1 === 'string') {
      const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(rowOrA1);
      assert.ok(match, `unsupported fake A1 range: ${rowOrA1}`);
      const startColumn = columnNumber(match[1]);
      const startRow = Number(match[2]);
      const endColumn = match[3] ? columnNumber(match[3]) : startColumn;
      const endRow = match[4] ? Number(match[4]) : startRow;
      return new FakeRange(this, startRow, startColumn,
        endRow - startRow + 1, endColumn - startColumn + 1);
    }
    return new FakeRange(this, rowOrA1, column, rowCount, columnCount);
  }

  setColumnWidth() {}
}

function fakeSpreadsheetApp() {
  return {
    newDataValidation() {
      return {
        requireValueInList() { return this; },
        setAllowInvalid() { return this; },
        build() { return {}; },
      };
    },
  };
}

function fakeUtilities(uuid = '11111111-2222-4333-8444-555555555555') {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest(),
        byte => (byte > 127 ? byte - 256 : byte));
    },
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    getUuid: () => uuid,
  };
}

function fakeScriptProperties(initial = {}) {
  const values = { ...initial };
  return {
    values,
    service: {
      getScriptProperties() {
        return {
          getProperty: key => values[key] ?? null,
          setProperty(key, value) { values[key] = String(value); return this; },
        };
      },
    },
  };
}

const PRODUCTION_HOOK = 'https://api.netlify.com/build_hooks/production123';
const PREVIEW_HOOK = 'https://api.netlify.com/build_hooks/preview123';
const PREVIEW_BRANCH = 'develop';

test('Apps Script accepts develop and builds a preview request', () => {
  const script = loadAppsScript();
  const request = script.configuredBuildRequest_({
    netlify_build_hook: PRODUCTION_HOOK,
    netlify_preview_build_hook: PREVIEW_HOOK,
    production_branch: 'main',
    preview_branch: PREVIEW_BRANCH,
  }, 'preview');

  assert.equal(request.ok, true);
  assert.equal(request.branch, PREVIEW_BRANCH);
  assert.match(request.hookUrl, /^https:\/\/api\.netlify\.com\/build_hooks\/preview123\?/);
  assert.match(request.hookUrl, /trigger_branch=develop/);
  assert.doesNotMatch(request.hookUrl, /production123/);
});

test('Apps Script still encodes approved prefixed preview branches', () => {
  const script = loadAppsScript();
  const request = script.configuredBuildRequest_({
    netlify_preview_build_hook: PREVIEW_HOOK,
    production_branch: 'main',
    preview_branch: 'feature/encoded-preview',
  }, 'preview');

  assert.equal(request.ok, true);
  assert.equal(request.branch, 'feature/encoded-preview');
  assert.match(request.hookUrl, /trigger_branch=feature%2Fencoded-preview/);
});

test('preview refuses production and query-injection branch names', () => {
  const script = loadAppsScript();
  for (const branch of [
    '',
    'main',
    'MAIN',
    'master',
    'feature/a&trigger_branch=main',
    'feature/foo//bar',
    'feature/foo..bar',
    'feature/.hidden',
    'feature/end.',
    'unapproved-branch',
  ]) {
    const request = script.configuredBuildRequest_({
      netlify_preview_build_hook: PREVIEW_HOOK,
      production_branch: 'main',
      preview_branch: branch,
    }, 'preview');
    assert.equal(request.ok, false, branch || '(empty)');
  }
});

test('preview never falls back to the production Hook', () => {
  const script = loadAppsScript();
  const request = script.configuredBuildRequest_({
    netlify_build_hook: PRODUCTION_HOOK,
    production_branch: 'main',
    preview_branch: PREVIEW_BRANCH,
  }, 'preview');

  assert.equal(request.ok, false);
  assert.match(request.error, /netlify_preview_build_hook/);
});

test('production is locked to main and ignores preview settings', () => {
  const script = loadAppsScript();
  const request = script.configuredBuildRequest_({
    netlify_build_hook: PRODUCTION_HOOK,
    netlify_preview_build_hook: PREVIEW_HOOK,
    production_branch: 'main',
    preview_branch: PREVIEW_BRANCH,
  }, 'production');

  assert.equal(request.ok, true);
  assert.equal(request.branch, 'main');
  assert.match(request.hookUrl, /build_hooks\/production123/);
  assert.match(request.hookUrl, /trigger_branch=main/);
  assert.doesNotMatch(request.hookUrl, /preview123/);

  const unsafe = script.configuredBuildRequest_({
    netlify_build_hook: PRODUCTION_HOOK,
    production_branch: PREVIEW_BRANCH,
  }, 'production');
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error, /locked to main/);
});

test('Build Hook configuration accepts only a base Netlify Hook URL', () => {
  const script = loadAppsScript();
  assert.equal(script.buildHookUrlError_(PREVIEW_HOOK), '');
  assert.match(script.buildHookUrlError_(`${PREVIEW_HOOK}?trigger_branch=main`), /base/);
  assert.match(script.buildHookUrlError_('https://example.com/deploy'), /Build Hook/);
});

test('legacy auto_publish=yes remains safe-off until a target is explicit', () => {
  const script = loadAppsScript();
  assert.equal(script.autoPublishTarget_({ auto_publish: 'yes' }), 'off');
  assert.equal(script.autoPublishTarget_({ auto_publish_target: 'preview' }), 'preview');
  assert.equal(script.autoPublishTarget_({ auto_publish_target: 'production' }), 'off');
  assert.equal(script.autoPublishTarget_({ auto_publish_target: 'anything' }), 'off');
});

test('preview URL is shown only when it belongs to the configured preview branch', () => {
  const script = loadAppsScript();
  const url = 'https://example-preview.netlify.app/';

  assert.equal(script.previewUrlError_(PREVIEW_BRANCH, url, PREVIEW_BRANCH, 'main'), '');
  assert.match(
    script.previewUrlError_(PREVIEW_BRANCH, url, 'feature/another-preview', 'main'),
    /but preview_branch is/,
  );
  assert.match(script.previewUrlError_(PREVIEW_BRANCH, url, '', 'main'), /preview_url_branch/);
  assert.match(script.previewUrlError_('main', url, 'main', 'main'), /refuses/);
});

test('Registry URL safely encodes a migrated custom access token', () => {
  const script = loadAppsScript();
  assert.equal(
    script.registryUrl_('https://script.google.com/macros/s/example/exec', 'a+b&c#d'),
    'https://script.google.com/macros/s/example/exec?token=a%2Bb%26c%23d',
  );
});

test('Registry audience is closed and defaults safely to Production', () => {
  const script = loadAppsScript();

  assert.equal(script.registryAudience_('').value, 'production');
  assert.equal(script.registryAudience_('production').value, 'production');
  assert.equal(script.registryAudience_('preview').value, 'preview');
  assert.equal(script.registryAudience_('PREVIEW').value, 'preview');
  assert.equal(script.registryAudience_('all').ok, false);
  assert.equal(script.registryAudience_('unknown').ok, false);
});

test('Registry visibility uses the same safe status matrix for manifest and files', () => {
  const script = loadAppsScript();
  const rows = [
    { id: 'live', status: 'Live', file_check: 'ok' },
    { id: 'draft', status: 'Draft', file_check: 'ok — no provenance.md' },
    { id: 'archived', status: 'Archived', file_check: 'ok' },
    { id: 'missing', status: 'Live', file_check: 'missing' },
    { id: 'unreadable', status: 'Live', file_check: 'ok — page unreadable' },
    { id: 'unknown', status: 'Published', file_check: 'ok' },
  ];

  assert.deepEqual(
    rows.filter(row => script.registryDemoVisible_(row, 'production')).map(row => row.id),
    ['live'],
  );
  assert.deepEqual(
    rows.filter(row => script.registryDemoVisible_(row, 'preview')).map(row => row.id),
    ['live', 'draft'],
  );
});

test('Registry revision is deterministic, audience-scoped, and excludes generated time', () => {
  const script = loadAppsScript();
  script.Utilities = fakeUtilities();
  script.readCategories_ = () => ['Physics', 'Biology'];

  let demos = [{
    title: 'Draft demo', status: 'Draft', file_check: 'ok', file_id: 'draft-id',
    last_modified: '2026-08-11T01:02:03.000Z', picture_file_id: '',
  }];
  script.readDemos_ = () => demos;
  const cfg = { site_title: 'Gym', site_tagline: 'Preview safely' };

  const first = script.registrySnapshot_({}, cfg, 'preview');
  demos = [{
    picture_file_id: '', last_modified: '2026-08-11T01:02:03.000Z',
    file_id: 'draft-id', file_check: 'ok', status: 'Draft', title: 'Draft demo',
  }];
  const reorderedKeys = script.registrySnapshot_({}, cfg, 'preview');
  const production = script.registrySnapshot_({}, cfg, 'production');
  demos[0].title = 'Changed title';
  const changed = script.registrySnapshot_({}, cfg, 'preview');

  assert.match(first.registry_revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.registry_revision, reorderedKeys.registry_revision);
  assert.notEqual(first.registry_revision, production.registry_revision);
  assert.notEqual(first.registry_revision, changed.registry_revision);
  assert.deepEqual(Array.from(production.demos), []);
});

test('Registry endpoint never lets legacy status=all bypass its audience', () => {
  const script = loadAppsScript();
  const syncedAt = '2026-08-11T00:00:00.000Z';
  const demos = [
    { status: 'Live', file_id: 'live-id', picture_file_id: '', file_check: 'ok',
      last_modified: syncedAt },
    { status: 'Draft', file_id: 'draft-id', picture_file_id: 'draft-picture-id',
      file_check: 'ok', last_modified: syncedAt },
    { status: 'Archived', file_id: 'archived-id', picture_file_id: '', file_check: 'ok',
      last_modified: syncedAt },
  ];
  let demoReads = 0;
  script.registrySpreadsheet_ = () => ({});
  script.readConfig_ = () => ({ access_token: 'secret' });
  script.readCategories_ = () => [];
  script.readDemos_ = () => { demoReads += 1; return demos; };
  script.jsonOut_ = value => value;
  let driveReads = 0;
  let blobReads = 0;
  const driveStamps = {};
  script.registryDriveFile_ = (cfg, id) => {
    driveReads += 1;
    return ({
      getLastUpdated: () => new Date(driveStamps[id] || syncedAt),
      getBlob: () => {
        blobReads += 1;
        return ({
          getDataAsString: () => `<html>${id}</html>`,
          getContentType: () => 'text/html',
          getBytes: () => [],
        });
      },
    });
  };
  script.Utilities = fakeUtilities();
  script.Utilities.base64Encode = () => 'encoded-picture';

  const production = script.doGet({ parameter: {
    token: 'secret', action: 'manifest', status: 'all',
  } });
  assert.equal(production.ok, true);
  assert.equal(production.audience, 'production');
  assert.deepEqual(Array.from(production.demos, demo => demo.file_id), ['live-id']);

  const preview = script.doGet({ parameter: {
    token: 'secret', action: 'manifest', audience: 'preview',
  } });
  assert.deepEqual(Array.from(preview.demos, demo => demo.file_id), ['live-id', 'draft-id']);
  assert.match(preview.registry_revision, /^sha256:[0-9a-f]{64}$/);

  const productionDraftFile = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-id',
  } });
  assert.equal(productionDraftFile.ok, false);
  assert.equal(productionDraftFile.error, 'unknown file id');

  const previewDraftFile = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-id', audience: 'preview',
  } });
  assert.equal(previewDraftFile.ok, true);
  assert.equal(previewDraftFile.audience, 'preview');
  assert.equal(previewDraftFile.registry_revision, preview.registry_revision);
  assert.match(previewDraftFile.html, /draft-id/);

  driveStamps['draft-id'] = '2026-08-11T00:00:00.001Z';
  const beforeChangedPage = blobReads;
  const changedDraftFile = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-id', audience: 'preview',
    registry_revision: preview.registry_revision,
  } });
  assert.equal(changedDraftFile.ok, false);
  assert.match(changedDraftFile.error, /source changed/);
  assert.equal(blobReads, beforeChangedPage,
    'a post-sync page change must fail before reading Drive bytes');
  delete driveStamps['draft-id'];

  const beforeRevisionMismatch = driveReads;
  const staleDraftFile = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-id', audience: 'preview',
    registry_revision: `sha256:${'0'.repeat(64)}`,
  } });
  assert.equal(staleDraftFile.ok, false);
  assert.match(staleDraftFile.error, /revision changed/);
  assert.equal(driveReads, beforeRevisionMismatch, 'stale revision must fail before Drive read');

  const productionDraftPicture = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-picture-id',
  } });
  assert.equal(productionDraftPicture.ok, false);

  const previewDraftPicture = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-picture-id', audience: 'preview',
  } });
  assert.equal(previewDraftPicture.ok, true);
  assert.equal(previewDraftPicture.audience, 'preview');
  assert.equal(previewDraftPicture.base64, 'encoded-picture');

  driveStamps['draft-picture-id'] = '2026-08-11T00:00:00.002Z';
  const beforeChangedPicture = blobReads;
  const changedDraftPicture = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'draft-picture-id', audience: 'preview',
    registry_revision: preview.registry_revision,
  } });
  assert.equal(changedDraftPicture.ok, false);
  assert.match(changedDraftPicture.error, /source changed/);
  assert.equal(blobReads, beforeChangedPicture,
    'a post-sync picture change must fail before reading Drive bytes');

  const archivedPreviewFile = script.doGet({ parameter: {
    token: 'secret', action: 'file', id: 'archived-id', audience: 'preview',
  } });
  assert.equal(archivedPreviewFile.ok, false);

  const beforeBadToken = demoReads;
  const badToken = script.doGet({ parameter: {
    token: 'wrong', action: 'manifest', audience: 'preview',
  } });
  assert.equal(badToken.error, 'bad token');
  assert.equal(demoReads, beforeBadToken);
});

test('Drive timestamp comparison catches every sub-minute timestamp change', () => {
  const script = loadAppsScript();
  const stored = new Date('2026-08-11T00:00:00.100Z');

  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T00:00:00.100Z')), false);
  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T00:00:00.900Z')), true);
  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T00:00:01.000Z')), true);
  assert.equal(script.driveStampChanged_(stored, new Date('2026-08-11T00:00:59.000Z')), true);
  assert.equal(script.driveStampChanged_('', new Date('2026-08-11T00:00:01.000Z')), true);
});

test('Preview publish state survives Script Properties and corrupt state resets safely', () => {
  const script = loadAppsScript();
  const properties = fakeScriptProperties();
  script.PropertiesService = properties.service;

  const state = script.emptyPreviewPublishState_();
  state.branch = 'develop';
  state.desired = `sha256:${'a'.repeat(64)}`;
  state.requested = state.desired;
  state.requestId = 'request-123';
  state.attempts = 2;
  script.writePreviewPublishState_(state);

  const restored = script.readPreviewPublishState_();
  assert.equal(restored.branch, 'develop');
  assert.equal(restored.desired, state.desired);
  assert.equal(restored.requestId, 'request-123');
  assert.equal(restored.attempts, 2);

  properties.values.AI4S_PREVIEW_PUBLISH_STATE_V1 = '{broken';
  const reset = script.readPreviewPublishState_();
  assert.equal(reset.requested, '');
  assert.match(reset.lastError, /unreadable/);
});

test('Preview receipt requires verified branch-deploy context, revision, audience, and request ID', () => {
  const script = loadAppsScript();
  const expected = {
    branch: 'develop', revision: `sha256:${'b'.repeat(64)}`, requestId: 'request-456',
  };
  const receipt = {
    schema: 1,
    verified: true,
    revision_bound: true,
    target: 'preview',
    audience: 'preview',
    context: 'branch-deploy',
    branch: 'develop',
    registry_revision: expected.revision,
    request_id: expected.requestId,
  };

  assert.equal(script.previewReceiptMatches_(receipt, expected), true);
  assert.equal(script.previewReceiptMatches_({ ...receipt, verified: false }, expected), false);
  assert.equal(script.previewReceiptMatches_({ ...receipt, context: 'production' }, expected), false);
  assert.equal(script.previewReceiptMatches_({ ...receipt, branch: 'main' }, expected), false);
  assert.equal(script.previewReceiptMatches_({ ...receipt, request_id: 'older' }, expected), false);
  assert.equal(script.previewReceiptMatches_({ ...receipt, registry_revision: `sha256:${'c'.repeat(64)}` }, expected), false);
});

test('Preview receipt reconciliation checks the stable receipt URL without exposing secrets', () => {
  const script = loadAppsScript();
  const revision = `sha256:${'d'.repeat(64)}`;
  const expected = { branch: 'develop', revision, requestId: 'request-789' };
  const cfg = {
    preview_branch: 'develop',
    preview_url_branch: 'develop',
    preview_url: 'https://develop--aisigym.netlify.app/',
    production_branch: 'main',
  };
  let fetchedUrl = '';
  script.UrlFetchApp = {
    fetch(url, options) {
      fetchedUrl = url;
      assert.equal(options.method, 'get');
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          schema: 1, verified: true, revision_bound: true,
          target: 'preview', audience: 'preview',
          context: 'branch-deploy',
          branch: 'develop', registry_revision: revision, request_id: 'request-789',
        }),
      };
    },
  };

  const match = script.checkPreviewReceipt_(cfg, expected, 123456);
  assert.equal(match.ready, true);
  assert.match(fetchedUrl, /\/deploy-receipt\.json\?ai4s_check=123456$/);
  assert.doesNotMatch(fetchedUrl, /token|build_hooks/);

  script.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      schema: 1, verified: true, revision_bound: true,
      target: 'preview', audience: 'preview',
      context: 'branch-deploy',
      branch: 'develop', registry_revision: revision, request_id: 'old-request',
    }),
  });
  assert.equal(script.checkPreviewReceipt_(cfg, expected, 123457).ready, false);
});

test('Preview maintenance treats auto-off as a hard POST stop and retries only after enabling Preview', () => {
  const script = loadAppsScript();
  const properties = fakeScriptProperties();
  const revision = `sha256:${'e'.repeat(64)}`;
  const cfg = {
    netlify_preview_build_hook: PREVIEW_HOOK,
    production_branch: 'main',
    preview_branch: 'develop',
    preview_url: 'https://develop--aisigym.netlify.app/',
    preview_url_branch: 'develop',
    auto_publish_target: 'off',
  };
  let receipt = { ok: false, configured: true, ready: false, status: 404, error: 'not ready' };
  const payloads = [];
  script.PropertiesService = properties.service;
  script.Utilities = fakeUtilities('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  script.registrySnapshot_ = () => ({
    audience: 'preview', site: {}, demos: [], registry_revision: revision,
  });
  script.checkPreviewReceipt_ = () => receipt;
  script.triggerBuildRequest_ = (request, payload) => {
    payloads.push(JSON.parse(JSON.stringify(payload)));
    return { ok: true, status: 202, target: request.target, branch: request.branch };
  };

  const observed = script.maintainPreviewPublish_({}, cfg, { now: 1_000, allowAttempt: true });
  assert.equal(observed.phase, 'dirty');
  assert.equal(observed.attempted, false, 'auto off must not create a request');

  cfg.auto_publish_target = 'preview';
  const statusOnly = script.maintainPreviewPublish_({}, cfg, {
    now: 1_500, allowAttempt: false, allowAutoRequest: false,
  });
  assert.equal(statusOnly.state.requested, '', 'a status-only check must not queue a request');
  cfg.auto_publish_target = 'off';

  const manual = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000, forceRequest: true, allowAttempt: true,
  });
  assert.equal(manual.phase, 'accepted');
  assert.equal(manual.attempted, true);
  assert.equal(manual.state.attempts, 1);
  assert.equal(payloads[0].schema, 1);
  assert.equal(payloads[0].target, 'preview');
  assert.equal(payloads[0].branch, 'develop');
  assert.equal(payloads[0].registry_revision, revision);
  assert.equal(payloads[0].request_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

  const tooSoon = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 30 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(tooSoon.attempted, false);
  assert.equal(payloads.length, 1);

  const retry = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(retry.attempted, false, 'auto off must also stop scheduled retries');
  assert.equal(retry.state.attempts, 1);
  assert.equal(payloads.length, 1);

  cfg.auto_publish_target = 'preview';
  const enabledRetry = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(enabledRetry.attempted, true);
  assert.equal(enabledRetry.state.attempts, 2);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].request_id, payloads[0].request_id,
    'backoff retries must retain the logical request ID');

  receipt = {
    ok: true, configured: true, ready: true, status: 200, error: '',
    receipt: {
      schema: 1, verified: true, revision_bound: true,
      target: 'preview', audience: 'preview',
      branch: 'develop', registry_revision: revision,
      request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    },
  };
  const ready = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 3 * 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.attempted, false);
  assert.equal(ready.state.ready, revision);
  assert.equal(ready.state.nextAttemptAt, 0);

  const exhaustedReady = script.readPreviewPublishState_();
  exhaustedReady.attempts = script.PREVIEW_MAX_ATTEMPTS;
  script.writePreviewPublishState_(exhaustedReady);

  receipt = {
    ok: false, configured: true, ready: false, status: 503, error: 'temporary outage',
  };
  const transientFailure = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 4 * 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(transientFailure.state.ready, revision,
    'a transient receipt fetch failure must not erase the last verified observation');
  assert.equal(transientFailure.attempted, false);

  cfg.auto_publish_target = 'off';
  receipt = {
    ok: true, configured: true, ready: false, status: 200, error: '',
    receipt: { schema: 1, verified: false, context: 'branch-deploy', branch: 'develop' },
  };
  const replaced = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 5 * 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(replaced.state.ready, '',
    'a valid nonmatching stable receipt must demote stale ready state');
  assert.equal(replaced.phase, 'dirty');
  assert.equal(replaced.state.requested, '');
  assert.equal(replaced.attempted, false,
    'auto off must demote stale ready state without posting a repair');
  assert.equal(payloads.length, 2);

  script.previewRequestId_ = () => 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  cfg.auto_publish_target = 'preview';
  const repaired = script.maintainPreviewPublish_({}, cfg, {
    now: 2_000 + 6 * 60 * 60 * 1000, allowAttempt: true,
  });
  assert.equal(repaired.attempted, true,
    'Preview automation should repair a replaced verified deploy with a fresh request');
  assert.equal(repaired.state.attempts, 1, 'a completed request must not consume the repair budget');
  assert.equal(payloads.length, 3);
  assert.equal(payloads[2].request_id, 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.notEqual(payloads[2].request_id, payloads[0].request_id);
});

test('Preview retry delays are bounded and revision changes cancel stale requests', () => {
  const script = loadAppsScript();
  assert.equal(script.previewRetryDelayMs_(1), 60 * 60 * 1000);
  assert.equal(script.previewRetryDelayMs_(2), 2 * 60 * 60 * 1000);
  assert.equal(script.previewRetryDelayMs_(3), 4 * 60 * 60 * 1000);
  assert.equal(script.previewRetryDelayMs_(4), 8 * 60 * 60 * 1000);
  assert.equal(script.previewRetryDelayMs_(5), 24 * 60 * 60 * 1000);
  assert.equal(script.previewRetryDelayMs_(99), 24 * 60 * 60 * 1000);

  let state = script.emptyPreviewPublishState_();
  state.branch = 'develop';
  state.desired = `sha256:${'1'.repeat(64)}`;
  state.requested = state.desired;
  state.requestId = 'stale-request';
  state.accepted = state.desired;
  state.attempts = 5;
  state.nextAttemptAt = 999;
  state.ready = `sha256:${'0'.repeat(64)}`;
  state = script.observePreviewDesired_(state, 'develop', `sha256:${'2'.repeat(64)}`);

  assert.equal(state.requested, '');
  assert.equal(state.accepted, '');
  assert.equal(state.attempts, 0);
  assert.equal(state.nextAttemptAt, 0);
  assert.equal(state.ready, `sha256:${'0'.repeat(64)}`,
    'the prior ready revision remains visible as stale status');
});

test('Config migration is idempotent and preserves tokens, custom rows, and formulas', () => {
  const script = loadAppsScript();
  const sheet = new FakeSheet([
    ['setting', 'value', 'notes', '', 'categories'],
    ['site_title', 'Existing title', 'keep title', '', 'Machine learning'],
    ['site_tagline', 'Existing tagline', 'keep tagline', '', 'Statistics'],
    ['drive_folder_url', 'https://drive.google.com/drive/folders/example', 'keep folder'],
    ['netlify_build_hook', PRODUCTION_HOOK, 'old production Hook'],
    ['auto_publish', 'yes', 'legacy setting'],
    ['access_token', 'keep-this-token', 'keep token'],
    ['auto_publish_target', 'production', 'unsafe legacy value'],
    ['custom_formula', 2, 'keep custom row'],
  ], { '9:2': '=1+1' });
  const spreadsheet = {
    getSheetByName(name) { return name === 'Config' ? sheet : null; },
    insertSheet() { throw new Error('Config should already exist'); },
  };
  script.SpreadsheetApp = fakeSpreadsheetApp();
  script.Utilities = { getUuid: () => 'should-not-replace-token' };

  script.setupConfigSheet_(spreadsheet);
  script.setupConfigSheet_(spreadsheet);

  const configRows = sheet.cells
    .slice(1)
    .filter(row => row[0])
    .map(row => [row[0], row[1], row[2]]);
  const keys = configRows.map(row => row[0]);
  const values = Object.fromEntries(configRows.map(row => [row[0], row[1]]));

  assert.equal(new Set(keys).size, keys.length, 'managed keys must not duplicate');
  assert.equal(keys.includes('auto_publish'), true);
  assert.equal(values.auto_publish_target, 'off');
  assert.equal(values.access_token, 'keep-this-token');
  assert.equal(values.netlify_build_hook, PRODUCTION_HOOK);
  assert.equal(values.custom_formula, 2);
  assert.equal(sheet.formulaAt(9, 2), '=1+1');
  assert.equal(configRows.find(row => row[0] === 'custom_formula')[2], 'keep custom row');
  assert.match(configRows.find(row => row[0] === 'auto_publish')[2], /retained but ignored/);
});

test('web-app context reopens the Registry Sheet from Script Properties', () => {
  const script = loadAppsScript();
  const registry = { id: 'registry-sheet' };
  let openedId = '';
  script.SpreadsheetApp = {
    getActive: () => null,
    openById(id) {
      openedId = id;
      return registry;
    },
  };
  script.PropertiesService = {
    getScriptProperties() {
      return { getProperty: key => (
        key === 'AI4S_REGISTRY_SPREADSHEET_ID' ? 'sheet-id-123' : ''
      ) };
    },
  };

  assert.equal(script.registrySpreadsheet_(), registry);
  assert.equal(openedId, 'sheet-id-123');
});

test('Drive responses are restricted to the configured root and its direct demo folders', () => {
  const script = loadAppsScript();
  const iterator = values => {
    let index = 0;
    return { hasNext: () => index < values.length, next: () => values[index++] };
  };
  const folder = (id, parents = []) => ({
    getId: () => id,
    getParents: () => iterator(parents),
  });
  const root = folder('rootFolder1234567890');
  const demoFolder = folder('demoFolder1234567890', [root]);
  const unrelatedFolder = folder('outsideFolder1234567');
  const file = (name, mime, parent) => ({
    getName: () => name,
    getMimeType: () => mime,
    getParents: () => iterator([parent]),
  });
  const rootPage = file('loose.html', 'text/html', root);
  const nestedPage = file('demo.html', 'text/html', demoFolder);
  const nestedPicture = file('card.png', 'image/png', demoFolder);
  const unrelatedPage = file('secret.html', 'text/html', unrelatedFolder);
  const files = {
    rootPage1234567890123: rootPage,
    nestedPage12345678901: nestedPage,
    nestedPic123456789012: nestedPicture,
    outsidePage1234567890: unrelatedPage,
  };
  script.DriveApp = { getFileById: id => files[id] };
  const cfg = {
    drive_folder_url: 'https://drive.google.com/drive/folders/rootFolder1234567890',
  };

  assert.equal(script.registryDriveFile_(cfg, 'rootPage1234567890123', 'page'), rootPage);
  assert.equal(script.registryDriveFile_(cfg, 'nestedPage12345678901', 'page'), nestedPage);
  assert.equal(script.registryDriveFile_(cfg, 'nestedPic123456789012', 'picture'), nestedPicture);
  assert.equal(script.registryDriveFile_(cfg, 'outsidePage1234567890', 'page'), null);
  assert.equal(script.registryDriveFile_(cfg, 'nestedPic123456789012', 'page'), null);
  assert.equal(script.registryDriveFile_(cfg, 'rootPage1234567890123', 'picture'), null);
});

test('Netlify response codes and network errors are reported accurately', () => {
  const script = loadAppsScript();
  let requestedUrl = '';
  let requestedOptions;
  script.UrlFetchApp = {
    fetch(url, options) {
      requestedUrl = url;
      requestedOptions = options;
      return { getResponseCode: () => 202 };
    },
  };

  const accepted = script.triggerConfiguredBuild_({
    netlify_preview_build_hook: PREVIEW_HOOK,
    production_branch: 'main',
    preview_branch: PREVIEW_BRANCH,
  }, 'preview');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.branch, PREVIEW_BRANCH);
  assert.match(requestedUrl, /trigger_branch=develop/);
  assert.equal(requestedOptions.method, 'post');
  assert.equal(requestedOptions.payload, '{}');

  script.UrlFetchApp.fetch = () => ({ getResponseCode: () => 404 });
  const rejected = script.triggerBuild_(PREVIEW_HOOK);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 404);
  assert.match(rejected.error, /HTTP 404/);

  script.UrlFetchApp.fetch = () => {
    throw new Error(`network unavailable for ${PREVIEW_HOOK}?trigger_branch=secret`);
  };
  const failed = script.triggerBuild_(PREVIEW_HOOK);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 0);
  assert.match(failed.error, /network unavailable/);
  assert.doesNotMatch(failed.error, /preview123|trigger_branch/);
});
