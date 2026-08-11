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
  column('status', '状态', FIELD_OWNERS.EDITOR, true),
  column('readiness', '发布检查', FIELD_OWNERS.DERIVED, false),
  column('preview_url', '预览', FIELD_OWNERS.DERIVED, false),
  column('title', '项目标题', FIELD_OWNERS.EDITOR, true),
  column('card_summary', '卡片摘要', FIELD_OWNERS.EDITOR, true),
  column('department', '部门', FIELD_OWNERS.EDITOR, true),
  column('subtopic', '子主题', FIELD_OWNERS.EDITOR, true),
  column('task', '任务类型', FIELD_OWNERS.EDITOR, true),
  column('methods', '方法', FIELD_OWNERS.EDITOR, true),
  column('card_image', '卡片图片', FIELD_OWNERS.EDITOR, true),
  column('image_alt', '图片说明', FIELD_OWNERS.EDITOR, true),
  column('audience', '受众', FIELD_OWNERS.EDITOR, true),
  column('featured', '精选', FIELD_OWNERS.EDITOR, true),
  column('data_source', '数据来源', FIELD_OWNERS.PROVENANCE_IMPORT, false),
  // Publication permission is a human approval. Drive/provenance automation
  // may suggest "Preview only", but it must never grant Public by itself.
  column('public_permission', '公开许可', FIELD_OWNERS.EDITOR, true),
]);

const HUMAN_PROJECT_HEADERS = Object.freeze(HUMAN_PROJECT_COLUMNS.map(item => item.key));

const HIDDEN_SHEET_HEADERS = deepFreeze({
  _Registry: [
    'schema_version', 'row_number', 'demo_id', 'entry_type', 'slug', 'status',
    'readiness', 'featured', 'sort_order', 'title', 'card_summary',
    'department_id', 'subtopic_id', 'task_ids', 'method_ids', 'audience',
    'data_source_label', 'public_page_permission', 'card_asset_id', 'file_id',
    'file_check', 'date_added',
  ],
  _Taxonomy: [
    'term_type', 'term_id', 'parent_id', 'label', 'short_label', 'description',
    'display_order', 'active', 'theme_key', 'icon_key', 'aliases',
  ],
  _Facets: ['demo_id', 'facet_type', 'term_id', 'display_order'],
  _Assets: [
    'asset_id', 'demo_id', 'role', 'source_type', 'drive_file_id',
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
    data_source_label: FIELD_OWNERS.PROVENANCE_IMPORT,
    public_page_permission: FIELD_OWNERS.EDITOR,
  }),
  _Taxonomy: owners(HIDDEN_SHEET_HEADERS._Taxonomy, FIELD_OWNERS.EDITOR),
  _Facets: owners(HIDDEN_SHEET_HEADERS._Facets, FIELD_OWNERS.DERIVED),
  _Assets: owners(HIDDEN_SHEET_HEADERS._Assets, FIELD_OWNERS.DERIVED, {
    drive_file_id: FIELD_OWNERS.DRIVE_SYNC,
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
  'file_check', 'date_added',
]);

const TAXONOMY_FIELDS = deepFreeze({
  departments: [
    'id', 'label', 'short_label', 'description', 'display_order', 'active',
    'theme_key', 'icon_key',
  ],
  subtopics: ['id', 'department_id', 'label', 'display_order', 'active'],
  tasks: ['id', 'label', 'active'],
  methods: ['id', 'label', 'active'],
});

const REGISTRY_V2_DEMO_FIELDS = Object.freeze([
  'demo_id', 'entry_type', 'slug', 'status', 'featured', 'sort_order', 'title',
  'card_summary', 'department_id', 'subtopic_id', 'task_ids', 'method_ids',
  'audience', 'data_source_label', 'public_page_permission', 'card_asset',
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
const VALID_FACET_TYPES = new Set(['task', 'method']);
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
 * `projects` contains only the 15 visible human columns. The Sheet adapter may
 * attach a transient `row_number`; the physical Sheet also has a hidden
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

  const taxonomyResult = normalizeTaxonomy(source.taxonomy, errors);
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
      _Registry: buildRegistryRows(demos, readiness),
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

function normalizeTaxonomy(rawTaxonomy, errors) {
  const raw = rawTaxonomy && typeof rawTaxonomy === 'object' ? rawTaxonomy : {};
  const definitions = {
    departments: normalizeTerms('departments', raw.departments, TAXONOMY_FIELDS.departments, errors),
    subtopics: normalizeTerms('subtopics', raw.subtopics, TAXONOMY_FIELDS.subtopics, errors),
    tasks: normalizeTerms('tasks', raw.tasks, TAXONOMY_FIELDS.tasks, errors),
    methods: normalizeTerms('methods', raw.methods, TAXONOMY_FIELDS.methods, errors),
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
    }),
    ...definitions,
  };
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
    const terms = facetType === 'task' ? taxonomyResult.tasks : taxonomyResult.methods;
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
    } else if (normalised.source_type === 'external' && !hasExternal) {
      addError(errors, 'asset_source_type_mismatch', `External asset ${normalised.asset_id} has no external_url.`, {
        asset_id: normalised.asset_id,
      });
    } else if (!['drive', 'external'].includes(normalised.source_type)) {
      addError(errors, 'asset_source_type_invalid', `Asset ${normalised.asset_id} has invalid source_type.`, {
        asset_id: normalised.asset_id,
      });
    }
    if (hasExternal && !isSafeHttpsUrl(normalised.external_url)) {
      addError(errors, 'asset_external_url_invalid', `Asset ${normalised.asset_id} must use an HTTPS external URL.`, {
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
  return selected;
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
    return selected === asset.drive_file_id || selected.includes(asset.drive_file_id);
  }
  return false;
}

function allowlistedTaxonomy(raw) {
  const taxonomy = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const group of ['departments', 'subtopics', 'tasks', 'methods']) {
    result[group] = asArray(taxonomy[group]).map(item => pick(item, TAXONOMY_FIELDS[group]));
  }
  return result;
}

function allowlistedDemo(raw) {
  const demo = pick(raw, REGISTRY_V2_DEMO_FIELDS);
  demo.task_ids = asArray(demo.task_ids).map(clean).filter(Boolean);
  demo.method_ids = asArray(demo.method_ids).map(clean).filter(Boolean);
  demo.card_asset = demo.card_asset
    ? pick(demo.card_asset, REGISTRY_V2_CARD_ASSET_FIELDS)
    : null;
  return demo;
}

function buildRegistryRows(demos, readiness) {
  const readinessById = new Map(readiness.map(item => [item.demo_id, item]));
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
    audience: demo.audience,
    data_source_label: demo.data_source_label,
    public_page_permission: demo.public_page_permission,
    card_asset_id: demo.card_asset ? demo.card_asset.asset_id : '',
    file_id: demo.file_id,
    file_check: demo.file_check,
    date_added: demo.date_added,
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
  if (value === true) return 'Public';
  if (value === false) return 'Private';
  const key = clean(value).toLowerCase();
  if (['public', 'yes', 'y', 'true', 'allow', 'allowed', 'approved', '是', '允许', '可公开'].includes(key)) {
    return 'Public';
  }
  if (['preview only', 'preview-only', 'preview', 'pending', 'review', '待确认', '仅预览'].includes(key)) {
    return 'Preview only';
  }
  if (['private', 'no', 'n', 'false', 'deny', 'denied', '否', '不允许', '不可公开'].includes(key)) {
    return 'Private';
  }
  return 'Private';
}

function isHealthyFileCheck(value) {
  const text = clean(value).toLowerCase();
  if (!/^ok(?:\b|\s|[-—:])/.test(text)) return false;
  return !/(page\s+unreadable|page\s+empty|missing|unreadable|empty\s+page)/.test(text);
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
  return text.split(/[,，;；|\n]+/).map(clean).filter(Boolean);
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
  const key = clean(value).toLowerCase();
  if (['true', 'yes', 'y', '1', '是', '✓'].includes(key)) {
    return { value: true, valid: true };
  }
  if (['false', 'no', 'n', '0', '否', '✗'].includes(key)) {
    return { value: false, valid: true };
  }
  return { value: false, valid: false };
}

function toBoolean(value) {
  if (value === true || value === false) return value;
  return ['true', 'yes', 'y', '1', '是', '✓'].includes(clean(value).toLowerCase());
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
