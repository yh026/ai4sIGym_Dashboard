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
const reviewEnv = { ...env, CONTEXT: 'deploy-preview', BRANCH: 'pull/10/head', REVIEW_ID: '10',
  BUILD_ID: 'review-build', DEPLOY_ID: 'review-deploy', COMMIT_REF: 'd'.repeat(40) };
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

function tbbResourceSample(t) {
  const s = sample(t), base = 'demos/tbb-cluster-explorer-2/';
  const manifest = JSON.parse(s.entries.get('manifest.json'));
  const tbb = manifest.demos.find(demo => demo.slug === 'tbb-cluster-explorer-2');
  tbb.pages = [
    { role: 'insight', path: base + 'index.html', state: 'Ready' },
    { role: 'workflow', path: base + 'workflow.html', state: 'Ready' },
    { role: 'dataset', path: 'datasets/himawari-9-ahi/index.html', state: 'Ready' },
    { role: 'resource_page', path: base + 'workflow-resources.html', state: 'Ready' },
  ];
  const wrap = href => Buffer.from('<!doctype html><html><body><nav><a href="' + href
    + '">Notebook &amp; skills</a><span>TBB</span></nav><script>const exact=[0.12345678912345678];</script></body></html>');
  s.entries.set(base + 'index.html', wrap('workflow-resources.html'));
  s.entries.set(base + 'workflow.html', wrap('workflow-resources.html'));
  s.entries.set('datasets/himawari-9-ahi/index.html', wrap('../../demos/tbb-cluster-explorer-2/workflow-resources.html'));
  s.entries.set(base + 'workflow-resources.html', Buffer.from('<html>Notebook &amp; skills</html>'));
  s.entries.set(base + 'resources/skills/notebook.zip', Buffer.from('unchanged source download'));
  s.entries.set('demos/soh-battery/resources/notebook.zip', Buffer.from('another demo download stays public'));
  const report = { schema: 1, pages: [{ path: base + 'index.html', inputBytes: 4321, outputBytes: 1234 },
    { path: base + 'workflow-resources.html', inputBytes: 99, outputBytes: 98 }], assets: [{ path: 'assets/exact.png', bytes: 123 }],
  homeMap: { pixelsIdentical: true } };
  s.entries.set('performance-report.json', Buffer.from(JSON.stringify(report)));
  s.entries.set('manifest.json', Buffer.from(JSON.stringify(manifest))); s.write();
  return s;
}

test('production and review omit only TBB notebook publication while preserving source inputs and other bytes', async t => {
  for (const options of [{}, { env: reviewEnv, review: true }]) await t.test(options.review ? 'review' : 'production', t => {
    const s = tbbResourceSample(t), base = 'demos/tbb-cluster-explorer-2/';
    const archivePath = path.join(s.directory, s.manifest.archive.path);
    const archiveBytes = fs.readFileSync(archivePath), manifestBytes = fs.readFileSync(s.manifestPath);
    fs.mkdirSync(path.join(s.outputDirectory, base, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(s.outputDirectory, base, 'resources/stale.zip'), 'old output');
    const result = s.build(options);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'manifest.json')));
    const override = result.receipt.publication_overrides[0];
    assert.equal(override.id, 'hide-tbb-notebook-resources-v1');
    assert.deepEqual(manifest.release.publication_overrides, result.receipt.publication_overrides);
    assert.deepEqual(manifest.demos.find(d => d.slug === 'tbb-cluster-explorer-2').pages.map(p => p.role), ['insight', 'workflow', 'dataset']);
    const changed = new Map(override.modified_files.map(file => [file.path, file]));
    const omitted = new Map(override.omitted_files.map(file => [file.path, file]));
    assert.equal(changed.size, 4);
    assert.deepEqual([...omitted.keys()].sort(), [base + 'resources/aisgym.ipynb', base + 'resources/skills/notebook.zip', base + 'workflow-resources.html'].sort());
    for (const [name, original] of s.entries) {
      if (name === 'manifest.json') continue;
      if (omitted.has(name)) {
        assert.equal(fs.existsSync(path.join(s.outputDirectory, name)), false);
        assert.equal(omitted.get(name).sha256, sha256(original));
      } else {
        const output = fs.readFileSync(path.join(s.outputDirectory, name));
        if (changed.has(name)) {
          assert.equal(changed.get(name).input_sha256, sha256(original));
          assert.equal(changed.get(name).output_sha256, sha256(output));
          if (name === 'performance-report.json') {
            const expected = JSON.parse(original); expected.pages = expected.pages.filter(p => p.path !== base + 'workflow-resources.html');
            assert.deepEqual(JSON.parse(output), expected);
          } else {
            const href = name.startsWith('datasets/') ? '../../' + base + 'workflow-resources.html' : 'workflow-resources.html';
            assert.deepEqual(output, Buffer.from(original.toString().replace('<a href="' + href + '">Notebook &amp; skills</a>', '')));
          }
        } else assert.deepEqual(output, original, name);
      }
    }
    assert.equal(fs.existsSync(path.join(s.outputDirectory, base + 'resources')), false);
    const redirects = ['', '/', '.html', '.html/'].map(suffix => '/' + base + 'workflow-resources' + suffix + ' /' + base + 'workflow.html 302').join('\n') + '\n';
    assert.equal(fs.readFileSync(path.join(s.outputDirectory, '_redirects'), 'utf8'), redirects);
    assert.deepEqual(fs.readFileSync(archivePath), archiveBytes);
    assert.deepEqual(fs.readFileSync(s.manifestPath), manifestBytes);
  });
});

test('TBB omission never bypasses full source validation or changes an existing output on failure', t => {
  const s = tbbResourceSample(t), resource = 'demos/tbb-cluster-explorer-2/workflow-resources.html';
  fs.mkdirSync(s.outputDirectory); fs.writeFileSync(path.join(s.outputDirectory, 'previous'), 'keep until valid');
  s.write([...s.entries].map(([name, bytes]) => ({ path: name, bytes: name === resource ? Buffer.from('bad source') : bytes })));
  assert.throws(() => s.build(), /size mismatch|checksum/);
  const original = s.entries.get(resource); s.entries.delete(resource); s.write();
  assert.throws(() => s.build(), /public page is missing/);
  s.entries.set(resource, original);
  s.entries.set('demos/tbb-cluster-explorer-2/workflow.html', Buffer.from('<html>Unexpected navigation revision</html>')); s.write();
  assert.throws(() => s.build(), /exact single navigation link/);
  assert.deepEqual(fs.readdirSync(s.outputDirectory), ['previous']);
  assert.equal(fs.readFileSync(path.join(s.outputDirectory, 'previous'), 'utf8'), 'keep until valid');
});

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

test('explicit review mode is confined to an identified Netlify pull request deployment', () => {
  const policy = productionPolicy(reviewEnv, { review: true });
  assert.equal(policy.context, 'deploy-preview');
  assert.equal(policy.branch, 'pull/10/head');
  assert.equal(policy.review_id, '10');
  assert.equal(policy.commit_ref, reviewEnv.COMMIT_REF);
  for (const patch of [{ NETLIFY: '' }, { CONTEXT: 'production' }, { CONTEXT: 'branch-deploy' },
    { BRANCH: 'main' }, { BRANCH: 'develop' }, { BRANCH: 'pull/11/head' }, { REVIEW_ID: '' },
    { REVIEW_ID: '0', BRANCH: 'pull/0/head' }, { REVIEW_ID: '01', BRANCH: 'pull/01/head' },
    { REVIEW_ID: '1.5', BRANCH: 'pull/1.5/head' }, { REVIEW_ID: '9007199254740992', BRANCH: 'pull/9007199254740992/head' },
    { COMMIT_REF: '' }, { SITE_ID: '' }, { BUILD_ID: '' }, { DEPLOY_ID: '' }]) {
    assert.throws(() => productionPolicy({ ...reviewEnv, ...patch }, { review: true }));
  }
  assert.throws(() => productionPolicy(reviewEnv), /requires NETLIFY/);
  assert.throws(() => productionPolicy(env, { review: true }), /--review requires/);
  assert.throws(() => productionPolicy({}, { local: true, review: true }), /mutually exclusive/);
});

test('review candidate preserves artifact bytes and source proof while remaining private and unindexed', t => {
  const s = sample(t), result = s.build({ env: reviewEnv, review: true });
  for (const [name, bytes] of s.entries) if (name !== 'manifest.json') {
    assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, name)), bytes, name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'manifest.json')));
  assert.equal(manifest.audience, 'preview');
  assert.ok(manifest.demos.every(d => d.status === 'Draft' && d.public_page_permission === 'Preview only' && d.audience === 'General'));
  const receipt = result.receipt;
  assert.equal(receipt.verified, false);
  assert.equal(receipt.target, 'preview');
  assert.equal(receipt.audience, 'preview');
  assert.equal(receipt.context, 'deploy-preview');
  assert.equal(receipt.branch, 'pull/10/head');
  assert.equal(receipt.review_id, '10');
  assert.equal(receipt.commit_ref, reviewEnv.COMMIT_REF);
  assert.equal(receipt.deploy_id, reviewEnv.DEPLOY_ID);
  assert.deepEqual(receipt.source_preview, source);
  assert.equal(receipt.publication_overrides, undefined);
  assert.equal(manifest.release.publication_overrides, undefined);
  assert.equal(fs.existsSync(path.join(s.outputDirectory, '_redirects')), false);
  const headers = fs.readFileSync(path.join(s.outputDirectory, '_headers'), 'utf8');
  assert.match(headers, /(?:^|\n)\/\*\n  X-Robots-Tag: noindex, nofollow/);
  assert.doesNotMatch(headers, /Cache-Control: public/);
  for (const kind of ['embedded', 'optimized', 'runtime']) assert.ok(headers.includes('/assets/' + kind + '/*\n  Cache-Control: private, max-age=31536000, immutable'));
  assert.equal(fs.readFileSync(path.join(s.outputDirectory, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
  fs.appendFileSync(path.join(s.directory, 'release.tar.gz'), 'changed');
  assert.throws(() => s.build({ env: reviewEnv, review: true }), /archive checksum/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'deploy-receipt.json'))), receipt);
});

test('CLI --review is explicit and cannot combine with local or enter production/develop', t => {
  const s = sample(t), cli = path.join(__dirname, '../scripts/build-production-release.cjs');
  const args = [cli, '--manifest', s.manifestPath, '--output', s.outputDirectory, '--review'];
  const invoke = (environment, extra = []) => spawnSync(process.execPath, [...args, ...extra], {
    encoding: 'utf8', env: { ...process.env, ...environment },
  });
  const review = invoke(reviewEnv);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /release review validated/);
  assert.notEqual(invoke(env).status, 0);
  assert.notEqual(invoke({ ...reviewEnv, CONTEXT: 'branch-deploy', BRANCH: 'develop' }).status, 0);
  const mixed = invoke(reviewEnv, ['--local']);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /mutually exclusive/);
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

test('homepage introduction publishes in production and review without changing demos or replacing the TBB override', async t => {
  for (const options of [{}, { env: reviewEnv, review: true }]) await t.test(options.review ? 'review' : 'production', t => {
    const s = tbbResourceSample(t);
    const home = Buffer.from('<!doctype html><html><head></head><body>Original map\n'
      + '  <section class="project-library" id="projects" aria-labelledby="projects-title">Original projects</section></body></html>');
    s.entries.set('index.html', home);
    s.write();
    s.build(options);
    const baseline = new Map();
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else baseline.set(path.relative(s.outputDirectory, file), fs.readFileSync(file));
      }
    };
    walk(s.outputDirectory);
    const directory = path.join(s.directory, 'homepage-video');
    fs.mkdirSync(directory);
    const definitions = [
      ['section', 'section.html', '<section id="introduction"><img src="{{POSTER_URL}}"><video data-intro-src="{{VIDEO_URL}}"></video></section>'],
      ['stylesheet', 'intro.css', '.gym-intro-video { width: 100%; }'],
      ['script', 'intro.js', '/* click-to-load player */'],
      ['poster', 'poster.jpg', 'poster bytes'],
      ['video', 'intro.mp4', 'video bytes'],
    ];
    const files = definitions.map(([role, name, content]) => {
      const bytes = Buffer.from(content), hash = sha256(bytes);
      fs.writeFileSync(path.join(directory, name), bytes);
      return { role, source: 'homepage-video/' + name, size: bytes.length, sha256: hash,
        ...(role === 'section' ? {} : { path: 'assets/' + (['stylesheet', 'script'].includes(role) ? 'runtime/' : 'optimized/')
          + hash + path.extname(name) }) };
    });
    s.manifest.homepage_introduction = { id: 'homepage-introduction-v1', input_index_sha256: sha256(home), files };
    s.write();
    const result = s.build(options);
    for (const [name, bytes] of baseline) {
      if (['index.html', 'manifest.json', 'deploy-receipt.json'].includes(name)) continue;
      assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, name)), bytes, name);
    }
    const overrides = result.receipt.publication_overrides;
    assert.deepEqual(overrides.map(item => item.id), ['hide-tbb-notebook-resources-v1', 'homepage-introduction-v1']);
    const metadata = JSON.parse(fs.readFileSync(path.join(s.outputDirectory, 'manifest.json')));
    assert.deepEqual(metadata.release.publication_overrides, overrides);
    assert.deepEqual(metadata.demos, JSON.parse(baseline.get('manifest.json')).demos);
    assert.deepEqual(result.receipt.source_preview, JSON.parse(baseline.get('deploy-receipt.json')).source_preview);
    for (const file of files.filter(file => file.path)) {
      assert.equal(sha256(fs.readFileSync(path.join(s.outputDirectory, file.path))), file.sha256);
    }
    assert.equal(overrides[1].modified_files[0].input_sha256, sha256(home));
    assert.equal(overrides[1].added_files.length, 4);
    const publishedHome = fs.readFileSync(path.join(s.outputDirectory, 'index.html'));
    fs.appendFileSync(path.join(directory, 'intro.mp4'), 'corrupt');
    assert.throws(() => s.build(options), /size|checksum|hash/i);
    assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, 'index.html')), publishedHome);
  });
});

test('release accepts only byte-bound immutable MP4 resources', t => {
  const s = sample(t), video = Buffer.from('unchanged video bytes');
  const name = 'assets/optimized/' + sha256(video) + '.mp4';
  s.entries.set(name, video); s.write(); s.build();
  assert.deepEqual(fs.readFileSync(path.join(s.outputDirectory, name)), video);
  s.entries.set(name, Buffer.from('changed video bytes')); s.write();
  assert.throws(() => s.build(), /filename does not match/);
  s.entries.delete(name);
  s.entries.set('assets/unreviewed.mp4', video); s.write();
  assert.throws(() => s.build(), /outside the authorized public routes/);
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
    commit_ref: 'ee1c49d6ed8e32ee17493a5c395bfe9245a60d52', deploy_id: '6abf25ef581f89000876e7fa',
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
