#!/usr/bin/env node
'use strict';

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {loadLocalRegistry}=require('../lib/local-content');
const {loadLocalDemoCollection,integrateLocalDemoPages}=require('../lib/local-demo-collection');
const {loadLocalProjectPages}=require('../lib/local-project-pages');
const {stripProjectNavigation}=require('../lib/project-pages');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'local-content/backend-sandbox/import');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');

async function main(){
  const registry=loadLocalRegistry(path.join(root,'local-content/drive-current'));
  const collection=loadLocalDemoCollection(path.join(root,'demos_v4'),registry.demos);
  const authored=loadLocalProjectPages(path.join(root,'local-content/v2'),collection.demos);
  const pages=integrateLocalDemoPages(collection,collection.demos,authored);
  const legacy=['air-quality-day-segment-pca-and-amp-umap-by-sensor','singapore-road-speed-clusters-umap'];
  const demos=collection.demos.filter(d=>pages.has(d.slug)||legacy.includes(d.slug));
  if(demos.length!==13)throw new Error('Expected the reviewed 13-project import');
  const pack={schema_version:1,registry_instance:'ais-backend-sandbox-20260923',projects:[],versions:[],pages:[],resources:[],files:[]};
  const addFile=(relative,bytes,mime_type)=>{
    const file=path.join(out,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    const record={path:relative,sha256:hash(bytes),size:bytes.length,mime_type};pack.files.push(record);return relative;
  };
  fs.mkdirSync(out,{recursive:true});
  for(const d of demos){
    const project={...d,status:'Draft',public_page_permission:'Preview only',card_asset:null,file_check:'ok'};
    delete project.file_id;
    const version=d.slug+'-draft-v1',folder='projects/'+d.slug+'/'+version;
    pack.projects.push(project);
    pack.versions.push({version_id:version,demo_id:d.demo_id,layout:pages.has(d.slug)?'three-page':'single',state:'Draft',permission:'Preview only',selected:true,collection:collection.entries.has(d.slug)?collection.id:''});
    const projectPages=pages.get(d.slug)||[{path:'demos/'+d.slug+'/index.html',html:(await registry.getHtml(d.file_id,registry.registryRevision)).html}];
    for(const page of projectPages){
      if(page.bytes){
        const relative=folder+'/resources/'+page.path.split('/resources/')[1];
        if(relative.endsWith('undefined'))throw new Error('Unexpected resource path: '+page.path);
        const extension=path.extname(page.path);const mime=extension==='.zip'?'application/zip':'application/x-ipynb+json';
        const file=addFile(relative,page.bytes,mime);
        pack.resources.push({resource_id:'res-'+d.slug+'-'+pack.resources.length,version_id:version,role:'download',route:page.path,source_path:file});
        continue;
      }
      const role=!pages.has(d.slug)?'legacy':page.path.endsWith('/workflow-resources.html')?'resource_page':page.path.endsWith('/workflow.html')?'workflow':(page.path.startsWith('datasets/')||page.path.endsWith('/dataset.html'))?'dataset':'insight';
      const placeholder=role==='dataset'&&page.html.includes('data-dataset-state="pending"');
      const datasetKey=role==='dataset'?(collection.entries.get(d.slug)?.dataset_source?.split('/')[0]||page.path.split('/')[1]):'';
      const relative=role==='dataset'?'datasets/'+datasetKey+'/v1/dataset.html':folder+'/'+role+'.html';
      const html=stripProjectNavigation(page.html);
      const file=placeholder?'':addFile(relative,Buffer.from(html), 'text/html');
      pack.pages.push({page_id:'page-'+d.slug+'-'+role.replaceAll('_','-'),version_id:version,role,state:placeholder?'Placeholder':'Ready',route:page.path,source_path:file,dataset_id:datasetKey,dataset_version:datasetKey?'v1':''});
    }
    if(d.card_asset){
      const a=await registry.getAsset(d.card_asset.asset_id,registry.registryRevision);
      const relative=addFile(folder+'/card.'+a.extension,Buffer.from(a.base64,'base64'),a.mime);
      pack.resources.push({resource_id:'card-'+d.slug,version_id:version,role:'card',route:'assets/cards/'+d.slug+'.'+a.extension,source_path:relative});
    }else if(d.slug==='battery-curve-shape-explorer'){
      const relative=addFile(folder+'/card.jpg',fs.readFileSync(path.join(root,'site/assets/previews/battery-curve-shape-explorer.jpg')),'image/jpeg');
      pack.resources.push({resource_id:'card-'+d.slug,version_id:version,role:'card',route:'assets/cards/'+d.slug+'.jpg',source_path:relative});
    }
  }
  fs.writeFileSync(path.join(out,'package.json'),JSON.stringify(pack,null,2));
  console.log(JSON.stringify({projects:pack.projects.length,pages:pack.pages.length,placeholders:pack.pages.filter(p=>p.state==='Placeholder').length,resources:pack.resources.length,files:pack.files.length,bytes:pack.files.reduce((a,f)=>a+f.size,0),output:out}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
