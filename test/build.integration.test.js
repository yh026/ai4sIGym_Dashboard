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
