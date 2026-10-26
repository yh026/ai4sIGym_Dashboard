'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const text = '<html><head></head><body>same</body></html>', bytes = [...Buffer.from(text)];
  const snapshot = { manifest: { registry_revision: 'sha256:' + 'a'.repeat(64), registry_instance: 'sandbox', demos: [{ demo_id: 'example' }] }, files: [
    { id: 'page-battery-curve-shape-explorer-dataset', kind: 'page' },
    { id: 'card-battery-curve-shape-explorer', kind: 'resource' },
    { id: 'res-tbb-cluster-explorer-2-0', kind: 'resource' },
  ].map(file => ({ ...file, size: bytes.length, sha256: hash(bytes) })) };
  const env = { phase: 'complete', contextHash: 'unchanged-context', preview: 'unchanged-preview', syncCalls: 0, token: 'private-token', requests: [], reports: [], logs: [] };
  const context = vm.createContext({ console: { log: message => env.logs.push(message) },
    CATEGORY_V3_MIGRATION_ID: 'drive-category-20261002', V3: { stable: JSON.stringify }, hash_: hash,
    categoryV3BatchContext_: () => ({ hash: env.contextHash, snapshot: copy(snapshot), binding: { registry_revision: snapshot.manifest.registry_revision } }),
    categoryV3BatchProgress_: () => ({ phase: env.phase }), sandboxGuard_: () => ({}), locked_: fn => fn(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SANDBOX_PREVIEW_STATE' ? env.preview : env.token }) },
    Utilities: { newBlob: data => ({ getBytes: () => [...Buffer.from(data)] }), base64Decode: data => [...Buffer.from(data, 'base64')] },
    categoryV3SaveJson_: (name, report) => { env.reports.push(copy(report)); return 'report-file'; },
    syncSandbox: () => { env.syncCalls++; if (env.onSync) env.onSync(); return copy(env.syncManifest || snapshot.manifest); },
    publishPreview: () => { throw new Error('Publishing forbidden'); },
    doGet: event => {
      const query = event.parameter; assert.equal(query.token, env.token);
      env.requests.push({ action: query.action, id: query.id });
      let response = query.action === 'manifest' ? { ok: true, ...copy(snapshot.manifest) } : {
        ok: true, id: query.id, registry_instance: 'sandbox', registry_revision: snapshot.manifest.registry_revision,
        ...(query.action === 'page' ? { html: text } : { base64: Buffer.from(bytes).toString('base64') }),
      };
      if (env.onResponse) response = env.onResponse(response);
      return { getContent: () => JSON.stringify(response) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google-apps-script/migration/CategoryDevelopRuntimeCheck.gs'), 'utf8'), context);
  return { context, env, snapshot };
}
test('runtime sync is separate from authenticated API scans and saves only sanitized reports', () => {
  const h = fixture(); assert.equal(h.context.categoryV3RuntimeCheck().result, 'PASS');
  assert.equal(h.env.syncCalls, 1); assert.equal(h.env.requests.length, 0);
  assert.equal(h.context.categoryV3RuntimeManifestCheck().result, 'PASS');
  assert.equal(h.env.requests.length, 1); assert.equal(h.context.categoryV3RuntimeSamplesCheck().result, 'PASS');
  assert.deepEqual(h.env.requests.map(request => request.action), ['manifest', 'page', 'resource', 'resource']);
  assert.equal(h.env.syncCalls, 1); assert.equal(h.env.reports.length, 3);
  assert.equal(JSON.stringify([h.env.reports, h.env.logs]).includes(h.env.token), false);
  for (const report of h.env.reports) { assert.equal(report.scope, 'editor-runtime-only'); assert.equal(typeof report.elapsed_ms, 'number'); }
});
test('runtime checks require completed source verification and reject changed state without a PASS report', () => {
  for (const mutate of [h => { h.env.phase = 'hashing'; }, h => { h.env.onSync = () => { h.env.preview = 'changed'; }; },
    h => { h.env.onSync = () => { h.env.contextHash = 'changed'; }; }, h => { h.env.syncManifest = {}; }]) {
    const h = fixture(); mutate(h); assert.throws(() => h.context.categoryV3RuntimeCheck()); assert.equal(h.env.reports.length, 0);
  }
});
test('internal API checks reject response errors, differing metadata, bytes and manifest contents', () => {
  for (const change of [response => ({ ...response, ok: false, error: 'private response must not be logged' }),
    response => ({ ...response, registry_revision: 'different' }), response => ({ ...response, id: 'wrong' }),
    response => ({ ...response, html: 'different', base64: Buffer.from('different').toString('base64') })]) {
    const h = fixture(); h.env.onResponse = change; assert.throws(() => h.context.categoryV3RuntimeSamplesCheck()); assert.equal(h.env.reports.length, 0); assert.equal(h.env.logs.length, 0);
  }
  const h = fixture(); h.env.onResponse = response => ({ ...response, demos: [] });
  assert.throws(() => h.context.categoryV3RuntimeManifestCheck(), /manifest differs/); assert.equal(h.env.reports.length, 0);
});
