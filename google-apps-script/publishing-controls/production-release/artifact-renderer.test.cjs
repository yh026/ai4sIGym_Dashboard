'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createReleaseIntent, HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION } = require('./release-plan.cjs');
const { verifyPinnedSource, deploymentSnapshot, renderArtifact, projectArtifact, localReferences } = require('./artifact-renderer.cjs');
const { loadCatalogRenderer, rendererDigest } = require('./catalog-renderer.cjs');
const root = path.resolve(__dirname, '../../..');
const taxonomy = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/registry-v2-current-21.json'))).taxonomy;
const renderer = loadCatalogRenderer(root, rendererDigest(root));
const sha = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const tbb = 'tbb-cluster-explorer-2';
const policies = [HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION];
const site = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973';

function demo(slug) {
  return { demo_id: 'demo-' + slug, slug, entry_type: 'project', status: 'Live', public_page_permission: 'Public',
    featured: false, sort_order: slug === tbb ? 1 : slug === 'a' ? 2 : 3,
    title: slug + ' science', card_summary: 'Explore scientific results', department_id: 'physics',
    subtopic_id: 'atmospheric-remote-sensing', task_ids: ['clustering'], method_ids: ['k-means'],
    data_type_ids: [], instrument_type_ids: [], audience: 'General', data_source_label: 'Scientific measurements',
    date_added: '2026-09-01T00:00:00.000Z', card_asset: { asset_id: 'card-' + slug,
      public_path: 'assets/cards/' + slug + '.jpg', alt_text: slug + ' cover' },
    pages: [{ role: 'insight', state: 'Ready', path: 'demos/' + slug + '/index.html' },
      { role: 'workflow', state: 'Ready', path: 'demos/' + slug + '/workflow.html' },
      { role: 'dataset', state: 'Ready', path: 'datasets/shared/index.html' }] };
}

function source(environment) {
  const production = environment === 'production', deploy = (production ? 'a' : 'b').repeat(24);
  const metadata = { id: deploy, site_id: site, state: 'ready', branch: production ? 'main' : 'develop',
    context: production ? 'production' : 'branch-deploy', commit_ref: 'c'.repeat(40) };
  const demos = [demo(tbb), demo('a'), ...(!production ? [demo('b')] : [])];
  const files = new Map(), put = (name, text) => files.set(name, Buffer.from(text));
  for (const row of demos) {
    const notebook = !production && row.slug === tbb;
    const nav = notebook ? '<a href="workflow-resources.html">Notebook &amp; skills</a>' : '';
    const value = !production && row.slug === 'a' ? 'Updated scientific result' : 'Original scientific result';
    put('demos/' + row.slug + '/index.html', '<html><a href="../../index.html">Home</a>' + nav
      + '<p>' + value + '</p><img src="/assets/embedded/shared.png"><script src="/assets/runtime/shared.js"></script></html>');
    put('demos/' + row.slug + '/workflow.html', '<html>' + nav + '<a href="../../datasets/shared/">Dataset</a></html>');
    put(row.card_asset.public_path, 'card-' + row.slug);
    if (notebook) {
      row.pages.push({ role: 'resource_page', state: 'Ready', path: 'demos/' + tbb + '/workflow-resources.html' });
      put('demos/' + tbb + '/workflow-resources.html', '<html>Downloads</html>');
      put('demos/' + tbb + '/resources/notebook.ipynb', '{}');
    }
  }
  // The shared Dataset has no notebook link because other projects use it.
  // TBB's own Dataset needs that exact link when the preview offers resources.
  const tbbDemo = demos[0]; tbbDemo.pages.find(page => page.role === 'dataset').path = 'datasets/tbb/index.html';
  put('datasets/tbb/index.html', '<html>' + (!production
    ? '<a href="../../demos/' + tbb + '/workflow-resources.html">Notebook &amp; skills</a>' : '') + 'TBB dataset</html>');
  put('datasets/shared/index.html', '<html>Shared dataset<img src="/assets/embedded/shared.png"></html>');
  put('assets/embedded/shared.png', 'same image pixels');
  put('assets/runtime/shared.js', 'const nested="/assets/runtime/values.json";');
  put('assets/runtime/values.json', '[0.12345678912345678,2]');
  put('assets/embedded/unused.png', 'unreferenced image');
  put('assets/map.png', 'original map pixels');
  const override = { id: HOMEPAGE_INTRODUCTION, added_files: [] };
  let introduction = '';
  if (production) {
    for (const [role, ext] of [['stylesheet', 'css'], ['script', 'js'], ['poster', 'jpg'], ['video', 'mp4']]) {
      const name = 'assets/intro-' + role + '.' + ext, bytes = Buffer.from('original intro ' + role);
      files.set(name, bytes); override.added_files.push({ path: name, size: bytes.length, sha256: sha(bytes) });
    }
    introduction = '<!-- homepage-introduction-v1:stylesheet:begin -->\n<link rel="stylesheet" href="/assets/intro-stylesheet.css">\n<!-- homepage-introduction-v1:stylesheet:end -->'
      + '<!-- homepage-introduction-v1:section:begin -->\n<section><video poster="/assets/intro-poster.jpg" src="/assets/intro-video.mp4"></video></section>\n<!-- homepage-introduction-v1:section:end -->'
      + '<!-- homepage-introduction-v1:script:begin -->\n<script src="/assets/intro-script.js"></script>\n<!-- homepage-introduction-v1:script:end -->';
  }
  put('index.html', '<html>' + introduction + '<img class="map-art" src="assets/map.png"></html>');
  put('manifest.json', JSON.stringify({ schema_version: 3, taxonomy, site: {}, demos, audience: environment }));
  const receipt = { schema: 1, deploy_id: deploy, site_id: site, commit_ref: metadata.commit_ref,
    audience: environment, target: environment, branch: metadata.branch, context: metadata.context,
    ...(production ? { publication_overrides: [{ id: HIDDEN_TBB_RESOURCES }, override] }
      : { verified: true, revision_bound: true, registry_revision: 'sha256:' + 'f'.repeat(64) }) };
  put('deploy-receipt.json', JSON.stringify(receipt));
  return { metadata, files, inventory: [...files].map(([name, bytes]) => ({ path: '/' + name,
    sha: sha(bytes, 'sha1'), deploy_id: deploy })) };
}

function fixture() {
  const baseline = verifyPinnedSource(source('production'), 'production');
  const preview = verifyPinnedSource(source('preview'), 'preview');
  const catalog = preview.manifest.demos.map(row => ({ demo_id: row.demo_id, slug: row.slug }));
  const current = { catalog, selection: catalog.map(row => ({ demo_id: row.demo_id,
    include_in_production: true, include_in_preview: row.slug !== tbb })),
  baseline: deploymentSnapshot(baseline, policies), preview: deploymentSnapshot(preview, policies),
  now: '2026-10-07T01:00:00.000Z' };
  return { baseline, preview, current, catalogRenderer: renderer };
}

test('renderer rebuilds cards, map links and domain counts while retaining old production and adding/updating preview projects', () => {
  const input = fixture(), intent = createReleaseIntent(input.current), result = renderArtifact({ ...input, intent });
  const files = result.artifact.files, home = files.get('index.html').toString(), manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.demos.length, 3);
  assert.match(home, /3 interactive projects/);
  assert.equal((home.match(/class="project-card"/g) || []).length, 3);
  assert.match(files.get('demos/a/index.html').toString(), /Updated scientific result/);
  assert.deepEqual(files.get('demos/' + tbb + '/index.html'), input.baseline.files.get('demos/' + tbb + '/index.html'));
  assert.equal(manifest.domains.find(row => row.id === 'space-astronomy').project_count, 3);
  assert.equal((files.get('domains/space-astronomy/index.html').toString().match(/class="project-card"/g) || []).length, 3);
  assert.ok(files.has('assets/runtime/values.json'));
  assert.equal(files.has('assets/embedded/unused.png'), false);
  assert.deepEqual(files.get('assets/intro-video.mp4'), input.baseline.files.get('assets/intro-video.mp4'));
  assert.equal(files.has('demos/' + tbb + '/resources/notebook.ipynb'), false);
  assert.equal(result.renderer_evidence.homepage_introduction_unchanged, true);
});

test('preview TBB policy normalization yields same digest as published TBB and omits download links', () => {
  const input = fixture(); input.current.selection[0].include_in_preview = true;
  const before = input.current.baseline.projects.find(p => p.slug === tbb);
  const next = input.current.preview.projects.find(p => p.slug === tbb);
  assert.equal(before.content_digest, next.content_digest);
  const intent = createReleaseIntent(input.current), output = renderArtifact({ ...input, intent }).artifact.files;
  assert.doesNotMatch(output.get('demos/' + tbb + '/index.html').toString(), /Notebook &amp; skills/);
  assert.doesNotMatch(output.get('datasets/tbb/index.html').toString(), /Notebook &amp; skills/);
});

test('remove drops project and its dataset routes but retains a dataset used by another selected project', () => {
  const input = fixture(); input.current.selection[0].include_in_production = false;
  input.current.selection[1].include_in_production = false;
  const result = renderArtifact({ ...input, intent: createReleaseIntent(input.current) }), files = result.artifact.files;
  assert.equal(files.has('datasets/tbb/index.html'), false);
  assert.equal(files.has('demos/a/index.html'), false);
  assert.ok(files.has('datasets/shared/index.html'));
  assert.equal((files.get('index.html').toString().match(/class="project-card"/g) || []).length, 1);
  assert.doesNotMatch(files.get('index.html').toString(), /demos\/a\/index.html/);
});

test('all-off produces a complete empty site with introduction and map but no project or dataset routes', () => {
  const input = fixture(); input.current.selection.forEach(row => row.include_in_production = false);
  const files = renderArtifact({ ...input, intent: createReleaseIntent(input.current) }).artifact.files;
  assert.equal([...files.keys()].some(name => name.startsWith('demos/') || name.startsWith('datasets/')), false);
  assert.match(files.get('index.html').toString(), /0 interactive projects/);
  assert.match(files.get('index.html').toString(), /homepage-introduction-v1:section/);
  assert.equal(JSON.parse(files.get('manifest.json')).demos.length, 0);
});

test('mixed-source conflicting shared dataset content fails before any artifact is accepted', () => {
  const input = fixture(); input.current.selection[1].include_in_preview = false;
  input.preview.files.set('datasets/shared/index.html', Buffer.from('<html>Different shared dataset</html>'));
  input.current.preview = deploymentSnapshot(input.preview, policies);
  assert.throws(() => renderArtifact({ ...input, intent: createReleaseIntent(input.current) }), /conflicting shared route/);
});

test('source inventory tampering, renderer source drift and missing scientific dependencies fail closed', () => {
  const raw = source('production'); raw.files.set('assets/map.png', Buffer.from('changed'));
  assert.throws(() => verifyPinnedSource(raw, 'production'), /hash mismatch/);
  assert.throws(() => loadCatalogRenderer(root, 'sha256:' + '0'.repeat(64)), /source changed/);
  const input = fixture(); input.preview.files.delete('assets/embedded/shared.png');
  input.current.preview = deploymentSnapshot(input.preview, policies);
  // Remove the production copy too so a retained project cannot satisfy it.
  input.current.selection[0].include_in_production = false;
  assert.throws(() => renderArtifact({ ...input, intent: createReleaseIntent(input.current) }), /unresolved local link/);
});

test('dependency scan is bounded on large inline binary data and still finds trailing script assets', () => {
  const files = new Map([['assets/runtime/a.js', Buffer.from('code')]]);
  const text = Buffer.from('<img src="data:image/png;base64,' + 'A'.repeat(500000)
    + '"><script src="/assets/runtime/a.js"></script>');
  assert.deepEqual(localReferences('demos/a/index.html', text, files), ['assets/runtime/a.js']);
});
