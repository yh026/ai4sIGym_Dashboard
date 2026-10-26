'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pack, unpack, hash, CHUNK_SIZE, readDirectory, writeDirectory } = require('./capsule.cjs');
const { validateHook, DOMAIN, SITE_ID, confirmationDigest } = require('./hook.cjs');
const { createClient } = require('./client.cjs');
const { productionBuild, artifactDigest, capsuleSource } = require('./build.cjs');
const { exportSuccessfulBuild, reportFailedBuild, stagePreviewBuild } = require('./plugin.cjs');
const NOW = '2026-10-08T08:00:00.000Z';
const secret = 'test-signing-key-never-used-outside-tests-123456';
const env = () => ({ NETLIFY: 'true', SITE_ID, BRANCH: 'main', CONTEXT: 'production',
  COMMIT_REF: 'a'.repeat(40), BUILD_ID: 'build-test', DEPLOY_ID: 'b'.repeat(24),
  AI4S_PREVIEW_CALLBACK_SECRET: secret, REGISTRY_URL: 'https://script.google.com/macros/s/test/exec?token=fake' });
const request = () => ({ schema: 2, target: 'production', site_id: SITE_ID, branch: 'main',
  review_id: 'review-123456', request_id: 'request-123456', requested_at: NOW,
  expires_at: '2026-10-08T08:30:00.000Z', preview_capsule_id: 'preview-123456',
  confirmation_digest: 'sha256:' + 'c'.repeat(64), baseline_deploy_id: 'd'.repeat(24) });
const sign = value => { const payload = JSON.stringify(value); return JSON.stringify({ payload,
  signature: crypto.createHmac('sha256', secret).update(DOMAIN + payload).digest('hex') }); };
const manifest = () => ({ schema_version: 3, taxonomy: {}, demos: [] });
const candidateFiles = () => new Map([
  ['index.html', Buffer.from('<h1>Reviewed content</h1>')],
  ['manifest.json', Buffer.from(JSON.stringify(manifest()))],
  ['deploy-receipt.json', Buffer.from(JSON.stringify({ schema: 1, target: 'production', audience: 'production',
    platform: 'netlify', baseline_deploy_id: 'd'.repeat(24), publication_overrides: [], projects: [] }))],
]);

test('capsule roundtrip retains every byte and chunks oversized compressed artifacts', () => {
  const files = new Map([['index.html', Buffer.from('hello')], ['assets/random.bin', crypto.randomBytes(CHUNK_SIZE + 1000)]]);
  const prepared = pack(files, { kind: 'candidate' });
  assert.equal(prepared.chunks.length, 2);
  assert.deepEqual(unpack(prepared.capsule, prepared.chunks), files);
});
test('capsule rejects chunk corruption, altered metadata, unsafe and colliding paths', () => {
  const prepared = pack(new Map([['index.html', Buffer.from('hello')]]), { kind: 'candidate' });
  const damaged = Buffer.from(prepared.chunks[0]); damaged[5] ^= 1;
  assert.throws(() => unpack(prepared.capsule, [damaged]), /chunk mismatch/);
  assert.throws(() => unpack({ ...prepared.capsule, provenance: { kind: 'production' } }, prepared.chunks), /identity/);
  for (const name of ['../secret', '/absolute', 'a//b', 'a/./b']) assert.throws(() => pack(new Map([[name, Buffer.from('x')]]), {}), /unsafe/);
  assert.throws(() => pack(new Map([['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]), {}), /collision/);
});
test('production only accepts signed current manual request with exact environment identity', () => {
  const e = env(); e.INCOMING_HOOK_BODY = sign(request());
  assert.equal(validateHook(e, 'production', Date.parse(NOW)).request_id, request().request_id);
  assert.equal(validateHook({ ...e, INCOMING_HOOK_BODY: encodeURIComponent(e.INCOMING_HOOK_BODY) }, 'production', Date.parse(NOW)).review_id, request().review_id);
  for (const change of [{ INCOMING_HOOK_BODY: '' }, { BRANCH: 'develop' }, { CONTEXT: 'branch-deploy' }, { NETLIFY: 'false' }, { SITE_ID: 'wrong' }]) {
    assert.throws(() => validateHook({ ...e, ...change }, 'production', Date.parse(NOW)));
  }
  assert.throws(() => validateHook({ ...e, INCOMING_HOOK_BODY: JSON.stringify({ payload: '{}', signature: '0'.repeat(64) }) }, 'production', Date.parse(NOW)), /signature/);
  for (const changed of [{ ...request(), expires_at: NOW }, { ...request(), requested_at: '2026-10-09T08:00:00.000Z' },
    { ...request(), target: 'production-review' }, { ...request(), confirmation_digest: '' }, { ...request(), schema: 1 }]) {
    assert.throws(() => validateHook({ ...e, INCOMING_HOOK_BODY: sign(changed) }, 'production', Date.parse(NOW)));
  }
});
test('non-main branches cannot render or claim a production release',()=>{
  for(const branch of ['develop','feature/review']){
    const e={...env(),BRANCH:branch,CONTEXT:'branch-deploy',INCOMING_HOOK_BODY:sign({...request(),branch})};
    assert.throws(()=>validateHook(e,'production',Date.parse(NOW)),/context/);
  }
});
test('unsigned production stops before network calls or any output mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-nohook-')); const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'existing'), 'unchanged');
  let calls = 0;
  try {
    await assert.rejects(productionBuild({ env: env(), client: { call() { calls++; } }, checkout: dir, now: NOW }), /manual publishing request/);
    assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(dist, 'existing'), 'utf8'), 'unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function publicationFixture() {
  const {source,root,policies}=require('../production-release/artifact-fixture.cjs');
  const {rendererDigest}=require('../production-release/catalog-renderer.cjs');
  const {deploymentSnapshot}=require('../production-release/artifact-renderer.cjs');
  const sources={};
  for(const kind of ['production','preview']){
    const original=source(kind),files=new Map(original.files),receipt=JSON.parse(files.get('deploy-receipt.json'));
    Object.assign(receipt,{build_id:'source-build-'+kind,renderer_digest:rendererDigest(root),request_id:'preview-request-1234'});
    files.set('deploy-receipt.json',Buffer.from(JSON.stringify(receipt)));
    const provenance={kind,...Object.fromEntries(['site_id','build_id','deploy_id','commit_ref','branch','context'].map(k=>[k,receipt[k]])),
      renderer_digest:receipt.renderer_digest,...(kind==='preview'?{registry_revision:receipt.registry_revision,request_id:receipt.request_id}:{})};
    const prepared=pack(files,provenance);
    sources[kind]={capsule:prepared.capsule,files};
  }
  const preview=capsuleSource(sources.preview,'preview'),baseline=capsuleSource(sources.production,'production');
  const catalog=preview.manifest.demos.map(d=>({demo_id:d.demo_id,slug:d.slug}));
  const review={schema:2,id:request().review_id,site_id:SITE_ID,created_at:NOW,expires_at:'2026-10-08T08:30:00.000Z',
    selection:catalog.map(d=>({demo_id:d.demo_id,include_in_production:true,include_in_preview:true})),catalog,
    baseline_capsule_id:sources.production.capsule.id,preview_capsule_id:sources.preview.capsule.id,
    baseline_deploy_id:baseline.metadata.id,preview_deploy_id:preview.metadata.id,renderer_digest:rendererDigest(root),changes:[]};
  const r={...request(),baseline_deploy_id:review.baseline_deploy_id,preview_capsule_id:review.preview_capsule_id,
    confirmation_digest:confirmationDigest(review)};
  const calls=[];let stored;
  const client={async call(action,data){calls.push(action);if(action==='claim_production')return {release:{id:r.request_id},review};
    assert.equal(action,'production_prepared');assert.equal(data.capsule_id,stored.capsule.id);
    assert.equal(data.artifact_digest,stored.capsule.provenance.artifact_digest);return {prepared:true};},
    async download(id){calls.push('download');const result=Object.values(sources).find(s=>s.capsule.id===id);assert.ok(result);return result;},
    async upload(value){calls.push('upload');stored=value;}};
  return {root,sources,review,r,calls,client,stored:()=>stored};
}
test('production renders pinned develop bytes, preserves publication policies and stages before writing dist',async()=>{
  const f=publicationFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'develop-promotion-'));
  try{
    const e={...env(),INCOMING_HOOK_BODY:sign(f.r)};
    await productionBuild({env:e,client:f.client,checkout:dir,rendererCheckout:f.root,now:NOW});
    assert.deepEqual(f.calls,['claim_production','download','download','upload','production_prepared']);
    const built=readDirectory(path.join(dir,'dist')),receipt=JSON.parse(built.get('deploy-receipt.json'));
    assert.equal(receipt.publication_method,'develop-promotion');assert.equal(receipt.confirmation_digest,f.r.confirmation_digest);
    assert.deepEqual(built.get('demos/a/index.html'),f.sources.preview.files.get('demos/a/index.html'));
    assert.deepEqual(built.get('assets/intro-video.mp4'),f.sources.production.files.get('assets/intro-video.mp4'));
    assert.equal(built.has('demos/tbb-cluster-explorer-2/resources/notebook.ipynb'),false);
    assert.equal(capsuleSource({capsule:f.stored().capsule,files:built},'production').metadata.id,e.DEPLOY_ID);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('changed confirmed inputs, source identity or renderer are rejected before output mutation',async()=>{
  for(const mutate of [f=>f.review.selection[0].include_in_production=false,
    f=>f.sources.preview.capsule.provenance.deploy_id='9'.repeat(24),f=>f.sources.preview.capsule.provenance.renderer_digest='sha256:'+'9'.repeat(64)]){
    const f=publicationFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'develop-reject-'));mutate(f);
    try{await assert.rejects(productionBuild({env:{...env(),INCOMING_HOOK_BODY:sign(f.r)},client:f.client,checkout:dir,rendererCheckout:f.root,now:NOW}),/differ/);
      assert.equal(fs.existsSync(path.join(dir,'dist')),false);assert.equal(f.stored(),undefined);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});
test('server rejection after upload preserves existing output and never reports publication success',async()=>{
  const f=publicationFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'develop-preflight-'));
  fs.mkdirSync(path.join(dir,'dist'));fs.writeFileSync(path.join(dir,'dist','existing'),'unchanged');
  const original=f.client.call;f.client.call=async(a,d)=>{if(a==='production_prepared')throw Error('Selection changed');return original(a,d);};
  try{await assert.rejects(productionBuild({env:{...env(),INCOMING_HOOK_BODY:sign(f.r)},client:f.client,checkout:dir,rendererCheckout:f.root,now:NOW}),/Selection changed/);
    assert.equal(fs.readFileSync(path.join(dir,'dist','existing'),'utf8'),'unchanged');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('client signs each bounded request and does not retry uncertain responses', async () => {
  let calls = 0;
  const client = createClient({ env: env(), now: () => NOW, fetchImpl: async (url, options) => {
    calls++; const body = JSON.parse(options.body), parsed = JSON.parse(body.payload);
    assert.equal(parsed.action, 'claim_production'); assert.equal(parsed.sent_at, NOW);
    assert.equal(body.signature, crypto.createHmac('sha256', secret).update('ais-manual-release-api-v1\n' + body.payload).digest('hex'));
    assert.equal(url.searchParams.get('action'), 'manual_release'); throw new Error('uncertain');
  } });
  await assert.rejects(client.call('claim_production'), /not confirmed/); assert.equal(calls, 1);
});
test('nonmanual preview never exports a publishable capsule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-preview-'));
  const e = { ...env(), BRANCH: 'develop', CONTEXT: 'branch-deploy' };
  fs.writeFileSync(path.join(dir, 'deploy-receipt.json'), JSON.stringify({ schema: 1, target: 'preview', audience: 'preview', verified: false,
    site_id: e.SITE_ID, build_id: e.BUILD_ID, deploy_id: e.DEPLOY_ID, commit_ref: e.COMMIT_REF, branch: e.BRANCH, context: e.CONTEXT }));
  try { assert.equal((await exportSuccessfulBuild({ env: e, publishDir: dir })).reason, 'not-manual-preview'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('failure callback is signed-request-bound and never sends raw build errors', async () => {
  const calls = [], e = { ...env(), INCOMING_HOOK_BODY: sign(request()) };
  const client = { async call(action, data) { calls.push({ action, data }); } };
  assert.equal((await reportFailedBuild({ env: e, client, now: Date.parse(NOW), beforeDeployment: true })).sent, true);
  assert.equal(calls[0].action, 'deployment_failed'); assert.equal(calls[0].data.kind, 'production');
  assert.equal(calls[0].data.request_id, request().request_id);
  assert.equal(calls[0].data.before_deployment, true);
  assert.equal((await reportFailedBuild({ env: env(), client, now: Date.parse(NOW), beforeDeployment: true })).sent, false);
  assert.equal((await reportFailedBuild({ env: e, client, now: Date.parse(NOW), beforeDeployment: false })).sent, false);
  assert.equal(calls.length, 1);
});
test('expired request can report its failure but can never publish', () => {
  const e = { ...env(), INCOMING_HOOK_BODY: sign(request()) }, late = Date.parse(NOW) + 45 * 60000;
  assert.throws(() => validateHook(e, 'production', late), /expired/);
  assert.equal(validateHook(e, 'production', late, { failureReport: true }).request_id, request().request_id);
  assert.throws(() => validateHook(e, 'production', late + 120 * 60000, { failureReport: true }), /expired/);
});

test('Preview stages exact bytes and verified project metadata without invoking publication',async()=>{
  const f=publicationFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-stage-'));
  let uploaded;
  try{
    for(const name of ['build.js','site/map-regions.js','site/template.html','site/domain-template.html','site/styles.css','site/app.js']){
      fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.copyFileSync(path.join(f.root,name),path.join(dir,name));
    }
    const files=f.sources.preview.files,publishDir=path.join(dir,'dist');writeDirectory(files,publishDir);
    const proof=f.sources.preview.capsule.provenance,e={NETLIFY:'true',SITE_ID:proof.site_id,BUILD_ID:proof.build_id,
      DEPLOY_ID:proof.deploy_id,COMMIT_REF:proof.commit_ref,BRANCH:'develop',CONTEXT:'branch-deploy'};
    await stagePreviewBuild({env:e,checkout:dir,publishDir,client:{async upload(p){uploaded=p;return p.capsule.id;}}});
    const saved=unpack(uploaded.capsule,uploaded.chunks),receipt=JSON.parse(saved.get('deploy-receipt.json'));
    assert.equal(receipt.renderer_digest,f.review.renderer_digest);
    assert.deepEqual(saved.get('demos/a/index.html'),files.get('demos/a/index.html'));
    assert.equal(uploaded.capsule.provenance.project_snapshots.standard.length,3);
    const snapshots=uploaded.capsule.provenance.project_snapshots;
    assert.notEqual(snapshots.standard[0].content_digest,snapshots.without_tbb_resources[0].content_digest);
    assert.deepEqual(saved.get('deploy-receipt.json'),fs.readFileSync(path.join(publishDir,'deploy-receipt.json')));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
