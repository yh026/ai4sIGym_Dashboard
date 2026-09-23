/** Independent V3 sandbox. This file is bundled with the tested pure compilers.
 * It deliberately has no Production publisher and never calls the V2 setup(). */
var SANDBOX = {
  environment: 'sandbox', branch: 'develop', registry_instance: 'ais-backend-sandbox-20260923',
  spreadsheet_id: '1LIoR1wJKW-qqaGLePnrQCmqz3YWatPWwZNtrLkEajXI',
  drive_root_id: '1d0Dat-aXa2n60nkQxR2PCBbkCBsnGlS2',
  import_config_id: '__IMPORT_CONFIG_ID__',
  site_id: '2fe21bb6-70b5-47c6-a810-18f6bd8f4973'
};
var V3_SHEETS = {
  Versions: ['Version ID','demo_id','Layout','State','Permission','Use in develop','Collection','Snapshot digest','Check'],
  Pages: ['Page ID','Version ID','Role','State','Source file','Dataset ID','Dataset version','Route'],
  Resources: ['Resource ID','Version ID','Role','Source file','Route'],
  _Pages: ['page_id','version_id','role','state','route','file_id','sha256','size','modified_at'],
  _Resources: ['resource_id','version_id','route','file_id','sha256','size','modified_at'],
  _ImportFiles: ['path','file_id','sha256'],
  _Snapshots: ['revision','snapshot_file_id','input_hash','created_at'],
  _SandboxAudit: ['time','action','revision','detail']
};
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AIS Sandbox')
    .addItem('1. Initialize sandbox','initializeSandbox')
    .addItem('2. Import four pilot projects','importPilot')
    .addItem('3. Import next project','importNextProject')
    .addSeparator().addItem('Validate and sync','syncSandbox')
    .addItem('Build develop preview','publishPreview')
    .addItem('Retry failed / unverified preview','retryPreviewAfterFailure')
    .addItem('Show preview status','showSandboxStatus')
    .addItem('Enable hourly preview sync','enableSandboxAutomation')
    .addItem('Disable sandbox automation','disableSandboxAutomation').addToUi();
}
function sandboxGuard_() {
  var p=PropertiesService.getScriptProperties();
  V3.assertSandbox(Object.assign({},SANDBOX,{production_hook:p.getProperty('AI4S_NETLIFY_PRODUCTION_BUILD_HOOK')}));
  var active=SpreadsheetApp.getActiveSpreadsheet();
  if(active && active.getId()!==SANDBOX.spreadsheet_id)throw new Error('Wrong bound spreadsheet');
  var ss=SpreadsheetApp.openById(SANDBOX.spreadsheet_id);
  if(p.getProperty('AI4S_AUTO_PUBLISH_TARGET') && !['off','preview'].includes(p.getProperty('AI4S_AUTO_PUBLISH_TARGET')))throw new Error('Invalid sandbox publish mode');
  return ss;
}
function locked_(fn) {
  var lock=LockService.getScriptLock();if(!lock.tryLock(2000))throw new Error('Another sandbox operation is running');
  try{return fn();}finally{lock.releaseLock();}
}
function hash_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,typeof value==='string'?Utilities.newBlob(value).getBytes():value).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function writeRows_(ss,name,rows){
  var sh=ss.getSheetByName(name);if(!sh)sh=ss.insertSheet(name);
  if(rows.length>sh.getMaxRows())sh.insertRowsAfter(sh.getMaxRows(),rows.length-sh.getMaxRows());
  if(rows[0].length>sh.getMaxColumns())sh.insertColumnsAfter(sh.getMaxColumns(),rows[0].length-sh.getMaxColumns());
  var old=sh.getDataRange().getValues();
  if(V3.stable(old)===V3.stable(rows))return false;
  sh.getRange(1,1,rows.length,rows[0].length).setValues(rows);
  if(old.length>rows.length)sh.getRange(rows.length+1,1,old.length-rows.length,old[0].length).clearContent();
  return true;
}
function tableRows_(ss,name){var sh=ss.getSheetByName(name);if(!sh)throw new Error('Missing sheet '+name);return sh.getDataRange().getValues().filter(function(r,i){return i===0||r.some(function(v){return v!==''&&v!==false;});});}
function objects_(rows){return rows.slice(1).map(function(r){return Object.fromEntries(rows[0].map(function(k,i){return [k,r[i]===undefined?'':r[i]];}));});}
function fileId_(value){var s=String(value||'').trim();var m=s.match(/\/d\/([A-Za-z0-9_-]+)/)||s.match(/[?&]id=([A-Za-z0-9_-]+)/);if(m)return m[1];if(/^[A-Za-z0-9_-]{20,}$/.test(s))return s;throw new Error('Use a valid Drive file link');}
function sourceFile_(id){
  var f=DriveApp.getFileById(id);if(f.isTrashed())throw new Error('Source file is in Trash');
  var queue=[f],seen={};var found=false;
  while(queue.length){var current=queue.shift(),parents=current.getParents();while(parents.hasNext()){var parent=parents.next(),pid=parent.getId();if(pid===SANDBOX.drive_root_id){found=true;break;}if(!seen[pid]){seen[pid]=true;queue.push(parent);}}if(found)break;}
  if(!found)throw new Error('Source file is outside the sandbox');return f;
}
function source_(id,previous){
  var f=sourceFile_(id),stamp=f.getLastUpdated().toISOString(),size=f.getSize(),mime=f.getMimeType(),parent=sourceParentPath_(f);
  if(previous && previous.modified_at===stamp && previous.size===size && previous.mime_type===mime && previous.parent_path===parent)return Object.assign({in_scope:true},previous);
  var blob=f.getBlob(),bytes=blob.getBytes();if(!bytes.length||bytes.length>25*1024*1024)throw new Error('Source size out of range');
  if(mime==='text/html'){var html=blob.getDataAsString('UTF-8');if(!/<head\b/i.test(html)||!/<body\b/i.test(html)||!/<\/body>/i.test(html))throw new Error('Incomplete HTML source');}
  if(f.getLastUpdated().toISOString()!==stamp||f.getSize()!==size)throw new Error('Source changed during read');
  return {in_scope:true,file_id:id,modified_at:stamp,size:size,mime_type:mime,sha256:hash_(bytes),parent_path:parent};
}
function sourceParentPath_(f){var parts=[],parents=f.getParents(),steps=0;while(parents.hasNext()){var parent=parents.next();if(parents.hasNext())throw new Error('Ambiguous source parents');if(parent.getId()===SANDBOX.drive_root_id)return parts.reverse().join('/');parts.push(parent.getName());parents=parent.getParents();if(++steps>12)break;}throw new Error('Source is outside sandbox');}
function audit_(ss,action,revision,detail){ss.getSheetByName('_SandboxAudit').appendRow([new Date().toISOString(),action,revision||'',String(detail||'').slice(0,1500)]);}
function initializeSandbox(){return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();
  if(p.getProperty('SANDBOX_INITIALIZED')){console.log('Sandbox already initialized; no changes.');return;}
  // Native copy may contain old properties. Refuse them instead of inheriting an
  // old hook or token. Credentials are generated only inside this new project.
  if(p.getProperty('AI4S_NETLIFY_PREVIEW_BUILD_HOOK')||p.getProperty('AI4S_REGISTRY_ACCESS_TOKEN'))throw new Error('Copied operational properties must be cleared before initialization');
  Object.keys(V3_SHEETS).forEach(function(name){
    writeRows_(ss,name,[V3_SHEETS[name]]);var sh=ss.getSheetByName(name);sh.setFrozenRows(1);
    sh.getRange(1,1,1,V3_SHEETS[name].length).setFontWeight('bold').setBackground('#eeeeea');
    sh.setColumnWidths(1,V3_SHEETS[name].length,180);sh.setRowHeight(1,32);
    if(name[0]==='_'){sh.hideSheet();sh.protect().setDescription('Sandbox machine index').setWarningOnly(false);}
  });
  var pr=ss.getSheetByName('Projects');
  var data=pr.getDataRange().getValues();
  for(var i=1;i<data.length;i++)if(data[i][17]){pr.getRange(i+1,1,1,3).setValues([['Draft','Not selected in sandbox','']]);pr.getRange(i+1,17).setValue('Preview only');}
  pr.insertColumnsAfter(18,2);pr.getRange(1,19,1,2).setValues([['Development version','Published version']]);
  pr.getRange(1,19,pr.getMaxRows(),2).protect().setDescription('Sandbox version pointers').setWarningOnly(false);
  var legacy=ss.getSheetByName('_Legacy_Config');if(legacy)legacy.hideSheet();
  p.setProperties({SANDBOX_INITIALIZED:'true',AI4S_AUTO_PUBLISH_TARGET:'off',AI4S_REGISTRY_ACCESS_TOKEN:Utilities.getUuid()+Utilities.getUuid(),AI4S_PREVIEW_CALLBACK_SECRET:Utilities.getUuid()+Utilities.getUuid(),AI4S_NETLIFY_SITE_ID:SANDBOX.site_id});
  ScriptApp.getProjectTriggers().forEach(function(t){ScriptApp.deleteTrigger(t);});
  configureSandboxTables_(ss);
  audit_(ss,'initialize','','New independent Sheet and Drive; automatic publishing off');
  console.log('Sandbox initialized; Production disabled.');
});}
function configureSandboxTables_(ss){
  var response=Sheets.Spreadsheets.get(ss.getId(),{fields:'sheets(properties,tables)'}),requests=[];
  var configs={Versions:{Layout:['single','three-page'],State:['Draft','Reviewed'],Permission:['Preview only','Private'],'Use in develop':'BOOLEAN'},Pages:{Role:['insight','dataset','workflow','legacy','resource_page'],State:['Ready','Placeholder']},Resources:{Role:['card','download']}};
  response.sheets.forEach(function(s){var name=s.properties.title,sh=ss.getSheetByName(name),table=(s.tables||[])[0];
    if(name==='Projects'&&table){var cols=table.columnProperties;cols[18]={columnIndex:18,columnName:'Development version',columnType:'TEXT'};cols[19]={columnIndex:19,columnName:'Published version',columnType:'TEXT'};requests.push({updateTable:{table:{tableId:table.tableId,range:{sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:Math.max(2,sh.getLastRow()),startColumnIndex:0,endColumnIndex:20},columnProperties:cols},fields:'range,columnProperties'}});}
    if(!configs[name])return;
    var columns=V3_SHEETS[name].map(function(h,i){var c={columnIndex:i,columnName:h,columnType:'TEXT'},rule=configs[name][h];if(rule==='BOOLEAN')c.columnType='BOOLEAN';else if(rule){c.columnType='DROPDOWN';c.dataValidationRule={condition:{type:'ONE_OF_LIST',values:rule.map(function(v){return {userEnteredValue:v};})}};}return c;});
    var t={name:name+'SandboxV3',range:{sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:Math.max(2,sh.getLastRow()),startColumnIndex:0,endColumnIndex:V3_SHEETS[name].length},columnProperties:columns};
    if(table){t.tableId=table.tableId;requests.push({updateTable:{table:t,fields:'range,columnProperties'}});}else requests.push({addTable:{table:t}});
  });
  if(requests.length)Sheets.Spreadsheets.batchUpdate({requests:requests},ss.getId());
}
function folder_(root,relative){var current=root;relative.split('/').filter(Boolean).forEach(function(name){if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))throw new Error('Unsafe import directory');var it=current.getFoldersByName(name),next=it.hasNext()?it.next():current.createFolder(name);if(it.hasNext())throw new Error('Ambiguous import folder');current=next;});return current;}
function importConfig_(){return JSON.parse(sourceFile_(SANDBOX.import_config_id).getBlob().getDataAsString('UTF-8'));}
function importPilot(){return importVersions_(function(v){return ['demo-tbb-cluster-explorer-2','demo-soh-battery','demo-battery-curve-shape-explorer','demo-air-quality-day-segment-pca-and-amp-umap-by-sensor'].includes(v.demo_id);});}
function importNextProject(){var existing=objects_(tableRows_(sandboxGuard_(),'Versions')).map(function(r){return r['Version ID'];}),chosen='';return importVersions_(function(v){if(chosen||existing.includes(v.version_id))return false;chosen=v.version_id;return true;});}
function importVersions_(predicate){return locked_(function(){
  var ss=sandboxGuard_();if(!PropertiesService.getScriptProperties().getProperty('SANDBOX_INITIALIZED'))throw new Error('Initialize first');
  var pack=importConfig_(),selected=pack.versions.filter(predicate),root=DriveApp.getFolderById(SANDBOX.drive_root_id);
  var importRows=tableRows_(ss,'_ImportFiles'),known={};objects_(importRows).forEach(function(r){known[r.path]=r;});
  selected.forEach(function(version){
    if(objects_(tableRows_(ss,'Versions')).some(function(r){return r['Version ID']===version.version_id;}))return;
    var archive=pack.archives.find(function(a){return a.version_id===version.version_id;});if(!archive)throw new Error('Missing import archive');
    var archiveFile=sourceFile_(archive.file_id),archiveBytes=archiveFile.getBlob();if(hash_(archiveBytes.getBytes())!==archive.sha256)throw new Error('Import archive changed');
    var blobs=Utilities.unzip(archiveBytes),files={};blobs.forEach(function(b){if(!V3.safeRoute(b.getName())||files[b.getName()])throw new Error('Unsafe or duplicate archive path');files[b.getName()]=b;});
    var refs=pack.pages.concat(pack.resources).filter(function(r){return r.version_id===version.version_id&&r.source_path;});
    refs.forEach(function(ref){var spec=pack.files.find(function(f){return f.path===ref.source_path;}),blob=files[ref.source_path];
      if(!spec||!blob||blob.getBytes().length!==spec.size||hash_(blob.getBytes())!==spec.sha256)throw new Error('Import hash mismatch');
      if(known[ref.source_path]){var old=source_(known[ref.source_path].file_id);if(old.sha256!==spec.sha256)throw new Error('Previously imported file was edited');return;}
      var bits=ref.source_path.split('/'),name=bits.pop(),dest=folder_(root,bits.join('/')),same=dest.getFilesByName(name),f;
      if(same.hasNext()){f=same.next();if(same.hasNext()||hash_(f.getBlob().getBytes())!==spec.sha256)throw new Error('Existing import path conflicts');}else f=dest.createFile(blob.setName(name).setContentType(spec.mime_type));
      var rec={path:ref.source_path,file_id:f.getId(),sha256:spec.sha256};known[rec.path]=rec;ss.getSheetByName('_ImportFiles').appendRow([rec.path,rec.file_id,rec.sha256]);
    });
    var project=pack.projects.find(function(p){return p.demo_id===version.demo_id;});upsertProject_(ss,project,version,known,pack);
    function add(name,rows){var current=tableRows_(ss,name),ids=new Set(current.slice(1).map(function(r){return r[0];}));rows.forEach(function(r){if(!ids.has(r[0]))current.push(r);});writeRows_(ss,name,current);}
    add('Pages',pack.pages.filter(function(p){return p.version_id===version.version_id;}).map(function(p){return [p.page_id,p.version_id,p.role,p.state,p.source_path?'https://drive.google.com/file/d/'+known[p.source_path].file_id+'/view':'',p.dataset_id,p.dataset_version,p.route];}));
    add('Resources',pack.resources.filter(function(r){return r.version_id===version.version_id;}).map(function(r){return [r.resource_id,r.version_id,r.role,'https://drive.google.com/file/d/'+known[r.source_path].file_id+'/view',r.route];}));
    add('Versions',[[version.version_id,version.demo_id,version.layout,'Draft','Preview only',true,version.collection,'','Not synced']]);
    audit_(ss,'import','',version.version_id);console.log('Imported '+version.version_id);
  });
  configureSandboxTables_(ss);return selected.length;
});}
function upsertProject_(ss,project,version,known,pack){
  var sh=ss.getSheetByName('Projects'),rows=sh.getDataRange().getValues(),row=rows.findIndex(function(r){return r[17]===project.demo_id;});
  var registry=tableRows_(ss,'_Registry'),headers=registry[0],index=registry.findIndex(function(r){return r[headers.indexOf('demo_id')]===project.demo_id;});
  var entry=pack.pages.find(function(p){return p.version_id===version.version_id&&['insight','legacy'].includes(p.role);});
  if(row<0){
    var taxonomy=objects_(tableRows_(ss,'_Taxonomy'));function label(id){var term=taxonomy.find(function(t){return t.term_id===id;});return term?term.label:id;}
    var options=objects_(tableRows_(ss,'Options'));function option(id){var term=options.find(function(t){return t['Option ID']===id;});return term?term['Option Label']:id;}
    row=sh.getLastRow();sh.getRange(2,1,1,18).copyTo(sh.getRange(row+1,1,1,18));
    sh.getRange(row+1,1,1,20).setValues([['Draft','Not synced','',project.title,project.card_summary,label(project.department_id),label(project.subtopic_id),project.task_ids.map(label).join(', '),project.method_ids.map(label).join(', '),project.data_type_ids.map(option).join(', '),project.instrument_type_ids.map(option).join(', '),'',project.title,project.audience,false,project.data_source_label,'Preview only',project.demo_id,version.version_id,'']]);
    var r=Object.assign({},project,{schema_version:2,row_number:row+1,card_asset_id:'',source_folder_id:'',file_id:known[entry.source_path].file_id,file_check:'ok',readiness:'ready'});
    registry.push(headers.map(function(h){var v=r[h];return Array.isArray(v)?v.join(', '):v===undefined?'':v;}));
    writeRows_(ss,'_Registry',registry);
  }else{sh.getRange(row+1,19).setValue(version.version_id);}
}
function readInput_(ss){
  var sheets={};['Projects','Options','_Registry','_Taxonomy','_Facets','_Assets','_Config'].forEach(function(n){sheets[n]=tableRows_(ss,n);});
  sheets.Projects=sheets.Projects.map(function(r,i){var c=r.slice(0,18);if(i){c[1]='';c[2]='';}return c;});
  var versions=tableRows_(ss,'Versions').map(function(r,i){var c=r.slice();if(i){c[7]='';c[8]='';}return c;});
  return {sheets:sheets,versions:versions,pages:tableRows_(ss,'Pages'),resources:tableRows_(ss,'Resources')};
}
function currentSnapshot_(){var p=PropertiesService.getScriptProperties(),id=p.getProperty('SANDBOX_SNAPSHOT_FILE');if(!id)return null;return JSON.parse(sourceFile_(id).getBlob().getDataAsString('UTF-8'));}
function syncSandbox(){return locked_(syncSandbox_);}
function syncSandbox_(){
  var ss=sandboxGuard_(),input=readInput_(ss),fingerprint=hash_(V3.stable(input)),old=currentSnapshot_(),oldFiles={};
  if(old)old.files.forEach(function(f){oldFiles[f.file_id]=f;});
  var compiled=V2Sheet.compileRegistryV2Sheet(input.sheets);if(!compiled.compiled.ok)throw new Error(JSON.stringify(compiled.compiled.errors));
  var v2=V2.toRegistryV2(compiled.compiled),versions=objects_(tableRows_(ss,'Versions')).map(function(r){return {version_id:r['Version ID'],demo_id:r.demo_id,layout:r.Layout,state:r.State,permission:r.Permission,selected:r['Use in develop']===true,collection:r.Collection,snapshot_digest:r['Snapshot digest']};});
  var selected={};versions.filter(function(v){return v.selected;}).forEach(function(v){if(selected[v.demo_id])throw new Error('Two development versions selected for '+v.demo_id);selected[v.demo_id]=v.version_id;});
  var projects=v2.demos.map(function(p){return Object.assign({},p,{development_version_id:selected[p.demo_id]||'',published_version_id:''});});
  Object.keys(selected).forEach(function(id){if(!projects.some(function(p){return p.demo_id===id;}))throw new Error('Selected project has invalid metadata: '+id);});
  var sources={};function resolve(link){if(!link)return null;var id=fileId_(link);if(!sources[id])sources[id]=source_(id,oldFiles[id]);return sources[id];}
  var pages=objects_(input.pages).map(function(r){return {page_id:r['Page ID'],version_id:r['Version ID'],role:r.Role,state:r.State,source:resolve(r['Source file']),dataset_id:r['Dataset ID'],dataset_version:r['Dataset version'],route:r.Route};});
  var resources=objects_(input.resources).map(function(r){return {resource_id:r['Resource ID'],version_id:r['Version ID'],role:r.Role,source:resolve(r['Source file']),route:r.Route};});
  var result=V3.compileRegistryV3(Object.assign({},SANDBOX,{audience:'preview',site:compiled.siteMetadata,taxonomy:v2.taxonomy,projects:projects,versions:versions,pages:pages,resources:resources}),hash_);
  if(fingerprint!==hash_(V3.stable(readInput_(ss))))throw new Error('Sheet changed during sync; retry');
  result.input_hash=fingerprint;
  if(old&&old.manifest.registry_revision===result.manifest.registry_revision&&old.input_hash===fingerprint){console.log('No content changes; no new snapshot or build.');return old.manifest;}
  result.files.forEach(function(f){assertStamp_(f);});
  var folder=folder_(DriveApp.getFolderById(SANDBOX.drive_root_id),'snapshots'),file=folder.createFile(Utilities.newBlob(JSON.stringify(result),'application/json',result.manifest.registry_revision.slice(7)+'.json'));
  writeRows_(ss,'_Pages',[V3_SHEETS._Pages].concat(result.manifest.bundles.flatMap(function(b){return b.pages.map(function(p){var f=p.source||{};return [p.page_id,b.version_id,p.role,p.state,p.route,f.file_id||'',f.sha256||'',f.size||'',f.modified_at||''];});})));
  writeRows_(ss,'_Resources',[V3_SHEETS._Resources].concat(result.manifest.bundles.flatMap(function(b){return b.resources.map(function(r){return [r.resource_id,b.version_id,r.route,r.source.file_id,r.source.sha256,r.source.size,r.source.modified_at];});})));
  var versionSheet=ss.getSheetByName('Versions'),versionRows=versionSheet.getDataRange().getValues();
  result.manifest.bundles.forEach(function(b){var row=versionRows.findIndex(function(r){return r[0]===b.version_id;});versionSheet.getRange(row+1,8,1,2).setValues([[b.snapshot_digest,'Validated']]);});
  var projectSheet=ss.getSheetByName('Projects'),projectRows=projectSheet.getDataRange().getValues();
  projectRows.slice(1).forEach(function(r,i){if(!r[17])return;var version=selected[r[17]]||'';projectSheet.getRange(i+2,19,1,2).setValues([[version,'']]);projectSheet.getRange(i+2,2,1,2).setValues([[version?'Validated; preview pending':'Not selected in sandbox','']]);});
  ss.getSheetByName('_Snapshots').appendRow([result.manifest.registry_revision,file.getId(),fingerprint,new Date().toISOString()]);
  PropertiesService.getScriptProperties().setProperty('SANDBOX_SNAPSHOT_FILE',file.getId());
  audit_(ss,'sync',result.manifest.registry_revision,result.manifest.demos.length+' projects');
  console.log('Validated '+result.manifest.demos.length+' projects; '+result.manifest.registry_revision);return result.manifest;
}
function assertStamp_(descriptor){var f=sourceFile_(descriptor.file_id);if(f.getLastUpdated().toISOString()!==descriptor.modified_at||f.getSize()!==descriptor.size||f.getMimeType()!==descriptor.mime_type||sourceParentPath_(f)!==descriptor.parent_path)throw new Error('Source changed; synchronize before building');return f;}
function checkedSnapshot_(revision,allFiles){var ss=sandboxGuard_(),snapshot=currentSnapshot_();if(!snapshot)throw new Error('Synchronize first');if(revision&&snapshot.manifest.registry_revision!==revision)throw new Error('Registry revision changed');if(hash_(V3.stable(readInput_(ss)))!==snapshot.input_hash)throw new Error('Sheet changed; synchronize before building');if(allFiles)snapshot.files.forEach(assertStamp_);return snapshot;}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
function safeEqual_(a,b){a=String(a||'');b=String(b||'');var diff=a.length^b.length;for(var i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
function doGet(e){try{
  var q=e&&e.parameter||{},p=PropertiesService.getScriptProperties(),token=p.getProperty('AI4S_REGISTRY_ACCESS_TOKEN');
  if(!token||!safeEqual_(q.token,token))return json_({ok:false,error:'Unauthorized'});
  if(q.schema!=='3'||q.audience!=='preview')throw new Error('Sandbox accepts schema 3 Preview only');
  var snapshot=checkedSnapshot_(q.registry_revision,q.action==='manifest');
  if(q.action==='manifest')return json_(Object.assign({ok:true},snapshot.manifest));
  if(!['page','resource'].includes(q.action))throw new Error('Unknown action');
  var f=V3.authorizedFile(snapshot,q.id,q.audience,q.registry_revision);
  if((q.action==='page')!==(f.kind==='page'))throw new Error('Wrong file role');
  var driveFile=assertStamp_(f),blob=driveFile.getBlob(),bytes=blob.getBytes();
  if(hash_(bytes)!==f.sha256||bytes.length!==f.size)throw new Error('Source hash changed');assertStamp_(f);
  var response={ok:true,id:f.id,registry_instance:SANDBOX.registry_instance,registry_revision:snapshot.manifest.registry_revision};
  if(f.kind==='page')response.html=blob.getDataAsString('UTF-8');else response.base64=Utilities.base64Encode(bytes);
  return json_(response);
}catch(error){return json_({ok:false,error:String(error.message).slice(0,400)});}}
function previewState_(){return JSON.parse(PropertiesService.getScriptProperties().getProperty('SANDBOX_PREVIEW_STATE')||'{}');}
function savePreviewState_(s){PropertiesService.getScriptProperties().setProperty('SANDBOX_PREVIEW_STATE',JSON.stringify(s));}
function publishPreview(){return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties(),snapshot=checkedSnapshot_('',true),revision=snapshot.manifest.registry_revision,state=previewState_();
  if(state.revision===revision && ['requested','accepted','ready','failed','replaced'].includes(state.phase)){console.log('Existing preview request: '+state.phase+'; no duplicate build');return state;}
  var hook=p.getProperty('AI4S_NETLIFY_PREVIEW_BUILD_HOOK');if(!/^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(hook||''))throw new Error('Configure the dedicated develop build hook first');
  var request={schema:1,target:'preview',branch:'develop',registry_revision:revision,request_id:Utilities.getUuid(),requested_at:new Date().toISOString()};
  var attempts=state.revision===revision?(state.attempts||1)+1:1;if(attempts>3)throw new Error('Three attempts reached; fix the content or configuration before retrying');
  state={revision:revision,request_id:request.request_id,requested_at:request.requested_at,phase:'requested',attempts:attempts};savePreviewState_(state);
  // Store the request before HTTP. An uncertain network result must never create
  // a second logical build automatically.
  var response=UrlFetchApp.fetch(hook+'?trigger_branch=develop',{method:'post',contentType:'application/json',payload:JSON.stringify(request),muteHttpExceptions:true});
  var code=response.getResponseCode();state.phase=code>=200&&code<300?'accepted':'failed';state.http_status=code;savePreviewState_(state);
  audit_(ss,'preview-'+state.phase,revision,state.request_id);console.log('Preview '+state.phase+'; waiting for signed completion');return state;
});}
function retryPreviewAfterFailure(){
  var ss=sandboxGuard_(),ui=SpreadsheetApp.getUi(),answer=ui.alert('Retry develop preview','First verify in Netlify that the previous sandbox build failed, was cancelled, or completed without a verified Registry request. Never retry a running or verified successful build. Have you checked its status?',ui.ButtonSet.YES_NO);
  if(answer!==ui.Button.YES)return;
  locked_(function(){var state=previewState_();if(!['requested','accepted','failed','replaced'].includes(state.phase))throw new Error('No failed or incomplete request to retry');if((state.attempts||1)>=3)throw new Error('Three attempts reached; correct the underlying issue first');audit_(ss,'manual-retry',state.revision,state.request_id);state.phase='retry-approved';savePreviewState_(state);});
  return publishPreview();
}
function doPost(e){try{return locked_(function(){
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();if(!e||!e.parameter||e.parameter.action!=='preview_callback'||String(e.postData&&e.postData.contents||'').length>20000)throw new Error('Invalid callback');
  var envelope=JSON.parse(e.postData.contents),secret=p.getProperty('AI4S_PREVIEW_CALLBACK_SECRET');
  if(!secret||typeof envelope.payload!=='string')throw new Error('Unauthorized callback');
  var signature=Utilities.computeHmacSha256Signature(envelope.payload,secret).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
  if(!safeEqual_(signature,envelope.signature))throw new Error('Unauthorized callback');
  var payload=JSON.parse(envelope.payload),r=payload.receipt,state=previewState_(),now=Date.now();
  if(payload.schema!==1||payload.event!=='preview_deploy_succeeded'||!Number.isFinite(Date.parse(payload.callback_at))||Math.abs(now-Date.parse(payload.callback_at))>15*60*1000)throw new Error('Expired callback');
  if(!r||r.schema!==1||r.registry_schema!==3||r.registry_instance!==SANDBOX.registry_instance||![true,false].includes(r.verified)||r.revision_bound!==true||r.target!=='preview'||r.audience!=='preview'||r.platform!=='netlify'||r.context!=='branch-deploy'||r.branch!=='develop'||r.site_id!==SANDBOX.site_id||!r.deploy_id||!r.build_id||!/^[a-f0-9]{40}$/.test(r.commit_ref||''))throw new Error('Callback identity mismatch');
  if(r.verified===false){
    if(state.phase==='ready'){
      var changed=ss.getSheetByName('Projects'),changedRows=changed.getDataRange().getValues();
      changedRows.slice(1).forEach(function(row,i){if(row[18])changed.getRange(i+2,2,1,2).setValues([['Preview replaced; verification required','']]);});
      state.phase='replaced';state.replaced_by=r.deploy_id;savePreviewState_(state);audit_(ss,'preview-replaced',state.revision,r.deploy_id);
    }
    return json_({ok:true,event:'preview_callback',deploy_id:r.deploy_id});
  }
  if(state.phase==='replaced'||r.registry_revision!==state.revision||r.request_id!==state.request_id||r.requested_at!==state.requested_at)throw new Error('Callback request mismatch');
  if(state.phase==='ready'&&state.deploy_id!==r.deploy_id)throw new Error('Callback replay');
  checkedSnapshot_(state.revision,true);
  if(state.phase!=='ready'){
    var sh=ss.getSheetByName('Projects'),rows=sh.getDataRange().getValues(),registry=objects_(tableRows_(ss,'_Registry'));
    rows.slice(1).forEach(function(row,i){if(!row[18])return;var d=registry.find(function(d){return d.demo_id===row[17];});if(!d)return;sh.getRange(i+2,2).setValue('Preview ready');sh.getRange(i+2,3).setFormula('=HYPERLINK("https://develop--aisigym.netlify.app/demos/'+d.slug+'/","Open Preview")');});
    state.phase='ready';state.deploy_id=r.deploy_id;state.commit_ref=r.commit_ref;state.ready_at=payload.callback_at;savePreviewState_(state);audit_(ss,'preview-ready',state.revision,r.deploy_id);
  }
  return json_({ok:true,event:'preview_callback',deploy_id:r.deploy_id});
});}catch(error){return json_({ok:false,error:String(error.message).slice(0,200)});}}
function showSandboxStatus(){var s=previewState_();SpreadsheetApp.getUi().alert('Sandbox preview',JSON.stringify(s,null,2),SpreadsheetApp.getUi().ButtonSet.OK);}
function hourlySandbox(){syncSandbox();if(PropertiesService.getScriptProperties().getProperty('AI4S_AUTO_PUBLISH_TARGET')==='preview')publishPreview();}
function enableSandboxAutomation(){sandboxGuard_();var state=previewState_();if(state.phase!=='ready')throw new Error('Verify a signed develop deployment first');disableSandboxAutomation();ScriptApp.newTrigger('hourlySandbox').timeBased().everyHours(1).create();PropertiesService.getScriptProperties().setProperty('AI4S_AUTO_PUBLISH_TARGET','preview');}
function disableSandboxAutomation(){sandboxGuard_();ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='hourlySandbox';}).forEach(function(t){ScriptApp.deleteTrigger(t);});PropertiesService.getScriptProperties().setProperty('AI4S_AUTO_PUBLISH_TARGET','off');}
