'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { applyHomepageIntroduction } = require('../lib/homepage-introduction');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const projectAnchor = '  <section class="project-library" id="projects" aria-labelledby="projects-title">';

function sample(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-homepage-introduction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const releaseDirectory = path.join(directory, 'release');
  fs.mkdirSync(path.join(releaseDirectory, 'homepage-video'), { recursive: true });
  const homepage = Buffer.from('<!doctype html>\n<html><head>\n<title>Gym</title>\n</head>\n<body>\n'
    + '<section class="science-map-section">The existing map</section>\n\n' + projectAnchor
    + '\n<p class="section-number">02</p><input id="q"><p>Measurements — don’t mutate</p>\n</section>\n'
    + '<script>const exact=[0.12345678912345678];</script>\n</body>\n</html>\n');
  const files = new Map([['index.html', homepage], ['manifest.json', Buffer.from('{"keep":"source proof"}\n')],
    ['demos/unchanged/index.html', Buffer.from('<script>const data=[1.123456789012345];</script>')],
    ['assets/unchanged.png', Buffer.from([0, 255, 14, 192, 83])]]);
  const entries = [
    ['section', 'section.html', '<section id="introduction"><img src="{{POSTER_URL}}"><video data-src="{{VIDEO_URL}}"></video></section>\n<dialog id="gym-intro-dialog"></dialog>'],
    ['stylesheet', 'intro.css', '#introduction{width:100%}'],
    ['script', 'intro.js', 'document.querySelector("#introduction");'],
    ['poster', 'poster.jpg', Buffer.from([255, 216, 255, 0])],
    ['video', 'video.mp4', Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])],
  ];
  const config = { id: 'homepage-introduction-v1', input_index_sha256: sha256(homepage), files: [] };
  for (const [role, filename, content] of entries) {
    const bytes = Buffer.from(content), hash = sha256(bytes);
    const entry = { role, source: 'homepage-video/' + filename, size: bytes.length, sha256: hash };
    if (role !== 'section') {
      const extension = { stylesheet: 'css', script: 'js', poster: 'jpg', video: 'mp4' }[role];
      entry.path = 'assets/' + (['stylesheet', 'script'].includes(role) ? 'runtime/' : 'optimized/') + hash + '.' + extension;
    }
    fs.writeFileSync(path.join(releaseDirectory, entry.source), bytes);
    config.files.push(entry);
  }
  const outputDirectory = path.join(directory, 'dist');
  const options = { files, config, releaseDirectory, outputDirectory };
  const entry = role => config.files.find(item => item.role === role);
  const setSource = (role, bytes) => {
    const item = entry(role), content = Buffer.from(bytes);
    fs.writeFileSync(path.join(releaseDirectory, item.source), content);
    item.size = content.length; item.sha256 = sha256(content);
    if (item.path) item.path = item.path.replace(/[a-f0-9]{64}/, item.sha256);
  };
  return { ...options, directory, entry, setSource, apply: patch => applyHomepageIntroduction({ ...options, ...patch }) };
}

test('absent optional supplement returns the exact original map without inspecting the filesystem', () => {
  const files = new Map([['index.html', Buffer.from('unchanged')]]);
  for (const config of [undefined, null]) assert.deepEqual(applyHomepageIntroduction({ files, config }), { files, override: null });
  assert.equal(applyHomepageIntroduction({ files }).files, files);
});

test('introduction adds only four assets and three removable homepage insertions with bound evidence', t => {
  const s = sample(t), before = new Map(s.files), result = s.apply();
  assert.notEqual(result.files, s.files);
  assert.equal(result.files.size, s.files.size + 4);
  for (const [name, bytes] of before) {
    assert.equal(s.files.get(name), bytes, 'source map must remain untouched');
    if (name !== 'index.html') assert.equal(result.files.get(name), bytes, name);
  }
  const html = result.files.get('index.html').toString('utf8');
  const pattern = /<!-- homepage-introduction-v1:(stylesheet|section|script):begin -->\n[\s\S]*?\n<!-- homepage-introduction-v1:\1:end -->\n/g;
  assert.equal([...html.matchAll(pattern)].length, 3);
  assert.deepEqual(Buffer.from(html.replace(pattern, '')), before.get('index.html'));
  assert.ok(html.indexOf('rel="stylesheet"') < html.indexOf('</head>'));
  assert.ok(html.indexOf('id="introduction"') < html.indexOf(projectAnchor));
  assert.ok(html.indexOf('<dialog') < html.indexOf(projectAnchor));
  assert.ok(html.indexOf(' defer></script>') < html.indexOf('</body>'));
  for (const role of ['poster', 'video']) assert.ok(html.includes('/' + s.entry(role).path));
  assert.doesNotMatch(html, /\{\{(?:POSTER|VIDEO)_URL\}\}/);
  assert.deepEqual(result.override.modified_files, [{ path: 'index.html', input_sha256: sha256(before.get('index.html')),
    output_sha256: sha256(result.files.get('index.html')) }]);
  assert.equal(result.override.id, s.config.id);
  assert.deepEqual(result.override.added_files, s.config.files.filter(f => f.role !== 'section')
    .map(({ path: name, size, sha256: hash }) => ({ path: name, size, sha256: hash })));
  for (const record of result.override.added_files) {
    assert.equal(result.files.get(record.path).length, record.size);
    assert.equal(sha256(result.files.get(record.path)), record.sha256);
  }
  assert.equal(fs.existsSync(s.outputDirectory), false, 'module must not publish or write output');
});

test('source homepage identity and each exact anchor must match before changing anything', t => {
  const s = sample(t);
  s.config.input_index_sha256 = '0'.repeat(64);
  assert.throws(() => s.apply(), /homepage hash mismatch/);
  const original = s.files.get('index.html');
  for (const anchor of ['</head>', projectAnchor, '</body>']) {
    for (const altered of [original.toString().replace(anchor, ''), original.toString() + anchor]) {
      const bytes = Buffer.from(altered);
      s.files.set('index.html', bytes); s.config.input_index_sha256 = sha256(bytes);
      assert.throws(() => s.apply(), /one exact .* anchor/);
      assert.equal(s.files.get('index.html'), bytes);
    }
  }
  const withMarker = Buffer.concat([original, Buffer.from('<!-- homepage-introduction-v1:section:begin -->')]);
  s.files.set('index.html', withMarker); s.config.input_index_sha256 = sha256(withMarker);
  assert.throws(() => s.apply(), /already contains introduction markers/);
});

test('missing files, size errors and wrong hashes preserve the source map and any existing output', t => {
  const s = sample(t), video = s.entry('video'), videoPath = path.join(s.releaseDirectory, video.source);
  fs.mkdirSync(s.outputDirectory); fs.writeFileSync(path.join(s.outputDirectory, 'previous'), 'keep');
  const original = fs.readFileSync(videoPath), before = [...s.files];
  fs.writeFileSync(videoPath, Buffer.concat([original, Buffer.from('more')]));
  assert.throws(() => s.apply(), /source size mismatch/);
  fs.writeFileSync(videoPath, Buffer.alloc(original.length, 9));
  assert.throws(() => s.apply(), /source hash or size mismatch/);
  fs.unlinkSync(videoPath);
  assert.throws(() => s.apply(), /ENOENT/);
  assert.deepEqual([...s.files], before);
  assert.deepEqual(fs.readdirSync(s.outputDirectory), ['previous']);
  assert.equal(fs.readFileSync(path.join(s.outputDirectory, 'previous'), 'utf8'), 'keep');
});

test('supplement roles are exact, unique and have hash-bound public paths', async t => {
  const cases = [
    ['unknown identity', s => { s.config.id = 'other'; }, /identity/],
    ['missing role', s => { s.config.files.pop(); }, /five/],
    ['extra role', s => { s.config.files.push({ ...s.entry('video') }); }, /five/],
    ['duplicate role', s => { s.entry('video').role = 'poster'; }, /duplicate.*role/],
    ['unknown role', s => { s.entry('video').role = '__proto__'; }, /unknown.*role/],
    ['duplicate source', s => { s.entry('video').source = s.entry('poster').source; }, /duplicate source/],
    ['section path', s => { s.entry('section').path = 'assets/section.html'; }, /section.*public path/],
    ['unhashed path', s => { s.entry('video').path = 'assets/video.mp4'; }, /public path/],
    ['wrong extension', s => { s.entry('video').path = s.entry('video').path.replace(/mp4$/, 'js'); }, /public path/],
    ['wrong directory', s => { s.entry('script').path = s.entry('script').path.replace('runtime', 'optimized'); }, /public path/],
    ['collision', s => { s.files.set(s.entry('poster').path, Buffer.from('already here')); }, /collision/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, t => {
    const s = sample(t); mutate(s); assert.throws(() => s.apply(), pattern);
  });
});

test('source paths cannot escape or nest beyond the dedicated input folder', async t => {
  for (const source of ['../video.mp4', '/tmp/video.mp4', 'homepage-video/../video.mp4',
    'homepage-video/nested/video.mp4', 'different/video.mp4', 'homepage-video/.hidden', 'homepage-video/a\\b.mp4']) {
    await t.test(source, t => {
      const s = sample(t); s.entry('video').source = source;
      assert.throws(() => s.apply(), /unsafe.*source/);
    });
  }
});

test('source and directory symlinks are rejected even when bytes would match', async t => {
  await t.test('file symlink', t => {
    const s = sample(t), original = path.join(s.releaseDirectory, s.entry('video').source), moved = path.join(s.directory, 'video.mp4');
    fs.renameSync(original, moved); fs.symlinkSync(moved, original);
    assert.throws(() => s.apply(), /regular file.*symlink/);
  });
  await t.test('input directory symlink', t => {
    const s = sample(t), original = path.join(s.releaseDirectory, 'homepage-video'), moved = path.join(s.directory, 'moved');
    fs.renameSync(original, moved); fs.symlinkSync(moved, original);
    assert.throws(() => s.apply(), /real directory.*symlink/);
  });
  await t.test('release directory symlink', t => {
    const s = sample(t), alias = path.join(s.directory, 'release-alias');
    fs.symlinkSync(s.releaseDirectory, alias);
    assert.throws(() => s.apply({ releaseDirectory: alias }), /real directory/);
  });
});

test('output cannot overwrite supplement input files or their ancestors', t => {
  const s = sample(t);
  for (const outputDirectory of [s.directory, s.releaseDirectory, path.join(s.releaseDirectory, 'homepage-video'),
    path.join(s.releaseDirectory, s.entry('video').source)]) {
    assert.throws(() => s.apply({ outputDirectory }), /output must not contain supplement inputs/);
  }
  const alias = path.join(s.directory, 'output-alias'); fs.symlinkSync(s.releaseDirectory, alias);
  assert.throws(() => s.apply({ outputDirectory: alias }), /output must not be a symlink/);
  assert.throws(() => s.apply({ outputDirectory: path.join(alias, 'homepage-video') }), /output must not contain supplement inputs/);
  const dangling = path.join(s.directory, 'dangling-output'); fs.symlinkSync(path.join(s.directory, 'missing'), dangling);
  assert.throws(() => s.apply({ outputDirectory: dangling }), /output must not be a symlink/);
});

test('section must be UTF-8 with both URL placeholders and cannot inject evidence markers', t => {
  const s = sample(t);
  for (const content of ['<section>{{POSTER_URL}}</section>', '<section>{{VIDEO_URL}}</section>',
    '<!-- homepage-introduction-v1:section:begin -->{{POSTER_URL}}{{VIDEO_URL}}', Buffer.from([255, 255, 255])]) {
    s.setSource('section', content);
    assert.throws(() => s.apply(), /placeholders|markers|UTF-8/);
  }
});

test('file, section and combined public byte limits remain enforced', async t => {
  for (const [role, size] of [['video', 64 * 1024 * 1024 + 1], ['section', 128 * 1024 + 1], ['poster', -1], ['script', 1.5]]) {
    await t.test(role + ':' + size, t => {
      const s = sample(t); s.entry(role).size = size;
      assert.throws(() => s.apply(), /invalid or oversized/);
    });
  }
  await t.test('combined size', t => {
    const s = sample(t), shared = Buffer.alloc(32 * 1024 * 1024);
    for (let i = 0; i < 8; i++) s.files.set('assets/large-' + i + '.png', shared);
    assert.throws(() => s.apply(), /combined public files/);
  });
});
