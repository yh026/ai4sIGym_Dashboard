'use strict';
const crypto = require('node:crypto');
const DOMAIN = 'ais-manual-release-hook-v1\n';
const REVIEW_BRANCH = 'codex/manual-production-review';
const SITE_ID = '2fe21bb6-70b5-47c6-a810-18f6bd8f4973';
const need = (value, message) => { if (!value) throw new Error('Manual publishing: ' + message); };
function validateHook(env = process.env, target = 'production', now = Date.now(), { failureReport = false } = {}) {
  const review = target === 'production-review';
  need(String(env.NETLIFY).toLowerCase() === 'true' && env.SITE_ID === SITE_ID
    && env.CONTEXT === (review ? 'branch-deploy' : 'production') && env.BRANCH === (review ? REVIEW_BRANCH : 'main'), 'deployment context is not authorized');
  need(/^[a-f0-9]{40}$/.test(env.COMMIT_REF || '') && /^[a-zA-Z0-9_-]{1,128}$/.test(env.BUILD_ID || '')
    && /^[a-f0-9]{24}$/.test(env.DEPLOY_ID || ''), 'deployment identity is missing');
  let envelope;
  const raw = env.INCOMING_HOOK_BODY;
  need(typeof raw === 'string' && raw.length > 0 && raw.length < 20000, 'a manual publishing request is required');
  try { envelope = JSON.parse(raw); } catch { try { envelope = JSON.parse(decodeURIComponent(raw)); } catch { throw new Error('Manual publishing: invalid hook envelope'); } }
  const secret = env.AI4S_PREVIEW_CALLBACK_SECRET;
  need(typeof secret === 'string' && secret.length >= 32 && typeof envelope.payload === 'string'
    && /^[a-f0-9]{64}$/.test(envelope.signature || ''), 'signed manual request is required');
  const signature = crypto.createHmac('sha256', secret).update(DOMAIN + envelope.payload).digest();
  need(crypto.timingSafeEqual(signature, Buffer.from(envelope.signature, 'hex')), 'manual request signature is invalid');
  const request = JSON.parse(envelope.payload), issued = Date.parse(request.requested_at), expires = Date.parse(request.expires_at);
  need(request.schema === 1 && request.target === target && request.site_id === SITE_ID && request.branch === env.BRANCH
    && /^[a-zA-Z0-9_-]{8,128}$/.test(request.review_id || '') && /^[a-zA-Z0-9_-]{8,128}$/.test(request.request_id || ''), 'manual request identity does not match');
  need(Number.isFinite(issued) && Number.isFinite(expires) && issued <= now + 60000 && (expires > now || failureReport && now - issued <= 2 * 60 * 60000)
    && expires > issued && expires - issued <= 30 * 60000, 'manual request has expired');
  if (!review) need(/^[a-zA-Z0-9_-]{8,128}$/.test(request.candidate_capsule_id || '')
    && /^sha256:[a-f0-9]{64}$/.test(request.artifact_digest || '') && /^[a-f0-9]{24}$/.test(request.baseline_deploy_id || ''), 'reviewed artifact identity is missing');
  return request;
}
module.exports = { DOMAIN, REVIEW_BRANCH, SITE_ID, validateHook };
