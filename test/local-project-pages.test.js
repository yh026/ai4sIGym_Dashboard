'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TBB_SLUG, loadLocalProjectPages } = require('../lib/local-project-pages');
const { createServer } = require('../scripts/preview-local.cjs');
const root = path.resolve(__dirname, '..');

function packageFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-local-pages-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, 'projects/tbb-cluster-explorer');
  const dataset = path.join(workspace, 'datasets/himawari-9-ahi');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(dataset, { recursive: true });
  const project = { schema_version: 1, project_id: 'test-tbb', slug: TBB_SLUG,
    pages: { key_findings: 'key-findings.html', workflow: 'workflow.html' },
    dataset: { slug: 'himawari-9-ahi', page: 'datasets/himawari-9-ahi/index.html' } };
  const writeProject = () => fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(project));
  writeProject();
  const wrap = body => '<!doctype html><html><head><title>Sample</title></head><body>' + body + '</body></html>';
  const finding = wrap('<canvas id="chart"></canvas><script>const payload = {values:[1,2,3]};</script>');
  fs.writeFileSync(path.join(directory, project.pages.key_findings), finding);
  fs.writeFileSync(path.join(directory, project.pages.workflow), wrap('<a href="../../datasets_v2/himawari-9-ahi/himawari-9-ahi.html#overview">Dataset record</a>'));
  fs.writeFileSync(path.join(dataset, 'index.html'), wrap('<h1>Dataset</h1><section id="overview">Source</section>'));
  return { workspace, directory, project, finding, writeProject, demos: [{ demo_id: 'test-tbb', slug: TBB_SLUG }] };
}

test('TBB card destination becomes Key Findings with navigable Dataset, Workflow and return links', t => {
  const sample = packageFixture(t);
  const pages = loadLocalProjectPages(sample.workspace, sample.demos).get(TBB_SLUG);
  const index = pages.find(page => page.path === 'demos/' + TBB_SLUG + '/index.html');
  assert.match(index.html, /data-page-role="key_findings"/);
  const nav = index.html.match(/<nav id="ais-page-navigation"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.indexOf('>Dataset<') < nav.indexOf('>Workflow<'));
  assert.match(index.html, /<canvas id="chart"><\/canvas><script>const payload = \{values:\[1,2,3\]\};<\/script>/);
  assert.equal(fs.readFileSync(path.join(sample.directory, 'key-findings.html'), 'utf8'), sample.finding);
  const emitted = new Set(['index.html', ...pages.map(page => page.path)]);
  for (const page of pages) {
    for (const [, href] of page.html.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(href, 'http://example.test/' + page.path);
      assert.equal(url.origin, 'http://example.test');
      assert.ok(emitted.has(url.pathname.slice(1)), page.path + ' has a broken link: ' + href);
    }
  }
  assert.ok(pages.every(page => !page.html.includes('datasets_v2/')));
});

test('only the matching TBB project can use the local page package', t => {
  const sample = packageFixture(t);
  assert.equal(loadLocalProjectPages(sample.workspace, [{ slug: 'another-demo' }]).size, 0);
  sample.project.project_id = 'wrong-project'; sample.writeProject();
  assert.throws(() => loadLocalProjectPages(sample.workspace, sample.demos), /does not match/);
  sample.project.project_id = 'test-tbb'; sample.project.pages.workflow = '../outside.html'; sample.writeProject();
  assert.throws(() => loadLocalProjectPages(sample.workspace, sample.demos), /Unsafe local content path/);
});

test('an incomplete page package fails before it can be emitted', t => {
  const sample = packageFixture(t);
  fs.unlinkSync(path.join(sample.directory, 'workflow.html'));
  assert.throws(() => loadLocalProjectPages(sample.workspace, sample.demos), /ENOENT/);
});

test('Netlify cannot enable local authoring pages through CLI flags', () => {
  for (const args of [['--local'], ['--include-drafts']]) {
    const result = spawnSync(process.execPath, ['build.js', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'main' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot run in a Netlify deployment|requires --local/);
  }
});

test('local server opens the real homepage and nested routes without exposing source folders', async t => {
  const sample = packageFixture(t);
  const site = path.join(sample.workspace, 'site');
  const projectPath = path.join(site, 'demos', TBB_SLUG);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Website homepage</h1>');
  fs.writeFileSync(path.join(projectPath, 'index.html'), '<h1>Key Findings</h1>');
  const server = createServer(site);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await (await fetch(base + '/')).text(), '<h1>Website homepage</h1>');
  assert.equal(await (await fetch(base + '/demos/' + TBB_SLUG + '/')).text(), '<h1>Key Findings</h1>');
  const directory = await fetch(base + '/demos/' + TBB_SLUG, { redirect: 'manual' });
  assert.equal(directory.status, 302);
  assert.equal(directory.headers.get('location'), '/demos/' + TBB_SLUG + '/');
  assert.equal(await (await fetch(base + '/demos/' + TBB_SLUG)).text(), '<h1>Key Findings</h1>');
  const alias = await fetch(base + '/site/index.html?x=1', { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), '/index.html?x=1');
  for (const route of ['/work/projects/tbb-cluster-explorer/project.json', '/%2e%2e%2fprojects/tbb-cluster-explorer/project.json']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
});
