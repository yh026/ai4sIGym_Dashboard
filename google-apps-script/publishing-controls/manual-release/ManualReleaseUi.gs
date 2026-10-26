/** Manual release orchestration. Only Confirm invokes the production hook. */
function registryManualSelection_() {
  return registryPublishingSelection_().map(function(s) {
    return {demo_id:s.demo_id,include_in_production:s.includeProduction,include_in_preview:s.includePreview};
  });
}
function registryManualProperty_(name) { return PropertiesService.getScriptProperties().getProperty(name); }
function registryManualVerifyReceipt_(receipt,environment) {
  if(environment==='production'&&receipt&&['manual-build','develop-promotion'].indexOf(receipt.publication_method)!==-1) {
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
  var review=id?registryReleaseStoreGetReview_(id):null;
  return review&&review.schema===2?review:null;
}

function registryManualPendingRequest_() {
  var id=registryManualProperty_('AIS_RELEASE_ACTIVE_REQUEST_ID');
  return id ? registryReleaseStoreGetRequest_(id) : null;
}
function registryManualConfigured_() {
  return !!registryManualProperty_('AIS_RELEASE_ROOT_FOLDER_ID')&&!!registryManualProperty_('AI4S_PREVIEW_CALLBACK_SECRET')
    &&/^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(registryManualProperty_('AIS_RELEASE_PRODUCTION_HOOK')||'');
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
  return !capsule||!capsule.complete||!proof.renderer_digest||!proof.project_snapshots||proof.deploy_id!==state.deploy_id
    ||proof.request_id!==state.request_id||proof.registry_revision!==state.revision;
}
function registryManualCatalog_() {
  return registryPublishingCatalog_().map(function(c){return Object.assign({},c,{slug:c.demo_id.replace(/^demo-/,'')});});
}
function registryManualChangeRows_(review) { return review&&review.changes||[]; }
function registryManualChanges_(baseline,preview,selection,catalog) {
  var proof=preview.provenance,overrides=baseline.receipt.publication_overrides||[];
  var hidden=overrides.some(function(o){return o.id==='hide-tbb-notebook-resources-v1';});
  var next=proof.project_snapshots&&proof.project_snapshots[hidden?'without_tbb_resources':'standard'];
  var previous=baseline.receipt.projects;
  if(!Array.isArray(next)||!Array.isArray(previous)||!/^sha256:[a-f0-9]{64}$/.test(proof.renderer_digest||''))
    throw new Error('Update preview once to prepare its verified publication metadata.');
  var changes=selection.map(function(s){
    var old=previous.filter(function(p){return p.demo_id===s.demo_id;})[0];
    var source=(s.include_in_preview?next:previous).filter(function(p){return p.demo_id===s.demo_id;})[0];
    if(s.include_in_production&&!source)throw new Error(s.include_in_preview?
      'Update preview with '+s.demo_id+' before publishing.':'No production version exists for '+s.demo_id+'. Update preview first.');
    var item=catalog.filter(function(c){return c.demo_id===s.demo_id;})[0];
    var action=!s.include_in_production?(old?'Remove':'Not included'):!old?'Add':
      source.content_digest===old.content_digest?'Keep':'Update';
    return {demo_id:s.demo_id,title:item.title,action:action};
  });
  if(baseline.receipt.renderer_digest!==proof.renderer_digest)
    changes.push({demo_id:'site-layout',title:'Website layout',action:'Update'});
  return changes;
}

function registryManualReviewReason_(review) {
  if(!review||review.schema!==2||review.phase!=='ready')return 'Prepare a publication confirmation first.';
  if(!Number.isFinite(Date.parse(review.expires_at))||Date.now()>=Date.parse(review.expires_at))return 'This confirmation expired. Prepare it again.';
  if(review.confirmation_digest!==registryReleaseStoreConfirmationDigest_(review))return 'This confirmation changed. Prepare it again.';
  if(V3.stable(registryManualSelection_())!==V3.stable(review.selection))return 'Selection changed. Prepare the confirmation again.';
  if(V3.stable(registryManualCatalog_())!==V3.stable(review.catalog))return 'Project details changed. Prepare the confirmation again.';
  var production=registryReleaseStoreGetActive_('production'),preview=registryReleaseStoreGetActive_('preview'),state=previewState_();
  if(!production||production.id!==review.baseline_capsule_id)return 'Production changed. Prepare the confirmation again.';
  if(!preview||preview.id!==review.preview_capsule_id||state.phase!=='ready'||state.deploy_id!==review.preview_deploy_id
    ||state.request_id!==preview.provenance.request_id||state.revision!==preview.provenance.registry_revision)
    return 'Preview changed. Prepare the confirmation again.';
  var pending=registryManualPendingRequest_();
  if(pending&&['requested','claimed'].indexOf(pending.phase)!==-1)return 'A production release is already in progress.';
  if(!registryManualChangeRows_(review).some(function(c){return ['Add','Update','Remove'].indexOf(c.action)!==-1;}))
    return 'No production changes to publish.';
  return '';
}

function registryManualReviewView_(review) {
  if(!review||review.schema!==2)return null;
  var changes=registryManualChangeRows_(review),reason=registryManualReviewReason_(review);
  return {id:review.id,phase:Date.parse(review.expires_at)<=Date.now()?'expired':'ready',changes:changes,
    change_count:changes.filter(function(c){return ['Add','Update','Remove'].indexOf(c.action)!==-1;}).length,
    preview_url:'https://develop--aisigym.netlify.app/',preview_deploy_id:review.preview_deploy_id,
    production_enabled:registryManualConfigured_()&&!reason,production_disabled_reason:reason};
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
    production_disabled_reason:registryManualConfigured_()?(view&&view.production_disabled_reason||'Confirm the develop version before publishing.'):'Publishing is not connected.',
    review:view};
}
function registryManualHook_(request) {
  if(request.kind!=='production'||request.schema!==2)throw new Error('Only a confirmed production request can invoke a hook.');
  var hook=registryManualProperty_('AIS_RELEASE_PRODUCTION_HOOK'),secret=registryManualProperty_('AI4S_PREVIEW_CALLBACK_SECRET');
  if(!/^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]+$/.test(hook||'')||!secret)
    throw new Error('The manual build connection is not configured.');
  var data={schema:2,target:'production',site_id:SANDBOX.site_id,branch:'main',
    review_id:request.review_id,request_id:request.id,requested_at:request.created_at,expires_at:request.expires_at,
    preview_capsule_id:request.preview_capsule_id,confirmation_digest:request.confirmation_digest,baseline_deploy_id:request.baseline_deploy_id};
  var payload=JSON.stringify(data),signature=Utilities.computeHmacSha256Signature('ais-manual-release-hook-v1\n'+payload,secret)
    .map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
  // The durable decision precedes HTTP. Never retry an uncertain response.
  var response=UrlFetchApp.fetch(hook+'?trigger_branch=main',
    {method:'post',contentType:'application/json',payload:JSON.stringify({payload:payload,signature:signature}),muteHttpExceptions:true});
  if(response.getResponseCode()<200||response.getResponseCode()>=300)
    throw new Error('The build request was not acknowledged. Check its status before retrying.');
}

/** Prepares a confirmation from immutable metadata. This never invokes a build. */
function registryManualReviewProduction() {
  if(!registryManualConfigured_())throw new Error('Publishing is not connected.');
  var review=locked_(function(){
    var active=registryManualPendingRequest_();
    if(active&&['requested','claimed'].indexOf(active.phase)!==-1)throw new Error('A production release is already in progress.');
    var baseline=registryManualBaseline_(),preview=registryManualPreview_(),selection=registryManualSelection_(),catalog=registryManualCatalog_();
    var now=new Date().toISOString();
    var value={id:Utilities.getUuid(),schema:2,site_id:SANDBOX.site_id,created_at:now,
      expires_at:new Date(Date.parse(now)+30*60*1000).toISOString(),phase:'ready',selection:selection,catalog:catalog,
      baseline_capsule_id:baseline.capsule.id,preview_capsule_id:preview.id,
      baseline_deploy_id:baseline.receipt.deploy_id,preview_deploy_id:preview.provenance.deploy_id,
      renderer_digest:preview.provenance.renderer_digest,changes:registryManualChanges_(baseline,preview,selection,catalog)};
    value.confirmation_digest=registryReleaseStoreConfirmationDigest_(value);
    registryReleaseStoreCreateReview_(value);
    PropertiesService.getScriptProperties().setProperty('AIS_RELEASE_CURRENT_REVIEW_ID',value.id);
    return value;
  });
  return registryManualReviewView_(review);
}

function registryManualConfirmProduction(reviewId) {
  if(!registryManualConfigured_())throw new Error('Publishing is not connected.');
  var request=locked_(function(){
    var review=registryManualCurrentReview_();
    if(!review||review.id!==reviewId)throw new Error('Prepare the publication confirmation again.');
    var reason=registryManualReviewReason_(review);if(reason)throw new Error(reason);
    var baseline=registryManualBaseline_();
    if(baseline.receipt.deploy_id!==review.baseline_deploy_id)throw new Error('Production changed. Prepare the confirmation again.');
    if(registryManualPreview_().id!==review.preview_capsule_id)throw new Error('Preview changed. Prepare the confirmation again.');
    var now=new Date().toISOString(),r={id:Utilities.getUuid(),schema:2,kind:'production',review_id:review.id,
      created_at:now,expires_at:new Date(Date.parse(now)+15*60*1000).toISOString(),phase:'requested',branch:'main',target:'production',
      preview_capsule_id:review.preview_capsule_id,confirmation_digest:review.confirmation_digest,baseline_deploy_id:review.baseline_deploy_id};
    registryReleaseStoreCreateRequest_(r);
    PropertiesService.getScriptProperties().setProperty('AIS_RELEASE_ACTIVE_REQUEST_ID',r.id);
    return r;
  });
  registryManualHook_(request);
  return {message:'Production release requested. Refresh status after the deployment completes.'};
}
