'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, stable, pack, inventory, writeDirectory } = require('./capsule.cjs');
const { createClient, identity } = require('./client.cjs');
const { validateHook, confirmationDigest } = require('./hook.cjs');
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
  files, manifest, receipt, capsule_renderer_digest: proof.renderer_digest, inventory_digest: capsule.inventory_digest,
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

async function productionBuild({ env = process.env, client, checkout = process.cwd(), rendererCheckout = checkout,
  now = new Date().toISOString() } = {}) {
  // Validate before reading sources, clearing output, or making any API request.
  const request = validateHook(env, 'production', Date.parse(now));
  client ||= createClient({ env });
  const binding = { review_id: request.review_id, request_id: request.request_id };
  const { release, review } = await client.call('claim_production', { ...binding,
    preview_capsule_id: request.preview_capsule_id, confirmation_digest: request.confirmation_digest,
    baseline_deploy_id: request.baseline_deploy_id });
  need(release?.id === request.request_id && review?.schema === 2 && review.id === request.review_id
    && confirmationDigest(review) === request.confirmation_digest
    && review.preview_capsule_id === request.preview_capsule_id
    && review.baseline_deploy_id === request.baseline_deploy_id, 'confirmed publication inputs differ');
  const baseline = capsuleSource(await client.download(review.baseline_capsule_id, binding), 'production');
  const preview = capsuleSource(await client.download(review.preview_capsule_id, binding), 'preview');
  need(baseline.metadata.id === review.baseline_deploy_id && preview.metadata.id === review.preview_deploy_id,
    'confirmed deployment identity differs');
  need(preview.receipt.renderer_digest === review.renderer_digest
    && preview.capsule_renderer_digest === review.renderer_digest, 'confirmed Preview renderer differs');
  const overrides = [...new Set((baseline.receipt.publication_overrides || []).map(item => item.id))];
  const current = { catalog: review.catalog, selection: review.selection,
    baseline: deploymentSnapshot(baseline, overrides), preview: deploymentSnapshot(preview, overrides), now };
  const intent = createReleaseIntent(current);
  const renderer = loadCatalogRenderer(rendererCheckout, review.renderer_digest);
  const result = renderArtifact({ intent, current, baseline, preview, catalogRenderer: renderer, now });
  const files = new Map(result.artifact.files);
  const receipt = { ...readJson(files, 'deploy-receipt.json'), publication_method: 'develop-promotion', verified: true,
    ...identity(env), built_at: now, ...binding, confirmation_digest: request.confirmation_digest,
    preview_capsule_id: review.preview_capsule_id, reviewed_artifact_digest: result.artifact_digest };
  files.set('deploy-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  const prepared = pack(files, { kind: 'production', ...identity(env), ...binding,
    confirmation_digest: request.confirmation_digest, renderer_digest: review.renderer_digest,
    artifact_digest: result.artifact_digest });
  // Durability and server-side validation precede Netlify publication. The API
  // rechecks the source deployments, selection and confirmation under its lock.
  await client.upload(prepared, binding);
  await client.call('production_prepared', { ...binding, capsule_id: prepared.capsule.id,
    artifact_digest: result.artifact_digest, plan: intent, renderer_evidence: result.renderer_evidence });
  writeDirectory(files, cleanOutput(path.join(checkout, 'dist')));
  saveState(checkout, { kind: 'production', ...binding, receipt, capsule_id: prepared.capsule.id });
  return { projects: intent.projects.length, artifact_digest: result.artifact_digest };
}
module.exports = { STATE_FILE, capsuleSource, artifactDigest, productionBuild };
