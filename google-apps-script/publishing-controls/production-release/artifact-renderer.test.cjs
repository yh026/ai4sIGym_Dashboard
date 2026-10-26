'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createReleaseIntent, HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION } = require('./release-plan.cjs');
const { verifyPinnedSource, deploymentSnapshot, renderArtifact, projectArtifact, localReferences } = require('./artifact-renderer.cjs');
const { loadCatalogRenderer, rendererDigest } = require('./catalog-renderer.cjs');
const { root, taxonomy, renderer, sha, tbb, policies, site, demo, source, fixture } = require('./artifact-fixture.cjs');

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
