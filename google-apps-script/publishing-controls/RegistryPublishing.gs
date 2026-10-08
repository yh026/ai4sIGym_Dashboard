/** Project inclusion is staged in Control panel; only explicit actions apply it.
 * The existing V3 API, signed callback, and production/main build remain intact.
 */
var REGISTRY_PUBLISHING = {
  stateSheet: '_PublishingState',
  headers: ['demo_id', 'Production status', 'Preview status', 'Production route', 'Preview route',
    'Checked at', 'Preferred version', 'Production digest', 'Preview digest', 'Production deploy', 'Preview deploy'],
  previewProperty: 'AIS_PUBLISHING_PREVIEW_ACTUAL_V1',
  productionProperty: 'AIS_PUBLISHING_PRODUCTION_ACTUAL_V1',
  reviewProperty: 'AIS_PUBLISHING_PRODUCTION_REVIEW_V1'
};
function registryPublishingPanel_() {
  var ss = registryUiSpreadsheet_();
  var panel = ss.getSheetByName('Control panel');
  var headers = panel.getRange(9,1,1,13).getValues()[0];
  if (headers[3] !== 'Include in production' || headers[5] !== 'Include in preview' || headers[12] !== 'demo_id')
    throw new Error('Publishing controls are not installed.');
  return panel;
}
function registryPublishingState_() {
  var sheet = registryUiSpreadsheet_().getSheetByName(REGISTRY_PUBLISHING.stateSheet);
  if (!sheet || sheet.getRange(1,1,1,11).getValues()[0].join('|') !== REGISTRY_PUBLISHING.headers.join('|'))
    throw new Error('The publishing state table has unexpected headers.');
  return sheet;
}
function registryPublishingCatalog_() {
  return registryUiSpreadsheet_().getSheetByName('Project files').getRange(5,1,13,11).getValues().map(function(r) {
    return {demo_id: r[10], title: String(r[1]), number: String(r[0])};
  });
}
function registryPublishingSelection_() {
  var rows = registryPublishingPanel_().getRange(10,1,13,13).getValues();
  return RegistryPublishingModel.normalizeSelection(registryPublishingCatalog_(), rows.map(function(r) {
    return {demo_id:r[12],includeProduction:r[3],includePreview:r[5]};
  }));
}
function registryPublishingStored_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { throw new Error('Publishing state is invalid. Refresh status.'); }
}
function registryPublishingSave_(key,value) {
  var raw=JSON.stringify(value);
  if(raw.length>8500)throw new Error('Publishing status exceeds its storage limit.');
  PropertiesService.getScriptProperties().setProperty(key,raw);
}
function registryPublishingJson_(url) {
  var response=UrlFetchApp.fetch(url,{method:'get',muteHttpExceptions:true,headers:{'Cache-Control':'no-cache'}});
  if(response.getResponseCode()!==200){var error=new Error('The deployed site did not return its status file.');
    error.httpStatus=response.getResponseCode();throw error;}
  var raw=response.getContentText();if(raw.length>2000000)throw new Error('The deployed status file is too large.');
  return JSON.parse(raw);
}
function registryPublishingVerifyReceipt_(receipt,environment) {
  if(!receipt||receipt.schema!==1||receipt.platform!=='netlify'||receipt.site_id!==SANDBOX.site_id
    ||receipt.target!==environment||receipt.audience!==environment||receipt.revision_bound!==true
    ||!/^sha256:[a-f0-9]{64}$/.test(receipt.registry_revision||'')
    ||receipt.branch!==(environment==='production'?'main':'develop')
    ||receipt.context!==(environment==='production'?'production':'branch-deploy')
    ||!/^[a-f0-9]{24}$/.test(receipt.deploy_id||''))throw new Error('Deployment identity did not match this environment.');
}
function registryPublishingMembership_(manifest,deploy,at) {
  if(!manifest||!Array.isArray(manifest.demos))throw new Error('The deployed project list is missing.');
  var seen={};
  var projects=manifest.demos.map(function(d){
    if(!/^demo-[a-z0-9-]+$/.test(d.demo_id||'')||seen[d.demo_id])throw new Error('Invalid deployed project identity.');
    seen[d.demo_id]=true;
    var page=(d.pages||[]).filter(function(p){return p.role==='insight';})[0];
    var route=page&&(page.path||page.route)||'demos/'+d.slug+'/index.html';
    if(!/^demos\/[a-z0-9-]+\/(?:index\.html)?$/.test(route))throw new Error('Invalid project route.');
    return {demo_id:d.demo_id,route:route};
  });
  return {known:true,deploy_id:deploy,checked_at:at,projects:projects};
}
function registryPublishingRefreshProduction_() {
  var first=registryPublishingJson_(REGISTRY_UI.productionReceiptUrl);
  registryPublishingVerifyReceipt_(first,'production');
  // Read the immutable deployment, then check that production still points to it.
  var base='https://'+first.deploy_id+'--aisigym.netlify.app/';
  var manifest=registryPublishingJson_(base+'manifest.json');
  var pinned=registryPublishingJson_(base+'deploy-receipt.json');
  registryPublishingVerifyReceipt_(pinned,'production');
  var last=registryPublishingJson_(REGISTRY_UI.productionReceiptUrl);
  registryPublishingVerifyReceipt_(last,'production');
  if(pinned.deploy_id!==first.deploy_id||last.deploy_id!==first.deploy_id||manifest.audience!=='production')
    throw new Error('Production changed during refresh. Refresh status again.');
  var value=registryPublishingMembership_(manifest,first.deploy_id,new Date().toISOString());
  value.registry_revision=first.registry_revision||'';
  registryPublishingSave_(REGISTRY_PUBLISHING.productionProperty,value);
  registryUiPatch_({production_deploy:first.deploy_id,production_checked_at:value.checked_at,production_warning:''});
  return value;
}
function registryPublishingSignedPreview_(state,at,stale) {
  if(state.phase!=='ready'||!state.request_id||!/^[a-f0-9]{24}$/.test(state.deploy_id||'')
    ||!Number.isFinite(Date.parse(at||'')))return null;
  var snapshot=currentSnapshot_();
  if(!snapshot||snapshot.manifest.registry_revision!==state.revision)return null;
  var value=registryPublishingMembership_(snapshot.manifest,state.deploy_id,new Date(at).toISOString());
  value.registry_revision=state.revision;value.request_id=state.request_id;
  value.source='signed_callback';value.stale=stale===true;
  value.projects.forEach(function(p){var b=snapshot.manifest.bundles.filter(function(x){return x.demo_id===p.demo_id;})[0];
    if(b){p.version_id=b.version_id;p.fingerprint=b.snapshot_digest;}});
  return value;
}
function registryPublishingRefreshPreview_() {
  var state=previewState_(),saved=registryPublishingStored_(REGISTRY_PUBLISHING.previewProperty);
  try {
    var live=registryPublishingJson_(REGISTRY_UI.previewUrl+'deploy-receipt.json');
    registryPublishingVerifyReceipt_(live,'preview');
    if(state.phase==='ready'&&typeof state.request_id==='string'&&state.request_id
      &&live.deploy_id===state.deploy_id&&live.registry_revision===state.revision
      &&live.request_id===state.request_id) {
      var value=registryPublishingSignedPreview_(state,new Date().toISOString(),false);
      if(value) {
        registryPublishingSave_(REGISTRY_PUBLISHING.previewProperty,value);return value;
      }
    }
    // During a pending build, the previously verified project list still describes
    // preview only if the live receipt still identifies that exact deployment.
    if(state.phase!=='replaced'&&saved&&saved.known&&saved.deploy_id===live.deploy_id
      &&saved.registry_revision===live.registry_revision&&saved.request_id&&saved.request_id===live.request_id) {
      saved.checked_at=new Date().toISOString();saved.stale=false;
      registryPublishingSave_(REGISTRY_PUBLISHING.previewProperty,saved);return saved;
    }
  } catch(error) {
    // Team-protected branch deployments return 401 to Apps Script. Keep protection
    // intact and label signed callback evidence as historical, never a fresh read.
    if(error.httpStatus===401&&state.phase!=='replaced') {
      var fallback=registryPublishingSignedPreview_(state,state.ready_at,true);
      if(!fallback&&['requested','accepted','failed','retry-approved'].indexOf(state.phase)!==-1
        &&saved&&saved.known&&saved.source==='signed_callback'&&saved.request_id
        &&/^[a-f0-9]{24}$/.test(saved.deploy_id||'')&&/^sha256:[a-f0-9]{64}$/.test(saved.registry_revision||'')
        &&Number.isFinite(Date.parse(saved.checked_at||''))) {
        fallback=saved;fallback.stale=true;
      }
      if(fallback){fallback.warning='Preview access is protected. Showing the last signed verification; current deployment has not been refreshed.';
        registryPublishingSave_(REGISTRY_PUBLISHING.previewProperty,fallback);return fallback;}
    }
    return {known:false,projects:[],warning:registryUiMessage_(error)};
  }
  return {known:false,projects:[],warning:'The live preview does not match a verified release. Update preview and refresh status.'};
}
function registryPublishingWriteStates_(production,preview) {
  var sheet=registryPublishingState_(),old=sheet.getRange(2,1,13,11).getValues(),catalog=registryPublishingCatalog_();
  var versions=objects_(tableRows_(registryUiSpreadsheet_(),'Versions'));
  var productionTime=Date.parse(production.checked_at||''),previewTime=Date.parse(preview.checked_at||'');
  var checked=production.known&&preview.known&&Number.isFinite(productionTime)&&Number.isFinite(previewTime)
    ?new Date(Math.min(productionTime,previewTime)).toISOString():'';
  var rows=catalog.map(function(p){
    var prev=old.filter(function(r){return r[0]===p.demo_id;})[0]||[];
    var active=versions.filter(function(v){return v.demo_id===p.demo_id&&v['Use in develop']===true;});
    if(active.length>1)throw new Error('Multiple development versions selected for '+p.demo_id);
    var pd=(production.projects||[]).filter(function(x){return x.demo_id===p.demo_id;})[0];
    var vd=(preview.projects||[]).filter(function(x){return x.demo_id===p.demo_id;})[0];
    return [p.demo_id,production.known?(pd?'Published':'Not published'):'Not checked',
      preview.known?(vd?'Published':'Not published'):'Not checked',
      pd?pd.route:'',vd?vd.route:'',checked,active.length?active[0]['Version ID']:prev[6]||'',
      pd&&pd.fingerprint||'',vd&&vd.fingerprint||'',production.known?production.deploy_id:'',preview.known?preview.deploy_id:''];
  });
  sheet.getRange(2,1,13,11).setValues(rows);
  return rows;
}
/** This operation only reads deployments and updates status cells. */
function registryPublishingRefreshStatus() {
  registryPublishingSelection_();
  var production,warning='';
  try{production=registryPublishingRefreshProduction_();}catch(error){
    production={known:false,projects:[]};warning=registryUiMessage_(error);
    registryUiPatch_({production_warning:warning});
  }
  var preview=registryPublishingRefreshPreview_();
  registryPublishingWriteStates_(production,preview);
  var status=registryUiWriteStatus_(registryUiGetStatus());
  status.production_warning=warning;status.preview_warning=preview.warning||'';status.publishing=registryPublishingSummary_(preview);
  return status;
}
function registryPublishingSummary_(preview) {
  var selected=registryPublishingSelection_(),rows=registryPublishingState_().getRange(2,1,13,11).getValues();
  var pending=selected.filter(function(s){var r=rows.filter(function(x){return x[0]===s.demo_id;})[0];
    return r&&(r[1]!=='Not checked'&&s.includeProduction!==(r[1]==='Published')||r[2]!=='Not checked'&&s.includePreview!==(r[2]==='Published'));});
  preview=preview||registryPublishingStored_(REGISTRY_PUBLISHING.previewProperty);
  var transport=!!PropertiesService.getScriptProperties().getProperty('AIS_PRODUCTION_RELEASE_BRIDGE_URL');
  var reason=preview&&preview.stale?'Preview is showing the last signed verification. Verify the current protected deployment before publishing production.'
    :(!preview||!preview.known?'Refresh preview status before publishing production.':(!transport?'Production publishing is not connected.':''));
  return {pending:pending.length,production:selected.filter(function(r){return r.includeProduction;}).length,
    preview:selected.filter(function(r){return r.includePreview;}).length,
    preview_stale:!!(preview&&preview.stale),production_enabled:transport&&!reason,production_disabled_reason:reason};
}
/** Called only by the explicit Update preview action, never on edit/open/hourly. */
function registryPublishingApplyPreview_() {
  var ss=registryUiSpreadsheet_(),selected=registryPublishingSelection_();
  var state=registryPublishingState_().getRange(2,1,13,11).getValues();
  var sheet=ss.getSheetByName('Versions'),rows=sheet.getDataRange().getValues();
  var before=rows.slice(1).map(function(r){return [r[5]];}),next=before.map(function(r){return r.slice();});
  selected.forEach(function(s){
    var indices=[];rows.slice(1).forEach(function(r,i){if(r[1]===s.demo_id)indices.push(i);});
    var active=indices.filter(function(i){return rows[i+1][5]===true;});
    if(active.length>1)throw new Error('Multiple development versions selected for '+s.demo_id);
    var saved=state.filter(function(r){return r[0]===s.demo_id;})[0];
    var preferred=active.length?rows[active[0]+1][0]:saved&&saved[6];
    var match=indices.filter(function(i){return rows[i+1][0]===preferred;});
    if(s.includePreview&&match.length!==1)throw new Error('Choose a development version for '+s.demo_id+' in Advanced tables.');
    indices.forEach(function(i){next[i]=[s.includePreview&&i===match[0]];});
  });
  // Keep a rollback copy of the inputs and generated tables touched by syncSandbox_.
  // A new immutable Drive snapshot may remain after failure, but is never activated.
  var ranges=[registryPublishingState_().getRange(2,7,13,1),sheet.getRange(2,6,before.length,1),
    sheet.getRange(2,8,before.length,2)];
  var projectSheet=ss.getSheetByName('Projects'),projectCount=projectSheet.getDataRange().getValues().length-1;
  if(projectCount>0)ranges.push(projectSheet.getRange(2,2,projectCount,2),projectSheet.getRange(2,19,projectCount,2));
  var rangeBackups=ranges.map(function(r){var values=r.getValues(),formulas=r.getFormulas();
    return {range:r,values:values.map(function(row,i){return row.map(function(v,j){return formulas[i][j]||v;});})};});
  var tableBackups=['_Pages','_Resources','_Snapshots','_SandboxAudit'].map(function(name){
    var table=ss.getSheetByName(name);if(!table)throw new Error('Missing backend table: '+name);
    return {sheet:table,values:table.getDataRange().getValues()};
  });
  var properties=PropertiesService.getScriptProperties(),oldSnapshot=properties.getProperty('SANDBOX_SNAPSHOT_FILE');
  // Save preferred versions before exclusion clears generated Projects pointers.
  state.forEach(function(r){var active=rows.slice(1).filter(function(v){return v[1]===r[0]&&v[5]===true;});if(active.length===1)r[6]=active[0][0];});
  try {
    registryPublishingState_().getRange(2,7,13,1).setValues(state.map(function(r){return [r[6]];}));
    sheet.getRange(2,6,next.length,1).setValues(next);SpreadsheetApp.flush();
    return syncSandbox_();
  } catch(error) {
    var failures=[];
    rangeBackups.forEach(function(b){try{b.range.setValues(b.values);}catch(failure){failures.push(failure);}});
    tableBackups.forEach(function(b){try{b.sheet.getDataRange().clearContent();
      b.sheet.getRange(1,1,b.values.length,b.values[0].length).setValues(b.values);
    }catch(failure){failures.push(failure);}});
    try{if(oldSnapshot)properties.setProperty('SANDBOX_SNAPSHOT_FILE',oldSnapshot);else properties.deleteProperty('SANDBOX_SNAPSHOT_FILE');}
    catch(failure){failures.push(failure);}
    SpreadsheetApp.flush();
    if(failures.length)throw new Error('Preview selection failed and could not be fully restored. Run validation before another build.');
    throw error;
  }
}
function registryPublishingUpdatePreview() {
  registryPublishingSelection_();
  registryPublishingRefreshPreview_();
  try{
    // Applying checkbox settings and taking the snapshot share the backend lock.
    locked_(registryPublishingApplyPreview_);
    registryUiPatch_({last_sync_at:new Date().toISOString(),last_sync_result:'Selection applied; files validated',last_error:''});
    publishPreview();
  }catch(error){registryUiPatch_({last_error:registryUiMessage_(error)});registryUiWriteStatus_(registryUiGetStatus());throw error;}
  return registryPublishingRefreshStatus();
}
function registryPublishingReviewProduction() {
  registryPublishingRefreshStatus();
  var selection=registryPublishingSelection_(),rows=registryPublishingState_().getRange(2,1,13,11).getValues();
  var prod=registryPublishingStored_(REGISTRY_PUBLISHING.productionProperty),prev=registryPublishingStored_(REGISTRY_PUBLISHING.previewProperty);
  var signed=previewState_();
  if(rows.some(function(r){return r[1]==='Not checked'||r[2]==='Not checked';}))throw new Error('Refresh both deployment states before preparing a release.');
  if(!prod||!prev||signed.phase!=='ready'||signed.deploy_id!==prev.deploy_id)throw new Error('Wait for a verified preview before preparing production.');
  var catalog=registryPublishingCatalog_(),changes=selection.map(function(s){
    var p=(prod.projects||[]).some(function(x){return x.demo_id===s.demo_id;});
    var v=(prev.projects||[]).some(function(x){return x.demo_id===s.demo_id;});
    if(s.includeProduction&&s.includePreview&&!v)throw new Error('Update preview with '+s.demo_id+' before publishing production.');
    if(s.includeProduction&&!s.includePreview&&!p)throw new Error('There is no production version to retain for '+s.demo_id+'. Include it in preview and update preview first.');
    return {demo_id:s.demo_id,title:catalog.filter(function(c){return c.demo_id===s.demo_id;})[0].title,
      action:!s.includeProduction?(p?'Remove':'Not included'):(s.includePreview?(p?'Use reviewed preview':'Add'):'Keep current production')};
  });
  var review={schema:1,id:Utilities.getUuid(),created_at:new Date().toISOString(),site_id:SANDBOX.site_id,
    baseline_production_deploy:prod.deploy_id,reviewed_preview_deploy:prev.deploy_id,
    reviewed_preview_revision:prev.registry_revision,preview_stale:prev.stale===true,selection:selection,changes:changes};
  registryPublishingSave_(REGISTRY_PUBLISHING.reviewProperty,review);
  var summary=registryPublishingSummary_(prev);
  return {id:review.id,changes:changes,production_enabled:summary.production_enabled,production_disabled_reason:summary.production_disabled_reason};
}
/** No production transport is installed implicitly. Its reviewed bridge is separate
 * from the existing develop hook, which remains guarded against production builds.
 */
function registryPublishingConfirmProduction(reviewId) {
  var review=registryPublishingStored_(REGISTRY_PUBLISHING.reviewProperty);
  var age=review?Date.now()-Date.parse(review.created_at):NaN;
  if(!review||review.id!==reviewId||!Number.isFinite(age)||age<0||age>15*60*1000)throw new Error('Release review expired. Review the changes again.');
  var p=PropertiesService.getScriptProperties(),url=p.getProperty('AIS_PRODUCTION_RELEASE_BRIDGE_URL');
  if(!url)throw new Error('Production publishing is not connected. The release review is ready; main and production are unchanged.');
  if(url!=='https://develop--aisigym.netlify.app/.netlify/functions/registry-production-release')throw new Error('Unexpected production release bridge.');
  var current=registryPublishingSelection_();
  if(V3.stable(current)!==V3.stable(review.selection))throw new Error('Selection changed. Review the changes again.');
  var currentPreview=registryPublishingRefreshPreview_();
  if(review.preview_stale||!currentPreview.known||currentPreview.stale)
    throw new Error('The preview deployment has not been freshly verified. Refresh through an authenticated connection and review the release again.');
  var prod=registryPublishingRefreshProduction_(),state=previewState_();
  if(prod.deploy_id!==review.baseline_production_deploy||state.phase!=='ready'||state.deploy_id!==review.reviewed_preview_deploy)throw new Error('A deployment changed. Review the changes again.');
  var secret=p.getProperty('AI4S_PREVIEW_CALLBACK_SECRET');if(!secret)throw new Error('The signed release bridge is not configured.');
  var payload=JSON.stringify({event:'production_release_confirmed',review:review});
  var signature=Utilities.computeHmacSha256Signature('production-release-v1\n'+payload,secret).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
  // The bridge must check the pinned baseline, expiry and nonce, and create a draft
  // before publishing. A timeout is not retried automatically.
  p.deleteProperty(REGISTRY_PUBLISHING.reviewProperty);
  var response=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify({payload:payload,signature:signature}),muteHttpExceptions:true});
  if(response.getResponseCode()!==202)throw new Error('Production request was not confirmed. Check deployment status before retrying.');
  return {message:'Production release requested. Refresh status after the deployment completes.'};
}
function registryPublishingUpdatePreviewFromMenu(){var s=registryPublishingUpdatePreview();registryUiSpreadsheet_().toast(s.preview_state,'AIS Control',8);}
function registryPublishingRefreshStatusFromMenu(){registryPublishingRefreshStatus();registryUiSpreadsheet_().toast('Project deployment states refreshed.','AIS Control',8);}
function registryPublishingReviewProductionFromMenu(){registryUiOpenSidebar();}
