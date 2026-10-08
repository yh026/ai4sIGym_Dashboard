'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pack, readDirectory } = require('./capsule.cjs');
const { identity, createClient } = require('./client.cjs');
const { STATE_FILE } = require('./build.cjs');
const { REVIEW_BRANCH, SITE_ID, validateHook } = require('./hook.cjs');

async function exportSuccessfulBuild({ env = process.env, publishDir = 'dist', checkout = process.cwd(), client } = {}) {
  if (env.NETLIFY !== 'true' || env.SITE_ID !== SITE_ID) return { sent: false, reason: 'not-release-site' };
  const files = readDirectory(publishDir);
  const receipt = JSON.parse(files.get('deploy-receipt.json')?.toString('utf8') || 'null');
  for (const [field, value] of Object.entries(identity(env))) if (receipt?.[field] !== value) throw new Error('Successful deployment receipt differs: ' + field);
  let state;
  if (env.BRANCH === 'develop' && env.CONTEXT === 'branch-deploy') {
    if (receipt.verified !== true || receipt.revision_bound !== true || receipt.target !== 'preview'
      || receipt.audience !== 'preview' || !receipt.request_id) return { sent: false, reason: 'not-manual-preview' };
    state = { kind: 'preview', request_id: receipt.request_id };
    const statePath = path.join(checkout, STATE_FILE);
    if (fs.existsSync(statePath)) {
      const staged = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (staged.kind === 'preview' && staged.receipt?.deploy_id === env.DEPLOY_ID
        && staged.request_id === receipt.request_id) state = staged;
    }
  } else if ((env.BRANCH === REVIEW_BRANCH && env.CONTEXT === 'branch-deploy') || (env.BRANCH === 'main' && env.CONTEXT === 'production')) {
    state = JSON.parse(fs.readFileSync(path.join(checkout, STATE_FILE), 'utf8'));
    if (state.receipt.deploy_id !== env.DEPLOY_ID || state.request_id !== receipt.request_id) throw new Error('Release completion state differs.');
  } else return { sent: false, reason: 'not-manual-release' };
  client ||= createClient({ env });
  const binding = { request_id: state.request_id, ...(state.review_id ? { review_id: state.review_id } : {}) };
  let capsuleId = state.capsule_id;
  if (state.kind === 'preview' && !capsuleId) {
    const provenance = { kind: state.kind, ...identity(env), ...binding,
      ...(state.kind === 'preview' ? { registry_revision: receipt.registry_revision } : { artifact_digest: receipt.reviewed_artifact_digest }) };
    const prepared = pack(files, provenance);
    capsuleId = await client.upload(prepared, binding);
  }
  await client.call('deployment_succeeded', { kind: state.kind, capsule_id: capsuleId, ...binding, receipt });
  return { sent: true, kind: state.kind, capsule_id: capsuleId };
}
async function stagePreviewBuild({ env = process.env, publishDir = 'dist', checkout = process.cwd(), client } = {}) {
  if (env.NETLIFY !== 'true' || env.SITE_ID !== SITE_ID || env.BRANCH !== 'develop' || env.CONTEXT !== 'branch-deploy') {
    throw new Error('Manual preview staging requires the configured develop deployment.');
  }
  const files = readDirectory(publishDir), receipt = JSON.parse(files.get('deploy-receipt.json')?.toString('utf8') || 'null');
  if (!receipt || receipt.verified !== true || receipt.revision_bound !== true || receipt.target !== 'preview'
    || receipt.audience !== 'preview' || !receipt.request_id) throw new Error('Only a verified manual preview can be staged.');
  for (const [field, value] of Object.entries(identity(env))) if (receipt[field] !== value) throw new Error('Preview receipt differs: ' + field);
  client ||= createClient({ env });
  const binding = { request_id: receipt.request_id };
  const prepared = pack(files, { kind: 'preview', ...identity(env), ...binding, registry_revision: receipt.registry_revision });
  await client.upload(prepared, binding);
  fs.writeFileSync(path.join(checkout, STATE_FILE), JSON.stringify({ kind: 'preview', ...binding, capsule_id: prepared.capsule.id, receipt }, null, 2) + '\n');
  return prepared.capsule.id;
}
async function reportFailedBuild({ env = process.env, checkout = process.cwd(), client, now = Date.now(), beforeDeployment = false } = {}) {
  if (beforeDeployment !== true) return { sent: false };
  if (env.NETLIFY !== 'true' || env.SITE_ID !== SITE_ID) return { sent: false };
  let binding, kind;
  try {
    if (env.BRANCH === 'main' || env.BRANCH === REVIEW_BRANCH) {
      kind = env.BRANCH === 'main' ? 'production' : 'review';
      const request = validateHook(env, kind === 'review' ? 'production-review' : 'production', now, { failureReport: true });
      binding = { request_id: request.request_id, review_id: request.review_id };
    } else if (env.BRANCH === 'develop' && env.CONTEXT === 'branch-deploy') {
      const build = require(path.join(checkout, 'build.js'));
      const request = build.resolvePreviewHookReceipt(env, build.resolveBuildContentPolicy(env));
      if (!request.verified) return { sent: false };
      kind = 'preview'; binding = { request_id: request.requestId };
    } else return { sent: false };
  } catch { return { sent: false }; }
  client ||= createClient({ env });
  await client.call('deployment_failed', { kind, ...binding, before_deployment: true,
    error: 'The build failed before deployment. Open the Netlify build log for details.' });
  return { sent: true };
}
module.exports = { exportSuccessfulBuild, stagePreviewBuild, reportFailedBuild };
