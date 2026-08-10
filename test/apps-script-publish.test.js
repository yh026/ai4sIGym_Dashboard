const assert = require('node:assert/strict');
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
  assert.equal(script.autoPublishTarget_({ auto_publish_target: 'production' }), 'production');
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

test('Registry endpoint never lets legacy status=all bypass its audience', () => {
  const script = loadAppsScript();
  const demos = [
    { status: 'Live', file_id: 'live-id', picture_file_id: '', file_check: 'ok' },
    { status: 'Draft', file_id: 'draft-id', picture_file_id: 'draft-picture-id', file_check: 'ok' },
    { status: 'Archived', file_id: 'archived-id', picture_file_id: '', file_check: 'ok' },
  ];
  let demoReads = 0;
  script.registrySpreadsheet_ = () => ({});
  script.readConfig_ = () => ({ access_token: 'secret' });
  script.readCategories_ = () => [];
  script.readDemos_ = () => { demoReads += 1; return demos; };
  script.jsonOut_ = value => value;
  script.registryDriveFile_ = (cfg, id) => ({
    getBlob: () => ({
      getDataAsString: () => `<html>${id}</html>`,
      getContentType: () => 'text/html',
      getBytes: () => [],
    }),
  });
  script.Utilities = { base64Encode: () => 'encoded-picture' };

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
  assert.match(previewDraftFile.html, /draft-id/);

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
    ['custom_formula', 2, 'keep custom row'],
  ], { '8:2': '=1+1' });
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
  assert.equal(sheet.formulaAt(8, 2), '=1+1');
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
