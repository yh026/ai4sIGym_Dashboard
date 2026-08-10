'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('mock build completes and publishes a safe seven-department manifest', () => {
  const result = spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
  assert.equal(manifest.taxonomy_version, 4);
  assert.equal(manifest.domains.length, 7);
  assert.equal(manifest.demos.length, 3);
  assert.equal(manifest.demos.some(demo => demo.slug === 'ai-for-science-demos'), false);
  assert.equal(manifest.demos.some(demo => (
    demo.file_id || demo.file_check || demo.picture_file_id || demo.preview_file_id || demo.thumbnail_file_id
  )), false);
});

test('mock builds enforce the Production and develop Preview status matrix', () => {
  const fixture = path.join(root, 'fixtures', 'manifest-status-matrix.json');
  const fallback = path.join(root, 'fixtures', 'demo-minimal.html');
  const build = (context, branch) => spawnSync(process.execPath, ['build.js', '--mock'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NETLIFY: 'true',
      CONTEXT: context,
      BRANCH: branch,
      MOCK_MANIFEST: fixture,
      MOCK_HTML_FALLBACK: fallback,
    },
  });
  const manifest = () => JSON.parse(
    fs.readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'),
  );
  const routeExists = slug => fs.existsSync(
    path.join(root, 'dist', 'demos', slug, 'index.html'),
  );

  const production = build('production', 'main');
  assert.equal(production.status, 0, production.stdout + production.stderr);
  assert.deepEqual(manifest().demos.map(demo => demo.slug), ['status-live']);
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), false);
  assert.equal(routeExists('status-archived'), false);
  assert.equal(fs.existsSync(path.join(root, 'dist', '_headers')), false);

  const preview = build('branch-deploy', 'develop');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(
    manifest().demos.map(demo => demo.slug).sort(),
    ['status-draft', 'status-live'],
  );
  assert.equal(routeExists('status-live'), true);
  assert.equal(routeExists('status-draft'), true);
  assert.equal(routeExists('status-archived'), false);
  assert.equal(routeExists('status-missing'), false);
  assert.equal(routeExists('status-unreadable'), false);
  assert.equal(routeExists('status-unknown'), false);
  assert.match(
    fs.readFileSync(path.join(root, 'dist', '_headers'), 'utf8'),
    /X-Robots-Tag: noindex, nofollow/,
  );
});
