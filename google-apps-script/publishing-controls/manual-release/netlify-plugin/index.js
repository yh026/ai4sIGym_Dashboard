'use strict';
const { exportSuccessfulBuild, reportFailedBuild } = require('../plugin.cjs');
const fs = require('node:fs');
const path = require('node:path');
const boundary = () => path.join(process.cwd(), '.ais-release-deploy-boundary.json');
module.exports = {
  onPostBuild: () => { fs.writeFileSync(boundary(), JSON.stringify({ deploy_id: process.env.DEPLOY_ID })); },
  onSuccess: async ({ constants = {} } = {}) => {
    const result = await exportSuccessfulBuild({ publishDir: constants.PUBLISH_DIR || 'dist' });
    if (result.sent) console.log('Manual publishing source recorded for ' + result.kind + '.');
  },
  // Netlify invokes onError for build/deploy failure. An onSuccess callback error
  // is a soft plugin failure and must never be reported as an unpublished build.
  onError: async () => {
    let deploymentMayHaveStarted = false;
    try { deploymentMayHaveStarted = JSON.parse(fs.readFileSync(boundary(), 'utf8')).deploy_id === process.env.DEPLOY_ID; } catch {}
    // A deploy transport error can be ambiguous. Only a pre-deploy failure is
    // final here; later errors require reconciliation against the served receipt.
    const result = await reportFailedBuild({ beforeDeployment: !deploymentMayHaveStarted });
    if (result.sent) console.log('Manual publishing build failure recorded.');
  },
};
