'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { optimizeEmbeddedImages } = require('../lib/embedded-image-assets');

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=', 'base64');
const uri = 'data:image/png;base64,' + pixel.toString('base64');
const hash = createHash('sha256').update(pixel).digest('hex');
const url = '/assets/embedded/' + hash + '.png';
const options = { minBytes: 1 };

test('image bytes, content hash, relative origin and unrelated markup stay exact', () => {
  const html = '<!doctype html><img alt="angle > zero" src="' + uri + '" width="1" height="1"><p>科学 result = 0.123456789</p>';
  const result = optimizeEmbeddedImages(html, options);
  assert.equal(result.html, html.replace(uri, url));
  assert.equal(result.assets.length, 1);
  const asset = result.assets[0];
  assert.equal(asset.filename, hash + '.png');
  assert.equal(asset.sha256, hash);
  assert.equal(asset.mimeType, 'image/png');
  assert.deepEqual(asset.bytes, pixel);
  assert.equal(new URL(asset.url, 'https://preview.example/demos/study/workflow.html').href, 'https://preview.example' + url);
  assert.equal(result.stats.htmlBytesBefore, Buffer.byteLength(html));
  assert.equal(result.stats.htmlBytesAfter, Buffer.byteLength(result.html));
  assert.equal(result.stats.extractedOccurrences, 1);
});

test('repeated images deduplicate within a page and share the same name across pages', () => {
  const result = optimizeEmbeddedImages('<img src="' + uri + '"><IMG SRC=\'' + uri + '\'>', options);
  assert.equal(result.assets.length, 1);
  assert.equal(result.stats.extractedOccurrences, 2);
  assert.equal(result.stats.assetBytes, pixel.length);
  const second = optimizeEmbeddedImages('<img src="' + uri + '">', options);
  assert.equal(second.assets[0].filename, result.assets[0].filename);
  assert.equal(optimizeEmbeddedImages(result.html, options).html, result.html);
  assert.equal(optimizeEmbeddedImages(result.html, options).assets.length, 0);
});

test('small placeholders, non-images, SVG, malformed base64 and fake raster content are preserved', () => {
  const defaultResult = optimizeEmbeddedImages('<img src="' + uri + '">');
  assert.equal(defaultResult.assets.length, 0);
  for (const value of [
    'data:application/octet-stream;base64,' + pixel.toString('base64'),
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
    'data:image/png;base64,SGVsbG8=',
    uri + '%', uri.slice(0, -1),
    'data:image/png;charset=utf8;base64,' + pixel.toString('base64'),
  ]) {
    const html = '<img src="' + value + '">';
    assert.equal(optimizeEmbeddedImages(html, options).html, html);
  }
});

test('script images require opt-in and JSON scientific numbers are never reserialized', () => {
  const json = '{"sprite":"' + uri + '","precise":9007199254740993,"float":1.234567890123456789,"codes":"AABBCQ=="}';
  const html = '<script type="application/json" id="payload">' + json + '</script>';
  assert.equal(optimizeEmbeddedImages(html, options).html, html);
  const result = optimizeEmbeddedImages(html, { ...options, includeScriptImages: true });
  assert.equal(result.html, html.replace(uri, url));
  assert.deepEqual(result.assets[0].bytes, pixel);
  assert.equal(JSON.parse(result.html.match(/>(.*)<\/script>/)[1]).sprite, url);
});

test('JSON keys, escaped text and invalid JSON stay untouched', () => {
  for (const json of [
    '{"' + uri + '":"a key"}',
    '{"description":"embedded \\"' + uri + '\\" text"}',
    '{broken:"' + uri + '"}',
  ]) {
    const html = '<script type="application/json">' + json + '</script>';
    const result = optimizeEmbeddedImages(html, { ...options, includeScriptImages: true });
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
  }
});

test('audited standalone sprite declarations remain executable and share their decoded image bytes', () => {
  const script = 'const THUMB_SPRITE_URL = "' + uri + '";\nconst CASE_SPRITE_URL = \'' + uri + '\';';
  const result = optimizeEmbeddedImages('<script>' + script + '</script>', { ...options, includeScriptImages: true });
  const after = result.html.slice('<script>'.length, -'</script>'.length);
  const values = vm.runInNewContext(after + '\n[THUMB_SPRITE_URL, CASE_SPRITE_URL]');
  assert.deepEqual(Array.from(values), [url, url]);
  assert.equal(result.assets.length, 1);
  assert.equal(result.stats.extractedOccurrences, 2);
});

test('initial JSON payload declarations keep all subsequent renderer code unchanged', () => {
  const json = '{"sprite":"' + uri + '","nested":[{"label":"braces } [ and escaped \\" quote"}],"precision":9007199254740993}';
  const renderer = '\nconst map=new Image(); map.src=E.sprite; /* exact renderer text */';
  const html = '<script>const E=' + json + ';' + renderer + '</script>';
  const result = optimizeEmbeddedImages(html, { ...options, includeScriptImages: true });
  assert.equal(result.html, html.replace(uri, url));
  const source = result.html.slice('<script>'.length, -'</script>'.length);
  const output = vm.runInNewContext(source + '\nmap.src', { Image: class Image {} });
  assert.equal(output, url);
  assert.equal(result.assets.length, 1);
  for (const body of [
    'const E={"sprite":"' + uri + '"} + changeObject();',
    'const E={sprite:"' + uri + '"}; draw(E);',
    'doWork(); const E={"sprite":"' + uri + '"};',
  ]) {
    const untouched = '<script>' + body + '</script>';
    assert.equal(optimizeEmbeddedImages(untouched, { ...options, includeScriptImages: true }).html, untouched);
  }
});

test('arbitrary JavaScript, comments, template text and raw-text markup are not blindly rewritten', () => {
  const img = '<img src="' + uri + '">';
  const sources = [
    '<!-- ' + img + ' -->',
    '<script>const raw="' + uri + '"; atob(raw.split(",")[1]);</script>',
    '<script>/*\nconst example="' + uri + '";\n*/</script>',
    '<script>const template=`' + img + '`;</script>',
    '<script type="application/ld+json">{"image":"' + uri + '"}</script>',
    '<script integrity="sha256-example">const sprite="' + uri + '";</script>',
    '<textarea>' + img + '</textarea>', '<style>/* ' + img + ' */</style>',
    '<script>unterminated ' + img,
  ];
  for (const html of sources) {
    const result = optimizeEmbeddedImages(html, { ...options, includeScriptImages: true });
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
  }
});

test('CSP and base URL policies preserve the entire page', () => {
  for (const header of [
    '<meta http-equiv="Content-Security-Policy" content="img-src data:; script-src \'sha256-abc\'">',
    '<meta http-equiv="Content-Security-Policy" http-equiv="refresh" content="img-src data:">',
    '<meta http-equiv="Content&#45;Security&#45;Policy" content="img-src data:">',
    '<BASE href="https://other.example/">',
    '<base href="&#104;ttps://other.example/">',
  ]) {
    const html = header + '<img src="' + uri + '">';
    const result = optimizeEmbeddedImages(html, options);
    assert.equal(result.html, html);
    assert.equal(result.assets.length, 0);
    assert.ok(result.stats.skippedReason);
  }
});

test('optional lazy image loading keeps the first image and explicit author settings intact', () => {
  const html = '<img src="' + uri + '"><img src="' + uri + '" /><img src="' + uri + '" loading="eager" decoding="sync">';
  const result = optimizeEmbeddedImages(html, { ...options, lazyAfterFirstImage: true });
  assert.equal(result.html, '<img src="' + url + '"><img src="' + url + '" loading="lazy" decoding="async" /><img src="' + url + '" loading="eager" decoding="sync">');
  assert.equal(optimizeEmbeddedImages(html, options).html.includes('loading="lazy"'), false);
});

test('a no-match page stays byte-for-byte unchanged and unsafe output prefixes are rejected', () => {
  const html = '<!doctype html>\r\n<img src="/existing.png"><p>Result 9.1 ± 0.2</p>';
  const result = optimizeEmbeddedImages(html);
  assert.equal(result.html, html);
  assert.deepEqual(result.assets, []);
  assert.equal(result.stats.htmlBytesSaved, 0);
  for (const prefix of ['https://evil.example/', '//evil.example/', '/assets/../', '/assets/?x=', '/assets/"', 'assets/', '/assets/%2F/']) {
    assert.throws(() => optimizeEmbeddedImages(html, { assetUrlPrefix: prefix }), /same-origin/);
  }
  assert.throws(() => optimizeEmbeddedImages(html, { minBytes: -1 }), /minBytes/);
});

test('duplicate src attributes are left to the browser and never rewritten ambiguously', () => {
  const html = '<img src="' + uri + '" src="/other.png">';
  assert.equal(optimizeEmbeddedImages(html, options).html, html);
});
