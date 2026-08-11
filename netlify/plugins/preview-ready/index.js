'use strict';

const { deliverPreviewCallback } = require('./lib');

async function onSuccess({ constants = {} } = {}) {
  const result = await deliverPreviewCallback({
    env: process.env,
    publishDir: constants.PUBLISH_DIR,
    siteId: constants.SITE_ID,
  });
  if (result.sent) {
    console.log('Authenticated Preview completion acknowledged for deploy '
      + result.deployId.slice(0, 12) + '.');
  } else if (result.reason !== 'not-develop-branch-deploy') {
    console.warn('Preview completion callback was not acknowledged; automatic duplicate deploys remain disabled.');
  }
}

// Netlify treats every exported plugin entry as a lifecycle event. Keep this
// surface intentionally limited to the one supported event.
module.exports = { onSuccess };
