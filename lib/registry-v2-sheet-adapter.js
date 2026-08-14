'use strict';

/**
 * Pure Node adapter for the Registry v2 Google Sheet layout.
 *
 * It intentionally knows nothing about Google APIs. Callers pass rectangular
 * arrays exactly as returned by a Sheet read and receive compiler input plus a
 * guarded write-back plan. This keeps identity reconciliation testable before
 * the Apps Script integration is changed.
 */

const {
  FIELD_OWNERS,
  HIDDEN_SHEET_HEADERS,
  HUMAN_PROJECT_COLUMNS,
  SCHEMA_VERSION,
  compileRegistryV2,
} = require('./registry-v2');

const PROJECTS_SHEET_NAME = 'Projects';
const OPTIONS_SHEET_NAME = 'Options';
const OPTIONS_SHEET_COLUMNS = deepFreeze([
  { key: 'category', label: 'Category' },
  { key: 'option_id', label: 'Option ID' },
  { key: 'option_label', label: 'Option Label' },
  { key: 'aliases', label: 'Aliases' },
  { key: 'display_order', label: 'Display Order' },
  { key: 'active', label: 'Active' },
  { key: 'description', label: 'Description' },
]);
const OPTIONS_SHEET_HEADERS = Object.freeze(OPTIONS_SHEET_COLUMNS.map(column => column.label));
const OPTION_LABEL_DELIMITER_RE = /[;,|\r\n]/;
const PROJECTS_IDENTITY_COLUMN = Object.freeze({
  key: 'demo_id',
  label: 'demo_id',
  owner: FIELD_OWNERS.DERIVED,
  editable: false,
  hidden: true,
});
const PROJECTS_SHEET_COLUMNS = Object.freeze([
  ...HUMAN_PROJECT_COLUMNS.map(column => Object.freeze({ ...column, hidden: false })),
  PROJECTS_IDENTITY_COLUMN,
]);
const PROJECTS_SHEET_HEADERS = Object.freeze(PROJECTS_SHEET_COLUMNS.map(column => column.label));

// These are the physical v2 sandbox headers. They intentionally reuse the
// compiler contract so the Sheet has one machine schema, not compatibility
// aliases for an abandoned draft layout.
const SHEET_HEADERS = deepFreeze({
  Projects: PROJECTS_SHEET_HEADERS,
  Options: OPTIONS_SHEET_HEADERS,
  _Registry: HIDDEN_SHEET_HEADERS._Registry,
  _Taxonomy: HIDDEN_SHEET_HEADERS._Taxonomy,
  _Facets: HIDDEN_SHEET_HEADERS._Facets,
  _Assets: HIDDEN_SHEET_HEADERS._Assets,
  _Config: HIDDEN_SHEET_HEADERS._Config,
  _Schema: HIDDEN_SHEET_HEADERS._Schema,
});

const SITE_METADATA_CONFIG_KEYS = Object.freeze(['site_title', 'site_tagline']);
const OPTIONAL_PROJECT_KEYS = new Set(['data_types', 'instrument_types']);
const OPTIONAL_REGISTRY_HEADERS = new Set(['data_type_ids', 'instrument_type_ids']);
const REQUIRED_PROJECT_KEYS = Object.freeze(
  PROJECTS_SHEET_COLUMNS
    .map(column => column.key)
    .filter(key => !OPTIONAL_PROJECT_KEYS.has(key)),
);
const CANONICAL_MACHINE_HEADERS = deepFreeze(Object.fromEntries(
  ['_Registry', '_Taxonomy', '_Facets', '_Assets', '_Config']
    .map(sheetName => [sheetName, SHEET_HEADERS[sheetName]]),
));

class RegistryV2SheetAdapterError extends Error {
  constructor(errors) {
    const safeErrors = Array.isArray(errors) ? errors : [];
    super(`Registry v2 Sheet adapter failed with ${safeErrors.length} structural error${safeErrors.length === 1 ? '' : 's'}.`);
    this.name = 'RegistryV2SheetAdapterError';
    this.errors = safeErrors;
  }
}

/**
 * Convert one complete Sheet snapshot into compiler input.
 *
 * Accepted input is either `{ Projects, _Registry, ... }` or
 * `{ sheets: { Projects, _Registry, ... } }`. Each property is a 2-D array
 * including its header row.
 */
function adaptRegistryV2Sheet(snapshot) {
  const sheets = snapshot && snapshot.sheets ? snapshot.sheets : snapshot;
  const errors = [];
  if (!sheets || typeof sheets !== 'object') {
    throw new RegistryV2SheetAdapterError([
      adapterError('snapshot_invalid', 'A Sheet snapshot object is required.'),
    ]);
  }

  findNonEnglishSheetCells(sheets).forEach(location => errors.push(adapterError(
    'sheet_text_not_english',
    `${location.sheet} row ${location.row} column ${location.column} must use English-only text.`,
    location,
  )));

  const optionsPresent = sheets.Options !== undefined && sheets.Options !== null;
  const projectResult = projectsRowsToProjects(sheets.Projects, errors, {
    requireOptionColumns: optionsPresent,
  });
  const options = optionsRowsToOptions(sheets.Options, errors);
  const registryObjects = machineRowsToObjects(
    '_Registry', sheets._Registry, CANONICAL_MACHINE_HEADERS._Registry, errors,
    { optionalHeaders: optionsPresent ? new Set() : OPTIONAL_REGISTRY_HEADERS },
  );
  const taxonomyObjects = machineRowsToObjects(
    '_Taxonomy', sheets._Taxonomy, CANONICAL_MACHINE_HEADERS._Taxonomy, errors,
  );
  const facetObjects = machineRowsToObjects(
    '_Facets', sheets._Facets, CANONICAL_MACHINE_HEADERS._Facets, errors,
  );
  const assetObjects = machineRowsToObjects(
    '_Assets', sheets._Assets, CANONICAL_MACHINE_HEADERS._Assets, errors,
  );
  const configObjects = machineRowsToObjects(
    '_Config', sheets._Config, CANONICAL_MACHINE_HEADERS._Config, errors,
  );

  const sourceProjections = registryRowsToSourceProjections(
    registryObjects.rows,
    projectResult.identities,
    errors,
  );
  const taxonomy = taxonomyRowsToTaxonomy(taxonomyObjects.rows, errors);
  const facets = facetRowsToFacets(facetObjects.rows);
  const assets = assetRowsToAssets(assetObjects.rows);
  const config = configRowsToConfig(configObjects.rows, errors);

  if (errors.length) throw new RegistryV2SheetAdapterError(errors);

  return {
    compilerInput: {
      projects: projectResult.projects,
      sourceProjections,
      taxonomy,
      options,
      facets,
      assets,
    },
    config,
    siteMetadata: {
      title: clean(config.site_title),
      tagline: clean(config.site_tagline),
    },
    sheetState: {
      projects: projectResult.projects,
      identities: projectResult.identities,
      projectHeaderIndex: projectResult.headerIndex,
      sourceProjections,
    },
  };
}

/** Compile a snapshot and produce guarded writes for derived human columns. */
function compileRegistryV2Sheet(snapshot, options) {
  const adapted = adaptRegistryV2Sheet(snapshot);
  const compiled = compileRegistryV2(adapted.compilerInput);
  const writebackPatches = buildProjectWritebackPatches(
    compiled,
    adapted.sheetState,
    options?.previewBaseUrl || adapted.config.preview_base_url,
  );
  return {
    compilerInput: adapted.compilerInput,
    config: adapted.config,
    siteMetadata: adapted.siteMetadata,
    compiled,
    writebackPatches,
    hiddenSheetRows: {
      _Registry: registryToSheetRows(compiled.hidden._Registry),
      _Taxonomy: taxonomyToSheetRows(adapted.compilerInput.taxonomy),
      _Facets: facetsToSheetRows(compiled.hidden._Facets),
      _Assets: assetsToSheetRows(compiled.hidden._Assets),
    },
  };
}

/**
 * Parse the visible human fields plus the hidden demo_id identity column.
 * Data Type and Instrument Type are rollout-optional so a legacy 15-field
 * Projects grid remains readable. Header labels may be canonical English
 * labels or stable English keys.
 */
function projectsRowsToProjects(rows, externalErrors, options) {
  const errors = externalErrors || [];
  const matrix = requireMatrix(PROJECTS_SHEET_NAME, rows, errors);
  if (!matrix.length) return emptyProjectResult();

  const headerIndex = indexProjectHeaders(matrix[0], errors, options);
  const projects = [];
  const identities = [];
  const seenDemoIds = new Set();

  matrix.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (isBlankRow(row)) return;
    const demoId = clean(cell(row, headerIndex.demo_id));
    if (!demoId) {
      errors.push(adapterError(
        'project_demo_id_missing',
        `Projects row ${rowNumber} has no hidden demo_id.`,
        { row_number: rowNumber },
      ));
    } else if (seenDemoIds.has(demoId)) {
      errors.push(adapterError(
        'project_demo_id_duplicate',
        `Projects uses demo_id ${demoId} more than once.`,
        { row_number: rowNumber, demo_id: demoId },
      ));
    }
    if (demoId) seenDemoIds.add(demoId);

    const project = { row_number: rowNumber };
    for (const column of HUMAN_PROJECT_COLUMNS) {
      project[column.key] = cell(row, headerIndex[column.key]);
    }
    projects.push(project);
    identities.push({ row_number: rowNumber, demo_id: demoId });
  });

  return { projects, identities, headerIndex };
}

function indexProjectHeaders(headerRow, errors, options) {
  const accepted = new Map();
  for (const column of PROJECTS_SHEET_COLUMNS) {
    accepted.set(normalizeHeader(column.key), column.key);
    accepted.set(normalizeHeader(column.label), column.key);
  }
  const headerIndex = {};
  const unknown = [];
  headerRow.forEach((raw, index) => {
    const text = clean(raw);
    if (!text) return;
    const key = accepted.get(normalizeHeader(text));
    if (!key) {
      unknown.push(text);
      return;
    }
    if (Object.hasOwn(headerIndex, key)) {
      errors.push(adapterError(
        'projects_header_duplicate',
        `Projects header ${key} appears more than once.`,
        { field_key: key },
      ));
      return;
    }
    headerIndex[key] = index;
  });

  const requiredKeys = options?.requireOptionColumns
    ? PROJECTS_SHEET_COLUMNS.map(column => column.key)
    : REQUIRED_PROJECT_KEYS;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(headerIndex, key)) {
      errors.push(adapterError(
        'projects_header_missing',
        `Projects is missing required column ${key}.`,
        { field_key: key },
      ));
    }
  }
  if (unknown.length) {
    errors.push(adapterError(
      'projects_header_unknown',
      `Projects has unsupported columns: ${unknown.join(', ')}.`,
      { headers: unknown },
    ));
  }
  return headerIndex;
}

/** Parse the optional, human-visible controlled vocabulary grid. */
function optionsRowsToOptions(rows, externalErrors) {
  const errors = externalErrors || [];
  const result = { data_types: [], instrument_types: [] };
  if (rows === undefined || rows === null) return result;

  const matrix = requireMatrix(OPTIONS_SHEET_NAME, rows, errors);
  if (!matrix.length) return result;
  const headerIndex = indexOptionsHeaders(matrix[0], errors);

  matrix.slice(1).forEach((row, index) => {
    // Google Sheets can materialize an otherwise unused checkbox row as
    // Active=false. Treat only that exact physical placeholder as blank so
    // this adapter matches the Apps Script workbook reader. Whitespace or any
    // other populated option cell must still reach strict validation.
    if (isBlankOptionRow(row, headerIndex.active)) return;
    const rowNumber = index + 2;
    const category = clean(cell(row, headerIndex.category)).toLowerCase();
    const group = category === 'data_type'
      ? 'data_types'
      : category === 'instrument_type' ? 'instrument_types' : '';
    if (!group) {
      errors.push(adapterError(
        'option_category_invalid',
        `Options row ${rowNumber} has unsupported Category ${category || '(empty)'}.`,
        { row_number: rowNumber, category },
      ));
      return;
    }

    const active = requiredBoolean(cell(row, headerIndex.active));
    const optionId = clean(cell(row, headerIndex.option_id));
    const optionLabel = clean(cell(row, headerIndex.option_label));
    const displayOrder = cell(row, headerIndex.display_order);
    if (!active.valid) {
      errors.push(adapterError(
        'option_active_invalid',
        `Options ${category}/${optionId || '(empty)'} must have an explicit boolean Active value.`,
        { row_number: rowNumber, category, option_id: optionId },
      ));
    }
    if (OPTION_LABEL_DELIMITER_RE.test(optionLabel)) {
      errors.push(adapterError(
        'option_label_delimiter_invalid',
        `Options ${category}/${optionId || '(empty)'} Option Label contains a list delimiter.`,
        { row_number: rowNumber, category, option_id: optionId },
      ));
    }
    if (typeof displayOrder !== 'number' || !Number.isFinite(displayOrder)) {
      errors.push(adapterError(
        'option_display_order_invalid',
        `Options ${category}/${optionId || '(empty)'} Display Order must be a finite number.`,
        { row_number: rowNumber, category, option_id: optionId },
      ));
    }
    result[group].push({
      id: optionId,
      label: optionLabel,
      aliases: cell(row, headerIndex.aliases),
      display_order: displayOrder,
      active: active.value,
      description: clean(cell(row, headerIndex.description)),
    });
  });
  return result;
}

function indexOptionsHeaders(headerRow, errors) {
  const accepted = new Map(OPTIONS_SHEET_COLUMNS.map(column => [
    normalizeHeader(column.label), column.key,
  ]));
  const headerIndex = {};
  let invalid = false;
  asArray(headerRow).forEach((raw, index) => {
    const key = accepted.get(normalizeHeader(raw));
    if (!key || Object.hasOwn(headerIndex, key)) {
      invalid = true;
      return;
    }
    headerIndex[key] = index;
  });
  if (OPTIONS_SHEET_COLUMNS.some(column => !Object.hasOwn(headerIndex, column.key))) {
    invalid = true;
  }
  if (invalid) {
    errors.push(adapterError(
      'options_header_invalid',
      `Options must use exactly these headers: ${OPTIONS_SHEET_HEADERS.join(', ')}.`,
      { headers: asArray(headerRow).map(clean) },
    ));
  }
  return headerIndex;
}

/** Join current Projects positions to stable machine data by hidden demo_id. */
function registryRowsToSourceProjections(registryRows, identities, externalErrors) {
  const errors = externalErrors || [];
  const registryByDemoId = new Map();
  for (const row of asArray(registryRows)) {
    const demoId = clean(row.demo_id);
    if (!demoId) continue;
    if (registryByDemoId.has(demoId)) {
      errors.push(adapterError(
        'registry_demo_id_duplicate',
        `_Registry uses demo_id ${demoId} more than once.`,
        { demo_id: demoId },
      ));
      continue;
    }
    registryByDemoId.set(demoId, row);
  }

  return asArray(identities).map(identity => {
    const demoId = clean(identity.demo_id);
    const registry = registryByDemoId.get(demoId);
    if (!registry) {
      errors.push(adapterError(
        'registry_projection_missing',
        `_Registry has no source projection for ${demoId || '(empty demo_id)'}.`,
        { row_number: identity.row_number, demo_id: demoId },
      ));
    }
    const source = registry || {};
    return {
      // Always use the current Projects row. _Registry.row_number is derived
      // audit state and may be stale after a user sort or row move.
      row_number: identity.row_number,
      demo_id: demoId,
      entry_type: clean(source.entry_type) || 'project',
      slug: clean(source.slug),
      sort_order: source.sort_order,
      file_id: clean(source.file_id),
      file_check: clean(source.file_check),
      date_added: source.date_added,
    };
  });
}

function taxonomyRowsToTaxonomy(rows, externalErrors) {
  const errors = externalErrors || [];
  const taxonomy = { departments: [], subtopics: [], tasks: [], methods: [] };
  const typeMap = new Map([
    ['department', 'departments'], ['departments', 'departments'],
    ['subtopic', 'subtopics'], ['subtopics', 'subtopics'],
    ['task', 'tasks'], ['tasks', 'tasks'],
    ['method', 'methods'], ['methods', 'methods'],
  ]);

  for (const row of asArray(rows)) {
    const termId = clean(row.term_id);
    if (!termId && isBlankObject(row)) continue;
    const group = typeMap.get(clean(row.term_type).toLowerCase());
    if (!group) {
      errors.push(adapterError(
        'taxonomy_term_type_invalid',
        `_Taxonomy term ${termId || '(empty)'} has unsupported term_type ${clean(row.term_type) || '(empty)'}.`,
        { term_id: termId },
      ));
      continue;
    }

    const active = requiredBoolean(row.active);
    if (!active.valid) {
      errors.push(adapterError(
        'taxonomy_active_invalid',
        `_Taxonomy term ${termId || '(empty)'} must have an explicit boolean active value.`,
        { term_id: termId, value: row.active },
      ));
    }
    const common = {
      id: termId,
      label: clean(row.label),
      display_order: row.display_order,
      active: active.value,
    };
    if (clean(row.aliases)) common.aliases = row.aliases;
    if (group === 'departments') {
      taxonomy.departments.push({
        ...common,
        short_label: clean(row.short_label),
        description: clean(row.description),
        theme_key: clean(row.theme_key),
        icon_key: clean(row.icon_key),
      });
    } else if (group === 'subtopics') {
      taxonomy.subtopics.push({
        ...common,
        department_id: clean(row.parent_id),
      });
    } else {
      taxonomy[group].push(common);
    }
  }
  return taxonomy;
}

function facetRowsToFacets(rows) {
  return asArray(rows)
    .filter(row => !isBlankObject(row))
    .map(row => ({
      demo_id: clean(row.demo_id),
      facet_type: clean(row.facet_type),
      term_id: clean(row.term_id),
      display_order: row.display_order,
    }));
}

function assetRowsToAssets(rows) {
  return asArray(rows)
    .filter(row => !isBlankObject(row))
    .map(row => ({
      asset_id: clean(row.asset_id),
      demo_id: clean(row.demo_id),
      role: clean(row.role),
      source_type: clean(row.source_type),
      drive_file_id: clean(row.drive_file_id),
      source_file_name: clean(row.source_file_name),
      external_url: clean(row.external_url),
      mime_type: clean(row.mime_type),
      alt_text: clean(row.alt_text),
      credit: clean(row.credit),
      license: clean(row.license),
      checksum: clean(row.checksum),
      public_path: clean(row.public_path),
      sync_status: clean(row.sync_status),
      source_modified_at: row.source_modified_at,
    }));
}

function configRowsToConfig(rows, externalErrors) {
  const errors = externalErrors || [];
  const config = {};
  for (const row of asArray(rows)) {
    const key = clean(row.key);
    if (!key && isBlankObject(row)) continue;
    if (!key) {
      errors.push(adapterError('config_key_missing', '_Config contains a row with no key.'));
      continue;
    }
    if (Object.hasOwn(config, key)) {
      errors.push(adapterError(
        'config_key_duplicate',
        `_Config key ${key} appears more than once.`,
        { key },
      ));
      continue;
    }
    config[key] = row.value;
  }
  return config;
}

/**
 * Return cell-level patches guarded by the same row's hidden identity cell.
 * A writer must re-read `identity_guard.range` and compare `expected_value`
 * immediately before applying either write. If the row moved, re-adapt first.
 */
function buildProjectWritebackPatches(compiled, sheetState, previewBaseUrl) {
  const state = sheetState && typeof sheetState === 'object' ? sheetState : {};
  const headerIndex = state.projectHeaderIndex || {};
  for (const key of ['readiness', 'preview_url', 'demo_id']) {
    if (!Number.isInteger(headerIndex[key])) {
      throw new TypeError(`Sheet state is missing the ${key} column index.`);
    }
  }
  const readinessByDemo = new Map(asArray(compiled?.readiness).map(item => [item.demo_id, item]));
  const projectionByDemo = new Map(asArray(state.sourceProjections).map(item => [item.demo_id, item]));
  const projectByRow = new Map(asArray(state.projects).map(item => [item.row_number, item]));
  const patches = [];

  for (const identity of asArray(state.identities)) {
    const demoId = clean(identity.demo_id);
    const rowNumber = identity.row_number;
    const readiness = readinessByDemo.get(demoId) || {
      status: 'blocked',
      issues: [{ code: 'readiness_missing', message: 'No compiler readiness result.' }],
    };
    const projection = projectionByDemo.get(demoId) || {};
    const project = projectByRow.get(rowNumber) || {};
    const readinessValue = formatReadiness(readiness, project.status);
    const previewValue = readiness.status === 'ready'
      && clean(project.status).toLowerCase() !== 'archived'
      && clean(projection.entry_type).toLowerCase() === 'project'
      ? buildPreviewUrl(previewBaseUrl, projection.slug)
      : '';
    const guard = {
      range: a1Cell(PROJECTS_SHEET_NAME, headerIndex.demo_id, rowNumber),
      expected_value: demoId,
    };
    patches.push({
      sheet_name: PROJECTS_SHEET_NAME,
      row_number: rowNumber,
      demo_id: demoId,
      identity_guard: guard,
      writes: [
        {
          field_key: 'readiness',
          range: a1Cell(PROJECTS_SHEET_NAME, headerIndex.readiness, rowNumber),
          value: readinessValue,
        },
        {
          field_key: 'preview_url',
          range: a1Cell(PROJECTS_SHEET_NAME, headerIndex.preview_url, rowNumber),
          value: previewValue,
        },
      ],
    });
  }
  return patches;
}

function formatReadiness(readiness, status) {
  const normalizedStatus = clean(status).toLowerCase();
  if (readiness.status === 'not_applicable' || normalizedStatus === 'archived') {
    return '— Archived';
  }
  if (readiness.status === 'ready') {
    return normalizedStatus === 'draft' ? '✅ Preview ready' : '✅ Publication ready';
  }
  const labels = asArray(readiness.issues)
    .map(item => readinessIssueLabel(item && item.code))
    .filter(Boolean);
  return `⛔ Action needed: ${labels.length ? [...new Set(labels)].join(', ') : 'Needs review'}`;
}

function readinessIssueLabel(value) {
  const code = clean(value);
  const labels = {
    audience_invalid: 'Audience',
    card_asset_index_missing: 'Card Image',
    card_asset_mime_invalid: 'Card Image',
    card_asset_public_path_invalid: 'Card Image',
    card_asset_source_mismatch: 'Card Image',
    card_asset_sync_unhealthy: 'Card Image',
    card_image_alt_missing: 'Image Alt Text',
    card_summary_missing: 'Card Summary',
    department_missing: 'Department',
    data_type_ambiguous: 'Data Type',
    data_type_inactive: 'Data Type',
    data_type_unknown: 'Data Type',
    entry_type_invalid: 'Record Type',
    featured_invalid: 'Featured',
    file_check_unhealthy: 'Source File Check',
    file_id_missing: 'Source File',
    method_missing: 'Methods',
    instrument_type_ambiguous: 'Instrument Type',
    instrument_type_inactive: 'Instrument Type',
    instrument_type_unknown: 'Instrument Type',
    readiness_missing: 'Readiness',
    status_invalid: 'Status',
    subtopic_missing: 'Subtopic',
    subtopic_parent_mismatch: 'Department / Subtopic',
    task_missing: 'Task Type',
    title_missing: 'Project Title',
  };
  if (labels[code]) return labels[code];
  return code
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function buildPreviewUrl(baseValue, slugValue) {
  const base = clean(baseValue);
  const slug = clean(slugValue);
  if (!base || !slug) return '';
  try {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const url = new URL(`demos/${encodeURIComponent(slug)}/`, normalizedBase);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

/** Convert fixture/domain objects into the physical Projects grid. */
function projectsToSheetRows(projects, identities) {
  const idByRow = new Map(asArray(identities).map(identity => [identity.row_number, identity.demo_id]));
  const rows = [PROJECTS_SHEET_HEADERS.slice()];
  asArray(projects).forEach((project, index) => {
    const rowNumber = Number.isInteger(project.row_number) ? project.row_number : index + 2;
    rows.push([
      ...HUMAN_PROJECT_COLUMNS.map(column => project[column.key] ?? ''),
      project.demo_id || idByRow.get(rowNumber) || '',
    ]);
  });
  return rows;
}

/** Convert controlled option groups into the canonical visible Options grid. */
function optionsToSheetRows(options) {
  const source = options && typeof options === 'object' ? options : {};
  const rows = [];
  for (const [group, category] of [
    ['data_types', 'data_type'],
    ['instrument_types', 'instrument_type'],
  ]) {
    for (const option of asArray(source[group])) {
      rows.push({
        category,
        option_id: option.id,
        option_label: option.label,
        aliases: Array.isArray(option.aliases) ? option.aliases.join(', ') : option.aliases,
        display_order: option.display_order,
        active: option.active,
        description: option.description,
      });
    }
  }
  return [
    OPTIONS_SHEET_HEADERS.slice(),
    ...rows.map(row => OPTIONS_SHEET_COLUMNS.map(column => row[column.key] ?? '')),
  ];
}

function registryToSheetRows(records) {
  const physical = asArray(records).map(record => ({
    ...record,
    schema_version: record.schema_version ?? SCHEMA_VERSION,
  }));
  return objectsToRows(SHEET_HEADERS._Registry, physical);
}

function taxonomyToSheetRows(taxonomy) {
  const source = taxonomy && typeof taxonomy === 'object' ? taxonomy : {};
  const rows = [];
  for (const [group, termType] of [
    ['departments', 'department'],
    ['subtopics', 'subtopic'],
    ['tasks', 'task'],
    ['methods', 'method'],
  ]) {
    for (const term of asArray(source[group])) {
      rows.push({
        term_type: termType,
        term_id: term.id,
        parent_id: group === 'subtopics' ? term.department_id : '',
        label: term.label,
        short_label: term.short_label,
        description: term.description,
        display_order: term.display_order,
        active: term.active,
        aliases: Array.isArray(term.aliases) ? term.aliases.join(', ') : term.aliases,
        theme_key: term.theme_key,
        icon_key: term.icon_key,
      });
    }
  }
  return objectsToRows(SHEET_HEADERS._Taxonomy, rows);
}

function facetsToSheetRows(facets) {
  return objectsToRows(SHEET_HEADERS._Facets, facets);
}

function assetsToSheetRows(assets) {
  return objectsToRows(SHEET_HEADERS._Assets, assets);
}

function configToSheetRows(config) {
  const rows = Object.entries(config || {}).map(([key, value]) => ({
    key,
    value,
    visibility: 'internal',
    description: SITE_METADATA_CONFIG_KEYS.includes(key) ? 'Site metadata' : '',
  }));
  return objectsToRows(SHEET_HEADERS._Config, rows);
}

function machineRowsToObjects(sheetName, rows, canonicalHeaders, errors, options) {
  const matrix = requireMatrix(sheetName, rows, errors);
  if (!matrix.length) return { rows: [], headerIndex: {} };
  const headerIndex = indexMachineHeaders(
    sheetName, matrix[0], canonicalHeaders, errors, options,
  );
  const headers = matrix[0].map(clean);
  return {
    headerIndex,
    rows: matrix.slice(1)
      .filter(row => !isBlankRow(row))
      .map(row => Object.fromEntries(headers.map((header, index) => [header, cell(row, index)]))),
  };
}

function indexMachineHeaders(sheetName, headerRow, canonicalHeaders, errors, options) {
  const index = {};
  const canonical = new Set(canonicalHeaders);
  headerRow.forEach((raw, position) => {
    const header = clean(raw);
    if (!header) return;
    if (!canonical.has(header)) {
      errors.push(adapterError(
        'machine_header_unknown',
        `${sheetName} has unsupported column ${header}.`,
        { sheet_name: sheetName, field_key: header },
      ));
      return;
    }
    if (Object.hasOwn(index, header)) {
      errors.push(adapterError(
        'machine_header_duplicate',
        `${sheetName} header ${header} appears more than once.`,
        { sheet_name: sheetName, field_key: header },
      ));
      return;
    }
    index[header] = position;
  });
  for (const header of canonicalHeaders) {
    if (!Object.hasOwn(index, header) && !options?.optionalHeaders?.has(header)) {
      errors.push(adapterError(
        'machine_header_missing',
        `${sheetName} is missing required column ${header}.`,
        { sheet_name: sheetName, field_key: header },
      ));
    }
  }
  return index;
}

function requireMatrix(sheetName, rows, errors) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) {
    errors.push(adapterError(
      'sheet_matrix_missing',
      `${sheetName} must be a non-empty two-dimensional array with a header row.`,
      { sheet_name: sheetName },
    ));
    return [];
  }
  return rows;
}

function objectsToRows(headers, rows) {
  return [headers.slice(), ...asArray(rows).map(row => headers.map(header => row?.[header] ?? ''))];
}

function requiredBoolean(value) {
  if (value === true || value === false) return { valid: true, value };
  return { valid: false, value: false };
}

function findNonEnglishSheetCells(sheets) {
  const locations = [];
  for (const [sheet, rows] of Object.entries(sheets || {})) {
    if (!Array.isArray(rows)) continue;
    rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, columnIndex) => {
        if (containsCjkText(value)) {
          locations.push({ sheet, row: rowIndex + 1, column: columnIndex + 1 });
        }
      });
    });
  }
  return locations;
}

function containsCjkText(value) {
  return typeof value === 'string'
    && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function a1Cell(sheetName, zeroBasedColumn, rowNumber) {
  const escaped = `'${String(sheetName).replace(/'/g, "''")}'`;
  return `${escaped}!${columnLetters(zeroBasedColumn + 1)}${rowNumber}`;
}

function columnLetters(oneBasedColumn) {
  let value = oneBasedColumn;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function emptyProjectResult() {
  return { projects: [], identities: [], headerIndex: {} };
}

function adapterError(code, message, details) {
  return { code, message, ...(details || {}) };
}

function cell(row, index) {
  return Number.isInteger(index) ? row[index] : '';
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeHeader(value) {
  return clean(value).toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function isBlankRow(row) {
  return !Array.isArray(row) || row.every(value => clean(value) === '');
}

function isBlankOptionRow(row, activeIndex) {
  return !Array.isArray(row) || row.every((value, index) => (
    value === '' || value === null || value === undefined
      || (index === activeIndex && value === false)
  ));
}

function isBlankObject(row) {
  return !row || typeof row !== 'object' || Object.values(row).every(value => clean(value) === '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

module.exports = {
  OPTIONS_SHEET_COLUMNS,
  OPTIONS_SHEET_HEADERS,
  OPTIONS_SHEET_NAME,
  PROJECTS_IDENTITY_COLUMN,
  PROJECTS_SHEET_COLUMNS,
  PROJECTS_SHEET_HEADERS,
  PROJECTS_SHEET_NAME,
  RegistryV2SheetAdapterError,
  SHEET_HEADERS,
  SITE_METADATA_CONFIG_KEYS,
  adaptRegistryV2Sheet,
  assetRowsToAssets,
  assetsToSheetRows,
  buildPreviewUrl,
  buildProjectWritebackPatches,
  compileRegistryV2Sheet,
  configRowsToConfig,
  configToSheetRows,
  facetRowsToFacets,
  facetsToSheetRows,
  formatReadiness,
  optionsRowsToOptions,
  optionsToSheetRows,
  projectsRowsToProjects,
  projectsToSheetRows,
  registryRowsToSourceProjections,
  registryToSheetRows,
  taxonomyRowsToTaxonomy,
  taxonomyToSheetRows,
};
