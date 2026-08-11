'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CALLBACK_SCHEMA = 1;
const CALLBACK_ACTION = 'preview_callback';
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_ATTEMPTS = 3;
const CALLBACK_TIMEOUT_MS = 10 * 1000;

function isDevelopBranchDeploy(env) {
  return String(env.CONTEXT || '') === 'branch-deploy'
    && String(env.BRANCH || '') === 'develop';
}

function previewCallbackUrl(registryUrl) {
  const url = new URL(String(registryUrl || ''));
  if (url.protocol !== 'https:') throw new Error('Preview callback endpoint must use HTTPS.');
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  url.searchParams.set('action', CALLBACK_ACTION);
  return url.toString();
}

function validTimestamp(value) {
  const text = String(value || '');
  const milliseconds = Date.parse(text);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    && Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === text;
}

function receiptError(receipt, siteId) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return 'invalid receipt object';
  }
  if (receipt.schema !== 1 || receipt.revision_bound !== true
      || receipt.target !== 'preview' || receipt.audience !== 'preview'
      || receipt.platform !== 'netlify' || receipt.context !== 'branch-deploy'
      || receipt.branch !== 'develop') {
    return 'invalid Preview receipt identity';
  }
  if (String(receipt.site_id || '') !== String(siteId || '')) return 'site mismatch';
  if (!/^sha256:[0-9a-f]{64}$/.test(String(receipt.registry_revision || ''))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(String(receipt.deploy_id || ''))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(String(receipt.build_id || ''))
      || !/^[0-9a-f]{7,64}$/i.test(String(receipt.commit_ref || ''))
      || !validTimestamp(receipt.built_at)) {
    return 'invalid Preview deploy fields';
  }
  if (receipt.verified === true) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(receipt.request_id || ''))
        || !validTimestamp(receipt.requested_at)) {
      return 'invalid verified request fields';
    }
  } else if (receipt.verified !== false) {
    return 'invalid verification flag';
  }
  return '';
}

function signedEnvelope(receipt, secret, callbackAt) {
  const payload = JSON.stringify({
    schema: CALLBACK_SCHEMA,
    event: 'preview_deploy_succeeded',
    callback_at: callbackAt,
    receipt,
  });
  const signature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return { payload, signature };
}

async function responseAcknowledged(response, deployId) {
  if (!response || response.ok !== true) return false;
  let ack;
  try { ack = await response.json(); }
  catch (error) { return false; }
  return Boolean(ack && ack.ok === true && ack.event === CALLBACK_ACTION
    && String(ack.deploy_id || '') === String(deployId));
}

function waitMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Preview callback timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverPreviewCallback(options = {}) {
  const env = options.env || process.env;
  if (!isDevelopBranchDeploy(env)) return { sent: false, reason: 'not-develop-branch-deploy' };

  const siteId = String(options.siteId || env.SITE_ID || '');
  const secret = String(env.AI4S_PREVIEW_CALLBACK_SECRET || '');
  if (secret.length < 32) return { sent: false, reason: 'callback-not-configured' };

  let url;
  try { url = previewCallbackUrl(env.REGISTRY_URL); }
  catch (error) { return { sent: false, reason: 'callback-not-configured' }; }

  const receiptPath = path.join(options.publishDir || 'dist', 'deploy-receipt.json');
  let receiptText;
  try {
    const size = fs.statSync(receiptPath).size;
    if (size <= 0 || size > MAX_RECEIPT_BYTES) return { sent: false, reason: 'invalid-receipt' };
    receiptText = fs.readFileSync(receiptPath, 'utf8');
  } catch (error) {
    return { sent: false, reason: 'invalid-receipt' };
  }
  let receipt;
  try { receipt = JSON.parse(receiptText); }
  catch (error) { return { sent: false, reason: 'invalid-receipt' }; }
  if (receiptError(receipt, siteId)) return { sent: false, reason: 'invalid-receipt' };

  const callbackAt = options.callbackAt || new Date().toISOString();
  if (!validTimestamp(callbackAt)) return { sent: false, reason: 'invalid-callback-time' };
  const envelope = signedEnvelope(receipt, secret, callbackAt);
  const body = JSON.stringify(envelope);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wait = options.wait || waitMs;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : CALLBACK_TIMEOUT_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body,
      }, timeoutMs);
      if (await responseAcknowledged(response, receipt.deploy_id)) {
        return { sent: true, attempts: attempt, deployId: receipt.deploy_id };
      }
    } catch (error) {
      // Deliberately suppress network details: fetch errors may contain the URL.
    }
    if (attempt < MAX_ATTEMPTS) await wait(250 * (2 ** (attempt - 1)));
  }
  return { sent: false, attempts: MAX_ATTEMPTS, reason: 'callback-not-acknowledged' };
}

module.exports = {
  isDevelopBranchDeploy,
  previewCallbackUrl,
  receiptError,
  signedEnvelope,
  fetchWithTimeout,
  deliverPreviewCallback,
};
