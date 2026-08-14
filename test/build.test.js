'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAIN_DEFINITIONS,
  cardPreview,
  esc,
  isSiteRecord,
  normalizeV2Demo,
  normalizeV2Taxonomy,
  repairDemoNavigation,
  resolveDomain,
  resolveSubtopic,
  safePublicCardAssetUrl,
  safePreviewUrl,
  validateTaxonomy,
} = require('../build.js');

test('taxonomy contains the seven official NUS Science departments', () => {
  assert.deepEqual(DOMAIN_DEFINITIONS.map(department => department.name), [
    'Physics',
    'Chemistry',
    'Biological Sciences',
    'Pharmacy and Pharmaceutical Sciences',
    'Food Science and Technology',
    'Mathematics',
    'Statistics and Data Science',
  ]);
  assert.doesNotThrow(validateTaxonomy);
});

test('dashboard records are excluded without excluding real index.html projects', () => {
  const dashboard = {
    title: 'AI for Science demos',
    slug: 'ai-for-science-demos',
    file_name: 'folder/index.html',
  };
  assert.equal(isSiteRecord(dashboard), true);
  assert.equal(isSiteRecord({ ...dashboard, record_type: 'project' }), false);
  assert.equal(isSiteRecord({ title: 'Real experiment', slug: 'experiment', file_name: 'index.html' }), false);
  assert.equal(isSiteRecord({ title: 'Site shell', record_type: 'site', file_name: 'shell.html' }), true);
  assert.equal(isSiteRecord({ title: 'Disabled record', is_project: false }), true);
});

test('preview URLs and encoded registry text are normalised safely', () => {
  assert.equal(safePreviewUrl('https://example.org/chart.png', '../../'), 'https://example.org/chart.png');
  assert.equal(safePreviewUrl('http://example.org/chart.png', '../../'), '');
  assert.equal(safePreviewUrl('assets/previews/chart.png', '../../'), '../../assets/previews/chart.png');
  assert.equal(safePreviewUrl('assets/../secret.png', '../../'), '');
  assert.equal(esc('PCA &amp; UMAP'), 'PCA &amp; UMAP');
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(safePublicCardAssetUrl('assets/cards/chart.webp', '../../'), '../../assets/cards/chart.webp');
  assert.equal(safePublicCardAssetUrl('/assets/cards/chart.webp', '../../'), '');
  assert.equal(safePublicCardAssetUrl('https://example.org/chart.webp', '../../'), '');
  assert.equal(safePublicCardAssetUrl('assets/cards/../secret.webp', '../../'), '');
  assert.equal(safePublicCardAssetUrl('assets/cards/chart.svg', '../../'), '');
});

test('Registry v2 resolves only explicit active taxonomy references', () => {
  const taxonomy = normalizeV2Taxonomy({
    departments: [{
      id: 'chemistry', label: 'Chemistry from Sheet', short_label: 'Chemistry',
      description: 'Sheet-owned copy', display_order: 1, active: true,
      theme_key: 'chemistry-materials', icon_key: 'flask',
      internal_secret: 'must-not-survive',
    }],
    subtopics: [{
      id: 'materials', department_id: 'chemistry', label: 'Materials from Sheet',
      display_order: 1, active: true,
    }],
    tasks: [{ id: 'classification', label: 'Classification', active: true }],
    methods: [
      { id: 'pca', label: 'Principal Components', active: true },
      { id: 'retired-method', label: 'Retired method', active: false },
    ],
    data_types: [
      {
        id: 'time-series', label: 'Time series', description: 'Ordered observations.',
        display_order: 1, active: true,
      },
    ],
    instrument_types: [
      {
        id: 'explorer', label: 'Explorer', description: 'Interactive exploration.',
        display_order: 1, active: true,
      },
      {
        id: 'retired-instrument', label: 'Retired instrument', description: '',
        display_order: 2, active: false,
      },
    ],
  });
  const demo = normalizeV2Demo({
    demo_id: 'galaxy-demo', entry_type: 'project', slug: 'galaxy-demo', title: 'A galaxy project',
    status: 'Live', sort_order: 1,
    card_summary: 'Its explicit IDs still place it in Chemistry.',
    department_id: 'chemistry', subtopic_id: 'materials',
    task_ids: ['classification'], method_ids: ['pca'], featured: false,
    data_type_ids: ['time-series'], instrument_type_ids: ['explorer'],
    audience: 'Intro', data_source_label: 'Synthetic', public_page_permission: 'Public',
    card_asset: { asset_id: 'galaxy-card', public_path: 'assets/cards/galaxy.jpg', alt_text: 'Galaxy points.' },
    file_id: 'galaxy-file', file_check: 'ok', date_added: '2026-08-11T00:00:00.000Z',
    category: 'must-not-survive', question: 'must-not-survive',
  }, taxonomy, { demoIds: new Set(), slugs: new Set() }, 0);

  assert.equal(demo._domain, 'chemistry-materials');
  assert.equal(demo.department_label, 'Chemistry from Sheet');
  assert.deepEqual(demo._methodTerms.map(term => term.label), ['Principal Components']);
  assert.deepEqual(demo._dataTypeTerms.map(term => term.label), ['Time series']);
  assert.deepEqual(demo._instrumentTypeTerms.map(term => term.label), ['Explorer']);
  assert.deepEqual(Object.keys(taxonomy.departments.get('chemistry')).sort(), [
    'active', 'description', 'display_order', 'icon_key', 'id', 'label',
    'short_label', 'theme_key',
  ]);
  assert.deepEqual(Object.keys(demo).sort(), [
    'audience', 'card_asset', 'card_summary', 'data_source_label', 'data_type_ids', 'date_added',
    'demo_id', 'department_id', 'entry_type', 'featured', 'file_check', 'file_id',
    'instrument_type_ids', 'method_ids', 'public_page_permission', 'slug', 'sort_order', 'status',
    'subtopic_id', 'task_ids', 'title',
  ]);
  assert.equal('category' in demo, false);
  assert.equal('question' in demo, false);
  assert.throws(() => normalizeV2Demo({
    ...demo, demo_id: 'second-demo', slug: 'second-demo', method_ids: ['retired-method'],
  }, taxonomy, { demoIds: new Set(), slugs: new Set() }, 1), /unknown or inactive method/);
  assert.throws(() => normalizeV2Demo({
    ...demo, demo_id: 'third-demo', slug: 'third-demo',
    instrument_type_ids: ['retired-instrument'],
  }, taxonomy, { demoIds: new Set(), slugs: new Set() }, 2), /unknown or inactive instrument type/);

  const compatibilitySource = {
    ...demo, demo_id: 'compatibility-demo', slug: 'compatibility-demo',
  };
  delete compatibilitySource.data_type_ids;
  delete compatibilitySource.instrument_type_ids;
  const compatibilityDemo = normalizeV2Demo(
    compatibilitySource, taxonomy, { demoIds: new Set(), slugs: new Set() }, 3,
  );
  assert.deepEqual(compatibilityDemo.data_type_ids, []);
  assert.deepEqual(compatibilityDemo.instrument_type_ids, []);
});

test('preview lookup survives a duplicate-row slug suffix by using the HTML file identity', () => {
  assert.equal(cardPreview({
    slug: 'tbb-cluster-explorer-2',
    file_name: 'tbb_cluster_explorer.html',
    title: 'TBB cluster explorer — grouping a day of Himawari-9 brightness temperatures',
  }, '../../'), '../../assets/previews/tbb-cluster-explorer.jpg');
  assert.equal(cardPreview({
    _registrySchemaVersion: 2,
    slug: 'tbb-cluster-explorer',
    card_asset: {
      asset_id: 'sheet-card', public_path: 'assets/cards/sheet-card.webp', alt_text: 'Sheet card.',
    },
  }, '../../'), '../../assets/cards/sheet-card.webp');
  assert.equal(cardPreview({
    _registrySchemaVersion: 2,
    slug: 'tbb-cluster-explorer',
    card_asset: null,
  }, '../../'), '../../assets/previews/tbb-cluster-explorer.jpg');
});

test('demo-owned All demos links are repaired for the nested published route', () => {
  const source = '<header><a data-role="back" href="../index.html">← All demos</a></header>'
    + '<a href="https://example.org">Keep this link</a>'
    + '<a data-role="back" href="#previous-step">Previous step</a>'
    + '<a data-href="../index.html">All demos without a real href</a>'
    + '<a href=../index.html>All demos with an unquoted href</a>'
    + '<a href="https://example.org/demos">Browse all demos elsewhere</a>'
    + '<script>const template = "<a data-role=\'back\' href=\'../index.html\'>All demos</a>";</script>';
  const repaired = repairDemoNavigation(source);

  assert.match(repaired, /href="\.\.\/\.\.\/index\.html#projects">← All demos<\/a>/);
  assert.match(repaired, /href="https:\/\/example\.org">Keep this link<\/a>/);
  assert.match(repaired, /data-role="back" href="#previous-step">Previous step<\/a>/);
  assert.match(repaired, /data-href="\.\.\/index\.html">All demos without a real href<\/a>/);
  assert.match(repaired, /href=\.\.\/index\.html>All demos with an unquoted href<\/a>/);
  assert.match(repaired, /href="https:\/\/example\.org\/demos">Browse all demos elsewhere<\/a>/);
  assert.match(repaired, /<script>const template = "<a data-role='back' href='\.\.\/index\.html'>All demos<\/a>";<\/script>/);
  assert.equal((repaired.match(/\.\.\/\.\.\/index\.html#projects/g) || []).length, 1);
});

test('subject matter wins over misleading individual words and ML methods', () => {
  const cases = [
    [{ title: 'Battery state of health from four battery cells' }, 'Chemistry'],
    [{ title: 'Himawari weather satellite', method: 'crop and cluster brightness temperatures' }, 'Physics'],
    [{ title: 'Forest canopy microclimate clustering' }, 'Biological Sciences'],
    [{ title: 'Drug screening on cell lines' }, 'Pharmacy and Pharmaceutical Sciences'],
    [{ title: 'Food fermentation clustering' }, 'Food Science and Technology'],
    [{ title: 'Topology visualiser' }, 'Mathematics'],
  ];
  cases.forEach(([record, expected]) => assert.equal(resolveDomain(record).name, expected));
});

test('explicit human metadata wins over compatibility assignments', () => {
  assert.equal(resolveDomain({ slug: 'soh-battery', domain: 'Mathematics' }).name, 'Mathematics');
  assert.equal(resolveDomain({ slug: 'soh-battery', department_id: 'space-astronomy' }).name, 'Physics');

  const chemistry = resolveDomain({ slug: 'soh-battery' });
  assert.equal(resolveSubtopic({ slug: 'soh-battery', subtopic: 'Materials Chemistry' }, chemistry).id, 'materials');
});

test('the current public collection resolves to 14 projects across four active departments', () => {
  const projects = [
    ['soh-battery', 'Chemistry', 'electrochemistry-energy'],
    ['ceemdan-battery-forecasting', 'Chemistry', 'electrochemistry-energy'],
    ['tbb-cluster-explorer', 'Physics', 'atmospheric-remote-sensing'],
    ['pleiades-membership-explorer', 'Physics', 'astrophysics'],
    ['superconductor-regression-explorer', 'Physics', 'condensed-matter'],
    ['forest-microclimate-does-canopy-buffer-the-day', 'Biological Sciences', 'ecology-evolution'],
    ['galaxy2-does-rotation-augmentation-help', 'Physics', 'astrophysics'],
    ['singapore-road-speed-clusters-umap', 'Statistics and Data Science', 'spatiotemporal-data'],
    ['from-twenty-thousand-genes-to-fourteen-cell-types', 'Biological Sciences', 'genomics-rna'],
    ['from-twelve-thousand-numbers-to-a-codebook', 'Statistics and Data Science', 'data-compression'],
    ['air-quality-day-segment-pca-and-amp-umap-by-sensor', 'Statistics and Data Science', 'multivariate-visualisation'],
    ['jae-regularisation-lab-what-each-loss-actually-does', 'Statistics and Data Science', 'machine-learning'],
    ['jae-joint-embedding-how-one-cell-becomes-61-numbers', 'Biological Sciences', 'genomics-rna'],
    ['alzheimer-s-gene-co-expression-explorer', 'Biological Sciences', 'systems-biology'],
  ];
  const counts = new Map();

  projects.forEach(([slug, expectedDepartment, expectedSubtopic]) => {
    const department = resolveDomain({ slug });
    const subtopic = resolveSubtopic({ slug }, department);
    assert.equal(department.name, expectedDepartment, slug);
    assert.equal(subtopic.id, expectedSubtopic, slug);
    counts.set(department.name, (counts.get(department.name) || 0) + 1);
  });

  assert.equal(projects.length, 14);
  assert.deepEqual(Object.fromEntries(counts), {
    Chemistry: 2,
    Physics: 4,
    'Biological Sciences': 4,
    'Statistics and Data Science': 4,
  });
});
