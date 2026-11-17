'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'netlify-plugin/index.js'), 'utf8');
function plugin(report, save, crossedBoundary = false) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, console: { log() {} },
    process: { cwd: () => '/fixture', env: { DEPLOY_ID: 'current-deploy' } },
    require(name) {
      if (name === '../plugin.cjs') return { reportFailedBuild: report };
      if (name === '../cache.cjs') return { cacheLifecycle: save };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { readFileSync() {
        if (!crossedBoundary) throw new Error('No deployment boundary');
        return JSON.stringify({ deploy_id: 'current-deploy' });
      } };
      throw new Error('Unexpected dependency');
    } });
  return module.exports;
}

test('a handled pre-deployment failure persists verified input cache after reporting failure', async () => {
  const events = [], utils = { cache: {} };
  const p = plugin(async ({ beforeDeployment }) => { assert.equal(beforeDeployment, true); events.push('failure'); return { sent: true }; },
    async (operation, options) => { assert.equal(options.utils, utils); events.push(operation); });
  await p.onError({ utils });
  assert.deepEqual(events, ['failure', 'save']);
});

test('cache persistence survives a failed callback without declaring a possible deployment failed', async () => {
  const events = [];
  const p = plugin(async ({ beforeDeployment }) => {
    assert.equal(beforeDeployment, false); events.push('callback'); throw new Error('Callback unavailable');
  }, async operation => events.push(operation), true);
  await assert.rejects(p.onError({ utils: {} }), /Callback unavailable/);
  assert.deepEqual(events, ['callback', 'save']);
});
