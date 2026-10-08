'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../google-apps-script/publishing-controls/sidebar.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function harness() {
  class Element {
    constructor() { this.textContent = ''; this.hidden = false; this.disabled = false; this.children = []; this.attributes = {}; }
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const calls = [];
  const document = {body: new Element(), getElementById(id) { assert.ok(elements[id], `Unknown element: ${id}`); return elements[id]; }, createElement() { return new Element(); }};
  function runner(success, failure) {
    const api = {withSuccessHandler(fn) { return runner(fn, failure); }, withFailureHandler(fn) { return runner(success, fn); }};
    for (const name of ['registryUiGetStatus', 'registryPublishingRefreshStatus', 'registryPublishingUpdatePreview', 'registryPublishingReviewProduction', 'registryPublishingConfirmProduction']) {
      api[name] = (...args) => { calls.push({name, args, success, failure}); };
    }
    return api;
  }
  const context = vm.createContext({document, google: {script: {run: runner()}}, Date, Intl, Number});
  vm.runInContext(script, context);
  const ready = {phase: 'ready', preview_state: 'Preview ready', preview_ready_at: '2026-10-07T09:12:00Z',
    production_deploy: 'a'.repeat(24), production_checked_at: '2026-10-07T09:25:00Z',
    last_sync_at: '2026-10-07T09:17:00Z', last_sync_result: 'Files validated', automation: 'Manual website updates',
    publishing: {pending: 1, preview: 13, production: 12, production_enabled: true}};
  return {context, elements, calls, ready, load(patch = {}) { calls[0].success({...ready, ...patch}); },
    review(result = {}) { context.reviewProduction(); calls.at(-1).success({id: 'review-1', phase: 'ready', production_enabled: true,
      changes: [{action: 'Remove', title: 'Battery Curve Shape Explorer'}], ...result}); }};
}

test('opening the sidebar only reads status and cannot publish', () => {
  const h = harness();
  assert.deepEqual(h.calls.map(call => call.name), ['registryUiGetStatus']);
  h.context.confirmProduction(); h.context.reviewProduction(); h.context.act('update');
  assert.equal(h.calls.length, 1);
  assert.equal(h.elements.confirm.disabled, true);
});

test('review displays the change list without submitting a release', () => {
  const h = harness(); h.load(); h.review();
  assert.deepEqual(h.calls.map(call => call.name), ['registryUiGetStatus', 'registryPublishingReviewProduction']);
  assert.equal(h.elements.review.hidden, false);
  assert.equal(h.elements.confirm.disabled, false);
  assert.equal(h.elements.changes.children[0].children[0].textContent, 'Remove');
});

test('one explicit confirmation submits exactly once and blocks duplicate mutations', () => {
  const h = harness(); h.load(); h.review();
  h.context.confirmProduction(); h.context.confirmProduction(); h.context.act('update'); h.context.reviewProduction();
  assert.equal(h.calls.filter(call => call.name === 'registryPublishingConfirmProduction').length, 1);
  assert.deepEqual(h.calls.at(-1).args, ['review-1']);
  h.calls.at(-1).success({message: 'Release requested.'});
  assert.equal(h.elements.production.textContent, 'Release requested');
  assert.equal(h.elements.update.disabled, true);
  assert.equal(h.elements.reviewButton.disabled, true);
  assert.equal(h.elements.refresh.disabled, false);
});

test('a failed or uncertain production request is never retried automatically', () => {
  const h = harness(); h.load(); h.review(); h.context.confirmProduction();
  h.calls.at(-1).failure({message: 'Connection timed out. Check deployment status.'});
  assert.equal(h.elements.review.hidden, true);
  assert.equal(h.elements.message.attributes.role, 'alert');
  assert.equal(h.elements.reviewButton.disabled, true);
  h.context.confirmProduction();
  assert.equal(h.calls.filter(call => call.name === 'registryPublishingConfirmProduction').length, 1);
  h.context.act('refresh');
  assert.equal(h.calls.at(-1).name, 'registryPublishingRefreshStatus');
});

test('refresh cannot create or preserve a previously reviewed release', () => {
  const h = harness(); h.load(); h.review(); h.context.act('refresh');
  h.calls.at(-1).success(h.ready);
  assert.equal(h.elements.review.hidden, true);
  assert.equal(h.elements.confirm.disabled, true);
  assert.equal(h.calls.at(-1).name, 'registryPublishingRefreshStatus');
});

test('unconnected publishing cannot be confirmed', () => {
  const h = harness(); h.load(); h.review({production_enabled: false, production_disabled_reason: 'Publishing connection pending.'});
  assert.equal(h.elements.confirm.disabled, true);
  assert.equal(h.elements.connection.textContent, 'Publishing connection pending.');
  h.context.confirmProduction();
  assert.equal(h.calls.length, 2);
});

test('no-change review does not offer an empty publication', () => {
  const h = harness(); h.load(); h.review({changes: [{action: 'Unchanged', title: 'Existing project'}, {action: 'Not included', title: 'Draft project'}]});
  assert.equal(h.elements.confirm.disabled, true);
  assert.equal(h.elements.reviewSummary.textContent, 'No changes to publish.');
  assert.equal(h.elements.changes.children.length, 0);
});

test('timestamps and routine verification notes stay under Details in Singapore time', () => {
  const h = harness(); h.load({preview_warning: 'Using the last signed verification.'});
  assert.match(h.elements.productionChecked.textContent, /17:25 SGT$/);
  assert.match(h.elements.previewChecked.textContent, /17:12 SGT$/);
  assert.equal(h.elements.message.hidden, true);
  assert.equal(h.elements.notes.textContent, 'Using the last signed verification.');
  assert.equal(h.context.date('invalid-date'), 'Not checked');
  assert.match(html, /<details id="details">/);
  assert.doesNotMatch(html, /<details[^>]+open/);
});

test('in-progress preview or production disables further deployment actions', () => {
  const h = harness(); h.load({phase: 'requested'});
  assert.equal(h.elements.update.disabled, true); assert.equal(h.elements.reviewButton.disabled, true);
  h.context.render({...h.ready, publishing: {...h.ready.publishing, production_phase: 'building', production_state: 'Publishing…'}});
  assert.equal(h.elements.production.textContent, 'Publishing…');
  assert.equal(h.elements.update.disabled, true); assert.equal(h.elements.reviewButton.disabled, true);
  assert.equal(h.elements.refresh.disabled, false);
});

test('a previously ready release cannot be confirmed while a newer preview is pending', () => {
  const h = harness(); h.load({phase: 'accepted', publishing: {...h.ready.publishing, review: {
    id: 'older-review', phase: 'ready', production_enabled: true, changes: [{action: 'Update', title: 'TBB'}],
  }}});
  assert.equal(h.elements.review.hidden, false);
  assert.equal(h.elements.confirm.disabled, true);
  h.context.confirmProduction();
  assert.deepEqual(h.calls.map(call => call.name), ['registryUiGetStatus']);
});

test('project titles and backend errors are rendered as text', () => {
  const h = harness(); h.load();
  const title = '<img src=x onerror=alert(1)>';
  h.review({changes: [{action: 'Add', title}]});
  assert.equal(h.elements.changes.children[0].children[1].textContent, title);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML/);
});

test('a failed initial read offers Refresh status but no deployment action', () => {
  const h = harness(); h.calls[0].failure({message: 'Status unavailable.'});
  assert.equal(h.elements.update.disabled, true); assert.equal(h.elements.reviewButton.disabled, true);
  assert.equal(h.elements.refresh.disabled, false);
});

test('asynchronous review waits for an explicitly refreshed ready candidate before enabling Publish', () => {
  const h = harness(); h.load(); h.review({phase: 'preparing', production_enabled: false, message: 'Preparing release preview.'});
  assert.equal(h.elements.reviewSummary.textContent, 'Preparing release preview.');
  assert.equal(h.elements.confirm.disabled, true); assert.equal(h.elements.reviewButton.disabled, true);
  assert.equal(h.elements.update.disabled, true); assert.equal(h.elements.refresh.disabled, false);
  h.context.confirmProduction(); h.context.reviewProduction();
  assert.equal(h.calls.length, 2);
  h.context.act('refresh');
  h.calls.at(-1).success({...h.ready, publishing: {...h.ready.publishing, review: {
    id: 'review-ready', phase: 'ready', changes: [{action: 'Update', title: 'TBB'}], production_enabled: true,
    preview_url: 'https://' + 'b'.repeat(24) + '--aisigym.netlify.app/',
  }}});
  assert.equal(h.elements.confirm.disabled, false);
  assert.equal(h.elements.candidateLink.hidden, false);
  assert.equal(h.calls.length, 3);
  h.context.confirmProduction();
  assert.equal(h.calls.at(-1).name, 'registryPublishingConfirmProduction');
  assert.deepEqual(h.calls.at(-1).args, ['review-ready']);
});

test('opening an existing ready review displays it but still never publishes', () => {
  const h = harness(); h.load({publishing: {...h.ready.publishing, review: {
    id: 'saved-review', phase: 'ready', changes: [{action: 'Remove', title: 'TBB'}], production_enabled: true,
  }}});
  assert.equal(h.elements.review.hidden, false);
  assert.equal(h.elements.confirm.disabled, false);
  assert.deepEqual(h.calls.map(call => call.name), ['registryUiGetStatus']);
});

test('failed candidate preparation is visible and cannot publish', () => {
  const h = harness(); h.load(); h.review({phase: 'failed', production_enabled: false, error: 'Candidate validation failed.'});
  assert.equal(h.elements.message.textContent, 'Candidate validation failed.');
  assert.equal(h.elements.message.attributes.role, 'alert');
  assert.equal(h.elements.confirm.disabled, true);
  assert.equal(h.elements.reviewButton.disabled, false);
});

test('a ready flag without the ready phase or a verified publication capability is insufficient', () => {
  const h = harness(); h.load(); h.review({phase: 'expired', production_enabled: true});
  assert.equal(h.elements.confirm.disabled, true);
  h.review({phase: 'ready', production_enabled: false, production_disabled_reason: 'Selection changed. Review again.'});
  assert.equal(h.elements.confirm.disabled, true);
  assert.equal(h.elements.connection.textContent, 'Selection changed. Review again.');
});

test('only expected HTTPS Netlify candidate links are displayed', () => {
  const h = harness(); h.load(); h.review({preview_url: 'javascript:alert(1)'});
  assert.equal(h.elements.candidateLink.hidden, true);
  h.review({preview_url: 'https://aisigym.netlify.app.evil.test/'});
  assert.equal(h.elements.candidateLink.hidden, true);
});

test('a failed live production status check is not hidden by a cached Published state', () => {
  const h = harness(); h.load({production_warning: 'Production status could not be checked.',
    publishing: {...h.ready.publishing, production_state: 'Published'}});
  assert.equal(h.elements.production.textContent, 'Check needed');
  assert.match(h.elements.notes.textContent, /could not be checked/);
});

test('a stale all-keep review explains why it must be prepared again', () => {
  const h = harness(); h.load(); h.review({changes: [{action: 'Keep', title: 'TBB'}], production_enabled: false,
    production_disabled_reason: 'Selection changed. Review the changes again.'});
  assert.equal(h.elements.reviewSummary.textContent, 'This review cannot be published.');
  assert.equal(h.elements.connection.hidden, false);
  assert.equal(h.elements.connection.textContent, 'Selection changed. Review the changes again.');
  assert.equal(h.elements.confirm.disabled, true);
});

test('a successful no-change review does not repeat a blocking notice', () => {
  const h = harness(); h.load(); h.review({changes: [{action: 'Keep', title: 'TBB'}], production_enabled: false,
    production_disabled_reason: 'No production changes to publish.'});
  assert.equal(h.elements.reviewSummary.textContent, 'No changes to publish.');
  assert.equal(h.elements.connection.hidden, true);
});

test('a signed production failure displays its reason prominently', () => {
  const h = harness(); h.load({publishing: {...h.ready.publishing, production_phase: 'failed',
    production_state: 'Publish failed', production_error: 'The reviewed artifact failed validation.'}});
  assert.equal(h.elements.production.textContent, 'Publish failed');
  assert.equal(h.elements.message.textContent, 'The reviewed artifact failed validation.');
  assert.equal(h.elements.message.attributes.role, 'alert');
});
