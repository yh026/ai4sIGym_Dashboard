#!/usr/bin/env node
'use strict';
// End-to-end contract rehearsal with the actual reviewed HTML/download bytes.
// A temporary Registry HTTP server exercises the same build path as Netlify.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const crypto=require('node:crypto'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {compileRegistryV3}=require('../lib/registry-v3');
const {loadLocalRegistry}=require('../lib/local-content');
const root=path.resolve(__dirname,'..'),source=path.join(root,'local-content/backend-sandbox');
const pack=JSON.parse(fs.readFileSync(process.argv[2]||path.join(source,'import-config.json')));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sources=new Map(pack.files.map((f,i)=>{const bytes=fs.readFileSync(path.join(source,'import',f.path));assert.equal(hash(bytes),f.sha256);return [f.path,{...f,file_id:'test-source-'+i,in_scope:true,modified_at:'2026-09-23T00:00:00.000Z',parent_path:path.posix.dirname(f.path),bytes}];}));
const registry=loadLocalRegistry(path.join(root,'local-content/drive-current'));
const input={environment:'sandbox',branch:'develop',spreadsheet_id:'test-sheet',drive_root_id:'test-root',registry_instance:pack.registry_instance,audience:'preview',taxonomy:registry.taxonomy,site:registry.site,projects:pack.projects.map(p=>({...p,development_version_id:pack.versions.find(v=>v.demo_id===p.demo_id).version_id})),versions:pack.versions,pages:pack.pages.map(p=>({...p,source:p.source_path?sources.get(p.source_path):null})),resources:pack.resources.map(r=>({...r,source:sources.get(r.source_path)}))};
const snapshot=compileRegistryV3(input,hash);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ais-v3-build-'));
for(const name of ['build.js','lib','site'])fs.cpSync(path.join(root,name),path.join(temp,name),{recursive:true});
let corrupt=false,requests=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push({action:url.searchParams.get('action'),id:url.searchParams.get('id')});
  res.setHeader('Content-Type','application/json');
  if(url.searchParams.get('token')!=='test-token'||url.searchParams.get('schema')!=='3'||url.searchParams.get('audience')!=='preview'){res.end(JSON.stringify({ok:false,error:'Unauthorized'}));return;}
  if(url.searchParams.get('action')==='manifest'){res.end(JSON.stringify({ok:true,...snapshot.manifest}));return;}
  const f=snapshot.files.find(f=>f.id===url.searchParams.get('id'));
  if(!f){res.end(JSON.stringify({ok:false,error:'Not selected'}));return;}
  const source=[...sources.values()].find(s=>s.file_id===f.file_id);
  const payload={ok:true,id:f.id,registry_instance:pack.registry_instance,registry_revision:snapshot.manifest.registry_revision};
  if(f.kind==='page')payload.html=source.bytes.toString('utf8')+(corrupt?' altered':'');else payload.base64=source.bytes.toString('base64');
  res.end(JSON.stringify(payload));
});
function run(env){return new Promise(resolve=>{const child=spawn(process.execPath,['build.js'],{cwd:temp,env:{...process.env,...env}});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.on('close',code=>resolve({code,text}));});}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={NETLIFY:'true',CONTEXT:'branch-deploy',BRANCH:'develop',AIS_REGISTRY_INSTANCE:pack.registry_instance,REGISTRY_URL:'http://127.0.0.1:'+server.address().port+'/?token=test-token&schema=3',SITE_ID:'2fe21bb6-70b5-47c6-a810-18f6bd8f4973',COMMIT_REF:'a'.repeat(40),DEPLOY_ID:'local-v3-test',BUILD_ID:'local-v3-test'};
  const build=await run(env);fs.writeFileSync(path.join(source,'rehearsal-build.log'),build.text);assert.equal(build.code,0,build.text);
  const manifest=JSON.parse(fs.readFileSync(path.join(temp,'dist/manifest.json')));assert.equal(manifest.schema_version,3);assert.equal(manifest.demos.length,13);
  const publicText=JSON.stringify(manifest);assert(!/file_id|source_path|drive_root|spreadsheet_id|test-source/.test(publicText));
  const homepage=fs.readFileSync(path.join(temp,'dist/index.html'),'utf8');
  assert(!/Yuhan demos|data-collection=|data-filter="collection"/.test(homepage),'Import source must not become a homepage category');
  const checks=[];
  for(const b of snapshot.manifest.bundles){
    for(const p of b.pages){const html=fs.readFileSync(path.join(temp,'dist',p.route),'utf8');if(p.state==='Placeholder')assert.match(html,/data-dataset-state="pending"/);else{const src=[...sources.values()].find(f=>f.file_id===p.source.file_id).bytes.toString('utf8');const scripts=s=>[...s.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map(m=>m[0]);for(const script of scripts(src))assert(html.includes(script),'Scientific script changed: '+p.route);}checks.push(p.route);}
    for(const r of b.resources)assert.equal(hash(fs.readFileSync(path.join(temp,'dist',r.route))),r.source.sha256);
  }
  const before=hash(fs.readFileSync(path.join(temp,'dist/manifest.json')));corrupt=true;const broken=await run(env);assert.notEqual(broken.code,0);assert.equal(hash(fs.readFileSync(path.join(temp,'dist/manifest.json'))),before,'Failed build replaced previous output');
  const wrong=await run({...env,CONTEXT:'production',BRANCH:'main'});assert.notEqual(wrong.code,0);
  const out={projects:13,pages:checks.length,resources:pack.resources.length,placeholders:pack.pages.filter(p=>p.state==='Placeholder').length,requests:requests.length,scientificScriptsUnchanged:true,downloadHashesMatch:true,productionRejected:true,failedBuildPreservesPreviousOutput:true,output:path.join(temp,'dist')};
  fs.writeFileSync(path.join(source,'rehearsal-result.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
