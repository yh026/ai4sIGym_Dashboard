#!/usr/bin/env node
/* Compare Production and the asset overlay in isolated Chrome profiles. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const playwrightModule = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', {
  paths: [process.cwd(), path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node')],
});
const { chromium } = require(playwrightModule);
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root=path.resolve('.local/netlify-manager/satellite');
const slug='/demos/from-twelve-thousand-numbers-to-a-codebook/';
const mime={'.html':'text/html','.js':'application/javascript','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.mp4':'video/mp4'};
function serve(mode){
 const cache=new Map();
 const server=http.createServer((req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}
  let target=path.join(root,'fixture',mode,decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(target.endsWith('/'))target+='index.html';
  if(!fs.existsSync(target)){res.writeHead(404);return res.end('Missing '+req.url)}
  const type=mime[path.extname(target)]||'application/octet-stream';
  const size=fs.statSync(target).size;
  const headers={'Content-Type':type,'Cache-Control':'no-store','Accept-Ranges':'bytes'};
  const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  if(range){const start=+range[1],end=range[2]?Math.min(+range[2],size-1):size-1;res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});const stream=fs.createReadStream(target,{start,end});stream.pipe(res);res.on('close',()=>stream.destroy());return}
  let body=cache.get(target);
  if(!body){body=fs.readFileSync(target);if(/text|javascript|json/.test(type))body=zlib.gzipSync(body,{level:9});cache.set(target,body)}
  if(/text|javascript|json/.test(type))headers['Content-Encoding']='gzip';
  res.writeHead(200,{...headers,'Content-Length':body.length});res.end(body);
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,url:`http://127.0.0.1:${server.address().port}`})));
}
async function snap(page){const shot=await page.evaluate(()=>{
 const text=id=>document.getElementById(id)?.textContent;
 const data=id=>({...document.getElementById(id)?.dataset});
 const pixels=id=>{const cv=document.getElementById(id);return cv?.toDataURL()};
 return {tile:text('tileName'),metrics:text('selectedMetrics'),storage:text('storage'),patch:text('patchReadout'),reconstruction:data('quantizedTile'),histogram:data('classificationSelectedHistogram'),summary:text('classificationSummary'),association:text('associationPatchReadout'),associationCanvas:data('associationOverlay'),mistakes:text('mxCount'),original:pixels('originalTile'),quantized:pixels('quantizedTile')};
});for(const key of ['original','quantized'])if(shot[key])shot[key]=crypto.createHash('sha256').update(shot[key]).digest('hex');return shot}
(async()=>{
 const before=await serve('before'),after=await serve('after');
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const result={schema:1,browser:browser.version(),conditions:{viewport:process.env.MOBILE?{width:390,height:844}:{width:1440,height:1000},cache:'new isolated browser context per sample; cache disabled through CDP',window_ms:10000,compression:'localhost HTTP; gzip level 9 for HTML, JS, JSON; images/video unchanged',network:'unthrottled localhost',first_load:'top of page, no scrolling, 10 seconds from navigation start'},cold:[],interactions:[]};
 try{
 for(let repeat=1;repeat<=(process.env.SKIP_COLD?0:2);repeat++)for(const [mode,fixture] of [['before',before],['after',after]]){
  console.log('Checking',mode);
  const ctx=await browser.newContext({viewport:result.conditions.viewport});const page=await ctx.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));const failed=[];page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()})});
  const cdp=await ctx.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  const requests=new Map();cdp.on('Network.requestWillBeSent',e=>requests.set(e.requestId,{url:e.request.url,received:0,headers:0}));
  cdp.on('Network.responseReceived',e=>{const q=requests.get(e.requestId);if(q){q.headers=e.response.encodedDataLength||0;q.status=e.response.status}});
  cdp.on('Network.dataReceived',e=>{const q=requests.get(e.requestId);if(q)q.received+=e.encodedDataLength||0});
  cdp.on('Network.loadingFinished',e=>{const q=requests.get(e.requestId);if(q)q.finished=e.encodedDataLength});
  const started=Date.now();await page.goto(fixture.url+slug,{waitUntil:'domcontentloaded'});await page.waitForTimeout(Math.max(0,10000-(Date.now()-started)));
  const reqs=[...requests.values()].map(q=>({...q,bytes:q.finished??q.headers+q.received}));
  console.log('Measured',mode,repeat,reqs.reduce((n,q)=>n+q.bytes,0));
  result.cold.push({mode,repeat,total_encoded_bytes:reqs.reduce((n,q)=>n+q.bytes,0),requests:reqs,errors,failed,performance:await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation')[0].toJSON(),resources:performance.getEntriesByType('resource').map(r=>({url:r.name,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize,transferSize:r.transferSize}))}))});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(reqs.filter(q=>q.status>=400),[]);await ctx.close();
 }
 for(const [mode,fixture] of [['before',before],['after',after]]){
  console.log('Checking',mode);
  const ctx=await browser.newContext({viewport:result.conditions.viewport});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(fixture.url+slug,{waitUntil:'domcontentloaded'});
  await page.locator('#reconstructionTitle').scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.VQHero&&window.VQExplorer&&document.getElementById('originalTile').width>0);
  await page.waitForFunction(()=>document.getElementById('originalTile').getContext('2d').getImageData(0,0,1,1).data[3]>0);
  const checks={mode,initial:await snap(page),sizes:[]};
  for(const k of ['8','16','32','64','128','256']){await page.selectOption('#reconstructionK',k);await page.waitForFunction(k=>document.getElementById('quantizedTile').dataset.k===k,k);checks.sizes.push(await snap(page))}
  await page.locator('#originalTile').press('ArrowRight');checks.patch=await snap(page);
  await page.locator('#errorView').check();checks.error=await snap(page);await page.locator('#errorView').uncheck();
  await page.locator('#classification').scrollIntoViewIfNeeded();await page.waitForTimeout(500);
  checks.models=[];for(const model of await page.locator('#classificationModel option').evaluateAll(xs=>xs.map(x=>x.value))){await page.selectOption('#classificationModel',model);await page.waitForFunction(model=>{const h=document.querySelector('canvas[data-dimensions]');return h&&h.dataset.model===model},model);checks.models.push(await snap(page))}
  await page.locator('[data-outcome="error"]').click();checks.filter=await snap(page);
  await page.locator('#classificationImageLookup').fill('Highway_2171.jpg');await page.locator('.class-sample-lookup button').click();checks.lookup=await snap(page);
  await page.locator('#local-associations').scrollIntoViewIfNeeded();await page.waitForSelector('#associationSample');await page.waitForFunction(()=>document.getElementById('associationOriginal')?.dataset.sample);
  checks.association=await snap(page);await page.selectOption('#associationMode','presence');await page.selectOption('#associationWord','9');checks.associationChanged=await snap(page);
  await page.locator('#network-mistakes').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.getElementById('mxCount').textContent.length>0);checks.mistakes=await snap(page);
  await page.selectOption('#mxShow','all');checks.mistakesAll=await snap(page);
  await page.goto(fixture.url+slug+'index.html?image=Highway_2171&k=64#reconstructionTitle',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(500);
  await page.waitForFunction(()=>document.getElementById('tileName').textContent.includes('Highway_2171')&&document.getElementById('quantizedTile').dataset.k==='64');checks.deepLink=await snap(page);
  await page.goto(fixture.url+slug+'index.html?t=355.7#film',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#film video').currentTime>355);checks.filmTime=await page.locator('#film video').evaluate(v=>v.currentTime);
  checks.errors=errors;assert.deepEqual(errors,[]);result.interactions.push(checks);await ctx.close();
 }
 const [b,a]=result.interactions;
 const clean=x=>{const y=structuredClone(x);delete y.mode;delete y.filmTime;
  for(const [step,value] of Object.entries(y))for(const snap of Array.isArray(value)?value:[value]){
   if(!snap||typeof snap!=='object')continue;
   if(!['association','associationChanged'].includes(step)){delete snap.association;delete snap.associationCanvas}
   if(!['mistakes','mistakesAll'].includes(step))delete snap.mistakes;
   if(!['models','lookup','filter'].includes(step))delete snap.histogram;
  }
  return y;
 };assert.deepEqual(clean(a),clean(b));
 result.parity='PASS: initial reconstruction; all 6 K sizes; keyboard patch; error view; all 8 classifiers and saved feature dimensions; outcome filter; image lookup; association mode/word; mistakes counts; ?image=&k= deep link; film ?t=';
 fs.writeFileSync(path.join(root,process.env.MOBILE?'browser-validation-mobile.json':'browser-validation.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({cold:result.cold.map(x=>({mode:x.mode,repeat:x.repeat,bytes:x.total_encoded_bytes,requests:x.requests.length})),parity:result.parity},null,2));
 }catch(error){fs.writeFileSync(path.join(root,'browser-validation-incomplete.json'),JSON.stringify(result,null,2));throw error}finally{await browser.close();before.server.close();after.server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
