var V2=(function(){var module={exports:{}};

'use strict';

/**
 * Registry v2 is the boundary between the small, human-maintained Projects
 * sheet and the stable machine index consumed by the site build.
 *
 * This module deliberately has no Google Apps Script, filesystem, network or
 * third-party dependencies. Adapters are responsible for reading Sheet rows
 * and Drive metadata; this compiler only validates and normalises those values.
 */

const SCHEMA_VERSION = 2;

const FIELD_OWNERS = Object.freeze({
  EDITOR: 'EDITOR',
  DERIVED: 'DERIVED',
  DRIVE_SYNC: 'DRIVE_SYNC',
  PROVENANCE_IMPORT: 'PROVENANCE_IMPORT',
});

const HUMAN_PROJECT_COLUMNS = Object.freeze([
  column('status', 'Status', FIELD_OWNERS.EDITOR, true),
  column('readiness', 'Readiness', FIELD_OWNERS.DERIVED, false),
  column('preview_url', 'Preview URL', FIELD_OWNERS.DERIVED, false),
  column('title', 'Project Title', FIELD_OWNERS.EDITOR, true),
  column('card_summary', 'Card Summary', FIELD_OWNERS.EDITOR, true),
  column('department', 'Department', FIELD_OWNERS.EDITOR, true),
  column('subtopic', 'Subtopic', FIELD_OWNERS.EDITOR, true),
  column('task', 'Task Type', FIELD_OWNERS.EDITOR, true),
  column('methods', 'Methods', FIELD_OWNERS.EDITOR, true),
  column('data_types', 'Data Type', FIELD_OWNERS.EDITOR, true),
  column('instrument_types', 'Instrument Type', FIELD_OWNERS.EDITOR, true),
  column('card_image', 'Card Image', FIELD_OWNERS.EDITOR, true),
  column('image_alt', 'Image Alt Text', FIELD_OWNERS.EDITOR, true),
  column('audience', 'Audience', FIELD_OWNERS.EDITOR, true),
  column('featured', 'Featured', FIELD_OWNERS.EDITOR, true),
  column('data_source', 'Data Source', FIELD_OWNERS.PROVENANCE_IMPORT, false),
  // Publication permission is a human approval. Drive/provenance automation
  // may suggest "Preview only", but it must never grant Public by itself.
  column('public_permission', 'Public Permission', FIELD_OWNERS.EDITOR, true),
]);

const HUMAN_PROJECT_HEADERS = Object.freeze(HUMAN_PROJECT_COLUMNS.map(item => item.key));

const HIDDEN_SHEET_HEADERS = deepFreeze({
  _Registry: [
    'schema_version', 'row_number', 'demo_id', 'entry_type', 'slug', 'status',
    'readiness', 'featured', 'sort_order', 'title', 'card_summary',
    'department_id', 'subtopic_id', 'task_ids', 'method_ids', 'data_type_ids',
    'instrument_type_ids', 'audience',
    'data_source_label', 'public_page_permission', 'card_asset_id', 'file_id',
    'file_check', 'date_added', 'source_folder_id',
  ],
  _Taxonomy: [
    'term_type', 'term_id', 'parent_id', 'label', 'short_label', 'description',
    'display_order', 'active', 'theme_key', 'icon_key', 'aliases',
  ],
  _Facets: ['demo_id', 'facet_type', 'term_id', 'display_order'],
  _Assets: [
    'asset_id', 'demo_id', 'role', 'source_type', 'drive_file_id', 'source_file_name',
    'external_url', 'mime_type', 'alt_text', 'credit', 'license', 'checksum',
    'public_path', 'sync_status', 'source_modified_at',
  ],
  _Audit: [
    'event_id', 'occurred_at', 'actor_type', 'action', 'demo_id',
    'row_version_before', 'row_version_after', 'result', 'detail',
  ],
  _Config: ['key', 'value', 'visibility', 'description'],
  _Schema: [
    'sheet_name', 'field_key', 'column_label', 'data_type', 'owner', 'editable',
    'required_when', 'public', 'description',
  ],
});

const HIDDEN_FIELD_OWNERS = deepFreeze({
  _Registry: owners(HIDDEN_SHEET_HEADERS._Registry, FIELD_OWNERS.DERIVED, {
    file_id: FIELD_OWNERS.DRIVE_SYNC,
    file_check: FIELD_OWNERS.DRIVE_SYNC,
    date_added: FIELD_OWNERS.DRIVE_SYNC,
    source_folder_id: FIELD_OWNERS.DRIVE_SYNC,
    data_source_label: FIELD_OWNERS.PROVENANCE_IMPORT,
    public_page_permission: FIELD_OWNERS.EDITOR,
  }),
  _Taxonomy: owners(HIDDEN_SHEET_HEADERS._Taxonomy, FIELD_OWNERS.EDITOR),
  _Facets: owners(HIDDEN_SHEET_HEADERS._Facets, FIELD_OWNERS.DERIVED),
  _Assets: owners(HIDDEN_SHEET_HEADERS._Assets, FIELD_OWNERS.DERIVED, {
    drive_file_id: FIELD_OWNERS.DRIVE_SYNC,
    source_file_name: FIELD_OWNERS.DRIVE_SYNC,
    external_url: FIELD_OWNERS.DRIVE_SYNC,
    mime_type: FIELD_OWNERS.DRIVE_SYNC,
    checksum: FIELD_OWNERS.DRIVE_SYNC,
    sync_status: FIELD_OWNERS.DRIVE_SYNC,
    source_modified_at: FIELD_OWNERS.DRIVE_SYNC,
  }),
  _Audit: owners(HIDDEN_SHEET_HEADERS._Audit, FIELD_OWNERS.DERIVED),
  _Config: owners(HIDDEN_SHEET_HEADERS._Config, FIELD_OWNERS.EDITOR),
  _Schema: owners(HIDDEN_SHEET_HEADERS._Schema, FIELD_OWNERS.DERIVED),
});

const SOURCE_PROJECTION_FIELDS = Object.freeze([
  'row_number', 'demo_id', 'entry_type', 'slug', 'sort_order', 'file_id',
  'file_check', 'date_added', 'source_folder_id',
]);

const TAXONOMY_FIELDS = deepFreeze({
  departments: [
    'id', 'label', 'short_label', 'description', 'display_order', 'active',
    'theme_key', 'icon_key',
  ],
  subtopics: ['id', 'department_id', 'label', 'display_order', 'active'],
  tasks: ['id', 'label', 'active'],
  methods: ['id', 'label', 'active'],
  data_types: ['id', 'label', 'description', 'display_order', 'active'],
  instrument_types: ['id', 'label', 'description', 'display_order', 'active'],
});

const REGISTRY_V2_DEMO_FIELDS = Object.freeze([
  'demo_id', 'entry_type', 'slug', 'status', 'featured', 'sort_order', 'title',
  'card_summary', 'department_id', 'subtopic_id', 'task_ids', 'method_ids',
  'data_type_ids', 'instrument_type_ids', 'audience', 'data_source_label',
  'public_page_permission', 'card_asset',
  'file_id', 'file_check', 'date_added',
]);

const REGISTRY_V2_CARD_ASSET_FIELDS = Object.freeze([
  'asset_id', 'public_path', 'alt_text',
]);

const REGISTRY_V2_TOP_LEVEL_FIELDS = Object.freeze([
  'schema_version', 'taxonomy', 'demos',
]);

const PUBLIC_ALLOWLIST = deepFreeze({
  topLevel: REGISTRY_V2_TOP_LEVEL_FIELDS,
  taxonomy: TAXONOMY_FIELDS,
  demo: REGISTRY_V2_DEMO_FIELDS,
  cardAsset: REGISTRY_V2_CARD_ASSET_FIELDS,
});

const VALID_STATUSES = new Set(['Draft', 'Live', 'Archived']);
const VALID_ENTRY_TYPES = new Set(['project', 'site']);
const VALID_FACET_TYPES = new Set(['task', 'method', 'data_type', 'instrument_type']);
const OPTIONAL_SINGLE_FACET_TYPES = new Set(['data_type', 'instrument_type']);
const VALID_AUDIENCES = new Set(['General', 'Intro', 'Intermediate', 'Advanced']);
const CARD_IMAGE_MIME_BY_EXTENSION = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MACHINE_ID_RE = SLUG_RE;
const OPTION_LABEL_DELIMITER_RE = /[;,|\r\n]/;

class RegistryV2ValidationError extends Error {
  constructor(errors) {
    const count = Array.isArray(errors) ? errors.length : 0;
    super(`Registry v2 validation failed with ${count} error${count === 1 ? '' : 's'}.`);
    this.name = 'RegistryV2ValidationError';
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

/**
 * Compile one deterministic Registry v2 snapshot.
 *
 * `projects` contains the visible human columns. The two option-backed facet
 * columns are rollout-optional; a legacy row without them behaves like empty
 * cells. The Sheet adapter may attach a transient `row_number`; the Sheet has a hidden
 * `demo_id` identity column. The adapter joins that ID to `_Registry` first,
 * then supplies source projections with the row's current position. The
 * compiler therefore never treats title or a stale row number as identity.
 */
function compileRegistryV2(input) {
  const source = input && typeof input === 'object' ? input : {};
  const projects = asArray(source.projects);
  const sourceProjections = asArray(source.sourceProjections);
  const rawAssets = asArray(source.assets);
  const rawFacets = asArray(source.facets);
  const errors = [];

  findNonEnglishTextPaths(source).forEach(path => addError(
    errors,
    'non_english_text',
    `Registry input ${path} must use English-only text.`,
    { path },
  ));

  const taxonomyResult = normalizeTaxonomy(source.taxonomy, source.options, errors);
  const taxonomy = taxonomyResult.taxonomy;
  const sourceByRow = indexSourceProjections(sourceProjections, projects.length, errors);
  const projectContexts = projects.map((project, index) => {
    const rowNumber = normaliseRowNumber(project && project.row_number, index + 2);
    const projection = sourceByRow.get(rowNumber);
    if (!projection) {
      addError(errors, 'source_projection_missing', `No source projection for Projects row ${rowNumber}.`, {
        row_number: rowNumber,
      });
    }
    return {
      project: project && typeof project === 'object' ? project : {},
      projection: projection || {},
      rowNumber,
    };
  });

  const identities = validateIdentities(projectContexts, errors);
  const facetIndex = validateAndIndexFacets(rawFacets, identities.demoIds, taxonomyResult, errors);
  const assetIndex = validateAndIndexAssets(rawAssets, identities.demoIds, errors);
  const readiness = [];
  const demos = [];
  const generatedFacets = [];
  const generatedAssets = [];

  for (const context of projectContexts) {
    const { project, projection, rowNumber } = context;
    const demoId = clean(projection.demo_id);
    const entryType = normalizeEntryType(projection.entry_type);
    const status = normalizeStatus(project.status);
    const issues = [];

    if (!VALID_ENTRY_TYPES.has(entryType)) {
      issues.push(issue('entry_type_invalid', 'entry_type must be project or site.'));
      addError(errors, 'entry_type_invalid', 'entry_type must be project or site.', {
        row_number: rowNumber,
        demo_id: demoId,
      });
    }
    if (!VALID_STATUSES.has(status)) {
      issues.push(issue('status_invalid', 'status must be Draft, Live or Archived.'));
      addError(errors, 'status_invalid', 'status must be Draft, Live or Archived.', {
        row_number: rowNumber,
        demo_id: demoId,
      });
    }

    const departmentId = resolveTerm(project.department, taxonomyResult.departments, 'department', issues);
    const subtopicId = resolveTerm(project.subtopic, taxonomyResult.subtopics, 'subtopic', issues);
    if (departmentId && subtopicId) {
      const subtopic = taxonomyResult.subtopics.byId.get(subtopicId);
      if (subtopic && subtopic.department_id !== departmentId) {
        issues.push(issue(
          'subtopic_parent_mismatch',
          `Subtopic ${subtopicId} belongs to ${subtopic.department_id}, not ${departmentId}.`,
        ));
      }
    }

    const taskIds = resolveFacetsForProject({
      demoId,
      rawValue: project.task,
      facetType: 'task',
      terms: taxonomyResult.tasks,
      supplied: facetIndex.get(demoId),
      issues,
      errors,
    });
    const methodIds = resolveFacetsForProject({
      demoId,
      rawValue: project.methods,
      facetType: 'method',
      terms: taxonomyResult.methods,
      supplied: facetIndex.get(demoId),
      issues,
      errors,
    });
    const dataTypeIds = resolveFacetsForProject({
      demoId,
      rawValue: project.data_types,
      facetType: 'data_type',
      terms: taxonomyResult.data_types,
      supplied: facetIndex.get(demoId),
      issues,
      errors,
    });
    const instrumentTypeIds = resolveFacetsForProject({
      demoId,
      rawValue: project.instrument_types,
      facetType: 'instrument_type',
      terms: taxonomyResult.instrument_types,
      supplied: facetIndex.get(demoId),
      issues,
      errors,
    });

    taskIds.forEach((termId, index) => generatedFacets.push({
      demo_id: demoId,
      facet_type: 'task',
      term_id: termId,
      display_order: index + 1,
    }));
    methodIds.forEach((termId, index) => generatedFacets.push({
      demo_id: demoId,
      facet_type: 'method',
      term_id: termId,
      display_order: index + 1,
    }));
    dataTypeIds.forEach((termId, index) => generatedFacets.push({
      demo_id: demoId,
      facet_type: 'data_type',
      term_id: termId,
      display_order: index + 1,
    }));
    instrumentTypeIds.forEach((termId, index) => generatedFacets.push({
      demo_id: demoId,
      facet_type: 'instrument_type',
      term_id: termId,
      display_order: index + 1,
    }));

    const cardAssetResult = resolveCardAsset(project, demoId, assetIndex.get(demoId), issues);
    if (cardAssetResult.hidden) generatedAssets.push(cardAssetResult.hidden);

    const title = clean(project.title);
    const cardSummary = clean(project.card_summary);
    const fileId = clean(projection.file_id);
    const fileCheck = clean(projection.file_check);
    const permission = normalizePublicPermission(project.public_permission);
    const audience = clean(project.audience);
    const featured = normalizeFeatured(project.featured);

    if (entryType === 'project') {
      if (!title) issues.push(issue('title_missing', 'A project title is required.'));
      if (!cardSummary) issues.push(issue('card_summary_missing', 'A Live project needs a card summary.'));
      if (!departmentId) issues.push(issue('department_missing', 'A project department is required.'));
      if (!subtopicId) issues.push(issue('subtopic_missing', 'A project subtopic is required.'));
      if (!taskIds.length) issues.push(issue('task_missing', 'A project needs at least one task.'));
      if (!methodIds.length) issues.push(issue('method_missing', 'A project needs at least one method.'));
      if (!VALID_AUDIENCES.has(audience)) {
        issues.push(issue(
          'audience_invalid',
          'audience must be General, Intro, Intermediate or Advanced.',
        ));
      }
      if (!featured.valid) {
        issues.push(issue('featured_invalid', 'featured must be a boolean value.'));
      }
      if (!fileId) issues.push(issue('file_id_missing', 'The Drive HTML file is missing.'));
      if (!isHealthyFileCheck(fileCheck)) {
        issues.push(issue('file_check_unhealthy', `The source file is not healthy: ${fileCheck || 'empty file_check'}.`));
      }
      if (status === 'Live' && permission !== 'Public') {
        issues.push(issue(
          'public_permission_not_granted',
          'public_permission must be Public before a project can be Live.',
        ));
      } else if (status === 'Draft' && permission === 'Private') {
        issues.push(issue(
          'preview_permission_not_granted',
          'public_permission must be Preview only or Public before a Draft can enter Preview.',
        ));
      }
    } else if (entryType === 'site') {
      if (!title) issues.push(issue('title_missing', 'A site record title is required.'));
      if (!fileId) issues.push(issue('file_id_missing', 'The site HTML file is missing.'));
      if (!isHealthyFileCheck(fileCheck)) {
        issues.push(issue('file_check_unhealthy', `The site source file is not healthy: ${fileCheck || 'empty file_check'}.`));
      }
    }

    const readinessStatus = status === 'Archived'
      ? 'not_applicable'
      : issues.length === 0 ? 'ready' : 'blocked';
    const readinessItem = {
      row_number: rowNumber,
      demo_id: demoId,
      status: readinessStatus,
      issues: issues.map(item => ({ ...item })),
    };
    readiness.push(readinessItem);

    if (status === 'Live' && issues.length) {
      issues
        .filter(item => !['entry_type_invalid', 'status_invalid'].includes(item.code))
        .forEach(item => addError(errors, item.code, item.message, {
          row_number: rowNumber,
          demo_id: demoId,
        }));
    }

    demos.push(allowlistedDemo({
      demo_id: demoId,
      entry_type: entryType,
      slug: clean(projection.slug),
      status,
      featured: featured.value,
      sort_order: finiteNumber(projection.sort_order, rowNumber - 1),
      title,
      card_summary: cardSummary,
      department_id: entryType === 'project' ? departmentId : '',
      subtopic_id: entryType === 'project' ? subtopicId : '',
      task_ids: entryType === 'project' ? taskIds : [],
      method_ids: entryType === 'project' ? methodIds : [],
      data_type_ids: entryType === 'project' ? dataTypeIds : [],
      instrument_type_ids: entryType === 'project' ? instrumentTypeIds : [],
      audience,
      data_source_label: clean(project.data_source),
      public_page_permission: permission,
      card_asset: cardAssetResult.public,
      file_id: fileId,
      file_check: fileCheck,
      date_added: normalizeDateValue(projection.date_added),
    }));
  }

  demos.sort(compareDemos);
  readiness.sort((a, b) => a.row_number - b.row_number);
  generatedFacets.sort(compareFacets);
  generatedAssets.sort((a, b) => a.asset_id.localeCompare(b.asset_id));

  return {
    ok: errors.length === 0,
    schema_version: SCHEMA_VERSION,
    taxonomy,
    demos,
    errors,
    readiness,
    hidden: {
      _Registry: buildRegistryRows(demos, readiness, sourceProjections),
      _Facets: generatedFacets,
      _Assets: generatedAssets,
    },
  };
}

/** Return only the frozen build-facing contract. Invalid Live data fails closed. */
function toRegistryV2(compiled) {
  if (!compiled || typeof compiled !== 'object') {
    throw new TypeError('A compileRegistryV2 result is required.');
  }
  if (!compiled.ok) throw new RegistryV2ValidationError(compiled.errors);
  const readiness = new Map(asArray(compiled.readiness).map(item => [item.demo_id, item.status]));
  return {
    schema_version: SCHEMA_VERSION,
    taxonomy: allowlistedTaxonomy(compiled.taxonomy),
    demos: asArray(compiled.demos)
      .filter(demo => ['Live', 'Draft'].includes(demo.status) && readiness.get(demo.demo_id) === 'ready')
      .map(allowlistedDemo),
  };
}

function normalizeTaxonomy(rawTaxonomy, rawOptions, errors) {
  const raw = rawTaxonomy && typeof rawTaxonomy === 'object' ? rawTaxonomy : {};
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const definitions = {
    departments: normalizeTerms('departments', raw.departments, TAXONOMY_FIELDS.departments, errors),
    subtopics: normalizeTerms('subtopics', raw.subtopics, TAXONOMY_FIELDS.subtopics, errors),
    tasks: normalizeTerms('tasks', raw.tasks, TAXONOMY_FIELDS.tasks, errors),
    methods: normalizeTerms('methods', raw.methods, TAXONOMY_FIELDS.methods, errors),
    data_types: normalizeOptionTerms(
      'data_types', options.data_types, TAXONOMY_FIELDS.data_types, errors,
    ),
    instrument_types: normalizeOptionTerms(
      'instrument_types', options.instrument_types, TAXONOMY_FIELDS.instrument_types, errors,
    ),
  };

  for (const subtopic of definitions.subtopics.rows) {
    if (!subtopic.department_id || !definitions.departments.byId.has(subtopic.department_id)) {
      addError(
        errors,
        'taxonomy_parent_invalid',
        `Subtopic ${subtopic.id || '(missing id)'} has unknown department ${subtopic.department_id || '(empty)'}.`,
        { term_id: subtopic.id, department_id: subtopic.department_id },
      );
    }
  }

  return {
    taxonomy: allowlistedTaxonomy({
      departments: definitions.departments.rows,
      subtopics: definitions.subtopics.rows,
      tasks: definitions.tasks.rows,
      methods: definitions.methods.rows,
      data_types: definitions.data_types.rows,
      instrument_types: definitions.instrument_types.rows,
    }),
    ...definitions,
  };
}

function normalizeOptionTerms(group, rows, fields, errors) {
  for (const raw of asArray(rows)) {
    const option = raw && typeof raw === 'object' ? raw : {};
    const label = clean(option.label);
    if (OPTION_LABEL_DELIMITER_RE.test(label)) {
      addError(
        errors,
        'option_label_delimiter_invalid',
        `${group} option ${clean(option.id) || '(missing id)'} label contains a list delimiter.`,
        { taxonomy_group: group, term_id: clean(option.id) },
      );
    }
    if (typeof option.display_order !== 'number' || !Number.isFinite(option.display_order)) {
      addError(
        errors,
        'option_display_order_invalid',
        `${group} option ${clean(option.id) || '(missing id)'} display_order must be a finite number.`,
        { taxonomy_group: group, term_id: clean(option.id) },
      );
    }
  }
  return normalizeTerms(group, rows, fields, errors);
}

function normalizeTerms(group, rows, fields, errors) {
  const normalised = asArray(rows).map((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const item = {};
    for (const field of fields) {
      if (field === 'display_order') item[field] = finiteNumber(row[field], index + 1);
      else if (field === 'active') item[field] = typeof row[field] === 'boolean' ? row[field] : false;
      else item[field] = clean(row[field]);
    }
    Object.defineProperty(item, '_activeValid', {
      enumerable: false,
      value: typeof row.active === 'boolean',
    });
    Object.defineProperty(item, '_aliases', {
      enumerable: false,
      value: splitHumanList(row.aliases),
    });
    return item;
  });
  const byId = new Map();

  for (const item of normalised) {
    if (!item._activeValid) {
      addError(
        errors,
        'taxonomy_active_invalid',
        `${group} term ${item.id || '(missing id)'} must have an explicit boolean active value.`,
        { taxonomy_group: group, term_id: item.id },
      );
    }
    if (!item.id || !MACHINE_ID_RE.test(item.id)) {
      addError(errors, 'taxonomy_id_invalid', `${group} contains invalid id ${item.id || '(empty)'}.`, {
        taxonomy_group: group,
        term_id: item.id,
      });
      continue;
    }
    if (byId.has(item.id)) {
      addError(errors, 'taxonomy_id_duplicate', `${group} contains duplicate id ${item.id}.`, {
        taxonomy_group: group,
        term_id: item.id,
      });
      continue;
    }
    if (!item.label) {
      addError(errors, 'taxonomy_label_missing', `${group} term ${item.id} has no label.`, {
        taxonomy_group: group,
        term_id: item.id,
      });
    }
    byId.set(item.id, item);
  }

  normalised.sort(compareTerms);
  const lookup = new Map();
  for (const item of normalised) {
    for (const candidate of [item.id, item.label, item.short_label, ...item._aliases]) {
      const key = lookupKey(candidate);
      if (!key) continue;
      const existing = lookup.get(key);
      if (existing && existing !== item.id) lookup.set(key, null);
      else if (existing === undefined) lookup.set(key, item.id);
    }
  }

  return { rows: normalised, byId, lookup };
}

function indexSourceProjections(rows, projectCount, errors) {
  const index = new Map();
  asArray(rows).forEach((raw, arrayIndex) => {
    const projection = raw && typeof raw === 'object' ? raw : {};
    const rowNumber = normaliseRowNumber(projection.row_number, arrayIndex + 2);
    if (index.has(rowNumber)) {
      addError(errors, 'source_projection_row_duplicate', `Multiple source projections target row ${rowNumber}.`, {
        row_number: rowNumber,
      });
      return;
    }
    index.set(rowNumber, projection);
  });
  if (rows.length !== projectCount) {
    addError(
      errors,
      'source_projection_count_mismatch',
      `Projects has ${projectCount} rows but sourceProjections has ${rows.length}.`,
      { projects_count: projectCount, source_projections_count: rows.length },
    );
  }
  return index;
}

function validateIdentities(contexts, errors) {
  const demoIds = new Set();
  const slugs = new Set();
  const sourceFolderIds = new Set();

  for (const { projection, rowNumber } of contexts) {
    const demoId = clean(projection.demo_id);
    const slug = clean(projection.slug);
    if (!demoId || !MACHINE_ID_RE.test(demoId)) {
      addError(errors, 'demo_id_invalid', `Projects row ${rowNumber} has invalid demo_id ${demoId || '(empty)'}.`, {
        row_number: rowNumber,
        demo_id: demoId,
      });
    } else if (demoIds.has(demoId)) {
      addError(errors, 'duplicate_demo_id', `demo_id ${demoId} is used more than once.`, {
        row_number: rowNumber,
        demo_id: demoId,
      });
    }
    if (demoId) demoIds.add(demoId);

    if (!slug || !SLUG_RE.test(slug)) {
      addError(errors, 'slug_invalid', `Projects row ${rowNumber} has invalid slug ${slug || '(empty)'}.`, {
        row_number: rowNumber,
        slug,
      });
    } else if (slugs.has(slug)) {
      addError(errors, 'duplicate_slug', `slug ${slug} is used more than once.`, {
        row_number: rowNumber,
        slug,
      });
    }
    if (slug) slugs.add(slug);

    const sourceFolderId = clean(projection.source_folder_id);
    if (sourceFolderId && sourceFolderIds.has(sourceFolderId)) {
      addError(errors, 'duplicate_source_folder_id', 'A Drive source folder belongs to more than one project.', {
        row_number: rowNumber,
        demo_id: demoId,
      });
    }
    if (sourceFolderId) sourceFolderIds.add(sourceFolderId);
  }
  return { demoIds, slugs };
}

function validateAndIndexFacets(rows, knownDemoIds, taxonomyResult, errors) {
  const byDemo = new Map();
  const seen = new Set();
  for (const raw of asArray(rows)) {
    const facet = raw && typeof raw === 'object' ? raw : {};
    const demoId = clean(facet.demo_id);
    const facetType = clean(facet.facet_type).toLowerCase();
    const termId = clean(facet.term_id);
    if (!knownDemoIds.has(demoId)) {
      addError(errors, 'facet_demo_unknown', `Facet refers to unknown demo_id ${demoId || '(empty)'}.`, {
        demo_id: demoId,
      });
      continue;
    }
    if (!VALID_FACET_TYPES.has(facetType)) {
      addError(errors, 'facet_type_invalid', `Facet ${demoId}/${termId} has invalid type ${facetType || '(empty)'}.`, {
        demo_id: demoId,
        term_id: termId,
      });
      continue;
    }
    const termsByFacetType = {
      task: taxonomyResult.tasks,
      method: taxonomyResult.methods,
      data_type: taxonomyResult.data_types,
      instrument_type: taxonomyResult.instrument_types,
    };
    const terms = termsByFacetType[facetType];
    if (!terms.byId.has(termId)) {
      addError(errors, 'facet_term_unknown', `Facet ${demoId} refers to unknown ${facetType} ${termId || '(empty)'}.`, {
        demo_id: demoId,
        term_id: termId,
      });
      continue;
    }
    const duplicateKey = `${demoId}\u0000${facetType}\u0000${termId}`;
    if (seen.has(duplicateKey)) {
      addError(errors, 'duplicate_facet', `Facet ${demoId}/${facetType}/${termId} is duplicated.`, {
        demo_id: demoId,
        term_id: termId,
      });
      continue;
    }
    seen.add(duplicateKey);
    if (!byDemo.has(demoId)) byDemo.set(demoId, []);
    byDemo.get(demoId).push({
      demo_id: demoId,
      facet_type: facetType,
      term_id: termId,
      display_order: finiteNumber(facet.display_order, byDemo.get(demoId).length + 1),
    });
  }
  byDemo.forEach(items => items.sort(compareFacets));
  return byDemo;
}

function validateAndIndexAssets(rows, knownDemoIds, errors) {
  const byDemo = new Map();
  const assetIds = new Set();
  for (const raw of asArray(rows)) {
    const asset = raw && typeof raw === 'object' ? raw : {};
    const normalised = {
      asset_id: clean(asset.asset_id),
      demo_id: clean(asset.demo_id),
      role: clean(asset.role),
      source_type: clean(asset.source_type).toLowerCase(),
      drive_file_id: clean(asset.drive_file_id),
      source_file_name: clean(asset.source_file_name),
      external_url: clean(asset.external_url),
      mime_type: clean(asset.mime_type),
      alt_text: clean(asset.alt_text),
      credit: clean(asset.credit),
      license: clean(asset.license),
      checksum: clean(asset.checksum),
      public_path: clean(asset.public_path),
      sync_status: clean(asset.sync_status),
      source_modified_at: normalizeDateValue(asset.source_modified_at),
    };
    if (!normalised.asset_id || !MACHINE_ID_RE.test(normalised.asset_id)) {
      addError(errors, 'asset_id_invalid', `Asset has invalid asset_id ${normalised.asset_id || '(empty)'}.`, {
        asset_id: normalised.asset_id,
      });
    } else if (assetIds.has(normalised.asset_id)) {
      addError(errors, 'duplicate_asset_id', `asset_id ${normalised.asset_id} is used more than once.`, {
        asset_id: normalised.asset_id,
      });
    }
    if (normalised.asset_id) assetIds.add(normalised.asset_id);
    if (!knownDemoIds.has(normalised.demo_id)) {
      addError(errors, 'asset_demo_unknown', `Asset ${normalised.asset_id || '(empty)'} refers to unknown demo_id ${normalised.demo_id || '(empty)'}.`, {
        asset_id: normalised.asset_id,
        demo_id: normalised.demo_id,
      });
      continue;
    }

    const hasDrive = Boolean(normalised.drive_file_id);
    const hasExternal = Boolean(normalised.external_url);
    if (hasDrive === hasExternal) {
      addError(
        errors,
        'asset_source_xor',
        `Asset ${normalised.asset_id || '(empty)'} must have exactly one of drive_file_id or external_url.`,
        { asset_id: normalised.asset_id, demo_id: normalised.demo_id },
      );
    }
    if (normalised.source_type === 'drive' && !hasDrive) {
      addError(errors, 'asset_source_type_mismatch', `Drive asset ${normalised.asset_id} has no drive_file_id.`, {
        asset_id: normalised.asset_id,
      });
    } else if (normalised.source_type !== 'drive') {
      addError(errors, 'asset_source_type_invalid', `Asset ${normalised.asset_id} has invalid source_type.`, {
        asset_id: normalised.asset_id,
      });
    }

    if (!byDemo.has(normalised.demo_id)) byDemo.set(normalised.demo_id, []);
    byDemo.get(normalised.demo_id).push(normalised);
  }

  for (const [demoId, demoAssets] of byDemo) {
    const cards = demoAssets.filter(asset => asset.role === 'card_image');
    if (cards.length > 1) {
      addError(errors, 'multiple_card_assets', `demo_id ${demoId} has more than one card_image asset.`, {
        demo_id: demoId,
      });
    }
  }
  return byDemo;
}

function resolveFacetsForProject({ demoId, rawValue, facetType, terms, supplied, issues, errors }) {
  const selected = [];
  for (const value of splitHumanList(rawValue)) {
    const id = resolveTerm(value, terms, facetType, issues);
    if (id && !selected.includes(id)) selected.push(id);
  }

  const hasTooManySelections = OPTIONAL_SINGLE_FACET_TYPES.has(facetType)
    && selected.length > 1;
  if (hasTooManySelections) {
    const label = facetType === 'data_type' ? 'Data Type' : 'Instrument Type';
    issues.push(issue(
      `${facetType}_multiple`,
      `${label} allows at most one distinct value; leave it blank when unknown.`,
    ));
  }

  const suppliedIds = asArray(supplied)
    .filter(facet => facet.facet_type === facetType)
    .map(facet => facet.term_id);
  if (suppliedIds.length || selected.length) {
    const selectedSet = [...selected].sort();
    const suppliedSet = [...new Set(suppliedIds)].sort();
    if (suppliedIds.length && !arraysEqual(selectedSet, suppliedSet)) {
      addError(
        errors,
        'facet_index_mismatch',
        `_Facets ${facetType} index for ${demoId} does not match the human Projects value.`,
        { demo_id: demoId, facet_type: facetType },
      );
    }
  }
  // Never carry an invalid multi-selection into the additive public array
  // contract. A Live row fails closed above; a blocked Draft remains omitted.
  return hasTooManySelections ? [] : selected;
}

function resolveTerm(value, terms, kind, issues) {
  const text = clean(value);
  if (!text) return '';
  const key = lookupKey(text);
  if (!terms.lookup.has(key)) {
    issues.push(issue(`${kind}_unknown`, `${kind} value ${text} is not in _Taxonomy.`));
    return '';
  }
  const id = terms.lookup.get(key);
  if (!id) {
    issues.push(issue(`${kind}_ambiguous`, `${kind} value ${text} matches more than one taxonomy term.`));
    return '';
  }
  const term = terms.byId.get(id);
  if (term && !term.active) {
    issues.push(issue(`${kind}_inactive`, `${kind} ${id} is inactive.`));
  }
  return id;
}

function resolveCardAsset(project, demoId, demoAssets, issues) {
  const selected = clean(project.card_image);
  const assets = asArray(demoAssets);
  const cardAssets = assets.filter(asset => asset.role === 'card_image');
  const asset = cardAssets.length === 1 ? cardAssets[0] : null;

  if (!selected && asset) {
    issues.push(issue('card_asset_not_selected', 'A hidden card asset exists but card_image is empty.'));
  }
  if (selected && !asset) {
    issues.push(issue('card_asset_index_missing', 'card_image has no corresponding _Assets record.'));
  }
  if (!selected || !asset) return { public: null, hidden: null };

  if (!matchesCardImageSource(selected, asset)) {
    issues.push(issue('card_asset_source_mismatch', 'card_image does not match the indexed asset source.'));
  }
  const altText = clean(project.image_alt);
  if (!altText) issues.push(issue('card_image_alt_missing', 'A selected card image needs image_alt.'));
  if (!isSafePublicPath(asset.public_path)) {
    issues.push(issue('card_asset_public_path_invalid', 'A selected card asset needs a safe public_path.'));
  }
  if (clean(asset.sync_status) !== 'ok') {
    issues.push(issue('card_asset_sync_unhealthy', 'A selected card asset must have sync_status ok.'));
  }
  if (!isCompatibleCardImageMime(asset.mime_type, asset.public_path)) {
    issues.push(issue(
      'card_asset_mime_invalid',
      'A selected card asset needs a supported image MIME type matching public_path.',
    ));
  }
  const hidden = { ...asset, alt_text: altText };
  return {
    public: {
      asset_id: asset.asset_id,
      public_path: asset.public_path,
      alt_text: altText,
    },
    hidden,
  };
}

function matchesCardImageSource(selected, asset) {
  if (asset.source_type === 'external') return selected === asset.external_url;
  if (asset.source_type === 'drive') {
    return selected === asset.source_file_name;
  }
  return false;
}

function allowlistedTaxonomy(raw) {
  const taxonomy = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const group of [
    'departments', 'subtopics', 'tasks', 'methods', 'data_types', 'instrument_types',
  ]) {
    result[group] = asArray(taxonomy[group]).map(item => pick(item, TAXONOMY_FIELDS[group]));
  }
  return result;
}

function allowlistedDemo(raw) {
  const demo = pick(raw, REGISTRY_V2_DEMO_FIELDS);
  demo.task_ids = asArray(demo.task_ids).map(clean).filter(Boolean);
  demo.method_ids = asArray(demo.method_ids).map(clean).filter(Boolean);
  demo.data_type_ids = asArray(demo.data_type_ids).map(clean).filter(Boolean);
  demo.instrument_type_ids = asArray(demo.instrument_type_ids).map(clean).filter(Boolean);
  demo.card_asset = demo.card_asset
    ? pick(demo.card_asset, REGISTRY_V2_CARD_ASSET_FIELDS)
    : null;
  return demo;
}

function buildRegistryRows(demos, readiness, sourceProjections) {
  const readinessById = new Map(readiness.map(item => [item.demo_id, item]));
  const foldersById = new Map(sourceProjections.map(source => [
    clean(source?.demo_id), clean(source?.source_folder_id),
  ]));
  return demos.map(demo => ({
    schema_version: SCHEMA_VERSION,
    row_number: readinessById.get(demo.demo_id)?.row_number || '',
    demo_id: demo.demo_id,
    entry_type: demo.entry_type,
    slug: demo.slug,
    status: demo.status,
    readiness: readinessById.get(demo.demo_id)?.status || 'blocked',
    featured: demo.featured,
    sort_order: demo.sort_order,
    title: demo.title,
    card_summary: demo.card_summary,
    department_id: demo.department_id,
    subtopic_id: demo.subtopic_id,
    task_ids: demo.task_ids.join(','),
    method_ids: demo.method_ids.join(','),
    data_type_ids: demo.data_type_ids.join(','),
    instrument_type_ids: demo.instrument_type_ids.join(','),
    audience: demo.audience,
    data_source_label: demo.data_source_label,
    public_page_permission: demo.public_page_permission,
    card_asset_id: demo.card_asset ? demo.card_asset.asset_id : '',
    file_id: demo.file_id,
    file_check: demo.file_check,
    date_added: demo.date_added,
    source_folder_id: foldersById.get(demo.demo_id) || '',
  }));
}

function normalizeStatus(value) {
  const key = clean(value).toLowerCase();
  if (key === 'draft') return 'Draft';
  if (key === 'live') return 'Live';
  if (key === 'archived') return 'Archived';
  return clean(value);
}

function normalizeEntryType(value) {
  const key = clean(value).toLowerCase();
  return key || 'project';
}

function normalizePublicPermission(value) {
  const key = clean(value).toLowerCase();
  if (key === 'public') return 'Public';
  if (key === 'preview only') return 'Preview only';
  if (key === 'private') return 'Private';
  return 'Private';
}

function isHealthyFileCheck(value) {
  const text = clean(value).toLowerCase();
  // `check assets: ...` is a warning emitted by the v1 scanner when the HTML
  // is readable but linked assets need a human look. Existing Production
  // projects legitimately carry this warning, so it must not block v2.
  if (!/^(?:ok(?:\b|\s|[-—:])|check assets:)/.test(text)) return false;
  return !/(page\s+unreadable|page\s+empty|unreadable|empty\s+page)/.test(text);
}

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch (_) {
    return false;
  }
}

function isSafePublicPath(value) {
  const text = clean(value);
  return /^assets\/cards\/[a-z0-9][a-z0-9/_-]*\.(?:avif|gif|jpe?g|png|webp)$/.test(text)
    && !text.split('/').includes('..');
}

function isCompatibleCardImageMime(mimeType, publicPath) {
  const match = clean(publicPath).toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return false;
  return CARD_IMAGE_MIME_BY_EXTENSION[match[1]] === clean(mimeType).toLowerCase();
}

function normalizeDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return clean(value);
}

function splitHumanList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (!text) return [];
  return text.split(/[,;|\n]+/).map(clean).filter(Boolean);
}

function normaliseRowNumber(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 2 ? number : fallback;
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || clean(value) === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeFeatured(value) {
  if (value === true || value === false) return { value, valid: true };
  return { value: false, valid: false };
}

function lookupKey(value) {
  return clean(value).toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function compareTerms(a, b) {
  return finiteNumber(a.display_order, Number.MAX_SAFE_INTEGER)
    - finiteNumber(b.display_order, Number.MAX_SAFE_INTEGER)
    || clean(a.id).localeCompare(clean(b.id));
}

function compareDemos(a, b) {
  return finiteNumber(a.sort_order, Number.MAX_SAFE_INTEGER)
    - finiteNumber(b.sort_order, Number.MAX_SAFE_INTEGER)
    || a.title.localeCompare(b.title)
    || a.demo_id.localeCompare(b.demo_id);
}

function compareFacets(a, b) {
  return a.demo_id.localeCompare(b.demo_id)
    || a.facet_type.localeCompare(b.facet_type)
    || finiteNumber(a.display_order, Number.MAX_SAFE_INTEGER)
      - finiteNumber(b.display_order, Number.MAX_SAFE_INTEGER)
    || a.term_id.localeCompare(b.term_id);
}

function addError(errors, code, message, details) {
  errors.push({ code, message, ...(details || {}) });
}

function issue(code, message) {
  return { code, message };
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function findNonEnglishTextPaths(value, path, matches) {
  const currentPath = path || '$';
  const output = matches || [];
  if (typeof value === 'string') {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) {
      output.push(currentPath);
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findNonEnglishTextPaths(item, `${currentPath}[${index}]`, output));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      findNonEnglishTextPaths(item, `${currentPath}.${key}`, output);
    });
  }
  return output;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pick(source, keys) {
  const result = {};
  const object = source && typeof source === 'object' ? source : {};
  for (const key of keys) result[key] = object[key];
  return result;
}

function column(key, label, owner, editable) {
  return Object.freeze({ key, label, owner, editable });
}

function owners(headers, fallback, overrides) {
  const result = {};
  for (const header of headers) result[header] = overrides?.[header] || fallback;
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

module.exports = {
  FIELD_OWNERS,
  HIDDEN_FIELD_OWNERS,
  HIDDEN_SHEET_HEADERS,
  HUMAN_PROJECT_COLUMNS,
  HUMAN_PROJECT_HEADERS,
  PUBLIC_ALLOWLIST,
  REGISTRY_V2_CARD_ASSET_FIELDS,
  REGISTRY_V2_DEMO_FIELDS,
  REGISTRY_V2_TOP_LEVEL_FIELDS,
  RegistryV2ValidationError,
  SCHEMA_VERSION,
  SOURCE_PROJECTION_FIELDS,
  TAXONOMY_FIELDS,
  VALID_AUDIENCES,
  compileRegistryV2,
  isCompatibleCardImageMime,
  isHealthyFileCheck,
  normalizeFeatured,
  normalizePublicPermission,
  splitHumanList,
  toRegistryV2,
};

return module.exports;})();
var V2Sheet=(function(){var module={exports:{}};
function require(name){if(name==='./registry-v2')return V2;throw new Error('Unknown module');}
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
const OPTIONAL_REGISTRY_HEADERS = new Set(['data_type_ids', 'instrument_type_ids', 'source_folder_id']);
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
    { optionalHeaders: optionsPresent ? new Set(['source_folder_id']) : OPTIONAL_REGISTRY_HEADERS },
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
      source_folder_id: clean(source.source_folder_id),
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
    data_type_multiple: 'Data Type',
    data_type_unknown: 'Data Type',
    entry_type_invalid: 'Record Type',
    featured_invalid: 'Featured',
    file_check_unhealthy: 'Source File Check',
    file_id_missing: 'Source File',
    method_missing: 'Methods',
    instrument_type_ambiguous: 'Instrument Type',
    instrument_type_inactive: 'Instrument Type',
    instrument_type_multiple: 'Instrument Type',
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

return module.exports;})();
var V3=(function(){var module={exports:{}};

'use strict';

// Shared, deterministic contract. No I/O: the Google adapter supplies verified
// bytes/metadata and both Node and Apps Script supply SHA-256.
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
const ROLES = ['insight', 'dataset', 'workflow', 'legacy', 'resource_page'];
const FORBIDDEN_SHEET = '1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE';
const FORBIDDEN_ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';

function need(ok, message) { if (!ok) throw new Error('Registry v3: ' + message); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function unique(rows, key, name) {
  const map = new Map();
  for (const row of rows) {
    need(row && ID.test(row[key] || ''), 'invalid ' + name + ' ID');
    need(!map.has(row[key]), 'duplicate ' + name + ': ' + row[key]); map.set(row[key], row);
  }
  return map;
}
function safeRoute(route) {
  return typeof route === 'string' && route.length < 240
    && !/[\\?#%:]/.test(route) && !route.startsWith('/')
    && route.split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) && p !== '..' && p !== '.')
    && !route.split('/').some(p => p.startsWith('.'));
}
function assertSandbox(config) {
  need(config && config.environment === 'sandbox', 'sandbox mode required');
  need(config.spreadsheet_id && config.spreadsheet_id !== FORBIDDEN_SHEET, 'official Sheet is forbidden');
  need(config.drive_root_id && config.drive_root_id !== FORBIDDEN_ROOT, 'official Drive root is forbidden');
  need(!config.production_hook, 'Production hook is forbidden in sandbox');
  need(config.branch === 'develop', 'sandbox must target develop');
}
function sourceDescriptor(source, html) {
  need(source && source.in_scope === true && source.trashed !== true, 'file missing or outside sandbox');
  need(typeof source.file_id === 'string' && source.file_id.length > 0, 'missing source file');
  need(SHA.test(source.sha256 || ''), 'invalid file hash');
  need(Number.isSafeInteger(source.size) && source.size > 0 && source.size <= 25 * 1024 * 1024, 'invalid file size');
  need(typeof source.modified_at === 'string' && Number.isFinite(Date.parse(source.modified_at)), 'invalid file timestamp');
  if (html) need(source.mime_type === 'text/html', 'HTML source required');
  return { file_id: source.file_id, sha256: source.sha256, size: source.size,
    mime_type: source.mime_type, modified_at: source.modified_at, parent_path: source.parent_path };
}

function compileRegistryV3(input, hash) {
  need(typeof hash === 'function', 'SHA-256 implementation required');
  need(['preview', 'production'].includes(input.audience), 'invalid audience');
  if (input.environment === 'sandbox') {
    assertSandbox(input); need(input.audience === 'preview', 'sandbox rejects Production');
  }
  need(ID.test(input.registry_instance || ''), 'invalid Registry instance');
  const projects = unique(input.projects || [], 'demo_id', 'project');
  const versions = unique(input.versions || [], 'version_id', 'version');
  const pages = unique(input.pages || [], 'page_id', 'page');
  const resources = unique(input.resources || [], 'resource_id', 'resource');
  unique([...projects.values()], 'slug', 'slug');
  for (const v of versions.values()) {
    need(projects.has(v.demo_id), 'version has no project');
    need(['single', 'three-page'].includes(v.layout), 'invalid layout');
    need(['Draft', 'Reviewed', 'Published'].includes(v.state), 'invalid version state');
    need(['Public', 'Preview only', 'Private'].includes(v.permission), 'invalid version permission');
    need(input.environment !== 'sandbox' || v.state !== 'Published', 'sandbox cannot publish versions');
  }
  for (const p of pages.values()) {
    need(versions.has(p.version_id), 'page has no version');
    need(ROLES.includes(p.role), 'invalid page role');
    need(['Ready', 'Placeholder'].includes(p.state), 'invalid page state');
    need(p.state !== 'Placeholder' || (p.role === 'dataset' && !p.source), 'only Dataset may be an empty placeholder');
  }
  for (const r of resources.values()) {
    need(versions.has(r.version_id), 'resource has no version');
    need(['card','download'].includes(r.role), 'invalid resource role');
  }
  const usedRoutes = new Set(), selectedFiles = new Map(), demos = [], bundles = [];
  for (const project of [...projects.values()].sort((a,b) => a.demo_id.localeCompare(b.demo_id))) {
    need(['Live', 'Draft', 'Archived'].includes(project.status), 'invalid project status');
    need(['Public', 'Preview only', 'Private'].includes(project.public_page_permission), 'invalid project permission');
    if (project.status === 'Archived' || project.public_page_permission === 'Private') continue;
    if (input.audience === 'production' && (project.status !== 'Live' || project.public_page_permission !== 'Public')) continue;
    const pointer = input.audience === 'production' ? project.published_version_id : project.development_version_id;
    if (!pointer) continue;
    const version = versions.get(pointer);
    need(version && version.demo_id === project.demo_id, 'version pointer belongs to another project');
    if (version.permission === 'Private') continue;
    if (input.audience === 'production') need(version.state === 'Published' && version.permission === 'Public', 'unpublished version selected');
    const base = 'demos/' + project.slug + '/';
    const sourceFolder = 'projects/' + project.slug + '/' + pointer;
    const versionPages = [...pages.values()].filter(p => p.version_id === pointer);
    const roles = new Set();
    const acceptRoute = route => {
      need(safeRoute(route), 'unsafe route'); need(!usedRoutes.has(route), 'duplicate output route: ' + route); usedRoutes.add(route);
    };
    const files = versionPages.map(p => {
      need(!roles.has(p.role), 'duplicate page role: ' + p.role); roles.add(p.role);
      acceptRoute(p.route);
      const expected = { insight: base + 'index.html', legacy: base + 'index.html', workflow: base + 'workflow.html', resource_page: base + 'workflow-resources.html' };
      if (p.role === 'dataset') {
        need(p.route === base + 'dataset.html' || /^datasets\/[a-z0-9-]+\/index\.html$/.test(p.route), 'invalid Dataset route');
        need(ID.test(p.dataset_id || '') && ID.test(p.dataset_version || ''), 'Dataset identity and version required');
      } else need(p.route === expected[p.role], 'page route does not match project and role');
      let source = null;
      if (p.state === 'Ready') {
        source = sourceDescriptor(p.source, true);
        need(source.parent_path === (p.role === 'dataset' ? 'datasets/' + p.dataset_id + '/' + p.dataset_version : sourceFolder), 'page belongs to a different source directory');
      }
      const result = { page_id: p.page_id, role: p.role, state: p.state, route: p.route,
        ...(p.role === 'dataset' ? { dataset_id: p.dataset_id, dataset_version: p.dataset_version } : {}), source };
      if (source) selectedFiles.set(p.page_id, { ...source, id: p.page_id, kind: 'page', demo_id: project.demo_id, version_id: pointer });
      return result;
    }).sort((a,b) => a.role.localeCompare(b.role));
    if (version.layout === 'three-page') need(['insight','dataset','workflow'].every(r => roles.has(r)) && !roles.has('legacy'), 'three-page version requires Insight, Dataset and Workflow');
    else need(roles.size === 1 && roles.has('legacy'), 'single-page version requires legacy only');
    const attached = [...resources.values()].filter(r => r.version_id === pointer).map(r => {
      acceptRoute(r.route); need(r.route.startsWith(base + 'resources/') || r.role === 'card', 'resource outside project resources');
      need(/\.(?:ipynb|zip|json|csv|txt|md|jpe?g|png|webp)$/.test(r.route), 'unsupported resource type');
      if (r.role === 'card') need(/^assets\/cards\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/.test(r.route), 'invalid card route');
      const source = sourceDescriptor(r.source, false);
      const resourceFolder = sourceFolder + '/resources';
      need(r.role === 'card' ? source.parent_path === sourceFolder : safeRoute(source.parent_path) && (source.parent_path === resourceFolder || source.parent_path.startsWith(resourceFolder + '/')), 'resource belongs to a different source directory');
      const result = { resource_id: r.resource_id, role: r.role || 'download', route: r.route, source };
      selectedFiles.set(r.resource_id, { ...source, id: r.resource_id, kind: 'resource', demo_id: project.demo_id, version_id: pointer });
      return result;
    }).sort((a,b) => a.resource_id.localeCompare(b.resource_id));
    const metadata = { ...(input.audience === 'production' ? version.frozen_metadata : project) };
    if (input.audience === 'production') need(metadata.demo_id === project.demo_id && metadata.slug === project.slug, 'Published metadata snapshot required');
    delete metadata.development_version_id; delete metadata.published_version_id;
    delete metadata.file_id; delete metadata.file_check;
    const snapshot = { metadata, version_id: pointer, layout: version.layout, pages: files, resources: attached };
    const digest = 'sha256:' + hash(stable(snapshot));
    if (['Reviewed','Published'].includes(version.state)) need(version.snapshot_digest === digest, 'reviewed snapshot changed; create a Draft version');
    if (input.audience === 'production') {
      need(version.frozen === true, 'Published version must use frozen copies');
      const draftFiles = new Set([...pages.values()].filter(p => versions.get(p.version_id).state === 'Draft' && p.source).map(p => p.source.file_id)
        .concat([...resources.values()].filter(r => versions.get(r.version_id).state === 'Draft' && r.source).map(r => r.source.file_id)));
      for (const item of files.concat(attached)) if (item.source) need(!draftFiles.has(item.source.file_id), 'Published file is shared with a mutable Draft');
    }
    const entry = files.find(p => ['legacy','insight'].includes(p.role));
    demos.push({ ...metadata, file_id: entry.page_id, file_check: 'ok', card_asset: null });
    bundles.push({ demo_id: project.demo_id, version_id: pointer, layout: version.layout,
      collection: version.collection || '', snapshot_digest: digest, pages: files, resources: attached });
  }
  // Shared Dataset identity must resolve to exactly one source in this release.
  const datasets = new Map();
  for (const b of bundles) for (const p of b.pages.filter(p=>p.role==='dataset')) {
    const key = p.dataset_id + '@' + p.dataset_version;
    const source = stable({state:p.state,source:p.source});
    need(!datasets.has(key) || datasets.get(key) === source, 'shared Dataset version resolves to different files'); datasets.set(key,source);
  }
  const manifest = { schema_version:3, registry_instance:input.registry_instance,
    environment:input.environment, audience:input.audience, site:input.site || {}, taxonomy:input.taxonomy,
    demos, bundles };
  manifest.registry_revision = 'sha256:' + hash(stable(manifest));
  return { manifest, files: [...selectedFiles.values()] };
}

function authorizedFile(snapshot, id, audience, revision) {
  need(snapshot.manifest.audience === audience, 'audience mismatch');
  need(snapshot.manifest.registry_revision === revision, 'revision mismatch');
  const file = snapshot.files.find(f=>f.id===id);
  need(file, 'file is not part of the selected release'); return file;
}

module.exports = { stable, safeRoute, assertSandbox, compileRegistryV3, authorizedFile,
  sourceDescriptor, FORBIDDEN_ROOT, FORBIDDEN_SHEET };

return module.exports;})();
/** Independent V3 sandbox. This file is bundled with the tested pure compilers.
 * It deliberately has no Production publisher and never calls the V2 setup(). */
var SANDBOX = {
  environment: 'sandbox', branch: 'develop', registry_instance: 'ais-backend-sandbox-20260923',
  spreadsheet_id: '1LIoR1wJKW-qqaGLePnrQCmqz3YWatPWwZNtrLkEajXI',
  drive_root_id: '1d0Dat-aXa2n60nkQxR2PCBbkCBsnGlS2',
  import_config_id: '1lTiLxcihW-BbY-ehcewmk_r9X-PFK4wu',
  site_id: '2fe21bb6-70b5-47c6-a810-18f6bd8f4973'
};
var V3_SHEETS = {
  Versions: ['Version ID','demo_id','Layout','State','Permission','Use in develop','Collection','Snapshot digest','Check'],
  Pages: ['Page ID','Version ID','Role','State','Source file','Dataset ID','Dataset version','Route'],
  Resources: ['Resource ID','Version ID','Role','Source file','Route'],
  _Pages: ['page_id','version_id','role','state','route','file_id','sha256','size','modified_at'],
  _Resources: ['resource_id','version_id','route','file_id','sha256','size','modified_at'],
  _ImportFiles: ['path','file_id','sha256'],
  _Snapshots: ['revision','snapshot_file_id','input_hash','created_at'],
  _SandboxAudit: ['time','action','revision','detail']
};
function onOpen() {
  registryUiOnOpen_();
}
function sandboxGuard_() {
  var p=PropertiesService.getScriptProperties();
  V3.assertSandbox(Object.assign({},SANDBOX,{production_hook:p.getProperty('AI4S_NETLIFY_PRODUCTION_BUILD_HOOK')}));
  var active=SpreadsheetApp.getActiveSpreadsheet();
  if(active && active.getId()!==SANDBOX.spreadsheet_id)throw new Error('Wrong bound spreadsheet');
  var ss=SpreadsheetApp.openById(SANDBOX.spreadsheet_id);
  if(p.getProperty('AI4S_AUTO_PUBLISH_TARGET') && !['off','preview'].includes(p.getProperty('AI4S_AUTO_PUBLISH_TARGET')))throw new Error('Invalid sandbox publish mode');
  return ss;
}
function locked_(fn) {
  var lock=LockService.getScriptLock();if(!lock.tryLock(2000))throw new Error('Another sandbox operation is running');
  try{return fn();}finally{lock.releaseLock();}
}
function hash_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,typeof value==='string'?Utilities.newBlob(value).getBytes():value).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function writeRows_(ss,name,rows){
  var sh=ss.getSheetByName(name);if(!sh)sh=ss.insertSheet(name);
  if(rows.length>sh.getMaxRows())sh.insertRowsAfter(sh.getMaxRows(),rows.length-sh.getMaxRows());
  if(rows[0].length>sh.getMaxColumns())sh.insertColumnsAfter(sh.getMaxColumns(),rows[0].length-sh.getMaxColumns());
  var old=sh.getDataRange().getValues();
  if(V3.stable(old)===V3.stable(rows))return false;
  sh.getRange(1,1,rows.length,rows[0].length).setValues(rows);
  if(old.length>rows.length)sh.getRange(rows.length+1,1,old.length-rows.length,old[0].length).clearContent();
  return true;
}
function tableRows_(ss,name){var sh=ss.getSheetByName(name);if(!sh)throw new Error('Missing sheet '+name);return sh.getDataRange().getValues().filter(function(r,i){return i===0||r.some(function(v){return v!==''&&v!==false;});});}
function objects_(rows){return rows.slice(1).map(function(r){return Object.fromEntries(rows[0].map(function(k,i){return [k,r[i]===undefined?'':r[i]];}));});}
function fileId_(value){var s=String(value||'').trim();var m=s.match(/\/d\/([A-Za-z0-9_-]+)/)||s.match(/[?&]id=([A-Za-z0-9_-]+)/);if(m)return m[1];if(/^[A-Za-z0-9_-]{20,}$/.test(s))return s;throw new Error('Use a valid Drive file link');}
function sourceBinding_(id){
  var f=DriveApp.getFileById(id);if(f.isTrashed())throw new Error('Source file is in Trash');
  return {file:f,parent_path:sourceParentPath_(f)};
}
function sourceFile_(id){return sourceBinding_(id).file;}
function source_(id,previous){
  var binding=sourceBinding_(id),f=binding.file,stamp=f.getLastUpdated().toISOString(),size=f.getSize(),mime=f.getMimeType(),parent=binding.parent_path;
  if(previous && previous.modified_at===stamp && previous.size===size && previous.mime_type===mime && previous.parent_path===parent)return Object.assign({in_scope:true},previous);
  var blob=f.getBlob(),bytes=blob.getBytes();if(!bytes.length||bytes.length>25*1024*1024)throw new Error('Source size out of range');
  if(mime==='text/html'){var html=blob.getDataAsString('UTF-8');if(!/<head\b/i.test(html)||!/<body\b/i.test(html)||!/<\/body>/i.test(html))throw new Error('Incomplete HTML source');}
  if(f.getLastUpdated().toISOString()!==stamp||f.getSize()!==size)throw new Error('Source changed during read');
  return {in_scope:true,file_id:id,modified_at:stamp,size:size,mime_type:mime,sha256:hash_(bytes),parent_path:parent};
}
function sourceParentPath_(f){return mountedSourceParentPath_(f);}
function audit_(ss,action,revision,detail){ss.getSheetByName('_SandboxAudit').appendRow([new Date().toISOString(),action,revision||'',String(detail||'').slice(0,1500)]);}
function initializeSandbox(){return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();
  if(p.getProperty('SANDBOX_INITIALIZED')){console.log('Sandbox already initialized; no changes.');return;}
  // Native copy may contain old properties. Refuse them instead of inheriting an
  // old hook or token. Credentials are generated only inside this new project.
  if(p.getProperty('AI4S_NETLIFY_PREVIEW_BUILD_HOOK')||p.getProperty('AI4S_REGISTRY_ACCESS_TOKEN'))throw new Error('Copied operational properties must be cleared before initialization');
  Object.keys(V3_SHEETS).forEach(function(name){
    writeRows_(ss,name,[V3_SHEETS[name]]);var sh=ss.getSheetByName(name);sh.setFrozenRows(1);
    sh.getRange(1,1,1,V3_SHEETS[name].length).setFontWeight('bold').setBackground('#eeeeea');
    sh.setColumnWidths(1,V3_SHEETS[name].length,180);sh.setRowHeight(1,32);
    if(name[0]==='_'){sh.hideSheet();sh.protect().setDescription('Sandbox machine index').setWarningOnly(false);}
  });
  var pr=ss.getSheetByName('Projects');
  var data=pr.getDataRange().getValues();
  for(var i=1;i<data.length;i++)if(data[i][17]){pr.getRange(i+1,1,1,3).setValues([['Draft','Not selected in sandbox','']]);pr.getRange(i+1,17).setValue('Preview only');}
  pr.insertColumnsAfter(18,2);pr.getRange(1,19,1,2).setValues([['Development version','Published version']]);
  pr.getRange(1,19,pr.getMaxRows(),2).protect().setDescription('Sandbox version pointers').setWarningOnly(false);
  var legacy=ss.getSheetByName('_Legacy_Config');if(legacy)legacy.hideSheet();
  p.setProperties({SANDBOX_INITIALIZED:'true',AI4S_AUTO_PUBLISH_TARGET:'off',AI4S_REGISTRY_ACCESS_TOKEN:Utilities.getUuid()+Utilities.getUuid(),AI4S_PREVIEW_CALLBACK_SECRET:Utilities.getUuid()+Utilities.getUuid(),AI4S_NETLIFY_SITE_ID:SANDBOX.site_id});
  ScriptApp.getProjectTriggers().forEach(function(t){ScriptApp.deleteTrigger(t);});
  configureSandboxTables_(ss);
  audit_(ss,'initialize','','New independent Sheet and Drive; automatic publishing off');
  console.log('Sandbox initialized; Production disabled.');
});}
function configureSandboxTables_(ss){
  var response=Sheets.Spreadsheets.get(ss.getId(),{fields:'sheets(properties,tables)'}),requests=[];
  var configs={Versions:{Layout:['single','three-page'],State:['Draft','Reviewed'],Permission:['Preview only','Private'],'Use in develop':'BOOLEAN'},Pages:{Role:['insight','dataset','workflow','legacy','resource_page'],State:['Ready','Placeholder']},Resources:{Role:['card','download']}};
  response.sheets.forEach(function(s){var name=s.properties.title,sh=ss.getSheetByName(name),table=(s.tables||[])[0];
    if(name==='Projects'&&table){var cols=table.columnProperties;cols[18]={columnIndex:18,columnName:'Development version',columnType:'TEXT'};cols[19]={columnIndex:19,columnName:'Published version',columnType:'TEXT'};requests.push({updateTable:{table:{tableId:table.tableId,range:{sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:Math.max(2,sh.getLastRow()),startColumnIndex:0,endColumnIndex:20},columnProperties:cols},fields:'range,columnProperties'}});}
    if(!configs[name])return;
    var columns=V3_SHEETS[name].map(function(h,i){var c={columnIndex:i,columnName:h,columnType:'TEXT'},rule=configs[name][h];if(rule==='BOOLEAN')c.columnType='BOOLEAN';else if(rule){c.columnType='DROPDOWN';c.dataValidationRule={condition:{type:'ONE_OF_LIST',values:rule.map(function(v){return {userEnteredValue:v};})}};}return c;});
    var t={name:name+'SandboxV3',range:{sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:Math.max(2,sh.getLastRow()),startColumnIndex:0,endColumnIndex:V3_SHEETS[name].length},columnProperties:columns};
    if(table){t.tableId=table.tableId;requests.push({updateTable:{table:t,fields:'range,columnProperties'}});}else requests.push({addTable:{table:t}});
  });
  if(requests.length)Sheets.Spreadsheets.batchUpdate({requests:requests},ss.getId());
}
function folder_(root,relative){var current=root;relative.split('/').filter(Boolean).forEach(function(name){if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))throw new Error('Unsafe import directory');var it=current.getFoldersByName(name),next=it.hasNext()?it.next():current.createFolder(name);if(it.hasNext())throw new Error('Ambiguous import folder');current=next;});return current;}
function importConfig_(){return JSON.parse(sourceFile_(SANDBOX.import_config_id).getBlob().getDataAsString('UTF-8'));}
function importPilot(){return importVersions_(function(v){return ['demo-tbb-cluster-explorer-2','demo-soh-battery','demo-battery-curve-shape-explorer','demo-air-quality-day-segment-pca-and-amp-umap-by-sensor'].includes(v.demo_id);});}
function importNextProject(){var existing=objects_(tableRows_(sandboxGuard_(),'Versions')).map(function(r){return r['Version ID'];}),chosen='';return importVersions_(function(v){if(chosen||existing.includes(v.version_id))return false;chosen=v.version_id;return true;});}
function importVersions_(predicate){return locked_(function(){
  var ss=sandboxGuard_();if(!PropertiesService.getScriptProperties().getProperty('SANDBOX_INITIALIZED'))throw new Error('Initialize first');
  var pack=importConfig_(),selected=pack.versions.filter(predicate),root=DriveApp.getFolderById(SANDBOX.drive_root_id);
  var importRows=tableRows_(ss,'_ImportFiles'),known={};objects_(importRows).forEach(function(r){known[r.path]=r;});
  selected.forEach(function(version){
    if(objects_(tableRows_(ss,'Versions')).some(function(r){return r['Version ID']===version.version_id;}))return;
    var archive=pack.archives.find(function(a){return a.version_id===version.version_id;});if(!archive)throw new Error('Missing import archive');
    var archiveFile=sourceFile_(archive.file_id),archiveBytes=archiveFile.getBlob();if(hash_(archiveBytes.getBytes())!==archive.sha256)throw new Error('Import archive changed');
    var blobs=Utilities.unzip(archiveBytes),files={};blobs.forEach(function(b){if(!V3.safeRoute(b.getName())||files[b.getName()])throw new Error('Unsafe or duplicate archive path');files[b.getName()]=b;});
    var refs=pack.pages.concat(pack.resources).filter(function(r){return r.version_id===version.version_id&&r.source_path;});
    refs.forEach(function(ref){var spec=pack.files.find(function(f){return f.path===ref.source_path;}),blob=files[ref.source_path];
      if(!spec||!blob||blob.getBytes().length!==spec.size||hash_(blob.getBytes())!==spec.sha256)throw new Error('Import hash mismatch');
      if(known[ref.source_path]){var old=source_(known[ref.source_path].file_id);if(old.sha256!==spec.sha256)throw new Error('Previously imported file was edited');return;}
      var bits=ref.source_path.split('/'),name=bits.pop(),dest=folder_(root,bits.join('/')),same=dest.getFilesByName(name),f;
      if(same.hasNext()){f=same.next();if(same.hasNext()||hash_(f.getBlob().getBytes())!==spec.sha256)throw new Error('Existing import path conflicts');}else f=dest.createFile(blob.setName(name).setContentType(spec.mime_type));
      var rec={path:ref.source_path,file_id:f.getId(),sha256:spec.sha256};known[rec.path]=rec;ss.getSheetByName('_ImportFiles').appendRow([rec.path,rec.file_id,rec.sha256]);
    });
    var project=pack.projects.find(function(p){return p.demo_id===version.demo_id;});upsertProject_(ss,project,version,known,pack);
    function add(name,rows){var current=tableRows_(ss,name),ids=new Set(current.slice(1).map(function(r){return r[0];}));rows.forEach(function(r){if(!ids.has(r[0]))current.push(r);});writeRows_(ss,name,current);}
    add('Pages',pack.pages.filter(function(p){return p.version_id===version.version_id;}).map(function(p){return [p.page_id,p.version_id,p.role,p.state,p.source_path?'https://drive.google.com/file/d/'+known[p.source_path].file_id+'/view':'',p.dataset_id,p.dataset_version,p.route];}));
    add('Resources',pack.resources.filter(function(r){return r.version_id===version.version_id;}).map(function(r){return [r.resource_id,r.version_id,r.role,'https://drive.google.com/file/d/'+known[r.source_path].file_id+'/view',r.route];}));
    add('Versions',[[version.version_id,version.demo_id,version.layout,'Draft','Preview only',true,version.collection,'','Not synced']]);
    audit_(ss,'import','',version.version_id);console.log('Imported '+version.version_id);
  });
  configureSandboxTables_(ss);return selected.length;
});}
function upsertProject_(ss,project,version,known,pack){
  var sh=ss.getSheetByName('Projects'),rows=sh.getDataRange().getValues(),row=rows.findIndex(function(r){return r[17]===project.demo_id;});
  var registry=tableRows_(ss,'_Registry'),headers=registry[0],index=registry.findIndex(function(r){return r[headers.indexOf('demo_id')]===project.demo_id;});
  var entry=pack.pages.find(function(p){return p.version_id===version.version_id&&['insight','legacy'].includes(p.role);});
  if(row<0){
    var taxonomy=objects_(tableRows_(ss,'_Taxonomy'));function label(id){var term=taxonomy.find(function(t){return t.term_id===id;});return term?term.label:id;}
    var options=objects_(tableRows_(ss,'Options'));function option(id){var term=options.find(function(t){return t['Option ID']===id;});return term?term['Option Label']:id;}
    row=sh.getLastRow();sh.getRange(2,1,1,18).copyTo(sh.getRange(row+1,1,1,18));
    sh.getRange(row+1,1,1,20).setValues([['Draft','Not synced','',project.title,project.card_summary,label(project.department_id),label(project.subtopic_id),project.task_ids.map(label).join(', '),project.method_ids.map(label).join(', '),project.data_type_ids.map(option).join(', '),project.instrument_type_ids.map(option).join(', '),'',project.title,project.audience,false,project.data_source_label,'Preview only',project.demo_id,version.version_id,'']]);
    var r=Object.assign({},project,{schema_version:2,row_number:row+1,card_asset_id:'',source_folder_id:'',file_id:known[entry.source_path].file_id,file_check:'ok',readiness:'ready'});
    registry.push(headers.map(function(h){var v=r[h];return Array.isArray(v)?v.join(', '):v===undefined?'':v;}));
    writeRows_(ss,'_Registry',registry);
  }else{sh.getRange(row+1,19).setValue(version.version_id);}
}
function readInput_(ss){
  var sheets={};['Projects','Options','_Registry','_Taxonomy','_Facets','_Assets','_Config'].forEach(function(n){sheets[n]=tableRows_(ss,n);});
  sheets.Projects=sheets.Projects.map(function(r,i){var c=r.slice(0,18);if(i){c[1]='';c[2]='';}return c;});
  var versions=tableRows_(ss,'Versions').map(function(r,i){var c=r.slice();if(i){c[7]='';c[8]='';}return c;});
  return {sheets:sheets,versions:versions,pages:tableRows_(ss,'Pages'),resources:tableRows_(ss,'Resources')};
}
function currentSnapshot_(){var p=PropertiesService.getScriptProperties(),id=p.getProperty('SANDBOX_SNAPSHOT_FILE');if(!id)return null;return JSON.parse(sourceFile_(id).getBlob().getDataAsString('UTF-8'));}
function syncSandbox(){return locked_(syncSandbox_);}
function syncSandbox_(){
  var ss=sandboxGuard_(),input=readInput_(ss),fingerprint=hash_(V3.stable(input)),old=currentSnapshot_(),oldFiles={};
  if(old)old.files.forEach(function(f){oldFiles[f.file_id]=f;});
  var compiled=V2Sheet.compileRegistryV2Sheet(input.sheets);if(!compiled.compiled.ok)throw new Error(JSON.stringify(compiled.compiled.errors));
  var v2=V2.toRegistryV2(compiled.compiled),versions=objects_(tableRows_(ss,'Versions')).map(function(r){return {version_id:r['Version ID'],demo_id:r.demo_id,layout:r.Layout,state:r.State,permission:r.Permission,selected:r['Use in develop']===true,collection:r.Collection,snapshot_digest:r['Snapshot digest']};});
  var selected={};versions.filter(function(v){return v.selected;}).forEach(function(v){if(selected[v.demo_id])throw new Error('Two development versions selected for '+v.demo_id);selected[v.demo_id]=v.version_id;});
  var projects=v2.demos.map(function(p){return Object.assign({},p,{development_version_id:selected[p.demo_id]||'',published_version_id:''});});
  Object.keys(selected).forEach(function(id){if(!projects.some(function(p){return p.demo_id===id;}))throw new Error('Selected project has invalid metadata: '+id);});
  var sources={};function resolve(link){if(!link)return null;var id=fileId_(link);if(!sources[id])sources[id]=source_(id,oldFiles[id]);return sources[id];}
  var pages=objects_(input.pages).map(function(r){return {page_id:r['Page ID'],version_id:r['Version ID'],role:r.Role,state:r.State,source:resolve(r['Source file']),dataset_id:r['Dataset ID'],dataset_version:r['Dataset version'],route:r.Route};});
  var resources=objects_(input.resources).map(function(r){return {resource_id:r['Resource ID'],version_id:r['Version ID'],role:r.Role,source:resolve(r['Source file']),route:r.Route};});
  var result=V3.compileRegistryV3(Object.assign({},SANDBOX,{audience:'preview',site:compiled.siteMetadata,taxonomy:v2.taxonomy,projects:projects,versions:versions,pages:pages,resources:resources}),hash_);
  if(fingerprint!==hash_(V3.stable(readInput_(ss))))throw new Error('Sheet changed during sync; retry');
  result.input_hash=fingerprint;
  if(old&&old.manifest.registry_revision===result.manifest.registry_revision&&old.input_hash===fingerprint){console.log('No content changes; no new snapshot or build.');return old.manifest;}
  result.files.forEach(function(f){assertStamp_(f);});
  var folder=folder_(DriveApp.getFolderById(SANDBOX.drive_root_id),'snapshots'),file=folder.createFile(Utilities.newBlob(JSON.stringify(result),'application/json',result.manifest.registry_revision.slice(7)+'.json'));
  writeRows_(ss,'_Pages',[V3_SHEETS._Pages].concat(result.manifest.bundles.flatMap(function(b){return b.pages.map(function(p){var f=p.source||{};return [p.page_id,b.version_id,p.role,p.state,p.route,f.file_id||'',f.sha256||'',f.size||'',f.modified_at||''];});})));
  writeRows_(ss,'_Resources',[V3_SHEETS._Resources].concat(result.manifest.bundles.flatMap(function(b){return b.resources.map(function(r){return [r.resource_id,b.version_id,r.route,r.source.file_id,r.source.sha256,r.source.size,r.source.modified_at];});})));
  var versionSheet=ss.getSheetByName('Versions'),versionRows=versionSheet.getDataRange().getValues();
  result.manifest.bundles.forEach(function(b){var row=versionRows.findIndex(function(r){return r[0]===b.version_id;});versionSheet.getRange(row+1,8,1,2).setValues([[b.snapshot_digest,'Validated']]);});
  var projectSheet=ss.getSheetByName('Projects'),projectRows=projectSheet.getDataRange().getValues();
  projectRows.slice(1).forEach(function(r,i){if(!r[17])return;var version=selected[r[17]]||'';projectSheet.getRange(i+2,19,1,2).setValues([[version,'']]);projectSheet.getRange(i+2,2,1,2).setValues([[version?'Validated; preview pending':'Not selected in sandbox','']]);});
  ss.getSheetByName('_Snapshots').appendRow([result.manifest.registry_revision,file.getId(),fingerprint,new Date().toISOString()]);
  PropertiesService.getScriptProperties().setProperty('SANDBOX_SNAPSHOT_FILE',file.getId());
  audit_(ss,'sync',result.manifest.registry_revision,result.manifest.demos.length+' projects');
  console.log('Validated '+result.manifest.demos.length+' projects; '+result.manifest.registry_revision);return result.manifest;
}
function assertStamp_(descriptor){var binding=sourceBinding_(descriptor.file_id),f=binding.file;if(f.getLastUpdated().toISOString()!==descriptor.modified_at||f.getSize()!==descriptor.size||f.getMimeType()!==descriptor.mime_type||binding.parent_path!==descriptor.parent_path)throw new Error('Source changed; synchronize before building');return f;}
function checkedSnapshot_(revision,allFiles){var ss=sandboxGuard_(),snapshot=currentSnapshot_();if(!snapshot)throw new Error('Synchronize first');if(revision&&snapshot.manifest.registry_revision!==revision)throw new Error('Registry revision changed');if(hash_(V3.stable(readInput_(ss)))!==snapshot.input_hash)throw new Error('Sheet changed; synchronize before building');if(allFiles)snapshot.files.forEach(assertStamp_);return snapshot;}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
function safeEqual_(a,b){a=String(a||'');b=String(b||'');var diff=a.length^b.length;for(var i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
function doGet(e){try{
  var q=e&&e.parameter||{},p=PropertiesService.getScriptProperties(),token=p.getProperty('AI4S_REGISTRY_ACCESS_TOKEN');
  if(!token||!safeEqual_(q.token,token))return json_({ok:false,error:'Unauthorized'});
  if(q.schema!=='3'||q.audience!=='preview')throw new Error('Sandbox accepts schema 3 Preview only');
  var snapshot=checkedSnapshot_(q.registry_revision,q.action==='manifest');
  if(q.action==='manifest')return json_(Object.assign({ok:true},snapshot.manifest));
  if(!['page','resource'].includes(q.action))throw new Error('Unknown action');
  var f=V3.authorizedFile(snapshot,q.id,q.audience,q.registry_revision);
  if((q.action==='page')!==(f.kind==='page'))throw new Error('Wrong file role');
  var driveFile=assertStamp_(f),blob=driveFile.getBlob(),bytes=blob.getBytes();
  if(hash_(bytes)!==f.sha256||bytes.length!==f.size)throw new Error('Source hash changed');assertStamp_(f);
  var response={ok:true,id:f.id,registry_instance:SANDBOX.registry_instance,registry_revision:snapshot.manifest.registry_revision};
  if(f.kind==='page')response.html=blob.getDataAsString('UTF-8');else response.base64=Utilities.base64Encode(bytes);
  return json_(response);
}catch(error){return json_({ok:false,error:String(error.message).slice(0,400)});}}
function previewState_(){return JSON.parse(PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE')||'{}');}
function savePreviewState_(s){PropertiesService.getScriptProperties().setProperty('SANDBOX_PREVIEW_STATE',JSON.stringify(s));}
function publishPreview(forceArtifactRefresh){return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties(),snapshot=checkedSnapshot_('',true),revision=snapshot.manifest.registry_revision,state=previewState_();
  var artifactRefresh=forceArtifactRefresh===true&&typeof registryManualNeedsPreviewArtifact_==='function'&&registryManualNeedsPreviewArtifact_(state,revision);
  if(!artifactRefresh&&state.revision===revision && ['requested','accepted','ready','failed','replaced'].includes(state.phase)){console.log('Existing preview request: '+state.phase+'; no duplicate build');return state;}
  var hook=p.getProperty('AI4S_NETLIFY_PREVIEW_BUILD_HOOK');if(!/^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(hook||''))throw new Error('Configure the dedicated develop build hook first');
  var request={schema:1,target:'preview',branch:'develop',registry_revision:revision,request_id:Utilities.getUuid(),requested_at:new Date().toISOString()};
  var attempts=artifactRefresh?1:state.revision===revision?(state.attempts||1)+1:1;if(attempts>3)throw new Error('Three attempts reached; fix the content or configuration before retrying');
  state={revision:revision,request_id:request.request_id,requested_at:request.requested_at,phase:'requested',attempts:attempts};savePreviewState_(state);
  // Store the request before HTTP. An uncertain network result must never create
  // a second logical build automatically.
  var response=UrlFetchApp.fetch(hook+'?trigger_branch=develop',{method:'post',contentType:'application/json',payload:JSON.stringify(request),muteHttpExceptions:true});
  var code=response.getResponseCode();state.phase=code>=200&&code<300?'accepted':'failed';state.http_status=code;savePreviewState_(state);
  audit_(ss,'preview-'+state.phase,revision,state.request_id);console.log('Preview '+state.phase+'; waiting for signed completion');return state;
});}
function retryPreviewAfterFailure(){
  var ss=sandboxGuard_(),ui=SpreadsheetApp.getUi(),answer=ui.alert('Retry develop preview','First verify in Netlify that the previous sandbox build failed, was cancelled, or completed without a verified Registry request. Never retry a running or verified successful build. Have you checked its status?',ui.ButtonSet.YES_NO);
  if(answer!==ui.Button.YES)return;
  locked_(function(){var state=previewState_();if(!['requested','accepted','failed','replaced'].includes(state.phase))throw new Error('No failed or incomplete request to retry');if((state.attempts||1)>=3)throw new Error('Three attempts reached; correct the underlying issue first');audit_(ss,'manual-retry',state.revision,state.request_id);state.phase='retry-approved';savePreviewState_(state);});
  return publishPreview();
}
function doPost(e){if(e&&e.parameter&&e.parameter.action==='manual_release')return registryReleaseStoreHandlePost_(e);try{return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();if(!e||!e.parameter||e.parameter.action!=='preview_callback'||String(e.postData&&e.postData.contents||'').length>20000)throw new Error('Invalid callback');
  var envelope=JSON.parse(e.postData.contents),secret=p.getProperty('AI4S_PREVIEW_CALLBACK_SECRET');
  if(!secret||typeof envelope.payload!=='string')throw new Error('Unauthorized callback');
  var signature=Utilities.computeHmacSha256Signature(envelope.payload,secret).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
  if(!safeEqual_(signature,envelope.signature))throw new Error('Unauthorized callback');
  var payload=JSON.parse(envelope.payload),r=payload.receipt,state=previewState_(),now=Date.now();
  if(payload.schema!==1||payload.event!=='preview_deploy_succeeded'||!Number.isFinite(Date.parse(payload.callback_at))||Math.abs(now-Date.parse(payload.callback_at))>15*60*1000)throw new Error('Expired callback');
  if(!r||r.schema!==1||r.registry_schema!==3||r.registry_instance!==SANDBOX.registry_instance||![true,false].includes(r.verified)||r.revision_bound!==true||r.target!=='preview'||r.audience!=='preview'||r.platform!=='netlify'||r.context!=='branch-deploy'||r.branch!=='develop'||r.site_id!==SANDBOX.site_id||!r.deploy_id||!r.build_id||!/^[a-f0-9]{40}$/.test(r.commit_ref||''))throw new Error('Callback identity mismatch');
  if(r.verified===false){
    if(state.phase==='ready'){
      var changed=ss.getSheetByName('Projects'),changedRows=changed.getDataRange().getValues();
      changedRows.slice(1).forEach(function(row,i){if(row[18])changed.getRange(i+2,2,1,2).setValues([['Preview replaced; verification required','']]);});
      state.phase='replaced';state.replaced_by=r.deploy_id;savePreviewState_(state);audit_(ss,'preview-replaced',state.revision,r.deploy_id);
    }
    return json_({ok:true,event:'preview_callback',deploy_id:r.deploy_id});
  }
  if(state.phase==='replaced'||r.registry_revision!==state.revision||r.request_id!==state.request_id||r.requested_at!==state.requested_at)throw new Error('Callback request mismatch');
  if(state.phase==='ready'&&state.deploy_id!==r.deploy_id)throw new Error('Callback replay');
  checkedSnapshot_(state.revision,true);
  if(state.phase!=='ready'){
    var sh=ss.getSheetByName('Projects'),rows=sh.getDataRange().getValues(),registry=objects_(tableRows_(ss,'_Registry'));
    rows.slice(1).forEach(function(row,i){if(!row[18])return;var d=registry.find(function(d){return d.demo_id===row[17];});if(!d)return;sh.getRange(i+2,2).setValue('Preview ready');sh.getRange(i+2,3).setFormula('=HYPERLINK("https://develop--aisigym.netlify.app/demos/'+d.slug+'/","Open Preview")');});
    state.phase='ready';state.deploy_id=r.deploy_id;state.commit_ref=r.commit_ref;state.ready_at=payload.callback_at;savePreviewState_(state);audit_(ss,'preview-ready',state.revision,r.deploy_id);
  }
  return json_({ok:true,event:'preview_callback',deploy_id:r.deploy_id});
});}catch(error){return json_({ok:false,error:String(error.message).slice(0,200)});}}
function showSandboxStatus(){var s=previewState_();SpreadsheetApp.getUi().alert('Sandbox preview',JSON.stringify(s,null,2),SpreadsheetApp.getUi().ButtonSet.OK);}
function hourlySandbox(){registryPublishingRefreshStatus();}
function enableSandboxAutomation(){sandboxGuard_();var state=previewState_();if(state.phase!=='ready')throw new Error('Verify a signed develop deployment first');disableSandboxAutomation();ScriptApp.newTrigger('hourlySandbox').timeBased().everyHours(1).create();PropertiesService.getScriptProperties().setProperty('AI4S_AUTO_PUBLISH_TARGET','preview');}
function disableSandboxAutomation(){sandboxGuard_();ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='hourlySandbox';}).forEach(function(t){ScriptApp.deleteTrigger(t);});PropertiesService.getScriptProperties().setProperty('AI4S_AUTO_PUBLISH_TARGET','off');}

/** Map verified physical project folders to unchanged logical V3 paths. */
function projectMounts_() {
  var config = JSON.parse(PropertiesService.getScriptProperties().getProperty('AIS_PROJECT_MOUNTS_V1') || '{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid project mount configuration');
  if (config.schema !== undefined && config.schema !== 1 && config.schema !== 2 && config.schema !== 3) throw new Error('Unsupported project mount schema');
  if (config.schema === 2) validateCategoryMounts_(config);
  if (config.schema === 3) validateFlatMounts_(config);
  return config;
}
function oneParent_(entry) {
  var it = entry.getParents();
  if (!it.hasNext()) throw new Error('Source has no parent');
  var parent = it.next();
  if (it.hasNext()) throw new Error('Ambiguous source parents');
  return parent;
}
/** Schema 2 binds every selected source-parent folder to its entire ID ancestry.
 * Physical labels (including project numbers) never become logical paths. A
 * nested download folder needs its own mount; mounting a parent grants no access
 * to arbitrary descendants. Keep this property key to preserve existing setup.
 */
function validateCategoryMounts_(config) {
  if (config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH') throw new Error('Unrecognized project root');
  if (!Array.isArray(config.mounts)) throw new Error('Invalid category mounts');
  var ids = {}, paths = {};
  config.mounts.forEach(function(mount) {
    if (!mount || typeof mount.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(mount.id)
      || mount.id === config.root_id || mount.id === SANDBOX.drive_root_id || ids[mount.id]) throw new Error('Invalid or duplicate mount ID');
    ids[mount.id] = true;
    var chain = mount.ancestor_chain;
    if (!Array.isArray(chain) || !chain.length || chain.length > 10 || chain[chain.length - 1] !== config.root_id) throw new Error('Invalid mount ancestor chain');
    var seen = {}; seen[mount.id] = true;
    chain.forEach(function(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || seen[id]) throw new Error('Invalid or duplicate mount ancestor');
      seen[id] = true;
    });
    var logical = mount.logical_path;
    if (typeof logical !== 'string' || logical.length >= 240 || paths[logical]) throw new Error('Invalid or duplicate mount path');
    var parts = logical.split('/'), stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (parts.length < 3 || !stableId.test(parts[1]) || !stableId.test(parts[2])
      || !(parts[0] === 'datasets' && parts.length === 3
        || parts[0] === 'projects' && (parts.length === 3 || parts[3] === 'resources'))
      || parts.slice(3).some(function(part) { return !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..'; })) throw new Error('Invalid mount path');
    paths[logical] = true;
  });
}
function categoryMountPath_(folder, mount) {
  var current = folder;
  mount.ancestor_chain.forEach(function(expectedId) {
    current = oneParent_(current);
    if (current.getId() !== expectedId) throw new Error('Project mount moved outside its approved location');
  });
  return mount.logical_path;
}
/** Schema 3 permits different stable logical paths in one flat physical folder.
 * Every source is allowlisted by file ID. Paths, filenames and neighbouring
 * files do not grant access; the whole ancestor-ID chain is checked each time. */
function validateFlatMounts_(config) {
  if (config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH') throw new Error('Unrecognized project root');
  if (!Array.isArray(config.mounts) || !config.mounts.length) throw new Error('Invalid flat mounts');
  var mountIds = {}, fileIds = {};
  config.mounts.forEach(function(mount) {
    if (!mount || typeof mount.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(mount.id)
      || mount.id === config.root_id || mount.id === SANDBOX.drive_root_id || mountIds[mount.id]) throw new Error('Invalid or duplicate flat mount ID');
    mountIds[mount.id] = true;
    if (!Array.isArray(mount.bindings) || !mount.bindings.length) throw new Error('Invalid flat source bindings');
    var paths = {};
    mount.bindings.forEach(function(binding) {
      if (!binding || paths[binding.logical_path]) throw new Error('Invalid or duplicate flat binding path');
      // Reuse the established canonical-path and exact ancestry-shape checks.
      validateCategoryMounts_({ root_id: config.root_id, mounts: [{ id: mount.id,
        ancestor_chain: mount.ancestor_chain, logical_path: binding.logical_path }] });
      paths[binding.logical_path] = true;
      if (!Array.isArray(binding.file_ids) || !binding.file_ids.length) throw new Error('Invalid flat source file allowlist');
      binding.file_ids.forEach(function(id) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(id) || fileIds[id]
          || id === mount.id || mount.ancestor_chain.includes(id)) throw new Error('Invalid or duplicate flat source file ID');
        fileIds[id] = true;
      });
    });
  });
  if (Object.keys(mountIds).some(function(id) { return fileIds[id]; })) throw new Error('Flat source file cannot be a mounted folder');
}
function flatMountPath_(file, folder, mount) {
  var id = file.getId(), binding = mount.bindings.find(function(entry) { return entry.file_ids.includes(id); });
  if (!binding) throw new Error('Source file is not explicitly allowed in its flat mount');
  categoryMountPath_(folder, mount);
  return binding.logical_path;
}
function mountedSourceParentPath_(file) {
  var config = projectMounts_(), parts = [], current = file, seen = {};
  for (var depth = 0; depth < 12; depth++) {
    var parent = oneParent_(current), id = parent.getId();
    if (seen[id]) throw new Error('Source parent cycle');
    seen[id] = true;
    if (id === SANDBOX.drive_root_id) return parts.reverse().join('/');
    var mount = (config.mounts || []).find(function(m) { return m.id === id; });
    if (mount) {
      if (config.schema === 3) {
        if (depth !== 0) throw new Error('Source parent folder has no explicit flat mount');
        return flatMountPath_(file, parent, mount);
      }
      if (config.schema === 2) {
        if (depth !== 0) throw new Error('Source parent folder has no explicit category mount');
        return categoryMountPath_(parent, mount);
      }
      if (config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH') throw new Error('Unrecognized project root');
      var project = oneParent_(parent);
      if (project.getId() !== mount.project_id || oneParent_(project).getId() !== config.root_id) throw new Error('Project mount moved outside its approved location');
      if (!/^(projects|datasets)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mount.logical_path)) throw new Error('Invalid mount path');
      return mount.logical_path + (parts.length ? '/' + parts.reverse().join('/') : '');
    }
    parts.push(parent.getName()); current = parent;
  }
  throw new Error('Source is outside the approved project folders');
}

function configureProjectMounts() {
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();
  var config=JSON.parse(DriveApp.getFileById('13pcmqFeD_RvtI9Wi-8hm9GxuNjRiNEro').getBlob().getDataAsString('UTF-8'));
  if(config.develop_sheet_id!==ss.getId()||config.root_id!=='1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'||config.mount_config.mounts.length!==24)throw new Error('Unexpected project mapping');
  config.mount_config.mounts.forEach(function(m){var folder=DriveApp.getFolderById(m.id),project=oneParent_(folder);if(project.getId()!==m.project_id||oneParent_(project).getId()!==config.root_id)throw new Error('Project mount is not in position: '+m.logical_path);});
  p.setProperty('AIS_PROJECT_MOUNTS_V1',JSON.stringify(config.mount_config));
  var snapshot=checkedSnapshot_('',true);
  audit_(ss,'project-folders-migrated',snapshot.manifest.registry_revision,'24 source mounts in AISInstrumentationGym; file IDs and logical routes preserved');
  console.log('All '+snapshot.files.length+' sources verified in the original project folders; existing snapshot remains valid.');
}

/** One-time category migration helpers. No Sheet writes, sync or build Hooks. */
var CATEGORY_V3_CONFIG_FILE_ID = '1Cx4U5JC9ZGlordnRNt3bJK9lanH_6xe9';
var CATEGORY_V3_MIGRATION_ID = 'drive-category-20261002';
function categoryV3Automation_() {
  return {
    auto_publish_target: PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off',
    hourly_trigger_count: ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'hourlySandbox'; }).length
  };
}
function categoryV3Paused_() {
  var state = categoryV3Automation_();
  if (state.auto_publish_target !== 'off' || state.hourly_trigger_count !== 0) throw new Error('Pause sandbox automation before installing category mounts');
}
function categoryV3PreviewState_() {
  var state = previewState_(), safe = {};
  ['phase','revision','request_id','requested_at','attempts','http_status','deploy_id','commit_ref','ready_at'].forEach(function(key) {
    if (state[key] !== undefined && ['string','number','boolean'].includes(typeof state[key])) safe[key] = state[key];
  });
  return safe;
}
function categoryV3SaveJson_(name, value) {
  var directory = folder_(DriveApp.getFolderById(SANDBOX.drive_root_id), 'imports');
  return directory.createFile(Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name)).getId();
}
function categoryV3ReadAdminJson_(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(id) || id.indexOf('__') === 0) throw new Error('Configure a valid category migration file ID');
  var file = sourceFile_(id);
  if (sourceParentPath_(file) !== 'imports' || file.getMimeType() !== 'application/json') throw new Error('Category migration JSON must be in backend imports');
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}
function categoryExportV3() { return locked_(function() {
  var ss = sandboxGuard_(), properties = PropertiesService.getScriptProperties();
  var snapshot = checkedSnapshot_('', true), existing = properties.getProperty('AIS_CATEGORY_V3_BASELINE_FILE');
  if (existing) {
    var prior = categoryV3ReadAdminJson_(existing);
    if (prior.migration_id !== CATEGORY_V3_MIGRATION_ID || prior.snapshot_sha256 !== hash_(V3.stable(snapshot))) throw new Error('Existing category baseline differs; preserve it and review the migration state');
    console.log('Baseline file: ' + existing); return existing;
  }
  var baseline = {
    schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, exported_at: new Date().toISOString(),
    root_id: '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH', develop_sheet_id: ss.getId(), backend_root_id: SANDBOX.drive_root_id,
    snapshot_file_id: properties.getProperty('SANDBOX_SNAPSHOT_FILE'), snapshot_sha256: hash_(V3.stable(snapshot)),
    snapshot: snapshot, mount_config: projectMounts_(), preview_state: categoryV3PreviewState_(),
    input_hash: hash_(V3.stable(readInput_(ss))), automation: categoryV3Automation_()
  };
  if (baseline.input_hash !== snapshot.input_hash) throw new Error('Sheet changed during baseline export');
  var fileId = categoryV3SaveJson_('drive-category-v3-baseline-20261002.json', baseline);
  properties.setProperty('AIS_CATEGORY_V3_BASELINE_FILE', fileId);
  console.log('Baseline file: ' + fileId); return fileId;
}); }
function categoryV3Config_() {
  var config = categoryV3ReadAdminJson_(CATEGORY_V3_CONFIG_FILE_ID);
  if (config.schema !== 1 || config.migration_id !== CATEGORY_V3_MIGRATION_ID
    || config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'
    || config.develop_sheet_id !== SANDBOX.spreadsheet_id || config.backend_root_id !== SANDBOX.drive_root_id
    || !config.mount_config || config.mount_config.schema !== 2 || config.mount_config.root_id !== config.root_id) throw new Error('Unexpected category migration configuration');
  validateCategoryMounts_(config.mount_config);
  var baselineId = PropertiesService.getScriptProperties().getProperty('AIS_CATEGORY_V3_BASELINE_FILE');
  if (!baselineId || config.baseline_file_id !== baselineId) throw new Error('Category configuration does not reference the exported baseline');
  return config;
}
function categoryV3VerifyBindings_(config, ss) {
  var properties = PropertiesService.getScriptProperties(), baseline = categoryV3ReadAdminJson_(config.baseline_file_id);
  if (baseline.schema !== 1 || baseline.migration_id !== CATEGORY_V3_MIGRATION_ID
    || baseline.root_id !== config.root_id || baseline.develop_sheet_id !== SANDBOX.spreadsheet_id
    || baseline.backend_root_id !== SANDBOX.drive_root_id || !baseline.snapshot
    || !Array.isArray(baseline.snapshot.files) || !baseline.snapshot.files.length
    || baseline.snapshot_sha256 !== hash_(V3.stable(baseline.snapshot))) throw new Error('Invalid category baseline');
  if (V3.stable(projectMounts_()) !== V3.stable(config.mount_config)) throw new Error('Installed category mounts differ from the reviewed configuration');
  var current = currentSnapshot_(), fingerprint = hash_(V3.stable(readInput_(ss)));
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(current)) !== baseline.snapshot_sha256 || fingerprint !== baseline.input_hash
    || fingerprint !== current.input_hash) throw new Error('Snapshot or Sheet input changed since baseline export');
  var observed = {}, files = [];
  current.files.forEach(function(expected) {
    // Omit the previous descriptor so every unique file is freshly hashed.
    var actual = observed[expected.file_id] || (observed[expected.file_id] = source_(expected.file_id));
    ['file_id','parent_path','sha256','size','mime_type','modified_at'].forEach(function(key) {
      if (actual[key] !== expected[key]) throw new Error('Category source binding changed: ' + expected.id + ' (' + key + ')');
    });
    files.push({ id: expected.id, file_id: actual.file_id, logical_parent_path: actual.parent_path,
      sha256: actual.sha256, size: actual.size, mime_type: actual.mime_type, modified_at: actual.modified_at });
  });
  current.files.forEach(assertStamp_);
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(currentSnapshot_())) !== baseline.snapshot_sha256
    || hash_(V3.stable(readInput_(ss))) !== fingerprint) throw new Error('Source snapshot or Sheet input changed during verification');
  return { schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, verified_at: new Date().toISOString(),
    result: 'PASS', registry_revision: current.manifest.registry_revision,
    project_count: current.manifest.demos.length, binding_count: files.length,
    unique_file_count: Object.keys(observed).length, baseline_file_id: config.baseline_file_id,
    config_file_id: CATEGORY_V3_CONFIG_FILE_ID, snapshot_file_id: baseline.snapshot_file_id,
    input_hash: fingerprint, snapshot_sha256: baseline.snapshot_sha256,
    mount_config_sha256: hash_(V3.stable(config.mount_config)), files: files,
    preview_state: categoryV3PreviewState_(), automation: categoryV3Automation_() };
}
function categoryV3SaveVerification_(report) {
  var fileId = categoryV3SaveJson_('drive-category-v3-verification-20261002-' + Date.now() + '.json', report);
  console.log('Category bindings PASS; revision ' + report.registry_revision + '; ' + report.binding_count + ' bindings; ' + report.unique_file_count + ' files; report ' + fileId);
  return fileId;
}
function categoryInstallV3() { return locked_(function() {
  var ss = sandboxGuard_(); categoryV3Paused_();
  var config = categoryV3Config_(), properties = PropertiesService.getScriptProperties();
  var previous = properties.getProperty('AIS_PROJECT_MOUNTS_V1');
  try {
    properties.setProperty('AIS_PROJECT_MOUNTS_V1', JSON.stringify(config.mount_config));
    return categoryV3SaveVerification_(categoryV3VerifyBindings_(config, ss));
  } catch (error) {
    if (previous === null) properties.deleteProperty('AIS_PROJECT_MOUNTS_V1');
    else properties.setProperty('AIS_PROJECT_MOUNTS_V1', previous);
    throw error;
  }
}); }
function categoryVerifyV3() { return locked_(function() {
  var ss = sandboxGuard_(); categoryV3Paused_();
  return categoryV3SaveVerification_(categoryV3VerifyBindings_(categoryV3Config_(), ss));
}); }

/** Bounded category verification. Each operation fits a separate Apps Script run. */
var CATEGORY_V3_VERIFY_PROGRESS = 'AIS_CATEGORY_V3_VERIFY_PROGRESS';
var CATEGORY_V3_VERIFY_CHUNK_SIZE = 12;
function categoryV3BatchContext_(ss, install) {
  categoryV3Paused_();
  var config = categoryV3Config_(), properties = PropertiesService.getScriptProperties();
  var baseline = categoryV3ReadAdminJson_(config.baseline_file_id);
  if (baseline.schema !== 1 || baseline.migration_id !== CATEGORY_V3_MIGRATION_ID
    || baseline.root_id !== config.root_id || baseline.develop_sheet_id !== SANDBOX.spreadsheet_id
    || baseline.backend_root_id !== SANDBOX.drive_root_id || !baseline.snapshot
    || !Array.isArray(baseline.snapshot.files) || !baseline.snapshot.files.length
    || baseline.snapshot_sha256 !== hash_(V3.stable(baseline.snapshot))) throw new Error('Invalid category baseline');
  var snapshot = currentSnapshot_(), inputHash = hash_(V3.stable(readInput_(ss)));
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(snapshot)) !== baseline.snapshot_sha256 || inputHash !== baseline.input_hash
    || inputHash !== snapshot.input_hash) throw new Error('Snapshot or Sheet input changed since baseline export');
  var installed = projectMounts_();
  if (V3.stable(installed) !== V3.stable(config.mount_config)) {
    if (!install || V3.stable(installed) !== V3.stable(baseline.mount_config)) throw new Error('Installed category mounts differ from the approved configuration');
    properties.setProperty('AIS_PROJECT_MOUNTS_V1', JSON.stringify(config.mount_config));
  }
  var binding = { migration_id: CATEGORY_V3_MIGRATION_ID, baseline_file_id: config.baseline_file_id,
    config_file_id: CATEGORY_V3_CONFIG_FILE_ID, config_sha256: hash_(V3.stable(config)),
    baseline_sha256: hash_(V3.stable(baseline)), snapshot_file_id: baseline.snapshot_file_id,
    snapshot_sha256: baseline.snapshot_sha256, input_hash: inputHash,
    mount_config_sha256: hash_(V3.stable(config.mount_config)),
    registry_revision: snapshot.manifest.registry_revision, binding_count: snapshot.files.length };
  return { config: config, baseline: baseline, snapshot: snapshot, binding: binding, hash: hash_(V3.stable(binding)) };
}
function categoryV3BatchProgress_(context) {
  var raw = PropertiesService.getScriptProperties().getProperty(CATEGORY_V3_VERIFY_PROGRESS);
  if (!raw) throw new Error('Run categoryBeginV3Verification first');
  var progress = JSON.parse(raw);
  if (progress.schema !== 1 || progress.context_hash !== context.hash
    || V3.stable(progress.binding) !== V3.stable(context.binding)
    || !['hashing','complete'].includes(progress.phase)
    || !Number.isInteger(progress.next_index) || progress.next_index < 0
    || progress.next_index > context.snapshot.files.length || !Array.isArray(progress.chunks)) throw new Error('Category verification context or progress changed');
  var cursor = 0;
  progress.chunks.forEach(function(chunk) {
    if (chunk.start !== cursor || !Number.isInteger(chunk.end) || chunk.end <= cursor
      || chunk.end > Math.min(cursor + CATEGORY_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length)
      || typeof chunk.file_id !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Invalid category verification chunk index');
    cursor = chunk.end;
  });
  if (cursor !== progress.next_index) throw new Error('Incomplete category verification progress');
  return progress;
}
function categoryV3WriteProgress_(progress) {
  var text = JSON.stringify(progress);
  if (text.length >= 8500) throw new Error('Category verification progress exceeds the bounded property size');
  PropertiesService.getScriptProperties().setProperty(CATEGORY_V3_VERIFY_PROGRESS, text);
}
function categoryBeginV3Verification() { return locked_(function() {
  var context = categoryV3BatchContext_(sandboxGuard_(), true);
  var properties = PropertiesService.getScriptProperties(), progress;
  if (properties.getProperty(CATEGORY_V3_VERIFY_PROGRESS)) progress = categoryV3BatchProgress_(context);
  else {
    progress = { schema: 1, context_hash: context.hash, binding: context.binding,
      phase: 'hashing', next_index: 0, chunks: [] };
    categoryV3WriteProgress_(progress);
  }
  console.log('Category verification ' + progress.phase + '; verified ' + progress.next_index + '/' + context.snapshot.files.length + ' bindings');
  return { phase: progress.phase, verified: progress.next_index, total: context.snapshot.files.length };
}); }
function categoryV3VerifiedFile_(expected, actual) {
  ['file_id','parent_path','sha256','size','mime_type','modified_at'].forEach(function(key) {
    if (actual[key] !== expected[key]) throw new Error('Category source binding changed: ' + expected.id + ' (' + key + ')');
  });
  return { id: expected.id, file_id: actual.file_id, logical_parent_path: actual.parent_path,
    sha256: actual.sha256, size: actual.size, mime_type: actual.mime_type, modified_at: actual.modified_at };
}
function categoryVerifyV3Chunk() { return locked_(function() {
  var ss = sandboxGuard_(), context = categoryV3BatchContext_(ss, false), progress = categoryV3BatchProgress_(context);
  var start = progress.next_index, end = Math.min(start + CATEGORY_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length);
  if (progress.phase === 'complete' || start === end) {
    console.log('All source hashes verified; phase ' + progress.phase + '; use categoryFinalizeV3Verification');
    return { phase: progress.phase, verified: start, total: context.snapshot.files.length };
  }
  var observed = {}, files = context.snapshot.files.slice(start, end).map(function(expected) {
    var actual = observed[expected.file_id] || (observed[expected.file_id] = source_(expected.file_id));
    return categoryV3VerifiedFile_(expected, actual);
  });
  if (categoryV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Category verification context changed during chunk');
  var report = { schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, context_hash: context.hash,
    verified_at: new Date().toISOString(), start: start, end: end, files: files };
  var fileId = categoryV3SaveJson_('drive-category-v3-chunk-' + start + '-' + end + '-' + Date.now() + '.json', report);
  // A failed or timed-out chunk never advances the cursor without saved proof.
  progress.chunks.push({ start: start, end: end, file_id: fileId, sha256: hash_(V3.stable(report)) });
  progress.next_index = end;
  categoryV3WriteProgress_(progress);
  console.log('Category hashes verified ' + end + '/' + context.snapshot.files.length + '; chunk ' + fileId);
  return { phase: progress.phase, verified: end, total: context.snapshot.files.length };
}); }
function categoryFinalizeV3Verification() { return locked_(function() {
  var ss = sandboxGuard_(), context = categoryV3BatchContext_(ss, false), progress = categoryV3BatchProgress_(context);
  if (progress.phase === 'complete') {
    console.log('Category verification already complete; report ' + progress.report_file_id); return progress.report_file_id;
  }
  if (progress.next_index !== context.snapshot.files.length) throw new Error('Verify every source chunk before finalizing');
  var files = [], uniqueFiles = {};
  progress.chunks.forEach(function(chunk) {
    var saved = categoryV3ReadAdminJson_(chunk.file_id);
    if (hash_(V3.stable(saved)) !== chunk.sha256 || saved.schema !== 1
      || saved.migration_id !== CATEGORY_V3_MIGRATION_ID || saved.context_hash !== context.hash
      || saved.start !== chunk.start || saved.end !== chunk.end || !Array.isArray(saved.files)
      || saved.files.length !== chunk.end - chunk.start) throw new Error('Category chunk proof changed or is incomplete');
    saved.files.forEach(function(actual, offset) {
      var expected = context.snapshot.files[chunk.start + offset];
      if (actual.id !== expected.id) throw new Error('Category chunk contains the wrong logical identity');
      var checked = categoryV3VerifiedFile_(expected, { file_id: actual.file_id,
        parent_path: actual.logical_parent_path, sha256: actual.sha256, size: actual.size,
        mime_type: actual.mime_type, modified_at: actual.modified_at });
      uniqueFiles[actual.file_id] = true; files.push(checked);
    });
  });
  if (files.length !== context.snapshot.files.length) throw new Error('Category source coverage is incomplete');
  context.snapshot.files.forEach(assertStamp_);
  if (categoryV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Category verification context changed during finalization');
  var report = { schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, verified_at: new Date().toISOString(),
    result: 'PASS', registry_revision: context.binding.registry_revision,
    project_count: context.snapshot.manifest.demos.length, binding_count: files.length,
    unique_file_count: Object.keys(uniqueFiles).length, baseline_file_id: context.config.baseline_file_id,
    config_file_id: CATEGORY_V3_CONFIG_FILE_ID, snapshot_file_id: context.binding.snapshot_file_id,
    input_hash: context.binding.input_hash, snapshot_sha256: context.binding.snapshot_sha256,
    mount_config_sha256: context.binding.mount_config_sha256, files: files,
    chunk_reports: progress.chunks, preview_state: categoryV3PreviewState_(), automation: categoryV3Automation_() };
  var fileId = categoryV3SaveVerification_(report);
  progress.phase = 'complete'; progress.report_file_id = fileId;
  categoryV3WriteProgress_(progress);
  return fileId;
}); }

/** Editor-only post-migration checks. Run each public function separately.
 * These call the existing authenticated doGet implementation internally; they
 * do not add a public endpoint or prove the deployed HTTP transport or ACLs. */
function categoryV3RuntimeContext_() {
  var context = categoryV3BatchContext_(sandboxGuard_(), false);
  if (categoryV3BatchProgress_(context).phase !== 'complete') throw new Error('Complete bounded source verification before checking runtime');
  return context;
}
function categoryV3RuntimeBefore_() {
  return { context: categoryV3RuntimeContext_(), preview_state: PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE'), started: Date.now() };
}
function categoryV3RuntimeFinish_(before, operation, checks) {
  var after = categoryV3RuntimeContext_();
  if (after.hash !== before.context.hash || PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE') !== before.preview_state) throw new Error('Runtime check changed the snapshot, input or preview state');
  var report = { schema: 1, migration_id: CATEGORY_V3_MIGRATION_ID, result: 'PASS',
    operation: operation, scope: 'editor-runtime-only', registry_revision: after.binding.registry_revision,
    context_hash: after.hash, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - before.started, checks: checks };
  var id = categoryV3SaveJson_('drive-category-v3-runtime-' + operation + '-' + Date.now() + '.json', report);
  console.log('Category runtime ' + operation + ' PASS; ' + report.elapsed_ms + ' ms; revision ' + report.registry_revision + '; report ' + id);
  return { result: report.result, operation: operation, elapsed_ms: report.elapsed_ms, report_file_id: id };
}
function categoryV3RuntimeCheck() {
  var before = categoryV3RuntimeBefore_(), started = Date.now();
  // syncSandbox owns its normal lock; do not wrap it in another locked_ call.
  // Automation remains paused and no publishing function is invoked.
  var manifest = syncSandbox();
  if (V3.stable(manifest) !== V3.stable(before.context.snapshot.manifest)) throw new Error('Normal sync changed the manifest');
  return categoryV3RuntimeFinish_(before, 'sync', [{ operation: 'syncSandbox', elapsed_ms: Date.now() - started, unchanged: true }]);
}
function categoryV3RuntimeRequest_(snapshot, action, id) {
  var token = PropertiesService.getScriptProperties().getProperty('AI4S_REGISTRY_ACCESS_TOKEN');
  if (!token) throw new Error('Existing registry token is missing');
  var output = doGet({ parameter: { token: token, schema: '3', audience: 'preview', action: action,
    id: id || '', registry_revision: snapshot.manifest.registry_revision } });
  var response = JSON.parse(output.getContent());
  if (response.ok !== true) throw new Error('Internal registry API check failed for ' + action);
  return response;
}
function categoryV3RuntimeManifestCheck() { return locked_(function() {
  var before = categoryV3RuntimeBefore_(), started = Date.now(), snapshot = before.context.snapshot;
  var response = categoryV3RuntimeRequest_(snapshot, 'manifest');
  if (V3.stable(response) !== V3.stable(Object.assign({ ok: true }, snapshot.manifest))) throw new Error('Internal manifest differs from the verified snapshot');
  return categoryV3RuntimeFinish_(before, 'manifest', [{ operation: 'manifest', elapsed_ms: Date.now() - started,
    project_count: snapshot.manifest.demos.length, binding_count: snapshot.files.length, unchanged: true }]);
}); }
function categoryV3RuntimeSamplesCheck() { return locked_(function() {
  var before = categoryV3RuntimeBefore_(), snapshot = before.context.snapshot;
  // Exercise dataset-page, cover-image and nested skill-resource mounts with
  // small representative files, keeping this separate from the manifest scan.
  var ids = ['page-battery-curve-shape-explorer-dataset', 'card-battery-curve-shape-explorer', 'res-tbb-cluster-explorer-2-0'];
  var checks = ids.map(function(id) {
    var file = snapshot.files.find(function(entry) { return entry.id === id; });
    if (!file) throw new Error('Representative source is absent from the verified snapshot');
    var started = Date.now(), action = file.kind === 'page' ? 'page' : 'resource';
    var response = categoryV3RuntimeRequest_(snapshot, action, file.id);
    if (response.id !== file.id || response.registry_instance !== snapshot.manifest.registry_instance
      || response.registry_revision !== snapshot.manifest.registry_revision) throw new Error('Internal API returned mismatched source metadata');
    var bytes = file.kind === 'page' ? Utilities.newBlob(response.html).getBytes() : Utilities.base64Decode(response.base64);
    if (bytes.length !== file.size || hash_(bytes) !== file.sha256) throw new Error('Internal API returned different source bytes');
    return { id: file.id, kind: file.kind, sha256: file.sha256, size: file.size, elapsed_ms: Date.now() - started };
  });
  return categoryV3RuntimeFinish_(before, 'samples', checks);
}); }

/** Flat migration setup and evidence. No Sheet writes or build Hooks. */
var FLAT_V3_CONFIG_FILE_ID = '1_YD5htPe-M52k7ZraYpLPV9fVdt3JxSP';
var FLAT_V3_MIGRATION_ID = 'drive-flat-layout-20261002';
function flatV3Automation_() {
  return {
    auto_publish_target: PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET') || 'off',
    hourly_trigger_count: ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'hourlySandbox'; }).length
  };
}
function flatV3Paused_() {
  var state = flatV3Automation_();
  if (state.auto_publish_target !== 'off' || state.hourly_trigger_count !== 0) throw new Error('Pause sandbox automation before installing flat mounts');
}
function flatV3PreviewState_() {
  var state = previewState_(), safe = {};
  ['phase','revision','request_id','requested_at','attempts','http_status','deploy_id','commit_ref','ready_at'].forEach(function(key) {
    if (state[key] !== undefined && ['string','number','boolean'].includes(typeof state[key])) safe[key] = state[key];
  });
  return safe;
}
function flatV3SaveJson_(name, value) {
  var directory = folder_(DriveApp.getFolderById(SANDBOX.drive_root_id), 'imports');
  return directory.createFile(Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name)).getId();
}
function flatV3ReadAdminJson_(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(id) || id.indexOf('__') === 0) throw new Error('Configure a valid flat migration file ID');
  var file = sourceFile_(id);
  if (sourceParentPath_(file) !== 'imports' || file.getMimeType() !== 'application/json') throw new Error('Flat migration JSON must be in backend imports');
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}
var FLAT_V3_AUTOMATION = 'AIS_FLAT_V3_ORIGINAL_AUTOMATION';
var FLAT_V3_RUNTIME_CHECKS = 'AIS_FLAT_V3_RUNTIME_CHECKS';
function flatBeginV3() { return locked_(function() {
  var ss = sandboxGuard_(), properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty(FLAT_V3_AUTOMATION)) {
    var automation = flatV3Automation_();
    if (!['off','preview'].includes(automation.auto_publish_target) || automation.hourly_trigger_count > 1) throw new Error('Review unexpected automation before flattening');
    properties.setProperty(FLAT_V3_AUTOMATION, JSON.stringify(automation));
  }
  disableSandboxAutomation(); flatV3Paused_();
  var snapshot = checkedSnapshot_('', false), existing = properties.getProperty('AIS_FLAT_V3_BASELINE_FILE');
  if (existing) {
    var prior = flatV3ReadAdminJson_(existing);
    if (prior.migration_id !== FLAT_V3_MIGRATION_ID || prior.snapshot_sha256 !== hash_(V3.stable(snapshot))) throw new Error('Existing flat baseline differs');
    console.log('Flat baseline file: ' + existing); return existing;
  }
  var baseline = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, exported_at: new Date().toISOString(),
    root_id: '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH', develop_sheet_id: ss.getId(), backend_root_id: SANDBOX.drive_root_id,
    snapshot_file_id: properties.getProperty('SANDBOX_SNAPSHOT_FILE'), snapshot_sha256: hash_(V3.stable(snapshot)),
    snapshot: snapshot, mount_config: projectMounts_(), preview_state: flatV3PreviewState_(),
    input_hash: hash_(V3.stable(readInput_(ss))), automation: JSON.parse(properties.getProperty(FLAT_V3_AUTOMATION)) };
  if (baseline.input_hash !== snapshot.input_hash) throw new Error('Sheet changed during flat baseline export');
  var id = flatV3SaveJson_('drive-flat-v3-baseline-20261002.json', baseline);
  properties.setProperty('AIS_FLAT_V3_BASELINE_FILE', id);
  console.log('Flat baseline file: ' + id); return id;
}); }
function flatV3Config_() {
  var config = flatV3ReadAdminJson_(FLAT_V3_CONFIG_FILE_ID);
  if (config.schema !== 1 || config.migration_id !== FLAT_V3_MIGRATION_ID
    || config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'
    || config.develop_sheet_id !== SANDBOX.spreadsheet_id || config.backend_root_id !== SANDBOX.drive_root_id
    || !config.mount_config || config.mount_config.schema !== 3 || config.mount_config.root_id !== config.root_id) throw new Error('Unexpected flat migration configuration');
  validateFlatMounts_(config.mount_config);
  if (Utilities.newBlob(JSON.stringify(config.mount_config)).getBytes().length > 9000) throw new Error('Flat mount configuration exceeds the property size budget');
  var baselineId = PropertiesService.getScriptProperties().getProperty('AIS_FLAT_V3_BASELINE_FILE');
  if (!baselineId || config.baseline_file_id !== baselineId) throw new Error('Flat configuration does not reference the exported baseline');
  return config;
}
function flatV3SaveVerification_(report) {
  var fileId = flatV3SaveJson_('drive-flat-v3-verification-20261002-' + Date.now() + '.json', report);
  console.log('Flat bindings PASS; revision ' + report.registry_revision + '; ' + report.binding_count + ' bindings; ' + report.unique_file_count + ' files; report ' + fileId);
  return fileId;
}
function flatResumeV3() { return locked_(function() {
  var properties = PropertiesService.getScriptProperties(), resumed = properties.getProperty('AIS_FLAT_V3_RESUMED');
  if (resumed) {
    var previous = JSON.parse(resumed);
    if (V3.stable(previous.automation) !== V3.stable(flatV3Automation_())) throw new Error('Restored automation has changed; review it manually');
    console.log('Flat preview automation already restored'); return previous;
  }
  var context = flatV3RuntimeContext_(), saved = JSON.parse(properties.getProperty(FLAT_V3_RUNTIME_CHECKS) || '{}');
  if (saved.context_hash !== context.hash || !saved.checks) throw new Error('Complete all flat runtime checks before restoring automation');
  ['sync','manifest','samples'].forEach(function(operation) {
    var proof = saved.checks[operation];
    if (!proof) throw new Error('Missing flat runtime check: ' + operation);
    var report = flatV3ReadAdminJson_(proof.file_id);
    if (hash_(V3.stable(report)) !== proof.sha256 || report.result !== 'PASS'
      || report.context_hash !== context.hash || report.operation !== operation) throw new Error('Flat runtime report changed');
  });
  var original = JSON.parse(properties.getProperty(FLAT_V3_AUTOMATION) || 'null');
  if (!original || V3.stable(original) !== V3.stable(context.baseline.automation)
    || !['off','preview'].includes(original.auto_publish_target)
    || ![0,1].includes(original.hourly_trigger_count)) throw new Error('Invalid original preview automation');
  if (original.auto_publish_target === 'preview') {
    var state = previewState_();
    if (state.phase !== 'ready' || state.revision !== context.binding.registry_revision) throw new Error('Existing preview is not ready for the verified revision');
  }
  if (original.hourly_trigger_count === 1) ScriptApp.newTrigger('hourlySandbox').timeBased().everyHours(1).create();
  properties.setProperty('AI4S_AUTO_PUBLISH_TARGET', original.auto_publish_target);
  var record = { context_hash: context.hash, resumed_at: new Date().toISOString(), automation: flatV3Automation_() };
  if (V3.stable(record.automation) !== V3.stable(original)) throw new Error('Preview automation restoration did not match the baseline');
  properties.setProperty('AIS_FLAT_V3_RESUMED', JSON.stringify(record));
  console.log('Flat preview automation restored; target ' + original.auto_publish_target + '; hourly triggers ' + original.hourly_trigger_count);
  return record;
}); }

/** Bounded flat verification. Each operation fits a separate Apps Script run. */
var FLAT_V3_VERIFY_PROGRESS = 'AIS_FLAT_V3_VERIFY_PROGRESS';
var FLAT_V3_VERIFY_CHUNK_SIZE = 12;
function flatV3BatchContext_(ss, install) {
  flatV3Paused_();
  var config = flatV3Config_(), properties = PropertiesService.getScriptProperties();
  var baseline = flatV3ReadAdminJson_(config.baseline_file_id);
  if (baseline.schema !== 1 || baseline.migration_id !== FLAT_V3_MIGRATION_ID
    || baseline.root_id !== config.root_id || baseline.develop_sheet_id !== SANDBOX.spreadsheet_id
    || baseline.backend_root_id !== SANDBOX.drive_root_id || !baseline.snapshot
    || !Array.isArray(baseline.snapshot.files) || !baseline.snapshot.files.length
    || baseline.snapshot_sha256 !== hash_(V3.stable(baseline.snapshot))) throw new Error('Invalid flat baseline');
  var snapshot = currentSnapshot_(), inputHash = hash_(V3.stable(readInput_(ss)));
  if (properties.getProperty('SANDBOX_SNAPSHOT_FILE') !== baseline.snapshot_file_id
    || hash_(V3.stable(snapshot)) !== baseline.snapshot_sha256 || inputHash !== baseline.input_hash
    || inputHash !== snapshot.input_hash) throw new Error('Snapshot or Sheet input changed since baseline export');
  var installed = projectMounts_();
  if (V3.stable(installed) !== V3.stable(config.mount_config)) {
    if (!install || V3.stable(installed) !== V3.stable(baseline.mount_config)) throw new Error('Installed flat mounts differ from the approved configuration');
    properties.setProperty('AIS_PROJECT_MOUNTS_V1', JSON.stringify(config.mount_config));
  }
  var binding = { migration_id: FLAT_V3_MIGRATION_ID, baseline_file_id: config.baseline_file_id,
    config_file_id: FLAT_V3_CONFIG_FILE_ID, config_sha256: hash_(V3.stable(config)),
    baseline_sha256: hash_(V3.stable(baseline)), snapshot_file_id: baseline.snapshot_file_id,
    snapshot_sha256: baseline.snapshot_sha256, input_hash: inputHash,
    mount_config_sha256: hash_(V3.stable(config.mount_config)),
    registry_revision: snapshot.manifest.registry_revision, binding_count: snapshot.files.length };
  return { config: config, baseline: baseline, snapshot: snapshot, binding: binding, hash: hash_(V3.stable(binding)) };
}
function flatV3BatchProgress_(context) {
  var raw = PropertiesService.getScriptProperties().getProperty(FLAT_V3_VERIFY_PROGRESS);
  if (!raw) throw new Error('Run flatBeginV3Verification first');
  var progress = JSON.parse(raw);
  if (progress.schema !== 1 || progress.context_hash !== context.hash
    || V3.stable(progress.binding) !== V3.stable(context.binding)
    || !['hashing','complete'].includes(progress.phase)
    || !Number.isInteger(progress.next_index) || progress.next_index < 0
    || progress.next_index > context.snapshot.files.length || !Array.isArray(progress.chunks)) throw new Error('Flat verification context or progress changed');
  var cursor = 0;
  progress.chunks.forEach(function(chunk) {
    if (chunk.start !== cursor || !Number.isInteger(chunk.end) || chunk.end <= cursor
      || chunk.end > Math.min(cursor + FLAT_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length)
      || typeof chunk.file_id !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Invalid flat verification chunk index');
    cursor = chunk.end;
  });
  if (cursor !== progress.next_index) throw new Error('Incomplete flat verification progress');
  return progress;
}
function flatV3WriteProgress_(progress) {
  var text = JSON.stringify(progress);
  if (text.length >= 8500) throw new Error('Flat verification progress exceeds the bounded property size');
  PropertiesService.getScriptProperties().setProperty(FLAT_V3_VERIFY_PROGRESS, text);
}
function flatBeginV3Verification() { return locked_(function() {
  var context = flatV3BatchContext_(sandboxGuard_(), true);
  var properties = PropertiesService.getScriptProperties(), progress;
  if (properties.getProperty(FLAT_V3_VERIFY_PROGRESS)) progress = flatV3BatchProgress_(context);
  else {
    progress = { schema: 1, context_hash: context.hash, binding: context.binding,
      phase: 'hashing', next_index: 0, chunks: [] };
    flatV3WriteProgress_(progress);
  }
  console.log('Flat verification ' + progress.phase + '; verified ' + progress.next_index + '/' + context.snapshot.files.length + ' bindings');
  return { phase: progress.phase, verified: progress.next_index, total: context.snapshot.files.length };
}); }
function flatV3VerifiedFile_(expected, actual) {
  ['file_id','parent_path','sha256','size','mime_type','modified_at'].forEach(function(key) {
    if (actual[key] !== expected[key]) throw new Error('Flat source binding changed: ' + expected.id + ' (' + key + ')');
  });
  return { id: expected.id, file_id: actual.file_id, logical_parent_path: actual.parent_path,
    sha256: actual.sha256, size: actual.size, mime_type: actual.mime_type, modified_at: actual.modified_at };
}
function flatVerifyV3Chunk() { return locked_(function() {
  var ss = sandboxGuard_(), context = flatV3BatchContext_(ss, false), progress = flatV3BatchProgress_(context);
  var start = progress.next_index, end = Math.min(start + FLAT_V3_VERIFY_CHUNK_SIZE, context.snapshot.files.length);
  if (progress.phase === 'complete' || start === end) {
    console.log('All source hashes verified; phase ' + progress.phase + '; use flatFinalizeV3Verification');
    return { phase: progress.phase, verified: start, total: context.snapshot.files.length };
  }
  var observed = {}, files = context.snapshot.files.slice(start, end).map(function(expected) {
    var actual = observed[expected.file_id] || (observed[expected.file_id] = source_(expected.file_id));
    return flatV3VerifiedFile_(expected, actual);
  });
  if (flatV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Flat verification context changed during chunk');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, context_hash: context.hash,
    verified_at: new Date().toISOString(), start: start, end: end, files: files };
  var fileId = flatV3SaveJson_('drive-flat-v3-chunk-' + start + '-' + end + '-' + Date.now() + '.json', report);
  // A failed or timed-out chunk never advances the cursor without saved proof.
  progress.chunks.push({ start: start, end: end, file_id: fileId, sha256: hash_(V3.stable(report)) });
  progress.next_index = end;
  flatV3WriteProgress_(progress);
  console.log('Flat hashes verified ' + end + '/' + context.snapshot.files.length + '; chunk ' + fileId);
  return { phase: progress.phase, verified: end, total: context.snapshot.files.length };
}); }
function flatFinalizeV3Verification() { return locked_(function() {
  var ss = sandboxGuard_(), context = flatV3BatchContext_(ss, false), progress = flatV3BatchProgress_(context);
  if (progress.phase === 'complete') {
    console.log('Flat verification already complete; report ' + progress.report_file_id); return progress.report_file_id;
  }
  if (progress.next_index !== context.snapshot.files.length) throw new Error('Verify every source chunk before finalizing');
  var files = [], uniqueFiles = {};
  progress.chunks.forEach(function(chunk) {
    var saved = flatV3ReadAdminJson_(chunk.file_id);
    if (hash_(V3.stable(saved)) !== chunk.sha256 || saved.schema !== 1
      || saved.migration_id !== FLAT_V3_MIGRATION_ID || saved.context_hash !== context.hash
      || saved.start !== chunk.start || saved.end !== chunk.end || !Array.isArray(saved.files)
      || saved.files.length !== chunk.end - chunk.start) throw new Error('Flat chunk proof changed or is incomplete');
    saved.files.forEach(function(actual, offset) {
      var expected = context.snapshot.files[chunk.start + offset];
      if (actual.id !== expected.id) throw new Error('Flat chunk contains the wrong logical identity');
      var checked = flatV3VerifiedFile_(expected, { file_id: actual.file_id,
        parent_path: actual.logical_parent_path, sha256: actual.sha256, size: actual.size,
        mime_type: actual.mime_type, modified_at: actual.modified_at });
      uniqueFiles[actual.file_id] = true; files.push(checked);
    });
  });
  if (files.length !== context.snapshot.files.length) throw new Error('Flat source coverage is incomplete');
  context.snapshot.files.forEach(assertStamp_);
  if (flatV3BatchContext_(ss, false).hash !== context.hash) throw new Error('Flat verification context changed during finalization');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, verified_at: new Date().toISOString(),
    result: 'PASS', registry_revision: context.binding.registry_revision,
    project_count: context.snapshot.manifest.demos.length, binding_count: files.length,
    unique_file_count: Object.keys(uniqueFiles).length, baseline_file_id: context.config.baseline_file_id,
    config_file_id: FLAT_V3_CONFIG_FILE_ID, snapshot_file_id: context.binding.snapshot_file_id,
    input_hash: context.binding.input_hash, snapshot_sha256: context.binding.snapshot_sha256,
    mount_config_sha256: context.binding.mount_config_sha256, files: files,
    chunk_reports: progress.chunks, preview_state: flatV3PreviewState_(), automation: flatV3Automation_() };
  var fileId = flatV3SaveVerification_(report);
  progress.phase = 'complete'; progress.report_file_id = fileId;
  flatV3WriteProgress_(progress);
  return fileId;
}); }


/** Editor-only post-migration checks. Run each public function separately.
 * These call the existing authenticated doGet implementation internally; they
 * do not add a public endpoint or prove the deployed HTTP transport or ACLs. */
function flatV3RuntimeContext_() {
  var context = flatV3BatchContext_(sandboxGuard_(), false);
  if (flatV3BatchProgress_(context).phase !== 'complete') throw new Error('Complete bounded source verification before checking runtime');
  return context;
}
function flatV3RuntimeBefore_() {
  return { context: flatV3RuntimeContext_(), preview_state: PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE'), started: Date.now() };
}
function flatV3RuntimeFinish_(before, operation, checks) {
  var after = flatV3RuntimeContext_();
  if (after.hash !== before.context.hash || PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE') !== before.preview_state) throw new Error('Runtime check changed the snapshot, input or preview state');
  var report = { schema: 1, migration_id: FLAT_V3_MIGRATION_ID, result: 'PASS',
    operation: operation, scope: 'editor-runtime-only', registry_revision: after.binding.registry_revision,
    context_hash: after.hash, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - before.started, checks: checks };
  var id = flatV3SaveJson_('drive-flat-v3-runtime-' + operation + '-' + Date.now() + '.json', report);
  var properties = PropertiesService.getScriptProperties(), saved = JSON.parse(properties.getProperty(FLAT_V3_RUNTIME_CHECKS) || '{}');
  if (saved.context_hash !== after.hash) saved = { context_hash: after.hash, checks: {} };
  saved.checks[operation] = { file_id: id, sha256: hash_(V3.stable(report)) };
  properties.setProperty(FLAT_V3_RUNTIME_CHECKS, JSON.stringify(saved));
  console.log('Flat runtime ' + operation + ' PASS; ' + report.elapsed_ms + ' ms; revision ' + report.registry_revision + '; report ' + id);
  return { result: report.result, operation: operation, elapsed_ms: report.elapsed_ms, report_file_id: id };
}
function flatV3RuntimeCheck() {
  var before = flatV3RuntimeBefore_(), started = Date.now();
  // syncSandbox owns its normal lock; do not wrap it in another locked_ call.
  // Automation remains paused and no publishing function is invoked.
  var manifest = syncSandbox();
  if (V3.stable(manifest) !== V3.stable(before.context.snapshot.manifest)) throw new Error('Normal sync changed the manifest');
  return flatV3RuntimeFinish_(before, 'sync', [{ operation: 'syncSandbox', elapsed_ms: Date.now() - started, unchanged: true }]);
}
function flatV3RuntimeRequest_(snapshot, action, id) {
  var token = PropertiesService.getScriptProperties().getProperty('AI4S_REGISTRY_ACCESS_TOKEN');
  if (!token) throw new Error('Existing registry token is missing');
  var output = doGet({ parameter: { token: token, schema: '3', audience: 'preview', action: action,
    id: id || '', registry_revision: snapshot.manifest.registry_revision } });
  var response = JSON.parse(output.getContent());
  if (response.ok !== true) throw new Error('Internal registry API check failed for ' + action);
  return response;
}
function flatV3RuntimeManifestCheck() { return locked_(function() {
  var before = flatV3RuntimeBefore_(), started = Date.now(), snapshot = before.context.snapshot;
  var response = flatV3RuntimeRequest_(snapshot, 'manifest');
  if (V3.stable(response) !== V3.stable(Object.assign({ ok: true }, snapshot.manifest))) throw new Error('Internal manifest differs from the verified snapshot');
  return flatV3RuntimeFinish_(before, 'manifest', [{ operation: 'manifest', elapsed_ms: Date.now() - started,
    project_count: snapshot.manifest.demos.length, binding_count: snapshot.files.length, unchanged: true }]);
}); }
function flatV3RuntimeSamplesCheck() { return locked_(function() {
  var before = flatV3RuntimeBefore_(), snapshot = before.context.snapshot;
  // Exercise dataset-page, cover-image and nested skill-resource mounts with
  // small representative files, keeping this separate from the manifest scan.
  var ids = ['page-battery-curve-shape-explorer-dataset', 'card-battery-curve-shape-explorer', 'res-tbb-cluster-explorer-2-0'];
  var checks = ids.map(function(id) {
    var file = snapshot.files.find(function(entry) { return entry.id === id; });
    if (!file) throw new Error('Representative source is absent from the verified snapshot');
    var started = Date.now(), action = file.kind === 'page' ? 'page' : 'resource';
    var response = flatV3RuntimeRequest_(snapshot, action, file.id);
    if (response.id !== file.id || response.registry_instance !== snapshot.manifest.registry_instance
      || response.registry_revision !== snapshot.manifest.registry_revision) throw new Error('Internal API returned mismatched source metadata');
    var bytes = file.kind === 'page' ? Utilities.newBlob(response.html).getBytes() : Utilities.base64Decode(response.base64);
    if (bytes.length !== file.size || hash_(bytes) !== file.sha256) throw new Error('Internal API returned different source bytes');
    return { id: file.id, kind: file.kind, sha256: file.sha256, size: file.size, elapsed_ms: Date.now() - started };
  });
  return flatV3RuntimeFinish_(before, 'samples', checks);
}); }
