'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const root='1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';
function fixture(){
  const entries={},props={};
  function item(id,name,parent,mime='application/vnd.google-apps.folder'){
    const f={id,name,parent,getId(){return id},getName(){return name},getParents(){let a=(Array.isArray(f.parent)?f.parent:[f.parent]).filter(Boolean).map(p=>entries[p]);return {hasNext:()=>a.length>0,next:()=>a.shift()}},getMimeType:()=>mime,isTrashed:()=>false};entries[id]=f;return f;
  }
  item(root,'AISInstrumentationGym');item('other','unrelated');item('project','Old Project',root);item('archive','archive','project');item('date','2026-09-25','archive');
  const ctx={console,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},DriveApp:{getFolderById:id=>entries[id],getFileById:id=>entries[id]},SANDBOX:{drive_root_id:'sandbox'}};
  vm.createContext(ctx);return {ctx,props,item,entries};
}
test('legacy source keeps project identity, supports staged migration, and rejects a moved archive',()=>{
  const h=fixture();vm.runInContext(read('google-apps-script/Code.gs'),h.ctx);
  h.item('legacy-page-001','old.html','project','text/html');
  h.props.AI4S_DATED_ARCHIVES_V1=JSON.stringify({project:{root_id:root,project_id:'project',archive_id:'archive',date_id:'date',date:'2026-09-25',page_id:'legacy-page-001',file_ids:['legacy-page-001']}});
  assert.equal(h.ctx.registryV2ArchiveSource_(h.entries.project,root).getId(),'project');
  h.entries['legacy-page-001'].parent='date';
  assert.equal(h.ctx.registryV2ArchiveSource_(h.entries.project,root).getId(),'date');
  h.entries['legacy-page-001'].getLastUpdated=()=>new Date('2026-09-01');
  const descriptor=h.ctx.registryV2DriveInfo_({drive_folder_url:root},'legacy-page-001','page');
  assert.deepEqual(Array.from(descriptor.parent_ids),['date']);
  assert.equal(descriptor.id,'legacy-page-001');
  assert.equal(h.ctx.registryDriveFile_({drive_folder_url:root},'legacy-page-001','page').getId(),'legacy-page-001');
  h.item('new-page-00001','new.html','date','text/html');
  assert.equal(h.ctx.registryDriveFile_({drive_folder_url:root},'new-page-00001','page'),null);
  assert.equal(h.ctx.registryV2DriveInfo_({drive_folder_url:root},'new-page-00001','page'),null);
  h.entries.archive.parent='other';
  assert.throws(()=>h.ctx.registryV2ArchiveSource_(h.entries.project,root),/outside/);
  assert.equal(h.ctx.registryDriveFile_({drive_folder_url:root},'legacy-page-001','page'),null);
});
test('project mounts preserve version paths and do not authorize neighboring archives or other projects',()=>{
  const h=fixture();vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'),h.ctx);
  h.item('mount','develop','project');h.item('version','example-draft-v1','mount');h.item('page','insight.html','version');h.item('old','old.html','date');
  h.props.AIS_PROJECT_MOUNTS_V1=JSON.stringify({root_id:root,mounts:[{id:'mount',project_id:'project',logical_path:'projects/example'}]});
  assert.equal(h.ctx.mountedSourceParentPath_(h.entries.page),'projects/example/example-draft-v1');
  assert.throws(()=>h.ctx.mountedSourceParentPath_(h.entries.old),/parent/);
  h.entries.mount.parent='other';assert.throws(()=>h.ctx.mountedSourceParentPath_(h.entries.page),/approved location/);
  h.entries.mount.parent='project';h.entries.project.parent='other';assert.throws(()=>h.ctx.mountedSourceParentPath_(h.entries.page),/approved location/);
});
test('dataset mounts and download descendants retain logical IDs; ambiguous parents fail closed',()=>{
  const h=fixture();vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'),h.ctx);
  h.item('mount','dataset','project');h.item('v2','v2','mount');h.item('data','dataset.html','v2');
  h.props.AIS_PROJECT_MOUNTS_V1=JSON.stringify({root_id:root,mounts:[{id:'mount',project_id:'project',logical_path:'datasets/gse84133-human-pancreas'}]});
  assert.equal(h.ctx.mountedSourceParentPath_(h.entries.data),'datasets/gse84133-human-pancreas/v2');
  h.entries.data.parent=['v2','date'];assert.throws(()=>h.ctx.mountedSourceParentPath_(h.entries.data),/Ambiguous/);
});
test('unmigrated sandbox paths continue to work without a mapping',()=>{
  const h=fixture();vm.runInContext(read('google-apps-script/sandbox/SourceMounts.gs'),h.ctx);
  h.item('sandbox','backend',root);h.item('ds','datasets','sandbox');h.item('id','example','ds');h.item('v1','v1','id');h.item('f','dataset.html','v1');
  assert.equal(h.ctx.mountedSourceParentPath_(h.entries.f),'datasets/example/v1');
});
