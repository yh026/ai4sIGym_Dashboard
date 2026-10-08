'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReleaseIntent, assertCurrentIntent, assertCandidate, createDraftRequest, digest,
  HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION } = require('./release-plan.cjs');

const h = text => digest(text);
const clone = value => structuredClone(value);
function fixture() {
  const catalog = ['a', 'b', 'c'].map(letter => ({ demo_id: 'demo-' + letter, slug: letter }));
  const project = letter => ({ ...catalog.find(row => row.slug === letter), content_digest: h(letter) });
  const common = { site_id: '2fe21bb6-70b5-47c6-a810-18f6bd8f4973', state: 'ready',
    commit_ref: 'c'.repeat(40), inventory_digest: h('inventory'), receipt_digest: h('receipt') };
  const baseline = { ...common, environment: 'production', branch: 'main', context: 'production',
    deploy_id: 'a'.repeat(24), projects: [project('a'), project('b')],
    publication_overrides: [HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION] };
  const preview = { ...common, environment: 'preview', branch: 'develop', context: 'branch-deploy',
    deploy_id: 'b'.repeat(24), verified: true, registry_revision: h('registry'),
    projects: [{ ...project('a'), content_digest: h('a-new') }, project('c')] };
  const selection = catalog.map(row => ({ demo_id: row.demo_id,
    include_in_production: true, include_in_preview: row.slug !== 'b' }));
  return { catalog, selection, baseline, preview, now: '2026-10-07T01:00:00.000Z' };
}
function candidate(intent) {
  return { site_id: intent.site_id, deploy_id: 'd'.repeat(24), state: 'ready', draft: true,
    intent_digest: intent.intent_digest, inventory_digest: h('candidate'), catalog_pages_regenerated: true,
    projects: clone(intent.projects), preserved_overrides: clone(intent.publication.required_overrides),
    unselected_routes_absent: true, source_files_unchanged: true, notebook_downloads_absent: true,
    homepage_introduction_unchanged: true };
}

test('selective release updates from reviewed preview, retains production-only project, and adds reviewed project', () => {
  const input = fixture(), before = clone(input), intent = createReleaseIntent(input);
  assert.deepEqual(intent.projects.map(p => [p.demo_id, p.action, p.source_environment]),
    [['demo-a', 'update', 'preview'], ['demo-b', 'keep', 'production'], ['demo-c', 'add', 'preview']]);
  assert.deepEqual(input, before);
  assert.equal(intent.publication.shell_source_deploy_id, input.baseline.deploy_id);
  assert.equal(intent.publication.preserve_homepage_introduction, true);
  assert.equal(intent.publication.omit_notebook_downloads, true);
  assertCurrentIntent(intent, input);
  assertCandidate(intent, candidate(intent));
});

test('explicit unpublish produces a removal without mutating either source snapshot', () => {
  const input = fixture(); input.selection[1].include_in_production = false;
  const intent = createReleaseIntent(input);
  assert.deepEqual(intent.removals.map(p => p.demo_id), ['demo-b']);
  assert.equal(input.baseline.projects.length, 2);
  assert.equal(intent.projects.some(p => p.demo_id === 'demo-b'), false);
});

test('all-off is a valid empty production library; no sources are deleted', () => {
  const input = fixture(); input.selection.forEach(row => row.include_in_production = false);
  const intent = createReleaseIntent(input);
  assert.equal(intent.projects.length, 0); assert.equal(intent.removals.length, 2);
  assertCandidate(intent, candidate(intent));
});

test('a removal-only review does not require preview content', () => {
  const input = fixture(); input.preview = null;
  input.selection.forEach(row => { row.include_in_preview = false; row.include_in_production = false; });
  const intent = createReleaseIntent(input); assert.equal(intent.reviewed_preview, null);
  assert.equal(intent.removals.length, 2);
});

test('missing, duplicate, nonboolean, unknown, and route-changed settings fail closed', () => {
  for (const mutate of [
    i => i.selection.pop(), i => i.selection.push(i.selection[0]),
    i => i.selection[0].include_in_production = 'TRUE', i => i.selection[0].demo_id = 'unknown',
    i => i.catalog[0].slug = 'changed', i => i.catalog[1].slug = 'a',
  ]) { const input = fixture(); mutate(input); assert.throws(() => createReleaseIntent(input)); }
});

test('a project cannot be added from unverified, wrong-site, stale-branch, or missing preview content', () => {
  for (const mutate of [i => i.preview.verified = false, i => i.preview.site_id = '0'.repeat(36),
    i => i.preview.branch = 'main', i => i.preview.projects.pop(), i => i.preview = null,
    i => i.selection[2].include_in_preview = false]) {
    const input = fixture(); mutate(input); assert.throws(() => createReleaseIntent(input));
  }
});

test('new unrecognized publication override requires explicit implementation', () => {
  const input = fixture(); input.baseline.publication_overrides.push('unknown-policy');
  assert.throws(() => createReleaseIntent(input), /unsupported/);
});

test('confirmation becomes invalid if baseline, preview, a checkbox, or source content changes', () => {
  for (const mutate of [i => i.baseline.deploy_id = 'e'.repeat(24),
    i => i.baseline.inventory_digest = h('new-baseline'), i => i.preview.deploy_id = 'f'.repeat(24),
    i => i.preview.registry_revision = h('new-registry'),
    i => i.selection[0].include_in_production = false,
    i => i.preview.projects[0].content_digest = h('new-content')]) {
    const input = fixture(), intent = createReleaseIntent(input); mutate(input);
    assert.throws(() => assertCurrentIntent(intent, input), /changed/);
  }
});

test('expired, future, and edited release intents cannot be published', () => {
  const input = fixture(), intent = createReleaseIntent(input);
  for (const now of ['2026-10-07T01:30:00.001Z', '2026-10-07T00:59:59.999Z', 'bad']) {
    assert.throws(() => assertCurrentIntent(intent, { ...input, now }), /expired/);
  }
  intent.projects.pop(); assert.throws(() => assertCurrentIntent(intent, input), /changed/);
});

test('unchanged project order does not create a different selection or release', () => {
  const input = fixture(), intent = createReleaseIntent(input);
  input.catalog.reverse(); input.selection.reverse(); input.baseline.projects.reverse(); input.preview.projects.reverse();
  assert.equal(createReleaseIntent(input).intent_digest, intent.intent_digest);
});

test('candidate may not publish either source, extra routes, altered science, or lost production overrides', () => {
  const intent = createReleaseIntent(fixture());
  for (const mutate of [c => c.draft = false, c => c.state = 'uploading',
    c => c.deploy_id = intent.baseline.deploy_id, c => c.deploy_id = intent.reviewed_preview.deploy_id,
    c => c.projects.pop(), c => c.projects[0].content_digest = h('changed'),
    c => c.preserved_overrides.pop(), c => c.unselected_routes_absent = false,
    c => c.source_files_unchanged = false, c => c.notebook_downloads_absent = false,
    c => c.homepage_introduction_unchanged = false, c => c.catalog_pages_regenerated = false]) {
    const draft = candidate(intent); mutate(draft); assert.throws(() => assertCandidate(intent, draft));
  }
});

test('file digest request is always draft and async, with generated release controls required', () => {
  const intent = createReleaseIntent(fixture());
  const files = Object.fromEntries(['/index.html', '/manifest.json', '/deploy-receipt.json', '/robots.txt', '/_headers']
    .map(path => [path, 'a'.repeat(40)]));
  const request = createDraftRequest(intent, files);
  assert.equal(request.draft, true); assert.equal(request.async, true);
  assert.equal(request.branch, undefined);
  assert.throws(() => createDraftRequest(intent, { ...files, '/../outside': 'a'.repeat(40) }), /invalid/);
  assert.throws(() => createDraftRequest(intent, { ...files, '/x?secret': 'a'.repeat(40) }), /invalid/);
  delete files['/_headers']; assert.throws(() => createDraftRequest(intent, files), /missing/);
});
