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

class FakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    this.sheet.beforeRead?.(this);
    return Array.from({ length: this.rowCount }, (_, rowOffset) => (
      Array.from({ length: this.columnCount }, (_, columnOffset) => (
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      ))
    ));
  }

  getFormulas() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => (
      Array.from({ length: this.columnCount }, (_, columnOffset) => (
        this.sheet.formulas[`${this.row + rowOffset}:${this.column + columnOffset}`] || ''
      ))
    ));
  }

  setValues(values) {
    this.sheet.writeCalls.push({
      kind: 'values', row: this.row, column: this.column,
      rowCount: this.rowCount, columnCount: this.columnCount,
    });
    values.forEach((valuesRow, rowOffset) => valuesRow.forEach((value, columnOffset) => {
      this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, value, '');
    }));
    return this;
  }

  setFormulas(formulas) {
    this.sheet.writeCalls.push({
      kind: 'formulas', row: this.row, column: this.column,
      rowCount: this.rowCount, columnCount: this.columnCount,
    });
    formulas.forEach((formulaRow, rowOffset) => formulaRow.forEach((formula, columnOffset) => {
      const display = /^=HYPERLINK\(/.test(formula) ? 'Open Preview' : '';
      this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, display, formula);
    }));
    return this;
  }
}

class FakeSheet {
  constructor(rows, formulas = {}) {
    this.rows = rows.map(row => row.slice());
    this.formulas = { ...formulas };
    this.writeCalls = [];
    this.beforeRead = null;
  }

  setCell(row, column, value, formula) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push('');
    this.rows[row - 1][column - 1] = value;
    const key = `${row}:${column}`;
    if (formula) this.formulas[key] = formula;
    else delete this.formulas[key];
  }

  getLastColumn() {
    return Math.max(0, ...this.rows.map(row => row.length));
  }

  getLastRow() {
    let last = 0;
    this.rows.forEach((row, index) => {
      if (row.some(value => value !== '' && value != null)) last = index + 1;
    });
    return last;
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = Object.fromEntries(
      Object.entries(sheets).map(([name, rows]) => [name, new FakeSheet(rows)]),
    );
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  toast() {}
}

function iterator(values) {
  let index = 0;
  return {
    hasNext: () => index < values.length,
    next: () => values[index++],
  };
}

function folder(id, parents = []) {
  return {
    getId: () => id,
    getParents: () => iterator(parents),
  };
}

function driveFile(options) {
  let modified = options.modified || Date.parse('2026-08-12T00:00:00.000Z');
  const bytes = options.bytes || Buffer.from(`<html>${options.name}</html>`);
  return {
    getName: () => options.name,
    getMimeType: () => options.mime,
    getParents: () => iterator(options.parents),
    getLastUpdated: () => new Date(modified),
    getSize: () => options.declaredSize ?? bytes.length,
    getBlob: () => {
      options.onBlob?.();
      if (options.mutateOnBlob) modified += 1;
      return {
        getDataAsString: () => bytes.toString('utf8'),
        getBytes: () => Array.from(bytes, byte => (byte > 127 ? byte - 256 : byte)),
        getContentType: () => options.mime,
      };
    },
  };
}

function utilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest(),
        byte => (byte > 127 ? byte - 256 : byte));
    },
    base64Encode: bytes => Buffer.from(bytes.map(byte => (byte < 0 ? byte + 256 : byte)))
      .toString('base64'),
  };
}

function row(headers, values) {
  return headers.map(header => values[header] ?? '');
}

function registryHeaderIndex(script, header) {
  return Array.from(script.REGISTRY_V2_HEADERS._Registry).indexOf(header);
}

function fixture(script, options = {}) {
  const projectsHeader = Array.from(script.REGISTRY_V2_PROJECT_FIELDS, field => field[1]);
  const registryHeader = Array.from(script.REGISTRY_V2_HEADERS._Registry);
  const taxonomyHeader = Array.from(script.REGISTRY_V2_HEADERS._Taxonomy);
  const facetsHeader = Array.from(script.REGISTRY_V2_HEADERS._Facets);
  const assetsHeader = Array.from(script.REGISTRY_V2_HEADERS._Assets);
  const configHeader = Array.from(script.REGISTRY_V2_HEADERS._Config);
  const cardName = options.cardName ?? '';
  const projectRows = [
    projectsHeader,
    row(projectsHeader, {
      Status: 'Live', Readiness: 'Ready', 'Preview URL': '',
      'Project Title': 'Live project', 'Card Summary': 'A live card.',
      Department: 'Chemistry', Subtopic: 'Materials', 'Task Type': 'Classification',
      Methods: 'PCA', 'Card Image': cardName, 'Image Alt Text': cardName ? 'A card image.' : '',
      Audience: 'Intro', Featured: true, 'Data Source': 'Synthetic',
      'Public Permission': 'Public', demo_id: 'demo-live',
    }),
    row(projectsHeader, {
      Status: 'Draft', Readiness: 'Ready', 'Preview URL': '',
      'Project Title': 'Draft project', 'Card Summary': 'A draft card.',
      Department: 'Chemistry', Subtopic: 'Materials', 'Task Type': 'Classification',
      Methods: 'PCA', 'Card Image': '', 'Image Alt Text': '', Audience: 'General',
      Featured: false, 'Data Source': 'Synthetic', 'Public Permission': 'Preview only',
      demo_id: 'demo-draft',
    }),
  ];
  const registryRows = [
    registryHeader,
    row(registryHeader, {
      schema_version: 2, row_number: 2, demo_id: 'demo-live', entry_type: 'project',
      slug: 'live-project', status: 'Live', readiness: 'blocked', featured: true,
      sort_order: 1, title: 'Live project', card_summary: 'A live card.',
      department_id: 'chemistry', subtopic_id: 'materials', task_ids: 'classification',
      method_ids: 'pca', audience: 'Intro', data_source_label: 'Synthetic',
      public_page_permission: 'Public', card_asset_id: cardName ? 'live-card' : '',
      file_id: 'page-live-12345', file_check: options.liveFileCheck || 'check assets: legacy local file',
      date_added: new Date('2026-08-01T00:00:00.000Z'),
    }),
    row(registryHeader, {
      schema_version: 2, row_number: 3, demo_id: 'demo-draft', entry_type: 'project',
      slug: 'draft-project', status: 'Draft', readiness: 'blocked', featured: false,
      sort_order: 2, title: 'Draft project', card_summary: 'A draft card.',
      department_id: 'chemistry', subtopic_id: 'materials', task_ids: 'classification',
      method_ids: 'pca', audience: 'General', data_source_label: 'Synthetic',
      public_page_permission: 'Preview only', card_asset_id: '',
      file_id: 'page-draft-12345', file_check: 'ok',
      date_added: new Date('2026-08-02T00:00:00.000Z'),
    }),
  ];
  const taxonomyRows = [
    taxonomyHeader,
    row(taxonomyHeader, {
      term_type: 'department', term_id: 'chemistry', label: 'Chemistry',
      short_label: 'Chemistry', description: 'Chemistry projects.', display_order: 1,
      active: true, theme_key: 'chemistry-materials', icon_key: 'flask', aliases: 'Chem',
    }),
    row(taxonomyHeader, {
      term_type: 'department', term_id: 'physics', label: 'Physics',
      short_label: 'Physics', description: 'Physics projects.', display_order: 2,
      active: true, theme_key: 'space-astronomy', icon_key: 'orbit',
    }),
    row(taxonomyHeader, {
      term_type: 'subtopic', term_id: 'materials', parent_id: 'chemistry',
      label: 'Materials', display_order: 1, active: true, aliases: 'Material Science',
    }),
    row(taxonomyHeader, {
      term_type: 'subtopic', term_id: 'astrophysics', parent_id: 'physics',
      label: 'Astrophysics', display_order: 1, active: true,
    }),
    row(taxonomyHeader, {
      term_type: 'task', term_id: 'classification', label: 'Classification', active: true,
      aliases: 'Classify',
    }),
    row(taxonomyHeader, {
      term_type: 'task', term_id: 'regression', label: 'Regression', active: true,
    }),
    row(taxonomyHeader, {
      term_type: 'method', term_id: 'pca', label: 'PCA', active: true,
      aliases: 'Principal Component Analysis',
    }),
    row(taxonomyHeader, {
      term_type: 'method', term_id: 'umap', label: 'UMAP', active: true,
    }),
  ];
  const facetRows = [
    facetsHeader,
    row(facetsHeader, { demo_id: 'demo-live', facet_type: 'task', term_id: 'classification', display_order: 1 }),
    row(facetsHeader, { demo_id: 'demo-live', facet_type: 'method', term_id: 'pca', display_order: 1 }),
    row(facetsHeader, { demo_id: 'demo-draft', facet_type: 'task', term_id: 'classification', display_order: 1 }),
    row(facetsHeader, { demo_id: 'demo-draft', facet_type: 'method', term_id: 'pca', display_order: 1 }),
  ];
  const assetRows = [assetsHeader];
  if (cardName) {
    assetRows.push(row(assetsHeader, {
      asset_id: 'live-card', demo_id: 'demo-live', role: 'card_image', source_type: options.sourceType || 'drive',
      drive_file_id: options.assetFileId ?? 'asset-live-12345',
      external_url: options.externalUrl ?? '', mime_type: options.assetMime || 'image/png',
      alt_text: 'Indexed alt.', public_path: options.publicPath || 'assets/cards/live-card.png',
      sync_status: options.syncStatus ?? 'ok',
      source_modified_at: new Date('2026-08-12T00:00:00.000Z'),
      source_file_name: cardName,
    }));
  }
  const configRows = [
    configHeader,
    row(configHeader, { key: 'schema_version', value: 2, visibility: 'internal' }),
    row(configHeader, { key: 'preview_base_url', value: 'https://develop--aisigym.netlify.app/', visibility: 'internal' }),
    row(configHeader, { key: 'site_title', value: 'Registry v2', visibility: 'public' }),
    row(configHeader, { key: 'site_tagline', value: 'Private preview.', visibility: 'public' }),
  ];
  return new FakeSpreadsheet({
    Projects: projectRows,
    _Registry: registryRows,
    _Taxonomy: taxonomyRows,
    _Facets: facetRows,
    _Assets: assetRows,
    _Config: configRows,
  });
}

function installServices(script, v2Sheet, files, properties = {}) {
  const configSheet = new FakeSpreadsheet({
    Config: [
      ['key', 'value'],
      ['access_token', 'secret'],
      ['drive_folder_url', 'https://drive.google.com/drive/folders/root-folder-12345'],
      ['preview_branch', 'develop'],
      ['preview_url', 'https://develop--aisigym.netlify.app/'],
      ['preview_url_branch', 'develop'],
      ['production_branch', 'main'],
    ],
  });
  const values = {
    AI4S_REGISTRY_V2_SPREADSHEET_ID: 'v2-sheet-id',
    ...properties,
  };
  script.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => values[key] ?? null,
      setProperty: (key, value) => { values[key] = String(value); },
    }),
  };
  script.SpreadsheetApp = {
    getActive: () => null,
    openById: id => {
      if (id === 'v2-sheet-id') return v2Sheet;
      throw new Error(`unknown fake spreadsheet ${id}`);
    },
    flush: () => {},
  };
  script.registrySpreadsheet_ = () => configSheet;
  script.DriveApp = { getFileById: id => {
    if (!files[id]) throw new Error('missing fake Drive file');
    return files[id];
  } };
  script.Utilities = utilities();
  script.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  script.jsonOut_ = value => value;
  return values;
}

function standardDrive(options = {}) {
  const root = folder('root-folder-12345');
  const demoFolder = folder('demo-folder-12345', [root]);
  const otherFolder = folder('other-folder-12345', [root]);
  const files = {
    'page-live-12345': driveFile({
      name: 'live.html', mime: 'text/html', parents: [demoFolder],
      mutateOnBlob: options.mutatePageOnBlob,
    }),
    'page-draft-12345': driveFile({
      name: 'draft.html', mime: 'text/html', parents: [demoFolder],
    }),
  };
  if (options.withAsset) {
    files['asset-live-12345'] = driveFile({
      name: options.assetName || 'card.png', mime: options.assetMime || 'image/png',
      parents: [options.assetOtherParent ? otherFolder : demoFolder],
      bytes: options.assetBytes || Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      declaredSize: options.assetDeclaredSize,
      mutateOnBlob: options.mutateAssetOnBlob,
      onBlob: options.onAssetBlob,
    });
  }
  return files;
}

test('Registry v2 is explicit while schema and Preview defaults remain v1', () => {
  const script = loadAppsScript();
  script.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => null }),
  };
  assert.equal(script.registrySchema_('').value, 1);
  assert.equal(script.registrySchema_('1').value, 1);
  assert.equal(script.registrySchema_('2').value, 2);
  assert.equal(script.registrySchema_('3').ok, false);
  assert.equal(script.previewRegistrySchema_(), 1);
});

test('v2 manifest reads all six tables, keeps default images null, and applies audience', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive());

  const production = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(production.ok, true);
  assert.equal(production.schema_version, 2);
  assert.equal(production.audience, 'production');
  assert.match(production.registry_revision, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Array.from(production.demos, demo => demo.demo_id), ['demo-live']);
  assert.equal(sheet.getSheetByName('_Registry').rows[1][registryHeaderIndex(script, 'readiness')],
    'blocked', 'the endpoint must derive current readiness without writing the stale hidden cell');
  assert.equal(production.demos[0].card_asset, null);
  assert.equal(production.demos[0].file_check.startsWith('check assets:'), true);
  assert.deepEqual(Object.keys(production.demos[0]).sort(), [
    'audience', 'card_asset', 'card_summary', 'data_source_label', 'date_added',
    'demo_id', 'department_id', 'entry_type', 'featured', 'file_check', 'file_id',
    'method_ids', 'public_page_permission', 'slug', 'sort_order', 'status',
    'subtopic_id', 'task_ids', 'title',
  ]);

  const preview = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'preview',
  } });
  assert.deepEqual(Array.from(preview.demos, demo => demo.demo_id), ['demo-live', 'demo-draft']);
  assert.notEqual(preview.registry_revision, production.registry_revision);
});

test('v2 human taxonomy must match _Registry and _Facets before serving', async t => {
  const cases = [
    ['Department', 'Physics'],
    ['Subtopic', 'Astrophysics'],
    ['Task Type', 'Regression'],
    ['Methods', 'UMAP'],
  ];
  for (const [label, value] of cases) {
    await t.test(label, () => {
      const script = loadAppsScript();
      const sheet = fixture(script);
      const header = sheet.getSheetByName('Projects').rows[0];
      sheet.getSheetByName('Projects').rows[1][header.indexOf(label)] = value;
      installServices(script, sheet, standardDrive());
      const result = script.doGet({ parameter: {
        token: 'secret', schema: '2', action: 'manifest', audience: 'production',
      } });
      assert.deepEqual({ ok: result.ok, error: result.error },
        { ok: false, error: 'registry v2 unavailable' });
    });
  }
});

test('v2 human taxonomy labels and aliases pass when hidden IDs are aligned', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const projects = sheet.getSheetByName('Projects').rows;
  const registry = sheet.getSheetByName('_Registry').rows;
  const facets = sheet.getSheetByName('_Facets').rows;
  const projectHeader = projects[0];
  const registryHeader = registry[0];
  const facetHeader = facets[0];
  projects[1][projectHeader.indexOf('Department')] = 'Physics';
  projects[1][projectHeader.indexOf('Subtopic')] = 'Astrophysics';
  projects[1][projectHeader.indexOf('Task Type')] = 'Regression';
  projects[1][projectHeader.indexOf('Methods')] = 'UMAP';
  registry[1][registryHeader.indexOf('department_id')] = 'physics';
  registry[1][registryHeader.indexOf('subtopic_id')] = 'astrophysics';
  facets[1][facetHeader.indexOf('term_id')] = 'regression';
  facets[2][facetHeader.indexOf('term_id')] = 'umap';

  // The Draft row demonstrates aliases resolve through the same canonical IDs.
  projects[2][projectHeader.indexOf('Department')] = 'Chem';
  projects[2][projectHeader.indexOf('Subtopic')] = 'Material Science';
  projects[2][projectHeader.indexOf('Task Type')] = 'Classify';
  projects[2][projectHeader.indexOf('Methods')] = 'Principal Component Analysis';
  installServices(script, sheet, standardDrive());
  const result = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'preview',
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.demos, demo => ({
    id: demo.demo_id,
    department: demo.department_id,
    subtopic: demo.subtopic_id,
    tasks: Array.from(demo.task_ids),
    methods: Array.from(demo.method_ids),
  })), [
    { id: 'demo-live', department: 'physics', subtopic: 'astrophysics',
      tasks: ['regression'], methods: ['umap'] },
    { id: 'demo-draft', department: 'chemistry', subtopic: 'materials',
      tasks: ['classification'], methods: ['pca'] },
  ]);
});

test('v2 rejects CJK text in every consumed Sheet while preserving typed cells', async t => {
  const cases = [
    ['Projects', 1, 3],
    ['_Registry', 1, 9],
    ['_Taxonomy', 1, 3],
    ['_Facets', 1, 2],
    ['_Assets', 1, 7],
    ['_Config', 1, 3],
  ];
  for (const [sheetName, rowIndex, columnIndex] of cases) {
    await t.test(sheetName, () => {
      const script = loadAppsScript();
      const sheet = fixture(script, sheetName === '_Assets' ? { cardName: 'card.png' } : {});
      sheet.getSheetByName(sheetName).rows[rowIndex][columnIndex] = '中文';
      installServices(script, sheet,
        standardDrive({ withAsset: sheetName === '_Assets' }));
      const result = script.doGet({ parameter: {
        token: 'secret', schema: '2', action: 'manifest', audience: 'production',
      } });
      assert.deepEqual({ ok: result.ok, error: result.error },
        { ok: false, error: 'registry v2 unavailable' });
    });
  }

  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive());
  const typed = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(typed.ok, true, 'Date, number, and boolean cells remain valid');
});

test('Projects and _Registry demo_id sets must match exactly', async t => {
  await t.test('extra Project', () => {
    const script = loadAppsScript();
    const sheet = fixture(script);
    const projects = sheet.getSheetByName('Projects').rows;
    const extra = projects[2].slice();
    extra[projects[0].indexOf('demo_id')] = 'demo-extra';
    projects.push(extra);
    installServices(script, sheet, standardDrive());
    const result = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    assert.equal(result.error, 'registry v2 unavailable');
  });

  await t.test('extra _Registry row', () => {
    const script = loadAppsScript();
    const sheet = fixture(script);
    const registry = sheet.getSheetByName('_Registry').rows;
    const extra = registry[2].slice();
    extra[registry[0].indexOf('demo_id')] = 'demo-extra';
    extra[registry[0].indexOf('file_id')] = 'page-extra-12345';
    extra[registry[0].indexOf('slug')] = 'extra-project';
    registry.push(extra);
    installServices(script, sheet, standardDrive());
    const result = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    assert.equal(result.error, 'registry v2 unavailable');
  });

  await t.test('duplicate _Registry identity', () => {
    const script = loadAppsScript();
    const sheet = fixture(script);
    const registry = sheet.getSheetByName('_Registry').rows;
    registry[2][registry[0].indexOf('demo_id')] = 'demo-live';
    installServices(script, sheet, standardDrive());
    const result = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    assert.equal(result.error, 'registry v2 unavailable');
  });
});

test('manual Registry v2 status refresh writes exactly three derived columns by demo_id', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive());
  const cfg = script.readConfig_(script.registrySpreadsheet_());
  const revisionBefore = script.registryV2Snapshot_(sheet, cfg, 'preview').registry_revision;

  const result = script.refreshRegistryV2Status();
  assert.deepEqual({ ok: result.ok, ready: result.ready, total: result.total },
    { ok: true, ready: 2, total: 2 });

  const projects = sheet.getSheetByName('Projects');
  const registry = sheet.getSheetByName('_Registry');
  assert.deepEqual(projects.writeCalls, [
    { kind: 'values', row: 2, column: 2, rowCount: 2, columnCount: 1 },
    { kind: 'formulas', row: 2, column: 3, rowCount: 2, columnCount: 1 },
  ]);
  assert.deepEqual(registry.writeCalls, [
    { kind: 'values', row: 2, column: 7, rowCount: 2, columnCount: 1 },
  ]);
  for (const name of ['_Taxonomy', '_Facets', '_Assets', '_Config']) {
    assert.equal(sheet.getSheetByName(name).writeCalls.length, 0);
  }
  assert.equal(projects.rows[1][1], '✅ Publication ready');
  assert.equal(projects.rows[2][1], '✅ Preview ready');
  assert.equal(projects.formulas['2:3'],
    '=HYPERLINK("https://develop--aisigym.netlify.app/demos/live-project/","Open Preview")');
  assert.equal(projects.formulas['3:3'],
    '=HYPERLINK("https://develop--aisigym.netlify.app/demos/draft-project/","Open Preview")');
  assert.deepEqual(registry.rows.slice(1).map(row => row[6]), ['ready', 'ready']);
  assert.equal(projects.rows[1][3], 'Live project', 'human-owned fields stay unchanged');
  assert.equal(script.registryV2Snapshot_(sheet, cfg, 'preview').registry_revision,
    revisionBefore, 'derived writes do not change the build-facing Registry revision');

  const firstState = JSON.stringify({
    projects: projects.rows,
    projectFormulas: projects.formulas,
    registry: registry.rows,
  });
  projects.writeCalls.length = 0;
  registry.writeCalls.length = 0;
  const second = script.refreshRegistryV2Status();
  assert.equal(second.registry_revision, result.registry_revision);
  assert.equal(JSON.stringify({
    projects: projects.rows,
    projectFormulas: projects.formulas,
    registry: registry.rows,
  }), firstState, 'running twice is idempotent');
});

test('manual Registry v2 status refresh writes blocked and archived status without publishing', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const projects = sheet.getSheetByName('Projects');
  const header = projects.rows[0];
  projects.rows[1][header.indexOf('Status')] = 'Archived';
  projects.rows[2][header.indexOf('Public Permission')] = 'Private';
  installServices(script, sheet, standardDrive());

  const result = script.refreshRegistryV2Status();
  assert.deepEqual({ ready: result.ready, total: result.total }, { ready: 0, total: 2 });
  assert.equal(projects.rows[1][header.indexOf('Readiness')], '— Archived');
  assert.equal(projects.rows[2][header.indexOf('Readiness')],
    '⛔ Action needed: Public Permission');
  assert.equal(projects.formulas['2:3'] || '', '');
  assert.equal(projects.formulas['3:3'] || '', '');
  const registry = sheet.getSheetByName('_Registry');
  assert.deepEqual(registry.rows.slice(1).map(row => row[6]), ['not_applicable', 'blocked']);
});

test('manual Registry v2 status refresh stops before its first write on concurrent edits', async t => {
  async function expectNoWrite(mutate) {
    const script = loadAppsScript();
    const sheet = fixture(script);
    installServices(script, sheet, standardDrive());
    const projects = sheet.getSheetByName('Projects');
    let fullReads = 0;
    projects.beforeRead = range => {
      if (range.row !== 1 || range.column !== 1) return;
      fullReads += 1;
      if (fullReads === 2) mutate(projects);
    };
    assert.throws(() => script.refreshRegistryV2Status(), /Sheet changed during compilation/);
    assert.equal(projects.writeCalls.length, 0);
    assert.equal(sheet.getSheetByName('_Registry').writeCalls.length, 0);
  }

  await t.test('human field edit', () => expectNoWrite(projects => {
    projects.rows[1][3] = 'Edited while compiling';
  }));
  await t.test('row move', () => expectNoWrite(projects => {
    [projects.rows[1], projects.rows[2]] = [projects.rows[2], projects.rows[1]];
  }));
  await t.test('formula edit', () => expectNoWrite(projects => {
    projects.formulas['2:3'] = '=HYPERLINK("https://example.invalid/","Changed")';
  }));
  await t.test('derived target value edit', () => expectNoWrite(projects => {
    projects.rows[1][1] = 'Manually changed readiness';
  }));

  await t.test('_Registry row move', () => {
    const script = loadAppsScript();
    const sheet = fixture(script);
    installServices(script, sheet, standardDrive());
    const registry = sheet.getSheetByName('_Registry');
    let reads = 0;
    registry.beforeRead = range => {
      if (range.row !== 1 || range.column !== 1) return;
      reads += 1;
      if (reads === 2) [registry.rows[1], registry.rows[2]] = [registry.rows[2], registry.rows[1]];
    };
    assert.throws(() => script.refreshRegistryV2Status(), /Sheet changed during compilation/);
    assert.equal(sheet.getSheetByName('Projects').writeCalls.length, 0);
    assert.equal(registry.writeCalls.length, 0);
  });

  await t.test('edit during second compiler pass', () => {
    const script = loadAppsScript();
    const sheet = fixture(script);
    installServices(script, sheet, standardDrive());
    const projects = sheet.getSheetByName('Projects');
    let reads = 0;
    projects.beforeRead = range => {
      if (range.row !== 1 || range.column !== 1) return;
      reads += 1;
      if (reads === 3) projects.rows[1][3] = 'Edited immediately before writing';
    };
    assert.throws(() => script.refreshRegistryV2Status(), /Sheet changed before writing/);
    assert.equal(projects.writeCalls.length, 0);
    assert.equal(sheet.getSheetByName('_Registry').writeCalls.length, 0);
  });
});

test('manual Registry v2 status refresh rejects missing or duplicate identity with zero writes', async t => {
  for (const [name, mutate] of [
    ['missing', (projects, idColumn) => { projects.rows[1][idColumn] = ''; }],
    ['duplicate', (projects, idColumn) => {
      projects.rows[2][idColumn] = projects.rows[1][idColumn];
    }],
  ]) {
    await t.test(name, () => {
      const script = loadAppsScript();
      const sheet = fixture(script);
      const projects = sheet.getSheetByName('Projects');
      mutate(projects, projects.rows[0].indexOf('demo_id'));
      installServices(script, sheet, standardDrive());
      assert.throws(() => script.refreshRegistryV2Status(), /identity|identities/);
      assert.equal(projects.writeCalls.length, 0);
      assert.equal(sheet.getSheetByName('_Registry').writeCalls.length, 0);
    });
  }
});

test('manual Registry v2 status refresh requires its V2 HTTPS Preview base before writing', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const config = sheet.getSheetByName('_Config');
  const keyColumn = config.rows[0].indexOf('key');
  const valueColumn = config.rows[0].indexOf('value');
  const previewRow = config.rows.find(row => row[keyColumn] === 'preview_base_url');
  previewRow[valueColumn] = 'http://develop.example.invalid/';
  installServices(script, sheet, standardDrive());
  assert.throws(() => script.refreshRegistryV2Status(), /preview_base_url.*HTTPS/);
  assert.equal(sheet.getSheetByName('Projects').writeCalls.length, 0);
  assert.equal(sheet.getSheetByName('_Registry').writeCalls.length, 0);
});

test('manual Registry v2 status refresh leaves a formula-only middle row untouched', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const projects = sheet.getSheetByName('Projects');
  const registry = sheet.getSheetByName('_Registry');
  projects.rows.splice(2, 0, Array(projects.rows[0].length).fill(''));
  registry.rows.splice(2, 0, Array(registry.rows[0].length).fill(''));
  const protectedFormula = '=IF(TRUE,"","")';
  projects.formulas['3:3'] = protectedFormula;
  registry.formulas['3:7'] = protectedFormula;
  installServices(script, sheet, standardDrive());

  script.refreshRegistryV2Status();

  assert.equal(projects.formulas['3:3'], protectedFormula);
  assert.equal(registry.formulas['3:7'], protectedFormula);
  assert.equal(projects.rows[2][2], '');
  assert.deepEqual(projects.writeCalls, [
    { kind: 'values', row: 2, column: 2, rowCount: 1, columnCount: 1 },
    { kind: 'formulas', row: 2, column: 3, rowCount: 1, columnCount: 1 },
    { kind: 'values', row: 4, column: 2, rowCount: 1, columnCount: 1 },
    { kind: 'formulas', row: 4, column: 3, rowCount: 1, columnCount: 1 },
  ]);
  assert.deepEqual(registry.writeCalls, [
    { kind: 'values', row: 2, column: 7, rowCount: 1, columnCount: 1 },
    { kind: 'values', row: 4, column: 7, rowCount: 1, columnCount: 1 },
  ]);
});

test('v2 file responses are visible, revision-bound, read-only, and race-safe', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const files = standardDrive();
  installServices(script, sheet, files);
  const manifest = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'preview',
  } });
  const result = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'preview',
    id: 'page-draft-12345', registry_revision: manifest.registry_revision,
  } });
  assert.equal(result.ok, true);
  assert.match(result.html, /draft\.html/);
  assert.equal(result.registry_revision, manifest.registry_revision);

  const stale = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'preview',
    id: 'page-draft-12345', registry_revision: `sha256:${'0'.repeat(64)}`,
  } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'registry revision changed');

  const raceScript = loadAppsScript();
  installServices(raceScript, fixture(raceScript), standardDrive({ mutatePageOnBlob: true }));
  const raceManifest = raceScript.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  const raced = raceScript.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: raceManifest.registry_revision,
  } });
  assert.deepEqual({ ok: raced.ok, error: raced.error },
    { ok: false, error: 'could not read file' });
});

test('v2 Drive card image returns the exact strict asset envelope', () => {
  const script = loadAppsScript();
  let blobReads = 0;
  installServices(script, fixture(script, { cardName: 'card.png' }), standardDrive({
    withAsset: true,
    onAssetBlob: () => { blobReads += 1; },
  }));
  const manifest = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(blobReads, 0, 'manifest reads metadata but not image bytes');
  assert.deepEqual(Object.keys(manifest.demos[0].card_asset).sort(),
    ['alt_text', 'asset_id', 'public_path']);
  const result = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'asset', audience: 'production',
    id: 'live-card', registry_revision: manifest.registry_revision,
  } });
  assert.equal(blobReads, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    'base64', 'extension', 'id', 'kind', 'mime', 'ok', 'registry_revision', 'size',
  ]);
  assert.equal(result.kind, 'card_image');
  assert.equal(result.id, 'live-card');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.extension, 'png');
  assert.equal(result.size, 8);
  assert.equal(result.base64, 'iVBORw0KGgo=');
  assert.equal(result.registry_revision, manifest.registry_revision);
});

test('v2 card images fail closed for external, parent, MIME, size, and read races', async t => {
  const cases = [
    ['external source',
      { sourceType: 'external', externalUrl: 'https://example.invalid/card.png', assetFileId: '' },
      standardDrive()],
    ['different project folder', {}, standardDrive({ withAsset: true, assetOtherParent: true })],
    ['MIME mismatch', {}, standardDrive({ withAsset: true, assetMime: 'image/jpeg' })],
    ['unhealthy sync status', { syncStatus: 'pending' }, standardDrive({ withAsset: true })],
  ];
  for (const [name, fixtureOptions, files] of cases) {
    await t.test(name, () => {
      const script = loadAppsScript();
      installServices(script, fixture(script, { cardName: 'card.png', ...fixtureOptions }), files);
      const result = script.doGet({ parameter: {
        token: 'secret', schema: '2', action: 'manifest', audience: 'production',
      } });
      assert.deepEqual({ ok: result.ok, error: result.error },
        { ok: false, error: 'registry v2 unavailable' });
    });
  }

  await t.test('larger than 5 MiB', () => {
    const script = loadAppsScript();
    installServices(script, fixture(script, { cardName: 'card.png' }), standardDrive({
      withAsset: true, assetDeclaredSize: 5 * 1024 * 1024 + 1,
    }));
    const manifest = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    const result = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'asset', audience: 'production',
      id: 'live-card', registry_revision: manifest.registry_revision,
    } });
    assert.deepEqual({ ok: result.ok, error: result.error },
      { ok: false, error: 'could not read asset' });
  });

  await t.test('modified while reading', () => {
    const script = loadAppsScript();
    installServices(script, fixture(script, { cardName: 'card.png' }), standardDrive({
      withAsset: true, mutateAssetOnBlob: true,
    }));
    const manifest = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    const result = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'asset', audience: 'production',
      id: 'live-card', registry_revision: manifest.registry_revision,
    } });
    assert.deepEqual({ ok: result.ok, error: result.error },
      { ok: false, error: 'could not read asset' });
  });
});

test('the explicit Preview schema switch binds Hook state to the v2 revision', () => {
  const script = loadAppsScript();
  const revisionV1 = `sha256:${'1'.repeat(64)}`;
  const revisionV2 = `sha256:${'2'.repeat(64)}`;
  script.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => key === 'AI4S_PREVIEW_REGISTRY_SCHEMA' ? '2' : null,
    }),
  };
  script.registrySnapshot_ = () => ({ registry_revision: revisionV1 });
  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2Snapshot_ = () => ({ registry_revision: revisionV2 });
  script.readPreviewPublishState_ = () => script.emptyPreviewPublishState_();
  script.writePreviewPublishState_ = state => state;
  script.checkPreviewReceipt_ = () => ({ ok: true, configured: true, ready: false, status: 0 });
  const run = script.maintainPreviewPublish_({}, {
    preview_branch: 'develop', auto_publish_target: 'off',
  }, { allowAutoRequest: false, allowAttempt: false, now: 1 });
  assert.equal(run.snapshot.registry_revision, revisionV2);
  assert.equal(run.state.desired, revisionV2);
});
