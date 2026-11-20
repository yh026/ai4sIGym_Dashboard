import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the deploy command rejects a bundler without protected-site user support before reading credentials', async (t) => {
  const cli = await mkdtemp(path.join(tmpdir(), 'gym-deploy-tools-'));
  t.after(() => rm(cli, { recursive: true, force: true }));
  const packages = path.join(cli, 'node_modules', '@netlify');
  const bundler = path.join(packages, 'zip-it-and-ship-it');
  const runtime = path.join(packages, 'serverless-functions-api');
  const helper = path.join(cli, 'dist', 'utils');
  await Promise.all([bundler, runtime, helper].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    path.join(cli, 'package.json'),
    JSON.stringify({ name: 'netlify-cli', version: '27.4.0', type: 'module' }),
  );
  await writeFile(path.join(bundler, 'index.js'), '');
  await writeFile(path.join(helper, 'command-helpers.js'), "throw Error('Test reached credential lookup.');");
  const command = fileURLToPath(new URL('../deploy-desk.mjs', import.meta.url));
  for (const [version, expected] of [
    ['2.18.0', /does not supply the signed-in user/],
    ['2.24.0', /Test reached credential lookup/],
  ]) {
    await writeFile(
      path.join(runtime, 'package.json'),
      JSON.stringify({ name: '@netlify/serverless-functions-api', version }),
    );
    const result = spawnSync(process.execPath, [command, cli], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});
