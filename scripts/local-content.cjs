#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifySnapshot, compareSnapshots, sha256, inside, loadLocalRegistry } = require('../lib/local-content');
const root = path.resolve(__dirname, '..');
const current = path.join(root, 'local-content', 'drive-current');

function seal(directory) {
  const file = path.join(directory, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of inventory.files) {
    const bytes = fs.readFileSync(inside(directory, entry.path));
    if (bytes.length !== entry.bytes) throw new Error('Incomplete download: ' + entry.path);
    entry.sha256 = sha256(bytes);
    if (entry.mime_type === 'text/html') {
      const html = bytes.toString('utf8');
      if (!/<(?:html\b|!doctype\s+html)/i.test(html)) throw new Error('Not an HTML document: ' + entry.path);
      entry.html_closed = /<\/html\s*>/i.test(html);
    }
  }
  inventory.registry_snapshot_sha256 = sha256(fs.readFileSync(path.join(directory, 'registry.snapshot.json')));
  inventory.captured_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(inventory, null, 2) + '\n');
  return verifySnapshot(directory);
}

function install(directory) {
  const source = fs.realpathSync(directory);
  if (source === current || source.startsWith(current + path.sep)) throw new Error('Stage must be outside drive-current.');
  const next = verifySnapshot(source);
  // Compile before replacing a usable snapshot. Invalid Sheet data never becomes current.
  loadLocalRegistry(source);
  const before = fs.existsSync(current) ? verifySnapshot(current).inventory : null;
  const changes = compareSnapshots(before, next.inventory);
  const previous = current + '.previous-' + Date.now();
  let moved = false;
  try {
    if (fs.existsSync(current)) { fs.renameSync(current, previous); moved = true; }
    fs.renameSync(source, current);
  } catch (error) {
    if (moved && !fs.existsSync(current)) fs.renameSync(previous, current);
    throw error;
  }
  if (moved) fs.rmSync(previous, { recursive: true });
  const report = { captured_at: next.inventory.captured_at, projects: next.inventory.projects.length,
    files: next.files.size, bytes: next.bytes, ...changes };
  fs.writeFileSync(path.join(root, 'local-content', 'last-refresh.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

function main() {
  const command = process.argv[2] || 'verify';
  const directory = path.resolve(process.argv[3] || current);
  if (command === 'verify') {
    const result = verifySnapshot(directory);
    console.log(JSON.stringify({ projects: result.inventory.projects.length, files: result.files.size,
      bytes: result.bytes, captured_at: result.inventory.captured_at }, null, 2));
  } else if (command === 'seal') {
    const result = seal(directory);
    console.log(JSON.stringify({ files: result.files.size, bytes: result.bytes }));
  } else if (command === 'install') {
    console.log(JSON.stringify(install(directory), null, 2));
  } else throw new Error('Usage: node scripts/local-content.cjs verify|seal|install [snapshot-directory]');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { seal, install };
