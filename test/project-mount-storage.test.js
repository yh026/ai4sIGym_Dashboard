'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),zlib=require('node:zlib');
const source=fs.readFileSync(require.resolve('../google-apps-script/sandbox/SourceMounts.gs'),'utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
  let stored='{}';
  const blob=data=>{const bytes=Buffer.from(data);return {getBytes:()=>bytes,getDataAsString:()=>bytes.toString('utf8')};};
  const context=vm.createContext({SANDBOX:{drive_root_id:'sandbox-root'},hash_:hash,
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>stored})},
    Utilities:{newBlob:blob,gzip:b=>blob(zlib.gzipSync(b.getBytes())),ungzip:b=>blob(zlib.gunzipSync(b.getBytes())),base64Encode:b=>Buffer.from(b).toString('base64'),base64Decode:s=>Buffer.from(s,'base64')}});
  vm.runInContext(source,context);return {context,set:value=>{stored=value}};
}
function config(n){return {schema:3,root_id:'1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH',mounts:Array.from({length:n},(_,i)=>({id:'folder-'+i,ancestor_chain:['parent','1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'],bindings:[{logical_path:'projects/example-'+i+'/example-'+i+'-draft-v1',file_ids:['source-file-identifier-'+i]}]}))};}
test('mount storage retains exact bindings beyond one raw property and remains backward compatible',()=>{
  const h=fixture();
  for(const n of [1,80]){const value=config(n),encoded=h.context.encodeProjectMounts_(value);assert.ok(Buffer.byteLength(encoded)<=9000);assert.equal(Boolean(JSON.parse(encoded).encoding),n===80);h.set(encoded);assert.deepEqual(JSON.parse(JSON.stringify(h.context.projectMounts_())),value);}
});
test('compressed mount storage rejects altered content and validates the decoded allowlist',()=>{
  const h=fixture(),encoded=JSON.parse(h.context.encodeProjectMounts_(config(80)));encoded.sha256='0'.repeat(64);h.set(JSON.stringify(encoded));assert.throws(()=>h.context.projectMounts_(),/integrity/);
  encoded.encoding='unknown';h.set(JSON.stringify(encoded));assert.throws(()=>h.context.projectMounts_(),/Invalid encoded/);
  const invalid=config(80);invalid.mounts[1].bindings[0].file_ids=invalid.mounts[0].bindings[0].file_ids;h.set(h.context.encodeProjectMounts_(invalid));assert.throws(()=>h.context.projectMounts_(),/duplicate flat source file/);
  assert.throws(()=>h.context.encodeProjectMounts_({data:'x'.repeat(256*1024)}),/decoded size/);
  assert.throws(()=>h.context.encodeProjectMounts_({data:crypto.randomBytes(20000).toString('hex')}),/property capacity/);
});
test('installed runtime contains the canonical mount reader and encoder',()=>{
  assert.ok(fs.readFileSync(require.resolve('../google-apps-script/publishing-controls/runtime-install/base/Code.gs'),'utf8').includes(source));
});
