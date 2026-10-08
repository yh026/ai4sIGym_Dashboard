/** Manual release orchestration. Only Confirm invokes the production hook. */
function registryManualSelection_() {
  return registryPublishingSelection_().map(function(s) {
    return {demo_id:s.demo_id,include_in_production:s.includeProduction,include_in_preview:s.includePreview};
  });
}
function registryManualProperty_(name) { return PropertiesService.getScriptProperties().getProperty(name); }
function registryManualVerifyReceipt_(receipt,environment) {
  if(environment==='production'&&receipt&&receipt.publication_method==='manual-build') {
    if(receipt.schema!==1||receipt.verified!==true||receipt.target!=='production'||receipt.audience!=='production'
      ||receipt.platform!=='netlify'||receipt.site_id!==SANDBOX.site_id||receipt.branch!=='main'||receipt.context!=='production'
      ||!/^[a-f0-9]{24}$/.test(receipt.deploy_id||'')||!/^[a-f0-9]{40}$/.test(receipt.commit_ref||'')
      ||!/^sha256:[a-f0-9]{64}$/.test(receipt.reviewed_artifact_digest||'')||!receipt.request_id||!receipt.review_id)
      throw new Error('The production receipt is not a confirmed manual release.');
    return;
  }
  return registryPublishingLegacyVerifyReceipt_(receipt,environment);
}
function registryManualRefreshPreview_() {
  var state=previewState_(),capsule=registryReleaseStoreGetActive_('preview');
  if(capsule&&capsule.complete&&state.phase==='ready'&&capsule.provenance.deploy_id===state.deploy_id
    &&capsule.provenance.request_id===state.request_id&&capsule.provenance.registry_revision===state.revision) {
    var value=registryPublishingSignedPreview_(state,capsule.activated_at||state.ready_at,true);
    if(value){value.source='signed_artifact';value.warning='';registryPublishingSave_(REGISTRY_PUBLISHING.previewProperty,value);return value;}
  }
  return registryPublishingLegacyRefreshPreview_();
}
function registryManualEnrichStatus_(status) {
  status.publishing=registryManualSummary_();
  status.automation='Manual updates only';
  return status;
}
function registryManualWritePanel_(status) {
  var panel=registryPublishingPanel_(),summary=status.publishing||registryManualSummary_();
  panel.getRange('A6').setValue(status.preview_state||'Not checked');
  panel.getRange('E6').setValue(status.production_warning?'Check status':summary.production_state);
  panel.getRange('I6').setValue(summary.pending?summary.pending+' project selections':'No selection changes');
  var error=status.last_error||status.production_warning||'';
  panel.getRange('A7').setValue(error?registryUiMessage_(error):'');
  return status;
}
function registryManualCurrentReview_() {
  var id=registryManualProperty_('AIS_RELEASE_CURRENT_REVIEW_ID');
  return id ? registryReleaseStoreGetReview_(id) : null;
}
function registryManualPendingRequest_() {
  var id=registryManualProperty_('AIS_RELEASE_ACTIVE_REQUEST_ID');
  return id ? registryReleaseStoreGetRequest_(id) : null;
}
function registryManualConfigured_() {
  return !!registryManualProperty_('AIS_RELEASE_ROOT_FOLDER_ID')&&!!registryManualProperty_('AI4S_PREVIEW_CALLBACK_SECRET')
    &&/^sha256:[a-f0-9]{64}$/.test(registryManualProperty_('AIS_RELEASE_RENDERER_DIGEST')||'')
    &&['AIS_RELEASE_REVIEW_HOOK','AIS_RELEASE_PRODUCTION_HOOK'].every(function(k){
      return /^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(registryManualProperty_(k)||'');});
}
function registryManualBaseline_() {
  var receipt=registryPublishingJson_(REGISTRY_UI.productionReceiptUrl);
  registryPublishingVerifyReceipt_(receipt,'production');
  var capsule=registryReleaseStoreGetActive_('production');
  if(!capsule||!capsule.complete||capsule.provenance.deploy_id!==receipt.deploy_id)
    throw new Error('The production artifact needs reconciliation before another release.');
  return {receipt:receipt,capsule:capsule};
}
function registryManualPreview_() {
  var state=previewState_(),capsule=registryReleaseStoreGetActive_('preview');
  if(state.phase!=='ready'||!capsule||!capsule.complete||capsule.provenance.deploy_id!==state.deploy_id
    ||capsule.provenance.request_id!==state.request_id||capsule.provenance.registry_revision!==state.revision)
    throw new Error('Update preview first and wait for its artifact to finish saving.');
  return capsule;
}
/** Only the explicit Update preview action requests this check under the build lock. */
function registryManualNeedsPreviewArtifact_(state,revision) {
  if(!state||state.phase!=='ready'||state.revision!==revision)return false;
  var capsule=registryReleaseStoreGetActive_('preview'),proof=capsule&&capsule.provenance||{};
  return !capsule||!capsule.complete||proof.deploy_id!==state.deploy_id
    ||proof.request_id!==state.request_id||proof.registry_revision!==state.revision;
}
function registryManualChangeRows_(review) {
  if(!review||!review.plan)return [];
  var changes=(review.plan.projects||[]).concat((review.plan.removals||[]).map(function(r){return Object.assign({},r,{action:'remove'});}));
  return changes.map(function(change){
    var item=review.catalog.filter(function(c){return c.demo_id===change.demo_id;})[0]||{};
    var action=String(change.action||change.kind||'');
    return {demo_id:change.demo_id,title:item.title||change.demo_id,
      action:({add:'Add',update:'Update',remove:'Remove',retain:'Keep',keep:'Keep',unchanged:'Unchanged'})[action]||action};
  });
}
function registryManualReviewReason_(review) {
  if(!review||review.phase!=='ready')return 'Wait for the release preview to finish.';
  var deadline=Math.min(Date.parse(review.expires_at),Date.parse(review.ready_at)+30*60*1000,
    Date.parse(review.plan&&review.plan.expires_at||review.expires_at));
  if(!Number.isFinite(deadline)||Date.now()>deadline)return 'This review expired. Review the changes again.';
  if(V3.stable(registryManualSelection_())!==V3.stable(review.selection))return 'Selection changed. Review the changes again.';
  var production=registryReleaseStoreGetActive_('production'),preview=registryReleaseStoreGetActive_('preview');
  if(!production||production.id!==review.baseline_capsule_id)return 'Production changed. Review the changes again.';
  if(!preview||preview.id!==review.preview_capsule_id)return 'Preview changed. Review the changes again.';
  var pending=registryManualPendingRequest_();
  if(pending&&['requested','claimed'].indexOf(pending.phase)!==-1)return 'A production release is already in progress.';
  if(!registryManualChangeRows_(review).some(function(c){return ['Add','Update','Remove'].indexOf(c.action)!==-1;}))
    return 'No production changes to publish.';
  return '';
}
function registryManualReviewView_(review) {
  if(!review)return null;
  var changes=registryManualChangeRows_(review),reason=registryManualReviewReason_(review);
  var phase=({requested:'preparing',prepared:'preparing',ready:'ready',failed:'failed',published:'published'})[review.phase]||'preparing';
  if(phase==='preparing'&&Date.parse(review.expires_at)<=Date.now()) {
    phase='expired';reason='This review expired. Review the changes again.';
  }
  return {id:review.id,phase:phase,changes:changes,
    change_count:changes.filter(function(c){return ['Add','Update','Remove'].indexOf(c.action)!==-1;}).length,
    preview_url:review.review_deploy_id?'https://'+review.review_deploy_id+'--aisigym.netlify.app/':'',
    production_enabled:registryManualConfigured_()&&!reason,production_disabled_reason:reason,
    message:phase==='preparing'?'Preparing the release preview. Refresh status when it is ready.':'',
    error:review.error?registryUiMessage_(review.error):''};
}
function registryManualSummary_() {
  var selected=registryPublishingSelection_(),rows=registryPublishingState_().getRange(2,1,13,11).getValues();
  var pending=selected.filter(function(s){var r=rows.filter(function(x){return x[0]===s.demo_id;})[0];
    return r&&(r[1]!=='Not checked'&&s.includeProduction!==(r[1]==='Published')||r[2]!=='Not checked'&&s.includePreview!==(r[2]==='Published'));});
  var review=registryManualCurrentReview_(),request=registryManualPendingRequest_();
  var phase=request&&request.phase||'';
  var state=({requested:'Publishing requested',claimed:'Publishing',succeeded:'Published',failed:'Publish failed'})[phase]
    ||(registryManualProperty_('AIS_RELEASE_ACTIVE_PRODUCTION_CAPSULE_ID')?'Published':'Not connected');
  var view=registryManualReviewView_(review);
  return {pending:pending.length,production:selected.filter(function(s){return s.includeProduction;}).length,
    preview:selected.filter(function(s){return s.includePreview;}).length,
    production_state:state,production_phase:phase==='claimed'?'publishing':phase,
    production_error:phase==='failed'&&request.error?registryUiMessage_(request.error):'',
    production_enabled:!!(view&&view.production_enabled),
    production_disabled_reason:registryManualConfigured_()?(view&&view.production_disabled_reason||'Review changes before publishing.'):'Publishing is not connected.',
    review:view};
}
function registryManualHook_(request) {
  var property=request.kind==='production'?'AIS_RELEASE_PRODUCTION_HOOK':'AIS_RELEASE_REVIEW_HOOK';
  var hook=registryManualProperty_(property),secret=registryManualProperty_('AI4S_PREVIEW_CALLBACK_SECRET');
  if(!/^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(hook||'')||!secret)
    throw new Error('The manual build connection is not configured.');
  var data={schema:1,target:request.target,site_id:SANDBOX.site_id,branch:request.branch,
    review_id:request.review_id,request_id:request.id,requested_at:request.created_at,expires_at:request.expires_at};
  ['candidate_capsule_id','artifact_digest','baseline_deploy_id'].forEach(function(k){if(request[k])data[k]=request[k];});
  var payload=JSON.stringify(data),signature=Utilities.computeHmacSha256Signature('ais-manual-release-hook-v1\n'+payload,secret)
    .map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
  // The durable request is created before HTTP. Never retry an uncertain response.
  var response=UrlFetchApp.fetch(hook+'?trigger_branch='+encodeURIComponent(request.branch),
    {method:'post',contentType:'application/json',payload:JSON.stringify({payload:payload,signature:signature}),muteHttpExceptions:true});
  if(response.getResponseCode()<200||response.getResponseCode()>=300)
    throw new Error('The build request was not acknowledged. Check its status before retrying.');
}
function registryManualReviewProduction() {
  if(!registryManualConfigured_())throw new Error('Publishing is not connected.');
  var prepared=locked_(function(){
    var active=registryManualPendingRequest_();
    if(active&&['requested','claimed'].indexOf(active.phase)!==-1)throw new Error('A production release is already in progress.');
    var existing=registryManualCurrentReview_();
    if(existing&&['requested','prepared'].indexOf(existing.phase)!==-1&&Date.parse(existing.expires_at)>Date.now())
      return {existing:existing};
    var baseline=registryManualBaseline_(),preview=registryManualPreview_();
    var now=new Date().toISOString(),id=Utilities.getUuid(),requestId=Utilities.getUuid();
    var review={id:id,schema:1,site_id:SANDBOX.site_id,created_at:now,expires_at:new Date(Date.parse(now)+2*60*60*1000).toISOString(),
      phase:'requested',request_id:requestId,selection:registryManualSelection_(),catalog:registryPublishingCatalog_().map(function(c){
        return Object.assign({},c,{slug:c.demo_id.replace(/^demo-/,'')});}),
      baseline_capsule_id:baseline.capsule.id,preview_capsule_id:preview.id,
      baseline_deploy_id:baseline.receipt.deploy_id,preview_deploy_id:preview.provenance.deploy_id,
      renderer_digest:registryManualProperty_('AIS_RELEASE_RENDERER_DIGEST')};
    registryReleaseStoreCreateReview_(review);
    var request={id:requestId,kind:'review',review_id:id,created_at:now,expires_at:new Date(Date.parse(now)+30*60*1000).toISOString(),
      phase:'requested',branch:'codex/manual-production-review',target:'production-review',baseline_deploy_id:review.baseline_deploy_id};
    registryReleaseStoreCreateRequest_(request);
    PropertiesService.getScriptProperties().setProperty('AIS_RELEASE_CURRENT_REVIEW_ID',id);
    return {review:review,request:request};
  });
  if(prepared.existing)return registryManualReviewView_(prepared.existing);
  registryManualHook_(prepared.request);
  return registryManualReviewView_(prepared.review);
}
function registryManualConfirmProduction(reviewId) {
  if(!registryManualConfigured_())throw new Error('Publishing is not connected.');
  var request=locked_(function(){
    var review=registryManualCurrentReview_();
    if(!review||review.id!==reviewId)throw new Error('Review the changes again.');
    var reason=registryManualReviewReason_(review);if(reason)throw new Error(reason);
    var baseline=registryManualBaseline_();
    if(baseline.receipt.deploy_id!==review.baseline_deploy_id)throw new Error('Production changed. Review the changes again.');
    if(registryManualPreview_().id!==review.preview_capsule_id)throw new Error('Preview changed. Review the changes again.');
    var now=new Date().toISOString(),r={id:Utilities.getUuid(),kind:'production',review_id:review.id,
      created_at:now,expires_at:new Date(Date.parse(now)+15*60*1000).toISOString(),phase:'requested',branch:'main',target:'production',
      candidate_capsule_id:review.candidate_capsule_id,artifact_digest:review.artifact_digest,baseline_deploy_id:review.baseline_deploy_id};
    registryReleaseStoreCreateRequest_(r);
    PropertiesService.getScriptProperties().setProperty('AIS_RELEASE_ACTIVE_REQUEST_ID',r.id);
    return r;
  });
  registryManualHook_(request);
  return {message:'Production release requested. Refresh status after the deployment completes.'};
}
