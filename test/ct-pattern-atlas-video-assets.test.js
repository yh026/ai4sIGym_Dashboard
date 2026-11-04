'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { optimizeSiteOutput } = require('../lib/site-performance');
const { optimizeCtPatternAtlasVideo } = require('../lib/ct-pattern-atlas-video-assets');
const { markupSegments, attributes } = require('../lib/embedded-image-assets');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/ct-pattern-atlas-video/insight.html'), 'utf8');
const identity = { slug: 'ct-pattern-atlas', role: 'insight' };
const expectedVideo = Buffer.concat([Buffer.from('0000001866747970', 'hex'), Buffer.from('ct-video-byte-sequence')]);
const expectedPoster = Buffer.from([255, 216, 255, 224, 0, 4, 67, 84, 255, 217]);

test('local site build reassembles padded chunks in order and preserves all unrelated content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'demos/ct-pattern-atlas/index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, source);
  const report = optimizeSiteOutput(root), html = fs.readFileSync(page, 'utf8');
  assert.equal(report.pages[0].video.applied, true);
  assert.equal(report.pages[0].video.videoChunks, 3);
  assert.equal(report.assets.length, 2);
  const video = markupSegments(html).find(s => s.tagName === 'video');
  const attrs = attributes(video.tag);
  assert.equal(attrs.has('src'), false);
  assert.equal(attrs.get('preload').value, 'none');
  assert.equal(attrs.has('autoplay'), false);
  for (const [name, expected] of [['data-video-src', expectedVideo], ['poster', expectedPoster]]) {
    const url = attrs.get(name).value;
    assert.deepEqual(fs.readFileSync(path.join(root, url)), expected);
    assert.equal(path.basename(url).split('.')[0], createHash('sha256').update(expected).digest('hex'));
  }
  for (const unchanged of ['<p>Retained narrative and CT/MRI alignment goal.</p>',
    '<script type="application/json" id="scientific-data">{ "points": [1, 2.50, -3], "text": "retain exact spacing" }</script>',
    '<script id="theme-control">window.themeControlRetained = true;</script>']) assert.ok(html.includes(unchanged));
  assert.doesNotMatch(html, /data-video-chunk|atob\(|createObjectURL|application\/octet-stream/);
  optimizeSiteOutput(root);
  assert.equal(fs.readFileSync(page, 'utf8'), html);
});

test('only the selected Insight and the known player are rewritten', () => {
  for (const id of [{ slug: 'tbb-cluster-explorer-2', role: 'insight' }, { ...identity, role: 'workflow' }]) {
    const result = optimizeCtPatternAtlasVideo(source, id);
    assert.equal(result.html, source);
    assert.equal(result.assets.length, 0);
  }
  const variants = [
    source.replace('const decode = b64', 'const unknownDecoder = b64'),
    source.replace('preload="metadata"', 'preload="metadata" autoplay'),
    source.replace('id="play"', 'id="another-button"'),
    source.replace('id="film"', 'id="film" id="ambiguous"'),
    source.replace('<head>', '<head><base href="https://example.com/">'),
    source.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src none">'),
  ];
  for (const html of variants) {
    const result = optimizeCtPatternAtlasVideo(html, identity);
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
    assert.equal(result.stats.applied, false);
  }
});

test('malformed media is left intact instead of emitting incomplete assets', () => {
  const variants = [
    source.replace(/data-video-chunk>[^<]+/, 'data-video-chunk>%%%'),
    source.replace(expectedVideo.subarray(0, 11).toString('base64'), Buffer.alloc(11).toString('base64')),
    source.replace(expectedPoster.toString('base64'), Buffer.from('not a JPEG').toString('base64')),
    source.replace(/<script type="application\/octet-stream" data-video-chunk>[\s\S]*?<\/script>/g, ''),
  ];
  for (const html of variants) {
    const result = optimizeCtPatternAtlasVideo(html, identity);
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
    assert.equal(result.stats.applied, false);
  }
});
