'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {optimizeAstronomyCellStartup:optimize}=require('../lib/astronomy-cell-startup-optimization');
const slug=family=>family==='jae'?'jae-joint-embedding-how-one-cell-becomes-61-numbers':'pleiades-membership-explorer';
const fixture=(family,role)=>fs.readFileSync(path.join(__dirname,'fixtures/astronomy-cell',family+'-'+role+'.js.txt'),'utf8');
const wrap=program=>'<html><body><script type="application/json" id="payload">{"number":0.12345678901234568,"codes":"AP8="}</script><script>'+program+'</script></body></html>';
const script=html=>[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
function versions(family,role){const before=fixture(family,role),result=optimize(wrap(before),{slug:slug(family),role});assert.ok(result.stats.applied.length,JSON.stringify(result.stats));return {before,after:script(result.html),result};}
function between(code,start,end){const a=code.indexOf(start),b=code.indexOf(end,a);assert.ok(a>=0&&b>a,start+' / '+end);return code.slice(a,b);}
const b64=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength).toString('base64');
const same=(a,b)=>assert.deepEqual(Buffer.from(a.buffer,a.byteOffset,a.byteLength),Buffer.from(b.buffer,b.byteOffset,b.byteLength));
function runtime(data={}){
 const counts={decode:0,floatArrays:0,distanceArrays:0};
 const F32=new Proxy(Float32Array,{construct(t,args){counts.floatArrays++;return Reflect.construct(t,args);}});
 const F64=new Proxy(Float64Array,{construct(t,args){counts.distanceArrays++;return Reflect.construct(t,args);}});
 return {counts,ctx:vm.createContext({D:data,Uint8Array,Uint16Array,Uint32Array,Int16Array,Float32Array:F32,Float64Array:F64,BigUint64Array,ArrayBuffer,atob(s){counts.decode++;return Buffer.from(s,'base64').toString('binary');}})};
}

test('all six reviewed programs compile, preserve payload text, and are idempotent',()=>{
 for(const family of ['jae','pleiades'])for(const role of ['insight','dataset','workflow']){
  const {before,after,result}=versions(family,role);new vm.Script(before);new vm.Script(after);
  const source=wrap(before);assert.equal(result.html.match(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/)[0],source.match(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/)[0]);
  const twice=optimize(result.html,{slug:slug(family),role});assert.equal(twice.html,result.html);assert.equal(twice.stats.skipped[0].reason,'already-optimized');
 }
});
test('unknown versions, ambiguous programs, and excluded projects are preserved',()=>{
 const original=wrap(fixture('jae','workflow'));
 for(const id of [{slug:'air-quality-day-segment-pca-and-amp-umap-by-sensor',role:'workflow'},{slug:'singapore-road-speed-clusters-umap',role:'insight'},{slug:slug('jae'),role:'other'}])assert.equal(optimize(original,id).html,original);
 const changed=original.replace('window.__JAE_PAYLOAD__=D;','window.__JAE_PAYLOAD__ = D;');assert.equal(optimize(changed,{slug:slug('jae'),role:'workflow'}).html,changed);
 const duplicated=original.replace('</body>','<script>'+fixture('jae','workflow')+'</script></body>');assert.equal(optimize(duplicated,{slug:slug('jae'),role:'workflow'}).stats.skipped[0].reason,'ambiguous-program');
 const modulePage=original.replace('<script>','<script type="module">');assert.equal(optimize(modulePage,{slug:slug('jae'),role:'workflow'}).html,modulePage);
});

function runPleiadesInsight(code,data){const h=runtime(data);vm.runInContext(between(code,'const bytes=s=>','const GROUPS=')+'globalThis.out={V,ID,LAB};',h.ctx);return {...h,out:h.ctx.out};}
test('Pleiades Insight lazily decodes non-default model labels without changing Float64/Int16/BigUint64 data',()=>{
 const a=Float64Array.from([-0,Math.PI,-1e-200,Infinity,NaN]);
 const data={arrays:Object.fromEntries(['pmra','pmdec','parallax','g_mag','bp_rp'].map(k=>[k,b64(a)])),source_id_u64_b64:b64(BigUint64Array.from([0n,18446744073709551615n,9007199254740993n])),bright_index:[1],model_order:['hdbscan','gmm','dbscan'],models:{}};
 data.model_order.forEach((key,i)=>data.models[key]={labels_i16_b64:b64(Int16Array.from([-1,i,32767,-32768]))});
 const v=versions('pleiades','insight'),old=runPleiadesInsight(v.before,data),now=runPleiadesInsight(v.after,data);
 assert.equal(old.counts.decode,9);assert.equal(now.counts.decode,6);assert.deepEqual(Object.keys(now.out.LAB),data.model_order);
 for(const key of Object.keys(old.out.V))same(now.out.V[key],old.out.V[key]);same(now.out.ID,old.out.ID);
 for(const key of data.model_order){const n=now.counts.decode,a=now.out.LAB[key];same(a,old.out.LAB[key]);assert.equal(now.counts.decode,n+1);assert.equal(now.out.LAB[key],a);assert.equal(now.counts.decode,n+1);}
});
function runPleiadesWorkflow(code,data){const h=runtime(data);vm.runInContext(between(code,'function bytes(encoded){','const FAMILY_LABEL=')+'globalThis.out=A;',h.ctx);return {...h,out:h.ctx.out};}
test('Pleiades Workflow defers all fourteen arrays until required and preserves every exact typed value',()=>{
 const fields={source_id_u64_b64:BigUint64Array.from([9007199254740993n,1n]),notebook_gmm_labels_i16_b64:Int16Array.from([-1,7]),feature_percentiles_u8_b64:Uint8Array.from([0,100,255])};
 for(const name of ['ra','dec','parallax','parallax_over_error','pmra','pmdec','g_mag','bp_rp','e_g_mag'])fields[name+'_f64_b64']=Float64Array.from([-0,-123.00000000000003,Math.PI]);
 fields.pca_xy_f32_b64=Float32Array.from([-0,Math.PI,1e-30]);fields.notebook_pca_xy_f32_b64=Float32Array.from([1,-2,3]);
 const data={arrays:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,b64(v)]))},v=versions('pleiades','workflow'),old=runPleiadesWorkflow(v.before,data),now=runPleiadesWorkflow(v.after,data);
 assert.equal(old.counts.decode,14);assert.equal(now.counts.decode,0);assert.deepEqual(Object.keys(now.out),Object.keys(old.out));
 for(const key of Object.keys(old.out)){const n=now.counts.decode,a=now.out[key];same(a,old.out[key]);assert.equal(now.counts.decode,n+1);assert.equal(now.out[key],a);assert.equal(now.counts.decode,n+1);}
});
function runJaeMatrix(code,data,optimized){const h=runtime();h.ctx.DX=data;vm.runInContext(between(code,optimized?'function __aisLazyValues':'const CODES =','const NC =')+(optimized?'globalThis.read=()=>__aisMatrix.codes;':'globalThis.read=()=>CODES;'),h.ctx);return h;}
test('JAE Dataset waits for matrix use and returns identical display codes and row values',()=>{
 const codes=Uint8Array.from([0,255,1,128,77,0,255,244,123,3,2,1]),data={codes_b64:b64(codes)},v=versions('jae','dataset');
 const old=runJaeMatrix(v.before,data,false),now=runJaeMatrix(v.after,data,true);assert.equal(old.counts.decode,1);assert.equal(now.counts.decode,0);
 const a=now.ctx.read(),b=old.ctx.read();same(a,b);assert.equal(now.counts.decode,1);assert.equal(now.ctx.read(),a);assert.equal(now.counts.decode,1);
 for(let row=0;row<3;row++)for(let col=0;col<4;col++)assert.equal(a[row*4+col]/255*[.01,3.11,12,100][col],b[row*4+col]/255*[.01,3.11,12,100][col]);
});
function runJaeDecoders(code,optimized){const h=runtime();let helpers=optimized?code.slice(0,code.indexOf('window.__JAE_PAYLOAD__')):'';
 const explorer=between(code,'function unb64(s, Type){','/* Colours');
 const lab=between(code,'function unb64(s,T){','const css=n=>');
 vm.runInContext(helpers+'globalThis.explorer=(()=>{'+explorer+'return {unb64,deq};})();globalThis.lab=(()=>{'+lab+'return {unb64,deq};})();',h.ctx);return h;}
test('JAE Workflow reuses identical decoded arrays and dequantization across views with unchanged arithmetic',()=>{
 const v=versions('jae','workflow'),old=runJaeDecoders(v.before,false),now=runJaeDecoders(v.after,true),encoded=b64(Uint16Array.from([0,1,32767,65535]));
 const results=[];
 for(const h of [old,now]){const x=h.ctx.explorer.unb64(encoded,Uint16Array),y=h.ctx.lab.unb64(encoded,Uint16Array);results.push([h.ctx.explorer.deq(x,-3.125,9.7,65535),h.ctx.lab.deq(y,-3.125,9.7,65535)]);}
 same(results[1][0],results[0][0]);same(results[1][1],results[0][1]);assert.equal(old.counts.decode,2);assert.equal(now.counts.decode,1);assert.equal(old.counts.floatArrays,2);assert.equal(now.counts.floatArrays,1);assert.equal(results[1][0],results[1][1]);
 const other=now.ctx.lab.unb64(encoded,Uint8Array);assert.equal(now.counts.decode,2);same(other,old.ctx.lab.unb64(encoded,Uint8Array));
 const z=now.ctx.lab.unb64(encoded,Uint16Array);for(const params of [[-0,0,65535],[0,0,65535],[-1,1,255],[0,1,65535]])same(now.ctx.lab.deq(z,...params),old.ctx.lab.deq(z,...params));
 assert.notEqual(now.ctx.lab.deq(z,-0,0,65535),now.ctx.lab.deq(z,0,0,65535),'Signed-zero parameter keys are not conflated.');
});
function runNeighbours(code,optimized,raw,N,DIM,K){const h=runtime();Object.assign(h.ctx,{raw,N,DIM,K});vm.runInContext(between(code,optimized?'const __aisNeighbourCache':'function neighbours(cell){','\nlet selected=')+'globalThis.neighbours=neighbours;',h.ctx);return h;}
test('JAE Insight neighbour cache preserves exact stable tie ordering, fresh results and bounded retention',()=>{
 const N=40,DIM=4,K=5,raw=Uint8Array.from({length:N*DIM},(_,i)=>Math.floor(i/8)%11),v=versions('jae','insight');
 const old=runNeighbours(v.before,false,raw,N,DIM,K),now=runNeighbours(v.after,true,raw,N,DIM,K);
 const first=now.ctx.neighbours(0);assert.deepEqual(Array.from(first),Array.from(old.ctx.neighbours(0)));first[0]=-999;
 assert.deepEqual(Array.from(now.ctx.neighbours(0)),Array.from(old.ctx.neighbours(0)));assert.equal(now.counts.distanceArrays,1);
 for(let i=1;i<N;i++)assert.deepEqual(Array.from(now.ctx.neighbours(i)),Array.from(old.ctx.neighbours(i)));
 const n=now.counts.distanceArrays;assert.deepEqual(Array.from(now.ctx.neighbours(0)),Array.from(old.ctx.neighbours(0)));assert.equal(now.counts.distanceArrays,n+1,'Oldest cached entry is evicted after thirty-two different cells.');
});
function originalHistogram(col){const lo=-4,hi=4,nb=64,bins=new Array(nb).fill(0);let under=0,over=0;col.forEach(v=>{if(v<lo)under++;else if(v>=hi)over++;else bins[Math.floor((v-lo)/(hi-lo)*nb)]++;});return {bins,under,over};}
test('Pleiades Dataset caches exact bin-edge/overflow counts without rescanning on repaint',()=>{
 const v=versions('pleiades','dataset'),h=runtime();vm.runInContext(between(v.after,'const __aisHistogramCache','function paintHist() {')+'globalThis.hist=__aisHistogram;',h.ctx);
 for(const values of [[],[-Infinity,-4.01,-4,-3.875,0,3.999,4,Infinity,NaN]]){
  let reads=0;const col=values.slice();col.forEach=function(fn){reads++;return Array.prototype.forEach.call(this,fn);};
  const out=h.ctx.hist(col),expected=originalHistogram(values);assert.deepEqual(Array.from(out.bins),expected.bins.slice());assert.deepEqual(Object.keys(out.bins),Object.keys(expected.bins));assert.equal(out.under,expected.under);assert.equal(out.over,expected.over);assert.equal(h.ctx.hist(col),out);assert.equal(reads,1);
 }
});
