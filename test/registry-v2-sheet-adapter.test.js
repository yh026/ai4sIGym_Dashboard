'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../fixtures/registry-v2-current-21.json');
const {
  HUMAN_PROJECT_HEADERS,
  toRegistryV2,
} = require('../lib/registry-v2');
const {
  PROJECTS_SHEET_COLUMNS,
  PROJECTS_SHEET_HEADERS,
  RegistryV2SheetAdapterError,
  SHEET_HEADERS,
  adaptRegistryV2Sheet,
  assetsToSheetRows,
  compileRegistryV2Sheet,
  configToSheetRows,
  facetsToSheetRows,
  projectsRowsToProjects,
  projectsToSheetRows,
  registryToSheetRows,
  taxonomyToSheetRows,
} = require('../lib/registry-v2-sheet-adapter');

function makeTwentyProjectSnapshot() {
  const data = structuredClone(fixture);
  const projects = data.projects.filter(project => project.row_number !== 2);
  const registry = data.sourceProjections;
  const identities = registry.filter(item => item.entry_type === 'project');
  return {
    Projects: projectsToSheetRows(projects, identities),
    _Registry: registryToSheetRows(registry),
    _Taxonomy: taxonomyToSheetRows(data.taxonomy),
    _Facets: facetsToSheetRows(data.facets),
    _Assets: assetsToSheetRows(data.assets),
    _Config: configToSheetRows({
      registry_schema_version: 2,
      site_title: 'AI for Science Interactive Gym',
      site_tagline: 'Explore scientific ideas through interactive demos.',
      preview_base_url: 'https://develop--aisigym.netlify.app/',
    }),
  };
}

function adapterErrorCodes(error) {
  return error.errors.map(item => item.code);
}

function removeColumn(rows, header) {
  const index = rows[0].indexOf(header);
  assert.notEqual(index, -1, `test setup: ${header} header exists`);
  rows.forEach(row => row.splice(index, 1));
}

test('Projects exposes fifteen Chinese-labelled fields and one hidden identity field', () => {
  assert.equal(HUMAN_PROJECT_HEADERS.length, 15);
  assert.equal(PROJECTS_SHEET_COLUMNS.length, 16);
  assert.deepEqual(PROJECTS_SHEET_HEADERS, [
    '状态', '发布检查', '预览', '项目标题', '卡片摘要', '部门', '子主题', '任务类型', '方法', '卡片图片',
    '图片说明', '受众', '精选', '数据来源', '公开许可', 'demo_id',
  ]);
  assert.equal(PROJECTS_SHEET_COLUMNS.at(-1).hidden, true);
  assert.equal(PROJECTS_SHEET_COLUMNS.at(-1).editable, false);
  assert.equal(PROJECTS_SHEET_COLUMNS.slice(0, -1).every(column => !column.hidden), true);

  const decodedChinese = projectsRowsToProjects(makeTwentyProjectSnapshot().Projects);
  assert.equal(decodedChinese.projects.length, 20);
  assert.equal(decodedChinese.identities[0].demo_id, 'demo-soh-battery');

  const englishHeaders = makeTwentyProjectSnapshot().Projects;
  englishHeaders[0] = [...HUMAN_PROJECT_HEADERS, 'demo_id'];
  const decodedEnglish = projectsRowsToProjects(englishHeaders);
  assert.deepEqual(decodedEnglish.projects[0], decodedChinese.projects[0]);
});

test('the shadow 20-project subset compiles while site metadata lives only in _Config', () => {
  const snapshot = makeTwentyProjectSnapshot();
  const result = compileRegistryV2Sheet(snapshot);

  assert.equal(result.compiled.ok, true);
  assert.equal(result.compiled.demos.length, 20);
  assert.equal(result.compiled.demos.some(demo => demo.entry_type === 'site'), false);
  assert.deepEqual(result.siteMetadata, {
    title: 'AI for Science Interactive Gym',
    tagline: 'Explore scientific ideas through interactive demos.',
  });
  assert.equal(result.compilerInput.projects.some(project => project.site_title), false);
  assert.equal(toRegistryV2(result.compiled).demos.length, 15);
  assert.deepEqual(result.hiddenSheetRows._Registry[0], SHEET_HEADERS._Registry);
  assert.equal(result.hiddenSheetRows._Registry.length, 21);
  assert.deepEqual(result.hiddenSheetRows._Taxonomy[0], SHEET_HEADERS._Taxonomy);
  assert.deepEqual(result.hiddenSheetRows._Facets[0], SHEET_HEADERS._Facets);
  assert.deepEqual(result.hiddenSheetRows._Assets[0], SHEET_HEADERS._Assets);
});

test('row sorting keeps title, slug and Drive state joined by hidden demo_id', () => {
  const snapshot = makeTwentyProjectSnapshot();
  snapshot.Projects = [snapshot.Projects[0], ...snapshot.Projects.slice(1).reverse()];

  // _Registry retains its old row_number values. The adapter must ignore those
  // positions and use the identity that travelled with each sorted row.
  const result = compileRegistryV2Sheet(snapshot);
  const firstIdentity = result.compilerInput.sourceProjections[0];
  const firstProject = result.compilerInput.projects[0];
  const compiled = result.compiled.demos.find(demo => demo.demo_id === firstIdentity.demo_id);

  assert.equal(firstIdentity.row_number, 2);
  assert.equal(firstIdentity.demo_id, 'demo-archived-b');
  assert.equal(compiled.title, firstProject.title);
  assert.equal(compiled.slug, 'archived-migration-b');
  assert.equal(compiled.file_check, 'missing');
  assert.equal(result.compiled.ok, true);
});

test('taxonomy, registry, facet and asset grids convert to compiler rows explicitly', () => {
  const snapshot = makeTwentyProjectSnapshot();
  const adapted = adaptRegistryV2Sheet(snapshot);

  assert.deepEqual(snapshot._Registry[0], SHEET_HEADERS._Registry);
  assert.deepEqual(snapshot._Taxonomy[0], SHEET_HEADERS._Taxonomy);
  assert.deepEqual(snapshot._Facets[0], SHEET_HEADERS._Facets);
  assert.deepEqual(snapshot._Assets[0], SHEET_HEADERS._Assets);
  assert.equal(adapted.compilerInput.taxonomy.departments.length, fixture.taxonomy.departments.length);
  assert.equal(adapted.compilerInput.taxonomy.subtopics[0].department_id, 'chemistry');
  assert.deepEqual(
    adapted.compilerInput.facets.find(item => item.demo_id === 'demo-singapore-road-speed'),
    fixture.facets.find(item => item.demo_id === 'demo-singapore-road-speed'),
  );
  assert.equal(adapted.compilerInput.assets[0].mime_type, 'image/jpeg');
  assert.equal(adapted.compilerInput.assets[0].checksum, '');
});

test('derived write-back patches touch only readiness and preview_url with a demo_id guard', () => {
  const snapshot = makeTwentyProjectSnapshot();
  const result = compileRegistryV2Sheet(snapshot);
  assert.equal(result.writebackPatches.length, 20);

  const readyDraft = result.writebackPatches.find(item => item.demo_id === 'demo-draft-a');
  assert.deepEqual(readyDraft.identity_guard, {
    range: "'Projects'!P16",
    expected_value: 'demo-draft-a',
  });
  assert.deepEqual(readyDraft.writes.map(write => write.field_key), ['readiness', 'preview_url']);
  assert.equal(readyDraft.writes[0].range, "'Projects'!B16");
  assert.equal(readyDraft.writes[0].value, '✅ 可预览');
  assert.equal(
    readyDraft.writes[1].value,
    'https://develop--aisigym.netlify.app/demos/draft-preview-a/',
  );

  const blockedDraft = result.writebackPatches.find(item => item.demo_id === 'demo-draft-b');
  assert.match(blockedDraft.writes[0].value, /^⛔ /);
  assert.equal(blockedDraft.writes[1].value, '');
});

test('missing or duplicate hidden identities fail structurally before compilation', async t => {
  await t.test('missing demo_id in Projects', () => {
    const snapshot = makeTwentyProjectSnapshot();
    snapshot.Projects[1][15] = '';
    assert.throws(
      () => adaptRegistryV2Sheet(snapshot),
      error => error instanceof RegistryV2SheetAdapterError
        && adapterErrorCodes(error).includes('project_demo_id_missing'),
    );
  });

  await t.test('duplicate demo_id in Projects', () => {
    const snapshot = makeTwentyProjectSnapshot();
    snapshot.Projects[2][15] = snapshot.Projects[1][15];
    assert.throws(
      () => adaptRegistryV2Sheet(snapshot),
      error => error instanceof RegistryV2SheetAdapterError
        && adapterErrorCodes(error).includes('project_demo_id_duplicate'),
    );
  });

  await t.test('missing _Registry source projection', () => {
    const snapshot = makeTwentyProjectSnapshot();
    const demoIdColumn = snapshot._Registry[0].indexOf('demo_id');
    snapshot._Registry = snapshot._Registry.filter(
      (row, index) => index === 0 || row[demoIdColumn] !== 'demo-soh-battery',
    );
    assert.throws(
      () => adaptRegistryV2Sheet(snapshot),
      error => error instanceof RegistryV2SheetAdapterError
        && adapterErrorCodes(error).includes('registry_projection_missing'),
    );
  });
});

test('every canonical machine header is required and unknown schema columns fail closed', async t => {
  const cases = [
    ['_Registry', 'status'],
    ['_Taxonomy', 'active'],
    ['_Facets', 'display_order'],
    ['_Assets', 'alt_text'],
    ['_Config', 'visibility'],
  ];

  for (const [sheetName, header] of cases) {
    await t.test(`${sheetName}.${header} cannot be deleted`, () => {
      const snapshot = makeTwentyProjectSnapshot();
      removeColumn(snapshot[sheetName], header);
      assert.throws(
        () => adaptRegistryV2Sheet(snapshot),
        error => error instanceof RegistryV2SheetAdapterError
          && adapterErrorCodes(error).includes('machine_header_missing'),
      );
    });
  }

  await t.test('extra machine columns are rejected instead of silently ignored', () => {
    const snapshot = makeTwentyProjectSnapshot();
    snapshot._Taxonomy[0].push('active_override');
    snapshot._Taxonomy.slice(1).forEach(row => row.push(true));
    assert.throws(
      () => adaptRegistryV2Sheet(snapshot),
      error => error instanceof RegistryV2SheetAdapterError
        && adapterErrorCodes(error).includes('machine_header_unknown'),
    );
  });
});

test('_Taxonomy active cells must contain an explicit valid boolean', async t => {
  const activeIndex = SHEET_HEADERS._Taxonomy.indexOf('active');
  assert.notEqual(activeIndex, -1);

  for (const value of ['', 'inherit', null]) {
    await t.test(`active=${String(value)} fails closed`, () => {
      const snapshot = makeTwentyProjectSnapshot();
      snapshot._Taxonomy[1][activeIndex] = value;
      assert.throws(
        () => adaptRegistryV2Sheet(snapshot),
        error => error instanceof RegistryV2SheetAdapterError
          && adapterErrorCodes(error).includes('taxonomy_active_invalid'),
      );
    });
  }

  await t.test('explicit false remains false and is never defaulted to active', () => {
    const snapshot = makeTwentyProjectSnapshot();
    snapshot._Taxonomy[1][activeIndex] = false;
    const adapted = adaptRegistryV2Sheet(snapshot);
    assert.equal(adapted.compilerInput.taxonomy.departments[0].active, false);
  });
});
