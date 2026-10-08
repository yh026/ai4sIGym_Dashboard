'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, stable, pack, inventory, writeDirectory } = require('./capsule.cjs');
const { createClient, identity } = require('./client.cjs');
const { validateHook } = require('./hook.cjs');
const { createReleaseIntent } = require('../production-release/release-plan.cjs');
const { deploymentSnapshot, renderArtifact } = require('../production-release/artifact-renderer.cjs');
const { loadCatalogRenderer } = require('../production-release/catalog-renderer.cjs');
const need = (value, message) => { if (!value) throw new Error('Manual release build: ' + message); };
const STATE_FILE = '.ais-manual-release-build.json';
const readJson = (files, name) => JSON.parse(files.get(name)?.toString('utf8') || 'null');
const artifactDigest = files => 'sha256:' + hash(stable(inventory(files)));

// The API exposes a source only after a signed successful build callback. The
// capsule inventory is a SHA256 artifact inventory, never a claimed API listing.
function capsuleSource(downloaded, environment) {
  const { capsule, files } = downloaded, proof = capsule.provenance;
  const receipt = readJson(files, 'deploy-receipt.json'), manifest = readJson(files, 'manifest.json');
  need(capsule.kind === environment && proof.kind === environment && manifest?.schema_version === 3
    && Array.isArray(manifest.demos) && manifest.taxonomy && receipt, 'source is incomplete');
  for (const field of ['site_id', 'build_id', 'deploy_id', 'commit_ref', 'branch', 'context']) {
    need(typeof proof[field] === 'string' && proof[field] === receipt[field], 'source receipt identity differs: ' + field);
  }
  need(receipt.target === environment && receipt.audience === environment
    && receipt.branch === (environment === 'preview' ? 'develop' : 'main')
    && receipt.context === (environment === 'preview' ? 'branch-deploy' : 'production'), 'source audience differs');
  if (environment === 'preview') need(receipt.verified === true && receipt.revision_bound === true
    && receipt.registry_revision === proof.registry_revision && receipt.request_id === proof.request_id,
  'preview was not verified');
  return { environment, metadata: { id: proof.deploy_id, site_id: proof.site_id, build_id: proof.build_id,
    state: 'ready', branch: proof.branch, context: proof.context, commit_ref: proof.commit_ref },
  files, manifest, receipt, inventory_digest: capsule.inventory_digest,
  receipt_digest: 'sha256:' + hash(files.get('deploy-receipt.json')) };
}
function cleanOutput(output) {
  // Netlify can restore a previous dist from cache. Only this exact build output
  // directory is cleared; source capsule data is never extracted there first.
  const absolute = path.resolve(output);
  need(path.basename(absolute) === 'dist' && absolute !== path.parse(absolute).root, 'unexpected output directory');
  fs.rmSync(absolute, { recursive: true, force: true }); return absolute;
}
function saveState(checkout, state) { fs.writeFileSync(path.join(checkout, STATE_FILE), JSON.stringify(state, null, 2) + '\n'); }

async function reviewBuild({ env = process.env, client = createClient({ env }), checkout = process.cwd(), rendererCheckout = checkout, now = new Date().toISOString() } = {}) {
  const request = validateHook(env, 'production-review', Date.parse(now));
  const binding = { review_id: request.review_id, request_id: request.request_id };
  const { review } = await client.call('claim_review', binding);
  need(review?.id === request.review_id && review.site_id === env.SITE_ID
    && Date.parse(review.expires_at) > Date.parse(now), 'review claim is invalid or expired');
  const baseline = capsuleSource(await client.download(review.baseline_capsule_id, binding), 'production');
  const preview = review.preview_capsule_id ? capsuleSource(await client.download(review.preview_capsule_id, binding), 'preview') : null;
  need(baseline.metadata.id === review.baseline_deploy_id, 'production baseline differs');
  if (preview) need(preview.metadata.id === review.preview_deploy_id, 'reviewed preview differs');
  const overrides = [...new Set((baseline.receipt.publication_overrides || []).map(item => item.id))];
  const current = { catalog: review.catalog, selection: review.selection,
    baseline: deploymentSnapshot(baseline, overrides), preview: preview ? deploymentSnapshot(preview, overrides) : null, now };
  const intent = createReleaseIntent(current);
  const renderer = loadCatalogRenderer(rendererCheckout, review.renderer_digest);
  const result = renderArtifact({ intent, current, baseline, preview, catalogRenderer: renderer, now });
  const provenance = { kind: 'candidate', ...identity(env), ...binding, artifact_digest: result.artifact_digest,
    baseline_deploy_id: review.baseline_deploy_id, renderer_digest: renderer.source_digest };
  const prepared = pack(result.artifact.files, provenance);
  await client.upload(prepared, binding);
  await client.call('candidate_ready', { ...binding, capsule_id: prepared.capsule.id,
    artifact_digest: result.artifact_digest, plan: intent, renderer_evidence: result.renderer_evidence });
  const visible = new Map(result.artifact.files);
  const visibleReceipt = { schema: 1, target: 'production-review', audience: 'preview', platform: 'netlify', verified: true, ...identity(env),
    built_at: now, ...binding, candidate_capsule_id: prepared.capsule.id, artifact_digest: result.artifact_digest };
  visible.set('deploy-receipt.json', Buffer.from(JSON.stringify(visibleReceipt, null, 2) + '\n'));
  visible.set('robots.txt', Buffer.from('User-agent: *\nDisallow: /\n'));
  visible.set('_headers', Buffer.from('/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n\n/deploy-receipt.json\n  Cache-Control: no-store\n'));
  writeDirectory(visible, cleanOutput(path.join(checkout, 'dist')));
  saveState(checkout, { kind: 'review', ...binding, capsule_id: prepared.capsule.id, receipt: visibleReceipt });
  return { projects: intent.projects.length, capsule_id: prepared.capsule.id, artifact_digest: result.artifact_digest };
}

async function productionBuild({ env = process.env, client = createClient({ env }), checkout = process.cwd(), now = new Date().toISOString() } = {}) {
  // Validate before fetching any source, clearing dist, or making an API request.
  const request = validateHook(env, 'production', Date.parse(now));
  const binding = { review_id: request.review_id, request_id: request.request_id };
  const claim = { ...binding, candidate_capsule_id: request.candidate_capsule_id,
    artifact_digest: request.artifact_digest, baseline_deploy_id: request.baseline_deploy_id };
  const { release } = await client.call('claim_production', claim);
  need(release && release.candidate_capsule_id === request.candidate_capsule_id
    && release.artifact_digest === request.artifact_digest && release.baseline_deploy_id === request.baseline_deploy_id,
  'production claim does not match the confirmed release');
  const source = await client.download(request.candidate_capsule_id, binding);
  need(source.capsule.kind === 'candidate' && source.capsule.provenance.review_id === request.review_id
    && source.capsule.provenance.artifact_digest === request.artifact_digest
    && artifactDigest(source.files) === request.artifact_digest, 'confirmed candidate bytes differ');
  const files = new Map(source.files), candidate = readJson(files, 'deploy-receipt.json');
  need(candidate?.target === 'production' && candidate.baseline_deploy_id === request.baseline_deploy_id
    && Array.isArray(candidate.projects) && Array.isArray(candidate.publication_overrides), 'invalid candidate receipt');
  const receipt = { ...candidate, publication_method: 'manual-build', verified: true, ...identity(env), built_at: now,
    ...binding, candidate_capsule_id: request.candidate_capsule_id, reviewed_artifact_digest: request.artifact_digest };
  files.set('deploy-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  const prepared = pack(files, { kind: 'production', ...identity(env), ...binding, artifact_digest: request.artifact_digest });
  // Durability precedes publication. The successful-deploy callback only activates
  // this exact staged capsule; a failed build cannot become the production source.
  await client.upload(prepared, binding);
  writeDirectory(files, cleanOutput(path.join(checkout, 'dist')));
  saveState(checkout, { kind: 'production', ...binding, receipt, capsule_id: prepared.capsule.id });
  return { projects: receipt.projects.length, artifact_digest: request.artifact_digest };
}
module.exports = { STATE_FILE, capsuleSource, artifactDigest, reviewBuild, productionBuild };
