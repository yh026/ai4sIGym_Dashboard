'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLocalDemoCollection, integrateLocalDemoPages } = require('../lib/local-demo-collection');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-collection-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, 'demos_v4');
  fs.mkdirSync(directory);
  const html = '<!doctype html><html><head><title>Study</title></head><body><canvas id="plot"></canvas><script type="application/json" id="payload">{"values":[1,2,3]}</script></body></html>';
  fs.writeFileSync(path.join(directory, 'insight.html'), html);
  fs.writeFileSync(path.join(directory, 'workflow.html'), html);
  const demo = { demo_id: 'demo-example', slug: 'example', status: 'Live', title: 'Example', card_summary: 'Original summary' };
  const manifest = { schema_version: 1, id: 'test-collection', label: 'Collection', projects: [
    { demo_id: demo.demo_id, slug: demo.slug, insight: 'insight.html', workflow: 'workflow.html', card_summary: 'Local summary' },
    { demo_id: 'demo-new-example', slug: 'new-example', insight: 'insight.html', workflow: 'workflow.html',
      new_demo: { title: 'New example', status: 'Draft', public_page_permission: 'Preview only' } },
  ] };
  const write = () => fs.writeFileSync(path.join(directory, 'collection.json'), JSON.stringify(manifest));
  write();
  return { directory, html, demo, manifest, write, load: () => loadLocalDemoCollection(directory, [demo]) };
}

test('the local overlay reuses Registry identities, adds a preview-only demo, and leaves source metadata alone', t => {
  const sample = fixture(t), collection = sample.load();
  assert.equal(collection.demos.length, 2);
  assert.equal(collection.demos[0].demo_id, sample.demo.demo_id);
  assert.equal(collection.demos[0].card_summary, 'Local summary');
  assert.equal(sample.demo.card_summary, 'Original summary');
  assert.equal(collection.demos[1].status, 'Draft');
  assert.equal(collection.demos[1].public_page_permission, 'Preview only');
  assert.deepEqual([...collection.previewIds], ['demo-example', 'demo-new-example']);
});

test('two-page demos preserve embedded scripts and link only to available pages', t => {
  const sample = fixture(t), collection = sample.load();
  const result = integrateLocalDemoPages(collection, collection.demos, new Map());
  const emitted = new Set(['index.html', ...[...result.values()].flat().map(page => page.path)]);
  for (const pages of result.values()) for (const page of pages) {
    assert.match(page.html, /<script type="application\/json" id="payload">\{"values":\[1,2,3\]\}<\/script>/);
    assert.doesNotMatch(page.html, />Dataset</);
    for (const [, href] of page.html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(emitted.has(new URL(href, 'http://test/' + page.path).pathname.slice(1)), href);
    }
  }
  assert.equal(fs.readFileSync(path.join(sample.directory, 'insight.html'), 'utf8'), sample.html);
});

test('pending Dataset pages keep project navigation when their shared source is added later', t => {
  const sample = fixture(t);
  for (const project of sample.manifest.projects) {
    project.dataset = 'demos/' + project.slug + '/dataset.html';
    project.dataset_source = 'shared-data/shared-data_dataset.html';
  }
  sample.write();
  const build = () => {
    const collection = sample.load();
    return integrateLocalDemoPages(collection, collection.demos, new Map());
  };
  const pending = build();
  for (const [slug, pages] of pending) {
    const dataset = pages.find(page => page.path.endsWith('/dataset.html'));
    assert.match(dataset.html, /data-dataset-state="pending"/);
    assert.match(dataset.html, /href="index.html"/);
    assert.match(dataset.html, /href="workflow.html"/);
    assert.match(pages[0].html, /href="dataset.html#overview"/);
    assert.equal(dataset.path, 'demos/' + slug + '/dataset.html');
  }
  const source = path.resolve(sample.directory, '../datasets_v4/shared-data/shared-data_dataset.html');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, sample.html.replace('<canvas', '<h1>Supplied Dataset</h1><canvas'));
  for (const [slug, pages] of build()) {
    assert.deepEqual(pages.map(page => page.path), pending.get(slug).map(page => page.path));
    const dataset = pages.find(page => page.path.endsWith('/dataset.html'));
    assert.match(dataset.html, /Supplied Dataset/);
    assert.doesNotMatch(dataset.html, /data-dataset-state="pending"/);
    assert.match(dataset.html, /href="index.html"/);
    assert.match(dataset.html, /href="workflow.html"/);
  }
});

test('an existing resource workflow and its downloads remain reachable alongside the replacement', t => {
  const sample = fixture(t);
  Object.assign(sample.manifest.projects[0], { dataset: 'datasets/example/index.html', preserve_workflow_resources: true });
  sample.write();
  const collection = sample.load();
  const asset = { path: 'demos/example/resources/notebook.ipynb', bytes: Buffer.from('notebook') };
  const other = [{ path: 'demos/gene-study/index.html', html: 'custom gene study' }];
  const authored = new Map([
    ['example', [
      { path: 'demos/example/index.html', html: 'previous entry' },
      { path: 'demos/example/workflow.html', html: '<a href="resources/notebook.ipynb">Notebook</a><span>Key Findings</span>' },
      { path: 'datasets/example/index.html', html: '<span>Key Findings</span>' }, asset,
    ]], ['gene-study', other],
  ]);
  const result = integrateLocalDemoPages(collection, collection.demos, authored);
  const pages = result.get('example');
  assert.ok(pages.includes(asset));
  assert.match(pages[0].html, /href="workflow-resources.html">Notebook &amp; skills/);
  assert.match(pages.find(page => page.path.endsWith('workflow-resources.html')).html, /resources\/notebook.ipynb/);
  assert.match(pages.find(page => page.path.startsWith('datasets/')).html, /<span>Insight<\/span>/);
  assert.strictEqual(result.get('gene-study'), other);
});

test('bad identities, duplicate routes, missing files and unsafe paths fail before output replacement', t => {
  const sample = fixture(t), project = sample.manifest.projects[0];
  project.demo_id = 'wrong'; sample.write();
  assert.throws(sample.load, /does not match/);
  project.demo_id = sample.demo.demo_id;
  sample.manifest.projects.push({ ...project }); sample.write();
  assert.throws(sample.load, /duplicate/);
  sample.manifest.projects.pop();
  project.insight = '../outside.html'; sample.write();
  assert.throws(sample.load, /Unsafe/);
  project.insight = 'missing.html'; sample.write();
  assert.throws(sample.load, /ENOENT/);
});

test('local additions cannot declare publication or silently overwrite an authored project', t => {
  const sample = fixture(t);
  sample.manifest.projects[1].new_demo.status = 'Live'; sample.write();
  assert.throws(sample.load, /Draft \/ Preview only/);
  sample.manifest.projects[1].new_demo.status = 'Draft'; sample.write();
  const collection = sample.load();
  assert.throws(() => integrateLocalDemoPages(collection, collection.demos,
    new Map([['example', [{ path: 'demos/example/index.html', html: 'authored' }]]])), /replace an authored project/);
});
