'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const currentV2Fixture = require('../fixtures/registry-v2-current-21.json');
const { compileRegistryV2, toRegistryV2 } = require('../lib/registry-v2');

const root = path.resolve(__dirname, '..');
const statusFixture = path.join(root, 'fixtures', 'manifest-status-matrix.json');
const fallbackHtml = path.join(root, 'fixtures', 'demo-minimal.html');
const mockCardAsset = path.join(
  root, 'site', 'assets', 'previews', 'singapore-road-speed-clusters-umap.jpg',
);
const STATUS_REVISION = `sha256:${'2'.repeat(64)}`;

function statusBuild(context, branch, extraEnv = {}) {
  const env = { ...process.env };
  [
    'INCOMING_HOOK_BODY', 'INCOMING_HOOK_TITLE', 'INCOMING_HOOK_URL',
    'MOCK_FILE_REGISTRY_REVISION', 'MOCK_ASSET_REGISTRY_REVISION',
    'MOCK_FINAL_REGISTRY_REVISION', 'MOCK_ASSET_FILE', 'MOCK_ASSET_RESPONSE',
  ].forEach(key => { delete env[key]; });
  Object.assign(env, {
    NETLIFY: 'true',
    CONTEXT: context,
    BRANCH: branch,
    COMMIT_REF: 'a'.repeat(40),
    BUILD_ID: 'build-test-123',
    DEPLOY_ID: 'deploy-test-456',
    SITE_ID: '33333333-4444-4555-8666-777777777777',
    MOCK_MANIFEST: statusFixture,
    MOCK_HTML_FALLBACK: fallbackHtml,
    MOCK_ASSET_FILE: mockCardAsset,
  }, extraEnv);
  return spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
}

function previewHookBody(registryRevision = STATUS_REVISION) {
  return JSON.stringify({
    schema: 1,
    target: 'preview',
    branch: 'develop',
    registry_revision: registryRevision,
    request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    requested_at: '2026-08-11T01:02:03.004Z',
  });
}

function builtManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
}

function deployReceipt() {
  return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'deploy-receipt.json'), 'utf8'));
}

function v2Manifest(demos) {
  return {
    ok: true,
    schema_version: 2,
    audience: 'production',
    registry_revision: STATUS_REVISION,
    site: {
      title: 'Registry v2 test',
      tagline: 'Human-friendly Sheet, strict machine index.',
      internal_secret: 'DO_NOT_PUBLISH_THIS_SECRET',
    },
    taxonomy: {
      departments: [{
        id: 'chemistry', label: 'Chemistry from Sheet', short_label: 'Chemistry',
        description: 'Taxonomy copy from the Registry.', display_order: 1, active: true,
        theme_key: 'chemistry-materials', icon_key: 'flask',
        internal_note: 'DO_NOT_PUBLISH_TAXONOMY_SECRET',
      }],
      subtopics: [{
        id: 'materials', department_id: 'chemistry', label: 'Materials from Sheet',
        display_order: 1, active: true, internal_note: 'not public',
      }],
      tasks: [{ id: 'classification', label: 'Classification', active: true, internal_note: 'not public' }],
      methods: [
        { id: 'pca', label: 'Principal Components', active: true, internal_note: 'not public' },
        { id: 'umap', label: 'UMAP', active: true, internal_note: 'not public' },
      ],
      data_types: [
        { id: 'time-series', label: 'Time series', description: 'Ordered observations.', display_order: 1, active: true, internal_note: 'not public' },
        { id: 'tabular', label: 'Tabular', description: 'Rows and columns.', display_order: 2, active: true, internal_note: 'not public' },
        { id: 'retired-data', label: 'Retired data', description: '', display_order: 3, active: false, internal_note: 'not public' },
      ],
      instrument_types: [
        { id: 'explorer', label: 'Explorer', description: 'Interactive exploration.', display_order: 1, active: true, internal_note: 'not public' },
        { id: 'simulator', label: 'Simulator', description: 'Adjustable scenarios.', display_order: 2, active: true, internal_note: 'not public' },
        { id: 'unused-viewer', label: 'Unused viewer', description: '', display_order: 3, active: true, internal_note: 'not public' },
      ],
    },
    demos,
  };
}

function v2Demo(overrides = {}) {
  return {
    demo_id: 'explicit-chemistry-demo',
    entry_type: 'project',
    slug: 'explicit-chemistry-demo',
    status: 'Live',
    featured: true,
    sort_order: 10,
    title: 'Galaxy clustering that must not be inferred as Physics',
    card_summary: 'The Sheet-owned card summary.',
    department_id: 'chemistry',
    subtopic_id: 'materials',
    task_ids: ['classification'],
    method_ids: ['pca', 'umap'],
    data_type_ids: ['time-series'],
    instrument_type_ids: ['explorer', 'simulator'],
    audience: 'Intro',
    data_source_label: 'Synthetic fixture',
    public_page_permission: 'Public',
    card_asset: {
      asset_id: 'explicit-chemistry-card',
      public_path: 'assets/cards/explicit-chemistry.jpg',
      alt_text: 'A labelled chemistry card preview.',
    },
    file_id: 'v2-demo-file',
    file_check: 'ok',
    date_added: '2026-08-11T00:00:00.000Z',
    question: 'This field must not be rendered or published.',
    category: 'DO_NOT_PUBLISH_CATEGORY',
    framework: 'DO_NOT_PUBLISH_FRAMEWORK',
    tags: ['DO_NOT_PUBLISH_TAG'],
    learning_goal: 'DO_NOT_PUBLISH_LEARNING_GOAL',
    provenance: 'DO_NOT_PUBLISH_PROVENANCE',
    internal_write_owner: 'DO_NOT_PUBLISH_THIS_SECRET',
    ...overrides,
  };
}

function withV2Fixture(t, manifest, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4s-registry-v2-'));
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return run(manifestPath);
}

function validAssetResponse(overrides = {}) {
  const bytes = fs.readFileSync(mockCardAsset);
  return {
    ok: true,
    kind: 'card_image',
    id: 'explicit-chemistry-card',
    mime: 'image/jpeg',
    size: bytes.length,
    extension: 'jpg',
    base64: bytes.toString('base64'),
    registry_revision: STATUS_REVISION,
    ...overrides,
  };
}

function withMockAssetResponse(t, response, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4s-card-asset-'));
  const responsePath = path.join(directory, 'response.json');
  fs.writeFileSync(responsePath, JSON.stringify(response));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return run(responsePath);
}

test('mock build completes and publishes a safe seven-department manifest', () => {
  const env = { ...process.env };
  [
    'NETLIFY', 'CONTEXT', 'BRANCH', 'COMMIT_REF', 'BUILD_ID', 'DEPLOY_ID',
    'INCOMING_HOOK_BODY', 'INCOMING_HOOK_TITLE', 'INCOMING_HOOK_URL',
    'MOCK_MANIFEST', 'MOCK_HTML_FALLBACK', 'MOCK_FILE_REGISTRY_REVISION',
    'MOCK_ASSET_REGISTRY_REVISION', 'MOCK_FINAL_REGISTRY_REVISION',
    'MOCK_ASSET_FILE', 'MOCK_ASSET_RESPONSE',
  ].forEach(key => { delete env[key]; });
  const result = spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
  assert.equal(manifest.taxonomy_version, 5);
  assert.equal(manifest.domains.length, 7);
  assert.equal(manifest.demos.length, 3);
  assert.equal(manifest.demos.some(demo => demo.slug === 'ai-for-science-demos'), false);
  assert.equal(manifest.demos.some(demo => (
    demo.file_id || demo.file_check || demo.picture_file_id || demo.preview_file_id || demo.thumbnail_file_id
  )), false);
  const receipt = deployReceipt();
  assert.equal(receipt.platform, 'local-mock');
  assert.equal(receipt.verified, false);
  assert.equal(receipt.revision_bound, true);
  assert.equal('request_id' in receipt, false);
});

test('Registry v2 renders referenced taxonomy facets, safe card assets, and a public allowlist', t => {
  const result = withV2Fixture(t, v2Manifest([v2Demo()]), manifestPath => (
    statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
  ));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const page = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.match(page, /Chemistry from Sheet/);
  assert.match(page, /Materials from Sheet/);
  assert.match(page, /data-group="domain" data-value="chemistry">Chemistry<\/button>/);
  assert.match(page, /data-domain="chemistry"/);
  assert.match(page, /data-group="method" data-value="pca">Principal Components<\/button>/);
  assert.match(page, /data-group="method" data-value="umap">UMAP<\/button>/);
  assert.match(page, /data-method="pca\|umap"/);
  assert.match(page, /data-group="data-type" data-value="time-series">Time series<\/button>/);
  assert.match(page, /data-group="instrument-type" data-value="explorer">Explorer<\/button>/);
  assert.match(page, /data-group="instrument-type" data-value="simulator">Simulator<\/button>/);
  assert.match(page, /data-data-type="time-series"/);
  assert.match(page, /data-instrument-type="explorer\|simulator"/);
  assert.match(page, /data-search="[^"]*time series[^"]*explorer simulator[^"]*"/);
  assert.doesNotMatch(page, />Tabular<\/button>|>Retired data<\/button>|>Unused viewer<\/button>/);
  assert.match(page, /getAttribute\('data-' \+ group\) \|\| ''\)\.split\('\|'\)/);
  assert.match(page, /src="assets\/cards\/explicit-chemistry\.jpg"/);
  assert.match(page, /alt="A labelled chemistry card preview\."/);
  assert.match(page, /The Sheet-owned card summary\./);
  assert.doesNotMatch(page, /This field must not be rendered|DO_NOT_PUBLISH_/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'domains', 'chemistry-materials', 'index.html')), true);
  const domainPage = fs.readFileSync(
    path.join(root, 'dist', 'domains', 'chemistry-materials', 'index.html'), 'utf8',
  );
  assert.match(domainPage, /data-group="data-type" data-value="time-series"/);
  assert.match(domainPage, /data-group="instrument-type" data-value="explorer"/);
  const demoPage = fs.readFileSync(
    path.join(root, 'dist', 'demos', 'explicit-chemistry-demo', 'index.html'), 'utf8',
  );
  assert.match(demoPage, /<span>Data Type<\/span><span>Time series<\/span>/);
  assert.match(demoPage, /<span>Instrument Type<\/span><span>Explorer, Simulator<\/span>/);

  const manifest = builtManifest();
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(Object.keys(manifest.demos[0]).sort(), [
    'audience', 'card_asset', 'card_summary', 'data_source_label', 'data_type_ids', 'date_added',
    'demo_id', 'department_id', 'entry_type', 'featured', 'instrument_type_ids', 'method_ids',
    'public_page_permission', 'slug', 'sort_order', 'status', 'subtopic_id',
    'task_ids', 'title',
  ]);
  assert.equal(manifest.demos[0].department_id, 'chemistry');
  assert.deepEqual(manifest.demos[0].method_ids, ['pca', 'umap']);
  assert.deepEqual(manifest.demos[0].data_type_ids, ['time-series']);
  assert.deepEqual(manifest.demos[0].instrument_type_ids, ['explorer', 'simulator']);
  assert.deepEqual(manifest.taxonomy.data_types.map(term => term.id), [
    'time-series', 'tabular', 'retired-data',
  ]);
  assert.deepEqual(manifest.taxonomy.instrument_types.map(term => term.id), [
    'explorer', 'simulator', 'unused-viewer',
  ]);
  assert.deepEqual(Object.keys(manifest.taxonomy.data_types[0]).sort(), [
    'active', 'description', 'display_order', 'id', 'label',
  ]);
  assert.deepEqual(Object.keys(manifest.demos[0].card_asset).sort(), [
    'alt_text', 'asset_id', 'public_path',
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /DO_NOT_PUBLISH_|file_id|file_check|question/);
  assert.doesNotMatch(page, /DO_NOT_PUBLISH_TAXONOMY_SECRET/);
  assert.deepEqual(
    fs.readFileSync(path.join(root, 'dist', 'assets', 'cards', 'explicit-chemistry.jpg')),
    fs.readFileSync(mockCardAsset),
  );
});

test('Registry v2 treats missing new facet groups and references as empty arrays', t => {
  const demo = v2Demo();
  delete demo.data_type_ids;
  delete demo.instrument_type_ids;
  const manifestFixture = v2Manifest([demo]);
  delete manifestFixture.taxonomy.data_types;
  delete manifestFixture.taxonomy.instrument_types;
  const result = withV2Fixture(t, manifestFixture, manifestPath => (
    statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
  ));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const page = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /data-group="(?:data-type|instrument-type)"/);
  const manifest = builtManifest();
  assert.deepEqual(manifest.demos[0].data_type_ids, []);
  assert.deepEqual(manifest.demos[0].instrument_type_ids, []);
  assert.deepEqual(manifest.taxonomy.data_types, []);
  assert.deepEqual(manifest.taxonomy.instrument_types, []);
});

test('the current 21-row migration contract builds 14 public v2 project routes', t => {
  const compiled = compileRegistryV2(structuredClone(currentV2Fixture));
  const registry = toRegistryV2(compiled);
  const manifest = {
    ok: true,
    audience: 'production',
    registry_revision: STATUS_REVISION,
    ...registry,
  };
  const result = withV2Fixture(t, manifest, manifestPath => (
    statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
  ));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(builtManifest().demos.length, currentV2Fixture.expected.live_projects);
  assert.equal(builtManifest().domains.length, 7);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'demos', 'soh-battery', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'demos', 'draft-preview-a', 'index.html')), false);
  const page = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.match(page, /data-group="method" data-value="pca">PCA<\/button>/);
  assert.match(page, /src="assets\/cards\/road-speed\.jpg"/);
});

test('Registry v2 fails closed on duplicate slugs and unsafe or incomplete card assets', async t => {
  await t.test('duplicate slug', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo(),
      v2Demo({ demo_id: 'second-demo', file_id: 'second-file' }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Registry v2 contract: duplicate slug/);
  });

  await t.test('missing alt text', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ card_asset: {
        asset_id: 'unsafe-card', public_path: 'assets/cards/card.webp', alt_text: '',
      } }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /card_asset\.alt_text is required/);
  });

  await t.test('unsafe public path', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ card_asset: {
        asset_id: 'unsafe-card', public_path: 'assets/cards/../secret.webp', alt_text: 'Unsafe.',
      } }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /card_asset\.public_path is unsafe/);
  });

  await t.test('duplicate card asset id', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo(),
      v2Demo({
        demo_id: 'second-demo', slug: 'second-demo', file_id: 'second-file',
        card_asset: {
          asset_id: 'explicit-chemistry-card',
          public_path: 'assets/cards/second-card.jpg',
          alt_text: 'Second card.',
        },
      }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /duplicate card_asset\.asset_id/);
  });

  await t.test('duplicate card asset public path', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo(),
      v2Demo({
        demo_id: 'second-demo', slug: 'second-demo', file_id: 'second-file',
        card_asset: {
          asset_id: 'second-card',
          public_path: 'assets/cards/explicit-chemistry.jpg',
          alt_text: 'Second card.',
        },
      }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /duplicate card_asset\.public_path/);
  });
});

test('Registry v2 rejects malformed or empty build-facing data', async t => {
  await t.test('demos must be an array', child => {
    const result = withV2Fixture(child, v2Manifest({}), manifestPath => (
      statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
    ));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /demos must be an array/);
  });

  await t.test('every v2 build is bound to a Registry revision', child => {
    const manifest = v2Manifest([v2Demo({ card_asset: null })]);
    manifest.registry_revision = '';
    const result = withV2Fixture(child, manifest, manifestPath => (
      statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
    ));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /registry_revision is required/);
  });

  await t.test('an empty project library cannot replace the site', child => {
    const result = withV2Fixture(child, v2Manifest([]), manifestPath => (
      statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
    ));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /no publishable project remains/);
  });

  await t.test('strict scalar types are required', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ sort_order: '10', featured: 'yes' }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /featured must be a boolean|sort_order must be a finite number/);
  });

  await t.test('task and method references cannot be empty', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ task_ids: [], method_ids: [] }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /task_ids and method_ids must be non-empty/);
  });

  await t.test('new facet references must be arrays when present', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ data_type_ids: 'time-series' }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /data_type_ids must be an array/);
  });

  await t.test('audience uses the closed first-round vocabulary', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ audience: 'Experts' }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /audience has an invalid value/);
  });

  await t.test('status and public permission use closed vocabularies', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ status: 'Published', public_page_permission: 'Yes' }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /status has an invalid value|public_page_permission has an invalid value/);
  });

  await t.test('build-facing metadata keeps exact string types', child => {
    const result = withV2Fixture(child, v2Manifest([
      v2Demo({ data_source_label: 42, file_id: 123 }),
    ]), manifestPath => statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /data_source_label must be a string|file_id must be a string/);
  });

  await t.test('taxonomy active and display_order use exact types', child => {
    const manifest = v2Manifest([v2Demo({ card_asset: null })]);
    manifest.taxonomy.departments[0].active = 'true';
    manifest.taxonomy.departments[0].display_order = '1';
    const result = withV2Fixture(child, manifest, manifestPath => (
      statusBuild('production', 'main', { MOCK_MANIFEST: manifestPath })
    ));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /active must be a boolean|display_order must be a finite number/);
  });
});

test('Registry v2 card asset responses are strict, revision-bound, and fail before output', async t => {
  const runWithResponse = (child, response, demoOverrides = {}, extraEnv = {}) => (
    withMockAssetResponse(child, response, responsePath => (
      withV2Fixture(child, v2Manifest([v2Demo(demoOverrides)]), manifestPath => (
        statusBuild('production', 'main', {
          MOCK_MANIFEST: manifestPath,
          MOCK_ASSET_RESPONSE: responsePath,
          ...extraEnv,
        })
      ))
    ))
  );

  const cases = [
    ['kind', validAssetResponse({ kind: 'file' }), /invalid kind/],
    ['mime', validAssetResponse({ mime: 'image/png' }), /mime\/extension mismatch/],
    ['size', validAssetResponse({ size: 1 }), /size does not match decoded bytes/],
    ['base64', validAssetResponse({ base64: 'not-base64!' }), /invalid base64/],
    ['extension', validAssetResponse({ extension: 'png' }), /invalid extension/],
    ['id', validAssetResponse({ id: 'another-asset' }), /requested asset id/],
    ['revision', validAssetResponse({ registry_revision: `sha256:${'9'.repeat(64)}` }), /Card asset.*does not match/],
  ];
  for (const [label, response, pattern] of cases) {
    await t.test(label, child => {
      const result = runWithResponse(child, response);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, pattern);
    });
  }

  await t.test('declared JPEG must contain JPEG bytes', child => {
    const bytes = Buffer.from('not an image', 'utf8');
    const result = runWithResponse(child, validAssetResponse({
      size: bytes.length,
      base64: bytes.toString('base64'),
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /declared image format/);
  });

  await t.test('unsupported response fields do not echo private source material', child => {
    const result = runWithResponse(child, validAssetResponse({
      source_url: 'https://private.invalid/DO_NOT_ECHO_ASSET_SECRET',
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /unsupported fields/);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO_ASSET_SECRET/);
  });

  await t.test('the final manifest is rechecked after the asset fetch', child => {
    const output = path.join(root, 'dist', 'assets', 'cards', 'revision-race.jpg');
    fs.rmSync(output, { force: true });
    const result = runWithResponse(
      child,
      validAssetResponse(),
      { card_asset: {
        asset_id: 'explicit-chemistry-card',
        public_path: 'assets/cards/revision-race.jpg',
        alt_text: 'Revision race fixture.',
      } },
      { MOCK_FINAL_REGISTRY_REVISION: `sha256:${'8'.repeat(64)}` },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Final manifest.*does not match/);
    assert.equal(fs.existsSync(output), false);
  });
});

test('mock builds enforce the Production and develop Preview status matrix', () => {
  const routeExists = slug => fs.existsSync(
    path.join(root, 'dist', 'demos', slug, 'index.html'),
  );

  const production = statusBuild('production', 'main');
  assert.equal(production.status, 0, production.stdout + production.stderr);
  assert.deepEqual(builtManifest().demos.map(demo => demo.slug), ['status-live']);
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), false);
  assert.equal(routeExists('status-archived'), false);
  assert.match(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /\/deploy-receipt\.json[\s\S]*X-Robots-Tag: noindex, nofollow/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /\/\*\n/,
  );
  assert.equal(deployReceipt().verified, false);
  assert.equal(deployReceipt().target, 'production');
  assert.equal(deployReceipt().registry_revision, STATUS_REVISION);

  const preview = statusBuild('branch-deploy', 'develop');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(
    builtManifest().demos.map(demo => demo.slug).sort(),
    ['status-draft', 'status-live'],
  );
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), true);
  assert.equal(routeExists('status-archived'), false);
  assert.equal(routeExists('status-missing'), false);
  assert.equal(routeExists('status-unreadable'), false);
  assert.equal(routeExists('status-unknown'), false);
  assert.match(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /X-Robots-Tag: noindex, nofollow/,
  );
  assert.equal(deployReceipt().verified, false);
  assert.equal(deployReceipt().target, 'preview');
  assert.equal(deployReceipt().revision_bound, true);
});

test('verified Preview Hook build emits a matching secret-free deploy receipt', () => {
  const result = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/DO_NOT_PUBLISH_THIS_SECRET',
    REGISTRY_URL: 'https://example.invalid/exec?token=DO_NOT_PUBLISH_THIS_SECRET',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = deployReceipt();
  assert.equal(receipt.verified, true);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.request_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(receipt.requested_at, '2026-08-11T01:02:03.004Z');
  assert.equal(receipt.registry_revision, STATUS_REVISION);
  assert.equal(receipt.context, 'branch-deploy');
  assert.equal(receipt.site_id, '33333333-4444-4555-8666-777777777777');
  assert.equal(receipt.commit_ref, 'a'.repeat(40));
  assert.doesNotMatch(
    JSON.stringify(receipt), /DO_NOT_PUBLISH_THIS_SECRET|build_hooks|token=/,
  );
});

test('verified Preview fails on stale manifest, file, or final Registry revision', () => {
  const staleManifest = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(`sha256:${'4'.repeat(64)}`),
  });
  assert.notEqual(staleManifest.status, 0);
  assert.match(staleManifest.stdout + staleManifest.stderr, /Initial manifest.*does not match/);

  const staleFile = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    MOCK_FILE_REGISTRY_REVISION: `sha256:${'3'.repeat(64)}`,
  });
  assert.notEqual(staleFile.status, 0);
  assert.match(staleFile.stdout + staleFile.stderr, /Project file.*does not match/);

  const staleFinal = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: previewHookBody(),
    MOCK_FINAL_REGISTRY_REVISION: `sha256:${'3'.repeat(64)}`,
  });
  assert.notEqual(staleFinal.status, 0);
  assert.match(staleFinal.stdout + staleFinal.stderr, /Final manifest.*does not match/);
});

test('malformed Preview Hook payload fails without echoing body contents', () => {
  const result = statusBuild('branch-deploy', 'develop', {
    INCOMING_HOOK_BODY: JSON.stringify({
      ...JSON.parse(previewHookBody()),
      unexpected_secret: 'DO_NOT_ECHO_THIS_SECRET',
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /unsupported fields/);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO_THIS_SECRET/);
});
