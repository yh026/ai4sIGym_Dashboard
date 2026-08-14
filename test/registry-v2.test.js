'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../fixtures/registry-v2-current-21.json');
const {
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
  compileRegistryV2,
  normalizeFeatured,
  normalizePublicPermission,
  toRegistryV2,
} = require('../lib/registry-v2');

function copyFixture() {
  return structuredClone(fixture);
}

function findProject(data, rowNumber) {
  return data.projects.find(project => project.row_number === rowNumber);
}

function errorCodes(compiled) {
  return compiled.errors.map(error => error.code);
}

test('the human Projects sheet stays at exactly fifteen simple columns', () => {
  assert.deepEqual(HUMAN_PROJECT_HEADERS, [
    'status', 'readiness', 'preview_url', 'title', 'card_summary',
    'department', 'subtopic', 'task', 'methods', 'card_image', 'image_alt',
    'audience', 'featured', 'data_source', 'public_permission',
  ]);
  assert.equal(HUMAN_PROJECT_COLUMNS.length, 15);
  assert.equal(new Set(HUMAN_PROJECT_HEADERS).size, 15);
  assert.equal(HUMAN_PROJECT_HEADERS.includes('demo_id'), false);
  assert.equal(HUMAN_PROJECT_HEADERS.includes('question'), false);
  assert.deepEqual(HUMAN_PROJECT_COLUMNS.map(column => column.label), [
    'Status', 'Readiness', 'Preview URL', 'Project Title', 'Card Summary',
    'Department', 'Subtopic', 'Task Type', 'Methods', 'Card Image',
    'Image Alt Text', 'Audience', 'Featured', 'Data Source',
    'Public Permission',
  ]);
  assert.equal(
    HUMAN_PROJECT_COLUMNS.some(column => /\p{Script=Han}/u.test(column.label)),
    false,
  );

  const byKey = Object.fromEntries(HUMAN_PROJECT_COLUMNS.map(column => [column.key, column]));
  assert.equal(byKey.title.owner, FIELD_OWNERS.EDITOR);
  assert.equal(byKey.title.editable, true);
  assert.equal(byKey.readiness.owner, FIELD_OWNERS.DERIVED);
  assert.equal(byKey.readiness.editable, false);
  assert.equal(byKey.data_source.owner, FIELD_OWNERS.PROVENANCE_IMPORT);
  assert.equal(byKey.data_source.editable, false);
  assert.equal(byKey.public_permission.owner, FIELD_OWNERS.EDITOR);
  assert.equal(byKey.public_permission.editable, true);
});

test('the direct compiler rejects CJK text anywhere in Registry input', () => {
  for (const mutate of [
    data => { findProject(data, 3).title = '\u9879\u76ee'; },
    data => { data.taxonomy.departments[0].label = '\u7269\u7406'; },
    data => { data.sourceProjections[1].file_check = 'ok — \u5df2\u68c0\u67e5'; },
  ]) {
    const data = copyFixture();
    mutate(data);
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('non_english_text'));
    assert.throws(() => toRegistryV2(compiled), RegistryV2ValidationError);
  }
});

test('hidden table headers and ownership are complete and machine-facing', () => {
  assert.deepEqual(Object.keys(HIDDEN_SHEET_HEADERS), [
    '_Registry', '_Taxonomy', '_Facets', '_Assets', '_Audit', '_Config', '_Schema',
  ]);
  for (const [sheetName, headers] of Object.entries(HIDDEN_SHEET_HEADERS)) {
    assert.equal(new Set(headers).size, headers.length, `${sheetName} has duplicate headers`);
    assert.deepEqual(Object.keys(HIDDEN_FIELD_OWNERS[sheetName]), headers);
  }
  assert.equal(HIDDEN_FIELD_OWNERS._Registry.file_id, FIELD_OWNERS.DRIVE_SYNC);
  assert.equal(
    HIDDEN_FIELD_OWNERS._Registry.public_page_permission,
    FIELD_OWNERS.EDITOR,
  );
});

test('the 21-row migration shape keeps one ready Draft and blocks incomplete Drafts locally', () => {
  const compiled = compileRegistryV2(copyFixture());
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.errors, []);
  assert.equal(compiled.schema_version, SCHEMA_VERSION);
  assert.equal(compiled.demos.length, fixture.expected.rows);

  const counts = Object.fromEntries(['Live', 'Draft', 'Archived'].map(status => [
    status.toLowerCase(),
    compiled.demos.filter(demo => demo.status === status).length,
  ]));
  assert.deepEqual(counts, {
    live: fixture.expected.live,
    draft: fixture.expected.draft,
    archived: fixture.expected.archived,
  });
  assert.equal(
    compiled.demos.filter(demo => demo.entry_type === 'site').length,
    fixture.expected.site_records,
  );
  assert.equal(
    compiled.demos.filter(demo => demo.entry_type === 'project' && demo.status === 'Live').length,
    fixture.expected.live_projects,
  );
  assert.equal(
    compiled.readiness.filter(item => item.status === 'blocked').length,
    fixture.expected.blocked_drafts,
  );
  assert.equal(
    compiled.readiness.find(item => item.demo_id === 'demo-draft-a').status,
    'ready',
  );
  assert.equal(
    compiled.readiness.find(item => item.demo_id === 'demo-draft-b').status,
    'blocked',
  );
  assert.equal(
    compiled.readiness.filter(item => (
      item.status === 'ready' && item.demo_id.startsWith('demo-draft-')
    )).length,
    fixture.expected.ready_drafts,
  );
  assert.equal(compiled.hidden._Registry.length, 21);
  assert.deepEqual(
    compiled.taxonomy.departments.map(department => department.theme_key),
    [
      'space-astronomy', 'chemistry-materials', 'biology-genomics',
      'pharmacy-biomedical', 'food-science-technology', 'mathematics',
      'ai-mathematics-data',
    ],
  );
});

test('Registry v2 emits the exact allowlisted contract and never exposes question', () => {
  const data = copyFixture();
  data.projects[1].question = 'This legacy field must not enter a card.';
  data.sourceProjections[1].drive_folder_id = 'private-drive-folder';
  const compiled = compileRegistryV2(data);
  assert.equal(Object.hasOwn(compiled, 'manifest'), false);
  const registry = toRegistryV2(compiled);

  assert.deepEqual(Object.keys(registry), REGISTRY_V2_TOP_LEVEL_FIELDS);
  assert.deepEqual(Object.keys(registry.taxonomy), [
    'departments', 'subtopics', 'tasks', 'methods',
  ]);
  registry.demos.forEach(demo => {
    assert.deepEqual(Object.keys(demo), REGISTRY_V2_DEMO_FIELDS);
    assert.equal(Object.hasOwn(demo, 'question'), false);
    assert.equal(Object.hasOwn(demo, 'drive_folder_id'), false);
  });
  const demoWithImage = registry.demos.find(demo => demo.card_asset);
  assert.deepEqual(Object.keys(demoWithImage.card_asset), REGISTRY_V2_CARD_ASSET_FIELDS);
  assert.deepEqual(PUBLIC_ALLOWLIST.topLevel, REGISTRY_V2_TOP_LEVEL_FIELDS);
  assert.equal(registry.demos.length, 16);
  assert.deepEqual(
    [...new Set(registry.demos.map(demo => demo.status))].sort(),
    ['Draft', 'Live'],
  );
  assert.deepEqual(
    registry.demos.filter(demo => demo.status === 'Draft').map(demo => demo.demo_id),
    ['demo-draft-a'],
  );
  assert.equal(registry.demos.some(demo => demo.status === 'Archived'), false);
});

test('one human Method cell becomes stable multi-method ids and synced _Facets rows', () => {
  const compiled = compileRegistryV2(copyFixture());
  const road = compiled.demos.find(demo => demo.demo_id === 'demo-singapore-road-speed');
  assert.deepEqual(road.method_ids, ['umap', 'k-means']);
  assert.deepEqual(
    compiled.hidden._Facets
      .filter(facet => facet.demo_id === road.demo_id && facet.facet_type === 'method')
      .map(facet => facet.term_id),
    ['umap', 'k-means'],
  );
});

test('stable demo_id and slug do not change when an editor changes the title', () => {
  const before = compileRegistryV2(copyFixture());
  const data = copyFixture();
  findProject(data, 3).title = 'A much better human title';
  const after = compileRegistryV2(data);
  const beforeDemo = before.demos.find(demo => demo.demo_id === 'demo-soh-battery');
  const afterDemo = after.demos.find(demo => demo.demo_id === 'demo-soh-battery');

  assert.equal(after.ok, true);
  assert.equal(afterDemo.demo_id, beforeDemo.demo_id);
  assert.equal(afterDemo.slug, beforeDemo.slug);
  assert.equal(afterDemo.title, 'A much better human title');
});

test('duplicate demo_id and duplicate slug fail the registry closed', async t => {
  await t.test('duplicate demo_id', () => {
    const data = copyFixture();
    data.sourceProjections[2].demo_id = data.sourceProjections[1].demo_id;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('duplicate_demo_id'));
    assert.throws(() => toRegistryV2(compiled), RegistryV2ValidationError);
  });

  await t.test('duplicate slug', () => {
    const data = copyFixture();
    data.sourceProjections[2].slug = data.sourceProjections[1].slug;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.equal(Object.hasOwn(compiled, 'manifest'), false);
    assert.ok(errorCodes(compiled).includes('duplicate_slug'));
    assert.throws(() => toRegistryV2(compiled), RegistryV2ValidationError);
  });
});

test('a subtopic under the wrong department blocks a Live row', () => {
  const data = copyFixture();
  findProject(data, 3).subtopic = 'Astrophysics';
  const compiled = compileRegistryV2(data);
  assert.equal(compiled.ok, false);
  assert.ok(errorCodes(compiled).includes('subtopic_parent_mismatch'));
  assert.equal(
    compiled.readiness.find(item => item.row_number === 3).status,
    'blocked',
  );
});

test('a card image without human alt text blocks a Live row', () => {
  const data = copyFixture();
  findProject(data, 10).image_alt = '';
  const compiled = compileRegistryV2(data);
  assert.equal(compiled.ok, false);
  assert.ok(errorCodes(compiled).includes('card_image_alt_missing'));
  assert.equal(
    compiled.demos.find(demo => demo.demo_id === 'demo-singapore-road-speed').card_asset.alt_text,
    '',
  );
});

test('card asset source uses XOR and a safe local public path', async t => {
  await t.test('both Drive and external sources are rejected', () => {
    const data = copyFixture();
    data.assets[0].external_url = 'https://images.example.org/road-speed.jpg';
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('asset_source_xor'));
  });

  await t.test('external image sources are outside the first-round contract', () => {
    const data = copyFixture();
    data.assets[0].source_type = 'external';
    data.assets[0].drive_file_id = '';
    data.assets[0].source_file_name = '';
    data.assets[0].external_url = 'https://images.example.org/road-speed.jpg';
    data.projects.find(project => project.row_number === 10).card_image = data.assets[0].external_url;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('asset_source_type_invalid'));
  });

  await t.test('a Drive card is selected by its direct-child relative filename', () => {
    const data = copyFixture();
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, true);
    const card = compiled.demos.find(demo => demo.demo_id === 'demo-singapore-road-speed').card_asset;
    assert.equal(card.asset_id, 'asset-road-speed-card');
    assert.equal(card.public_path, 'assets/cards/road-speed.jpg');
  });

  await t.test('unsafe public paths are rejected for Live cards', () => {
    const data = copyFixture();
    data.assets[0].public_path = '../private/road-speed.svg';
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('card_asset_public_path_invalid'));
  });

  await t.test('an unsynchronised selected image is not ready', () => {
    const data = copyFixture();
    data.assets[0].sync_status = 'missing';
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('card_asset_sync_unhealthy'));
  });

  await t.test('card asset sync status is the exact machine value ok', () => {
    const data = copyFixture();
    data.assets[0].sync_status = 'OK';
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('card_asset_sync_unhealthy'));
  });

  await t.test('MIME type must be supported and match the public extension', () => {
    const data = copyFixture();
    data.assets[0].mime_type = 'image/png';
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false);
    assert.ok(errorCodes(compiled).includes('card_asset_mime_invalid'));
  });
});

test('first-round card gates require task, method, audience and an explicit featured boolean', async t => {
  const scenarios = [
    ['task', '', 'task_missing'],
    ['methods', '', 'method_missing'],
    ['audience', 'Experts', 'audience_invalid'],
    ['featured', '', 'featured_invalid'],
  ];

  for (const [field, value, code] of scenarios) {
    await t.test(`${field} blocks a Live row globally`, () => {
      const data = copyFixture();
      findProject(data, 3)[field] = value;
      const compiled = compileRegistryV2(data);
      assert.equal(compiled.ok, false);
      assert.ok(errorCodes(compiled).includes(code));
      assert.throws(() => toRegistryV2(compiled), RegistryV2ValidationError);
    });

    await t.test(`${field} blocks a Draft locally without invalidating healthy rows`, () => {
      const data = copyFixture();
      findProject(data, 17)[field] = value;
      const compiled = compileRegistryV2(data);
      const draft = compiled.readiness.find(item => item.demo_id === 'demo-draft-a');
      assert.equal(compiled.ok, true);
      assert.equal(errorCodes(compiled).includes(code), false);
      assert.equal(draft.status, 'blocked');
      assert.ok(draft.issues.some(item => item.code === code));
      assert.equal(
        toRegistryV2(compiled).demos.some(demo => demo.demo_id === 'demo-draft-a'),
        false,
      );
    });
  }

  await t.test('featured string aliases never become an approval boolean', () => {
    for (const value of ['true', 'yes', '1', '✓']) {
      const data = copyFixture();
      findProject(data, 3).featured = value;
      const compiled = compileRegistryV2(data);
      assert.equal(compiled.ok, false, value);
      assert.ok(errorCodes(compiled).includes('featured_invalid'), value);
      assert.equal(normalizeFeatured(value).valid, false, value);
    }
  });
});

test('empty numeric cells use deterministic fallbacks instead of becoming zero', () => {
  const data = copyFixture();
  data.sourceProjections[1].sort_order = '';
  data.taxonomy.departments[0].display_order = '   ';
  const compiled = compileRegistryV2(data);
  const demo = compiled.demos.find(item => item.demo_id === 'demo-soh-battery');
  const department = compiled.taxonomy.departments.find(item => item.id === 'physics');
  assert.equal(compiled.ok, true);
  assert.equal(demo.sort_order, 2);
  assert.equal(department.display_order, 1);
});

test('readable HTML with an asset warning remains eligible during v1 to v2 migration', () => {
  const data = copyFixture();
  data.sourceProjections[1].file_check = 'check assets: ../index.html';
  const compiled = compileRegistryV2(data);
  assert.equal(compiled.ok, true);
  assert.equal(
    compiled.readiness.find(item => item.demo_id === 'demo-soh-battery').status,
    'ready',
  );
});

test('the compiler requires an explicit boolean for every taxonomy active field', async t => {
  const invalidCases = [
    ['missing', undefined, true],
    ['blank', '', false],
    ['string true', 'true', false],
    ['arbitrary string', 'inherit', false],
  ];

  for (const [label, value, remove] of invalidCases) {
    await t.test(`${label} fails closed at the direct compiler boundary`, () => {
      const data = copyFixture();
      if (remove) delete data.taxonomy.departments[0].active;
      else data.taxonomy.departments[0].active = value;
      const compiled = compileRegistryV2(data);
      assert.equal(compiled.ok, false);
      assert.ok(errorCodes(compiled).includes('taxonomy_active_invalid'));
      assert.throws(() => toRegistryV2(compiled), RegistryV2ValidationError);
    });
  }

  await t.test('explicit true passes', () => {
    const data = copyFixture();
    data.taxonomy.departments[0].active = true;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, true);
    assert.equal(compiled.taxonomy.departments[0].active, true);
  });

  await t.test('explicit false stays false', () => {
    const data = copyFixture();
    const unused = data.taxonomy.departments.find(item => item.id === 'pharmacy-pharmaceutical-sciences');
    unused.active = false;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, true);
    assert.equal(
      compiled.taxonomy.departments.find(item => item.id === unused.id).active,
      false,
    );
  });
});

test('only Public permission passes the Live publication gate', () => {
  assert.equal(normalizePublicPermission('Public'), 'Public');
  assert.equal(normalizePublicPermission(' public '), 'Public');
  assert.equal(normalizePublicPermission('Preview only'), 'Preview only');
  assert.equal(normalizePublicPermission('Private'), 'Private');
  for (const unsafeAlias of [true, 'true', 'yes', 'approved', 'allow', 'preview', '\u5141\u8bb8']) {
    assert.equal(normalizePublicPermission(unsafeAlias), 'Private', String(unsafeAlias));
  }

  for (const permission of ['Preview only', 'Private', true, 'yes', 'approved', '\u5141\u8bb8']) {
    const data = copyFixture();
    findProject(data, 3).public_permission = permission;
    const compiled = compileRegistryV2(data);
    assert.equal(compiled.ok, false, permission);
    assert.ok(errorCodes(compiled).includes('public_permission_not_granted'), permission);
  }
});
