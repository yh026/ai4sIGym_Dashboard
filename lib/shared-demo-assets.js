'use strict';

const { createHash } = require('node:crypto');
const { markupSegments, imageOptimizationSkipReason } = require('./embedded-image-assets');

const PROJECTS = new Set([
  'battery-curve-shape-explorer', 'ceemdan-battery-forecasting', 'soh-battery',
  'jae-joint-embedding-how-one-cell-becomes-61-numbers',
  'pleiades-membership-explorer', 'superconductor-regression-explorer',
]);
// Complete, reviewed resource bodies only. Unknown revisions remain inline.
// These classic programs do not use currentScript or script-relative URLs;
// these styles contain no relative URLs or imports.
const REVIEWED = {
  script: new Set([
    '8aa04ef572442fe8fbdd5489e2c4d39087e87f47ee0c5b219f05beb4cb2ae2cc',
    'f0631e74d84e9887c4d8c3627c5b18597e795608c37e6afda6d7c90837ce6a95',
    'c4499890c2c5a73943b6c24884d1540c09b4a67ea5e9553a6578932cacce2200',
    '8f546e5c891889fc74f34b2c2cc733a04d5da8a14aed8263cad2c1b931a59773',
    'b59a5e70083fab63d3d97c580539ca144547f8e45bcc3447e3dcba8f62b147ad',
  ]),
  style: new Set([
    '9e722dd7e402fc0eaaea700d86f2f26bd5cb1f2683de849be1eda2967ac2dd6a',
    '74a28279cc8c43884190ce0175d64c40a570bb426f58994b963bfdbd50ce3b5e',
  ]),
};

function optimizeSharedDemoAssets(html, { slug, role } = {}) {
  const assets = new Map();
  const stats = { applied: [], skipped: [], externalizedBytes: 0 };
  const skip = reason => ({ html, assets: [], stats: { ...stats, skipped: [reason] } });
  if (!PROJECTS.has(slug) || !['insight', 'dataset', 'workflow'].includes(role)) return skip('unsupported-page');
  const policy = imageOptimizationSkipReason(html);
  if (policy) return skip(policy);
  const segments = markupSegments(html);
  const heads = segments.filter(s => s.tagName === 'head');
  if (heads.length !== 1 || !segments.some(s => /^<\/head\s*>$/i.test(s.tag || ''))) return skip('unrecognized-head');
  const preloads = new Set();
  let inertDepth = 0;
  const rewritten = segments.map(s => {
    if (s.text !== undefined) return s.text;
    if (['template', 'svg', 'math'].includes(s.tagName)) inertDepth++;
    const eligible = !inertDepth && REVIEWED[s.tagName] && s.closing
      && new RegExp('^<' + s.tagName + '\\s*>$', 'i').test(s.tag);
    if (/^<\/(?:template|svg|math)\s*>$/i.test(s.tag)) inertDepth = Math.max(0, inertDepth - 1);
    if (eligible) {
      const bytes = Buffer.from(s.body, 'utf8');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (REVIEWED[s.tagName].has(digest)) {
        const filename = digest + (s.tagName === 'script' ? '.js' : '.css');
        const url = '/assets/runtime/' + filename;
        assets.set(filename, { filename, bytes });
        stats.applied.push({ kind: s.tagName, sha256: digest, bytes: bytes.length });
        stats.externalizedBytes += bytes.length;
        if (s.tagName === 'style') return '<link rel="stylesheet" href="' + url + '">';
        preloads.add(url);
        // Remain parser-blocking, at the original position, before dependants.
        return '<script src="' + url + '"></script>';
      }
    }
    return s.tag + (s.body === undefined ? '' : s.body + s.closing);
  });
  if (preloads.size) {
    const headIndex = segments.indexOf(heads[0]);
    rewritten[headIndex] += '\n' + [...preloads].map(url => '<link rel="preload" as="script" href="' + url + '">').join('\n');
  }
  return { html: rewritten.join(''), assets: [...assets.values()], stats };
}

module.exports = { optimizeSharedDemoAssets };
