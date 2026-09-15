'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('../fixtures/registry-v2-current-21.json');
const adapter = require('../lib/registry-v2-sheet-adapter');
const { verifySnapshot, loadLocalRegistry, localContentPolicy, sha256, compareSnapshots } = require('../lib/local-content');

function snapshot(t, status = 'Live') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-local-content-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = { ...fixture.projects.find(p => p.row_number === 3), status,
    public_permission: status === 'Draft' ? 'Preview only' : 'Public' };
  const source = fixture.sourceProjections.find(p => p.row_number === 3);
  const sheets = {
    Projects: adapter.projectsToSheetRows([project], [source]),
    _Registry: adapter.registryToSheetRows([source]),
    _Taxonomy: adapter.taxonomyToSheetRows(fixture.taxonomy),
    _Facets: adapter.facetsToSheetRows([]),
    _Assets: adapter.assetsToSheetRows([]),
    _Config: adapter.configToSheetRows({ schema_version: 2, site_title: 'Synthetic local collection' }),
  };
  const html = '<!doctype html><html><body>Local example</body></html>';
  const file = 'projects/soh-battery/example.html';
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), html);
  const registry = JSON.stringify({ sheets });
  fs.writeFileSync(path.join(directory, 'registry.snapshot.json'), registry);
  const inventory = { schema_version: 1, registry_snapshot_sha256: sha256(registry),
    projects: [{ slug: source.slug, primary_file_id: source.file_id, primary_path: file }],
    files: [{ id: source.file_id, path: file, bytes: Buffer.byteLength(html), sha256: sha256(html) }] };
  fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(inventory));
  return { directory, html, file, source, inventory };
}

test('local Registry reads current Sheet metadata and locally stored Draft HTML', async t => {
  const data = snapshot(t, 'Draft');
  const registry = loadLocalRegistry(data.directory);
  assert.equal(registry.audience, 'preview');
  assert.equal(registry.site.title, 'Synthetic local collection');
  assert.equal(registry.demos.length, 1);
  assert.equal(registry.demos[0].status, 'Draft');
  assert.equal(registry.demos[0].slug, data.source.slug);
  assert.equal((await registry.getHtml(data.source.file_id)).html, data.html);
  assert.equal(await registry.getRevision(), registry.registryRevision);
});

test('a modified or missing snapshot file blocks local builds', t => {
  const data = snapshot(t);
  fs.writeFileSync(path.join(data.directory, data.file), data.html.replace('Local', 'Other'));
  assert.throws(() => verifySnapshot(data.directory), /snapshot file changed/);
  fs.unlinkSync(path.join(data.directory, data.file));
  assert.throws(() => verifySnapshot(data.directory), /ENOENT/);
});

test('local reads detect source or Registry changes during a build', async t => {
  const data = snapshot(t);
  const registry = loadLocalRegistry(data.directory);
  fs.writeFileSync(path.join(data.directory, data.file), data.html.replace('Local', 'Other'));
  await assert.rejects(registry.getHtml(data.source.file_id), /Source changed/);
  fs.writeFileSync(path.join(data.directory, data.file), data.html);
  fs.appendFileSync(path.join(data.directory, 'registry.snapshot.json'), ' ');
  await assert.rejects(registry.getRevision(), /Registry snapshot changed/);
});

test('refresh validation protects new local files that are absent from the download inventory', t => {
  const data = snapshot(t);
  fs.writeFileSync(path.join(data.directory, 'my-edits.html'), 'Unpublished work');
  assert.throws(() => verifySnapshot(data.directory), /Unrecorded local file/);
  assert.equal(fs.readFileSync(path.join(data.directory, 'my-edits.html'), 'utf8'), 'Unpublished work');
});

test('an inventory cannot escape its content directory through paths or symlinks', t => {
  const data = snapshot(t);
  const write = () => fs.writeFileSync(path.join(data.directory, 'inventory.json'), JSON.stringify(data.inventory));
  data.inventory.files[0].path = '../outside.html'; write();
  assert.throws(() => verifySnapshot(data.directory), /Unsafe local content path/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'outside.html'), data.html);
  fs.symlinkSync(path.join(outside, 'outside.html'), path.join(data.directory, 'linked.html'));
  data.inventory.files[0].path = 'linked.html'; write();
  assert.throws(() => verifySnapshot(data.directory), /escapes its directory/);
});

test('local Draft access is unavailable in deployment environments', () => {
  assert.deepEqual(localContentPolicy({}), { audience: 'preview', context: 'local', branch: 'local', netlify: false });
  assert.throws(() => localContentPolicy({ NETLIFY: 'true' }), /cannot run in a Netlify deployment/);
  assert.throws(() => localContentPolicy({ CONTEXT: 'production' }), /cannot run in a Netlify deployment/);
  assert.throws(() => localContentPolicy({ CONTEXT: 'deploy-preview' }), /cannot run in a Netlify deployment/);
});

test('refresh reports replaced source identities even when bytes are unchanged', () => {
  const old = { files: [{ path: 'a.html', id: 'old-id', sha256: 'same' }, { path: 'removed.html', id: 'b', sha256: 'b' }] };
  const next = { files: [{ path: 'a.html', id: 'new-id', sha256: 'same' }, { path: 'new.html', id: 'c', sha256: 'c' }] };
  assert.deepEqual(compareSnapshots(old, next), { added: ['new.html'], updated: ['a.html'], removed: ['removed.html'] });
});
