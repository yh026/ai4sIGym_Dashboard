'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const V3 = require('../lib/registry-v3');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
const hash = value => crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');

function fixture() {
  const entries = new Map(), metrics = { parents: 0, blobs: 0 };
  function entry(id, parentIds = []) {
    const item = { id, parentIds, getId: () => id, getName: () => id, getParents() {
      metrics.parents++;
      const parents = this.parentIds.map(parent => entries.get(parent));
      return { hasNext: () => parents.length > 0, next: () => parents.shift() };
    } };
    entries.set(id, item); return item;
  }
  entry(ROOT); entry('outside'); entry('category', [ROOT]); entry('project', ['category']); entry('version', ['project']);
  const state = { trash: false, mime: 'text/html', modified: '2026-10-02T00:00:00.000Z',
    text: '<html><head></head><body>verified</body></html>' };
  state.size = Buffer.byteLength(state.text);
  const file = Object.assign(entry('source-file', ['version']), {
    isTrashed: () => state.trash, getLastUpdated: () => new Date(state.modified), getSize: () => state.size,
    getMimeType: () => state.mime, getBlob() {
      metrics.blobs++; if (state.onRead) state.onRead();
      return { getBytes: () => [...Buffer.from(state.text)], getDataAsString: () => state.text };
    },
  });
  const config = { schema: 2, root_id: ROOT, mounts: [{ id: 'version', ancestor_chain: ['project', 'category', ROOT], logical_path: 'projects/example/example-v1' }] };
  const context = vm.createContext({ V3, console: { log() {} },
    DriveApp: { getFileById: id => { assert.equal(id, file.id); return file; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'AIS_PROJECT_MOUNTS_V1' ? JSON.stringify(config) : key === 'AI4S_REGISTRY_ACCESS_TOKEN' ? 'private-token' : null }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) },
  });
  vm.runInContext(read('google-apps-script/sandbox/Adapter.gs'), context);
  vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'), context);
  context.hash_ = hash;
  const descriptor = { id: 'page-example', kind: 'page', file_id: file.id, sha256: hash(state.text),
    size: state.size, mime_type: state.mime, modified_at: state.modified, parent_path: config.mounts[0].logical_path };
  const snapshot = { manifest: { audience: 'preview', registry_revision: 'sha256:' + 'a'.repeat(64), registry_instance: context.SANDBOX.registry_instance }, files: [descriptor] };
  context.checkedSnapshot_ = () => snapshot;
  function get() { return JSON.parse(context.doGet({ parameter: { schema: '3', audience: 'preview', token: 'private-token', action: 'page', id: descriptor.id, registry_revision: snapshot.manifest.registry_revision } }).getContent()); }
  return { context, state, entries, metrics, descriptor, file, get };
}

test('each source operation resolves one full ancestry while sourceFile still returns the Drive File', () => {
  const h = fixture();
  assert.equal(h.context.sourceFile_(h.file.id), h.file); assert.equal(h.metrics.parents, 4);
  const source = h.context.source_(h.file.id); assert.equal(source.sha256, h.descriptor.sha256); assert.equal(h.metrics.parents, 8);
  assert.equal(h.context.assertStamp_(h.descriptor), h.file); assert.equal(h.metrics.parents, 12);
  h.context.source_(h.file.id, h.descriptor); assert.equal(h.metrics.parents, 16); assert.equal(h.metrics.blobs, 1);
});

test('cached source metadata never bypasses fresh parent, ancestor, ambiguity or trash checks', () => {
  const changes = [
    h => { h.file.parentIds = ['outside']; },
    h => { h.entries.get('project').parentIds = ['outside']; },
    h => { h.entries.get('category').parentIds.push('outside'); },
    h => { h.state.trash = true; },
  ];
  for (const change of changes) {
    const h = fixture(); h.context.source_(h.file.id, h.descriptor); change(h);
    assert.throws(() => h.context.source_(h.file.id, h.descriptor));
    assert.throws(() => h.context.assertStamp_(h.descriptor)); assert.equal(h.metrics.blobs, 0);
  }
});

test('assertStamp preserves all descriptor checks without cross-call caching', () => {
  for (const change of [h => { h.state.size++; }, h => { h.state.mime = 'application/json'; },
    h => { h.state.modified = '2026-10-03T00:00:00.000Z'; }, h => { h.descriptor.parent_path = 'projects/other/other-v1'; }]) {
    const h = fixture(); h.context.assertStamp_(h.descriptor); change(h);
    assert.throws(() => h.context.assertStamp_(h.descriptor), /Source changed/);
    assert.equal(h.metrics.parents, 8);
  }
});

test('page API keeps independent pre-read and post-read ancestry validation', () => {
  const healthy = fixture(); assert.equal(healthy.get().html, healthy.state.text); assert.equal(healthy.metrics.parents, 8);
  for (const change of [h => { h.file.parentIds = ['outside']; }, h => { h.entries.get('category').parentIds = ['outside']; }, h => { h.state.trash = true; }]) {
    const h = fixture(); h.state.onRead = () => change(h);
    const result = h.get(); assert.equal(result.ok, false); assert.equal(result.html, undefined);
  }
});

test('source reads still reject incomplete HTML and mid-read metadata changes', () => {
  const incomplete = fixture(); incomplete.state.text = 'not a document';
  assert.throws(() => incomplete.context.source_(incomplete.file.id), /Incomplete HTML/);
  const changed = fixture(); changed.state.onRead = () => { changed.state.size++; };
  assert.throws(() => changed.context.source_(changed.file.id), /Source changed during read/);
});
