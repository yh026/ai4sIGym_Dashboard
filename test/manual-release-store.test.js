'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pack, unpack, hash, stable } = require('../google-apps-script/publishing-controls/manual-release/capsule.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../google-apps-script/publishing-controls/manual-release/ManualReleaseStore.gs'), 'utf8');
const { confirmationDigest } = require('../google-apps-script/publishing-controls/manual-release/hook.cjs');
const SITE = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973', SECRET = 'test-only-signing-secret-not-a-real-credential';
const NOW = Date.parse('2026-10-08T04:00:00.000Z');
const iso = delta => new Date(NOW + delta).toISOString();
const identity = (kind, digit) => ({ site_id: SITE, build_id: digit.repeat(24), deploy_id: digit.repeat(24),
  commit_ref: 'c'.repeat(40), branch: kind === 'preview' ? 'develop' : 'main',
  context: kind === 'preview' ? 'branch-deploy' : 'production' });

function runtime() {
  let time = NOW, next = 0, lockHeld = false, failLocks = 0, duringChunkCreate = null, duringChunkSize = null;
  const values = new Map([['AIS_RELEASE_ROOT_FOLDER_ID','root-folder'], ['AI4S_PREVIEW_CALLBACK_SECRET',SECRET]]), files = new Map();
  const blob = (value, type, name) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : value || []);
    return { bytes, name, getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8') }; };
  class File {
    constructor(b) { this.id = 'file-' + (++next); this.name = b.name; this.bytes = Buffer.from(b.bytes); this.trashed = false; }
    getId() { return this.id; } getSize() { if(this.name.startsWith('chunk-')) {
      assert.equal(lockHeld,false,'Chunk metadata I/O must not hold the shared lock.');
      if(duringChunkSize) {const callback=duringChunkSize;duringChunkSize=null;callback(this);}
    } return this.bytes.length; } isTrashed() { return this.trashed; }
    getBlob() { if(this.name.startsWith('chunk-'))assert.equal(lockHeld,false,'Chunk bytes must not be read under the shared lock.');return blob(this.bytes); }
    setContent(value) { this.bytes = Buffer.from(value); return this; }
    setTrashed(value) { assert.equal(lockHeld,false);this.trashed=value;return this; }
  }
  const root = { getFilesByName(name) { const matches = [...files.values()].filter(f => f.name === name && !f.trashed); let cursor = 0;
    return { hasNext: () => cursor < matches.length, next: () => matches[cursor++] }; },
  createFile(b) { const file = new File(b); files.set(file.id,file);
    if(file.name.startsWith('chunk-')) {assert.equal(lockHeld,false,'Drive byte upload must not hold the shared lock.');
      if(duringChunkCreate){const callback=duringChunkCreate;duringChunkCreate=null;callback(file);}}
    return file; } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const props = { getProperty: key => values.get(key) || null, setProperty(key,value) { values.set(key,value); return this; }, deleteProperty: key => values.delete(key) };
  let preview = { phase:'accepted',request_id:'preview-request',revision:'sha256:'+'d'.repeat(64) }, publicReceipt = null;
  const selection=[{demo_id:'demo-one',include_in_production:true,include_in_preview:true}],catalog=[{demo_id:'demo-one',title:'One',number:'001',slug:'one'}];
  const context = vm.createContext({ console, Date: Clock, SANDBOX: {site_id:SITE},
    registryManualSelection_:()=>selection,registryManualCatalog_:()=>catalog,
    PropertiesService:{getScriptProperties:()=>props}, DriveApp:{getFolderById:()=>root,getFileById:id=>{
      if (!files.has(id)) throw new Error('Injected missing Drive object token=DO_NOT_LEAK'); return files.get(id); }},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},newBlob:blob,getUuid:()=>crypto.randomUUID(),computeDigest:(algorithm,value)=>{
      if(value.length>1048576)assert.equal(lockHeld,false,'Large chunk hashing must not hold the shared lock.');
      return [...crypto.createHash('sha256').update(Buffer.from(value)).digest()];},
      computeHmacSha256Signature:(value,key)=>[...crypto.createHmac('sha256',key).update(value).digest()],
      base64Decode:value=>[...Buffer.from(value,'base64')],base64Encode:value=>Buffer.from(value).toString('base64')},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>publicReceipt?200:404,getContentText:()=>JSON.stringify(publicReceipt)})},
    safeEqual_:(a,b)=>a===b, locked_:fn=>{if(lockHeld||failLocks>0){if(failLocks>0)failLocks--;throw new Error('Another sandbox operation is running');}
      lockHeld=true;try{return fn();}finally{lockHeld=false;}}, json_:value=>JSON.parse(JSON.stringify(value)), previewState_:()=>preview,
    savePreviewState_:value=>{preview=value;} });
  vm.runInContext(source,context);
  function call(id, action, data={}, options={}) {
    const payload = JSON.stringify({schema:1,...id,...data,action,sent_at:options.sent_at || new Date(time).toISOString()});
    const signature = crypto.createHmac('sha256',options.secret || SECRET).update((options.domain || 'ais-manual-release-api-v1\n')+payload).digest('hex');
    return context.registryReleaseStoreHandlePost_({parameter:{action:'manual_release'},postData:{contents:JSON.stringify({payload,signature})}});
  }
  function success(result) { assert.equal(result.ok,true,result.error); return result; }
  function prepare(kind,id,binding={},extra={}) {
    return pack(new Map([['index.html',Buffer.from('<p>Immutable '+kind+'</p>')]]),{kind,...id,...binding,...extra});
  }
  function upload(id, prepared, binding={}) {
    success(call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
    prepared.chunks.forEach((bytes,index)=>success(call(id,'put_chunk',{...binding,capsule_id:prepared.capsule.id,index,
      sha256:prepared.capsule.chunks[index].sha256,base64:bytes.toString('base64')})));
    success(call(id,'complete_capsule',{...binding,capsule_id:prepared.capsule.id})); return prepared.capsule;
  }
  function receipt(id,target,extra={}) { return {schema:1,platform:'netlify',verified:true,...id,target,
    audience:target==='production'?'production':'preview',...extra}; }
  function bootstrap() {
    const id = identity('production','1'), prepared = prepare('production',id);
    values.set('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY',id.deploy_id); values.set('AIS_RELEASE_BOOTSTRAP_UPLOADER',JSON.stringify(id));
    upload(id,prepared);
    success(call(id,'deployment_succeeded',{kind:'production',capsule_id:prepared.capsule.id,receipt:receipt(id,'production')}));
    return {id,capsule:prepared.capsule};
  }
  function previewReady() {
    const id = identity('preview','2'), binding={request_id:preview.request_id};
    const prepared=prepare('preview',id,binding,{registry_revision:preview.revision,renderer_digest:'sha256:'+'e'.repeat(64)}); upload(id,prepared,binding);
    preview={...preview,phase:'ready',deploy_id:id.deploy_id};
    success(call(id,'deployment_succeeded',{...binding,kind:'preview',capsule_id:prepared.capsule.id,
      receipt:receipt(id,'preview',{...binding,revision_bound:true,registry_revision:preview.revision})}));
    return {id,capsule:prepared.capsule};
  }
  function releaseSetup(claim=true) {
    const production=bootstrap(),development=previewReady(),id=identity('production','3');
    const review={id:'confirmation-0001',schema:2,created_at:iso(0),expires_at:iso(1800000),site_id:SITE,
      selection:JSON.parse(JSON.stringify(selection)),catalog:JSON.parse(JSON.stringify(catalog)),
      baseline_capsule_id:production.capsule.id,preview_capsule_id:development.capsule.id,baseline_deploy_id:production.id.deploy_id,
      preview_deploy_id:development.id.deploy_id,renderer_digest:'sha256:'+'e'.repeat(64),phase:'ready',
      changes:[{demo_id:'demo-one',title:'One',action:'Update'}]};
    review.confirmation_digest=confirmationDigest(review);context.registryReleaseStoreCreateReview_(review);
    const binding={request_id:'production-request',review_id:review.id};
    const request={id:binding.request_id,schema:2,kind:'production',review_id:review.id,created_at:iso(0),expires_at:iso(900000),
      branch:'main',target:'production',phase:'requested',baseline_deploy_id:review.baseline_deploy_id,
      preview_capsule_id:review.preview_capsule_id,confirmation_digest:review.confirmation_digest};
    context.registryReleaseStoreCreateRequest_(request);values.set('AIS_RELEASE_ACTIVE_REQUEST_ID',request.id);
    const claimData={...binding,baseline_deploy_id:review.baseline_deploy_id,preview_capsule_id:review.preview_capsule_id,
      confirmation_digest:review.confirmation_digest};
    if(claim)success(call(id,'claim_production',claimData));
    return {production,development,id,review,binding,claimData};
  }
  function productionPrepared(setup,finish=false) {
    const {id,review,binding}=setup,artifactDigest='sha256:'+'f'.repeat(64);
    const prepared=prepare('production',id,binding,{renderer_digest:review.renderer_digest,
      confirmation_digest:review.confirmation_digest,artifact_digest:artifactDigest});
    upload(id,prepared,binding);
    const projects=[{demo_id:'demo-one',slug:'one',source_environment:'preview',source_deploy_id:review.preview_deploy_id,
      content_digest:'sha256:'+'a'.repeat(64),action:'update'}];
    const body={schema:1,target:'production',site_id:SITE,created_at:iso(0),expires_at:iso(1800000),
      baseline:{deploy_id:review.baseline_deploy_id},reviewed_preview:{deploy_id:review.preview_deploy_id},projects,removals:[],
      publication:{required_overrides:[],omit_notebook_downloads:false,preserve_homepage_introduction:false}};
    const plan={...body,intent_digest:'sha256:'+hash(stable(body))};
    const evidence={projects,preserved_overrides:[],catalog_pages_regenerated:true,source_files_unchanged:true,
      unselected_routes_absent:true,renderer_digest:review.renderer_digest};
    const data={...binding,capsule_id:prepared.capsule.id,artifact_digest:artifactDigest,plan,renderer_evidence:evidence};
    success(call(id,'production_prepared',data));
    const completed={...binding,kind:'production',capsule_id:prepared.capsule.id,
      receipt:receipt(id,'production',{...binding,publication_method:'develop-promotion',confirmation_digest:review.confirmation_digest,
        preview_capsule_id:review.preview_capsule_id,reviewed_artifact_digest:artifactDigest})};
    if(finish)success(call(id,'deployment_succeeded',completed));
    return {...setup,prepared,data,completed};
  }
  return {context,call,success,prepare,upload,receipt,bootstrap,previewReady,releaseSetup,productionPrepared,files,values,selection,catalog,
    setTime:delta=>{time=NOW+delta;},setPreview:value=>{preview=value;},setPublicReceipt:value=>{publicReceipt=value;},
    onChunkCreate:fn=>{duringChunkCreate=fn;},onChunkSize:fn=>{duringChunkSize=fn;},failNextLocks:count=>{failLocks=count;}};
}

test('signed preview artifacts stay inactive until the matching signed deployment succeeds',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'}, revision='sha256:'+'d'.repeat(64);
  const prepared=r.prepare('preview',id,binding,{registry_revision:revision}); r.upload(id,prepared,binding);
  assert.equal(r.context.registryReleaseStoreGetActive_('preview'),null);
  const data={...binding,kind:'preview',capsule_id:prepared.capsule.id,receipt:r.receipt(id,'preview',{...binding,revision_bound:true,registry_revision:revision})};
  assert.match(r.call(id,'deployment_succeeded',data).error,/current signed/);
  r.setPreview({phase:'ready',request_id:binding.request_id,revision,deploy_id:id.deploy_id});
  r.success(r.call(id,'deployment_succeeded',data)); assert.equal(r.context.registryReleaseStoreGetActive_('preview').id,prepared.capsule.id);
});
test('wrong signing key, domain, stale timestamp and wrong site are rejected without writes',()=>{
  const r=runtime(), id=identity('preview','2');
  for (const options of [{secret:'wrong'},{domain:'wrong\n'},{sent_at:iso(-900001)}]) assert.equal(r.call(id,'claim_production',{},options).ok,false);
  assert.equal(r.call({...id,site_id:'other'},'claim_production').ok,false); assert.equal(r.files.size,0);
});
test('no public API action can create a production request',()=>{
  const r=runtime(); assert.match(r.call(identity('production','4'),'create_request',{kind:'production'}).error,/Unknown release action/); assert.equal(r.files.size,0);
});
test('bootstrap is pinned to a configured uploader and closes after first activation',()=>{
  const r=runtime(), base=r.bootstrap(); assert.equal(r.context.registryReleaseStoreGetActive_('production').id,base.capsule.id);
  assert.equal(r.values.has('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY'),false); assert.equal(r.values.has('AIS_RELEASE_BOOTSTRAP_UPLOADER'),false);
  const prepared=r.prepare('production',base.id); assert.equal(r.call(base.id,'begin_capsule',{capsule:prepared.capsule}).ok,false);
});
test('bootstrap uploader cannot replace identity with another signed build',()=>{
  const r=runtime(), expected=identity('production','1'), wrong=identity('production','9');
  r.values.set('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY',wrong.deploy_id); r.values.set('AIS_RELEASE_BOOTSTRAP_UPLOADER',JSON.stringify(expected));
  const prepared=r.prepare('production',wrong); assert.equal(r.call(wrong,'begin_capsule',{capsule:prepared.capsule}).ok,false);
});
test('incomplete capsule, checksum mismatch and descriptor changes are rejected',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=r.prepare('preview',id,binding,{registry_revision:'sha256:'+'d'.repeat(64)});
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  assert.match(r.call(id,'complete_capsule',{...binding,capsule_id:prepared.capsule.id}).error,/incomplete/);
  assert.match(r.call(id,'put_chunk',{...binding,capsule_id:prepared.capsule.id,index:0,sha256:prepared.capsule.chunks[0].sha256,base64:Buffer.alloc(prepared.chunks[0].length).toString('base64')}).error,/checksum/);
  assert.match(r.call(id,'begin_capsule',{...binding,capsule:{...prepared.capsule,archive_sha256:'0'.repeat(64)}}).error,/Immutable/);
});
test('explicit production claim is bound to one build and its confirmed develop source',()=>{
  const r=runtime(),s=r.releaseSetup();r.success(r.call(s.id,'claim_production',s.claimData));
  assert.match(r.call(identity('production','9'),'claim_production',s.claimData).error,/build identity/);
  assert.equal(r.call(s.id,'claim_production',{...s.claimData,preview_capsule_id:'another-preview'}).ok,false);
});
test('retired review actions and signed ordinary main builds cannot read or publish artifacts',()=>{
  const r=runtime(),base=r.bootstrap(),id=identity('production','5');
  assert.equal(r.call(id,'read_capsule',{capsule_id:base.capsule.id}).ok,false);
  for(const action of ['claim_review','candidate_ready','create_request'])assert.match(r.call(id,action).error,/Unknown release action/);
});
test('publication can read only its two pinned immutable sources and detects stored tampering',()=>{
  const r=runtime(),s=r.releaseSetup(),capsuleId=s.development.capsule.id;
  const descriptor=r.success(r.call(s.id,'read_capsule',{...s.binding,capsule_id:capsuleId})).capsule;
  const chunk=r.success(r.call(s.id,'read_chunk',{...s.binding,capsule_id:capsuleId,index:0}));
  assert.equal(unpack(descriptor,[Buffer.from(chunk.base64,'base64')]).get('index.html').toString(),'<p>Immutable preview</p>');
  assert.equal(r.call(s.id,'read_capsule',{...s.binding,capsule_id:'unknown-capsule'}).ok,false);
  [...r.files.values()].find(f=>f.name.startsWith('chunk-'+capsuleId+'-0-')).bytes=Buffer.from('changed');
  assert.match(r.call(s.id,'read_chunk',{...s.binding,capsule_id:capsuleId,index:0}).error,/checksum/);
});
test('preparing production never activates it; only the matching successful deployment does',()=>{
  const r=runtime(),s=r.productionPrepared(r.releaseSetup());
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,s.production.capsule.id);
  r.success(r.call(s.id,'deployment_succeeded',s.completed));
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,s.prepared.capsule.id);
});
test('publication requires prepared renderer evidence and cannot substitute another capsule',()=>{
  const r=runtime(),s=r.releaseSetup(),prepared=r.prepare('production',s.id,s.binding,{artifact_digest:'sha256:'+'f'.repeat(64)});
  r.upload(s.id,prepared,s.binding);
  assert.equal(r.call(s.id,'deployment_succeeded',{...s.binding,kind:'production',capsule_id:prepared.capsule.id,
    receipt:r.receipt(s.id,'production',{...s.binding,reviewed_artifact_digest:'sha256:'+'f'.repeat(64)})}).ok,false);
  const other=r.prepare('production',s.id,s.binding);assert.equal(r.call(s.id,'begin_capsule',{...s.binding,capsule:other.capsule}).ok,false);
});
test('changed plan, renderer evidence, selection or sources cannot pass final preparation',()=>{
  for(const mutate of [s=>{s.data.plan.removals=[{demo_id:'demo-one'}];},
    s=>{s.data.renderer_evidence.source_files_unchanged=false;},s=>{s.data.renderer_evidence.renderer_digest='sha256:'+'a'.repeat(64);}]){
    const r=runtime(),s=r.productionPrepared(r.releaseSetup());mutate(s);
    assert.equal(r.call(s.id,'production_prepared',s.data).ok,false);
  }
  for(const mutate of [r=>r.selection[0].include_in_production=false,r=>r.catalog[0].title='Changed',
    r=>r.setPreview({phase:'accepted',request_id:'new-request',revision:'sha256:'+'d'.repeat(64)})]){
    const r=runtime(),s=r.productionPrepared(r.releaseSetup());mutate(r);
    assert.equal(r.call(s.id,'production_prepared',s.data).ok,false);
  }
});
test('claim rejects changed active source, selection and altered confirmation digest',()=>{
  for(const mutate of [r=>r.values.set('AIS_RELEASE_ACTIVE_PREVIEW_CAPSULE_ID','unknown-capsule'),
    r=>r.selection[0].include_in_preview=false,r=>r.catalog[0].title='Changed']){
    const r=runtime(),s=r.releaseSetup(false);mutate(r);assert.equal(r.call(s.id,'claim_production',s.claimData).ok,false);
  }
  const r=runtime(),s=r.releaseSetup(false);s.review.selection[0].include_in_production=false;
  assert.throws(()=>r.context.registryReleaseStoreSaveReview_(s.review),/confirmation changed/);
});
test('expiry rejects new claims while a claimed build retains bounded source access',()=>{
  const r=runtime(),s=r.releaseSetup(false);r.setTime(900001);assert.equal(r.call(s.id,'claim_production',s.claimData).ok,false);
  const active=runtime(),claimed=active.releaseSetup();active.setTime(3600000);
  active.success(active.call(claimed.id,'read_capsule',{...claimed.binding,capsule_id:claimed.development.capsule.id}));
  active.setTime(7200001);assert.equal(active.call(claimed.id,'read_capsule',{...claimed.binding,capsule_id:claimed.development.capsule.id}).ok,false);
});
test('pre-deployment failure retains production and a published request cannot be demoted',()=>{
  const r=runtime(),s=r.releaseSetup();
  assert.equal(r.call(s.id,'deployment_failed',{...s.binding,kind:'production',before_deployment:false}).ok,false);
  r.success(r.call(s.id,'deployment_failed',{...s.binding,kind:'production',before_deployment:true}));
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,s.production.capsule.id);
  const done=runtime(),published=done.productionPrepared(done.releaseSetup(),true);
  assert.equal(done.call(published.id,'deployment_failed',{...published.binding,kind:'production',before_deployment:true}).ok,false);
});
test('public matching receipt reconciles a lost success callback after expiry without a build hook',()=>{
  const r=runtime(),s=r.productionPrepared(r.releaseSetup());r.setTime(7200001);
  r.setPublicReceipt(s.completed.receipt);r.context.registryReleaseStoreReconcileProduction_();
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,s.prepared.capsule.id);
  assert.equal(r.context.registryReleaseStoreGetRequest_(s.binding.request_id).phase,'succeeded');
});
test('legacy verified:false is accepted only by the exact one-time production bootstrap',()=>{
  const r=runtime(), id=identity('production','1'), prepared=r.prepare('production',id);
  r.values.set('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY',id.deploy_id); r.values.set('AIS_RELEASE_BOOTSTRAP_UPLOADER',JSON.stringify(id));
  r.upload(id,prepared); r.success(r.call(id,'deployment_succeeded',{kind:'production',capsule_id:prepared.capsule.id,receipt:r.receipt(id,'production',{verified:false})}));
  assert.equal(r.context.registryReleaseStoreGetActive_('production').receipt.verified,false);
});
test('preview pre-deployment failure closes only its matching pending preview request',()=>{
  const r=runtime(), id=identity('preview','2'), data={kind:'preview',request_id:'preview-request',before_deployment:true};
  assert.equal(r.call(id,'deployment_failed',{...data,request_id:'wrong-request'}).ok,false);
  r.success(r.call(id,'deployment_failed',data)); assert.equal(r.context.previewState_().phase,'failed');
  assert.equal(r.context.registryReleaseStoreGetActive_('production'),null);
  const done=runtime(); done.previewReady(); assert.equal(done.call(id,'deployment_failed',data).ok,false);
});
test('a full 8 MiB chunk fits the signed envelope and base64 validation does not overflow the regex stack',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=pack(new Map([['payload.bin',crypto.randomBytes(8388608+512)]]),
    {kind:'preview',...id,...binding,registry_revision:'sha256:'+'d'.repeat(64)});
  assert.equal(prepared.chunks[0].length,8388608);
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  r.success(r.call(id,'put_chunk',{...binding,capsule_id:prepared.capsule.id,index:0,
    sha256:prepared.capsule.chunks[0].sha256,base64:prepared.chunks[0].toString('base64')}));
  assert.equal([...r.files.values()].find(f=>f.name.startsWith('chunk-'+prepared.capsule.id+'-0-')).getSize(),8388608);
});
test('duplicate concurrent chunk uploads commit one canonical file without losing either response',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=r.prepare('preview',id,binding,{registry_revision:'sha256:'+'d'.repeat(64)});
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  const data={...binding,capsule_id:prepared.capsule.id,index:0,sha256:prepared.capsule.chunks[0].sha256,base64:prepared.chunks[0].toString('base64')};
  let simultaneous;
  r.onChunkCreate(()=>{simultaneous=r.call(id,'put_chunk',data);r.success(simultaneous);});
  r.success(r.call(id,'put_chunk',data));
  const chunks=[...r.files.values()].filter(f=>f.name.startsWith('chunk-'+prepared.capsule.id+'-0-'));
  assert.equal(chunks.length,2);assert.equal(chunks.filter(f=>!f.trashed).length,1);
  const status=r.success(r.call(id,'upload_status',{...binding,capsule_id:prepared.capsule.id}));
  assert.deepEqual(status.uploaded_indices,[0]);assert.equal(status.complete,false);
  r.success(r.call(id,'complete_capsule',{...binding,capsule_id:prepared.capsule.id}));
  assert.equal(r.success(r.call(id,'upload_status',{...binding,capsule_id:prepared.capsule.id})).complete,true);
});
test('request changes during byte upload are rechecked before committing the chunk',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=r.prepare('preview',id,binding,{registry_revision:'sha256:'+'d'.repeat(64)});
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  r.onChunkCreate(()=>r.setPreview({phase:'accepted',request_id:'new-preview-request',revision:'sha256:'+'e'.repeat(64)}));
  const result=r.call(id,'put_chunk',{...binding,capsule_id:prepared.capsule.id,index:0,sha256:prepared.capsule.chunks[0].sha256,base64:prepared.chunks[0].toString('base64')});
  assert.equal(result.ok,false);assert.match(result.error,/request identity/);
  assert.deepEqual(r.success(r.call(id,'upload_status',{...binding,capsule_id:prepared.capsule.id})).uploaded_indices,[]);
});
test('a busy metadata commit preserves uncertain files and upload_status distinguishes committed progress',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=r.prepare('preview',id,binding,{registry_revision:'sha256:'+'d'.repeat(64)});
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  const data={...binding,capsule_id:prepared.capsule.id,index:0,sha256:prepared.capsule.chunks[0].sha256,base64:prepared.chunks[0].toString('base64')};
  r.onChunkCreate(()=>r.failNextLocks(1));const result=r.call(id,'put_chunk',data);
  assert.equal(result.code,'release_busy');assert.equal(result.retryable,true);
  assert.deepEqual(r.success(r.call(id,'upload_status',{...binding,capsule_id:prepared.capsule.id})).uploaded_indices,[]);
  r.success(r.call(id,'put_chunk',data));
  assert.deepEqual(r.success(r.call(id,'upload_status',{...binding,capsule_id:prepared.capsule.id})).uploaded_indices,[0]);
});
test('completion rejects a request invalidated during out-of-lock durable file checks',()=>{
  const r=runtime(), id=identity('preview','2'), binding={request_id:'preview-request'};
  const prepared=r.prepare('preview',id,binding,{registry_revision:'sha256:'+'d'.repeat(64)});
  r.success(r.call(id,'begin_capsule',{...binding,capsule:prepared.capsule}));
  r.success(r.call(id,'put_chunk',{...binding,capsule_id:prepared.capsule.id,index:0,sha256:prepared.capsule.chunks[0].sha256,base64:prepared.chunks[0].toString('base64')}));
  r.onChunkSize(()=>r.setPreview({phase:'failed',request_id:binding.request_id,revision:'sha256:'+'d'.repeat(64)}));
  assert.equal(r.call(id,'complete_capsule',{...binding,capsule_id:prepared.capsule.id}).ok,false);
  assert.equal(r.context.registryReleaseStoreGetCapsule_(prepared.capsule.id).complete,false);
});
test('upload_status is owner-bound and reports completed bootstrap after one-time authorization closes',()=>{
  const r=runtime(), setup=r.bootstrap();
  const status=r.success(r.call(setup.id,'upload_status',{capsule_id:setup.capsule.id}));
  assert.equal(status.complete,true);assert.deepEqual(status.uploaded_indices,[0]);
  assert.equal(r.call(identity('production','9'),'upload_status',{capsule_id:setup.capsule.id}).ok,false);
  assert.equal(r.call(setup.id,'upload_status',{capsule_id:setup.capsule.id,request_id:'foreign-request'}).ok,false);
});
