'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { optimizeSiteOutput } = require('../lib/site-performance');
const { optimizeTbbVideo } = require('../lib/tbb-video-assets');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/tbb-video/insight.html'), 'utf8');
const identity = { slug: 'tbb-cluster-explorer-2', role: 'insight' };
const payload = html => JSON.parse(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html)[1]);

test('Preview build writes byte-identical media and renders a native player with no preload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbb-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'demos/tbb-cluster-explorer-2/index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, source);
  const report = optimizeSiteOutput(root), html = fs.readFileSync(page, 'utf8');
  assert.equal(report.assets.length, 2);
  assert.equal(report.pages[0].video.applied, true);
  const before = payload(source), after = payload(html);
  assert.deepEqual({ ...after, video: before.video }, before);
  assert.deepEqual(fs.readFileSync(path.join(root, after.video.src)), Buffer.from(before.video.mp4_b64, 'base64'));
  assert.deepEqual(fs.readFileSync(path.join(root, after.video.poster)), Buffer.from(before.video.poster.split(',')[1], 'base64'));
  assert.match(html, /<video[^>]*preload="none"[^>]*src="\/assets\/embedded\/[a-f0-9]{64}\.mp4"[^>]*poster="\/assets\/embedded\/[a-f0-9]{64}\.png"/);
  assert.doesNotMatch(html, /mp4_b64|createObjectURL|mountVideo/);
  assert.ok(html.indexOf('poster="') < html.indexOf('id="payload"'));
  optimizeSiteOutput(root);
  assert.equal(fs.readFileSync(page, 'utf8'), html);
});

test('other projects, other TBB pages and unfamiliar player implementations stay intact', () => {
  for (const id of [{ slug: 'other', role: 'insight' }, { ...identity, role: 'workflow' }]) {
    assert.equal(optimizeTbbVideo(source, id).html, source);
  }
  for (const html of [source.replace('mountVideo()', 'differentPlayer()'),
    source.replace('preload="metadata"', 'preload="metadata" autoplay'),
    source.replace('<head>', '<head><base href="https://example.com/">')]) {
    const result = optimizeTbbVideo(html, identity);
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
  }
});

test('invalid embedded media is preserved instead of producing broken asset URLs', () => {
  const original = payload(source);
  for (const video of [{ ...original.video, mp4_b64: 'invalid' },
    { ...original.video, bytes: 999 }, { ...original.video, poster: 'data:image/png;base64,AAAA' }]) {
    const html = source.replace(JSON.stringify(original), JSON.stringify({ ...original, video }));
    const result = optimizeTbbVideo(html, identity);
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
  }
});
