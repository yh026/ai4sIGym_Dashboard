'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const V3=require('../lib/registry-v3');
const adapter=fs.readFileSync(path.join(__dirname,'../google-apps-script/sandbox/Adapter.gs'),'utf8');
const revision='sha256:'+'a'.repeat(64),instance='ais-backend-sandbox-20260923';
function harness(){
  const properties=new Map([['AI4S_REGISTRY_ACCESS_TOKEN','test-token'],['AI4S_PREVIEW_CALLBACK_SECRET','s'.repeat(64)]]),events=[],calls=[];
  const context={V3,console:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v)})},ContentService:{MimeType:{JSON:'application/json'},createTextOutput:s=>({setMimeType:()=>JSON.parse(s)})},Utilities:{computeHmacSha256Signature:(s,k)=>[...crypto.createHmac('sha256',k).update(s).digest()],getUuid:()=>crypto.randomUUID()},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
  vm.createContext(context);vm.runInContext(adapter,context);
  const ss={getSheetByName:()=>({getDataRange:()=>({getValues:()=>[['header']]}),getRange:()=>({setValue(){},setFormula(){}})})};
  context.sandboxGuard_=()=>ss;
  const snapshot={manifest:{registry_revision:revision,registry_instance:instance,audience:'preview'},files:[{id:'page-insight',kind:'page',file_id:'drive-secret-id',size:5,sha256:crypto.createHash('sha256').update('hello').digest('hex')} ]};
  context.checkedSnapshot_=r=>{calls.push('snapshot');if(r&&r!==revision)throw new Error('Revision changed');return snapshot;};
  context.assertStamp_=()=>({getBlob:()=>({getBytes:()=>[...Buffer.from('hello')],getDataAsString:()=> 'hello'})});
  context.hash_=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  context.audit_=(...a)=>events.push(a);
  context.tableRows_=()=>[['header']];
  return {context,properties,events,calls,snapshot};
}
function get(h,patch={}){return h.context.doGet({parameter:{token:'test-token',schema:'3',audience:'preview',action:'manifest',...patch}});}
test('native Sheets checkbox placeholder rows are ignored without hiding incomplete records',()=>{
  const context={};vm.createContext(context);vm.runInContext(adapter,context);
  const rows=[['ID','Selected'],['',false],['draft-v1',false],['',true],['', 'Draft']];
  const actual=context.tableRows_({getSheetByName:()=>({getDataRange:()=>({getValues:()=>rows})})},'Versions');
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),[rows[0],rows[2],rows[3],rows[4]]);
});
test('sandbox API rejects wrong token before reading content and rejects Production/schema 2',()=>{
  const h=harness();assert.equal(get(h,{token:'wrong'}).ok,false);assert.equal(h.calls.length,0);
  assert.equal(get(h,{audience:'production'}).ok,false);assert.equal(get(h,{schema:'2'}).ok,false);assert.equal(h.calls.length,0);
});
test('page API requires an authorized page identity and the exact revision',()=>{
  const h=harness();assert.equal(get(h,{action:'page',id:'page-insight',registry_revision:revision}).html,'hello');
  for(const patch of [{id:'drive-secret-id'},{id:'unpublished-page'},{registry_revision:'stale'},{action:'resource'}])assert.equal(get(h,{action:'page',id:'page-insight',registry_revision:revision,...patch}).ok,false);
});
test('a source hash or live input change blocks reads rather than using the old snapshot',()=>{
  const h=harness();h.snapshot.files[0].sha256='b'.repeat(64);assert.equal(get(h,{action:'page',id:'page-insight',registry_revision:revision}).ok,false);
  h.context.checkedSnapshot_=()=>{throw new Error('Sheet changed');};assert.equal(get(h).ok,false);
});
function receipt(){return {schema:1,registry_schema:3,registry_instance:instance,verified:true,revision_bound:true,target:'preview',audience:'preview',platform:'netlify',context:'branch-deploy',branch:'develop',site_id:'2fe21bb6-70b5-47c6-a810-18f6bd8f4973',registry_revision:revision,request_id:'abc',requested_at:'2026-09-23T00:00:00.000Z',deploy_id:'deploy-one',build_id:'build-one',commit_ref:'a'.repeat(40)};}
function post(h,r,callback_at=new Date().toISOString(),secret='s'.repeat(64)){
  const payload=JSON.stringify({schema:1,event:'preview_deploy_succeeded',callback_at,receipt:r});
  const signature=crypto.createHmac('sha256',secret).update(payload).digest('hex');
  return h.context.doPost({parameter:{action:'preview_callback'},postData:{contents:JSON.stringify({payload,signature})}});
}
function requested(h){h.properties.set('SANDBOX_PREVIEW_STATE',JSON.stringify({revision,request_id:'abc',requested_at:'2026-09-23T00:00:00.000Z',phase:'accepted'}));}
test('only matching signed instance/site/branch/request callbacks mark preview ready; duplicate ack is idempotent',()=>{
  const h=harness();requested(h);const r=receipt();assert.equal(post(h,r).ok,true);assert.equal(h.events.length,1);assert.equal(JSON.parse(h.properties.get('SANDBOX_PREVIEW_STATE')).phase,'ready');
  assert.equal(post(h,r).ok,true);assert.equal(h.events.length,1);
  assert.equal(post(h,{...r,deploy_id:'replayed-deploy'}).ok,false);
});
test('wrong secret, stale callbacks, other registries, sites, unverified builds and mismatched requests are rejected',()=>{
  const h=harness();requested(h);const r=receipt();assert.equal(post(h,r,undefined,'wrong').ok,false);assert.equal(post(h,r,'2020-01-01T00:00:00.000Z').ok,false);
  for(const patch of [{registry_instance:'other'},{site_id:'other'},{branch:'main'},{verified:'false'},{request_id:'other'},{registry_revision:'sha256:'+'b'.repeat(64)}])assert.equal(post(h,{...r,...patch}).ok,false);
  assert.equal(h.events.length,0);assert.equal(JSON.parse(h.properties.get('SANDBOX_PREVIEW_STATE')).phase,'accepted');
});
test('a signed unverified Git deployment removes stale ready status instead of approving it',()=>{
  const h=harness();requested(h);assert.equal(post(h,receipt()).ok,true);
  assert.equal(post(h,{...receipt(),verified:false,deploy_id:'git-deploy'}).ok,true);
  assert.equal(JSON.parse(h.properties.get('SANDBOX_PREVIEW_STATE')).phase,'replaced');
  assert.equal(h.events.length,2);
  assert.equal(post(h,receipt()).ok,false);
});
test('parallel operations cannot write or publish while the lock is held',()=>{
  const h=harness();h.context.LockService.getScriptLock=()=>({tryLock:()=>false,releaseLock(){throw new Error('not owned');}});
  let wrote=false;assert.throws(()=>h.context.locked_(()=>{wrote=true;}),/Another sandbox operation/);assert.equal(wrote,false);
});
test('accepted preview requests never duplicate a hook while waiting for completion',()=>{
  const h=harness();requested(h);h.properties.set('AI4S_NETLIFY_PREVIEW_BUILD_HOOK','https://api.netlify.com/build_hooks/abcd');h.context.UrlFetchApp={fetch(){throw new Error('Must not call hook again');}};
  assert.equal(h.context.publishPreview().phase,'accepted');assert.equal(h.events.length,0);
});
test('failed requests do not retry hourly, and explicit retries are bounded',()=>{
  const h=harness();requested(h);h.properties.set('AI4S_NETLIFY_PREVIEW_BUILD_HOOK','https://api.netlify.com/build_hooks/abcd');
  let sent=0;h.context.UrlFetchApp={fetch(){sent++;return {getResponseCode:()=>503};}};
  const state=JSON.parse(h.properties.get('SANDBOX_PREVIEW_STATE'));state.phase='failed';state.attempts=1;h.properties.set('SANDBOX_PREVIEW_STATE',JSON.stringify(state));
  assert.equal(h.context.publishPreview().phase,'failed');assert.equal(sent,0);
  state.phase='retry-approved';h.properties.set('SANDBOX_PREVIEW_STATE',JSON.stringify(state));
  assert.equal(h.context.publishPreview().attempts,2);assert.equal(sent,1);
  assert.equal(h.context.publishPreview().phase,'failed');assert.equal(sent,1);
  state.attempts=3;h.properties.set('SANDBOX_PREVIEW_STATE',JSON.stringify(state));
  assert.throws(()=>h.context.publishPreview(),/Three attempts/);assert.equal(sent,1);
});
