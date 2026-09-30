'use strict';

const { createHash } = require('node:crypto');
const { imageOptimizationSkipReason } = require('./embedded-image-assets');

const MARKER = '/* ais-forecast-startup-v1 */';
const hash = value => createHash('sha256').update(value).digest('hex');
const PROFILES = {
  'ceemdan-battery-forecasting/insight': {
    hash: 'c153d7d011befcd6d61a2fd62dae489e30fa9e18105946567d35d6c1b4b6ce05', transform: ceemdanInsight,
    applied: ['ceemdan-cache-fixed-forecast-domain'],
  },
  'ceemdan-battery-forecasting/dataset': {
    hash: '163121e9fadbe3481eccdb17df58b9535f66f037514140d8abdc14cd2cac2fb8', transform: ceemdanDataset,
    applied: ['ceemdan-defer-capacity-table'],
  },
  'superconductor-regression-explorer/dataset': {
    hash: 'eec4131781106c6c577891a1964a37ee3d97ed264333eba8d1f8c4a19962d9ed', transform: superconductorDataset,
    applied: ['superconductor-defer-rank-matrix-decode'],
  },
  'superconductor-regression-explorer/workflow': {
    hash: '820bdc8e0208a859ed6e8ba026ba5ea7ce0b0fa8d8d17ab4bdde19533bfc2c80', transform: superconductorWorkflow,
    applied: ['superconductor-defer-pca-coordinates-and-table', 'superconductor-cache-fixed-prediction-domain'],
  },
};
const REVIEWED_UNCHANGED = {
  'ceemdan-battery-forecasting/workflow': 'f3188d3115849f7a674b07b2a63e2aaf495c1fb61b99cc02cd5a140b2756e443',
  'superconductor-regression-explorer/insight': '49707e10794af5355b24ec433914f99498b6b2265706ed02d241bc7988a75efc',
};

function replaceExactly(source, replacements) {
  for (const [before, after] of replacements) {
    const start = source.indexOf(before);
    if (start < 0 || source.indexOf(before, start + before.length) >= 0) return null;
    source = source.slice(0, start) + after + source.slice(start + before.length);
  }
  return source;
}

function ceemdanInsight(source) {
  const domain = '[Math.min(...D.curve,...Object.values(D.predictions).flat())-.04,Math.max(...D.curve,...Object.values(D.predictions).flat())+.04]';
  return replaceExactly(source, [
    [domain, '__aisForecastDomain()'],
    ['function plot(){', 'let __aisForecastDomainValue;\nfunction __aisForecastDomain(){\n  if (!__aisForecastDomainValue) __aisForecastDomainValue=' + domain + ';\n  return __aisForecastDomainValue;\n}\nfunction plot(){'],
  ]);
}

function ceemdanDataset(source) {
  const table = `$('capTable').innerHTML = '<thead><tr><th>Discharge</th>' + CELLS.map(c => '<th>' + c + ' (Ah)</th>').join('') + '</tr></thead><tbody>'
  + Array.from({ length: NROW }, (_, r) => '<tr><td>' + r + '</td>' + CELLS.map(c => '<td>' + (S.capacity[c][r] != null ? S.capacity[c][r].toFixed(4) : '') + '</td>').join('') + '</tr>').join('') + '</tbody>';`;
  return replaceExactly(source, [
    [table, 'let __aisCapacityTableReady = false;\nfunction __aisBuildCapacityTable() {\n  if (__aisCapacityTableReady) return;\n  ' + table + '\n  __aisCapacityTableReady = true;\n}'],
    ["function paintCap() {\n  if (!isOpen('matrix')) return;", "function paintCap() {\n  if (!isOpen('matrix')) return;\n  __aisBuildCapacityTable();"],
  ]);
}

function superconductorDataset(source) {
  return replaceExactly(source, [
    ['const NF = S.features.length, Q = Uint8Array.from(atob(MX.rank_u8_b64), c => c.charCodeAt(0));',
      'const NF = S.features.length;\nlet Q = null;'],
    ['  if (hmImg && hmTheme === t) return hmImg;\n  const ramp = PC.rampScale(), lut = [];',
      '  if (hmImg && hmTheme === t) return hmImg;\n  if (Q === null) Q = Uint8Array.from(atob(MX.rank_u8_b64), c => c.charCodeAt(0));\n  const ramp = PC.rampScale(), lut = [];'],
  ]);
}

function superconductorWorkflow(source) {
  return replaceExactly(source, [
    ['const PCAXY = f32(P.pca_xy_f32_b64);', 'let PCAXY = null;\nfunction __aisEnsurePcaCoordinates() {\n  if (PCAXY === null) PCAXY = f32(P.pca_xy_f32_b64);\n  return PCAXY;\n}'],
    ['function drawPca() {', 'function drawPca() {\n  __aisEnsurePcaCoordinates();'],
    ['function renderPcaTable() {', 'let __aisPcaTableReady = false;\nfunction renderPcaTable() {\n  if (__aisPcaTableReady) return;\n  __aisEnsurePcaCoordinates();'],
    ['")</th></tr></thead><tbody>" + rows.join("") + "</tbody>";\n}\n\n/* -- the unsupervised embedding panel',
      '")</th></tr></thead><tbody>" + rows.join("") + "</tbody>";\n  __aisPcaTableReady = true;\n}\n\n/* -- the unsupervised embedding panel'],
    ['  renderPcaTable();', '  if (PCFolds.isOpen(document.getElementById("analysis"))) renderPcaTable();'],
    ['  else if (i === 2) {\n    drawPca();', '  else if (i === 2) {\n    renderPcaTable();\n    drawPca();'],
    ['function predictionExtent() {', 'let __aisPredictionExtentValue = null;\nfunction predictionExtent() {\n  if (__aisPredictionExtentValue) return __aisPredictionExtentValue.slice();'],
    ['  return [Math.floor((lo - 5) / 20) * 20, Math.ceil((hi + 5) / 20) * 20];',
      '  __aisPredictionExtentValue = [Math.floor((lo - 5) / 20) * 20, Math.ceil((hi + 5) / 20) * 20];\n  return __aisPredictionExtentValue.slice();'],
  ]);
}

function scripts(html) {
  const result = [];
  const pattern = /<!--[\s\S]*?(?:-->|$)|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[1] === undefined) continue;
    const attrs = match[1];
    const classic = !/\b(?:src|integrity)\s*=/i.test(attrs) && !/\b(?:async|defer)\b/i.test(attrs)
      && (!/\btype\s*=/i.test(attrs) || /\btype\s*=\s*["'](?:text|application)\/javascript["']/i.test(attrs));
    result.push({ code: match[2], start: match.index + match[0].indexOf('>') + 1, classic });
  }
  return result;
}

/**
 * Only reviewed complete programs are changed. Payload scripts, model values,
 * image bytes, drawing formulas and visual styles are never rewritten. Changed
 * upstream programs fail closed until reviewed again. Run before shared runtime
 * delivery/externalization. Air Quality and Singapore Road have no profiles.
 */
function optimizeForecastStartup(html, { slug, role } = {}) {
  if (typeof html !== 'string') throw new TypeError('Forecast startup optimization requires HTML text.');
  const stats = { inputBytes: Buffer.byteLength(html), outputBytes: Buffer.byteLength(html), applied: [], skipped: [] };
  const skip = reason => { stats.skipped.push({ optimization: 'forecast-startup', reason }); return { html, stats }; };
  const key = slug + '/' + (role === 'key_findings' ? 'insight' : role);
  const profile = PROFILES[key];
  if (!profile && !REVIEWED_UNCHANGED[key]) return skip('unsupported-page');
  const policy = imageOptimizationSkipReason(html);
  if (policy) return skip(policy);
  const programs = scripts(html).filter(script => script.classic);
  if (programs.some(script => script.code.includes(MARKER))) return skip('already-optimized');
  const digest = profile?.hash || REVIEWED_UNCHANGED[key];
  const matches = programs.filter(script => hash(script.code) === digest);
  if (matches.length !== 1) return skip(matches.length ? 'ambiguous-program' : 'unrecognized-program');
  if (!profile) return skip('reviewed-no-startup-change-needed');
  const target = matches[0], changed = profile.transform(target.code);
  if (changed === null) return skip('unrecognized-initializer');
  html = html.slice(0, target.start) + MARKER + changed + html.slice(target.start + target.code.length);
  stats.applied = [...profile.applied];
  stats.outputBytes = Buffer.byteLength(html);
  return { html, stats };
}

module.exports = { optimizeForecastStartup };
