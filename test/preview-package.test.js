'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipFiles } = require('../lib/local-zip');
const api = import('../preview-manager/shared/package.mjs');
const hash = 'a'.repeat(40);
const file = (path, text = '') => ({ path, blob: new Blob([text]) });
const demo = { slug: 'alpha', pages: {
  insight: { path: '/demos/alpha/index.html', state: 'Ready' },
  workflow: { path: '/demos/alpha/workflow.html', state: 'Ready' },
  dataset: { path: '/datasets/example/index.html', state: 'Placeholder' },
}, files: { '/demos/alpha/index.html': { sha1: hash, size: 10 }, '/demos/alpha/data.json': { sha1: hash, size: 10 }, '/datasets/example/index.html': { sha1: hash, size: 10 } } };

test('catalog retains registered page roles, external datasets, cards and page status', async () => {
  const { catalogFromBaseline, canWrite, fileMap } = await api;
  const demos = ['alpha', 'beta'].map((slug) => ({
    slug,
    pages: {
      insight: { path: '/demos/' + slug + '/index.html' },
      workflow: { path: '/demos/' + slug + '/workflow.html' },
      dataset: { path: '/datasets/' + slug + '/index.html', state: slug === 'alpha' ? 'Ready' : 'Placeholder' },
    },
    card_asset: { public_path: 'assets/cards/' + slug + '.jpg' },
  }));
  const files = demos.flatMap(({ pages, card_asset }) =>
    [...Object.values(pages).map((page) => page.path), '/' + card_asset.public_path]
      .map((path) => ({ path, sha1: hash, size_bytes: 10 })),
  );
  const catalog = catalogFromBaseline({ demos, files });
  assert.deepEqual(Object.keys(catalog).sort(), ['alpha', 'beta']);
  assert.equal(Object.keys(fileMap(files)).length, 8);
  for (const [slug, entry] of Object.entries(catalog)) {
    assert.deepEqual(Object.keys(entry.pages).sort(), ['dataset', 'insight', 'workflow']);
    const dataset = '/datasets/' + slug + '/index.html';
    const card = '/' + entry.card_asset.public_path;
    assert.equal(entry.pages.dataset.path, dataset);
    assert.equal(entry.files[dataset].size, 10);
    assert.equal(entry.files[card].sha1, hash);
    assert.equal(canWrite(entry, dataset), true);
    assert.equal(canWrite(entry, '/index.html'), false);
    assert.equal(canWrite(entry, '/demos/some-other-project/index.html'), false);
  }
  assert.equal(catalog.alpha.pages.dataset.state, 'Ready');
  assert.equal(catalog.beta.pages.dataset.state, 'Placeholder');
});
test('standalone HTML replaces insight; incomplete package preserves all other files', async () => {
  const { importPackage, planChanges } = await api;
  const imported = await importPackage([file('report.html', '<h1>Hello</h1>')], demo, demo.files);
  assert.equal(imported.files[0].path, demo.pages.insight.path);
  assert.match(imported.files[0].sha1, /^[a-f0-9]{40}$/);
  assert.deepEqual(imported.remove, []);
  const plan = planChanges(demo.files, imported.files);
  assert.deepEqual(plan.map(p => p.kind), ['replaced']);
  assert.equal(planChanges(imported.files, imported.files)[0].kind, 'reused');
});
test('data-only overlay folder works without an HTML page', async () => {
  const { importPackage } = await api;
  const result = await importPackage([file('alpha/data.json', '{"rows":[]}')], demo, demo.files);
  assert.equal(result.files[0].path, '/demos/alpha/data.json');
});
test('manifest remaps a Dataset file to its registered /datasets path', async () => {
  const { importPackage } = await api;
  const result = await importPackage([file('demo.json', JSON.stringify({ schema: 1, slug: 'alpha', pages: { dataset: 'source.html' } })), file('source.html', '<h1>Data</h1>')], demo, demo.files);
  assert.equal(result.files[0].path, '/datasets/example/index.html');
});
test('relative HTML, CSS, poster, srcset and cross-demo dependencies use final site inventory', async () => {
  const { importPackage } = await api;
  const entries = [file('index.html', '<!-- <img src="missing.png"> --><script>"<img src=missing.png>"</script><link href="style.css"><video poster="poster.jpg"><source src="clip.mp4"></video><img srcset="a.png 1x, b.png 2x"><a href="../beta/">Other</a><style>.a{background:url(a.png)}</style>'), file('style.css', '@import "more.css"; .a{background:url("a.png")}'), file('more.css'), file('a.png'), file('b.png'), file('poster.jpg'), file('clip.mp4')];
  const existing = { ...demo.files, '/demos/beta/index.html': { sha1: hash, size: 1 } };
  assert.equal((await importPackage(entries, demo, existing)).files.length, entries.length);
  await assert.rejects(importPackage(entries.filter(e => e.path !== 'b.png'), demo, existing), /Missing dependency/);
});
test('ZIP deflate roundtrip validates checksums and sizes', async () => {
  const { importPackage } = await api;
  const bytes = zipFiles(new Map([['wrapper/index.html', '<img src="asset.png">'], ['wrapper/asset.png', 'image bytes']]));
  assert.equal((await importPackage([file('upload.zip', bytes)], demo, demo.files)).files.length, 2);
  const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(0, 14);
  await assert.rejects(importPackage([file('upload.zip', corrupt)], demo, demo.files), /mismatch/);
});
test('rejects traversal, ambiguous names, outside writes and protected removals', async () => {
  const { importPackage, safePath, validateChanges } = await api;
  for (const path of ['../secret', '/a//b', '/a/./b', '/a/%2e%2e/b', '/a\\b', '/a?b', '/.env']) assert.throws(() => safePath(path), /Unsafe/);
  await assert.rejects(importPackage([file('a.json'), file('A.json')], demo, demo.files), /ambiguous/);
  await assert.rejects(importPackage([file('demos/beta/index.html')], demo, demo.files), /outside/);
  assert.throws(() => validateChanges(demo, [], ['/datasets/example/index.html'], demo.files), /required/);
  assert.throws(() => validateChanges(demo, [], ['/demos/alpha/missing.json'], demo.files), /unregistered/);
  await assert.rejects(importPackage([file('demo.json', JSON.stringify({ schema: 1, slug: 'beta', pages: {} }))], demo, demo.files), /schema/);
});
test('explicit removal plans registered non-page only and checks dangling dependencies', async () => {
  const { importPackage, planChanges } = await api;
  const manifest = file('demo.json', JSON.stringify({ schema: 1, slug: 'alpha', pages: {}, remove: ['data.json'] }));
  const imported = await importPackage([manifest, file('other.json', '{}')], demo, demo.files);
  assert.deepEqual(imported.remove, ['/demos/alpha/data.json']);
  assert.equal(planChanges(demo.files, imported.files, imported.remove).find(p => p.path.endsWith('data.json')).kind, 'removed');
  await assert.rejects(importPackage([manifest, file('index.html', '<a href="data.json">Data</a>')], demo, demo.files), /Missing dependency/);
});
test('inline data srcset candidates do not become false local dependencies', async () => {
  const { importPackage } = await api;
  const result = await importPackage([file('index.html', '<img srcset="data:image/png;base64,AAAA 1x, image.png 2x">'), file('image.png')], demo, demo.files);
  assert.equal(result.files.length, 2);
});
test('removal checks dependencies of retained pages when their blobs are available', async () => {
  const { importPackage } = await api;
  const existing = { ...demo.files, '/demos/alpha/index.html': { ...demo.files['/demos/alpha/index.html'], blob: new Blob(['<a href="data.json">Data</a>']) } };
  await assert.rejects(importPackage([file('demo.json', JSON.stringify({ schema: 1, slug: 'alpha', pages: {}, remove: ['data.json'] }))], demo, existing), /Missing dependency/);
});
test('shared Dataset and card assets remain readable but cannot be changed by either demo', async () => {
  const { catalogFromBaseline, canWrite } = await api;
  const catalog = catalogFromBaseline({ demos: ['alpha', 'beta'].map(slug => ({ slug, pages: { insight: `demos/${slug}/index.html`, dataset: 'datasets/common/index.html' }, card_asset: { public_path: 'assets/cards/common.jpg' } })), files: { '/datasets/common/index.html': { sha1: hash, size: 1 }, '/assets/cards/common.jpg': { sha1: hash, size: 1 } } });
  for (const d of Object.values(catalog)) {
    assert.ok(d.files['/datasets/common/index.html']);
    assert.ok(d.sharedFiles['/assets/cards/common.jpg']);
    assert.equal(canWrite(d, '/datasets/common/index.html'), false);
    assert.equal(canWrite(d, '/assets/cards/common.jpg'), false);
    assert.equal(canWrite(d, '/demos/' + d.slug + '/index.html'), true);
  }
});
test('reserved site settings paths are forbidden even inside selected demo', async () => {
  const { importPackage, canWrite } = await api;
  for (const path of ['_headers', '_redirects', 'netlify.toml', 'resources/_headers']) {
    await assert.rejects(importPackage([file(path, 'configuration')], demo, demo.files), /Reserved/);
    assert.equal(canWrite(demo, '/demos/alpha/' + path), false);
  }
  await assert.rejects(importPackage([file('index.html')], { ...demo, slug: '../other' }), /Invalid demo slug/);
});
test('Finder ZIP metadata is ignored and encoded spaces resolve to exact local files', async () => {
  const { importPackage } = await api;
  const zip = zipFiles(new Map([
    ['field/index.html', '<img src="resources/map%2001.png">'],
    ['field/resources/map 01.png', 'pixels'], ['field/.DS_Store', 'metadata'],
    ['__MACOSX/field/._index.html', 'attributes']
  ]));
  const pkg = await importPackage([{path:'demo.zip',blob:new Blob([zip])}],demo,demo.files);
  assert.deepEqual(pkg.files.map(f=>f.path).sort(),['/demos/alpha/index.html','/demos/alpha/resources/map 01.png']);
});

test('new demo ZIP and folder keep their declared entry points and relative assets', async () => {
  const { importPackage, newDemoDescriptor } = await api;
  const registration = { slug: 'my-demo', title: 'My demo', departmentId: 'mathematics' };
  const descriptor = newDemoDescriptor(registration);
  const contents = new Map([
    ['example/demo.json', JSON.stringify({ schema: 1, slug: 'my-demo', pages: { dataset: 'pages/data.htm' } })],
    ['example/insight.html', '<a href="pages/data.htm">Data</a>'],
    ['example/workflow.html', '<a href="insight.html">Insight</a>'],
    ['example/pages/data.htm', '<a href="../datasets/data.csv">Data</a>'],
    ['example/datasets/data.csv', 'x\n1']
  ]);
  const inputs = [...contents].map(([p, s]) => file(p, s));
  const folder = await importPackage(inputs, descriptor, {}, { registration });
  const zip = await importPackage([{ path: 'example.zip', blob: new Blob([zipFiles(contents)]) }], descriptor, {}, { registration });
  const summarize = (pkg) => pkg.files.map(({path,sha1})=>[path,sha1]).sort();
  assert.deepEqual(summarize(zip), summarize(folder));
  const registered = newDemoDescriptor(zip.registration);
  assert.equal(registered.pages.insight.path, '/demos/my-demo/insight.html');
  assert.equal(registered.pages.dataset.path, '/demos/my-demo/pages/data.htm');
  assert.ok(zip.files.some((f)=> f.path === '/demos/my-demo/datasets/data.csv'));
  await assert.rejects(importPackage(inputs.filter(f => !f.path.endsWith('/workflow.html')), descriptor, {}, { registration }), /Missing Workflow/);
  await assert.rejects(importPackage(inputs.filter(f => !f.path.endsWith('.csv')), descriptor, {}, { registration }), /Missing dependency/);
});
