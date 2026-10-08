'use strict';

// The caller supplies a reviewed artifact produced by a separate renderer.
// Publication never reads mutable Drive sources or changes a Git branch.
const crypto = require('node:crypto');
const { assertCurrentIntent, assertCandidate, createDraftRequest, digest } = require('./release-plan.cjs');
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (condition, message) => { if (!condition) throw new Error('Release bridge: ' + message); };

function inventoryDigest(files) {
  return digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function validateArtifact(intent, artifact, reviewedArtifactDigest) {
  need(artifact && artifact.schema === 1 && artifact.intent_digest === intent.intent_digest
    && artifact.files instanceof Map && artifact.files.size > 0 && artifact.files.size <= 10000,
  'prepared artifact is required');
  const files = {}, inventory = [];
  for (const [path, bytes] of artifact.files) {
    need(Buffer.isBuffer(bytes), 'artifact files must be immutable byte buffers');
    need(bytes.length <= 64 * 1024 * 1024, 'artifact file exceeds size limit');
    files['/' + path] = sha1(bytes);
    inventory.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  need(inventory.reduce((n, row) => n + row.size, 0) <= 256 * 1024 * 1024, 'artifact exceeds size limit');
  createDraftRequest(intent, files);
  const artifactDigest = digest(inventory.sort((a, b) => a.path.localeCompare(b.path)));
  need(artifactDigest === reviewedArtifactDigest, 'artifact differs from the reviewed bytes');
  const manifest = JSON.parse(artifact.files.get('manifest.json').toString('utf8'));
  need(manifest.schema_version === 3 && manifest.audience === 'production' && Array.isArray(manifest.demos),
    'artifact requires a production manifest');
  const actualIds = manifest.demos.map(d => d.demo_id).sort();
  need(JSON.stringify(actualIds) === JSON.stringify(intent.projects.map(d => d.demo_id).sort()),
    'artifact project membership differs from review');
  for (const demo of manifest.demos) {
    const expected = intent.projects.find(p => p.demo_id === demo.demo_id);
    need(demo.slug === expected.slug && demo.status === 'Live' && demo.public_page_permission === 'Public'
      && Array.isArray(demo.pages), 'invalid production project metadata');
    for (const page of demo.pages) need(artifact.files.has(page.path), 'project page missing from artifact');
  }
  const selectedSlugs = new Set(intent.projects.map(d => d.slug));
  for (const path of artifact.files.keys()) {
    const match = /^demos\/([^/]+)\//.exec(path);
    need(!match || selectedSlugs.has(match[1]), 'unpublished project route remains in artifact');
    if (intent.publication.omit_notebook_downloads) {
      need(!/^demos\/tbb-cluster-explorer-2\/(?:resources\/|workflow-resources(?:\.|\/|$))/.test(path),
        'hidden notebook route remains in artifact');
    }
  }
  const receipt = JSON.parse(artifact.files.get('deploy-receipt.json').toString('utf8'));
  need(receipt.target === 'production' && receipt.audience === 'production'
    && receipt.intent_digest === intent.intent_digest && receipt.baseline_deploy_id === intent.baseline.deploy_id,
    'artifact receipt does not match release intent');
  return { files, artifact_digest: artifactDigest, inventory_digest: inventoryDigest(files) };
}

function createNetlifyBridge({ token, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  maxPolls = 30, pollMs = 2000 } = {}) {
  need(typeof token === 'string' && token.length >= 20, 'local Netlify authentication is required');
  async function api(path, method = 'GET', body, raw = false) {
    need(/^\/[A-Za-z0-9_/?=.%-]+$/.test(path), 'invalid Netlify API path');
    let response;
    try {
      response = await fetchImpl('https://api.netlify.com/api/v1' + path, {
        method, headers: { Authorization: 'Bearer ' + token,
          ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
    } catch { throw new Error('Release bridge: Netlify request did not complete; status must be reconciled before retrying'); }
    need(response.ok, 'Netlify returned HTTP ' + response.status);
    if (raw) return null;
    try { return await response.json(); }
    catch { throw new Error('Release bridge: invalid Netlify response'); }
  }
  async function assertPublishedBaseline(intent) {
    const site = await api('/sites/' + intent.site_id);
    need(site.id === intent.site_id && site.published_deploy?.id === intent.baseline.deploy_id
      && site.published_deploy?.commit_ref === intent.baseline.commit_ref,
      'published production changed; review again');
  }
  function isolatedDraft(deploy, intent, candidateId, title) {
    // Netlify currently omits `draft` from its deploy responses. A manual
    // draft is reported as an unpublished deploy-preview with no Git commit.
    // Never treat the missing boolean alone as evidence of isolation.
    return deploy.id === candidateId && deploy.site_id === intent.site_id
      && deploy.context === 'deploy-preview' && !deploy.published_at && !deploy.commit_ref
      && deploy.draft !== false && deploy.title === title;
  }
  async function assertDraftInventory(intent, candidate) {
    const deploy = await api('/deploys/' + candidate.deploy_id);
    need(isolatedDraft(deploy, intent, candidate.deploy_id, candidate.title)
      && deploy.state === 'ready', 'candidate is not a ready draft on this site');
    const listing = await api('/sites/' + intent.site_id + '/files?deploy_id=' + candidate.deploy_id);
    need(Array.isArray(listing) && listing.length && listing.every(file => file.deploy_id === candidate.deploy_id),
      'candidate file inventory is not bound to this deploy');
    const files = {};
    for (const file of listing) {
      need(typeof file.path === 'string' && !Object.hasOwn(files, file.path), 'duplicate candidate file');
      files[file.path] = file.sha;
    }
    need(inventoryDigest(files) === candidate.inventory_digest, 'candidate bytes changed after validation');
  }
  async function prepare({ intent, current, artifact, reviewedArtifactDigest, rendererEvidence, resumeCandidateId }) {
    assertCurrentIntent(intent, current);
    const validated = validateArtifact(intent, artifact, reviewedArtifactDigest);
    // Validate renderer evidence before even creating a remote draft.
    assertCandidate(intent, { ...rendererEvidence, site_id: intent.site_id,
      deploy_id: '0'.repeat(24), state: 'ready', draft: true,
      intent_digest: intent.intent_digest, inventory_digest: validated.inventory_digest });
    await assertPublishedBaseline(intent);
    const request = createDraftRequest(intent, validated.files);
    need(resumeCandidateId === undefined || /^[a-f0-9]{24}$/.test(resumeCandidateId), 'invalid resume deployment');
    let deploy = resumeCandidateId ? await api('/deploys/' + resumeCandidateId)
      : await api('/sites/' + intent.site_id + '/deploys', 'POST', request);
    need(/^[a-f0-9]{24}$/.test(deploy.id || '') && (!resumeCandidateId || deploy.id === resumeCandidateId) && deploy.site_id === intent.site_id
      && isolatedDraft(deploy, intent, deploy.id, request.title), 'Netlify did not return an isolated draft');
    const candidateId = deploy.id;
    let polls = 0;
    while (deploy.state === 'preparing' && polls++ < maxPolls) {
      await sleep(pollMs); deploy = await api('/deploys/' + candidateId);
      need(isolatedDraft(deploy, intent, candidateId, request.title), 'draft identity changed');
    }
    need(Array.isArray(deploy.required) || deploy.state === 'ready', 'draft inventory is not ready');
    need(!(deploy.required_functions || []).length, 'release unexpectedly requires server functions');
    const pathByHash = new Map(Object.entries(validated.files).map(([path, hash]) => [hash, path]));
    for (const hash of deploy.required || []) {
      const path = pathByHash.get(hash); need(path, 'Netlify requested an unreviewed file');
      await api('/deploys/' + candidateId + '/files' + path.split('/').map(encodeURIComponent).join('/'),
        'PUT', artifact.files.get(path.slice(1)), true);
    }
    while (deploy.state !== 'ready' && polls++ < maxPolls) {
      need(!['error', 'failed'].includes(deploy.state), 'draft deployment failed');
      await sleep(pollMs); deploy = await api('/deploys/' + candidateId);
      need(isolatedDraft(deploy, intent, candidateId, request.title), 'draft identity changed');
    }
    const candidate = { ...rendererEvidence, site_id: intent.site_id, deploy_id: candidateId,
      state: deploy.state, draft: true, title: request.title, deploy_url: deploy.deploy_ssl_url || null,
      isolation_evidence: { request_draft: true, context: deploy.context, published_at: deploy.published_at || null,
        commit_ref: deploy.commit_ref || null }, intent_digest: intent.intent_digest,
      inventory_digest: validated.inventory_digest, artifact_digest: validated.artifact_digest };
    assertCandidate(intent, candidate);
    await assertDraftInventory(intent, candidate);
    await assertPublishedBaseline(intent);
    return candidate;
  }
  async function publish({ intent, current, candidate, confirmation }) {
    need(confirmation === intent.intent_digest, 'explicit confirmation of this exact release is required');
    assertCurrentIntent(intent, current);
    assertCandidate(intent, candidate);
    await assertDraftInventory(intent, candidate);
    await assertPublishedBaseline(intent);
    // This is the only production-changing operation in the entire bridge.
    // Do not retry a timeout: first inspect the site's published deployment.
    await api('/sites/' + intent.site_id + '/deploys/' + candidate.deploy_id + '/restore', 'POST', {});
    const site = await api('/sites/' + intent.site_id);
    need(site.id === intent.site_id && site.published_deploy?.id === candidate.deploy_id,
      'publication response needs reconciliation');
    return { published: true, deploy_id: candidate.deploy_id, intent_digest: intent.intent_digest };
  }
  return { prepare, publish, assertPublishedBaseline, assertDraftInventory };
}

module.exports = { createNetlifyBridge, validateArtifact, inventoryDigest };
