'use strict';

const { createHash } = require('node:crypto');

// These hashes describe complete, reviewed inline programs, never their data.
// If a producer changes its program, preserve it unchanged until re-reviewed.
const PROFILES = {
  'tbb-cluster-explorer-2': {
    name: 'tbb',
    hash: 'ead45819f55c4990ce14cdff6716ace0dac3ee4df2ee215219f6ddf2ed661aaa',
  },
  'from-twenty-thousand-genes-to-fourteen-cell-types': {
    name: 'single-cell',
    hash: '0baafc117d84048a61679dfdce761e8fe00142c60f4ab61150621e965c1bd95e',
  },
  'alzheimer-s-gene-co-expression-explorer': {
    name: 'alzheimer',
    hash: '56a6fc8a68073673ab44c806cc4bd096743c525331e7bdfc680096cc5be4b6b3',
  },
};
const TBB_SHARED_HASH = '8f546e5c891889fc74f34b2c2cc733a04d5da8a14aed8263cad2c1b931a59773';
const MARKER = '/* ais-page-startup-v1 */';
const hash = source => createHash('sha256').update(source).digest('hex');

// Existing programs read these properties; they do not inspect descriptors or
// change the source values. First access runs the original converter verbatim,
// then installs the same ordinary, mutable property Object.fromEntries creates.
const LAZY_VALUES = `function __aisLazyValues(sources, decode) {
    const result = {};
    for (const key of Object.keys(sources)) {
      Object.defineProperty(result, key, {
        enumerable: true, configurable: true,
        get() {
          const value = decode(sources[key], key);
          Object.defineProperty(result, key, {
            value, enumerable: true, configurable: true, writable: true
          });
          return value;
        }
      });
    }
    return result;
  }`;

const TBB_BINDING = 'const D=JSON.parse(document.getElementById("payload").textContent),N=D.n_nodes,T=D.n_time,SCALE=D.tbb_scale,LAT=D.lat,LON=D.lon,NLAT=LAT.length,NLON=LON.length;';
const TBB_EMBEDDINGS = 'const EMB={pca:{"0":f32(D.pca.xy_b64)},tsne:Object.fromEntries(Object.entries(D.tsne).map(([k,v])=>[k,f32(v)])),umap:Object.fromEntries(Object.entries(D.umap).map(([k,v])=>[k,f32(v)]))};';
const TBB_BASEMAP_CHECK = 'typeof D.basemap==="string"&&D.basemap.startsWith("data:")';
const TBB_LOCAL_BASEMAP_CHECK = 'typeof D.basemap==="string"&&(D.basemap.startsWith("data:")||/^\\/assets\\/embedded\\/[a-f0-9]{64}\\.(?:png|jpg|jpeg|webp|gif|avif)$/.test(D.basemap))';
const SINGLE_VIEWS = `const pc = floats(D.cells.pcs), pcWidth = D.cells.pcs.shape[1];
  const views = { umap: floats(D.embeddings.umap['nn15_md0.1']), tsne: floats(D.embeddings.tsne.perp30), pca: Float32Array.from({ length: labels.length * 2 }, (_, i) => pc[Math.floor(i / 2) * pcWidth + i % 2]) };`;
const AD_POSITIONS = 'const positions = Object.fromEntries(stages.map(stage => [stage, Float32Array.from(A.maps[stage].xy_q, n => n * A.maps[stage].xy_step)]));';

function replaceOnce(source, before, after) {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) !== -1) return null;
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function inlineScripts(html) {
  return Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi), match => {
    const openingLength = match[0].indexOf('>') + 1;
    const attributes = match[1];
    // Only ordinary classic inline scripts are eligible. JSON remains byte-for-byte intact.
    const classic = !/\bsrc\s*=/i.test(attributes)
      && !/\b(?:async|defer)\b/i.test(attributes)
      && (!/\btype\s*=/i.test(attributes) || /\btype\s*=\s*["'](?:text|application)\/javascript["']/i.test(attributes));
    return { code: match[2], start: match.index + openingLength, classic };
  });
}

/**
 * Optimize known Insight programs without changing scientific data or formulas.
 * Run BEFORE asset extraction, which may change an inline program's checksum.
 * @param {string} html Complete source page.
 * @param {{slug:string, role:string, projectId?:string}} identity
 * @returns {{html:string,stats:{inputBytes:number,outputBytes:number,applied:string[],skipped:Array<{optimization:string,reason:string}>}}}
 */
function optimizePageStartup(html, identity = {}) {
  if (typeof html !== 'string') throw new TypeError('Page startup optimization requires HTML text.');
  const stats = { inputBytes: Buffer.byteLength(html), outputBytes: Buffer.byteLength(html), applied: [], skipped: [] };
  const result = () => ({ html, stats });
  const skip = (optimization, reason) => { stats.skipped.push({ optimization, reason }); return result(); };
  const profile = PROFILES[identity.slug];
  if (!profile || !['insight', 'key_findings'].includes(identity.role)) return skip('page-startup', 'unsupported-page');
  const scripts = inlineScripts(html);
  if (scripts.some(script => script.classic && script.code.includes(MARKER))) return skip(profile.name, 'already-optimized');
  const matches = scripts.filter(script => script.classic && hash(script.code) === profile.hash);
  if (matches.length !== 1) return skip(profile.name, matches.length ? 'ambiguous-program' : 'unrecognized-program');
  const target = matches[0];
  let code = target.code;
  const replacements = [];
  if (profile.name === 'tbb') {
    // D is a lexical, page-global const in the immediately preceding reviewed
    // classic script. That program only declares D; it never mutates its data.
    const index = scripts.indexOf(target), shared = scripts[index - 1];
    if (!shared?.classic || hash(shared.code) !== TBB_SHARED_HASH) return skip(profile.name, 'unrecognized-shared-runtime');
    replacements.push([
      TBB_BINDING,
      'const N=D.n_nodes,T=D.n_time,SCALE=D.tbb_scale,LAT=D.lat,LON=D.lon,NLAT=LAT.length,NLON=LON.length;',
      'tbb-share-payload-parse',
    ], [
      TBB_EMBEDDINGS,
      LAZY_VALUES + '\n  const EMB={pca:__aisLazyValues({"0":D.pca.xy_b64},f32),tsne:__aisLazyValues(D.tsne,f32),umap:__aisLazyValues(D.umap,f32)};',
      'tbb-defer-embedding-decode',
    ], [
      TBB_BASEMAP_CHECK,
      TBB_LOCAL_BASEMAP_CHECK,
      'tbb-local-basemap-compatible',
    ]);
  } else if (profile.name === 'single-cell') {
    replacements.push([
      SINGLE_VIEWS,
      LAZY_VALUES + `
  const views = __aisLazyValues({
    umap: () => floats(D.embeddings.umap['nn15_md0.1']),
    tsne: () => floats(D.embeddings.tsne.perp30),
    pca: () => {
      const pc = floats(D.cells.pcs), pcWidth = D.cells.pcs.shape[1];
      return Float32Array.from({ length: labels.length * 2 }, (_, i) => pc[Math.floor(i / 2) * pcWidth + i % 2]);
    }
  }, read => read());`,
      'single-cell-defer-view-decode',
    ]);
  } else {
    replacements.push([
      AD_POSITIONS,
      LAZY_VALUES + '\n  const positions = __aisLazyValues(Object.fromEntries(stages.map(stage => [stage, stage])), stage => Float32Array.from(A.maps[stage].xy_q, n => n * A.maps[stage].xy_step));',
      'alzheimer-defer-stage-decode',
    ]);
  }
  for (const [before, after] of replacements) {
    const replaced = replaceOnce(code, before, after);
    if (replaced === null) return skip(profile.name, 'unrecognized-initializer');
    code = replaced;
  }
  code = MARKER + code;
  html = html.slice(0, target.start) + code + html.slice(target.start + target.code.length);
  stats.applied = replacements.map(([, , name]) => name);
  stats.outputBytes = Buffer.byteLength(html);
  return result();
}

module.exports = { optimizePageStartup };
