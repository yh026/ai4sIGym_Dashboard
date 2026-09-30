'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { AUTHORIZED_DEMOS, sha256, productionPolicy, validateReleaseManifest,
  readUstar, productionHeaders, buildProductionRelease } = require('../lib/production-release');

const env = { NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'main', COMMIT_REF: 'b'.repeat(40),
  SITE_ID: '00000000-0000-4000-8000-000000000001', BUILD_ID: 'production-build', DEPLOY_ID: 'production-deploy' };
const source = { verified: true, commit_ref: 'a'.repeat(40), registry_revision: 'sha256:' + 'c'.repeat(64), deploy_id: 'reviewed-preview' };

function ustar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes || ''), header = Buffer.alloc(512);
    const write = (text, start, length) => header.write(text, start, length, 'utf8');
    write(entry.path, 0, 100); write('0000644\0', 100, 8); write('0000000\0', 108, 8); write('0000000\0', 116, 8);
    write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12); write('00000000000\0', 136, 12);
    header.fill(32, 148, 156); header[156] = (entry.type || '0').charCodeAt(0);
    if (entry.link) write(entry.link, 157, 100);
    write('ustar\0', 257, 6); write('00', 263, 2);
    if (entry.prefix) write(entry.prefix, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function sample(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-production-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entries = new Map([['index.html', Buffer.from('<!doctype html><html><body>All projects</body></html>')]]);
  const demos = AUTHORIZED_DEMOS.map((slug, index) => {
    const entry = 'demos/' + slug + '/index.html';
    entries.set(entry, Buffer.from('<html><body><canvas></canvas><script>const science=[0.12345678912345678,2];</script></body></html>'));
    return { slug, demo_id: 'demo-' + index, title: slug, audience: 'General', status: 'Draft',
      public_page_permission: 'Preview only', pages: [{ role: 'legacy', path: entry, state: 'Ready' }] };
  });
  entries.set('manifest.json', Buffer.from(JSON.stringify({ schema_version: 3, domains: [{ id: 'physics' }], demos })));
  entries.set('domains/physics/index.html', Buffer.from('<html>Physics</html>'));
  entries.set('assets/optimized/' + sha256(Buffer.from('unchanged pixels')) + '.png', Buffer.from('unchanged pixels'));
  entries.set('demos/tbb-cluster-explorer-2/resources/aisgym.ipynb', Buffer.from('{"cells":[],"metadata":{}}'));
  const manifest = { schema: 1, archive: { path: 'release.tar.gz', sha256: '' }, source: { ...source },
    demo_slugs: [...AUTHORIZED_DEMOS], files: [] };
  const manifestPath = path.join(directory, 'production-release.json');
  function write(custom = [...entries].map(([name, bytes]) => ({ path: name, bytes }))) {
    const archive = zlib.gzipSync(ustar(custom));
    fs.writeFileSync(path.join(directory, manifest.archive.path), archive);
    manifest.archive.sha256 = sha256(archive);
    manifest.files = [...entries].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: sha256(bytes) }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  write();
  const outputDirectory = path.join(directory, 'dist');
  return { directory, manifestPath, outputDirectory, entries, manifest, write,
    build: options => buildProductionRelease({ manifestPath, outputDirectory, env, ...options }) };
}

test('release policy accepts only current Production identity or explicit local validation', () => {
  assert.equal(productionPolicy(env).deploy_id, env.DEPLOY_ID);
  assert.equal(productionPolicy({}, { local: true }).platform, 'local-release-validation');
  for (const changes of [{ CONTEXT: 'branch-deploy' }, { BRANCH: 'develop' }, { NETLIFY: 'false' },
    { COMMIT_REF: '' }, { SITE_ID: '' }, { BUILD_ID: '' }, { DEPLOY_ID: '' }]) {
    assert.throws(() => productionPolicy({ ...env, ...changes }));
  }
  assert.throws(() => productionPolicy({}));
  assert.throws(() => productionPolicy(env, { local: true }), /forbidden/);
  assert.throws(() => productionPolicy({ CONTEXT: 'deploy-preview' }, { local: true }), /forbidden/);
});

test('frozen release preserves every scientific/image/download byte and creates honest production metadata', t => {
  const s = sample(t), result = s.build();
  assert.equal(result.demos, 13);
  for (const [name, bytes] of s.entries) if (name !== 'manifest.json') {
    assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, name)), bytes, name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'manifest.json')));
  assert.equal(manifest.audience, 'production');
  assert.ok(manifest.demos.every(d => d.status === 'Live' && d.public_page_permission === 'Public' && d.audience === 'General'));
  const receipt = JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'deploy-receipt.json')));
  assert.equal(receipt.verified, false);
  assert.equal(receipt.revision_bound, true);
  assert.equal(receipt.commit_ref, env.COMMIT_REF);
  assert.equal(receipt.deploy_id, env.DEPLOY_ID);
  assert.equal(receipt.target, 'production');
  assert.equal(receipt.context, 'production');
  assert.deepEqual(receipt.source_preview, source);
  assert.equal(receipt.release_manifest_sha256, sha256(fs.readFileSync(s.manifestPath)));
  assert.equal(receipt.archive_sha256, s.manifest.archive.sha256);
  const headers = fs.readFileSync(path.join(s.outputDirectory, '_headers'), 'utf8');
  assert.doesNotMatch(headers, /(?:^|\n)\/\*\n/);
  assert.match(headers, /\/deploy-receipt\.json\n  X-Robots-Tag: noindex/);
  for (const kind of ['embedded', 'optimized', 'runtime']) assert.ok(headers.includes('/assets/' + kind + '/*\n  Cache-Control: public, max-age=31536000, immutable'));
  assert.equal(fs.readFileSync(path.join(s.outputDirectory, 'robots.txt'), 'utf8'), 'User-agent: *\nAllow: /\n');
  const local = s.build({ env: {}, local: true });
  assert.equal(local.receipt.platform, 'local-release-validation');
  assert.equal(local.receipt.deploy_id, null);
});

test('checksum or inventory failures leave an existing dist intact', t => {
  const s = sample(t);
  fs.mkdirSync(s.outputDirectory); fs.writeFileSync(path.join(s.outputDirectory, 'existing'), 'previous deployment');
  fs.appendFileSync(path.join(s.directory, 'release.tar.gz'), 'changed');
  assert.throws(() => s.build(), /archive checksum/);
  s.write();
  s.manifest.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest));
  assert.throws(() => s.build(), /file checksum/);
  s.write([...s.entries].slice(1).map(([name, bytes]) => ({ path: name, bytes })));
  assert.throws(() => s.build(), /inventory files missing/);
  assert.deepEqual(fs.readdirSync(s.outputDirectory), ['existing']);
  assert.equal(fs.readFileSync(path.join(s.outputDirectory, 'existing'), 'utf8'), 'previous deployment');
});

test('USTAR parser rejects traversal, links, extensions, duplicates and unlisted files before output', t => {
  const s = sample(t), normal = [...s.entries].map(([name, bytes]) => ({ path: name, bytes }));
  const bad = [
    { path: '../escaped', bytes: 'unsafe' }, { path: '/absolute', bytes: 'unsafe' },
    { path: 'assets/x', type: '2', link: '/outside' }, { path: 'assets/x', type: '1', link: 'index.html' },
    { path: 'assets/x', type: 'x', bytes: 'PAX metadata' }, { path: 'assets/x', type: 'L', bytes: 'GNU metadata' },
    { path: 'index.html', bytes: s.entries.get('index.html') }, { path: 'assets/extra.js', bytes: 'unexpected' },
  ];
  for (const entry of bad) {
    s.write([...normal, entry]);
    assert.throws(() => s.build());
    assert.equal(fs.existsSync(s.outputDirectory), false);
  }
  const tar = ustar(normal), inventory = validateReleaseManifest(s.manifest);
  tar[1] ^= 1;
  assert.throws(() => readUstar(tar, inventory), /header checksum/);
  const trailing = Buffer.concat([ustar(normal), Buffer.alloc(512, 1)]);
  assert.throws(() => readUstar(trailing, inventory), /trailer/);
});

test('release rejects unexpected public roots, unauthorized demos and stale control files', t => {
  const s = sample(t);
  for (const file of ['secret.json', 'other/index.html', 'demos/unauthorized/index.html',
    'datasets/unselected/index.html', 'assets/extra.html', '_headers', '_redirects', 'robots.txt', 'deploy-receipt.json']) {
    s.entries.set(file, Buffer.from('unexpected')); s.write();
    assert.throws(() => s.build(), /route|inventory|control files/);
    s.entries.delete(file);
  }
  s.write(); s.manifest.demo_slugs.pop();
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest));
  assert.throws(() => s.build(), /13 authorized/);
  s.manifest.demo_slugs = [...AUTHORIZED_DEMOS]; s.manifest.source.verified = false;
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest));
  assert.throws(() => s.build(), /verified preview/);
});

test('manifest links must point at present matching project pages and dataset routes', t => {
  const s = sample(t), original = JSON.parse(s.entries.get('manifest.json'));
  const publicManifest = structuredClone(original);
  publicManifest.demos[0].pages.push({ role: 'dataset', path: 'datasets/verified-dataset/index.html', state: 'Ready' });
  s.entries.set('datasets/verified-dataset/index.html', Buffer.from('<html>Dataset provenance</html>'));
  s.entries.set('manifest.json', Buffer.from(JSON.stringify(publicManifest))); s.write();
  assert.doesNotThrow(() => s.build());
  s.entries.delete('datasets/verified-dataset/index.html'); s.write();
  assert.throws(() => s.build(), /public page is missing/);
  publicManifest.demos[0].pages[0].path = 'demos/' + AUTHORIZED_DEMOS[1] + '/index.html';
  s.entries.set('manifest.json', Buffer.from(JSON.stringify(publicManifest))); s.write();
  assert.throws(() => s.build(), /does not match/);
});

test('inputs and output cannot redirect writes through symlinks or consume the release inputs', t => {
  const s = sample(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-outside-release-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, s.outputDirectory);
  assert.throws(() => s.build(), /symlink/);
  fs.unlinkSync(s.outputDirectory);
  const archivePath = path.join(s.directory, 'release.tar.gz'), moved = path.join(elsewhere, 'release.tar.gz');
  fs.renameSync(archivePath, moved); fs.symlinkSync(moved, archivePath);
  assert.throws(() => s.build(), /escapes/);
  fs.unlinkSync(archivePath); fs.renameSync(moved, archivePath);
  assert.throws(() => s.build({ outputDirectory: s.directory }), /contain release inputs/);
});

test('production cache policy never inherits preview global noindex', () => {
  assert.equal((productionHeaders().match(/noindex/g) || []).length, 1);
  assert.doesNotMatch(productionHeaders(), /private/);
});

test('immutable resource names must bind the actual file bytes', t => {
  const s = sample(t);
  s.entries.set('assets/runtime/' + 'e'.repeat(64) + '.js', Buffer.from('exact code with wrong filename'));
  s.write();
  assert.throws(() => s.build(), /filename does not match/);
});

test('the two reviewed legacy department redirects survive release without allowing other collections', t => {
  const s = sample(t);
  const html = Buffer.from('<!doctype html><meta http-equiv="refresh" content="0;url=../../index.html#projects">');
  for (const route of ['domains/physics-simulation/index.html', 'domains/earth-climate/index.html']) s.entries.set(route, html);
  s.write(); s.build();
  for (const route of ['domains/physics-simulation/index.html', 'domains/earth-climate/index.html']) {
    assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, route)), html);
  }
  s.entries.set('domains/unreviewed-collection/index.html', html); s.write();
  assert.throws(() => s.build(), /outside the authorized public routes/);
});

test('CLI requires explicit local validation and accepts ordinary system USTAR packaging', t => {
  const s = sample(t), input = path.join(s.directory, 'input');
  fs.mkdirSync(input);
  for (const [name, bytes] of s.entries) {
    const file = path.join(input, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const packed = spawnSync('tar', ['--format=ustar', '-czf', path.join(s.directory, 'release.tar.gz'), '-C', input,
    ...s.entries.keys()], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(packed.status, 0, packed.stderr);
  s.manifest.archive.sha256 = sha256(fs.readFileSync(path.join(s.directory, 'release.tar.gz')));
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest));
  const cli = path.join(__dirname, '../scripts/build-production-release.cjs');
  const localEnv = { ...process.env, NETLIFY: '', CONTEXT: '', BRANCH: '' };
  const args = [cli, '--manifest', s.manifestPath, '--output', s.outputDirectory];
  const denied = spawnSync(process.execPath, args, { encoding: 'utf8', env: localEnv });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /requires NETLIFY/);
  const built = spawnSync(process.execPath, [...args, '--local'], { encoding: 'utf8', env: localEnv });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /13 demos/);
  const protectedPreview = spawnSync(process.execPath, [...args, '--local'], {
    encoding: 'utf8', env: { ...localEnv, ...env, CONTEXT: 'branch-deploy', BRANCH: 'develop' },
  });
  assert.notEqual(protectedPreview.status, 0);
  assert.match(protectedPreview.stderr, /forbidden/);
});

test('packager binds the actual reviewed receipt, excludes controls, and emits deterministic compatible USTAR', t => {
  const s = sample(t), input = path.join(s.directory, 'downloaded');
  fs.mkdirSync(input);
  for (const [name, bytes] of s.entries) {
    const file = path.join(input, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const previewReceipt = { schema: 1, registry_schema: 3, verified: true, revision_bound: true,
    platform: 'netlify', target: 'preview', audience: 'preview', context: 'branch-deploy', branch: 'develop',
    commit_ref: '6a56afde35bb966255350d9108d51213b4e7438e', deploy_id: '6abcd9a85bfd9b000843743b',
    registry_revision: source.registry_revision, site_id: env.SITE_ID, build_id: 'real-preview-build', registry_instance: 'reviewed-registry' };
  const receiptBytes = Buffer.from(JSON.stringify(previewReceipt));
  fs.writeFileSync(path.join(input, 'deploy-receipt.json'), receiptBytes);
  for (const name of ['_headers', '_redirects', 'robots.txt', 'netlify.toml']) fs.writeFileSync(path.join(input, name), 'preview controls');
  const script = path.join(__dirname, '../scripts/package-production-release.py');
  function pack(name) {
    const output = path.join(s.directory, name, 'production-release.json');
    const result = spawnSync('python3', [script, '--source', input, '--output', output], { encoding: 'utf8' });
    return { output, result };
  }
  const first = pack('release-a'), second = pack('release-b');
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(second.result.status, 0, second.result.stderr);
  const a = JSON.parse(fs.readFileSync(first.output)), b = JSON.parse(fs.readFileSync(second.output));
  assert.deepEqual(a, b);
  assert.equal(a.source.receipt_sha256, sha256(receiptBytes));
  assert.equal(a.source.deploy_id, previewReceipt.deploy_id);
  assert.deepEqual(a.files.map(f => f.path).sort(), [...s.entries.keys()].sort());
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(first.output), a.archive.path)),
    fs.readFileSync(path.join(path.dirname(second.output), b.archive.path)));
  const built = s.build({ manifestPath: first.output });
  assert.equal(built.receipt.source_preview.receipt_sha256, a.source.receipt_sha256);
  assert.throws(() => s.build({ manifestPath: first.output, env: { ...env, SITE_ID: '10000000-0000-4000-8000-000000000001' } }), /another Netlify site/);
  previewReceipt.verified = false;
  fs.writeFileSync(path.join(input, 'deploy-receipt.json'), JSON.stringify(previewReceipt));
  const bad = pack('release-unsigned');
  assert.notEqual(bad.result.status, 0);
  assert.match(bad.result.stderr, /reviewed preview: verified/);
  assert.equal(fs.existsSync(bad.output), false);
  previewReceipt.verified = true; previewReceipt.deploy_id = 'old-local-receipt';
  fs.writeFileSync(path.join(input, 'deploy-receipt.json'), JSON.stringify(previewReceipt));
  assert.match(pack('release-stale').result.stderr, /reviewed preview: deploy_id/);
});
