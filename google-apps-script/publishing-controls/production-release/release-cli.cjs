#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createReleaseIntent, assertCurrentIntent } = require('./release-plan.cjs');
const { createNetlifyBridge, validateArtifact } = require('./netlify-bridge.cjs');
const { verifyPinnedSource, deploymentSnapshot, renderArtifact } = require('./artifact-renderer.cjs');
const { loadCatalogRenderer } = require('./catalog-renderer.cjs');

function readJson(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function readFiles(directory) {
  const root = path.resolve(directory), files = new Map();
  const visit = location => {
    const stat = fs.lstatSync(location);
    if (stat.isSymbolicLink()) throw new Error('Release CLI: artifact symlinks are forbidden');
    if (stat.isDirectory()) for (const child of fs.readdirSync(location)) visit(path.join(location, child));
    else if (stat.isFile()) files.set(path.relative(root, location).split(path.sep).join('/'), fs.readFileSync(location));
    else throw new Error('Release CLI: artifact contains a special file');
  };
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Release CLI: artifact must be a directory');
  visit(root); return files;
}
function renderLocal(options) {
  const configuration = readJson(options['--input']);
  const relative = filename => path.resolve(path.dirname(path.resolve(options['--input'])), filename);
  const load = environment => {
    const source = configuration.sources?.[environment];
    if (!source) throw new Error('Release CLI: pinned production and preview sources are required');
    return verifyPinnedSource({ metadata: readJson(relative(source.metadata)),
      inventory: readJson(relative(source.inventory)), files: readFiles(relative(source.directory)) }, environment);
  };
  const baseline = load('production'), preview = load('preview');
  const overrides = (baseline.receipt.publication_overrides || []).map(row => row.id);
  const catalog = new Map([...baseline.manifest.demos, ...preview.manifest.demos].map(row =>
    [row.demo_id, { demo_id: row.demo_id, slug: row.slug }]));
  const current = { catalog: [...catalog.values()], selection: configuration.selection,
    baseline: deploymentSnapshot(baseline, overrides), preview: deploymentSnapshot(preview, overrides),
    now: new Date().toISOString() };
  const intent = createReleaseIntent(current);
  const catalogRenderer = loadCatalogRenderer(relative(configuration.renderer.checkout), configuration.renderer.digest);
  const rendered = renderArtifact({ intent, current, baseline, preview, catalogRenderer });
  const artifactDirectory = path.resolve(options['--artifact']);
  if (fs.existsSync(artifactDirectory)) throw new Error('Release CLI: artifact output already exists');
  const output = path.resolve(options['--output']);
  const companions = { input: output + '.input.json', intent: output + '.intent.json', evidence: output + '.evidence.json' };
  if (Object.values(companions).some(filename => fs.existsSync(filename))) throw new Error('Release CLI: companion output exists');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  for (const [name, bytes] of rendered.artifact.files) {
    const target = path.join(artifactDirectory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  for (const [key, value] of Object.entries({ input: current, intent, evidence: rendered.renderer_evidence })) {
    fs.writeFileSync(companions[key], JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return { schema: 1, artifact_directory: artifactDirectory, artifact_digest: rendered.artifact_digest,
    project_count: intent.projects.length, file_count: rendered.artifact.files.size,
    renderer_digest: catalogRenderer.source_digest, ...companions, intent_digest: intent.intent_digest };
}
async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv, options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!/^--[a-z-]+$/.test(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Release CLI: invalid arguments');
    }
    options[key] = args[i + 1];
  }
  const allowed = new Set(['--input', '--intent', '--artifact', '--artifact-digest', '--evidence', '--candidate',
    '--confirm', '--output', '--cli-token-helper', '--resume-draft']);
  if (!['render', 'plan', 'verify', 'draft', 'publish'].includes(action) || Object.keys(options).some(k => !allowed.has(k))) {
    throw new Error('Release CLI: use render, plan, verify, draft, or publish');
  }
  if (!options['--input'] || !options['--output']) throw new Error('Release CLI: --input and --output are required');
  if (fs.existsSync(options['--output'])) throw new Error('Release CLI: output exists; choose a new report file');
  let result;
  if (action === 'render') result = renderLocal(options);
  else if (action === 'plan') result = createReleaseIntent({ ...readJson(options['--input']), now: new Date().toISOString() });
  else {
    const current = { ...readJson(options['--input']), now: new Date().toISOString() };
    const intent = readJson(options['--intent']);
    assertCurrentIntent(intent, current);
    const input = { intent, current };
    if (action === 'verify' || action === 'draft') {
      input.artifact = { schema: 1, intent_digest: intent.intent_digest, files: readFiles(options['--artifact']) };
      input.reviewedArtifactDigest = options['--artifact-digest'];
      input.rendererEvidence = readJson(options['--evidence']);
      result = validateArtifact(intent, input.artifact, input.reviewedArtifactDigest);
    }
    if (action === 'draft' || action === 'publish') {
      let token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token && options['--cli-token-helper']) {
        const helper = await import(pathToFileURL(path.resolve(options['--cli-token-helper'])).href);
        [token] = await helper.getToken();
      }
      const bridge = createNetlifyBridge({ token });
      if (action === 'draft') result = await bridge.prepare({ ...input, resumeCandidateId: options['--resume-draft'] });
      else result = await bridge.publish({ ...input, candidate: readJson(options['--candidate']),
        confirmation: options['--confirm'] });
    }
  }
  fs.writeFileSync(options['--output'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Release ' + action + ' completed. Report: ' + path.resolve(options['--output']));
  return result;
}
if (require.main === module) main().catch(error => {
  const message = error.message?.startsWith('Release ') ? error.message : 'Release CLI: operation failed; no credentials logged';
  console.error(message); process.exitCode = 1;
});
module.exports = { main, readFiles, renderLocal };
