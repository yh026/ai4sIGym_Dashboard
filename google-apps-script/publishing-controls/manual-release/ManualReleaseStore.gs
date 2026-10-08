/** Immutable, signed build capsules. Only server-side UI functions create requests.
 * This API stores artifacts and acknowledgements; it never invokes a build hook.
 */
var AIS_RELEASE_STORE = { schema: 1, chunkSize: 8388608, maxChunks: 256,
  maxEnvelope: 11300000, rootProperty: 'AIS_RELEASE_ROOT_FOLDER_ID',
  activePreview: 'AIS_RELEASE_ACTIVE_PREVIEW_CAPSULE_ID',
  activeProduction: 'AIS_RELEASE_ACTIVE_PRODUCTION_CAPSULE_ID' };

function registryReleaseStoreNeed_(condition, message) {
  if (!condition) { var error = new Error(message); error.releaseStoreSafe = true; throw error; }
}
function registryReleaseStoreWithLock_(fn) {
  try { return locked_(fn); }
  catch (error) {
    if (error && error.message === 'Another sandbox operation is running') {
      var busy = new Error('Release metadata is busy. Retry only the same artifact operation.');
      busy.releaseStoreSafe = true; busy.releaseStoreCode = 'release_busy'; throw busy;
    }
    throw error;
  }
}
function registryReleaseStoreClone_(value) { return JSON.parse(JSON.stringify(value)); }
function registryReleaseStoreStable_(value) {
  if (Array.isArray(value)) return '[' + value.map(registryReleaseStoreStable_).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function(k) {
    return JSON.stringify(k) + ':' + registryReleaseStoreStable_(value[k]);
  }).join(',') + '}';
  return JSON.stringify(value);
}
function registryReleaseStoreId_(value) {
  registryReleaseStoreNeed_(typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value), 'Invalid release identity.'); return value;
}
function registryReleaseStoreHash_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function(b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}
function registryReleaseStoreRoot_() {
  var id = PropertiesService.getScriptProperties().getProperty(AIS_RELEASE_STORE.rootProperty);
  registryReleaseStoreNeed_(!!id, 'Release storage is not configured.'); return DriveApp.getFolderById(id);
}
function registryReleaseStoreFile_(folder, name) {
  var files = folder.getFilesByName(name), file = files.hasNext() ? files.next() : null;
  registryReleaseStoreNeed_(!files.hasNext(), 'Release storage contains an ambiguous record.'); return file;
}
function registryReleaseStoreRecord_(type, id) {
  registryReleaseStoreId_(id);
  var file = registryReleaseStoreFile_(registryReleaseStoreRoot_(), type + '-' + id + '.json');
  return file ? JSON.parse(file.getBlob().getDataAsString('UTF-8')) : null;
}
function registryReleaseStoreWrite_(type, record, createOnly) {
  registryReleaseStoreId_(record.id);
  var root = registryReleaseStoreRoot_(), name = type + '-' + record.id + '.json';
  var file = registryReleaseStoreFile_(root, name), text = JSON.stringify(record);
  registryReleaseStoreNeed_(text.length <= 2000000, 'Release metadata exceeds its limit.');
  registryReleaseStoreNeed_(!createOnly || !file, 'Release identity already exists.');
  if (file) file.setContent(text); else root.createFile(Utilities.newBlob(text, 'application/json', name));
  return registryReleaseStoreClone_(record);
}
function registryReleaseStoreExpiry_(record) {
  registryReleaseStoreNeed_(record && Number.isFinite(Date.parse(record.expires_at)) &&
    Date.parse(record.expires_at) > Date.now(), 'Release request expired. Review the changes again.');
}
function registryReleaseStoreCreateReview_(review) {
  registryReleaseStoreNeed_(review && review.schema === 1 && review.site_id === SANDBOX.site_id &&
    review.phase === 'requested' && Array.isArray(review.selection) && Array.isArray(review.catalog), 'Invalid release review.');
  ['id', 'request_id', 'baseline_capsule_id', 'preview_capsule_id'].forEach(function(k) { registryReleaseStoreId_(review[k]); });
  registryReleaseStoreExpiry_(review);
  return registryReleaseStoreWrite_('review', review, true);
}
function registryReleaseStoreGetReview_(id) { return registryReleaseStoreRecord_('review', id); }
function registryReleaseStoreSaveReview_(review) {
  var old = registryReleaseStoreGetReview_(review.id); registryReleaseStoreNeed_(!!old, 'Release review is missing.');
  ['id','schema','created_at','expires_at','site_id','selection','catalog','baseline_capsule_id',
    'preview_capsule_id','baseline_deploy_id','preview_deploy_id','renderer_digest','request_id'].forEach(function(k) {
    registryReleaseStoreNeed_(registryReleaseStoreStable_(old[k]) === registryReleaseStoreStable_(review[k]), 'Release review identity changed.');
  });
  return registryReleaseStoreWrite_('review', review, false);
}
function registryReleaseStoreCreateRequest_(request) {
  registryReleaseStoreNeed_(request && ['review','production'].indexOf(request.kind) !== -1 && request.phase === 'requested', 'Invalid release request.');
  var review = registryReleaseStoreGetReview_(request.review_id); registryReleaseStoreNeed_(!!review, 'Release review is missing.');
  registryReleaseStoreExpiry_(request); registryReleaseStoreExpiry_(review);
  registryReleaseStoreNeed_(request.baseline_deploy_id === review.baseline_deploy_id &&
    request.branch === (request.kind === 'review' ? 'codex/manual-production-review' : 'main') &&
    request.target === (request.kind === 'review' ? 'production-review' : 'production'), 'Release request identity mismatch.');
  if (request.kind === 'review') registryReleaseStoreNeed_(request.id === review.request_id, 'Review request mismatch.');
  else registryReleaseStoreNeed_(review.phase === 'ready' && request.candidate_capsule_id === review.candidate_capsule_id &&
    request.artifact_digest === review.artifact_digest, 'Production must use the ready reviewed artifact.');
  // No API action calls this helper. Creation therefore records the explicit UI decision.
  var saved = registryReleaseStoreClone_(request); saved.ui_created = true;
  return registryReleaseStoreWrite_('request', saved, true);
}
function registryReleaseStoreGetRequest_(id) { return registryReleaseStoreRecord_('request', id); }
function registryReleaseStoreSaveRequest_(request) {
  var old = registryReleaseStoreGetRequest_(request.id); registryReleaseStoreNeed_(!!old, 'Release request is missing.');
  ['id','kind','review_id','created_at','expires_at','branch','target','baseline_deploy_id',
    'candidate_capsule_id','artifact_digest','ui_created'].forEach(function(k) {
    registryReleaseStoreNeed_(registryReleaseStoreStable_(old[k]) === registryReleaseStoreStable_(request[k]), 'Release request identity changed.');
  });
  ['owner','production_capsule_id'].forEach(function(k) {
    if (old[k]) registryReleaseStoreNeed_(registryReleaseStoreStable_(old[k]) === registryReleaseStoreStable_(request[k]), 'Claimed release output identity changed.');
  });
  return registryReleaseStoreWrite_('request', request, false);
}
function registryReleaseStoreIdentity_(payload) {
  registryReleaseStoreNeed_(payload && payload.schema === 1 && payload.site_id === SANDBOX.site_id &&
    Number.isFinite(Date.parse(payload.sent_at)) && Math.abs(Date.now() - Date.parse(payload.sent_at)) <= 900000 &&
    /^[a-f0-9]{24}$/.test(payload.deploy_id || '') && /^[a-f0-9]{40}$/.test(payload.commit_ref || '') &&
    typeof payload.build_id === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(payload.build_id) &&
    typeof payload.branch === 'string' && typeof payload.context === 'string', 'Invalid or expired release message.');
  return {site_id:payload.site_id,build_id:payload.build_id,deploy_id:payload.deploy_id,
    commit_ref:payload.commit_ref,branch:payload.branch,context:payload.context};
}
function registryReleaseStoreOwner_(record, payload) {
  registryReleaseStoreNeed_(record && record.owner && registryReleaseStoreStable_(record.owner) ===
    registryReleaseStoreStable_(registryReleaseStoreIdentity_(payload)), 'Release build identity mismatch.');
}
function registryReleaseStoreRequestFor_(payload, kind, claim, reconciled) {
  var request = registryReleaseStoreGetRequest_(payload.request_id), review = registryReleaseStoreGetReview_(payload.review_id);
  registryReleaseStoreNeed_(request && review && request.ui_created === true && request.kind === kind &&
    request.review_id === review.id && payload.branch === request.branch &&
    payload.context === (kind === 'review' ? 'branch-deploy' : 'production'), 'Release request identity mismatch.');
  if (claim) {
    registryReleaseStoreExpiry_(request); registryReleaseStoreExpiry_(review);
    registryReleaseStoreNeed_(request.phase === 'requested' || request.phase === 'claimed', 'Release request cannot be claimed.');
    if (request.phase === 'claimed') registryReleaseStoreOwner_(request, payload);
    else { request.phase = 'claimed'; request.claimed_at = new Date().toISOString(); request.owner = registryReleaseStoreIdentity_(payload);
      registryReleaseStoreSaveRequest_(request); }
  } else { registryReleaseStoreNeed_(request.phase === 'claimed' || request.phase === 'succeeded', 'Release request has not been claimed.');
    registryReleaseStoreNeed_(Number.isFinite(Date.parse(request.claimed_at)) && (reconciled === true || Date.now() - Date.parse(request.claimed_at) <= 7200000),
      'Claimed release build expired.'); registryReleaseStoreOwner_(request, payload); }
  return {request:request,review:review};
}
function registryReleaseStoreCapsuleValue_(record) {
  if (!record) return null;
  var value = registryReleaseStoreClone_(record.capsule); value.complete = record.phase === 'complete';
  if (record.receipt) value.receipt = registryReleaseStoreClone_(record.receipt);
  if (record.activated_at) value.activated_at = record.activated_at;
  return value;
}
function registryReleaseStoreGetCapsule_(id) {
  return registryReleaseStoreCapsuleValue_(registryReleaseStoreRecord_('capsule', id));
}
function registryReleaseStoreGetActive_(kind) {
  registryReleaseStoreNeed_(['preview','production'].indexOf(kind) !== -1, 'Invalid release environment.');
  var id = PropertiesService.getScriptProperties().getProperty(kind === 'preview' ? AIS_RELEASE_STORE.activePreview : AIS_RELEASE_STORE.activeProduction);
  return id ? registryReleaseStoreGetCapsule_(id) : null;
}
function registryReleaseStoreBootstrap_(payload) {
  var props = PropertiesService.getScriptProperties(), deploy = props.getProperty('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY');
  var owner = props.getProperty('AIS_RELEASE_BOOTSTRAP_UPLOADER');
  return !!deploy && !!owner && payload.deploy_id === deploy && payload.branch === 'main' && payload.context === 'production' &&
    registryReleaseStoreStable_(JSON.parse(owner)) === registryReleaseStoreStable_(registryReleaseStoreIdentity_(payload));
}
function registryReleaseStoreAuthorizeUpload_(payload, kind) {
  if (kind === 'preview') {
    var state = previewState_();
    registryReleaseStoreNeed_(payload.branch === 'develop' && payload.context === 'branch-deploy' &&
      ['requested','accepted','ready'].indexOf(state.phase) !== -1 && payload.request_id === state.request_id,
      'Preview request identity mismatch.');
    if (state.phase === 'ready') registryReleaseStoreNeed_(state.deploy_id === payload.deploy_id, 'Preview deployment changed.');
    return;
  }
  if (kind === 'production' && registryReleaseStoreBootstrap_(payload)) return;
  var pair = registryReleaseStoreRequestFor_(payload, kind === 'candidate' ? 'review' : 'production', false);
  registryReleaseStoreNeed_(pair.request.phase === 'claimed', 'Release artifact is already finalized.');
}
function registryReleaseStoreCapsuleShape_(capsule, payload) {
  registryReleaseStoreNeed_(capsule && ['preview','candidate','production'].indexOf(capsule.kind) !== -1, 'Invalid release artifact.');
  registryReleaseStoreId_(capsule.id);
  registryReleaseStoreNeed_(/^[a-f0-9]{64}$/.test(capsule.archive_sha256 || '') &&
    /^sha256:[a-f0-9]{64}$/.test(capsule.inventory_digest || '') && Number.isSafeInteger(capsule.archive_size) &&
    capsule.archive_size > 0 && capsule.archive_size <= 268435456 && Number.isSafeInteger(capsule.unpacked_size) &&
    capsule.unpacked_size > 0 && capsule.unpacked_size <= 268435456 &&
    capsule.chunk_size === AIS_RELEASE_STORE.chunkSize && Array.isArray(capsule.chunks) &&
    capsule.chunks.length > 0 && capsule.chunks.length <= AIS_RELEASE_STORE.maxChunks, 'Invalid capsule inventory.');
  var total = 0;
  capsule.chunks.forEach(function(chunk, i) {
    registryReleaseStoreNeed_(chunk.index === i && Number.isSafeInteger(chunk.size) && chunk.size > 0 &&
      chunk.size <= capsule.chunk_size && (i === capsule.chunks.length - 1 || chunk.size === capsule.chunk_size) &&
      /^[a-f0-9]{64}$/.test(chunk.sha256 || ''), 'Invalid capsule chunk inventory.'); total += chunk.size;
  });
  registryReleaseStoreNeed_(total === capsule.archive_size && capsule.provenance &&
    capsule.provenance.kind === capsule.kind, 'Capsule size or provenance mismatch.');
  var identity = registryReleaseStoreIdentity_(payload);
  Object.keys(identity).forEach(function(k) { registryReleaseStoreNeed_(capsule.provenance[k] === identity[k], 'Capsule build identity mismatch.'); });
  if (capsule.kind === 'preview') {
    var state = previewState_(); registryReleaseStoreNeed_(capsule.provenance.request_id === state.request_id &&
      capsule.provenance.registry_revision === state.revision, 'Capsule preview revision mismatch.');
  } else if (!registryReleaseStoreBootstrap_(payload)) {
    registryReleaseStoreNeed_(capsule.provenance.review_id === payload.review_id &&
      capsule.provenance.request_id === payload.request_id, 'Capsule release request mismatch.');
  }
}
function registryReleaseStoreBegin_(payload) {
  var capsule = payload.capsule; registryReleaseStoreCapsuleShape_(capsule, payload);
  registryReleaseStoreAuthorizeUpload_(payload, capsule.kind);
  var old = registryReleaseStoreRecord_('capsule', capsule.id);
  if (old) { registryReleaseStoreOwner_(old, payload); registryReleaseStoreNeed_(registryReleaseStoreStable_(old.capsule) ===
    registryReleaseStoreStable_(capsule), 'Immutable capsule identity already exists.'); return {capsule_id:capsule.id,capsule:registryReleaseStoreGetCapsule_(capsule.id)}; }
  var request;
  if (capsule.kind === 'production' && !registryReleaseStoreBootstrap_(payload)) {
    request = registryReleaseStoreGetRequest_(payload.request_id);
    registryReleaseStoreNeed_(!request.production_capsule_id || request.production_capsule_id === capsule.id, 'Production output capsule is already pinned.');
  }
  registryReleaseStoreWrite_('capsule', {id:capsule.id,phase:'uploading',created_at:new Date().toISOString(),
    owner:registryReleaseStoreIdentity_(payload),request_id:payload.request_id || '',review_id:payload.review_id || '',capsule:capsule,chunks:{}}, true);
  if (request) { request.production_capsule_id = capsule.id; registryReleaseStoreSaveRequest_(request); }
  return {capsule_id:capsule.id,capsule:registryReleaseStoreGetCapsule_(capsule.id)};
}
function registryReleaseStoreUploadRecord_(payload) {
  var record = registryReleaseStoreRecord_('capsule', payload.capsule_id);
  registryReleaseStoreNeed_(!!record, 'Release capsule is missing.'); registryReleaseStoreOwner_(record, payload);
  registryReleaseStoreNeed_(record.request_id === (payload.request_id || '') && record.review_id === (payload.review_id || ''), 'Capsule request mismatch.');
  registryReleaseStoreAuthorizeUpload_(payload, record.capsule.kind); return record;
}
function registryReleaseStorePut_(payload) {
  // Snapshot authorization and metadata briefly. Hashing and Drive byte I/O must
  // not hold the ScriptLock shared with the spreadsheet's control actions.
  var record = registryReleaseStoreWithLock_(function() { return registryReleaseStoreUploadRecord_(payload); });
  var expected = record.capsule.chunks[payload.index];
  registryReleaseStoreNeed_(Number.isInteger(payload.index) && expected && expected.index === payload.index &&
    payload.sha256 === expected.sha256 && typeof payload.base64 === 'string' &&
    payload.base64.length === Math.ceil(expected.size / 3) * 4 && !/[^A-Za-z0-9+/=]/.test(payload.base64), 'Invalid capsule chunk.');
  var bytes = Utilities.base64Decode(payload.base64);
  registryReleaseStoreNeed_(bytes.length === expected.size && Utilities.base64Encode(bytes) === payload.base64 &&
    registryReleaseStoreHash_(bytes) === expected.sha256, 'Capsule chunk checksum mismatch.');
  var stored = record.chunks[String(payload.index)], created = false, file;
  if (stored) {
    registryReleaseStoreNeed_(stored.sha256 === expected.sha256 && stored.size === expected.size, 'Stored capsule metadata changed.');
    file = DriveApp.getFileById(stored.file_id);
    registryReleaseStoreNeed_(!file.isTrashed() && file.getSize() === expected.size &&
      registryReleaseStoreHash_(file.getBlob().getBytes()) === expected.sha256, 'Stored capsule chunk changed.');
  } else {
    registryReleaseStoreNeed_(record.phase === 'uploading', 'Complete capsules are immutable.');
    // Independent attempt names make concurrent identical retries harmless. The
    // first successful metadata commit chooses the sole canonical file ID.
    var name = 'chunk-' + record.id + '-' + payload.index + '-' + Utilities.getUuid() + '.bin';
    file = registryReleaseStoreRoot_().createFile(Utilities.newBlob(bytes, 'application/octet-stream', name)); created = true;
  }
  registryReleaseStoreNeed_(file.getSize() === expected.size, 'Capsule chunk was not stored durably.');
  var fileId = file.getId();
  var canonical = registryReleaseStoreWithLock_(function() {
    var latest = registryReleaseStoreUploadRecord_(payload), current = latest.chunks[String(payload.index)];
    registryReleaseStoreNeed_(registryReleaseStoreStable_(latest.capsule) === registryReleaseStoreStable_(record.capsule), 'Capsule identity changed during upload.');
    if (current) {
      registryReleaseStoreNeed_(current.sha256 === expected.sha256 && current.size === expected.size,
        'Concurrent capsule chunk metadata differs.');
      return current.file_id;
    }
    registryReleaseStoreNeed_(latest.phase === 'uploading', 'Complete capsules are immutable.');
    latest.chunks[String(payload.index)] = {file_id:fileId,size:expected.size,sha256:expected.sha256};
    registryReleaseStoreWrite_('capsule', latest, false); return fileId;
  });
  // Never delete after an uncertain commit failure. An unreferenced attempt may
  // remain in the release archive; upload_status determines durable progress.
  if (created && canonical !== fileId) { try { file.setTrashed(true); } catch (_) {} }
  return {capsule_id:record.id,index:payload.index,stored:true};
}
function registryReleaseStoreComplete_(payload) {
  var record = registryReleaseStoreWithLock_(function() { return registryReleaseStoreUploadRecord_(payload); });
  record.capsule.chunks.forEach(function(expected) {
    var stored = record.chunks[String(expected.index)];
    registryReleaseStoreNeed_(stored && stored.sha256 === expected.sha256 && stored.size === expected.size, 'Capsule upload is incomplete.');
    var file = DriveApp.getFileById(stored.file_id);
    registryReleaseStoreNeed_(file.getSize() === expected.size && !file.isTrashed(), 'Capsule chunk is not durably available.');
  });
  return registryReleaseStoreWithLock_(function() {
    var latest = registryReleaseStoreUploadRecord_(payload);
    registryReleaseStoreNeed_(registryReleaseStoreStable_(latest.capsule) === registryReleaseStoreStable_(record.capsule) &&
      registryReleaseStoreStable_(latest.chunks) === registryReleaseStoreStable_(record.chunks),
      'Capsule upload changed during completion. Retry the same completion request.');
    latest.phase = 'complete'; latest.completed_at = latest.completed_at || new Date().toISOString();
    registryReleaseStoreWrite_('capsule', latest, false); return {capsule:registryReleaseStoreCapsuleValue_(latest)};
  });
}
/** Owner-bound, read-only progress inspection after an uncertain upload response.
 * This reports durable indexed chunks, not uncommitted attempt files or activation.
 */
function registryReleaseStoreUploadStatus_(payload) {
  var record = registryReleaseStoreRecord_('capsule', payload.capsule_id);
  registryReleaseStoreNeed_(!!record, 'Release capsule is missing.'); registryReleaseStoreOwner_(record, payload);
  registryReleaseStoreNeed_(record.request_id === (payload.request_id || '') && record.review_id === (payload.review_id || ''), 'Capsule request mismatch.');
  var indices = [];
  record.capsule.chunks.forEach(function(expected) {
    var stored = record.chunks[String(expected.index)]; if (!stored) return;
    registryReleaseStoreNeed_(stored.sha256 === expected.sha256 && stored.size === expected.size, 'Stored capsule chunk metadata changed.');
    var file = DriveApp.getFileById(stored.file_id);
    registryReleaseStoreNeed_(!file.isTrashed() && file.getSize() === expected.size, 'Stored capsule chunk is unavailable.');
    indices.push(expected.index);
  });
  registryReleaseStoreNeed_(record.phase !== 'complete' || indices.length === record.capsule.chunks.length, 'Complete capsule has missing chunks.');
  return {capsule:registryReleaseStoreCapsuleValue_(record),uploaded_indices:indices,complete:record.phase === 'complete'};
}
function registryReleaseStoreAuthorizeRead_(payload, id) {
  var request = registryReleaseStoreGetRequest_(payload.request_id);
  registryReleaseStoreNeed_(!!request, 'Release read is not authorized.');
  var pair = registryReleaseStoreRequestFor_(payload, request.kind, false), review = pair.review;
  registryReleaseStoreNeed_([review.baseline_capsule_id,review.preview_capsule_id,review.candidate_capsule_id].indexOf(id) !== -1,
    'Capsule does not belong to this review.'); return id;
}
function registryReleaseStoreRead_(payload, chunk) {
  var id = registryReleaseStoreAuthorizeRead_(payload, payload.capsule_id), record = registryReleaseStoreRecord_('capsule', id);
  registryReleaseStoreNeed_(record && record.phase === 'complete', 'Release capsule is not complete.');
  if (!chunk) return {capsule:registryReleaseStoreGetCapsule_(id)};
  var expected = record.capsule.chunks[payload.index], stored = record.chunks[String(payload.index)];
  registryReleaseStoreNeed_(Number.isInteger(payload.index) && expected && stored, 'Release chunk does not exist.');
  var file = DriveApp.getFileById(stored.file_id), bytes = file.getBlob().getBytes();
  registryReleaseStoreNeed_(!file.isTrashed() && bytes.length === expected.size && registryReleaseStoreHash_(bytes) === expected.sha256, 'Stored capsule chunk checksum mismatch.');
  return {capsule_id:id,index:payload.index,sha256:expected.sha256,base64:Utilities.base64Encode(bytes)};
}
function registryReleaseStoreClaimReview_(payload) {
  var pair = registryReleaseStoreRequestFor_(payload, 'review', true);
  return {review:pair.review,request:pair.request};
}
function registryReleaseStoreCandidateReady_(payload) {
  var pair = registryReleaseStoreRequestFor_(payload, 'review', false), capsule = registryReleaseStoreGetCapsule_(payload.capsule_id);
  var record = registryReleaseStoreRecord_('capsule', payload.capsule_id); registryReleaseStoreOwner_(record, payload);
  registryReleaseStoreNeed_(pair.request.phase === 'claimed' && capsule && capsule.complete && capsule.kind === 'candidate' &&
    capsule.provenance.review_id === pair.review.id && /^sha256:[a-f0-9]{64}$/.test(payload.artifact_digest || '') &&
    payload.artifact_digest === capsule.provenance.artifact_digest && payload.artifact_digest === capsule.inventory_digest &&
    payload.plan && payload.renderer_evidence, 'Candidate evidence mismatch.');
  var plan = payload.plan, evidence = payload.renderer_evidence, body = registryReleaseStoreClone_(plan);
  delete body.intent_digest;
  registryReleaseStoreNeed_(plan.schema === 1 && plan.site_id === SANDBOX.site_id && plan.target === 'production' &&
    plan.baseline && plan.baseline.deploy_id === pair.review.baseline_deploy_id &&
    plan.reviewed_preview && plan.reviewed_preview.deploy_id === pair.review.preview_deploy_id &&
    Number.isFinite(Date.parse(plan.expires_at)) && Date.parse(plan.expires_at) > Date.now() &&
    plan.intent_digest === 'sha256:' + registryReleaseStoreHash_(Utilities.newBlob(registryReleaseStoreStable_(body)).getBytes()) &&
    evidence.renderer_digest === pair.review.renderer_digest && capsule.provenance.renderer_digest === pair.review.renderer_digest &&
    evidence.catalog_pages_regenerated === true && evidence.source_files_unchanged === true && evidence.unselected_routes_absent === true,
    'Rendered release evidence does not match the review.');
  var projects = plan.projects || [], selected = pair.review.selection.filter(function(s) { return s.include_in_production === true; });
  registryReleaseStoreNeed_(projects.length === selected.length && selected.every(function(s) {
    var matches = projects.filter(function(p) { return p.demo_id === s.demo_id; });
    return matches.length === 1 && matches[0].source_environment === (s.include_in_preview ? 'preview' : 'production') &&
      matches[0].source_deploy_id === (s.include_in_preview ? pair.review.preview_deploy_id : pair.review.baseline_deploy_id);
  }) && registryReleaseStoreStable_(evidence.projects) === registryReleaseStoreStable_(projects), 'Rendered release selection changed.');
  registryReleaseStoreNeed_(plan.publication && registryReleaseStoreStable_(evidence.preserved_overrides) ===
    registryReleaseStoreStable_(plan.publication.required_overrides) &&
    (!plan.publication.omit_notebook_downloads || evidence.notebook_downloads_absent === true) &&
    (!plan.publication.preserve_homepage_introduction || evidence.homepage_introduction_unchanged === true), 'Production presentation overrides were not preserved.');
  registryReleaseStoreNeed_(!pair.review.candidate_capsule_id || (pair.review.candidate_capsule_id === capsule.id &&
    pair.review.artifact_digest === payload.artifact_digest), 'Review candidate is immutable.');
  var review = pair.review; review.candidate_capsule_id = capsule.id; review.artifact_digest = payload.artifact_digest;
  review.plan = payload.plan; review.renderer_evidence = payload.renderer_evidence; review.phase = 'prepared';
  registryReleaseStoreSaveReview_(review); return {review:review};
}
function registryReleaseStoreClaimProduction_(payload) {
  var request = registryReleaseStoreGetRequest_(payload.request_id), review = registryReleaseStoreGetReview_(payload.review_id);
  var active = registryReleaseStoreGetActive_('production');
  registryReleaseStoreNeed_(PropertiesService.getScriptProperties().getProperty('AIS_RELEASE_ACTIVE_REQUEST_ID') === payload.request_id &&
    request && review && review.phase === 'ready' && active && active.provenance.deploy_id === payload.baseline_deploy_id &&
    request.baseline_deploy_id === payload.baseline_deploy_id && request.candidate_capsule_id === payload.candidate_capsule_id &&
    request.artifact_digest === payload.artifact_digest && review.candidate_capsule_id === payload.candidate_capsule_id &&
    review.artifact_digest === payload.artifact_digest, 'Production review or baseline changed.');
  var pair = registryReleaseStoreRequestFor_(payload, 'production', true);
  return {release:pair.request,review:pair.review};
}
function registryReleaseStoreReceipt_(payload) {
  var receipt = payload.receipt, identity = registryReleaseStoreIdentity_(payload);
  var bootstrap = payload.kind === 'production' && registryReleaseStoreBootstrap_(payload);
  registryReleaseStoreNeed_(receipt && receipt.schema === 1 && receipt.platform === 'netlify' &&
    (receipt.verified === true || (bootstrap && receipt.verified === false)), 'Deployment receipt is not verified.');
  Object.keys(identity).forEach(function(k) { registryReleaseStoreNeed_(receipt[k] === identity[k], 'Deployment receipt identity mismatch.'); });
  return receipt;
}
function registryReleaseStoreSucceeded_(payload, reconciled) {
  var record = registryReleaseStoreRecord_('capsule', payload.capsule_id), receipt = registryReleaseStoreReceipt_(payload);
  registryReleaseStoreNeed_(record && record.phase === 'complete', 'Completed capsule is required.'); registryReleaseStoreOwner_(record, payload);
  var props = PropertiesService.getScriptProperties(), now = new Date().toISOString();
  if (payload.kind === 'preview') {
    var state = previewState_();
    registryReleaseStoreNeed_(record.capsule.kind === 'preview' && payload.branch === 'develop' && payload.context === 'branch-deploy' &&
      receipt.target === 'preview' && receipt.audience === 'preview' && receipt.revision_bound === true && state.phase === 'ready' &&
      state.request_id === payload.request_id && receipt.request_id === state.request_id && receipt.registry_revision === state.revision &&
      state.deploy_id === payload.deploy_id && record.capsule.provenance.registry_revision === state.revision, 'Preview success does not match the current signed deployment.');
    record.receipt = receipt; record.activated_at = now; registryReleaseStoreWrite_('capsule', record, false);
    props.setProperty(AIS_RELEASE_STORE.activePreview, record.id); return {capsule_id:record.id,activated:true};
  }
  if (payload.kind === 'production' && registryReleaseStoreBootstrap_(payload)) {
    registryReleaseStoreNeed_(record.capsule.kind === 'production' && receipt.target === 'production' && !registryReleaseStoreGetActive_('production'), 'Production bootstrap is not available.');
    record.receipt = receipt; record.activated_at = now; registryReleaseStoreWrite_('capsule', record, false);
    props.setProperty(AIS_RELEASE_STORE.activeProduction, record.id);
    props.deleteProperty('AIS_RELEASE_BOOTSTRAP_PRODUCTION_DEPLOY'); props.deleteProperty('AIS_RELEASE_BOOTSTRAP_UPLOADER');
    return {capsule_id:record.id,activated:true};
  }
  registryReleaseStoreNeed_(['review','production'].indexOf(payload.kind) !== -1, 'Invalid deployment environment.');
  var pair = registryReleaseStoreRequestFor_(payload, payload.kind, false, reconciled), review = pair.review, request = pair.request;
  registryReleaseStoreNeed_(record.request_id === request.id && record.review_id === review.id && receipt.request_id === request.id &&
    receipt.review_id === review.id && receipt.target === request.target, 'Deployment request mismatch.');
  if (payload.kind === 'review') {
    registryReleaseStoreNeed_(record.capsule.kind === 'candidate' && review.candidate_capsule_id === record.id &&
      receipt.artifact_digest === review.artifact_digest && ['prepared','ready'].indexOf(review.phase) !== -1, 'Review deployment does not match its candidate.');
    review.phase = 'ready'; review.ready_at = review.ready_at || now; review.review_deploy_id = payload.deploy_id;
    review.review_url = 'https://' + payload.deploy_id + '--aisigym.netlify.app/'; registryReleaseStoreSaveReview_(review);
  } else {
    var active = registryReleaseStoreGetActive_('production');
    registryReleaseStoreNeed_(record.capsule.kind === 'production' && receipt.reviewed_artifact_digest === request.artifact_digest &&
      record.capsule.provenance.artifact_digest === request.artifact_digest && active &&
      (active.provenance.deploy_id === request.baseline_deploy_id || active.id === record.id), 'Production capsule or baseline changed.');
  }
  record.receipt = receipt; record.activated_at = now; registryReleaseStoreWrite_('capsule', record, false);
  if (payload.kind === 'production') props.setProperty(AIS_RELEASE_STORE.activeProduction, record.id);
  request.phase = 'succeeded'; request.succeeded_at = request.succeeded_at || now; request.deploy_id = payload.deploy_id;
  registryReleaseStoreSaveRequest_(request); return {capsule_id:record.id,activated:payload.kind === 'production',review:review};
}
/** Only an actual pre-deployment failure calls this action. Callback transport
 * failures after deployment must retain the pending request for reconciliation.
 */
function registryReleaseStoreFailed_(payload) {
  registryReleaseStoreNeed_(['preview','review','production'].indexOf(payload.kind) !== -1 && payload.before_deployment === true,
    'Only a confirmed pre-deployment failure can close a request.');
  if (payload.kind === 'preview') {
    var state = previewState_();
    registryReleaseStoreNeed_(payload.branch === 'develop' && payload.context === 'branch-deploy' &&
      ['requested','accepted'].indexOf(state.phase) !== -1 && payload.request_id === state.request_id,
      'Preview failure does not match a pending request.');
    state.phase = 'failed'; state.failed_at = new Date().toISOString();
    state.error = 'The preview build failed before deployment. Open the build log for details.';
    state.failed_build_id = payload.build_id; state.failed_deploy_id = payload.deploy_id;
    savePreviewState_(state); return {request_id:state.request_id,phase:'failed'};
  }
  var pair = registryReleaseStoreRequestFor_(payload, payload.kind, false);
  registryReleaseStoreNeed_(pair.request.phase === 'claimed', 'A finalized release cannot be failed.');
  pair.request.phase = 'failed'; pair.request.failed_at = new Date().toISOString();
  pair.request.error = 'The deployment failed before publication. Review the changes before retrying.';
  registryReleaseStoreSaveRequest_(pair.request);
  if (payload.kind === 'review') { pair.review.phase = 'failed'; pair.review.error = pair.request.error;
    registryReleaseStoreSaveReview_(pair.review); }
  return {request_id:pair.request.id,phase:'failed'};
}
/** Reads the public production receipt itself. This private helper can repair a
 * lost success callback, including an expired callback window, without deploying.
 */
function registryReleaseStoreReconcileProduction_() {
  var id = PropertiesService.getScriptProperties().getProperty('AIS_RELEASE_ACTIVE_REQUEST_ID');
  if (!id) return null;
  var request = registryReleaseStoreGetRequest_(id);
  if (!request || request.kind !== 'production' || request.phase !== 'claimed' || !request.production_capsule_id) return null;
  var response = UrlFetchApp.fetch('https://aisigym.netlify.app/deploy-receipt.json',
    {method:'get',muteHttpExceptions:true,headers:{'Cache-Control':'no-cache'}});
  if (response.getResponseCode() !== 200 || response.getContentText().length > 2000000) return null;
  var receipt = JSON.parse(response.getContentText());
  if (!receipt || receipt.request_id !== request.id || receipt.review_id !== request.review_id ||
    receipt.deploy_id !== request.owner.deploy_id) return null;
  return registryReleaseStoreSucceeded_(Object.assign({schema:1,action:'deployment_succeeded',sent_at:new Date().toISOString(),
    kind:'production',request_id:request.id,review_id:request.review_id,capsule_id:request.production_capsule_id,receipt:receipt}, request.owner), true);
}
function registryReleaseStoreHandlePost_(event) {
  try {
    var raw = event && event.postData && event.postData.contents;
    registryReleaseStoreNeed_(event && event.parameter && event.parameter.action === 'manual_release' &&
      typeof raw === 'string' && raw.length <= AIS_RELEASE_STORE.maxEnvelope, 'Invalid release request.');
    var envelope = JSON.parse(raw), secret = PropertiesService.getScriptProperties().getProperty('AI4S_PREVIEW_CALLBACK_SECRET');
    registryReleaseStoreNeed_(secret && typeof envelope.payload === 'string' && /^[a-f0-9]{64}$/.test(envelope.signature || ''), 'Unauthorized release request.');
    var signature = Utilities.computeHmacSha256Signature('ais-manual-release-api-v1\n' + envelope.payload, secret).map(function(b) {
      return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
    }).join('');
    registryReleaseStoreNeed_(safeEqual_(signature, envelope.signature), 'Unauthorized release request.');
    var payload = JSON.parse(envelope.payload); registryReleaseStoreIdentity_(payload);
    var actions = {begin_capsule:registryReleaseStoreBegin_,put_chunk:registryReleaseStorePut_,complete_capsule:registryReleaseStoreComplete_,
        read_capsule:function(p) { return registryReleaseStoreRead_(p, false); },read_chunk:function(p) { return registryReleaseStoreRead_(p, true); },
        upload_status:registryReleaseStoreUploadStatus_,
        claim_review:registryReleaseStoreClaimReview_,candidate_ready:registryReleaseStoreCandidateReady_,
        claim_production:registryReleaseStoreClaimProduction_,deployment_succeeded:registryReleaseStoreSucceeded_,deployment_failed:registryReleaseStoreFailed_};
    registryReleaseStoreNeed_(Object.prototype.hasOwnProperty.call(actions, payload.action), 'Unknown release action.');
    // Reads are immutable. Upload and completion perform their own short commits.
    var unlocked = ['put_chunk','complete_capsule','read_capsule','read_chunk','upload_status'].indexOf(payload.action) !== -1;
    var result = unlocked ? actions[payload.action](payload) : registryReleaseStoreWithLock_(function() { return actions[payload.action](payload); });
    return json_(Object.assign({ok:true}, result));
  } catch (error) { return json_(Object.assign({ok:false,error:error.releaseStoreSafe ? error.message : 'Release storage operation failed. Retry only the same request identity.'},
    error.releaseStoreCode ? {code:error.releaseStoreCode,retryable:error.releaseStoreCode === 'release_busy'} : {})); }
}
