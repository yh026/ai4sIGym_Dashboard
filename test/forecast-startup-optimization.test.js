'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { optimizeForecastStartup } = require('../lib/forecast-startup-optimization');

const identity = name => ({
  slug: name.startsWith('ceemdan-') ? 'ceemdan-battery-forecasting' : 'superconductor-regression-explorer',
  role: name.split('-').at(-1),
});
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/forecast-startup', name + '.js.txt'), 'utf8');
const script = code => '<script>' + code + '</script>';
const optimize = name => optimizeForecastStartup(script(fixture(name)), identity(name)).html.slice(8, -9);
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Reviewed program boundaries exist.');
  return source.slice(a, b);
}
const bytes = value => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const b64 = value => bytes(value).toString('base64');

test('CEEMDAN keeps the exact full-forecast domain and computes it only on first draw', () => {
  const D = { curve: [2.01123, 1.96214, 1.92351, -0], predictions: { truth: [1.9111, 1.9001], raw: [1.82, 1.71], linear: [-0.2, -0.1] } };
  const snapshot = JSON.stringify(D);
  const original = '[Math.min(...D.curve,...Object.values(D.predictions).flat())-.04,Math.max(...D.curve,...Object.values(D.predictions).flat())+.04]';
  const expected = vm.runInNewContext(original, { D });
  let scans = 0;
  const ctx = vm.createContext({ D, Math: { min(...args) { scans++; return Math.min(...args); }, max(...args) { scans++; return Math.max(...args); } } });
  const source = optimize('ceemdan-insight');
  vm.runInContext(between(source, 'let __aisForecastDomainValue;', 'function plot(){'), ctx);
  assert.equal(scans, 0);
  assert.deepEqual(Array.from(vm.runInContext('__aisForecastDomain()', ctx)), Array.from(expected));
  assert.equal(scans, 2);
  for (let frame = 0; frame < 12; frame++) assert.deepEqual(Array.from(vm.runInContext('__aisForecastDomain()', ctx)), Array.from(expected));
  assert.equal(scans, 2, 'Replay frames and model changes reuse the fixed domain.');
  assert.equal(JSON.stringify(D), snapshot);
});

function capacityContext() {
  const S = { capacity: { A: [2.01551, 1.91115, 0], B: [1.99999, null, -0, 1.12345] } };
  let writes = 0, html = 'not built', open = false;
  const table = { set innerHTML(value) { writes++; html = value; }, get innerHTML() { return html; } };
  const stop = new Error('stop after opening the chart');
  return {
    ctx: vm.createContext({ S, CELLS: ['A', 'B'], $: () => table, isOpen: () => open, panel: () => { throw stop; } }),
    get html() { return html; }, get writes() { return writes; }, open() { open = true; }, stop,
  };
}

test('CEEMDAN capacity table stays unbuilt while folded and retains exact values on first open', () => {
  const original = fixture('ceemdan-dataset'), changed = optimize('ceemdan-dataset');
  const before = capacityContext(), after = capacityContext();
  vm.runInContext(between(original, 'const NROW =', 'let capHit ='), before.ctx);
  vm.runInContext(between(changed, 'const NROW =', 'let capHit ='), after.ctx);
  vm.runInContext(between(changed, 'function paintCap() {', "disSel.addEventListener('change'"), after.ctx);
  assert.equal(after.writes, 0);
  vm.runInContext('paintCap()', after.ctx);
  assert.equal(after.writes, 0);
  after.open();
  assert.throws(() => vm.runInContext('paintCap()', after.ctx), error => error === after.stop);
  assert.equal(after.html, before.html);
  assert.equal(after.writes, 1);
  assert.throws(() => vm.runInContext('paintCap()', after.ctx), error => error === after.stop);
  assert.equal(after.writes, 1, 'Reopening/repainting the chart does not rebuild its static table.');
});

function rankContext() {
  const rank = Uint8Array.from([0, 1, 50, 127, 253, 254]);
  let decodes = 0, dark = false;
  const ctx = vm.createContext({
    S: { features: ['a', 'b'], n_rows: 3 }, MX: { rank_u8_b64: b64(rank) },
    atob(value) { decodes++; return Buffer.from(value, 'base64').toString('binary'); },
    isOpen: () => false,
    PC: { isDark: () => dark, rampScale: () => value => 'rgb(' + Math.round(value * 254) + ',' + (dark ? 13 : 27) + ',99)' },
    document: { createElement: () => {
      const canvas = {};
      canvas.getContext = () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(image) { canvas.pixels = image.data; },
      });
      return canvas;
    } },
  });
  return { ctx, rank, get decodes() { return decodes; }, setDark() { dark = true; } };
}

test('Superconductor rank decoding waits for the heatmap and keeps all pixels and percentile bytes', () => {
  const original = fixture('superconductor-dataset'), changed = optimize('superconductor-dataset');
  const before = rankContext(), after = rankContext();
  vm.runInContext(between(original, 'const NF =', "mSel.addEventListener('change'"), before.ctx);
  vm.runInContext(between(changed, 'const NF =', "mSel.addEventListener('change'"), after.ctx);
  assert.equal(before.decodes, 1);
  assert.equal(after.decodes, 0);
  vm.runInContext('paintHeat()', after.ctx);
  assert.equal(after.decodes, 0, 'A folded matrix does not decode its rank payload.');
  const a = vm.runInContext('heatImage()', before.ctx), b = vm.runInContext('heatImage()', after.ctx);
  assert.deepEqual(bytes(b.pixels), bytes(a.pixels));
  assert.deepEqual(bytes(vm.runInContext('Q', after.ctx)), Buffer.from(after.rank));
  assert.equal(after.decodes, 1);
  assert.strictEqual(vm.runInContext('heatImage()', after.ctx), b);
  before.setDark(); after.setDark();
  assert.deepEqual(bytes(vm.runInContext('heatImage().pixels', after.ctx)), bytes(vm.runInContext('heatImage().pixels', before.ctx)));
  assert.equal(after.decodes, 1, 'Theme changes recolor the same rank bytes without decoding again.');
});

function workflowContext() {
  const P = {
    test_n: 3, train_n: 4,
    target_f32_b64: b64(Float32Array.from([-0, 0.012345, 112.125])),
    pca_xy_f32_b64: b64(Float32Array.from([-0, 1 / 3, -1e-12, 70.123, 0.55555, -5.1])),
    indices_i32_b64: b64(Int32Array.from([91, 201, 632])),
    features_f32_b64: b64(Float32Array.from([-0, 1 / 3, 12.812345])),
    feature_percentiles_u8_b64: b64(Uint8Array.from([0, 33, 99])),
    predictions: {}, error_bins: { labels: ['< 10 K', '≥ 10 K'] },
  };
  for (const model of ['linear', 'linear_original', 'polynomial', 'forest', 'forest_original']) P.predictions[model] = b64(Float32Array.from([-5.1, 1 / 3, 70.0123]));
  let writes = 0, html = '', open = false;
  const decodes = [], table = { set innerHTML(value) { writes++; html = value; } };
  const D = { metadata: { pca_components: 2 }, provenance: { raw_rows: 7, feature_columns: 1 }, protocols: { random: P }, feature_defs: [{ label: 'a' }] };
  const ctx = vm.createContext({
    D, atob(value) { decodes.push(value); return Buffer.from(value, 'base64').toString('binary'); },
    document: { getElementById: id => id === 'pcaTable' ? table : id === 'evalRepSel' ? null : { id } },
    PCFolds: { isOpen: () => open },
    ns: value => Number(value).toLocaleString('en-US'), f: (value, digits) => Number(value).toFixed(digits),
    pc: (value, digits) => (value * 100).toFixed(digits) + ' %', esc: value => String(value), K: () => 'K',
    renderBranches() {}, renderVariance() {}, renderPredictionPanels() {}, renderErrorTable() {},
    renderMetrics() {}, renderSelected() {}, buildConclusions() {}, redrawVisible() {},
  });
  return { ctx, P, decodes, get html() { return html; }, get writes() { return writes; }, open() { open = true; } };
}

test('Superconductor workflow defers PCA decoding/table while preserving numerical rows exactly', () => {
  const original = fixture('superconductor-workflow'), changed = optimize('superconductor-workflow');
  const before = workflowContext(), after = workflowContext();
  for (const [source, item, tableStart] of [[original, before, 'function renderPcaTable()'], [changed, after, 'let __aisPcaTableReady =']]) {
    vm.runInContext(source.slice(0, source.indexOf('/* ── colour, decided once')), item.ctx);
    vm.runInContext(between(source, 'const BANDS =', '/* ═══════════════════ formatting'), item.ctx);
    vm.runInContext(between(source, tableStart, '/* -- the unsupervised embedding panel'), item.ctx);
  }
  assert.ok(before.decodes.includes(before.P.pca_xy_f32_b64));
  assert.ok(!after.decodes.includes(after.P.pca_xy_f32_b64));
  for (const variable of ['TARGET', 'ROWID', 'FVAL', 'FPCT']) assert.deepEqual(bytes(vm.runInContext(variable, after.ctx)), bytes(vm.runInContext(variable, before.ctx)));
  vm.runInContext(between(changed, 'function renderAll() {', 'function wireControls() {'), after.ctx);
  vm.runInContext('renderAll()', after.ctx);
  assert.equal(after.writes, 0);
  assert.ok(!after.decodes.includes(after.P.pca_xy_f32_b64));
  vm.runInContext('renderPcaTable()', before.ctx);
  after.open(); vm.runInContext('renderAll()', after.ctx);
  assert.equal(after.html, before.html);
  assert.deepEqual(bytes(vm.runInContext('PCAXY', after.ctx)), bytes(vm.runInContext('PCAXY', before.ctx)));
  vm.runInContext('renderAll(); renderPcaTable();', after.ctx);
  assert.equal(after.writes, 1);
  assert.equal(after.decodes.filter(value => value === after.P.pca_xy_f32_b64).length, 1);
  assert.match(changed, /else if \(i === 2\) \{\s*renderPcaTable\(\);\s*drawPca\(\);/);
  assert.match(changed, /function drawPca\(\) \{\s*__aisEnsurePcaCoordinates\(\);/);
});

test('Superconductor caches the same all-model axes and returned ranges cannot corrupt the cache', () => {
  const original = fixture('superconductor-workflow'), changed = optimize('superconductor-workflow');
  const make = () => {
    let reads = 0;
    const data = [-12.45678, -0, 20.0001, 198.987];
    const pred = new Proxy(data, { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key); } });
    return { ctx: vm.createContext({ TARGET: [-0, 90.111, 180.333], MODELS: ['a', 'b'], PRED: { a: pred, b: [0.222, 111.222, 234.444] } }), get reads() { return reads; } };
  };
  const before = make(), after = make();
  vm.runInContext(between(original, 'function predictionExtent()', 'function renderPredictionPanels()'), before.ctx);
  vm.runInContext(between(changed, 'let __aisPredictionExtentValue =', 'function renderPredictionPanels()'), after.ctx);
  assert.equal(after.reads, 0);
  const expected = Array.from(vm.runInContext('predictionExtent()', before.ctx));
  assert.deepEqual(Array.from(vm.runInContext('predictionExtent()', after.ctx)), expected);
  const firstReads = after.reads;
  vm.runInContext('predictionExtent()[0] = -99999', after.ctx);
  assert.deepEqual(Array.from(vm.runInContext('predictionExtent()', after.ctx)), expected);
  assert.equal(after.reads, firstReads, 'Repeated redraws do not rescan immutable prediction arrays.');
});

test('all reviewed transforms preserve payload bytes, compile, and are idempotent', () => {
  const payload = '<script type="application/json" id="payload">{"scientific_value":1.234567890123456789,"large_integer":9007199254740993}</script>';
  for (const name of ['ceemdan-insight', 'ceemdan-dataset', 'superconductor-dataset', 'superconductor-workflow']) {
    const html = '<!doctype html><html><body>' + payload + script(fixture(name)) + '</body></html>';
    const result = optimizeForecastStartup(html, identity(name));
    assert.ok(result.stats.applied.length);
    assert.ok(result.html.includes(payload));
    new vm.Script(optimize(name));
    assert.equal(optimizeForecastStartup(result.html, identity(name)).html, result.html);
    assert.equal(optimizeForecastStartup(html, { ...identity(name), slug: 'air-quality-day-segment-pca-and-amp-umap-by-sensor' }).html, html);
    assert.equal(optimizeForecastStartup(html, { ...identity(name), slug: 'singapore-road-speed-clusters-umap' }).html, html);
  }
});

test('changed, duplicate, non-classic and policy-protected programs fail closed', () => {
  const code = fixture('ceemdan-insight'), id = identity('ceemdan-insight');
  for (const html of [
    script(code + '\n// upstream change'), script(code) + script(code),
    '<script type="module">' + code + '</script>', '<script src="external.js">' + code + '</script>',
    '<script integrity="sha256-placeholder">' + code + '</script>',
    '<meta http-equiv="Content-Security-Policy" content="script-src \'sha256-placeholder\'">' + script(code),
    '<base href="https://other.example/">' + script(code), '<!-- ' + script(code) + ' -->',
  ]) {
    const result = optimizeForecastStartup(html, id);
    assert.equal(result.html, html);
    assert.deepEqual(result.stats.applied, []);
  }
});
