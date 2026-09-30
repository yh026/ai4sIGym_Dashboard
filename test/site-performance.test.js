'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { optimizeSiteOutput } = require('../lib/site-performance');
const project = path.join(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets/cards'), { recursive: true });
  return root;
}

test('Air Quality and Singapore Road are excluded byte-for-byte at every nested page', t => {
  const root = directory(t);
  const png = fs.readFileSync(path.join(project, 'site/assets/ais-science-map-v2-lines.png'));
  const source = '<html><body><img src="data:image/png;base64,' + png.toString('base64') + '"></body></html>';
  for (const slug of ['air-quality-day-segment-pca-and-amp-umap-by-sensor', 'singapore-road-speed-clusters-umap']) {
    for (const role of ['index.html', 'dataset.html', 'workflow.html', 'resources/extra.html']) {
      const file = path.join(root, 'demos', slug, role);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
  }
  const report = optimizeSiteOutput(root);
  assert.equal(report.assets.length, 0);
  assert.equal(report.pages.length, 8);
  for (const page of report.pages) {
    assert.ok(page.excluded);
    assert.equal(fs.readFileSync(path.join(root, page.path), 'utf8'), source);
  }
});

test('generated resources retain original image bytes and native source files', t => {
  const root = directory(t);
  const png = fs.readFileSync(path.join(project, 'site/assets/ais-science-map-v2-lines.png'));
  const card = Buffer.from('synthetic existing JPEG bytes');
  fs.writeFileSync(path.join(root, 'assets/cards/example.jpg'), card);
  const source = '<html><body><img src="assets/cards/example.jpg"><img src="data:image/png;base64,' + png.toString('base64') + '"></body></html>';
  fs.writeFileSync(path.join(root, 'index.html'), source);
  const report = optimizeSiteOutput(root);
  assert.equal(report.assets.length, 2);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const images = [...html.matchAll(/src="([^"]+)"/g)].map(m => fs.readFileSync(path.join(root, m[1].slice(1))));
  assert.deepEqual(images, [card, png]);
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets/cards/example.jpg')), card);
  assert.ok(report.pages[0].outputBytes < report.pages[0].inputBytes);
  for (const item of report.assets) assert.equal(path.basename(item.path).split('.')[0], hash(fs.readFileSync(path.join(root, item.path))));
});

test('home map uses only its pixel-verified derivative and falls back if the source changes', t => {
  const root = directory(t);
  const sourcePath = 'assets/ais-science-map-v2-lines.png';
  const derivativePath = 'assets/ais-science-map-v2-lines.lossless.webp';
  for (const name of [sourcePath, derivativePath]) fs.copyFileSync(path.join(project, 'site', name), path.join(root, name));
  const html = '<html><body><img class="map-art" src="' + sourcePath + '" width="1536" height="1024"></body></html>';
  fs.writeFileSync(path.join(root, 'index.html'), html);
  const report = optimizeSiteOutput(root);
  assert.equal(report.homeMap.pixelsIdentical, true);
  const updated = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(updated, /\/assets\/optimized\/[a-f0-9]{64}\.webp/);
  assert.match(updated, /width="1536" height="1024"/);
  assert.match(updated, /fetchpriority="high"/);
  fs.appendFileSync(path.join(root, sourcePath), 'changed');
  fs.writeFileSync(path.join(root, 'index.html'), html);
  assert.equal(optimizeSiteOutput(root).homeMap, null);
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /src="assets\/ais-science-map-v2-lines\.png"/);
});

test('card rewrites visit only real images in generated listing pages', t => {
  const root = directory(t);
  const bytes = Buffer.from('unchanged card file');
  fs.writeFileSync(path.join(root, 'assets/cards/example.jpg'), bytes);
  const image = '<img alt="angle > zero" src="/assets/cards/example.jpg">';
  const passive = '<!-- ' + image + ' --><script>const example=\'' + image + '\';</script><textarea>' + image + '</textarea>';
  const source = '<html><body>' + image + passive + '</body></html>';
  for (const relative of ['index.html', 'domains/biology-genomics/index.html', 'demos/example/index.html']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  const report = optimizeSiteOutput(root);
  assert.equal(report.assets.length, 1);
  const expected = source.replace(image, image.replace('/assets/cards/example.jpg', '/assets/optimized/' + hash(bytes) + '.jpg'));
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(root, 'domains/biology-genomics/index.html'), 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(root, 'demos/example/index.html'), 'utf8'), source);
});

test('CSP or base URL pages keep their original image paths and inline programs', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'assets/cards/example.jpg'), 'unchanged card file');
  const program = fs.readFileSync(path.join(__dirname, 'fixtures/page-startup/single-cell.js.txt'), 'utf8');
  const demo = path.join(root, 'demos/from-twenty-thousand-genes-to-fourteen-cell-types/index.html');
  fs.mkdirSync(path.dirname(demo), { recursive: true });
  for (const policy of [
    '<meta http-equiv="Content-Security-Policy" content="img-src /assets/cards/example.jpg; script-src \'sha256-example\'">',
    '<base href="https://external.example/">',
  ]) {
    const source = '<html><head>' + policy + '</head><body><img src="/assets/cards/example.jpg"><script>' + program + '</script></body></html>';
    fs.writeFileSync(path.join(root, 'index.html'), source);
    fs.writeFileSync(demo, source);
    const report = optimizeSiteOutput(root);
    assert.equal(report.assets.length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), source);
    assert.equal(fs.readFileSync(demo, 'utf8'), source);
    for (const page of report.pages) {
      assert.deepEqual(page.startup.applied, []);
      assert.ok(page.images.skippedReason);
      assert.equal(page.outputBytes, page.inputBytes);
    }
  }
});
