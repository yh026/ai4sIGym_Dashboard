#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SITE_ID } = require('./hook.cjs');
const { stagePreviewBuild } = require('./plugin.cjs');
async function main() {
  const env = process.env, checkout = process.cwd();
  const build = require(path.join(checkout, 'build.js'));
  const policy = build.resolveBuildContentPolicy(env);
  if (env.SITE_ID !== SITE_ID || env.NETLIFY !== 'true' || env.BRANCH !== 'develop' || env.CONTEXT !== 'branch-deploy'
    || !build.resolvePreviewHookReceipt(env, policy).verified) throw new Error('Use Update preview in the control panel to deploy develop.');
  const result = spawnSync(process.execPath, [path.join(checkout, 'build.js')], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Preview build failed; no release artifact was staged.');
  await stagePreviewBuild({ env, checkout, publishDir: path.join(checkout, 'dist') });
  console.log('Manual preview artifact stored; activation waits for successful deployment.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
