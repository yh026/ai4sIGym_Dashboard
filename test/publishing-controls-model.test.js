'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname,
  '../google-apps-script/publishing-controls/PublishingControlsModel.gs'), 'utf8');
const model = require('../google-apps-script/publishing-controls/PublishingControlsModel.gs');
const A = 'demo-a', B = 'demo-b', C = 'demo-c';
const hash = digit => 'sha256:' + digit.repeat(64);
const project = (id, digit = 'a', version = 'version-1') => ({demo_id: id,
  version_id: version, fingerprint: hash(digit)});
const snapshot = (environment, projects, known = true) => ({environment, projects, known});
function input(environment = 'preview') {
  return {environment, catalog: [A, B, C].map(demo_id => ({demo_id})),
    selection: [A, B, C].map(demo_id => ({demo_id, includePreview: true, includeProduction: true})),
    candidate: snapshot('preview', [project(A), project(B), project(C)]),
    actual: snapshot(environment, [project(A), project(B), project(C)])};
}

test('loads in Apps Script without CommonJS or service dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.RegistryPublishingModel.plan, 'function');
});

test('matches by stable ID when catalog, selection and manifest orders differ', () => {
  const value = input(); value.selection.reverse(); value.actual.projects.reverse();
  const result = model.plan(value);
  assert.deepEqual(result.rows.map(row => row.demo_id), [A, B, C]);
  assert.equal(result.canRelease, true); assert.equal(result.changes.length, 0);
});

test('unknown actual does not falsely report unpublished projects or permit release', () => {
  const value = input(); value.actual = snapshot('preview', [], false);
  const result = model.plan(value);
  assert.equal(result.canRelease, false);
  assert.ok(result.rows.every(row => row.status === 'Not checked' && row.action === 'unknown'));
  assert.deepEqual(result.changes, []);
});

test('known empty actual produces additions rather than unknowns', () => {
  const value = input(); value.actual.projects = [];
  const result = model.plan(value);
  assert.equal(result.canRelease, true);
  assert.ok(result.rows.every(row => row.status === 'Not published' && row.action === 'add'));
});

test('staged uncheck shows removal while actual still reads Published', () => {
  const value = input(); value.selection[0].includePreview = false;
  const result = model.plan(value);
  assert.deepEqual([result.rows[0].status, result.rows[0].action, result.rows[0].pending],
    ['Published', 'remove', true]);
  assert.deepEqual(result.release.map(row => row.demo_id), [B, C]);
});

test('same version with changed content is an update', () => {
  const value = input(); value.candidate.projects[0].fingerprint = hash('b');
  const result = model.plan(value);
  assert.equal(result.rows[0].action, 'update'); assert.equal(result.changes.length, 1);
});

test('missing content hashes are unknown even when version labels match', () => {
  const value = input(); value.actual.projects[0].fingerprint = '';
  const result = model.plan(value);
  assert.equal(result.rows[0].action, 'unknown'); assert.equal(result.canRelease, false);
});

test('production selection is independent of preview selection', () => {
  const value = input('production'); value.selection[0].includePreview = false;
  assert.equal(model.plan(value).rows[0].action, 'none');
  value.selection[0].includeProduction = false;
  assert.equal(model.plan(value).rows[0].action, 'remove');
});

test('preview uncheck never removes production and preview checkbox alone never publishes', () => {
  const value = input(); value.selection[0].includeProduction = false;
  assert.equal(model.plan(value).rows[0].action, 'none');
  value.environment = 'production'; value.actual.environment = 'production';
  value.actual.projects = value.actual.projects.slice(1);
  assert.equal(model.plan(value).rows[0].action, 'none');
});

test('production retains its current version when preview inclusion is off and the project is absent from preview', () => {
  const value = input('production'); value.candidate.projects = value.candidate.projects.slice(1);
  value.selection[0].includePreview = false;
  const result = model.plan(value);
  assert.equal(result.canRelease, true); assert.equal(result.rows[0].action, 'none');
  assert.deepEqual(result.release[0], {demo_id: A, source: 'production',
    version_id: 'version-1', fingerprint: hash('a')});
});

test('production preview opt-out retains the public version even if newer content remains deployed in preview', () => {
  const value = input('production'); value.selection[0].includePreview = false;
  value.candidate.projects[0] = project(A, 'b', 'version-2');
  const result = model.plan(value);
  assert.equal(result.rows[0].action, 'none'); assert.equal(result.rows[0].source, 'production');
  assert.equal(result.release[0].fingerprint, hash('a')); assert.equal(result.release[0].version_id, 'version-1');
});

test('production preview opt-in requires reviewed preview content instead of silently retaining public content', () => {
  const value = input('production'); value.candidate.projects = value.candidate.projects.slice(1);
  const result = model.plan(value);
  assert.equal(result.rows[0].action, 'blocked'); assert.equal(result.canRelease, false);
});

test('a new production project cannot be added from lingering preview content after preview inclusion is turned off', () => {
  const value = input('production'); value.actual.projects = value.actual.projects.slice(1);
  value.selection[0].includePreview = false;
  assert.equal(model.plan(value).rows[0].action, 'blocked');
  assert.equal(model.plan(value).canRelease, false);
});

test('retaining only current production versions does not require preview content', () => {
  const value = input('production'); value.selection.forEach(row => { row.includePreview = false; });
  value.candidate = snapshot('preview', [], false);
  const result = model.plan(value);
  assert.equal(result.canRelease, true); assert.deepEqual(result.changes, []);
  assert.ok(result.release.every(row => row.source === 'production'));
});

test('preview cannot inherit production when included content is unavailable', () => {
  const value = input(); value.candidate.projects = value.candidate.projects.slice(1);
  assert.equal(model.plan(value).rows[0].action, 'blocked');
  assert.equal(model.plan(value).canRelease, false);
});

test('new production project absent from preview is blocked', () => {
  const value = input('production'); value.candidate.projects = []; value.actual.projects = [];
  assert.ok(model.plan(value).rows.every(row => row.action === 'blocked'));
});

test('unknown candidate does not allow retaining production as if its absence was known', () => {
  const value = input('production'); value.candidate.known = false;
  assert.equal(model.plan(value).canRelease, false);
  assert.ok(model.plan(value).rows.every(row => row.action === 'unknown'));
});

test('unmanaged deployed projects block release instead of being silently removed', () => {
  const value = input(); value.actual.projects.push(project('demo-unmanaged'));
  assert.match(model.plan(value).blockers.join(' '), /unmanaged project/);
});

test('unmanaged candidate projects also block release', () => {
  const value = input(); value.candidate.projects.push(project('demo-unmanaged'));
  assert.equal(model.plan(value).canRelease, false);
});

test('rejects missing, duplicate, invalid and foreign selection IDs', () => {
  for (const mutate of [
    value => value.selection.pop(),
    value => value.selection.push({...value.selection[0]}),
    value => value.selection[0].demo_id = '../demo-a',
    value => value.selection[0].demo_id = 'demo-foreign',
  ]) { const value = input(); mutate(value); assert.throws(() => model.plan(value)); }
});

test('rejects pasted string checkboxes instead of truthiness coercion', () => {
  const value = input(); value.selection[0].includePreview = 'FALSE';
  assert.throws(() => model.plan(value), /must be booleans/);
});

test('rejects mismatched environments and malformed hashes', () => {
  const value = input(); value.actual.environment = 'production';
  assert.throws(() => model.plan(value), /environment mismatch/);
  value.actual.environment = 'preview'; value.actual.projects[0].fingerprint = 'same-content';
  assert.throws(() => model.plan(value), /fingerprint/);
});

test('V3 adapter uses bundle digest and never mutates source manifests', () => {
  const manifest = {audience: 'preview', demos: [{demo_id: A}],
    bundles: [{demo_id: A, version_id: 'version-1', snapshot_digest: hash('a')}]};
  const before = JSON.stringify(manifest);
  const result = model.snapshotFromManifest(manifest, {environment: 'preview', verified: true});
  assert.deepEqual(result.projects, [project(A)]); assert.equal(JSON.stringify(manifest), before);
});

test('public manifest membership does not invent version or fingerprint evidence', () => {
  const result = model.snapshotFromManifest({demos: [{demo_id: A}]},
    {environment: 'production', verified: true});
  assert.equal(result.known, true);
  assert.deepEqual(result.projects, [{demo_id: A, version_id: '', fingerprint: ''}]);
});

test('failed manifest verification returns unknown even when old data exists', () => {
  const result = model.snapshotFromManifest({demos: [{demo_id: A}]},
    {environment: 'preview', verified: false, reason: 'Refresh failed.'});
  assert.equal(result.known, false); assert.deepEqual(result.projects, []);
});

test('V3 bundle and demo membership must agree exactly', () => {
  assert.throws(() => model.snapshotFromManifest({demos: [{demo_id: A}], bundles: []},
    {environment: 'preview', verified: true}), /no bundle/);
  assert.throws(() => model.snapshotFromManifest({demos: [], bundles: [{demo_id: A}]},
    {environment: 'preview', verified: true}), /no manifest project/);
});

test('planning is deterministic and does not mutate staging or active state', () => {
  const value = input('production'); value.selection[1].includeProduction = false;
  const before = JSON.stringify(value), first = model.plan(value), second = model.plan(value);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(value), before);
});
