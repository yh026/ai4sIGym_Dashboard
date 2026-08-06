'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAIN_DEFINITIONS,
  esc,
  isSiteRecord,
  resolveDomain,
  resolveSubtopic,
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
