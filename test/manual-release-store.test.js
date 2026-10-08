'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pack, unpack, hash, stable } = require('../google-apps-script/publishing-controls/manual-release/capsule.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../google-apps-script/publishing-controls/manual-release/ManualReleaseStore.gs'), 'utf8');
const SITE = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973', SECRET = 'test-only-signing-secret-not-a-real-credential';
const NOW = Date.parse('2026-10-08T04:00:00.000Z');
const iso = delta => new Date(NOW + delta).toISOString();
const identity = (kind, digit) => ({ site_id: SITE, build_id: digit.repeat(24), deploy_id: digit.repeat(24),
  commit_ref: 'c'.repeat(40), branch: kind === 'preview' ? 'develop' : kind === 'review' ? 'codex/manual-production-review' : 'main',
  context: kind === 'production' ? 'production' : 'branch-deploy' });

function runtime() {
  let time = NOW, next = 0;
  const values = new Map([['AIS_RELEASE_ROOT_FOLDER_ID','root-folder'], ['AI4S_PREVIEW_CALLBACK_SECRET',SECRET]]), files = new Map();
  const blob = (value, type, name) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : value || []);
    return { bytes, name, getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8') }; };
  class File {
    constructor(b) { this.id = 'file-' + (++next); this.name = b.name; this.bytes = Buffer.from(b.bytes); this.trashed = false; }
    getId() { return this.id; } getSize() { return this.bytes.length; } isTrashed() { return this.trashed; }
    getBlob() { return blob(this.bytes); } setContent(value) { this.bytes = Buffer.from(value); return this; }
  }
  const root = { getFilesByName(name) { const matches = [...files.values()].filter(f => f.name === name && !f.trashed); let cursor = 0;
    return { hasNext: () => cursor < matches.length, next: () => matches[cursor++] }; },
  createFile(b) { const file = new File(b); files.set(file.id,file); return file; } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const props = { getProperty: key => values.get(key) || null, setProperty(key,value) { values.set(key,value); return this; }, deleteProperty: key => values.delete(key) };
  let preview = { phase:'accepted',request_id:'preview-request',revision:'sha256:'+'d'.repeat(64) }, publicReceipt = null;
  const context = vm.createContext({ console, Date: Clock, SANDBOX: {site_id:SITE},
    PropertiesService:{getScriptProperties:()=>props}, DriveApp:{getFolderById:()=>root,getFileById:id=>{
      if (!files.has(id)) throw new Error('Injected missing Drive object token=DO_NOT_LEAK'); return files.get(id); }},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},newBlob:blob,computeDigest:(algorithm,value)=>[...crypto.createHash('sha256').update(Buffer.from(value)).digest()],
      computeHmacSha256Signature:(value,key)=>[...crypto.createHmac('sha256',key).update(value).digest()],
      base64Decode:value=>[...Buffer.from(value,'base64')],base64Encode:value=>Buffer.from(value).toString('base64')},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>publicReceipt?200:404,getContentText:()=>JSON.stringify(publicReceipt)})},
    safeEqual_:(a,b)=>a===b, locked_:fn=>fn(), json_:value=>JSON.parse(JSON.stringify(value)), previewState_:()=>preview,
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
    const prepared=prepare('preview',id,binding,{registry_revision:preview.revision}); upload(id,prepared,binding);
    preview={...preview,phase:'ready',deploy_id:id.deploy_id};
    success(call(id,'deployment_succeeded',{...binding,kind:'preview',capsule_id:prepared.capsule.id,
      receipt:receipt(id,'preview',{...binding,revision_bound:true,registry_revision:preview.revision})}));
    return {id,capsule:prepared.capsule};
  }
  function reviewSetup() {
    const production=bootstrap(), development=previewReady(), id=identity('review','3');
    const review={id:'review-000001',schema:1,created_at:iso(0),expires_at:iso(7200000),site_id:SITE,
      selection:[{demo_id:'demo-one',include_in_production:true,include_in_preview:true}],catalog:[{demo_id:'demo-one',title:'One',number:'001',slug:'one'}],
      baseline_capsule_id:production.capsule.id,preview_capsule_id:development.capsule.id,baseline_deploy_id:production.id.deploy_id,
      preview_deploy_id:development.id.deploy_id,renderer_digest:'sha256:'+'e'.repeat(64),phase:'requested',request_id:'review-request'};
    context.registryReleaseStoreCreateReview_(review);
    context.registryReleaseStoreCreateRequest_({id:review.request_id,kind:'review',review_id:review.id,created_at:iso(0),expires_at:iso(7200000),
      branch:id.branch,target:'production-review',phase:'requested',baseline_deploy_id:review.baseline_deploy_id});
    const binding={request_id:review.request_id,review_id:review.id}; success(call(id,'claim_review',binding));
    return {production,development,id,review,binding};
  }
  function candidateReady(setup, finish=true) {
    const {id,review,binding}=setup;
    const digest='sha256:'+hash(stable([{path:'index.html',size:28,sha256:'unused'}]));
    // Packing includes the digest in provenance, while the artifact inventory covers only files.
    const first=prepare('candidate',id,binding,{renderer_digest:review.renderer_digest,artifact_digest:digest});
    const prepared=prepare('candidate',id,binding,{renderer_digest:review.renderer_digest,artifact_digest:first.capsule.inventory_digest});
    upload(id,prepared,binding);
    const projects=[{demo_id:'demo-one',slug:'one',source_environment:'preview',source_deploy_id:review.preview_deploy_id,content_digest:'sha256:'+'f'.repeat(64),action:'update'}];
    const body={schema:1,target:'production',site_id:SITE,created_at:iso(0),expires_at:iso(1800000),baseline:{deploy_id:review.baseline_deploy_id},
      reviewed_preview:{deploy_id:review.preview_deploy_id},projects,removals:[],publication:{required_overrides:[],omit_notebook_downloads:false,preserve_homepage_introduction:false}};
    const plan={...body,intent_digest:'sha256:'+hash(stable(body))};
    const evidence={projects,preserved_overrides:[],catalog_pages_regenerated:true,source_files_unchanged:true,unselected_routes_absent:true,renderer_digest:review.renderer_digest};
    const data={...binding,capsule_id:prepared.capsule.id,artifact_digest:prepared.capsule.inventory_digest,plan,renderer_evidence:evidence};
    success(call(id,'candidate_ready',data));
    if (finish) success(call(id,'deployment_succeeded',{...binding,kind:'review',capsule_id:prepared.capsule.id,
      receipt:receipt(id,'production-review',{...binding,artifact_digest:data.artifact_digest})}));
    return {...setup,prepared,data};
  }
  return {context,call,success,prepare,upload,receipt,bootstrap,previewReady,reviewSetup,candidateReady,files,values,
    setTime:delta=>{time=NOW+delta;},setPreview:value=>{preview=value;},setPublicReceipt:value=>{publicReceipt=value;}};
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
  for (const options of [{secret:'wrong'},{domain:'wrong\n'},{sent_at:iso(-900001)}]) assert.equal(r.call(id,'claim_review',{},options).ok,false);
  assert.equal(r.call({...id,site_id:'other'},'claim_review').ok,false); assert.equal(r.files.size,0);
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
test('claimed review is idempotent for one build and rejects another build',()=>{
  const r=runtime(), setup=r.reviewSetup(); r.success(r.call(setup.id,'claim_review',setup.binding));
  assert.match(r.call(identity('review','9'),'claim_review',setup.binding).error,/build identity/);
});
test('a signed ordinary main build has no access to active capsule bytes',()=>{
  const r=runtime(), base=r.bootstrap(); assert.equal(r.call(identity('production','5'),'read_capsule',{capsule_id:base.capsule.id}).ok,false);
});
test('a review reads only its pinned sources and exact immutable provenance survives unpacking',()=>{
  const r=runtime(), setup=r.reviewSetup(), capsuleId=setup.development.capsule.id;
  const descriptor=r.success(r.call(setup.id,'read_capsule',{...setup.binding,capsule_id:capsuleId})).capsule;
  const chunk=r.success(r.call(setup.id,'read_chunk',{...setup.binding,capsule_id:capsuleId,index:0}));
  assert.equal(unpack(descriptor,[Buffer.from(chunk.base64,'base64')]).get('index.html').toString(),'<p>Immutable preview</p>');
  assert.equal(r.call(setup.id,'read_capsule',{...setup.binding,capsule_id:'unknown-capsule'}).ok,false);
});
test('read detects post-upload Drive chunk tampering',()=>{
  const r=runtime(), setup=r.reviewSetup();
  [...r.files.values()].find(f=>f.name==='chunk-'+setup.development.capsule.id+'-0.bin').bytes=Buffer.from('changed');
  assert.match(r.call(setup.id,'read_chunk',{...setup.binding,capsule_id:setup.development.capsule.id,index:0}).error,/checksum/);
});
test('candidate success changes review state without activating production',()=>{
  const r=runtime(), setup=r.candidateReady(r.reviewSetup());
  assert.equal(r.context.registryReleaseStoreGetReview_(setup.review.id).phase,'ready');
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,setup.production.capsule.id);
  assert.equal(r.values.has('AIS_RELEASE_ACTIVE_REQUEST_ID'),false);
});
test('ready candidate cannot be silently replaced and release plan mutation is detected',()=>{
  const r=runtime(), setup=r.reviewSetup(); const ready=r.candidateReady(setup,false);
  const changed={...ready.data,plan:{...ready.data.plan,removals:[{demo_id:'demo-one'}]}};
  assert.match(r.call(setup.id,'candidate_ready',changed).error,/evidence does not match/);
  const replacement=r.prepare('candidate',setup.id,setup.binding,{renderer_digest:setup.review.renderer_digest,artifact_digest:ready.data.artifact_digest});
  r.upload(setup.id,replacement,setup.binding);
  assert.match(r.call(setup.id,'candidate_ready',{...ready.data,capsule_id:replacement.capsule.id}).error,/candidate is immutable/);
});
test('production requires a server-created explicit request and the unchanged baseline',()=>{
  const r=runtime(), setup=r.candidateReady(r.reviewSetup()), id=identity('production','4');
  const claim={review_id:setup.review.id,request_id:'production-request',candidate_capsule_id:setup.prepared.capsule.id,
    artifact_digest:setup.data.artifact_digest,baseline_deploy_id:setup.review.baseline_deploy_id};
  assert.equal(r.call(id,'claim_production',claim).ok,false);
  r.context.registryReleaseStoreCreateRequest_({id:claim.request_id,kind:'production',review_id:claim.review_id,created_at:iso(0),expires_at:iso(900000),
    branch:'main',target:'production',phase:'requested',baseline_deploy_id:claim.baseline_deploy_id,
    candidate_capsule_id:claim.candidate_capsule_id,artifact_digest:claim.artifact_digest});
  r.values.set('AIS_RELEASE_ACTIVE_REQUEST_ID',claim.request_id);
  assert.equal(r.call(id,'claim_production',{...claim,baseline_deploy_id:'9'.repeat(24)}).ok,false);
  r.success(r.call(id,'claim_production',claim));
  const binding={request_id:claim.request_id,review_id:claim.review_id}, prepared=r.prepare('production',id,binding,{artifact_digest:claim.artifact_digest});
  r.upload(id,prepared,binding);
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,setup.production.capsule.id);
  r.success(r.call(id,'deployment_succeeded',{...binding,kind:'production',capsule_id:prepared.capsule.id,
    receipt:r.receipt(id,'production',{...binding,reviewed_artifact_digest:claim.artifact_digest})}));
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,prepared.capsule.id);
});
test('request expiry blocks new claims but allows already claimed builds to finish within two hours',()=>{
  const r=runtime(), setup=r.reviewSetup(); r.setTime(3600000);
  r.success(r.call(setup.id,'read_capsule',{...setup.binding,capsule_id:setup.development.capsule.id}));
  r.setTime(7200001);
  assert.equal(r.call(setup.id,'claim_review',setup.binding).ok,false);
  assert.equal(r.call(setup.id,'read_capsule',{...setup.binding,capsule_id:setup.development.capsule.id}).ok,false);
});
test('immutable review fields cannot be changed by UI saves and Drive errors are redacted',()=>{
  const r=runtime(), setup=r.reviewSetup(), review=r.context.registryReleaseStoreGetReview_(setup.review.id);
  assert.throws(()=>r.context.registryReleaseStoreSaveReview_({...review,baseline_deploy_id:'9'.repeat(24)}),/identity changed/);
  const file=[...r.files.values()].find(f=>f.name==='chunk-'+setup.development.capsule.id+'-0.bin'); r.files.delete(file.id);
  const result=r.call(setup.id,'read_chunk',{...setup.binding,capsule_id:setup.development.capsule.id,index:0});
  assert.equal(result.ok,false); assert.equal(result.error.includes('DO_NOT_LEAK'),false);
});

function pendingProduction(r) {
  const setup=r.candidateReady(r.reviewSetup()), id=identity('production','4');
  const claim={review_id:setup.review.id,request_id:'production-request',candidate_capsule_id:setup.prepared.capsule.id,
    artifact_digest:setup.data.artifact_digest,baseline_deploy_id:setup.review.baseline_deploy_id};
  r.context.registryReleaseStoreCreateRequest_({id:claim.request_id,kind:'production',review_id:claim.review_id,created_at:iso(0),expires_at:iso(900000),
    branch:'main',target:'production',phase:'requested',baseline_deploy_id:claim.baseline_deploy_id,
    candidate_capsule_id:claim.candidate_capsule_id,artifact_digest:claim.artifact_digest});
  r.values.set('AIS_RELEASE_ACTIVE_REQUEST_ID',claim.request_id); r.success(r.call(id,'claim_production',claim));
  const binding={request_id:claim.request_id,review_id:claim.review_id};
  const prepared=r.prepare('production',id,binding,{artifact_digest:claim.artifact_digest}); r.upload(id,prepared,binding);
  const receipt=r.receipt(id,'production',{...binding,reviewed_artifact_digest:claim.artifact_digest});
  return {...setup,id,claim,binding,output:prepared,receipt};
}
test('a genuine bound pre-deployment failure closes the request without changing production',()=>{
  const r=runtime(), setup=pendingProduction(r);
  assert.equal(r.call(setup.id,'deployment_failed',{...setup.binding,kind:'production'}).ok,false);
  assert.equal(r.call(identity('production','9'),'deployment_failed',{...setup.binding,kind:'production',before_deployment:true}).ok,false);
  r.success(r.call(setup.id,'deployment_failed',{...setup.binding,kind:'production',before_deployment:true,error:'SECRET=do-not-store'}));
  const record=r.context.registryReleaseStoreGetRequest_(setup.claim.request_id);
  assert.equal(record.phase,'failed'); assert.equal(record.error.includes('SECRET'),false);
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,setup.production.capsule.id);
});
test('production output is pinned and cannot be replaced by another capsule in the same request',()=>{
  const r=runtime(), setup=pendingProduction(r);
  assert.equal(r.context.registryReleaseStoreGetRequest_(setup.claim.request_id).production_capsule_id,setup.output.capsule.id);
  const replacement=r.prepare('production',setup.id,setup.binding,{artifact_digest:setup.claim.artifact_digest});
  assert.match(r.call(setup.id,'begin_capsule',{...setup.binding,capsule:replacement.capsule}).error,/already pinned/);
});
test('public matching receipt reconciles a lost callback after expiry without a build hook',()=>{
  const r=runtime(), setup=pendingProduction(r); r.setTime(10800000);
  assert.equal(r.call(setup.id,'deployment_succeeded',{...setup.binding,kind:'production',capsule_id:setup.output.capsule.id,receipt:setup.receipt}).ok,false);
  assert.equal(r.context.registryReleaseStoreReconcileProduction_(),null);
  r.setPublicReceipt({...setup.receipt,deploy_id:'9'.repeat(24)}); assert.equal(r.context.registryReleaseStoreReconcileProduction_(),null);
  r.setPublicReceipt(setup.receipt); const result=r.context.registryReleaseStoreReconcileProduction_(); assert.equal(result.activated,true);
  assert.equal(r.context.registryReleaseStoreGetActive_('production').id,setup.output.capsule.id);
  assert.equal(r.context.registryReleaseStoreGetRequest_(setup.claim.request_id).phase,'succeeded');
});
test('a post-success failure cannot demote the published request',()=>{
  const r=runtime(), setup=pendingProduction(r);
  r.success(r.call(setup.id,'deployment_succeeded',{...setup.binding,kind:'production',capsule_id:setup.output.capsule.id,receipt:setup.receipt}));
  assert.equal(r.call(setup.id,'deployment_failed',{...setup.binding,kind:'production',before_deployment:true}).ok,false);
  assert.equal(r.context.registryReleaseStoreGetRequest_(setup.claim.request_id).phase,'succeeded');
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
  assert.equal([...r.files.values()].find(f=>f.name==='chunk-'+prepared.capsule.id+'-0.bin').getSize(),8388608);
});
