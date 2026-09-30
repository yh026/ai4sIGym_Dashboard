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

test('protected preview cache rules target only generated assets; production rules stay unchanged', () => {
  const preview = deployHeaders({ audience: 'preview', context: 'branch-deploy' });
  assert.match(preview, /\/assets\/embedded\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.match(preview, /\/assets\/optimized\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.match(preview, /\/assets\/runtime\/\*\n  Cache-Control: private, max-age=31536000, immutable/);
  assert.doesNotMatch(preview, /Cache-Control: public/);
  assert.doesNotMatch(deployHeaders({ audience: 'production', context: 'production' }), /immutable/);
});
