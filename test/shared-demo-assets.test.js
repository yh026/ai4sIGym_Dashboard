'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { optimizeSharedDemoAssets } = require('../lib/shared-demo-assets');
const { markupSegments } = require('../lib/embedded-image-assets');
const dir = path.join(__dirname, 'fixtures/shared-demo-assets');
const fixtures = fs.readdirSync(dir).sort().map(name => ({
  filename: name.slice(0, -4), body: fs.readFileSync(path.join(dir, name), 'utf8'),
  tag: name.includes('.js.') ? 'script' : 'style',
}));
const identity = { slug: 'battery-curve-shape-explorer', role: 'insight' };
const element = f => '<' + f.tag + '>' + f.body + '</' + f.tag + '>';
const source = '<html><head><meta charset="utf-8">' + fixtures.filter(f => f.tag === 'style').map(element).join('')
  + '</head><body><script type="application/json" id="payload">{"exact":0.12345678912345678}</script>'
  + fixtures.filter(f => f.tag === 'script').map(element).join('') + '<script>window.authorRunsLast = true;</script></body></html>';

test('shared programs and styles keep every byte and their original execution/cascade positions', () => {
  const result = optimizeSharedDemoAssets(source, identity);
  assert.equal(result.assets.length, 7);
  const assets = new Map(result.assets.map(a => ['/assets/runtime/' + a.filename, a.bytes.toString('utf8')]));
  for (const asset of result.assets) assert.equal(asset.filename.split('.')[0], createHash('sha256').update(asset.bytes).digest('hex'));
  let restored = result.html.replace(/\n<link rel="preload" as="script" href="[^"]+">/g, '');
  restored = restored.replace(/<script src="([^"]+)"><\/script>/g, (_, url) => '<script>' + assets.get(url) + '</script>')
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, url) => '<style>' + assets.get(url) + '</style>');
  assert.equal(restored, source);
  const scripts = markupSegments(result.html).filter(s => s.tagName === 'script');
  assert.equal(scripts[0].body, '{"exact":0.12345678912345678}');
  assert.equal(scripts.at(-1).body, 'window.authorRunsLast = true;');
  for (const s of scripts.filter(s => s.tag.includes('src='))) assert.doesNotMatch(s.tag, /async|defer|module/);
  assert.equal((result.html.match(/rel="preload"/g) || []).length, 5);
  assert.ok(result.html.indexOf('rel="preload"') < result.html.indexOf('</head>'));
  assert.deepEqual(optimizeSharedDemoAssets(result.html, identity).assets, []);
  assert.equal(optimizeSharedDemoAssets(result.html, identity).html, result.html);
});

test('every resource hash is scoped to the six reviewed demos and their three page roles', () => {
  for (const slug of ['battery-curve-shape-explorer', 'ceemdan-battery-forecasting', 'soh-battery',
    'jae-joint-embedding-how-one-cell-becomes-61-numbers', 'pleiades-membership-explorer', 'superconductor-regression-explorer']) {
    for (const role of ['insight', 'dataset', 'workflow']) assert.equal(optimizeSharedDemoAssets(source, { slug, role }).assets.length, 7);
  }
  for (const other of [{ ...identity, slug: 'unknown' }, { ...identity, role: 'resource' },
    { ...identity, slug: 'air-quality-day-segment-pca-and-amp-umap-by-sensor' },
    { ...identity, slug: 'singapore-road-speed-clusters-umap' }]) assert.equal(optimizeSharedDemoAssets(source, other).html, source);
});

test('unknown, inert, policy-controlled and attributed resources remain inline', () => {
  const program = fixtures.find(f => f.tag === 'script');
  const style = fixtures.find(f => f.tag === 'style');
  const cases = [
    '<!-- ' + element(program) + ' -->',
    '<textarea>' + element(program) + '</textarea>',
    '<template>' + element(program) + element(style) + '</template>',
    '<script>' + program.body + '\n// unreviewed change</script>',
    '<script nonce="example">' + program.body + '</script>',
    '<script type="module">' + program.body + '</script>',
    '<style id="referenced-style">' + style.body + '</style>',
    '<style media="print">' + style.body + '</style>',
  ];
  for (const body of cases) {
    const html = '<html><head></head><body>' + body + '</body></html>';
    assert.equal(optimizeSharedDemoAssets(html, identity).html, html);
  }
  for (const policy of ['<base href="https://example.com/">', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">']) {
    const html = source.replace('<head>', '<head>' + policy);
    assert.equal(optimizeSharedDemoAssets(html, identity).html, html);
  }
});
