'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {compileRegistryV3,authorizedFile,assertSandbox,FORBIDDEN_ROOT,FORBIDDEN_SHEET}=require('../lib/registry-v3');
const {validateManifest,loadV3Registry}=require('../lib/registry-v3-client');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const html='<!doctype html><html><head><title>Result</title></head><body><script>window.result=42</script><main>Core result</main></body></html>';
function input(){
  const data={environment:'sandbox',registry_instance:'test-registry',spreadsheet_id:'test-sheet',drive_root_id:'test-root',branch:'develop',audience:'preview',taxonomy:{},projects:[],versions:[],pages:[],resources:[]};
  for(const slug of ['battery-a','battery-b']){
    const version=slug+'-v1';data.projects.push({demo_id:'demo-'+slug,slug,status:'Draft',public_page_permission:'Preview only',title:slug,development_version_id:version});
    data.versions.push({version_id:version,demo_id:'demo-'+slug,layout:'three-page',state:'Draft',permission:'Preview only'});
    for(const role of ['insight','workflow','dataset'])data.pages.push({page_id:slug+'-'+role,version_id:version,role,state:role==='dataset'?'Placeholder':'Ready',dataset_id:role==='dataset'?'calce-cs2':'',dataset_version:role==='dataset'?'v1':'',route:'demos/'+slug+'/'+(role==='insight'?'index':role)+'.html',source:role==='dataset'?null:{in_scope:true,file_id:slug+'-'+role+'-drive-file',sha256:hash(html),size:Buffer.byteLength(html),mime_type:'text/html',modified_at:'2026-09-23T00:00:00.000Z',parent_path:'projects/'+slug+'/'+version}});
  }return data;
}
const policy={netlify:true,context:'branch-deploy',branch:'develop',audience:'preview'};

test('sandbox rejects original Sheet, original root, Production hook and audience',()=>{
  for(const patch of [{spreadsheet_id:FORBIDDEN_SHEET},{drive_root_id:FORBIDDEN_ROOT},{production_hook:'secret'},{branch:'main'},{audience:'production'}])assert.throws(()=>compileRegistryV3({...input(),...patch},hash));
  assert.doesNotThrow(()=>assertSandbox(input()));
});
test('deterministic revision binds Workflow, metadata, Placeholder and resource content',()=>{
  const a=input(),first=compileRegistryV3(a,hash);a.projects.reverse();a.pages.reverse();a.versions.reverse();
  assert.equal(compileRegistryV3(a,hash).manifest.registry_revision,first.manifest.registry_revision);
  const workflow=a.pages.find(p=>p.role==='workflow');workflow.source.sha256=hash('changed');
  assert.notEqual(compileRegistryV3(a,hash).manifest.registry_revision,first.manifest.registry_revision);
  const b=input();b.projects[0].title='Renamed';assert.notEqual(compileRegistryV3(b,hash).manifest.registry_revision,first.manifest.registry_revision);
});
test('missing required page, duplicate role, wrong version, invalid path and out-of-scope source fail',()=>{
  const changes=[a=>a.pages.splice(0,1),a=>a.pages.push({...a.pages[0],page_id:'duplicate'}),a=>a.pages[0].version_id='unknown',a=>a.pages[0].route='../index.html',a=>a.pages[0].source.in_scope=false,a=>a.pages[0].source.parent_path='projects/battery-b/battery-b-v1',a=>a.pages[2].state='Ready',a=>a.projects[0].development_version_id='battery-b-v1'];
  for(const change of changes){const a=input();change(a);assert.throws(()=>compileRegistryV3(a,hash));}
});
test('one shared Dataset source produces two project routes and cannot silently diverge',()=>{
  const a=input();const source={...a.pages[0].source,file_id:'shared-dataset',parent_path:'datasets/calce-cs2/v1'};
  a.pages.filter(p=>p.role==='dataset').forEach(p=>{p.state='Ready';p.source={...source};});
  const output=compileRegistryV3(a,hash);assert.equal(output.manifest.bundles.length,2);
  a.pages.findLast(p=>p.role==='dataset').source.file_id='other-dataset';assert.throws(()=>compileRegistryV3(a,hash),/shared Dataset/);
});
test('private/archived projects have neither cards nor authorized file access',()=>{
  const a=input();a.projects[0].status='Archived';const compiled=compileRegistryV3(a,hash);
  assert.equal(compiled.manifest.demos.length,1);
  assert.throws(()=>authorizedFile(compiled,'battery-a-insight','preview',compiled.manifest.registry_revision));
  assert.throws(()=>authorizedFile(compiled,'battery-b-insight','production',compiled.manifest.registry_revision));
  assert.throws(()=>authorizedFile(compiled,'battery-b-insight','preview','stale'));
  assert.throws(()=>authorizedFile(compiled,'battery-b-insight-drive-file','preview',compiled.manifest.registry_revision));
});
test('a reviewed version invalidates approval when any bound content changes',()=>{
  const a=input(),first=compileRegistryV3(a,hash);a.versions[0].state='Reviewed';a.versions[0].snapshot_digest=first.manifest.bundles[0].snapshot_digest;
  assert.doesNotThrow(()=>compileRegistryV3(a,hash));a.pages[1].source.sha256=hash('different');assert.throws(()=>compileRegistryV3(a,hash),/snapshot changed/);
});
test('Published metadata and files stay fixed while the same project develops a separate Draft',()=>{
  const a=input();a.environment='production';
  for(const p of a.projects){p.status='Live';p.public_page_permission='Public';p.published_version_id=p.development_version_id;}
  for(const v of a.versions)v.permission='Public';
  const reviewed=compileRegistryV3(a,hash);
  for(const v of a.versions){v.state='Published';v.frozen=true;v.snapshot_digest=reviewed.manifest.bundles.find(b=>b.version_id===v.version_id).snapshot_digest;v.frozen_metadata={...a.projects.find(p=>p.demo_id===v.demo_id)};}
  const p=a.projects[0],oldVersion=p.development_version_id,newVersion='battery-a-v2';
  a.versions.push({version_id:newVersion,demo_id:p.demo_id,layout:'three-page',state:'Draft',permission:'Preview only'});
  a.pages.push(...a.pages.filter(page=>page.version_id===oldVersion).map(page=>({...page,page_id:page.page_id+'-draft',version_id:newVersion,source:page.source?{...page.source,file_id:page.source.file_id+'-draft',parent_path:'projects/battery-a/'+newVersion}:null})));
  p.development_version_id=newVersion;a.audience='production';
  const before=compileRegistryV3(a,hash).manifest.registry_revision;
  p.title='Unpublished new title';a.pages.find(page=>page.version_id===newVersion&&page.role==='workflow').source.sha256=hash('new workflow');
  assert.equal(compileRegistryV3(a,hash).manifest.registry_revision,before);
  const draft=a.pages.find(page=>page.version_id===newVersion&&page.role==='insight'),published=a.pages.find(page=>page.version_id===oldVersion&&page.role==='insight');
  draft.source.file_id=published.source.file_id;
  assert.throws(()=>compileRegistryV3(a,hash),/shared with a mutable Draft/);
  draft.source.file_id+='-draft';published.source.sha256=hash('changed old source');
  assert.throws(()=>compileRegistryV3(a,hash),/snapshot changed/);
});
test('client checks instance, audience, checksum and output routes before serving content',()=>{
  const manifest=compileRegistryV3(input(),hash).manifest;
  assert.doesNotThrow(()=>validateManifest(manifest,policy,'test-registry'));
  assert.throws(()=>validateManifest(manifest,{...policy,branch:'main'},'test-registry'));
  assert.throws(()=>validateManifest(manifest,policy,'other-registry'));
  const changed=structuredClone(manifest);changed.demos[0].title='changed';assert.throws(()=>validateManifest(changed,policy,'test-registry'),/checksum/);
});
test('client assembles compact Dataset placeholders with independent round-trip navigation',async()=>{
  const snapshot=compileRegistryV3(input(),hash);const getJson=async address=>{
    const u=new URL(address),id=u.searchParams.get('id');
    if(u.searchParams.get('action')==='manifest')return {ok:true,...snapshot.manifest};
    authorizedFile(snapshot,id,'preview',u.searchParams.get('registry_revision'));
    return {ok:true,id,registry_instance:'test-registry',registry_revision:snapshot.manifest.registry_revision,html};
  };
  const registry=await loadV3Registry('https://example.com/exec?token=test&schema=3',policy,getJson,'',{AIS_REGISTRY_INSTANCE:'test-registry'});
  const pages=await registry.getProjectPages(snapshot.manifest.demos,snapshot.manifest.registry_revision);
  assert.equal(pages.size,2);
  for(const slug of ['battery-a','battery-b']){
    const output=pages.get(slug);assert.equal(output.length,3);
    const dataset=output.find(p=>p.path.endsWith('dataset.html')).html;
    assert.match(dataset,/data-dataset-state="pending"/);assert.match(dataset,/href="index.html"/);assert.match(dataset,/href="workflow.html"/);
    assert.equal((output[0].html.match(/id="ais-page-navigation"/g)||[]).length,1);
  }
  assert.equal(await registry.getRevision(snapshot.manifest.registry_revision),snapshot.manifest.registry_revision);
});

module.exports={input,hash,html,policy};
