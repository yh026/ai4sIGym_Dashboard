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

test('Apps Script manifest enables the Sheets v4 advanced service', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'google-apps-script', 'appsscript.json'), 'utf8',
  ));
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{
    userSymbol: 'Sheets', version: 'v4', serviceId: 'sheets',
  }]);
  assert.deepEqual(manifest.webapp, {
    executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS',
  });
});

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

  appendRow(values) {
    this.rows.push(values.slice());
    this.writeCalls.push({ kind: 'append', values: values.slice() });
    return this;
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

  getId() {
    return 'v2-sheet-id';
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
  const created = options.created || Date.parse('2026-08-11T00:00:00.000Z');
  const bytes = options.bytes || Buffer.from(`<html>${options.name}</html>`);
  return {
    getId: () => options.id || options.name,
    getName: () => options.name,
    getMimeType: () => options.mime,
    getParents: () => iterator(options.parentsProvider
      ? options.parentsProvider() : options.parents),
    getLastUpdated: () => new Date(modified),
    getDateCreated: () => new Date(created),
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
    getUuid: () => '11111111-2222-4333-8444-555555555555',
  };
}

function fakeScriptCache() {
  let now = 0;
  const entries = new Map();
  const calls = { get: 0, put: 0, remove: 0, removeAll: 0 };
  const cache = {
    get(key) {
      calls.get += 1;
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    put(key, value, ttlSeconds) {
      calls.put += 1;
      entries.set(key, { value: String(value), expiresAt: now + ttlSeconds * 1000 });
    },
    remove(key) {
      calls.remove += 1;
      entries.delete(key);
    },
    removeAll(keys) {
      calls.removeAll += 1;
      keys.forEach(key => entries.delete(key));
    },
  };
  return {
    service: { getScriptCache: () => cache },
    calls,
    entries,
    advance(milliseconds) { now += milliseconds; },
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
  const auditHeader = Array.from(script.REGISTRY_V2_HEADERS._Audit);
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
    _Audit: [auditHeader],
    _Config: configRows,
  });
}

function installServices(script, v2Sheet, files, properties = {}) {
  const values = {
    AI4S_REGISTRY_V2_SPREADSHEET_ID: 'v2-sheet-id',
    AI4S_REGISTRY_ACCESS_TOKEN: 'secret',
    AI4S_DRIVE_FOLDER_URL: 'https://drive.google.com/drive/folders/root-folder-12345',
    AI4S_NETLIFY_PRODUCTION_BUILD_HOOK:
      'https://api.netlify.com/build_hooks/production-hook',
    AI4S_NETLIFY_PREVIEW_BUILD_HOOK:
      'https://api.netlify.com/build_hooks/preview-hook',
    AI4S_PRODUCTION_BRANCH: 'main',
    AI4S_PREVIEW_BRANCH: 'develop',
    AI4S_PREVIEW_URL: 'https://develop--aisigym.netlify.app/',
    AI4S_PREVIEW_URL_BRANCH: 'develop',
    AI4S_AUTO_PUBLISH_TARGET: 'off',
    AI4S_NETLIFY_SITE_ID: '33333333-4444-4555-8666-777777777777',
    AI4S_PREVIEW_CALLBACK_SECRET: 'callback-secret-with-at-least-thirty-two-characters',
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
  script.DriveApp = {
    getFileById: id => {
      if (!files[id]) throw new Error('missing fake Drive file');
      return files[id];
    },
    getFolderById: id => {
      if (id !== 'root-folder-12345') throw new Error('missing fake Drive folder');
      return folder(id);
    },
  };
  script.Utilities = utilities();
  script.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  const cache = fakeScriptCache();
  script.CacheService = cache.service;
  script.__testSnapshotCache = cache;
  script.jsonOut_ = value => value;
  return values;
}

function standardDrive(options = {}) {
  const root = folder('root-folder-12345');
  const demoFolder = folder('demo-folder-12345', [root]);
  const otherFolder = folder('other-folder-12345', [root]);
  const files = {
    'page-live-12345': driveFile({
      id: 'page-live-12345', name: 'live.html', mime: 'text/html', parents: [demoFolder],
      mutateOnBlob: options.mutatePageOnBlob,
      onBlob: options.onPageBlob,
    }),
    'page-draft-12345': driveFile({
      id: 'page-draft-12345', name: 'draft.html', mime: 'text/html', parents: [demoFolder],
    }),
  };
  if (options.withAsset) {
    files['asset-live-12345'] = driveFile({
      id: 'asset-live-12345', name: options.assetName || 'card.png',
      mime: options.assetMime || 'image/png',
      parents: [options.assetOtherParent ? otherFolder : demoFolder],
      bytes: options.assetBytes || Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      declaredSize: options.assetDeclaredSize,
      mutateOnBlob: options.mutateAssetOnBlob,
      onBlob: options.onAssetBlob,
    });
  }
  return files;
}

test('Registry v2 is the sole runtime schema and the legacy resolver aliases V2 only', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive(), {
    AI4S_REGISTRY_SPREADSHEET_ID: 'archived-v1-must-not-open',
  });
  assert.deepEqual({ ok: script.registrySchema_('').ok, value: script.registrySchema_('').value },
    { ok: true, value: 2 });
  assert.equal(script.registrySchema_('1').ok, false);
  assert.equal(script.previewRegistrySchema_(), 2);
  assert.equal(script.registrySpreadsheet_(), sheet);
});

test('setup refuses a V1-shaped active workbook before properties, triggers, or tabs change', () => {
  const script = loadAppsScript();
  const legacy = new FakeSpreadsheet({
    Demos: [['title', 'file_id']],
    Config: [['key', 'value']],
    Log: [['timestamp', 'event', 'details']],
  });
  const originalNames = Object.keys(legacy.sheets);
  let propertyWrites = 0;
  script.SpreadsheetApp = {
    getActive: () => legacy,
    getUi: () => { throw new Error('menu must not be installed'); },
  };
  script.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => null,
      setProperty: () => { propertyWrites += 1; },
    }),
  };
  script.ScriptApp = {
    getProjectTriggers: () => { throw new Error('trigger must not be inspected'); },
  };

  assert.throws(() => script.setup(), /missing sheet Projects/);
  assert.equal(propertyWrites, 0);
  assert.deepEqual(Object.keys(legacy.sheets), originalNames);
});

test('setup commissions only V2 and repeated setup leaves one hourly sync trigger', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const properties = installServices(script, sheet, standardDrive());
  const menus = [];
  const ui = { createMenu(name) {
    const menu = { name, items: [],
      addItem(label, handler) { this.items.push({ label, handler }); return this; },
      addSeparator() { this.items.push({ separator: true }); return this; },
      addToUi() { menus.push(this); return this; },
    };
    return menu;
  } };
  script.SpreadsheetApp.getActive = () => sheet;
  script.SpreadsheetApp.getUi = () => ui;
  const projects = sheet.getSheetByName('Projects');
  script.registryV2SheetsMetadata_ = id => {
    assert.equal(id, 'v2-sheet-id');
    return {
      Projects: { sheet_id: 1, table_id: 'projects-table-id',
        table_name: 'ProjectsCatalogV2', table_count: 1,
        table_range: { startRowIndex: 0, startColumnIndex: 0,
          endRowIndex: projects.getLastRow(), endColumnIndex: projects.getLastColumn() } },
      _Registry: { sheet_id: 2, table_id: '', table_count: 0 },
      _Facets: { sheet_id: 3, table_id: '', table_count: 0 },
      _Assets: { sheet_id: 4, table_id: '', table_count: 0 },
      _Audit: { sheet_id: 5, table_id: '', table_count: 0 },
    };
  };
  let triggers = [];
  let deleted = 0;
  script.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(trigger) {
      deleted += 1;
      triggers = triggers.filter(candidate => candidate !== trigger);
    },
    newTrigger(handler) {
      const builder = {
        timeBased() { return this; },
        everyHours(hours) { assert.equal(hours, 1); return this; },
        create() {
          const trigger = { getHandlerFunction: () => handler };
          triggers.push(trigger);
          return trigger;
        },
      };
      return builder;
    },
  };

  script.setup();
  script.setup();

  assert.equal(properties.AI4S_REGISTRY_V2_SPREADSHEET_ID, 'v2-sheet-id');
  assert.equal(properties.AI4S_REGISTRY_SPREADSHEET_ID, undefined,
    'setup must not restore a V1 workbook property');
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].getHandlerFunction(), 'syncDrive');
  assert.equal(deleted, 1);
  assert.equal(menus.length, 2);
  assert.deepEqual(Object.keys(sheet.sheets).sort(), [
    'Projects', '_Assets', '_Audit', '_Config', '_Facets', '_Registry', '_Taxonomy',
  ].sort());
  assert.equal(sheet.getSheetByName('_Audit').rows.length, 3);
});

test('setup validates commissioning properties and Drive access before any control-plane write', async t => {
  const cases = [
    ['missing callback secret', values => {
      delete values.AI4S_PREVIEW_CALLBACK_SECRET;
    }, /AI4S_PREVIEW_CALLBACK_SECRET/],
    ['short callback secret', values => {
      values.AI4S_PREVIEW_CALLBACK_SECRET = 'too-short';
    }, /at least 32 characters/],
    ['invalid Netlify site id', values => {
      values.AI4S_NETLIFY_SITE_ID = 'not-a-site-id';
    }, /valid Netlify Site ID/],
    ['unreadable Drive root', () => {}, /accessible Drive folder/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const script = loadAppsScript();
      const sheet = fixture(script);
      const values = installServices(script, sheet, standardDrive());
      mutate(values);
      let propertyWrites = 0;
      script.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: key => values[key] ?? null,
          setProperty(key, value) {
            propertyWrites += 1;
            values[key] = String(value);
          },
        }),
      };
      script.SpreadsheetApp.getActive = () => sheet;
      const projects = sheet.getSheetByName('Projects');
      script.registryV2SheetsMetadata_ = () => ({
        Projects: { sheet_id: 1, table_id: 'projects-table-id',
          table_name: 'ProjectsCatalogV2', table_count: 1,
          table_range: { startRowIndex: 0, startColumnIndex: 0,
            endRowIndex: projects.getLastRow(), endColumnIndex: projects.getLastColumn() } },
        _Registry: { sheet_id: 2, table_id: '', table_count: 0 },
        _Facets: { sheet_id: 3, table_id: '', table_count: 0 },
        _Assets: { sheet_id: 4, table_id: '', table_count: 0 },
        _Audit: { sheet_id: 5, table_id: '', table_count: 0 },
      });
      if (name === 'unreadable Drive root') {
        script.DriveApp.getFolderById = () => { throw new Error('HTTP 403'); };
      }
      let triggerReads = 0;
      script.ScriptApp = {
        getProjectTriggers() { triggerReads += 1; return []; },
      };

      assert.throws(() => script.setup(), expected);
      assert.equal(propertyWrites, 0);
      assert.equal(triggerReads, 0);
      assert.equal(values.AI4S_REGISTRY_V2_SPREADSHEET_ID, 'v2-sheet-id',
        'the pre-existing stable ID is unchanged');
      assert.equal(sheet.getSheetByName('_Audit').rows.length, 1,
        'failed commissioning does not append an audit event');
    });
  }
});

test('onOpen exposes the V2 owner workflow and no archived V1 menu actions', () => {
  const script = loadAppsScript();
  let menu;
  script.SpreadsheetApp = { getUi: () => ({ createMenu(name) {
    menu = { name, items: [],
      addItem(label, handler) { this.items.push({ label, handler }); return this; },
      addSeparator() { return this; },
      addToUi() { return this; },
    };
    return menu;
  } }) };

  script.onOpen();

  assert.equal(menu.name, 'AI4S dashboard');
  assert.deepEqual(menu.items.map(item => item.handler), [
    'syncDriveFromMenu', 'refreshRegistryV2Status', 'publishPreview',
    'showPreviewPublishStatus', 'showPreviewSite', 'publishProduction',
    'showBuildUrl', 'setup', 'showHelp',
  ]);
  assert.equal(menu.items.some(item => [
    'showCardMapping', 'showMetaTemplate', 'publishSite',
  ].includes(item.handler)), false);
});

test('V2 operational config keeps public metadata in _Config and overrides controls from properties', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const config = sheet.getSheetByName('_Config');
  const header = config.rows[0];
  Object.keys(script.REGISTRY_V2_OPERATION_PROPERTIES).forEach(key => {
    config.rows.push(row(header, {
      key, value: `sheet-${key}-must-not-win`, visibility: 'internal',
    }));
  });
  installServices(script, sheet, standardDrive());
  const getSheetByName = sheet.getSheetByName.bind(sheet);
  sheet.getSheetByName = name => {
    if (['Demos', 'Config', 'Log'].includes(name)) {
      throw new Error(`archived V1 sheet ${name} must not be read`);
    }
    return getSheetByName(name);
  };

  const cfg = script.registryV2OperationalConfig_(sheet);

  assert.equal(cfg.site_title, 'Registry v2');
  assert.equal(cfg.access_token, 'secret');
  assert.equal(cfg.drive_folder_url,
    'https://drive.google.com/drive/folders/root-folder-12345');
  assert.equal(cfg.netlify_build_hook,
    'https://api.netlify.com/build_hooks/production-hook');
  assert.equal(cfg.netlify_preview_build_hook,
    'https://api.netlify.com/build_hooks/preview-hook');
  assert.equal(cfg.production_branch, 'main');
  assert.equal(cfg.preview_branch, 'develop');
  assert.equal(cfg.auto_publish_target, 'off');
  assert.equal(cfg.netlify_site_id, '33333333-4444-4555-8666-777777777777');
  assert.equal(cfg.preview_callback_secret,
    'callback-secret-with-at-least-thirty-two-characters');
});

test('syncDriveUnlocked reconciles V2 items directly with no V1 row map', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const before = { captured: 'v2-state' };
  const root = { id: 'root-folder-12345' };
  const items = [{ file: { getId: () => 'page-new-12345' } }];
  const cfg = {
    drive_folder_url: 'https://drive.google.com/drive/folders/root-folder-12345',
  };
  script.registryV2Spreadsheet_ = () => sheet;
  script.registryV2WorkbookState_ = value => {
    assert.equal(value, sheet);
    return before;
  };
  script.registryV2OperationalConfig_ = (value, state) => {
    assert.equal(value, sheet);
    assert.equal(state, before);
    return cfg;
  };
  script.registrySpreadsheet_ = () => { throw new Error('V1 resolver must not run'); };
  script.readConfig_ = () => { throw new Error('V1 Config must not run'); };
  script.DriveApp = { getFolderById(id) {
    assert.equal(id, 'root-folder-12345');
    return root;
  } };
  script.collectDemos_ = value => {
    assert.equal(value, root);
    return items;
  };
  script.registryV2AutoIngest_ = function (context, receivedCfg, receivedItems) {
    assert.equal(arguments.length, 3, 'there is no fourth v1ByFileId argument');
    assert.equal(context.enabled, true);
    assert.equal(context.spreadsheet, sheet);
    assert.equal(context.spreadsheet_id, 'v2-sheet-id');
    assert.equal(context.before, before);
    assert.equal(receivedCfg, cfg);
    assert.equal(receivedItems, items);
    return { added: 1, updated: 0, checked: 1, skipped: 0, missing: 0 };
  };
  script.logEvent_ = () => {};

  const result = script.syncDriveUnlocked_();

  assert.equal(result.nNew, 1);
  assert.equal(result.registryV2.checked, 1);
});

test('audit logging writes the nine-column V2 record and removes CJK text', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive());

  script.logEvent_('sync-error 中文', 'Drive scan failed 中文');

  const audit = sheet.getSheetByName('_Audit');
  assert.equal(audit.rows.length, 2);
  const record = audit.rows[1];
  assert.equal(record.length, 9);
  assert.equal(record[0], '11111111-2222-4333-8444-555555555555');
  assert.equal(record[2], 'apps_script');
  assert.match(record[3], /^sync-error \[non-English text omitted\]$/);
  assert.equal(record[7], 'error');
  assert.match(record[8], /^Drive scan failed \[non-English text omitted\]$/);
  assert.doesNotMatch(record.join(' '), /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u);
});

test('v2 manifest reads all six tables, keeps default images null, and applies audience', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  installServices(script, sheet, standardDrive());

  const production = script.doGet({ parameter: {
    token: 'secret', action: 'manifest', audience: 'production',
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

  const archived = script.doGet({ parameter: {
    token: 'secret', schema: '1', action: 'manifest', audience: 'production',
  } });
  assert.deepEqual({ ok: archived.ok, error: archived.error }, {
    ok: false, error: 'schema 1 is archived; schema must be 2',
  });
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
  const cfg = script.registryV2OperationalConfig_(script.registrySpreadsheet_());
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

test('v2 build snapshot cache compiles once, serves pinned blobs, and recompiles the closing manifest', () => {
  const script = loadAppsScript();
  const sheet = fixture(script, { cardName: 'card.png' });
  let blobReads = 0;
  installServices(script, sheet, standardDrive({
    withAsset: true,
    onPageBlob: () => { blobReads += 1; },
    onAssetBlob: () => { blobReads += 1; },
  }));
  let driveFileReads = 0;
  const getFileById = script.DriveApp.getFileById;
  script.DriveApp.getFileById = id => {
    driveFileReads += 1;
    return getFileById(id);
  };
  let stateReads = 0;
  let compiles = 0;
  const readState = script.registryV2WorkbookState_;
  const compile = script.registryV2CompileState_;
  script.registryV2WorkbookState_ = (...args) => {
    stateReads += 1;
    return readState(...args);
  };
  script.registryV2CompileState_ = (...args) => {
    compiles += 1;
    return compile(...args);
  };

  const opening = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(opening.ok, true);
  assert.equal(stateReads, 1, 'config and compiler share one workbook state');
  assert.equal(compiles, 1);
  assert.equal(script.__testSnapshotCache.calls.put, 2,
    'opening stores the snapshot and its audience marker');

  const page = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: opening.registry_revision,
  } });
  const asset = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'asset', audience: 'production',
    id: 'live-card', registry_revision: opening.registry_revision,
  } });
  assert.equal(page.ok, true);
  assert.equal(asset.ok, true);
  assert.equal(stateReads, 1, 'pinned blobs do not reopen the workbook');
  assert.equal(compiles, 1, 'pinned blobs reuse the opening snapshot');

  const closing = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    registry_revision: opening.registry_revision,
  } });
  assert.equal(closing.ok, true);
  assert.equal(closing.registry_revision, opening.registry_revision);
  assert.equal(stateReads, 2, 'closing manifest reads one fresh workbook state');
  assert.equal(compiles, 2, 'closing manifest never trusts the cache');
  assert.equal(script.__testSnapshotCache.calls.put, 4,
    'closing verification refreshes only after compiling the live Registry');
  assert.equal(blobReads, 2, 'only the requested page and asset bytes are read');
  assert.equal(driveFileReads, 9,
    'compile 2+2, page read 2, and asset page/asset checks 1+2');
});

test('v2 cold-cache pinned opening manifest primes page and asset reads', () => {
  const script = loadAppsScript();
  const sheet = fixture(script, { cardName: 'card.png' });
  const files = standardDrive({ withAsset: true });
  installServices(script, sheet, files);
  const state = script.registryV2WorkbookState_(sheet);
  const cfg = script.registryV2OperationalConfig_(sheet, state);
  const expected = script.registryV2Snapshot_(sheet, cfg, 'production', state)
    .registry_revision;
  script.__testSnapshotCache.entries.clear();

  let compiles = 0;
  const compile = script.registryV2CompileState_;
  script.registryV2CompileState_ = (...args) => {
    compiles += 1;
    return compile(...args);
  };
  const opening = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    registry_revision: expected,
  } });
  assert.equal(opening.ok, true);
  assert.equal(compiles, 1);
  const page = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: expected,
  } });
  const asset = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'asset', audience: 'production',
    id: 'live-card', registry_revision: expected,
  } });
  assert.equal(page.ok, true);
  assert.equal(asset.ok, true);
  assert.equal(compiles, 1, 'both pinned resources use the opening manifest cache');
});

test('v2 cache-hit resources reject page or asset parent changes before reading bytes', async t => {
  for (const moved of ['page', 'asset']) {
    await t.test(moved, () => {
      const script = loadAppsScript();
      const root = folder('root-folder-12345');
      const demo = folder('demo-folder-12345', [root]);
      const other = folder('other-folder-12345', [root]);
      let pageParents = [demo];
      let assetParents = [demo];
      let blobReads = 0;
      const files = {
        'page-live-12345': driveFile({
          id: 'page-live-12345', name: 'live.html', mime: 'text/html',
          parentsProvider: () => pageParents,
        }),
        'page-draft-12345': driveFile({
          id: 'page-draft-12345', name: 'draft.html', mime: 'text/html', parents: [demo],
        }),
        'asset-live-12345': driveFile({
          id: 'asset-live-12345', name: 'card.png', mime: 'image/png',
          parentsProvider: () => assetParents,
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          onBlob: () => { blobReads += 1; },
        }),
      };
      installServices(script, fixture(script, { cardName: 'card.png' }), files);
      const manifest = script.doGet({ parameter: {
        token: 'secret', schema: '2', action: 'manifest', audience: 'production',
      } });
      assert.equal(manifest.ok, true);
      if (moved === 'page') pageParents = [other];
      else assetParents = [other];

      const result = script.doGet({ parameter: {
        token: 'secret', schema: '2', action: 'asset', audience: 'production',
        id: 'live-card', registry_revision: manifest.registry_revision,
      } });
      assert.deepEqual({ ok: result.ok, error: result.error },
        { ok: false, error: 'could not read asset' });
      assert.equal(blobReads, 0);
    });
  }
});

test('v2 pinned requests safely recompile after snapshot cache expiry', () => {
  const script = loadAppsScript();
  let blobReads = 0;
  installServices(script, fixture(script), {
    ...standardDrive(),
    'page-live-12345': driveFile({
      id: 'page-live-12345', name: 'live.html', mime: 'text/html',
      parents: [folder('demo-folder-12345', [folder('root-folder-12345')])],
      onBlob: () => { blobReads += 1; },
    }),
  });
  let compiles = 0;
  const compile = script.registryV2CompileState_;
  script.registryV2CompileState_ = (...args) => {
    compiles += 1;
    return compile(...args);
  };
  const manifest = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(manifest.ok, true);
  script.__testSnapshotCache.advance(
    script.REGISTRY_V2_SNAPSHOT_CACHE_TTL_SECONDS * 1000 + 1);

  const expired = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: manifest.registry_revision,
  } });
  assert.equal(expired.ok, true);
  assert.match(expired.html, /live\.html/);
  assert.equal(compiles, 2, 'an evicted snapshot is rebuilt before serving');
  assert.equal(blobReads, 1);
});

test('v2 cached blobs retain their pinned view while the closing manifest detects a Sheet edit', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  let blobReads = 0;
  installServices(script, sheet, standardDrive({
    onPageBlob: () => { blobReads += 1; },
  }));
  const opening = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(opening.ok, true);

  const projects = sheet.getSheetByName('Projects');
  projects.rows[1][projects.rows[0].indexOf('Project Title')] = 'Edited during build';
  const pinnedPage = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: opening.registry_revision,
  } });
  assert.equal(pinnedPage.ok, true, 'the opening revision remains internally consistent');

  const closing = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    registry_revision: opening.registry_revision,
  } });
  assert.equal(closing.ok, false);
  assert.equal(closing.error, 'registry revision changed');
  assert.notEqual(closing.registry_revision, opening.registry_revision);
  const oldRevision = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'file', audience: 'production',
    id: 'page-live-12345', registry_revision: opening.registry_revision,
  } });
  assert.equal(oldRevision.error, 'registry revision changed');
  assert.equal(blobReads, 1,
    'the stale revision is rejected before a second page blob read');
});

test('v2 marker invalidation prevents a replaced image old revision from reading its old blob', () => {
  const script = loadAppsScript();
  const sheet = fixture(script, { cardName: 'card.png' });
  let oldBlobReads = 0;
  const files = standardDrive({
    withAsset: true,
    onAssetBlob: () => { oldBlobReads += 1; },
  });
  const root = folder('root-folder-12345');
  const demo = folder('demo-folder-12345', [root]);
  files['asset-new-12345'] = driveFile({
    id: 'asset-new-12345', name: 'card-new.png', mime: 'image/png', parents: [demo],
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  installServices(script, sheet, files);
  const opening = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'manifest', audience: 'production',
  } });
  assert.equal(opening.ok, true);

  const projects = sheet.getSheetByName('Projects').rows;
  projects[1][projects[0].indexOf('Card Image')] = 'card-new.png';
  const assets = sheet.getSheetByName('_Assets').rows;
  assets[1][assets[0].indexOf('drive_file_id')] = 'asset-new-12345';
  assets[1][assets[0].indexOf('source_file_name')] = 'card-new.png';
  assets[1][assets[0].indexOf('source_modified_at')]
    = new Date('2026-08-13T00:00:00.000Z');
  script.registryV2InvalidateSnapshotMarkers_();

  const stale = script.doGet({ parameter: {
    token: 'secret', schema: '2', action: 'asset', audience: 'production',
    id: 'live-card', registry_revision: opening.registry_revision,
  } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'registry revision changed');
  assert.notEqual(stale.registry_revision, opening.registry_revision);
  assert.equal(oldBlobReads, 0);
});

test('v2 malformed, unavailable, and oversized caches fall back to authoritative compilation', async t => {
  await t.test('malformed descriptor', () => {
    const script = loadAppsScript();
    installServices(script, fixture(script), standardDrive());
    const manifest = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    const key = script.registryV2SnapshotCacheKey_('production', manifest.registry_revision);
    const entry = script.__testSnapshotCache.entries.get(key);
    const envelope = JSON.parse(entry.value);
    delete envelope.snapshot.files_by_id['page-live-12345'].name;
    entry.value = JSON.stringify(envelope);
    let compiles = 0;
    const compile = script.registryV2CompileState_;
    script.registryV2CompileState_ = (...args) => {
      compiles += 1;
      return compile(...args);
    };
    const page = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'file', audience: 'production',
      id: 'page-live-12345', registry_revision: manifest.registry_revision,
    } });
    assert.equal(page.ok, true);
    assert.equal(compiles, 1);
    assert.equal(script.__testSnapshotCache.calls.remove, 1);
  });

  await t.test('CacheService get and put throw', () => {
    const script = loadAppsScript();
    installServices(script, fixture(script), standardDrive());
    const manifest = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    script.CacheService = { getScriptCache: () => ({
      get() { throw new Error('cache unavailable'); },
      put() { throw new Error('cache unavailable'); },
      remove() {}, removeAll() {},
    }) };
    const page = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'file', audience: 'production',
      id: 'page-live-12345', registry_revision: manifest.registry_revision,
    } });
    assert.equal(page.ok, true);
  });

  await t.test('oversized cache DTO', () => {
    const script = loadAppsScript();
    installServices(script, fixture(script), standardDrive());
    const cacheable = script.registryV2CacheableSnapshot_;
    script.registryV2CacheableSnapshot_ = snapshot => ({
      ...cacheable(snapshot),
      padding: 'x'.repeat(script.REGISTRY_V2_SNAPSHOT_CACHE_MAX_BYTES),
    });
    const manifest = script.doGet({ parameter: {
      token: 'secret', schema: '2', action: 'manifest', audience: 'production',
    } });
    assert.equal(manifest.ok, true);
    assert.equal(script.__testSnapshotCache.calls.put, 0,
      'the UTF-8 guard runs before CacheService.put');
  });
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

test('Preview always binds Hook state to V2 and a legacy schema property cannot downgrade it', () => {
  const script = loadAppsScript();
  const revisionV2 = `sha256:${'2'.repeat(64)}`;
  script.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => key === 'AI4S_PREVIEW_REGISTRY_SCHEMA' ? '1' : null,
    }),
  };
  script.registrySnapshot_ = () => { throw new Error('archived V1 must not be read'); };
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

function autoItem(file, folderName, meta = {}) {
  return {
    file,
    folderName,
    provFile: null,
    picFile: null,
    card: null,
    stamp: new Date('2026-08-13T00:00:00.000Z'),
    notes: [],
    registryRead: {
      html: `<html><title>${meta.title || folderName}</title></html>`,
      meta,
      card: {},
      notes: [],
    },
  };
}

function existingItems(files) {
  return [
    autoItem(files['page-live-12345'], 'live'),
    autoItem(files['page-draft-12345'], 'draft'),
  ];
}

function installAutoCandidate(script, sheet, options = {}) {
  const files = standardDrive();
  const root = folder('root-folder-12345');
  const parent = folder('new-demo-folder-12345', [root]);
  const file = driveFile({
    id: options.fileId || 'page-new-12345',
    name: options.fileName || 'new-demo.html',
    mime: 'text/html',
    parents: [parent],
  });
  files[file.getId()] = file;
  installServices(script, sheet, files);
  const cfg = { drive_folder_url: 'https://drive.google.com/drive/folders/root-folder-12345' };
  const meta = options.meta || {
    title: 'New demo', description: 'New card summary.', data_source: 'New dataset',
    audience: 'Not a supported audience',
  };
  const item = autoItem(file, options.folderName ?? 'new-demo', meta);
  const registry = sheet.getSheetByName('_Registry');
  const fileCheckColumn = registry.rows[0].indexOf('file_check');
  registry.rows[1][fileCheckColumn] = 'ok';
  return {
    files, file, item, cfg,
    existingItems: existingItems(files),
    items: [...existingItems(files), item],
  };
}

function selectedCardScenario(script, options = {}) {
  const sheet = fixture(script);
  const files = standardDrive();
  installServices(script, sheet, files);
  const projects = sheet.getSheetByName('Projects');
  const cardColumn = projects.rows[0].indexOf('Card Image');
  const altColumn = projects.rows[0].indexOf('Image Alt Text');
  projects.rows[1][cardColumn] = options.name || 'card.png';
  projects.rows[1][altColumn] = 'Selected Drive card.';
  const parent = files['page-live-12345'].getParents().next();
  const card = driveFile({
    id: options.id || 'asset-live-first-12345',
    name: options.name || 'card.png',
    mime: options.mime || 'image/png',
    parents: [parent],
    modified: options.modified || Date.parse('2026-08-13T01:00:00.000Z'),
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  files[card.getId()] = card;
  const items = existingItems(files);
  items[0].imageFiles = [card];
  items[1].imageFiles = [];
  const cfg = {
    drive_folder_url: 'https://drive.google.com/drive/folders/root-folder-12345',
  };
  const before = script.registryV2WorkbookState_(sheet);
  const plan = script.registryV2AutoPlan_(before, cfg, items);
  return { sheet, files, card, items, cfg, before, plan };
}

test('Drive asset reconciliation adds a selected direct-child card in the same atomic batch', () => {
  const script = loadAppsScript();
  const scenario = selectedCardScenario(script);
  const assets = scenario.plan.target._Assets.values;
  const ah = assets[0];
  assert.equal(assets.length, 2);
  assert.equal(assets[1][ah.indexOf('asset_id')], 'asset-live-project-card');
  assert.equal(assets[1][ah.indexOf('drive_file_id')], 'asset-live-first-12345');
  assert.equal(assets[1][ah.indexOf('source_type')], 'drive');
  assert.equal(assets[1][ah.indexOf('external_url')], '');
  assert.equal(assets[1][ah.indexOf('public_path')], 'assets/cards/live-project.png');
  const registry = scenario.plan.target._Registry.values;
  assert.equal(registry[1][registry[0].indexOf('card_asset_id')], 'asset-live-project-card');

  let payload;
  script.Sheets = { Spreadsheets: { batchUpdate: body => { payload = body; } } };
  script.registryV2BatchWrite_('v2-sheet-id', scenario.before, scenario.plan, {
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2' },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  assert.ok(payload.requests.some(request => request.appendCells?.sheetId === 4),
    JSON.stringify(payload.requests));
  assert.ok(payload.requests.some(request => request.updateCells?.range.sheetId === 2
    && request.updateCells.range.startColumnIndex === registry[0].indexOf('card_asset_id')),
  JSON.stringify(payload.requests));
});

test('Drive asset reconciliation follows a same-name replacement to its new Drive ID', () => {
  const script = loadAppsScript();
  const scenario = selectedCardScenario(script);
  const parent = scenario.files['page-live-12345'].getParents().next();
  const replacement = driveFile({
    id: 'asset-live-replacement-67890', name: 'card.png', mime: 'image/png',
    parents: [parent], modified: Date.parse('2026-08-13T02:00:00.000Z'),
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  scenario.files[replacement.getId()] = replacement;
  const items = existingItems(scenario.files);
  items[0].imageFiles = [replacement];
  items[1].imageFiles = [];
  const next = script.registryV2AutoPlan_(scenario.plan.target, scenario.cfg, items);
  const assets = next.target._Assets.values;
  const ah = assets[0];
  assert.equal(assets.length, 2);
  assert.equal(assets[1][ah.indexOf('asset_id')], 'asset-live-project-card',
    'the public asset identity remains stable');
  assert.equal(assets[1][ah.indexOf('drive_file_id')], replacement.getId());
  assert.equal(assets.flat().includes(scenario.card.getId()), false);
  assert.equal(assets[1][ah.indexOf('source_modified_at')], '2026-08-13T02:00:00.000Z');
});

test('clearing Card Image removes the _Assets row and _Registry link', () => {
  const script = loadAppsScript();
  const scenario = selectedCardScenario(script);
  const projects = scenario.plan.target.Projects.values;
  projects[1][projects[0].indexOf('Card Image')] = '';
  projects[1][projects[0].indexOf('Image Alt Text')] = '';
  const next = script.registryV2AutoPlan_(
    scenario.plan.target, scenario.cfg, scenario.items,
  );
  assert.equal(next.target._Assets.rows, 1);
  assert.equal(next.target._Assets.values.length, 1);
  const registry = next.target._Registry.values;
  assert.equal(registry[1][registry[0].indexOf('card_asset_id')], '');
  assert.equal(next.compiled.demos[0].card_asset, null);
});

test('Drive auto-ingest creates one blocked v2 Draft pair and is idempotent by file_id', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const before = script.registryV2WorkbookState_(sheet);
  const baseline = script.registryV2CompileState_(sheet, candidate.cfg, 'preview', before);
  const plan = script.registryV2AutoPlan_(
    before, candidate.cfg, candidate.items,
  );

  assert.equal(plan.added, 1);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.target.Projects.rows, before.Projects.rows + 1);
  assert.equal(plan.target._Registry.rows, before._Registry.rows + 1);
  const project = plan.target.Projects.values.at(-1);
  const projectHeader = plan.target.Projects.values[0];
  const p = name => project[projectHeader.indexOf(name)];
  assert.equal(p('Status'), 'Draft');
  assert.equal(p('Public Permission'), 'Preview only');
  assert.equal(p('Featured'), false);
  assert.equal(p('Project Title'), 'New demo');
  assert.equal(p('Card Summary'), 'New card summary.');
  assert.equal(p('Data Source'), 'New dataset');
  assert.equal(p('Audience'), 'General');
  assert.equal(p('Card Image'), '');
  assert.match(p('Readiness'), /Action needed/);
  assert.equal(p('demo_id'), 'demo-new-demo');
  const registry = plan.target._Registry.values.at(-1);
  const registryHeader = plan.target._Registry.values[0];
  assert.equal(registry[registryHeader.indexOf('file_id')], 'page-new-12345');
  assert.equal(registry[registryHeader.indexOf('readiness')], 'blocked');
  const finalCompile = script.registryV2CompileState_(
    null, candidate.cfg, 'preview', plan.target,
  );
  assert.equal(finalCompile.registry_revision, baseline.registry_revision,
    'a blocked Draft is not build-facing and cannot request a deploy');

  const again = script.registryV2AutoPlan_(
    plan.target, candidate.cfg, candidate.items,
  );
  assert.equal(again.added, 0);
  assert.equal(again.target.Projects.rows, plan.target.Projects.rows);
  assert.equal(again.target._Registry.rows, plan.target._Registry.rows);
  assert.equal(script.registryV2CompileState_(null, candidate.cfg, 'preview', again.target)
    .registry_revision, finalCompile.registry_revision);
});

test('v2 auto-ingest projects exact taxonomy and leaves unknown initial taxonomy blocked', () => {
  const exactScript = loadAppsScript();
  const exactSheet = fixture(exactScript);
  const exact = installAutoCandidate(exactScript, exactSheet, { meta: {
    title: 'Exact demo', description: 'Exact summary.', data_source: 'Exact data',
    audience: 'Intro', department: 'Chemistry', subtopic: 'Materials',
    task_type: 'Classification', method: 'PCA',
  } });
  const exactPlan = exactScript.registryV2AutoPlan_(
    exactScript.registryV2WorkbookState_(exactSheet), exact.cfg,
    exact.items,
  );
  const registryHeader = exactPlan.target._Registry.values[0];
  const registry = exactPlan.target._Registry.values.at(-1);
  assert.equal(registry[registryHeader.indexOf('department_id')], 'chemistry');
  assert.equal(registry[registryHeader.indexOf('subtopic_id')], 'materials');
  assert.equal(registry[registryHeader.indexOf('task_ids')], 'classification');
  assert.equal(registry[registryHeader.indexOf('method_ids')], 'pca');
  assert.equal(exactPlan.target._Facets.rows, 7);

  const badScript = loadAppsScript();
  const badSheet = fixture(badScript);
  const bad = installAutoCandidate(badScript, badSheet, { meta: {
    title: 'Bad demo', description: 'Bad summary.', department: 'Chemistry',
    subtopic: 'Materials', task_type: 'Classification', method: 'PCA, Invented method',
  } });
  const badPlan = badScript.registryV2AutoPlan_(
    badScript.registryV2WorkbookState_(badSheet), bad.cfg,
    bad.items,
  );
  const badHeader = badPlan.target.Projects.values[0];
  const badProject = badPlan.target.Projects.values.at(-1);
  assert.equal(badProject[badHeader.indexOf('Methods')], '');
  assert.match(badProject[badHeader.indexOf('Readiness')], /Action needed/);
  assert.equal(badSheet.getSheetByName('Projects').writeCalls.length, 0);
  assert.equal(badSheet.getSheetByName('_Registry').writeCalls.length, 0);
});

test('v2 auto-ingest sanitises CJK initial copy without weakening existing English-only checks', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet, { meta: {
    title: '中文标题', description: '中文摘要', data_source: '中文数据',
  } });
  const plan = script.registryV2AutoPlan_(
    script.registryV2WorkbookState_(sheet), candidate.cfg,
    candidate.items,
  );
  const header = plan.target.Projects.values[0];
  const project = plan.target.Projects.values.at(-1);
  assert.equal(project[header.indexOf('Project Title')], 'new-demo');
  assert.equal(project[header.indexOf('Card Summary')], '');
  assert.equal(project[header.indexOf('Data Source')], '');
  assert.match(project[header.indexOf('Readiness')], /Action needed/);
});

test('v2 auto-ingest excludes loose HTML and skips identity conflicts without replacing file_id', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const loose = installAutoCandidate(script, sheet, { folderName: '' });
  const conflictFile = driveFile({
    id: 'replacement-file-12345', name: 'replacement.html', mime: 'text/html',
    parents: [folder('replacement-folder-12345', [folder('root-folder-12345')])],
  });
  loose.files[conflictFile.getId()] = conflictFile;
  const conflict = autoItem(conflictFile, 'live', { title: 'Replacement' });
  const ambiguousFile = driveFile({
    id: 'ambiguous-file-12345', name: 'first.html', mime: 'text/html',
    parents: [folder('ambiguous-folder-12345', [folder('root-folder-12345')])],
  });
  const ambiguous = autoItem(ambiguousFile, 'ambiguous-demo', { title: 'Ambiguous' });
  ambiguous.notes = ['primary page unclear (first.html, second.html) — using first.html'];
  const before = script.registryV2WorkbookState_(sheet);
  const plan = script.registryV2AutoPlan_(
    before, loose.cfg, [...loose.existingItems, loose.item, conflict, ambiguous],
  );
  assert.equal(plan.added, 0);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.events.length, 2, 'loose root HTML is silently outside v2 scope');
  assert.equal(plan.target.Projects.rows, before.Projects.rows);
  const fileColumn = plan.target._Registry.values[0].indexOf('file_id');
  assert.equal(plan.target._Registry.values[1][fileColumn], 'page-live-12345');
  assert.equal(plan.target._Registry.values.flat().includes('replacement-file-12345'), false);
});

test('Projects edits project to machine tables while missing files remain recorded', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const files = standardDrive();
  installServices(script, sheet, files);
  const projects = sheet.getSheetByName('Projects');
  const titleColumn = projects.rows[0].indexOf('Project Title');
  const methodsColumn = projects.rows[0].indexOf('Methods');
  projects.rows[1][titleColumn] = 'Human-edited title';
  projects.rows[1][methodsColumn] = 'UMAP';
  const cfg = { drive_folder_url: 'https://drive.google.com/drive/folders/root-folder-12345' };
  const live = autoItem(files['page-live-12345'], 'live');
  const plan = script.registryV2AutoPlan_(
    script.registryV2WorkbookState_(sheet), cfg, [live],
  );
  const rh = plan.target._Registry.values[0];
  assert.equal(plan.target._Registry.values[1][rh.indexOf('title')], 'Human-edited title');
  assert.equal(plan.target._Registry.values[1][rh.indexOf('method_ids')], 'umap');
  assert.equal(plan.target._Registry.values[2][rh.indexOf('file_check')], 'missing');
  assert.equal(plan.target._Registry.values.length, 3, 'missing records are retained');
  assert.ok(plan.target._Facets.values.some(row => row[0] === 'demo-live'
    && row[1] === 'method' && row[2] === 'umap'));

  const restored = script.registryV2AutoPlan_(plan.target, cfg, existingItems(files));
  assert.equal(restored.target._Registry.values[2][rh.indexOf('file_check')], 'ok');
  assert.equal(restored.target._Registry.values.length, 3,
    'restoring a file updates its machine check without replacing its identity');
});

test('v2 guarded auto-ingest detects a concurrent human edit before its first write', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const context = {
    enabled: true, spreadsheet: sheet, spreadsheet_id: 'v2-sheet-id',
    before: script.registryV2WorkbookState_(sheet),
  };
  let mutated = false;
  sheet.getSheetByName('Projects').beforeRead = () => {
    if (mutated) return;
    mutated = true;
    sheet.getSheetByName('Projects').rows[1][3] = 'Concurrent human title';
  };
  let writes = 0;
  script.registryV2SheetsMetadata_ = () => ({
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2',
      table_range: { startRowIndex: 0, startColumnIndex: 0, endRowIndex: 3, endColumnIndex: 16 } },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  script.registryV2BatchWrite_ = () => { writes += 1; };
  assert.throws(
    () => script.registryV2AutoIngest_(
      context, candidate.cfg, candidate.items,
    ),
    /changed during Drive scan/,
  );
  assert.equal(writes, 0);
  assert.equal(sheet.getSheetByName('Projects').writeCalls.length, 0);
  assert.equal(sheet.getSheetByName('_Registry').writeCalls.length, 0);
});

test('v2 guarded auto-ingest reports failure when post-write state is not exact', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const context = {
    enabled: true, spreadsheet: sheet, spreadsheet_id: 'v2-sheet-id',
    before: script.registryV2WorkbookState_(sheet),
  };
  script.registryV2SheetsMetadata_ = () => ({
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2',
      table_range: { startRowIndex: 0, startColumnIndex: 0, endRowIndex: 3, endColumnIndex: 16 } },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  script.registryV2BatchWrite_ = () => {};
  assert.throws(
    () => script.registryV2AutoIngest_(
      context, candidate.cfg, candidate.items,
    ),
    /could not verify the completed write/,
  );
});

test('v2 guarded auto-ingest detects a concurrent formula before its first write', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const context = {
    enabled: true, spreadsheet: sheet, spreadsheet_id: 'v2-sheet-id',
    before: script.registryV2WorkbookState_(sheet),
  };
  let mutated = false;
  sheet.getSheetByName('Projects').beforeRead = () => {
    if (mutated) return;
    mutated = true;
    sheet.getSheetByName('Projects').formulas['2:4'] = '=UPPER("Live project")';
  };
  let writes = 0;
  script.registryV2SheetsMetadata_ = () => { throw new Error('must stop before metadata'); };
  script.registryV2BatchWrite_ = () => { writes += 1; };
  assert.throws(
    () => script.registryV2AutoIngest_(
      context, candidate.cfg, candidate.items,
    ),
    /changed during Drive scan/,
  );
  assert.equal(writes, 0);
});

test('v2 guarded auto-ingest verifies success from a freshly opened spreadsheet', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const context = {
    enabled: true, spreadsheet: sheet, spreadsheet_id: 'v2-sheet-id',
    before: script.registryV2WorkbookState_(sheet),
  };
  script.registryV2SheetsMetadata_ = () => ({
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2',
      table_range: { startRowIndex: 0, startColumnIndex: 0, endRowIndex: 3, endColumnIndex: 16 } },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  let target;
  script.registryV2BatchWrite_ = (id, before, plan) => { target = plan.target; };
  const fresh = new FakeSpreadsheet(Object.fromEntries(
    script.REGISTRY_V2_COMPILE_SHEETS.map(name => [name, []]),
  ));
  let freshOpens = 0;
  script.SpreadsheetApp.openById = id => {
    assert.equal(id, 'v2-sheet-id');
    freshOpens += 1;
    Object.entries(target).forEach(([name, table]) => {
      fresh.sheets[name] = new FakeSheet(table.values);
      table.formulas.forEach((row, r) => row.forEach((formula, c) => {
        if (formula) fresh.sheets[name].formulas[`${r + 1}:${c + 1}`] = formula;
      }));
    });
    return fresh;
  };
  const result = script.registryV2AutoIngest_(
    context, candidate.cfg, candidate.items,
  );
  assert.equal(result.added, 1);
  assert.equal(freshOpens, 1);
});

test('v2 native table metadata uses the Sheets advanced service', () => {
  const script = loadAppsScript();
  let call;
  script.Sheets = { Spreadsheets: { get: (spreadsheetId, options) => {
    call = { spreadsheetId, options };
    return { sheets: [
      { properties: { sheetId: 1, title: 'Projects' }, tables: [{
        tableId: 'projects-table-id', name: 'ProjectsCatalogV2',
        range: { startRowIndex: 0, endRowIndex: 16, startColumnIndex: 0, endColumnIndex: 16 },
      }] },
      { properties: { sheetId: 2, title: '_Registry' } },
      { properties: { sheetId: 3, title: '_Facets' }, tables: [] },
      { properties: { sheetId: 4, title: '_Assets' }, tables: [] },
      { properties: { sheetId: 5, title: '_Audit' }, tables: [] },
    ] };
  } } };
  const metadata = script.registryV2SheetsMetadata_('v2-sheet-id');
  assert.equal(call.spreadsheetId, 'v2-sheet-id');
  assert.equal(call.options.fields,
    'sheets(properties(sheetId,title),tables(tableId,name,range))');
  assert.equal(metadata.Projects.table_id, 'projects-table-id');
  assert.equal(metadata._Registry.sheet_id, 2);
  assert.equal(metadata._Facets.table_count, 0);
  assert.equal(metadata._Assets.table_count, 0);
  assert.equal(metadata._Audit.table_count, 0);
});

test('v2 batch append addresses Projects by native tableId and machines by sheetId', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const candidate = installAutoCandidate(script, sheet);
  const before = script.registryV2WorkbookState_(sheet);
  const plan = script.registryV2AutoPlan_(
    before, candidate.cfg, candidate.items,
  );
  let payload;
  script.Sheets = { Spreadsheets: { batchUpdate: (body, spreadsheetId) => {
    assert.equal(spreadsheetId, 'v2-sheet-id');
    payload = body;
  } } };
  script.registryV2BatchWrite_('v2-sheet-id', before, plan, {
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2' },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  const appends = payload.requests.map(request => request.appendCells).filter(Boolean);
  assert.ok(appends.some(request => request.tableId === 'ProjectsCatalogV2'));
  assert.ok(appends.some(request => request.sheetId === 2 && request.tableId === undefined));
});

test('v2 batch clears stale _Facets formulas even when their display value matches', () => {
  const script = loadAppsScript();
  const sheet = fixture(script);
  const files = standardDrive();
  installServices(script, sheet, files);
  const facets = sheet.getSheetByName('_Facets');
  facets.formulas['2:3'] = '="classification"';
  facets.rows[1][2] = 'classification';
  const before = script.registryV2WorkbookState_(sheet);
  const plan = script.registryV2AutoPlan_(before, {
    drive_folder_url: 'https://drive.google.com/drive/folders/root-folder-12345',
  }, existingItems(files));
  let payload;
  script.Sheets = { Spreadsheets: { batchUpdate: (body, spreadsheetId) => {
    assert.equal(spreadsheetId, 'v2-sheet-id');
    payload = body;
  } } };
  script.registryV2BatchWrite_('v2-sheet-id', before, plan, {
    Projects: { sheet_id: 1, table_id: 'ProjectsCatalogV2' },
    _Registry: { sheet_id: 2, table_id: '' },
    _Facets: { sheet_id: 3, table_id: '' },
    _Assets: { sheet_id: 4, table_id: '' },
  });
  const cleared = payload.requests.filter(request => request.updateCells
    && request.updateCells.range.sheetId === 3);
  assert.ok(cleared.length > 0, JSON.stringify(payload.requests));
  assert.ok(cleared.some(request => request.updateCells.rows[0].values.some(cell =>
    cell.userEnteredValue
      && !Object.prototype.hasOwnProperty.call(cell.userEnteredValue, 'formulaValue'))),
  JSON.stringify(cleared));
});

test('a v2 sync error disables both automatic Preview requests and retries', () => {
  const script = loadAppsScript();
  script.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  script.SpreadsheetApp = { flush: () => {} };
  script.syncDriveUnlocked_ = () => ({ error: 'Registry v2 auto-ingest failed' });
  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2OperationalConfig_ = () => ({});
  script.logEvent_ = () => {};
  let observed;
  script.maintainPreviewPublish_ = (ss, cfg, options) => {
    observed = options;
    return { attempted: false, becameReady: false, phase: 'dirty' };
  };
  const result = script.syncDrive();
  assert.match(result.error, /v2 auto-ingest failed/);
  assert.equal(observed.allowAutoRequest, false);
  assert.equal(observed.allowAttempt, false);
});

test('CacheService marker invalidation failure never changes the sync result', () => {
  const script = loadAppsScript();
  let released = false;
  script.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { released = true; },
    }),
  };
  script.CacheService = { getScriptCache: () => ({
    removeAll() { throw new Error('cache unavailable'); },
  }) };
  script.SpreadsheetApp = { flush: () => {} };
  script.syncDriveUnlocked_ = () => ({ ok: true, registryV2: { checked: 2 } });
  script.registryV2Spreadsheet_ = () => ({});
  script.registryV2OperationalConfig_ = () => ({});
  script.maintainPreviewPublish_ = () => ({
    attempted: false, becameReady: false, phase: 'ready',
  });
  script.logEvent_ = () => {};

  const result = script.syncDrive();
  assert.equal(result.ok, true);
  assert.equal(result.previewPublishPhase, 'ready');
  assert.equal(released, true);
});
