#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { optimizeSiteOutput } = require('../lib/site-performance');
const root = path.resolve(__dirname, '..');
const builder = 'ct-pattern-atlas-local-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Build this new demo independently, before its Drive/Registry onboarding.
// The normal Gym build uses the same optimizeSiteOutput transformation.
function main() {
  if (process.env.NETLIFY) throw new Error('This standalone build is for local review only.');
  const source = path.join(root, 'content/projects/ct-pattern-atlas/ct_pattern_atlas_insight.html');
  const output = path.join(root, '.local/ct-pattern-atlas-site');
  const previous = output + '.previous';
  const page = 'demos/ct-pattern-atlas/index.html';
  const original = fs.readFileSync(source);
  const sourceHash = hash(original);
  if (fs.existsSync(previous)) throw new Error('Previous build backup exists; inspect it before rebuilding.');
  if (fs.existsSync(output)) {
    const receipt = path.join(output, 'build-info.json');
    if (fs.lstatSync(output).isSymbolicLink() || !fs.existsSync(receipt)
        || JSON.parse(fs.readFileSync(receipt, 'utf8')).builder !== builder) {
      throw new Error('Refusing to replace an unrecognized local output directory.');
    }
  }
  fs.mkdirSync(path.join(root, '.local'), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, '.local/ct-pattern-atlas-build-'));
  try {
    const target = path.join(stage, page);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, original);
    const performance = optimizeSiteOutput(stage);
    const result = performance.pages.find(item => item.path === page);
    if (!result?.video?.applied) {
      throw new Error('Video was not externalized: ' + (result?.video?.skippedReason || 'missing result'));
    }
    if (hash(fs.readFileSync(source)) !== sourceHash) throw new Error('Source changed during the build.');
    const info = {
      builder, built_at: new Date().toISOString(), publication: 'local-only',
      source: { path: path.relative(root, source), bytes: original.length, sha256: sourceHash },
      page: { path: page, bytes: result.outputBytes, sha256: hash(fs.readFileSync(target)) },
      assets: performance.assets,
    };
    fs.writeFileSync(path.join(stage, 'performance-report.json'), JSON.stringify(performance, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    if (fs.existsSync(output)) fs.renameSync(output, previous);
    try { fs.renameSync(stage, output); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, output);
      throw error;
    }
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    console.log('Local build: ' + path.join(output, page));
    console.log('HTML: ' + original.length + ' → ' + result.outputBytes + ' bytes');
    console.log('Video: ' + result.video.videoBytes + ' bytes; poster: ' + result.video.posterBytes + ' bytes');
    return info;
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
