'use strict';

const { createHash } = require('node:crypto');

// Complete reviewed author programs, not fragments or scientific payloads.
// Changed upstream code stays unchanged until it is reviewed again.
const PROFILES = {
  'battery-curve-shape-explorer': {
    insight: { hash: '49d94bd53f83153f6a4836d95fe5166b31968b46bfe4726ddc71fdec5a9d5ecf', name: 'shape-insight' },
    dataset: { hash: 'c053810206dec3d45e6e20cce5c05dfa8ec2fa8651c44118106f9dc14ceee3da', name: 'shape-dataset' },
    workflow: { hash: '6fe83aa74ae1556fa36d59af131e8a7f3ef469557f7714558e04fe84c3fe278c', name: 'shape-workflow' },
  },
  'soh-battery': {
    insight: { hash: '3200aced81f82473db0b568f21e15713bebada66f72d3b10992fb62e5ce8bd18', name: 'soh-insight' },
    dataset: { hash: 'c147d01a21526ee1d4e04e9acdad5fb91499e9a3b319022fa8b0c36a52b114a8', name: 'soh-dataset' },
    workflow: { hash: '4bb1cc51663c45fa9de3cbd423757ab300cf6612356a9639eb2b0678704c255e', name: 'soh-workflow' },
  },
};
const MARKER = '/* ais-battery-startup-v1 */';
const hash = source => createHash('sha256').update(source).digest('hex');

function scriptsIn(html) {
  return Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi), match => ({
    code: match[2],
    start: match.index + match[0].indexOf('>') + 1,
    classic: !/\bsrc\s*=/i.test(match[1]) && !/\b(?:async|defer)\b/i.test(match[1])
      && (!/\btype\s*=/i.test(match[1]) || /\btype\s*=\s*["'](?:text|application)\/javascript["']/i.test(match[1])),
  }));
}

function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) !== -1) return null;
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function replacementsFor(name) {
  if (name === 'shape-dataset') return [
    [
      'const M = B.matrix, Z8 = (() => { const b = atob(M.z_i8_b64), a = new Int8Array(b.length); for (let k = 0; k < b.length; k++) a[k] = (b.charCodeAt(k) << 24) >> 24; return a; })();',
      `const M = B.matrix;
let __aisShapeBytes = null;
function __aisShapeMatrix() {
  if (__aisShapeBytes === null) {
    const b = atob(M.z_i8_b64), a = new Int8Array(b.length);
    for (let k = 0; k < b.length; k++) a[k] = (b.charCodeAt(k) << 24) >> 24;
    __aisShapeBytes = a;
  }
  return __aisShapeBytes;
}`,
      'shape-dataset-defer-matrix-decode',
    ],
    ['  if (hmImg && hmTheme === theme) return hmImg;',
      '  if (hmImg && hmTheme === theme) return hmImg;\n  const Z8 = __aisShapeMatrix();'],
    ["function paintRow() {\n  if (!isOpen('matrix')) return;",
      "function paintRow() {\n  if (!isOpen('matrix')) return;\n  const Z8 = __aisShapeMatrix();"],
  ];
  if (name === 'shape-workflow') return [[
    `const raw=atob(MX.z_b64);
const Z=new Int8Array(raw.length);
for(let q=0;q<raw.length;q++)Z[q]=(raw.charCodeAt(q)<<24)>>24;
const zAt=(i,j)=>Z[i*NC+j]/MX.z_scale;`,
    `let zAt=(i,j)=>{
  const raw=atob(MX.z_b64);
  const Z=new Int8Array(raw.length);
  for(let q=0;q<raw.length;q++)Z[q]=(raw.charCodeAt(q)<<24)>>24;
  zAt=(i,j)=>Z[i*NC+j]/MX.z_scale;
  return zAt(i,j);
};`,
    'shape-workflow-defer-matrix-decode',
  ], ['Offline single file; no network requests.', 'Shared assets are cached locally after loading. The original download is a standalone offline file.']];
  if (name === 'soh-insight') return [
    ['function setAnchor(value){', 'function setAnchor(value, paint=true){', 'soh-insight-single-initial-paint'],
    [' render();\n}\nstartSlider.max=', ' if(paint)render();\n}\nstartSlider.max='],
    ["PC.registerRepaint(render);setAnchor(D.anchor);PC.repaint('initial',document);",
      "PC.registerRepaint(render);setAnchor(D.anchor,false);PC.repaint('initial',document);"],
  ];
  if (name === 'soh-dataset') return [
    ["const select = $('cellSelect');", "const select = $('cellSelect');\nlet __aisCurveTableRows = null;", 'soh-dataset-reuse-series-table'],
    ["  $('curveTable').innerHTML = '<thead><tr><th>Cycle index</th><th>SOH (dimensionless)</th></tr></thead><tbody>' + rows.map(r => '<tr><td>' + r.cycle + '</td><td>' + r.soh + '</td></tr>').join('') + '</tbody>';",
      "  if (__aisCurveTableRows !== rows) {\n    $('curveTable').innerHTML = '<thead><tr><th>Cycle index</th><th>SOH (dimensionless)</th></tr></thead><tbody>' + rows.map(r => '<tr><td>' + r.cycle + '</td><td>' + r.soh + '</td></tr>').join('') + '</tbody>';\n    __aisCurveTableRows = rows;\n  }"],
  ];
  if (name === 'soh-workflow') return [
    ['Offline single file · stored LSTM predictions and rollouts;', 'Stored LSTM predictions and rollouts;'],
    ['function sweepPoints(){', 'let __aisSweepPoints;\nfunction sweepPoints(){\n  if (__aisSweepPoints) return __aisSweepPoints;', 'soh-workflow-reuse-sweep-statistics'],
    ['  return selectable.concat(EXT.large_window_rollout.points).sort((a,b)=>a.window-b.window);',
      '  return (__aisSweepPoints = selectable.concat(EXT.large_window_rollout.points).sort((a,b)=>a.window-b.window));'],
    ['function matrixRows(){return META.train_batteries.flatMap(name=>Array.from({length:seriesFor(name).length-BRIDGE_W},(_,start)=>({name,start,values:seriesFor(name).slice(start,start+BRIDGE_W),label:seriesFor(name)[start+BRIDGE_W]})))}',
      'let __aisMatrixRows;\nfunction matrixRows(){return __aisMatrixRows || (__aisMatrixRows = META.train_batteries.flatMap(name=>Array.from({length:seriesFor(name).length-BRIDGE_W},(_,start)=>({name,start,values:seriesFor(name).slice(start,start+BRIDGE_W),label:seriesFor(name)[start+BRIDGE_W]}))))}',
      'soh-workflow-reuse-training-matrix-rows'],
  ];
  return [];
}

/** Run before asset extraction/shared-runtime delivery changes inline scripts. */
function optimizeBatteryStartup(html, identity = {}) {
  if (typeof html !== 'string') throw new TypeError('Battery startup optimization requires HTML text.');
  const stats = { applied: [], skipped: [] };
  const result = () => ({ html, stats });
  const skip = (optimization, reason) => { stats.skipped.push({ optimization, reason }); return result(); };
  const role = identity.role === 'key_findings' ? 'insight' : identity.role;
  const profile = PROFILES[identity.slug]?.[role];
  if (!profile) return skip('battery-startup', 'unsupported-page');
  const scripts = scriptsIn(html);
  if (scripts.some(script => script.classic && script.code.includes(MARKER))) return skip(profile.name, 'already-optimized');
  const matches = scripts.filter(script => script.classic && hash(script.code) === profile.hash);
  if (matches.length !== 1) return skip(profile.name, matches.length ? 'ambiguous-program' : 'unrecognized-program');
  if (profile.name === 'shape-insight') return skip(profile.name, 'default-chart-requires-matrix');
  const target = matches[0], replacements = replacementsFor(profile.name);
  let code = target.code;
  for (const [before, after] of replacements) {
    code = replaceOnce(code, before, after);
    if (code === null) return skip(profile.name, 'unrecognized-initializer');
  }
  code = MARKER + code;
  html = html.slice(0, target.start) + code + html.slice(target.start + target.code.length);
  if (profile.name === 'soh-workflow') html = html.replace(
    'Offline single file · stored LSTM predictions and rollouts;',
    'Stored LSTM predictions and rollouts;');
  stats.applied = replacements.map(item => item[2]).filter(Boolean);
  return result();
}

module.exports = { optimizeBatteryStartup };
