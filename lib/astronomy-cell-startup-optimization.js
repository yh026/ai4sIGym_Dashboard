'use strict';
const { createHash } = require('node:crypto');
const hash = source => createHash('sha256').update(source).digest('hex');
const MARKER = '/* ais-astronomy-cell-startup-v1 */';
const HASHES = {
  'jae:insight': '390f500a3d7ed8a7108a5f1b0dc93387a1251b40a4534969c0862750d3b61896',
  'jae:dataset': 'bd5cf494e35c138e531a08e1cb67de5d0354ccce75474d651f5005028e1e5c48',
  'jae:workflow': '3037182507fbf3f4649e1121fbc768bdb4d00d4f3f2187846490f56b658c0c93',
  'pleiades:insight': '0c4585109d42e81520e1622990017af9d0abf02eaf3dccb7772b0cd5a268b5e6',
  'pleiades:dataset': 'c2a51b5e9386683a895eb4b2f4b5cc8715384c5dc9e36526c1c8578d6105e342',
  'pleiades:workflow': 'e8e8bb367279562fb057a3d2b649d9e778bcab8c0fc03238c7d95c389cf3a871',
};
const LAZY = `function __aisLazyValues(readers) {
  const result = {};
  for (const key of Object.keys(readers)) Object.defineProperty(result, key, {
    enumerable: true, configurable: true, get() {
      const value = readers[key]();
      Object.defineProperty(result, key, {value, enumerable:true, configurable:true, writable:true});
      return value;
    }
  });
  return result;
}`;
const NEIGHBOURS = `function neighbours(cell){
 const d=new Float64Array(N);
 for(let i=0;i<N;i++){let s=0;for(let k=0;k<DIM;k++){const t=raw[i*DIM+k]-raw[cell*DIM+k];s+=t*t}d[i]=i===cell?Infinity:s}
 const idx=Array.from({length:N},(_,i)=>i);
 idx.sort((a,b)=>d[a]-d[b]);
 return idx.slice(0,K);
}`;
const MATRIX_CODES = 'const CODES = (() => { const b = atob(DX.codes_b64), a = new Uint8Array(b.length); for (let k = 0; k < b.length; k++) a[k] = b.charCodeAt(k); return a; })();';
const EXPLORER_UNB64 = `function unb64(s, Type){
  const bin = atob(s); const buf = new ArrayBuffer(bin.length);
  const v = new Uint8Array(buf);
  for(let i=0;i<bin.length;i++) v[i] = bin.charCodeAt(i);
  return new Type(buf);
}`;
const EXPLORER_DEQ = `function deq(codes, lo, hi, max){ // integer codes -> floats
  const out = new Float32Array(codes.length); const s=(hi-lo)/max;
  for(let i=0;i<codes.length;i++) out[i]=lo+codes[i]*s;
  return out;
}`;
const LAB_UNB64 = `function unb64(s,T){const b=atob(s);const buf=new ArrayBuffer(b.length);const v=new Uint8Array(buf);
  for(let i=0;i<b.length;i++)v[i]=b.charCodeAt(i);return new T(buf);}`;
const LAB_DEQ = `function deq(c,lo,hi,mx){const o=new Float32Array(c.length);const s=(hi-lo)/mx;
  for(let i=0;i<c.length;i++)o[i]=lo+c[i]*s;return o;}`;
const SHARED_DECODERS = `const __aisTypedCache = new Map(), __aisDequantizedCache = new WeakMap();
function __aisSharedUnb64(s, Type) {
  let cache = __aisTypedCache.get(Type);
  if (!cache) __aisTypedCache.set(Type, cache = new Map());
  if (cache.has(s)) return cache.get(s);
  const bin = atob(s), buf = new ArrayBuffer(bin.length), v = new Uint8Array(buf);
  for (let i=0;i<bin.length;i++) v[i]=bin.charCodeAt(i);
  const out = new Type(buf); cache.set(s, out); return out;
}
function __aisSharedDeq(codes, lo, hi, max) {
  let entries = __aisDequantizedCache.get(codes);
  if (!entries) __aisDequantizedCache.set(codes, entries = []);
  const hit = entries.find(row => Object.is(row.lo,lo) && Object.is(row.hi,hi) && Object.is(row.max,max));
  if (hit) return hit.out;
  const out = new Float32Array(codes.length), s=(hi-lo)/max;
  for (let i=0;i<codes.length;i++) out[i]=lo+codes[i]*s;
  entries.push({lo,hi,max,out}); return out;
}
`;
const WORKFLOW_ARRAYS = `const A={
  source:typed(BigUint64Array,D.arrays.source_id_u64_b64),
  ra:typed(Float64Array,D.arrays.ra_f64_b64),
  dec:typed(Float64Array,D.arrays.dec_f64_b64),
  parallax:typed(Float64Array,D.arrays.parallax_f64_b64),
  poe:typed(Float64Array,D.arrays.parallax_over_error_f64_b64),
  pmra:typed(Float64Array,D.arrays.pmra_f64_b64),
  pmdec:typed(Float64Array,D.arrays.pmdec_f64_b64),
  g:typed(Float64Array,D.arrays.g_mag_f64_b64),
  colour:typed(Float64Array,D.arrays.bp_rp_f64_b64),
  eg:typed(Float64Array,D.arrays.e_g_mag_f64_b64),
  pca:typed(Float32Array,D.arrays.pca_xy_f32_b64),
  notebookPca:typed(Float32Array,D.arrays.notebook_pca_xy_f32_b64),
  notebookLabels:typed(Int16Array,D.arrays.notebook_gmm_labels_i16_b64),
  percentile:typed(Uint8Array,D.arrays.feature_percentiles_u8_b64)
};`;
const HISTOGRAM = `    const cv = $('hist' + j), lo = -4, hi = 4, nb = 64, bins = new Array(nb).fill(0);
    let under = 0, over = 0;
    col.forEach(v => { if (v < lo) under++; else if (v >= hi) over++; else bins[Math.floor((v - lo) / (hi - lo) * nb)]++; });`;
const HISTOGRAM_CACHE = `const __aisHistogramCache = new WeakMap();
function __aisHistogram(col) {
  if (__aisHistogramCache.has(col)) return __aisHistogramCache.get(col);
  const lo = -4, hi = 4, nb = 64, bins = new Array(nb).fill(0);
  let under = 0, over = 0;
  col.forEach(v => { if (v < lo) under++; else if (v >= hi) over++; else bins[Math.floor((v - lo) / (hi - lo) * nb)]++; });
  const result = {bins,under,over}; __aisHistogramCache.set(col,result); return result;
}
`;
function once(source, from, to) {
  const start=source.indexOf(from);
  if(start<0 || source.indexOf(from,start+from.length)>=0) throw new Error('Unrecognized initializer');
  return source.slice(0,start)+to+source.slice(start+from.length);
}
function transform(code, key) {
  if (key==='jae:insight') return {
    code:once(code,NEIGHBOURS,`const __aisNeighbourCache = new Map();
function neighbours(cell){
 if(__aisNeighbourCache.has(cell)) return __aisNeighbourCache.get(cell).slice();
 const d=new Float64Array(N);
 for(let i=0;i<N;i++){let s=0;for(let k=0;k<DIM;k++){const t=raw[i*DIM+k]-raw[cell*DIM+k];s+=t*t}d[i]=i===cell?Infinity:s}
 const idx=Array.from({length:N},(_,i)=>i);
 idx.sort((a,b)=>d[a]-d[b]);
 const result=idx.slice(0,K);
 if(__aisNeighbourCache.size>=32) __aisNeighbourCache.delete(__aisNeighbourCache.keys().next().value);
 __aisNeighbourCache.set(cell,result);
 return result.slice();
}`), applied:['jae-cache-exact-neighbours'] };
  if (key==='jae:dataset') {
    const initializer=MATRIX_CODES.slice('const CODES = '.length,-1);
    code=once(code,MATRIX_CODES,LAZY+'\nconst __aisMatrix = __aisLazyValues({codes: () => '+initializer+'});');
    // All remaining CODES references are reads in the reviewed render functions.
    code=code.replace(/\bCODES\b/g,'__aisMatrix.codes');
    return {code,applied:['jae-defer-dataset-matrix-decode']};
  }
  if (key==='jae:workflow') {
    code=once(code,EXPLORER_UNB64,'function unb64(s, Type){return __aisSharedUnb64(s,Type);}');
    code=once(code,LAB_UNB64,'function unb64(s,T){return __aisSharedUnb64(s,T);}');
    code=once(code,EXPLORER_DEQ,'function deq(codes, lo, hi, max){return __aisSharedDeq(codes,lo,hi,max);}');
    code=once(code,LAB_DEQ,'function deq(c,lo,hi,mx){return __aisSharedDeq(c,lo,hi,mx);}');
    // Both reviewed views only read decoded arrays; scalar formulas are identical.
    return {code:SHARED_DECODERS+code,applied:['jae-reuse-workflow-array-decode','jae-reuse-workflow-dequantization']};
  }
  if (key==='pleiades:insight') {
    code=once(code,'const ID=asU64(D.source_id_u64_b64),LAB={},BRIGHT=D.bright_index;\nfor(const k of D.model_order)LAB[k]=asI16(D.models[k].labels_i16_b64);',
      LAZY+'\nconst ID=asU64(D.source_id_u64_b64),LAB=__aisLazyValues(Object.fromEntries(D.model_order.map(k=>[k,()=>asI16(D.models[k].labels_i16_b64)]))),BRIGHT=D.bright_index;');
    return {code,applied:['pleiades-defer-model-label-decode']};
  }
  if (key==='pleiades:workflow') {
    const lazy=WORKFLOW_ARRAYS.replace('const A={','const A=__aisLazyValues({').replace(/:typed\(/g,':()=>typed(').replace(/};$/,'});');
    return {code:once(code,WORKFLOW_ARRAYS,LAZY+'\n'+lazy),applied:['pleiades-defer-workflow-arrays']};
  }
  code=once(code,'function paintHist() {',HISTOGRAM_CACHE+'function paintHist() {');
  code=once(code,HISTOGRAM,"    const cv = $('hist' + j), lo = -4, hi = 4, nb = 64;\n    const {bins,under,over} = __aisHistogram(col);");
  return {code,applied:['pleiades-cache-dataset-histograms']};
}
/** Full-program checksum gates: changed author code is delivered unchanged. */
function optimizeAstronomyCellStartup(html,{slug,role}={}) {
  if(typeof html!=='string') throw new TypeError('Expected HTML text');
  const family=slug==='jae-joint-embedding-how-one-cell-becomes-61-numbers'?'jae':slug==='pleiades-membership-explorer'?'pleiades':null;
  const key=family+':'+(role==='key_findings'?'insight':role),stats={applied:[],skipped:[]};
  const skip=reason=>{stats.skipped.push({optimization:key,reason});return {html,stats};};
  if(!family||!HASHES[key]) return skip('unsupported-page');
  const scripts=Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi));
  const eligible=scripts.filter(m=>! /\b(?:src|type|async|defer)\b/i.test(m[1]));
  if(eligible.some(m=>m[2].includes(MARKER)))return skip('already-optimized');
  const matching=eligible.filter(m=>hash(m[2])===HASHES[key]);
  if(matching.length!==1)return skip(matching.length?'ambiguous-program':'unrecognized-program');
  const target=matching[0];let updated;
  try{updated=transform(target[2],key);}catch{return skip('unrecognized-initializer');}
  const start=target.index+target[0].indexOf('>')+1;
  html=html.slice(0,start)+MARKER+'\n'+updated.code+html.slice(start+target[2].length);
  stats.applied=updated.applied;return {html,stats};
}
module.exports={optimizeAstronomyCellStartup};
