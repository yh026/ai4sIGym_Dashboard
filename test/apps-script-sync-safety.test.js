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

  setValue(value) {
    this.sheet.setValueCalls.push({ row: this.row, column: this.column, value });
    this.sheet.setCell(this.row, this.column, value);
    return this;
  }

  setValues(rows) {
    this.sheet.setValuesCalls.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
    });
    rows.forEach((values, rowOffset) => values.forEach((value, columnOffset) => {
      this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, value);
    }));
    return this;
  }
}

class FakeSheet {
  constructor(rows, formulas = {}) {
    this.cells = rows.map(row => row.slice());
    this.formulas = { ...formulas };
    this.setValueCalls = [];
    this.setValuesCalls = [];
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
    delete this.formulas[`${row}:${column}`];
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  getLastRow() {
    let last = 0;
    this.cells.forEach((row, index) => {
      if (row.some(value => value !== '' && value != null && value !== false)) last = index + 1;
    });
    return last;
  }
}

function emptyRow() {
  return Array(30).fill('');
}

function iterator(values) {
  let index = 0;
  return {
    hasNext: () => index < values.length,
    next: () => values[index++],
  };
}

function makeFile({ id, name, mime, parents, updated = new Date('2026-08-11T00:00:00Z') }) {
  return {
    getId: () => id,
    getName: () => name,
    getMimeType: () => mime,
    getParents: () => iterator(parents),
    getLastUpdated: () => updated,
  };
}

function makeFolder({ id, name, parents = [], files = [], folders = [], getFiles }) {
  return {
    getId: () => id,
    getName: () => name,
    getParents: () => iterator(parents),
    getFiles: getFiles || (() => iterator(files)),
    getFolders: () => iterator(folders),
  };
}

test('Drive sync preserves title/status/slug/metadata edits made during the scan', () => {
  const script = loadAppsScript();
  const original = emptyRow();
  original[0] = 'Initial title';
  original[1] = 'initial-slug';
  original[2] = '';
  original[6] = 'Draft';
  original[10] = '';
  original[12] = 'Initial dataset';
  original[15] = 'CC0';
  original[17] = 'Clustering';
  original[18] = 'K-Means';
  original[24] = 'demo.html';
  original[25] = 'drive-file-1';
  original[28] = new Date('2026-08-11T00:00:00Z');
  original[29] = 'ok';

  const desired = original.slice();
  desired[2] = 'Imported description';
  desired[10] = 'Imported question';
  desired[28] = new Date('2026-08-11T01:00:00Z');
  desired[29] = 'ok — provenance updated';

  // This is the second Sheet state, observed after Drive scanning completed.
  const current = original.slice();
  current[0] = 'Human title';
  current[1] = 'human-slug';
  current[2] = 'Human description';
  current[6] = 'Live';
  current[12] = 'Human dataset metadata';

  const header = Array.from(script.HEADERS);
  const sheet = new FakeSheet([header, current]);
  const logs = [];
  script.logEvent_ = (event, details) => logs.push({ event, details });

  const result = script.writeExistingRowsSafely_(sheet, [desired], [original]);

  assert.equal(sheet.valueAt(2, 1), 'Human title');
  assert.equal(sheet.valueAt(2, 2), 'human-slug');
  assert.equal(sheet.valueAt(2, 3), 'Human description');
  assert.equal(sheet.valueAt(2, 7), 'Live');
  assert.equal(sheet.valueAt(2, 13), 'Human dataset metadata');
  assert.equal(sheet.valueAt(2, 11), 'Imported question',
    'an unchanged empty import field may still be pre-filled');
  assert.equal(sheet.valueAt(2, 24), '✓',
    'derived provenance is recomputed from the current human metadata');
  assert.equal(sheet.valueAt(2, 29).toISOString(), '2026-08-11T01:00:00.000Z');
  assert.equal(sheet.valueAt(2, 30), 'ok — provenance updated');
  assert.equal(sheet.setValuesCalls.length, 0, 'existing rows must never use a wide setValues');
  assert.equal(result.conflicts, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'sync-conflict');
  assert.match(logs[0].details, /title/);
  assert.match(logs[0].details, /slug/);
  assert.match(logs[0].details, /description/);
  assert.match(logs[0].details, /status/);
  assert.match(logs[0].details, /data_source/);
});

test('Drive sync fails before any existing-row write if a row moves during the scan', () => {
  const script = loadAppsScript();
  const original = emptyRow();
  original[0] = 'Demo';
  original[25] = 'expected-file-id';
  const desired = original.slice();
  desired[29] = 'missing';
  const moved = original.slice();
  moved[25] = 'different-file-id';
  const sheet = new FakeSheet([Array.from(script.HEADERS), moved]);

  assert.throws(
    () => script.writeExistingRowsSafely_(sheet, [desired], [original]),
    /moved or its file_id changed/,
  );
  assert.equal(sheet.setValueCalls.length, 0);
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.equal(sheet.valueAt(2, 30), '');
});

test('an empty-looking human formula is never replaced by a Drive import', () => {
  const script = loadAppsScript();
  const original = emptyRow();
  original[0] = 'Demo';
  original[25] = 'drive-file-1';
  const desired = original.slice();
  desired[2] = 'Imported description';
  const formulas = { '2:3': '=IF(A2="", "", "")' };
  const sheet = new FakeSheet([Array.from(script.HEADERS), original], formulas);
  const originalFormulas = [emptyRow()];
  originalFormulas[0][2] = formulas['2:3'];

  const result = script.writeExistingRowsSafely_(
    sheet, [desired], [original], originalFormulas,
  );

  assert.equal(sheet.formulaAt(2, 3), formulas['2:3']);
  assert.equal(sheet.valueAt(2, 3), '');
  assert.equal(result.conflicts, 0);
  assert.equal(sheet.setValueCalls.some(call => call.column === 3), false);
});

test('new Drive records append as complete rows after current Sheet content', () => {
  const script = loadAppsScript();
  const existing = emptyRow();
  existing[0] = 'Existing';
  const concurrentlyAppended = emptyRow();
  concurrentlyAppended[0] = 'Human row';
  const fresh = emptyRow();
  fresh[0] = 'New Drive demo';
  fresh[25] = 'new-drive-id';
  const sheet = new FakeSheet([Array.from(script.HEADERS), existing, concurrentlyAppended]);

  script.appendNewRows_(sheet, [fresh]);

  assert.equal(sheet.valueAt(3, 1), 'Human row');
  assert.equal(sheet.valueAt(4, 1), 'New Drive demo');
  assert.deepEqual(sheet.setValuesCalls, [{
    row: 4, column: 1, rowCount: 1, columnCount: 30,
  }]);
});

test('Drive collection rechecks root folders, loose files, subfolder files, and skips shortcuts', () => {
  const script = loadAppsScript();
  const logs = [];
  script.logEvent_ = (event, details) => logs.push({ event, details });

  const outside = makeFolder({ id: 'outside', name: 'Outside' });
  const root = makeFolder({ id: 'root', name: 'Root' });
  const validSub = makeFolder({ id: 'valid-sub', name: 'valid-demo', parents: [root] });
  const validSubPage = makeFile({
    id: 'sub-page', name: 'valid-demo.html', mime: 'text/html', parents: [validSub],
  });
  const movedSubPage = makeFile({
    id: 'moved-sub-page', name: 'moved.html', mime: 'text/html', parents: [outside],
  });
  const subShortcut = makeFile({
    id: 'sub-shortcut', name: 'shortcut.html',
    mime: 'application/vnd.google-apps.shortcut', parents: [validSub],
  });
  validSub.getFiles = () => iterator([movedSubPage, subShortcut, validSubPage]);

  const movedFolder = makeFolder({
    id: 'moved-folder',
    name: 'moved-folder',
    parents: [outside],
    getFiles: () => { throw new Error('a moved folder must not be scanned'); },
  });
  const loosePage = makeFile({
    id: 'loose-page', name: 'loose.html', mime: 'text/html', parents: [root],
  });
  const movedLoosePage = makeFile({
    id: 'moved-loose', name: 'moved-loose.html', mime: 'text/html', parents: [outside],
  });
  const rootShortcut = makeFile({
    id: 'root-shortcut', name: 'looks-real.html',
    mime: 'application/vnd.google-apps.shortcut', parents: [root],
  });
  root.getFolders = () => iterator([movedFolder, validSub]);
  root.getFiles = () => iterator([movedLoosePage, rootShortcut, loosePage]);

  const items = script.collectDemos_(root);

  assert.deepEqual(Array.from(items, item => item.file.getId()), ['sub-page', 'loose-page']);
  assert.ok(logs.some(entry => /no longer directly inside the configured Drive root/.test(entry.details)));
  assert.ok(logs.some(entry => /no longer directly inside demo folder/.test(entry.details)));
  assert.ok(logs.some(entry => /shortcut/.test(entry.details)));
  assert.equal(script.isHtmlFile_(rootShortcut), false,
    'a shortcut with an .html name must not be classified as HTML');
});

test('a Drive parent lookup exception aborts collection fail closed', () => {
  const script = loadAppsScript();
  const root = makeFolder({ id: 'root', name: 'Root' });
  const unreadableParentFile = makeFile({
    id: 'unreadable-parent', name: 'demo.html', mime: 'text/html', parents: [],
  });
  unreadableParentFile.getParents = () => { throw new Error('Drive unavailable'); };
  root.getFiles = () => iterator([unreadableParentFile]);

  assert.throws(
    () => script.collectDemos_(root),
    /parent lookup failed.*No registry changes were written/,
  );
});

test('a Drive MIME lookup exception cannot turn a shortcut-shaped file into HTML', () => {
  const script = loadAppsScript();
  const root = makeFolder({ id: 'root', name: 'Root' });
  const unreadableMimeFile = makeFile({
    id: 'unreadable-mime', name: 'looks-like-a-page.html', mime: 'text/html', parents: [root],
  });
  unreadableMimeFile.getMimeType = () => { throw new Error('Drive unavailable'); };
  root.getFiles = () => iterator([unreadableMimeFile]);

  assert.throws(
    () => script.collectDemos_(root),
    /MIME lookup failed.*No registry changes were written/,
  );
});
