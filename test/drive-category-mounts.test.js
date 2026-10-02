'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const SOURCE = fs.readFileSync(path.join(__dirname, '../google-apps-script/sandbox/SourceMounts.gs'), 'utf8');
const ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';

function fixture() {
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

test('category mounts preserve version paths across physical folder and file renames', () => {
  const h = fixture(), page = h.source();
  assert.equal(h.resolve(page), 'projects/satellite/satellite-draft-v1');
  for (const id of ['demo-html', 'project', 'version']) h.entries.get(id).name = 'renamed numbered folder';
  page.name = 'new-insight-name.html';
  assert.equal(h.resolve(page), 'projects/satellite/satellite-draft-v1');
  assert.equal(h.resolve(h.source('dataset', 'dataset.html', 'dataset-version')), 'datasets/eurosat-rgb/v2');
});

test('explicit resource mounts preserve separate skills and nested download logical paths', () => {
  const h = fixture();
  assert.equal(h.resolve(h.source('notebook', 'analysis.ipynb', 'resources')), 'projects/satellite/satellite-draft-v1/resources');
  assert.equal(h.resolve(h.source('skill', 'pca.zip', 'nested')), 'projects/satellite/satellite-draft-v1/resources/skills');
  h.folder('unregistered', 'unregistered', 'resources');
  assert.throws(() => h.resolve(h.source('unexpected', 'extra.zip', 'unregistered')), /no explicit category mount/);
  h.config.mounts = h.config.mounts.filter(mount => mount.id !== 'nested'); h.configure();
  assert.throws(() => h.resolve(h.entries.get('skill')), /no explicit category mount/);
});

test('each ancestor ID is checked, including the category and trusted root', () => {
  for (const moved of ['version', 'project', 'demo-html']) {
    const h = fixture(), page = h.source();
    h.entries.get(moved).parentIds = ['outside'];
    assert.throws(() => h.resolve(page), /outside its approved location/, moved);
  }
  const h = fixture(), page = h.source();
  h.folder('sibling-project', '04_satellite', 'demo-html');
  h.entries.get('version').parentIds = ['sibling-project'];
  assert.throws(() => h.resolve(page), /outside its approved location/);
});

test('ambiguous parents and unregistered sources fail closed', () => {
  for (const ambiguous of ['page', 'version', 'project', 'demo-html']) {
    const h = fixture(), page = h.source();
    h.entries.get(ambiguous).parentIds.push('outside');
    assert.throws(() => h.resolve(page), /Ambiguous source parents/, ambiguous);
  }
  const h = fixture();
  assert.throws(() => h.resolve(h.source('outside-page', 'insight.html', 'outside')), /no parent|outside/);
  assert.throws(() => h.resolve(h.source('project-page', 'insight.html', 'project')), /no parent|outside/);
});

test('schema 2 rejects invalid roots, cycles, duplicate mounts and noncanonical logical paths', () => {
  const cases = [
    config => { config.root_id = 'outside'; },
    config => { config.schema = 3; },
    config => { config.mounts[0].ancestor_chain = []; },
    config => { config.mounts[0].ancestor_chain = ['project', 'outside']; },
    config => { config.mounts[0].ancestor_chain = ['project', 'version', ROOT]; },
    config => { config.mounts[0].ancestor_chain = ['project', 'project', ROOT]; },
    config => { config.mounts.push({ ...config.mounts[0] }); },
    config => { config.mounts[1].logical_path = config.mounts[0].logical_path; },
    config => { config.mounts[0].logical_path = 'projects/satellite'; },
    config => { config.mounts[0].logical_path = 'projects/satellite/version/other'; },
    config => { config.mounts[0].logical_path = 'projects/satellite/version/resources/../secret'; },
    config => { config.mounts[1].logical_path = 'datasets/eurosat/v2/nested'; },
    config => { config.mounts[0].logical_path = '/projects/satellite/version'; },
    config => { config.mounts[0].logical_path = 'projects/satellite/version/resources/%2e%2e'; },
  ];
  for (const mutate of cases) {
    const h = fixture(), page = h.source();
    mutate(h.config); h.configure();
    assert.throws(() => h.resolve(page), /Invalid|Unrecognized|Unsupported/);
  }
});

test('admin backend root remains usable after moving beneath _admin', () => {
  const h = fixture();
  h.folder('snapshots', 'snapshots', 'backend');
  assert.equal(h.resolve(h.source('snapshot', 'revision.json', 'snapshots')), 'snapshots');
  h.folder('imports', 'imports', 'backend');
  assert.equal(h.resolve(h.source('import', 'import.json', 'imports')), 'imports');
});

test('existing schema 1 project mappings remain backward compatible', () => {
  for (const schema of [undefined, 1]) {
    const h = fixture();
    h.entries.get('project').parentIds = [ROOT];
    h.folder('develop', 'develop', 'project');
    h.entries.get('version').parentIds = ['develop'];
    h.configure({ ...(schema ? { schema } : {}), root_id: ROOT,
      mounts: [{ id: 'develop', project_id: 'project', logical_path: 'projects/satellite' }] });
    assert.equal(h.resolve(h.source()), 'projects/satellite/satellite-draft-v1');
    h.entries.get('project').parentIds = ['outside'];
    assert.throws(() => h.resolve(h.entries.get('page')), /outside its approved location/);
  }
});
