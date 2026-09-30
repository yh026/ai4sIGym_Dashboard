'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { optimizeBatteryStartup } = require('../lib/battery-startup-optimization');

const SHAPE = 'battery-curve-shape-explorer', SOH = 'soh-battery';
const fixture = (slug, role) => fs.readFileSync(path.join(__dirname, 'fixtures/battery-startup-original', `${slug}-${role === 'insight' ? 'index' : role}.js.txt`), 'utf8');
const wrap = code => '<script>' + code + '</script>';
const data = '<script type="application/json" id="payload">{"science":[0,-0,0.01234567890123456789],"image":"data:image/png;base64,UNCHANGED"}</script>';
const page = (slug, role) => '<!doctype html><main><img src="original.png" width="1536"></main>' + data + wrap(fixture(slug, role));
const program = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const optimizedCode = (slug, role) => program(optimizeBatteryStartup(page(slug, role), { slug, role }).html);
function between(code, start, end) {
  const a = code.indexOf(start), b = code.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Exact reviewed program boundaries exist.');
  return code.slice(a, b);
}
function plain(value) { return structuredClone(value); }
function matrixPayload() {
  const values = Array.from({ length: 256 }, (_, i) => [-127, -126, -64, -1, 0, 1, 63, 126, 127][i % 9]);
  const encoded = Buffer.from(Int8Array.from(values).buffer).toString('base64');
  return {
    values,
    matrix: { z_i8_b64: encoded, z_b64: encoded, n_cols: 128, n_rows: 2, clip: 4.2, z_scale: 30,
      cell: [0, 1], cycle: [1, 905], q_dis: [1.10000001, .3456789], ce: [1, .9999999],
      v_mean: [3.75, 3.123456789], v_std: [.3, .0000001], dur_ch_h: [2.5, 2.6], dur_dis_h: [1, .5] },
  };
}

test('Only the five reviewed eligible battery programs change; payloads, images and other HTML stay exact', () => {
  for (const slug of [SHAPE, SOH]) for (const role of ['insight', 'dataset', 'workflow']) {
    const html = page(slug, role), result = optimizeBatteryStartup(html, { slug, role });
    new vm.Script(program(result.html));
    assert.equal(result.html.split('<script>')[0], html.split('<script>')[0]);
    if (slug === SHAPE && role === 'insight') {
      assert.equal(result.html, html);
      assert.equal(result.stats.skipped[0].reason, 'default-chart-requires-matrix');
    } else {
      assert.ok(result.stats.applied.length > 0);
      const again = optimizeBatteryStartup(result.html, { slug, role });
      assert.equal(again.html, result.html);
      assert.equal(again.stats.skipped[0].reason, 'already-optimized');
    }
    const altered = html.replace('<script>', '<script>/* upstream change */');
    assert.equal(optimizeBatteryStartup(altered, { slug, role }).html, altered);
    const duplicate = html + wrap(fixture(slug, role));
    const rejected = optimizeBatteryStartup(duplicate, { slug, role });
    assert.equal(rejected.html, duplicate);
    assert.equal(rejected.stats.skipped[0].reason, 'ambiguous-program');
  }
  for (const slug of ['air-quality', 'singapore-road-speed', 'unrelated']) {
    const html = page(SOH, 'insight');
    assert.equal(optimizeBatteryStartup(html, { slug, role: 'insight' }).html, html);
  }
  for (const attrs of [' type="application/json"', ' type="module"', ' src="other.js"', ' defer', ' async']) {
    const html = '<script' + attrs + '>' + fixture(SOH, 'insight') + '</script>';
    assert.equal(optimizeBatteryStartup(html, { slug: SOH, role: 'insight' }).html, html);
  }
  assert.equal(optimizeBatteryStartup(page(SOH, 'insight'), { slug: SOH, role: 'key_findings' }).stats.applied.length, 1);
});

function shapeDatasetRuntime(code, payload) {
  const counts = { decode: 0 }, output = { lines: [], readout: '' };
  let open = false, dark = false;
  const ctx = vm.createContext({
    B: { matrix: payload.matrix }, Int8Array, Uint8ClampedArray,
    CELLS: ['CS2_35', 'CS2_38'], cellVar: cell => cell,
    fmtN: value => String(value), isOpen: () => open,
    atob(value) { counts.decode++; return Buffer.from(value, 'base64').toString('binary'); },
    $: () => ({ set textContent(value) { output.readout = value; } }),
    PC: { isDark: () => dark, css: value => value,
      divScale: () => value => `rgb(${Math.round((value + 2) * 50)},${dark ? 19 : 220},${Math.round((2 - value) * 50)})` },
    document: { createElement() {
      const canvas = { width: 0, height: 0, image: null };
      canvas.getContext = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(image) { canvas.image = image; } });
      return canvas;
    } },
    panel: () => ({ g: {}, sc: {} }),
    line: (_g, _sc, x, y) => output.lines.push({ x: Array.from(x), y: Array.from(y) }),
  });
  vm.runInContext(between(code, 'const M = B.matrix', "$('funnelCell').addEventListener")
    + '\nglobalThis.api={paintRow,paintHeat,heatImage,setRow:r=>{hmRow=r;}};', ctx);
  return { counts, output, api: ctx.api, open: value => { open = value; }, theme: value => { dark = value; } };
}

test('Shape Dataset defers matrix decoding until use and preserves heatmap RGBA and all row values', () => {
  const payload = matrixPayload();
  const before = shapeDatasetRuntime(fixture(SHAPE, 'dataset'), payload);
  const after = shapeDatasetRuntime(optimizedCode(SHAPE, 'dataset'), payload);
  assert.equal(before.counts.decode, 1);
  assert.equal(after.counts.decode, 0);
  after.api.paintHeat(); after.api.paintRow();
  assert.equal(after.counts.decode, 0, 'Closed matrix panel does not decode.');
  for (const dark of [false, true]) {
    before.theme(dark); after.theme(dark);
    const expected = before.api.heatImage(), actual = after.api.heatImage();
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    assert.deepEqual(actual.image.data, expected.image.data, 'Every generated heatmap RGBA byte is unchanged.');
    assert.equal(after.api.heatImage(), actual, 'Existing image cache still works.');
  }
  before.open(true); after.open(true);
  for (const row of [0, 1]) {
    before.api.setRow(row); after.api.setRow(row);
    before.api.paintRow(); after.api.paintRow();
    assert.deepEqual(after.output.lines.at(-1), before.output.lines.at(-1));
    assert.equal(after.output.readout, before.output.readout);
  }
  assert.equal(after.counts.decode, 1, 'A theme change or another row does not decode again.');
});

function shapeWorkflowRuntime(code, payload, optimized) {
  const counts = { decode: 0 };
  const ctx = vm.createContext({ MX: payload.matrix, NC: 128, Int8Array,
    atob(value) { counts.decode++; return Buffer.from(value, 'base64').toString('binary'); } });
  vm.runInContext(between(code, optimized ? 'let zAt=' : 'const raw=atob', 'const cellRows=')
    + '\nglobalThis.api={z:(i,j)=>zAt(i,j),v:voltAt};', ctx);
  return { counts, api: ctx.api };
}

test('Shape Workflow decodes once on its first matrix access and retains exact z-scores and voltages', () => {
  const payload = matrixPayload();
  const before = shapeWorkflowRuntime(fixture(SHAPE, 'workflow'), payload, false);
  const after = shapeWorkflowRuntime(optimizedCode(SHAPE, 'workflow'), payload, true);
  assert.equal(before.counts.decode, 1);
  assert.equal(after.counts.decode, 0);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 128; j++) {
    assert.ok(Object.is(after.api.z(i, j), before.api.z(i, j)));
    assert.ok(Object.is(after.api.v(i, j), before.api.v(i, j)));
  }
  assert.equal(after.counts.decode, 1);
});

function forecastRuntime(code) {
  const elements = new Map(), frames = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { clientWidth: 900, style: {}, value: '', textContent: '',
      attrs: {}, tBodies: [{ innerHTML: '' }], addEventListener() {}, setAttribute(k, v) { this.attrs[k] = v; } });
    return elements.get(id);
  };
  const payload = { kind: 'forecast', anchor: 3, anchors: [3, 6], truth: [.99, .98, .97, .90, .85, .81, .7, .6, .4],
    rollouts: { 3: [.9600001, .954321, .9400008, .92, .9, .88], 6: [.79, .77, .75] } };
  let painter;
  const ctx = vm.createContext({ D: payload, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    PC: { css: value => value, font: { family: () => 'system-ui' },
      fit() {
        const commands = []; frames.push(commands);
        return new Proxy({}, { get: (_o, key) => (...args) => commands.push([key, ...args]),
          set: (_o, key, value) => { commands.push(['set', key, value]); return true; } });
      },
      registerRepaint: callback => { painter = callback; }, repaint: () => painter(),
    },
  });
  vm.runInContext(code + '\nglobalThis.api={setAnchor,render,state};', ctx);
  return { ctx, frames, elements, payload };
}

test('SOH Insight draws the same default forecast once and keeps later anchor/reveal canvas output identical', () => {
  const before = forecastRuntime(fixture(SOH, 'insight'));
  const after = forecastRuntime(optimizedCode(SOH, 'insight'));
  assert.equal(before.frames.length, 2);
  assert.equal(after.frames.length, 1);
  assert.deepEqual(plain(after.frames[0]), plain(before.frames.at(-1)));
  for (const anchor of [6, 5, 3]) for (const progress of [0, .45, 1]) {
    before.ctx.api.state.progress = progress; after.ctx.api.state.progress = progress;
    before.ctx.api.setAnchor(anchor); after.ctx.api.setAnchor(anchor);
    assert.deepEqual(plain(after.frames.at(-1)), plain(before.frames.at(-1)));
    assert.equal(after.elements.get('forecastData').tBodies[0].innerHTML, before.elements.get('forecastData').tBodies[0].innerHTML);
    for (const id of ['takeaway', 'sceneLabel', 'progressLabel', 'tableStart']) {
      assert.equal(after.elements.get(id).textContent, before.elements.get(id).textContent);
    }
  }
});

function sohDatasetRuntime(code) {
  const stats = { tableWrites: 0, plots: [] }, elements = new Map();
  let open = false, painter;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: 'CS2_35', textContent: '', addEventListener() {},
      set innerHTML(value) { this.html = value; stats.tableWrites++; } });
    return elements.get(id);
  };
  const payload = { curves: { CS2_35: [{ cycle: 1, soh: .9999999991 }, { cycle: 250, soh: .6123456789 }],
    CS2_38: [{ cycle: 1, soh: -.0 }, { cycle: 1002, soh: .2345678912 }] } };
  const ctx = vm.createContext({ D: payload, document: {}, $: element, isOpen: () => open, cellVar: value => value,
    paintFunnel() {}, paintExample() {}, exSel: element('exSelect'),
    panel: (_cv, _h, xs) => ({ g: xs, sc: {} }),
    line: (domain, _sc, x, y) => stats.plots.push({ domain: Array.from(domain), x: Array.from(x), y: Array.from(y) }),
    PC: { css: value => value, registerRepaint: callback => { painter = callback; }, repaint: () => painter() },
  });
  vm.runInContext(code.slice(code.indexOf("const select = $('cellSelect');")) + '\nglobalThis.render=renderCurve;', ctx);
  return { stats, elements, render: () => ctx.render(), open: value => { open = value; } };
}

test('SOH Dataset retains its accessible table while avoiding identical table replacement on repaint', () => {
  const before = sohDatasetRuntime(fixture(SOH, 'dataset'));
  const after = sohDatasetRuntime(optimizedCode(SOH, 'dataset'));
  assert.equal(after.stats.tableWrites, 1, 'Full table remains available even with its panel closed.');
  after.render(); after.render();
  assert.equal(after.stats.tableWrites, 1);
  for (const name of ['CS2_35', 'CS2_38', 'CS2_38', 'CS2_35']) {
    before.open(true); after.open(true);
    before.elements.get('cellSelect').value = name; after.elements.get('cellSelect').value = name;
    before.render(); after.render();
    assert.equal(after.elements.get('curveTable').html, before.elements.get('curveTable').html);
    assert.deepEqual(after.stats.plots.at(-1), before.stats.plots.at(-1));
  }
  assert.equal(after.stats.tableWrites, 3, 'Only changed battery selections replace table rows.');
});

function sohWorkflowRuntime(code, optimized) {
  const counts = { series: 0 };
  const series = { CS2_35: [1, .99000001, .97, -.0, .93, .91], CS2_36: [.95, .9, .8, .7, .6], CS2_38: [1, .95, .9, .88, .81, .7] };
  const D = { configs: {
    2: { rollout_anchors: [2, 3], rollouts: { 2: [.9, .85, .8, .75], 3: [.88, .82, .71] } },
    3: { rollout_anchors: [3, 4], rollouts: { 3: [.87, .8, .72], 4: [.79, .69] } },
  } };
  const ctx = vm.createContext({ D, META: { train_batteries: ['CS2_35', 'CS2_36'], window_sizes: [2, 3], crossing_rule: '5 consecutive cycles' },
    EXT: { large_window_rollout: { points: [{ window: 10, mean_mse: .0314159265, source: 'stored' }] } }, TEST: 'CS2_38', BRIDGE_W: 2,
    seriesFor(name) { counts.series++; return series[name]; },
    mean: values => values.reduce((a, b) => a + b, 0) / values.length,
  });
  vm.runInContext(between(code, 'function linearFit', 'function makeButton')
    + between(code, optimized ? 'let __aisMatrixRows;' : 'function matrixRows()', 'function drawMatrixWhole')
    + '\nglobalThis.api={matrixRows,sweepPoints};', ctx);
  return { counts, api: ctx.api };
}

test('SOH Workflow lazily reuses identical training rows and rollout error statistics without repeated calculation', () => {
  const before = sohWorkflowRuntime(fixture(SOH, 'workflow'), false);
  const after = sohWorkflowRuntime(optimizedCode(SOH, 'workflow'), true);
  assert.equal(after.counts.series, 0, 'No training rows or sweep statistics are calculated during declaration.');
  const expectedRows = before.api.matrixRows(), rows = after.api.matrixRows();
  assert.deepEqual(plain(rows), plain(expectedRows), 'Every input window and next-cycle label stays exact, including signed zero.');
  const afterRows = after.counts.series;
  assert.equal(after.api.matrixRows(), rows);
  assert.equal(after.counts.series, afterRows);
  const expectedSweep = before.api.sweepPoints(), sweep = after.api.sweepPoints();
  assert.deepEqual(plain(sweep), plain(expectedSweep), 'MSE arithmetic, ordering and stored large-window evidence are unchanged.');
  const afterSweep = after.counts.series;
  assert.equal(after.api.sweepPoints(), sweep);
  assert.equal(after.counts.series, afterSweep);
  assert.deepEqual(plain(after.api.matrixRows()), plain(expectedRows));
});
