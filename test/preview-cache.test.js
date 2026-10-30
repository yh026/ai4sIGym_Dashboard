'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createServer } = require('../scripts/preview-local.cjs');
const { deployHeaders } = require('../build');

test('local previews revalidate changed files and reuse unchanged bytes without caching receipts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-cache-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'first version');
  fs.writeFileSync(path.join(root, 'deploy-receipt.json'), '{}');
  const asset = 'assets/optimized/' + 'a'.repeat(64) + '.png';
  fs.mkdirSync(path.dirname(path.join(root, asset)), { recursive: true });
  fs.writeFileSync(path.join(root, asset), 'synthetic pixels');
  const server = createServer(root).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(base + '/');
  const etag = first.headers.get('etag');
  assert.equal(await first.text(), 'first version');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const repeated = await fetch(base + '/', { headers: { 'If-None-Match': etag } });
  assert.equal(repeated.status, 304);
  assert.equal(await repeated.text(), '');
  fs.writeFileSync(path.join(root, 'index.html'), 'second version');
  const changed = await fetch(base + '/', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), 'second version');
  assert.notEqual(changed.headers.get('etag'), etag);
  const resource = await fetch(base + '/' + asset);
  assert.equal(resource.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  await resource.arrayBuffer();
  for (const [extension, mime] of [['js', 'text/javascript'], ['css', 'text/css']]) {
    const runtimePath = 'assets/runtime/' + 'c'.repeat(64) + '.' + extension;
    fs.mkdirSync(path.dirname(path.join(root, runtimePath)), { recursive: true });
    fs.writeFileSync(path.join(root, runtimePath), 'exact shared resource bytes');
    const response = await fetch(base + '/' + runtimePath);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(response.headers.get('content-type'), mime + '; charset=utf-8');
    assert.equal(await response.text(), 'exact shared resource bytes');
  }
  for (const extension of ['gif', 'avif']) {
    const imagePath = 'assets/optimized/' + 'b'.repeat(64) + '.' + extension;
    const bytes = Buffer.from('unchanged ' + extension + ' image bytes');
    fs.writeFileSync(path.join(root, imagePath), bytes);
    const image = await fetch(base + '/' + imagePath);
    assert.equal(image.headers.get('content-type'), 'image/' + extension);
    assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  }
  const receipt = await fetch(base + '/deploy-receipt.json');
  const receiptEtag = receipt.headers.get('etag');
  await receipt.text();
  const checked = await fetch(base + '/deploy-receipt.json', { headers: { 'If-None-Match': receiptEtag } });
  assert.equal(checked.status, 200);
  assert.equal(checked.headers.get('cache-control'), 'no-store');
  await checked.text();
});

test('local MP4 previews support playback metadata and seeking without changing bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-video-'));
  const bytes = Buffer.from('0123456789');
  fs.writeFileSync(path.join(root, 'film.mp4'), bytes);
  const server = createServer(root).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/film.mp4`;
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(await head.text(), '');
  for (const [range, expected, contentRange] of [
    ['bytes=0-1', '01', 'bytes 0-1/10'],
    ['bytes=6-', '6789', 'bytes 6-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
  ]) {
    const response = await fetch(url, { headers: { Range: range, 'If-Range': head.headers.get('etag') } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(await response.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0']) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
  const stale = await fetch(url, { headers: { Range: 'bytes=2-3', 'If-Range': '"old-video"' } });
  assert.equal(stale.status, 200);
  assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
});

test('protected preview cache rules target only generated assets; production rules stay unchanged', () => {
  const preview = deployHeaders({ audience: 'preview', context: 'branch-deploy' });
  assert.match(preview, /\/assets\/embedded\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.match(preview, /\/assets\/optimized\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.match(preview, /\/assets\/runtime\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.doesNotMatch(preview, /Cache-Control: public/);
  assert.doesNotMatch(deployHeaders({ audience: 'production', context: 'production' }), /immutable/);
});
