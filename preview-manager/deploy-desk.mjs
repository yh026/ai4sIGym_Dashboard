// Deploy only the control plane. Never place its provisioned key in a command line,
// a project environment variable, the static directory, or a content preview.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { SITE, OWNER, ALIAS } from './server/store.mjs';
import { protectedSite, api } from './server/native.mjs';
const cli = await realpath(path.resolve(process.argv[2] || ''));
const load = (relative) => import(pathToFileURL(path.join(cli, relative)));
const pkg = JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8'));
if (pkg.name !== 'netlify-cli' || Number(pkg.version.split('.')[0]) < 27)
  throw Error('Use a Netlify CLI with protected-site context.user support.');
// The CLI bundles the Functions runtime with each deploy. Earlier versions
// accept a protected-site login at the edge but omit the user in the function.
const cliRequire = createRequire(path.join(cli, 'package.json'));
const bundlerRequire = createRequire(cliRequire.resolve('@netlify/zip-it-and-ship-it'));
const runtime = bundlerRequire('@netlify/serverless-functions-api/package.json');
const [major, minor] = runtime.version.split('.').map(Number);
if (!(major > 2 || (major === 2 && minor >= 24)))
  throw Error(
    `Netlify Functions runtime ${runtime.version} does not supply the signed-in user. Use Netlify CLI 27.20.0 or a CLI bundling Functions runtime 2.24.0 or newer.`,
  );
const { getToken } = await load('dist/utils/command-helpers.js');
const [active] = await getToken();
const authorizedCLI = process.argv.includes('--use-approved-cli-grant');
const credential = process.env.GYM_PREVIEW_DEPLOY_TOKEN || (authorizedCLI ? active : null);
if (!credential) throw Error('Set GYM_PREVIEW_DEPLOY_TOKEN or explicitly choose the approved CLI grant.');
const site = await protectedSite(active);
if ((await api(active, '/user')).id !== OWNER)
  throw Error('Only the configured owner can provision this control plane.');
await protectedSite(credential);
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await import('./prepare.mjs');
const { createMainCommand } = await load('dist/commands/main.js');
const { runProgram } = await load('dist/utils/run-program.js');
process.env.NETLIFY_CLI_TELEMETRY_DISABLED = '1';
const program = createMainCommand();
const args = [
  process.execPath,
  'netlify',
  'deploy',
  '--site',
  SITE,
  '--alias',
  ALIAS,
  '--no-build',
  '--skip-functions-cache',
  '--dir',
  '.preview/desk',
  '--functions',
  '.preview/functions',
  '--message',
  'Instrumentation Gym private preview desk',
  '--json',
  '--secret-env',
  'GYM_PREVIEW_DEPLOY_TOKEN=' + credential,
];
try {
  await runProgram(program, args);
  program.onEnd();
  const after = await protectedSite(active);
  if (after.published_deploy.id !== site.published_deploy.id)
    throw Error('Production changed during control desk provisioning.');
} catch (err) {
  // The CLI may include an argument in a parse error; serialise only redacted text.
  console.error(String(err.message).replaceAll(credential, '[masked]'));
  process.exitCode = 1;
}
