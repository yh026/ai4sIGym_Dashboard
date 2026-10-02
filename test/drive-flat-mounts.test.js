'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const SOURCE = fs.readFileSync(path.join(__dirname, '../google-apps-script/sandbox/SourceMounts.gs'), 'utf8');
const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';

function categoryFixture() {
  const entries = new Map(), properties = {};
  function folder(id, name, parentIds = []) {
    const entry = { id, name, parentIds: Array.isArray(parentIds) ? parentIds : [parentIds],
      getId() { return this.id; }, getName() { return this.name; },
      getParents() {
        const remaining = this.parentIds.map(parent => entries.get(parent));
        return { hasNext: () => remaining.length > 0, next: () => remaining.shift() };
      } };
    entries.set(id, entry);
    return entry;
  }
  folder(ROOT, 'AIS Instrumentation Gym');
  folder('outside', 'Unrelated root');
  folder('demo-html', 'demo_html', ROOT);
  folder('project', '04_satellite', 'demo-html');
  folder('version', 'satellite-draft-v1', 'project');
  folder('dataset-container', 'dataset', 'project');
  folder('dataset-version', 'v2', 'dataset-container');
  folder('skills', 'skills', ROOT);
  folder('skill-project', '04_satellite', 'skills');
  folder('resources', 'resources', 'skill-project');
  folder('nested', 'skills', 'resources');
  folder('admin', '_admin', ROOT);
  folder('backend', '_backend_develop', 'admin');
  const context = vm.createContext({
    SANDBOX: { drive_root_id: 'backend' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name] || null }) },
  });
  vm.runInContext(SOURCE, context);
  const config = { schema: 2, root_id: ROOT, mounts: [
    { id: 'version', ancestor_chain: ['project', 'demo-html', ROOT], logical_path: 'projects/satellite/satellite-draft-v1' },
    { id: 'dataset-version', ancestor_chain: ['dataset-container', 'project', 'demo-html', ROOT], logical_path: 'datasets/eurosat-rgb/v2' },
    { id: 'resources', ancestor_chain: ['skill-project', 'skills', ROOT], logical_path: 'projects/satellite/satellite-draft-v1/resources' },
    { id: 'nested', ancestor_chain: ['resources', 'skill-project', 'skills', ROOT], logical_path: 'projects/satellite/satellite-draft-v1/resources/skills' },
  ] };
  function configure(value = config) { properties.AIS_PROJECT_MOUNTS_V1 = JSON.stringify(value); }
  configure();
  return { folder, entries, context, config, configure,
    source(id = 'page', name = 'insight.html', parent = 'version') { return folder(id, name, parent); },
    resolve(entry) { return context.mountedSourceParentPath_(entry); } };
}

function fixture() {
  const h = categoryFixture();
  h.config.schema = 3;
  h.config.mounts = [
    { id: 'project', ancestor_chain: ['demo-html', ROOT], bindings: [
      { logical_path: 'projects/satellite/satellite-draft-v1', file_ids: ['insight-file-00000000000001', 'cover-file-000000000000001'] },
      { logical_path: 'datasets/eurosat-rgb/v2', file_ids: ['dataset-file-00000000000001'] },
    ] },
    { id: 'skill-project', ancestor_chain: ['skills', ROOT], bindings: [
      { logical_path: 'projects/satellite/satellite-draft-v1/resources', file_ids: ['notebook-file-0000000000001'] },
      { logical_path: 'projects/satellite/satellite-draft-v1/resources/skills', file_ids: ['skill-file-0000000000000001'] },
    ] },
  ];
  h.configure(); return h;
}
test('flat HTML and skills folders preserve different logical paths by exact file identity', () => {
  const h = fixture();
  assert.equal(h.resolve(h.source('insight-file-00000000000001', 'insight.html', 'project')), 'projects/satellite/satellite-draft-v1');
  assert.equal(h.resolve(h.source('dataset-file-00000000000001', 'dataset.html', 'project')), 'datasets/eurosat-rgb/v2');
  assert.equal(h.resolve(h.source('notebook-file-0000000000001', 'analysis.ipynb', 'skill-project')), 'projects/satellite/satellite-draft-v1/resources');
  assert.equal(h.resolve(h.source('skill-file-0000000000000001', 'pca.zip', 'skill-project')), 'projects/satellite/satellite-draft-v1/resources/skills');
  h.entries.get('project').name = '001-renamed'; h.entries.get('dataset-file-00000000000001').name = 'renamed.html';
  assert.equal(h.resolve(h.entries.get('dataset-file-00000000000001')), 'datasets/eurosat-rgb/v2');
});
test('flat mounts reject neighbouring files, clones, nested files and cross-project moves', () => {
  for (const [id, parent] of [['unlisted-file-0000000000001', 'project'], ['insight-file-00000000000001', 'skill-project'], ['insight-file-00000000000001', 'version']]) {
    const h = fixture(); assert.throws(() => h.resolve(h.source(id, 'insight.html', parent)), /not explicitly allowed|no explicit flat mount/);
  }
});
test('flat resolution freshly checks every ancestor and rejects ambiguous parents', () => {
  for (const id of ['project', 'demo-html']) {
    const h = fixture(), file = h.source('insight-file-00000000000001', 'insight.html', 'project'); h.resolve(file);
    h.entries.get(id).parentIds = ['outside']; assert.throws(() => h.resolve(file), /outside its approved location/);
  }
  const h = fixture(), file = h.source('insight-file-00000000000001', 'insight.html', 'project'); h.resolve(file);
  file.parentIds.push('outside'); assert.throws(() => h.resolve(file), /Ambiguous/);
});
test('archived registered HTML can retain the same logical path in a separately allowlisted folder', () => {
  const h = fixture(); h.folder('archive', 'archive', ROOT); h.folder('archived-version', 'old-version', 'archive');
  h.config.mounts.push({ id: 'archived-version', ancestor_chain: ['archive', ROOT], bindings: [
    { logical_path: 'projects/satellite/satellite-draft-v1', file_ids: ['resource-page-file-00000001'] },
  ] }); h.configure();
  assert.equal(h.resolve(h.source('resource-page-file-00000001', 'resource_page.html', 'archived-version')), 'projects/satellite/satellite-draft-v1');
  assert.throws(() => h.resolve(h.source('insight-file-00000000000001', 'insight.html', 'archived-version')), /not explicitly allowed/);
});
test('flat schema rejects duplicate IDs, malformed allowlists, unsafe paths and bad chains', () => {
  const cases = [
    c => { c.mounts[0].bindings = []; }, c => { c.mounts[0].bindings[0].file_ids = []; },
    c => { c.mounts[0].bindings[0].file_ids.push('short'); },
    c => { c.mounts[0].bindings[1].file_ids = c.mounts[0].bindings[0].file_ids; },
    c => { c.mounts[1].bindings[0].file_ids = c.mounts[0].bindings[0].file_ids; },
    c => { c.mounts.push(c.mounts[0]); }, c => { c.mounts[0].bindings.push(c.mounts[0].bindings[0]); },
    c => { c.mounts[0].bindings[0].logical_path = 'projects/satellite/version/resources/../secret'; },
    c => { c.mounts[0].ancestor_chain = ['project', ROOT]; },
    c => { c.root_id = 'outside'; }, c => { c.mounts[0].ancestor_chain = ['demo-html', 'outside']; },
  ];
  for (const mutate of cases) {
    const h = fixture(); mutate(h.config); h.configure();
    assert.throws(() => h.resolve(h.source('insight-file-00000000000001', 'insight.html', 'project')), /Invalid|duplicate|Unrecognized/);
  }
});
test('flat layout retains scoped backend imports without allowing unrelated root files', () => {
  const h = fixture(); h.folder('imports', 'imports', 'backend');
  assert.equal(h.resolve(h.source('admin-json-file-0000000001', 'config.json', 'imports')), 'imports');
  assert.throws(() => h.resolve(h.source('root-file-000000000000001', 'config.json', ROOT)), /no parent/);
});

