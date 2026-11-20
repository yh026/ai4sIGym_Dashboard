#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {catalogFromBaseline, fileMap, importPackage, planChanges} from '../shared/package.mjs';
const root=path.resolve('.local/netlify-manager/satellite');
const baseline=JSON.parse(await fs.readFile('private-inputs/production-baseline.json','utf8'));
const catalog=catalogFromBaseline(baseline),files=fileMap(baseline.files);
const slug='from-twelve-thousand-numbers-to-a-codebook',entries=[];
async function walk(folder){for(const e of await fs.readdir(folder,{withFileTypes:true})){
 const full=path.join(folder,e.name);
 if(e.isDirectory())await walk(full);
 else if(e.isFile()){
  const relative=path.relative(path.join(root,'package'),full).split(path.sep).join('/');
  assert.equal(relative,relative.toLowerCase(),'Every new package path is lowercase');
  entries.push({path:relative,blob:new Blob([await fs.readFile(full)])});
 }else throw Error('Unsupported entry '+full);
}}
await walk(path.join(root,'package'));
const pkg=await importPackage(entries,catalog[slug],files);
const diff=planChanges(files,pkg.files,pkg.remove);
assert.deepEqual(pkg.remove,[]);
assert.equal(diff.filter(x=>x.kind==='replaced').length,1);
assert.equal(diff.find(x=>x.kind==='replaced').path,'/demos/'+slug+'/index.html');
const html=await fs.readFile(path.join(root,'package/index.html'),'utf8');
for(const name of ['satellite_vocabulary_poster.jpg','satellite_vocabulary.mp4']){
 assert(html.includes('resources/'+name));assert(files['/demos/'+slug+'/resources/'+name]);
}
const available=new Set([...Object.keys(files),...pkg.files.map(f=>f.path)]),dynamic=new Set();
function checkReferences(value){
 if(Array.isArray(value))return value.forEach(checkReferences);
 if(value&&typeof value==='object')return Object.values(value).forEach(checkReferences);
 if(typeof value==='string'&&/^(?:resources\/|\/assets\/)/.test(value)){
  const target=value.startsWith('/')?value:'/demos/'+slug+'/'+value;
  assert(available.has(target),'Missing dynamic asset '+target);dynamic.add(target);
 }
}
const loader=await fs.readFile(path.join(root,'package/resources/data/satellite-loader.js'),'utf8');
checkReferences(JSON.parse(loader.match(/const urls = (.*);/)[1]));
for(const entry of entries.filter(e=>e.path.startsWith('resources/data/')&&e.path.endsWith('.json')))checkReferences(JSON.parse(await entry.blob.text()));
const report={schema:1,status:'PASS',baseline_deploy:baseline.deployment.deploy_id,package_files:pkg.files.length,all_generated_paths_lowercase:true,canonical_media_urls:true,dynamic_asset_paths_verified:dynamic.size,dependency_validation:'importPackage with catalogFromBaseline and fileMap from current production-baseline',counts:Object.fromEntries(['added','replaced','removed','reused'].map(k=>[k,diff.filter(x=>x.kind===k).length])),bytes:pkg.files.reduce((n,f)=>n+f.size,0)};
await fs.writeFile(path.join(root,'import-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
