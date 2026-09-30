#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { buildProductionRelease } = require('../lib/production-release');

function main(args = process.argv.slice(2)) {
  const options = { manifestPath: path.join(__dirname, '../release/production-release.json'),
    outputDirectory: path.join(__dirname, '../dist'), local: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (seen.has(argument)) throw new Error('Duplicate option: ' + argument);
    seen.add(argument);
    if (argument === '--local') options.local = true;
    else if (['--manifest', '--output'].includes(argument) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[argument === '--manifest' ? 'manifestPath' : 'outputDirectory'] = path.resolve(args[++i]);
    } else throw new Error('Unknown or incomplete option: ' + argument);
  }
  const result = buildProductionRelease(options);
  console.log(`Frozen production release validated: ${result.demos} demos, ${result.files} files.`);
  return result;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
