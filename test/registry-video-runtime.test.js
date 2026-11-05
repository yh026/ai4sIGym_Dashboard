'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {buildRuntime}=require('../google-apps-script/publishing-controls/runtime-install/bundle.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
  const context=vm.createContext({console});
  vm.runInContext(Object.values(buildRuntime().files).join('\n'),context);
  const size=26*1024*1024+17,stamp='2026-11-06T00:00:00.000Z',id='registered-video';
  const descriptor={file_id:id,mime_type:'video/mp4',size,modified_at:stamp,sha256:'a'.repeat(64)};
  const calls=[];let stamped=0,blobReads=0,wrongRange=false,changedHash=false;
  context.ScriptApp={getOAuthToken:()=> 'test-token'};
  context.Utilities={base64Encode:bytes=>Buffer.from(bytes).toString('base64')};
  context.hash_=hash;
  context.assertStamp_=f=>{assert.equal(f.file_id,id);stamped++;};
  const file={getId:()=>id,getLastUpdated:()=>new Date(stamp),getSize:()=>size,getMimeType:()=> 'video/mp4',getBlob:()=>{blobReads++;throw Error('Full video must not be loaded');}};
  context.sourceBinding_=()=>({file,parent_path:'projects/example/example-v1'});
  context.UrlFetchApp={fetch(url,options){
    calls.push({url,options});assert.equal(options.headers.Authorization,'Bearer test-token');
    assert.equal(options.followRedirects,false);
    if(!url.includes('alt=media'))return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({id,size:String(size),mimeType:'video/mp4',modifiedTime:stamp,sha256Checksum:changedHash?'b'.repeat(64):descriptor.sha256,trashed:false})};
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range),start=Number(a),end=Number(b);
    const bytes=Buffer.alloc(end-start+1,197);
    return {getResponseCode:()=>206,getAllHeaders:()=>({'content-range':`bytes ${start+(wrongRange?1:0)}-${end}/${size}`}),getBlob:()=>({getBytes:()=>bytes})};
  }};
  return {context,descriptor,calls,stats:()=>({stamped,blobReads}),wrongRange:()=>{wrongRange=true},changedHash:()=>{changedHash=true}};
}
test('large-video source uses Drive checksum without materializing the whole file',()=>{
  const h=fixture(),source=h.context.source_(h.descriptor.file_id);
  assert.equal(source.sha256,h.descriptor.sha256);assert.equal(source.size,h.descriptor.size);
  assert.equal(source.parent_path,'projects/example/example-v1');assert.equal(h.stats().blobReads,0);
  assert.equal(h.calls.length,1);
});
test('video ranges are bounded, stamped and verified before returning their bytes',()=>{
  const h=fixture(),offset=3*8*1024*1024,result=h.context.readVideoChunk_(h.descriptor,String(offset));
  const bytes=Buffer.from(result.base64,'base64');
  assert.equal(bytes.length,h.descriptor.size-offset);assert.equal(result.offset,offset);
  assert.equal(result.total_size,h.descriptor.size);assert.equal(result.source_sha256,h.descriptor.sha256);
  assert.equal(result.sha256,hash(bytes));assert.equal(h.stats().stamped,1);assert.equal(h.stats().blobReads,0);
});
test('invalid ranges, changed sources and malformed Drive responses cannot return video',()=>{
  for(const offset of [undefined,'','-1','01','1','1.5','9007199254740992','33554432']){
    const h=fixture();assert.throws(()=>h.context.readVideoChunk_(h.descriptor,offset),/offset/);assert.equal(h.calls.length,0);
  }
  const range=fixture();range.wrongRange();assert.throws(()=>range.context.readVideoChunk_(range.descriptor,'0'),/response mismatch/);
  const changed=fixture();changed.changedHash();assert.throws(()=>changed.context.readVideoChunk_(changed.descriptor,'0'),/source changed/);
  assert.equal(changed.calls.length,1,'changed source must not be downloaded');
});
