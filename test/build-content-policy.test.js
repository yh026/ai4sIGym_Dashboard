'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBuildContentPolicy,
  scopedRegistryUrl,
  isPublishableDemo,
} = require('../build.js');

test('only the stable develop Branch Deploy gets Preview content', () => {
  assert.equal(resolveBuildContentPolicy({
    NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'develop',
  }).audience, 'preview');

  for (const env of [
    { NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'main' },
    { NETLIFY: 'true', CONTEXT: 'deploy-preview', BRANCH: 'develop' },
    { NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'main' },
    { NETLIFY: 'true', CONTEXT: 'branch-deploy', BRANCH: 'feature/example' },
    {},
  ]) {
    assert.equal(resolveBuildContentPolicy(env).audience, 'production');
  }
});

test('a Netlify production deploy is locked to main', () => {
  assert.throws(
    () => resolveBuildContentPolicy({
      NETLIFY: 'true', CONTEXT: 'production', BRANCH: 'develop',
    }),
    /production.*main/i,
  );
});

test('registry requests override stale status and audience parameters', () => {
  const base = 'https://example.invalid/exec?token=secret&status=all&status=Draft&audience=preview';
  const production = { audience: 'production' };
  const preview = { audience: 'preview' };

  const productionManifest = new URL(scopedRegistryUrl(base, 'manifest', production));
  assert.equal(productionManifest.searchParams.get('token'), 'secret');
  assert.equal(productionManifest.searchParams.get('action'), 'manifest');
  assert.equal(productionManifest.searchParams.get('audience'), 'production');
  assert.equal(productionManifest.searchParams.has('status'), false);
  assert.equal(productionManifest.searchParams.has('id'), false);

  const previewFile = new URL(scopedRegistryUrl(base, 'file', preview, 'draft-id'));
  assert.equal(previewFile.searchParams.get('action'), 'file');
  assert.equal(previewFile.searchParams.get('audience'), 'preview');
  assert.equal(previewFile.searchParams.get('id'), 'draft-id');
  assert.equal(previewFile.searchParams.has('status'), false);
});

test('Production publishes only healthy Live rows; Preview additionally permits Draft', () => {
  const rows = [
    { name: 'live', status: 'Live', file_check: 'ok' },
    { name: 'draft', status: 'Draft', file_check: 'ok — no provenance.md' },
    { name: 'archived', status: 'Archived', file_check: 'ok' },
    { name: 'unknown', status: 'Published', file_check: 'ok' },
    { name: 'blank', status: '', file_check: 'ok' },
    { name: 'missing', status: 'Live', file_check: 'missing' },
    { name: 'unreadable', status: 'Live', file_check: 'ok — provenance unreadable' },
    { name: 'empty', status: 'Live', file_check: 'ok — page empty' },
    { name: 'asset-warning', status: 'Live', file_check: 'check assets: missing-image.png' },
  ];

  assert.deepEqual(
    rows.filter(row => isPublishableDemo(row, { audience: 'production' })).map(row => row.name),
    ['live', 'asset-warning'],
  );
  assert.deepEqual(
    rows.filter(row => isPublishableDemo(row, { audience: 'preview' })).map(row => row.name),
    ['live', 'draft', 'asset-warning'],
  );
});
