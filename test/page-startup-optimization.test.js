'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { optimizePageStartup } = require('../lib/page-startup-optimization');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/page-startup', name + '.js.txt'), 'utf8');
const identity = name => ({ role: 'insight', slug: {
  tbb: 'tbb-cluster-explorer-2',
  'single-cell': 'from-twenty-thousand-genes-to-fourteen-cell-types',
  alzheimer: 'alzheimer-s-gene-co-expression-explorer',
}[name] });
const script = code => '<script>' + code + '</script>';
function page(name, payload = { note: 'All source values stay unchanged: 0, -0, 1e-15.' }) {
  return '<!doctype html><html><head><title>Insight</title></head><body>'
    + '<script type="application/json" id="payload">' + JSON.stringify(payload) + '</script>'
    + '<script type="application/json" id="science-evidence">{"scientific_result":0.0123456789012345}</script>'
    + (name === 'tbb' ? script(fixture('tbb-shared')) : '')
    + script(fixture(name)) + '</body></html>';
}
function program(html) {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).at(-1)[1];
}
function dataScripts(html) {
  return Array.from(html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g), match => match[0]);
}
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Reviewed initializer boundaries are present.');
  return source.slice(a, b);
}
const b64 = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
function context(payload) {
  const counts = { parse: 0, decode: 0, decoded: [], convert: 0 };
  class CountedFloat32Array extends Float32Array {
    static from(...args) { counts.convert++; return Float32Array.from(...args); }
  }
  const ctx = vm.createContext({
    payload, counts, Date, Float32Array: CountedFloat32Array, Int16Array, Uint8Array, Int32Array,
    atob(value) { counts.decode++; counts.decoded.push(value); return Buffer.from(value, 'base64').toString('binary'); },
    JSON: { parse(value) { counts.parse++; return JSON.parse(value); } },
    document: { getElementById: () => ({ textContent: JSON.stringify(payload) }) },
  });
  return { ctx, counts };
}
function bytes(array) { return Buffer.from(array.buffer, array.byteOffset, array.byteLength); }
function equalArray(actual, expected) {
  assert.deepEqual(bytes(actual), bytes(expected), 'Typed-array bytes, including float rounding and signed zero, are identical.');
}

function tbbPayload() {
  const vector = offset => b64(Float32Array.from([-0, 1 / 3, -1e-12, 700.125, -13.75, offset]));
  return {
    n_nodes: 3, n_time: 4, tbb_scale: 100, lat: [1], lon: [2, 3, 4],
    tbb_i16_b64: b64(Int16Array.from([-32768, -9, 0, 32767, 300, 300, 300, 300, 299, 500, -1, 800])),
    timestamps_utc: ['2026-09-01T00:00:00Z', '2026-09-01T00:10:00Z', '2026-09-01T00:20:00Z', '2026-09-01T00:40:00Z'],
    pca: { xy_b64: vector(1) }, tsne: { 5: vector(2), 30: vector(3) }, umap: { 15: vector(4), 30: vector(5) },
  };
}
function runTbb(html, payload) {
  const h = context(payload);
  vm.runInContext('const D = JSON.parse(document.getElementById("payload").textContent);', h.ctx);
  const startup = between(program(html), '(function(){', '  const $=id=>');
  vm.runInContext(startup + 'globalThis.capture={D,N,T,TBB,EMB,nodeMean,rawMin,rawMax,STRETCH,PERPS,NNS,TSMS,STEP};})();', h.ctx);
  return { ...h, result: h.ctx.capture };
}

test('TBB parses once, decodes each embedding only on demand, and keeps exact scientific arrays/statistics', () => {
  const payload = tbbPayload(), original = page('tbb', payload);
  const optimized = optimizePageStartup(original, identity('tbb'));
  assert.deepEqual(optimized.stats.applied, ['tbb-share-payload-parse', 'tbb-defer-embedding-decode', 'tbb-local-basemap-compatible']);
  const before = runTbb(original, payload), after = runTbb(optimized.html, payload);
  assert.equal(before.counts.parse, 2);
  assert.equal(after.counts.parse, 1);
  assert.equal(before.counts.decode, 6);
  assert.equal(after.counts.decode, 1, 'Only the unchanged temperature matrix is decoded before a view is used.');
  equalArray(after.result.TBB, before.result.TBB);
  equalArray(after.result.nodeMean, before.result.nodeMean);
  for (const field of ['rawMin', 'rawMax', 'STEP']) assert.equal(after.result[field], before.result[field]);
  for (const field of ['STRETCH', 'PERPS', 'NNS', 'TSMS']) assert.equal(JSON.stringify(after.result[field]), JSON.stringify(before.result[field]));
  for (const method of ['umap', 'tsne', 'pca']) {
    assert.deepEqual(Object.keys(after.result.EMB[method]), Object.keys(before.result.EMB[method]));
    for (const key of Object.keys(before.result.EMB[method])) {
      const prior = after.counts.decode, decoded = after.result.EMB[method][key];
      equalArray(decoded, before.result.EMB[method][key]);
      assert.equal(after.counts.decode, prior + 1);
      assert.equal(after.result.EMB[method][key], decoded, 'Revisiting a view retains its original object identity.');
      assert.equal(after.counts.decode, prior + 1);
      const descriptor = Object.getOwnPropertyDescriptor(after.result.EMB[method], key);
      assert.equal(descriptor.writable, true);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.configurable, true);
    }
  }
  assert.deepEqual(dataScripts(optimized.html), dataScripts(original));
});

function singlePayload() {
  const packed = (values, scale, shape) => ({ b: b64(Int16Array.from(values)), s: scale, shape });
  return {
    cells: {
      labels: { b: b64(Uint8Array.from([0, 1, 1])) }, donor: { b: b64(Uint8Array.from([2, 0, 1])) },
      pcs: packed([-32768, 32767, 55, 0, 12, 21, -19, 8, 6], 0.03125, [3, 3]),
    },
    clustering: {
      hdbLabels: { mcs5: { b: b64(Int16Array.from([-1, 0, 2])) } },
      dbLabels: { best: { b: b64(Int16Array.from([1, 0, 1])) } },
      dbscanMetrics: [{ ari: .1 }, { ari: .9 }], hdbMetrics: [{ ari: .8 }],
    },
    embeddings: { umap: { 'nn15_md0.1': packed([1, -1, 10, 30, -12, 32767], .004) }, tsne: { perp30: packed([-7, 9, 100, 201, -32768, 6], .017) } },
  };
}
function runSingle(html, payload) {
  const h = context(payload);
  vm.runInContext(`const D=payload;
    function bytes(o){return Uint8Array.from(atob(o.b), c=>c.charCodeAt(0));}
    function floats(o){return Float32Array.from(new Int16Array(bytes(o).buffer), x=>x*o.s);}
    ` + between(program(html), '  const labels = bytes(D.cells.labels)', '  const pretty = value =>')
    + 'globalThis.capture={labels,donors,assignments,views,scores,state};', h.ctx);
  return { ...h, result: h.ctx.capture };
}

test('Single Cell defers non-default views and retains all PCA/UMAP/t-SNE values and clustering labels', () => {
  const payload = singlePayload(), original = page('single-cell', payload);
  const optimized = optimizePageStartup(original, identity('single-cell'));
  assert.deepEqual(optimized.stats.applied, ['single-cell-defer-view-decode']);
  const before = runSingle(original, payload), after = runSingle(optimized.html, payload);
  assert.equal(before.counts.decode, 7);
  assert.equal(after.counts.decode, 4, 'Labels and assignments remain eagerly available; display coordinates wait.');
  for (const field of ['labels', 'donors']) equalArray(after.result[field], before.result[field]);
  for (const field of ['hdbscan', 'dbscan']) equalArray(after.result.assignments[field], before.result.assignments[field]);
  assert.deepEqual(Object.keys(after.result.views), ['umap', 'tsne', 'pca']);
  for (const view of ['umap', 'pca', 'tsne']) {
    const prior = after.counts.decode, values = after.result.views[view];
    equalArray(values, before.result.views[view]);
    assert.equal(after.counts.decode, prior + 1);
    assert.equal(after.result.views[view], values);
    assert.equal(after.counts.decode, prior + 1);
  }
  assert.equal(JSON.stringify(after.result.scores), JSON.stringify(before.result.scores));
  assert.equal(JSON.stringify(after.result.state), JSON.stringify(before.result.state));
  assert.deepEqual(dataScripts(optimized.html), dataScripts(original));
});

function runAlzheimer(html, payload) {
  const h = context(payload);
  vm.runInContext('const D=payload;\n' + between(program(html), "  const A = D.analysis, stages =", '  const firstShared = anchor =>')
    + 'globalThis.capture={positions,stages,all};', h.ctx);
  return { ...h, result: h.ctx.capture };
}

test('Alzheimer converts only a selected stage while retaining exact Float32 coordinates and probe coverage', () => {
  const payload = { dataset: { n_probes: 3 }, analysis: { maps: {
    incipient: { xy_q: [-32768, 32767, 0, -0, 7, -1], xy_step: .017 },
    moderate: { xy_q: [4, -3, 12345, -7, 0, 3], xy_step: .0001 },
    severe: { xy_q: [10, -32767, 22222, 17, 50, 0], xy_step: .035 },
  } } };
  const original = page('alzheimer', payload), optimized = optimizePageStartup(original, identity('alzheimer'));
  assert.deepEqual(optimized.stats.applied, ['alzheimer-defer-stage-decode']);
  const before = runAlzheimer(original, payload), after = runAlzheimer(optimized.html, payload);
  assert.equal(before.counts.convert, 3);
  assert.equal(after.counts.convert, 0);
  assert.deepEqual(Array.from(after.result.all), Array.from(before.result.all));
  assert.deepEqual(Object.keys(after.result.positions), Array.from(before.result.stages));
  for (const stage of ['incipient', 'severe', 'moderate']) {
    const prior = after.counts.convert, coordinates = after.result.positions[stage];
    equalArray(coordinates, before.result.positions[stage]);
    assert.equal(after.counts.convert, prior + 1);
    assert.equal(after.result.positions[stage], coordinates);
    assert.equal(after.counts.convert, prior + 1);
  }
  assert.deepEqual(dataScripts(optimized.html), dataScripts(original));
});

test('TBB permits only existing data sources and exact same-site hash-addressed images', () => {
  const optimized = optimizePageStartup(page('tbb'), identity('tbb'));
  const code = program(optimized.html), prefix = 'if(typeof D.basemap===', a = code.indexOf(prefix), b = code.indexOf('{geoImg=new Image', a);
  assert.ok(a >= 0 && b > a);
  const expression = code.slice(a + 3, b - 1), digest = 'abcdef0123456789'.repeat(4);
  const permits = basemap => vm.runInNewContext(expression, { D: { basemap } });
  for (const suffix of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']) assert.equal(permits('/assets/embedded/' + digest + '.' + suffix), true);
  assert.equal(permits('data:image/png;base64,AA=='), true);
  for (const value of ['https://example.org/' + digest + '.png', '//example.org/a.png', '/other/a.png', '/assets/embedded/a.png', '/assets/embedded/' + digest + '.svg', '/assets/embedded/' + digest + '.png?x=1', '/assets/embedded/' + digest.toUpperCase() + '.png', '../assets/embedded/' + digest + '.png', null, 12]) {
    assert.equal(permits(value), false, String(value));
  }
});

test('unknown, changed, reordered and ambiguous programs remain byte-for-byte untouched', () => {
  const original = page('tbb');
  const cases = [
    [original, { slug: 'unknown', role: 'insight' }, 'unsupported-page'],
    [original, { ...identity('tbb'), role: 'workflow' }, 'unsupported-page'],
    [original.replace('const EMB=', 'const EMB ='), identity('tbb'), 'unrecognized-program'],
    [original.replace(script(fixture('tbb-shared')), script('const D={};')), identity('tbb'), 'unrecognized-shared-runtime'],
    [original.replace(script(fixture('tbb-shared')), script(fixture('tbb-shared')) + script('globalThis.changed=true;')), identity('tbb'), 'unrecognized-shared-runtime'],
    [original.replace(script(fixture('tbb')), script(fixture('tbb')) + script(fixture('tbb'))), identity('tbb'), 'ambiguous-program'],
    [original.replace(script(fixture('tbb')), '<script type="module">' + fixture('tbb') + '</script>'), identity('tbb'), 'unrecognized-program'],
  ];
  for (const [html, id, reason] of cases) {
    const output = optimizePageStartup(html, id);
    assert.equal(output.html, html);
    assert.deepEqual(output.stats.applied, []);
    assert.equal(output.stats.skipped[0].reason, reason);
  }
});

test('all known optimized programs are valid scripts and repeated builds are idempotent', () => {
  for (const name of ['tbb', 'single-cell', 'alzheimer']) {
    const source = page(name), once = optimizePageStartup(source, identity(name));
    assert.ok(once.stats.applied.length > 0);
    assert.equal(once.stats.inputBytes, Buffer.byteLength(source));
    assert.equal(once.stats.outputBytes, Buffer.byteLength(once.html));
    assert.doesNotThrow(() => new vm.Script(program(once.html)));
    const twice = optimizePageStartup(once.html, identity(name));
    assert.equal(twice.html, once.html);
    assert.deepEqual(twice.stats.applied, []);
    assert.equal(twice.stats.skipped[0].reason, 'already-optimized');
  }
});
