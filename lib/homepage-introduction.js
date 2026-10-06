'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const ID = 'homepage-introduction-v1';
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SECTION_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const PROJECT_ANCHOR = '  <section class="project-library" id="projects" aria-labelledby="projects-title">';
const PUBLIC_ROLES = Object.freeze({
  stylesheet: ['runtime', 'css'], script: ['runtime', 'js'],
  poster: ['optimized', 'jpg'], video: ['optimized', 'mp4'],
});
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireValid = (condition, message) => {
  if (!condition) throw new Error('Homepage introduction: ' + message);
};

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function uniquePosition(bytes, needle, description) {
  const token = Buffer.from(needle);
  const position = bytes.indexOf(token);
  requireValid(position >= 0 && bytes.indexOf(token, position + token.length) === -1,
    'requires one exact ' + description + ' anchor');
  return position;
}

function insertion(role, content) {
  return Buffer.from('<!-- ' + ID + ':' + role + ':begin -->\n' + content
    + '\n<!-- ' + ID + ':' + role + ':end -->\n');
}

function applyHomepageIntroduction({ files, config, releaseDirectory, outputDirectory }) {
  if (config === undefined || config === null) return { files, override: null };
  requireValid(config && typeof config === 'object' && !Array.isArray(config) && config.id === ID,
    'unsupported supplement identity');
  requireValid(SHA.test(config.input_index_sha256 || ''), 'invalid input homepage hash');
  requireValid(files instanceof Map && Buffer.isBuffer(files.get('index.html')), 'homepage bytes are required');
  const original = files.get('index.html');
  requireValid(digest(original) === config.input_index_sha256, 'input homepage hash mismatch');
  requireValid(!original.includes(Buffer.from('<!-- ' + ID + ':')), 'homepage already contains introduction markers');
  requireValid(Array.isArray(config.files) && config.files.length === 5, 'exactly five supplement roles are required');
  requireValid(typeof releaseDirectory === 'string' && typeof outputDirectory === 'string',
    'release and output directories are required');

  const root = path.resolve(releaseDirectory);
  requireValid(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'release root must be a real directory');
  const actualRoot = fs.realpathSync(root);
  const sourceDirectory = path.join(root, 'homepage-video');
  requireValid(fs.lstatSync(sourceDirectory).isDirectory() && !fs.lstatSync(sourceDirectory).isSymbolicLink(),
    'homepage-video must be a real directory, not a symlink');
  requireValid(fs.realpathSync(sourceDirectory) === path.join(actualRoot, 'homepage-video'), 'source directory escapes release root');
  const output = path.resolve(outputDirectory);
  let outputStat;
  try { outputStat = fs.lstatSync(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireValid(!outputStat || !outputStat.isSymbolicLink(), 'output must not be a symlink');
  const actualOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const roles = new Map(), sources = new Set(), destinations = new Set();
  for (const entry of config.files) {
    requireValid(entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry.role === 'section' || Object.hasOwn(PUBLIC_ROLES, entry.role)) && !roles.has(entry.role),
    'unknown or duplicate supplement role');
    requireValid(typeof entry.source === 'string'
      && /^homepage-video\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.source) && !sources.has(entry.source),
    'unsafe or duplicate source path');
    requireValid(SHA.test(entry.sha256 || '') && Number.isSafeInteger(entry.size) && entry.size >= 0
      && entry.size <= (entry.role === 'section' ? MAX_SECTION_BYTES : MAX_FILE_BYTES),
    'invalid or oversized supplement file');
    if (entry.role === 'section') {
      requireValid(entry.path === undefined, 'section must not have a public path');
    } else {
      const [directory, extension] = PUBLIC_ROLES[entry.role];
      requireValid(entry.path === `assets/${directory}/${entry.sha256}.${extension}`, 'public path must match role and content hash');
      requireValid(!files.has(entry.path) && !destinations.has(entry.path), 'public resource collision');
      destinations.add(entry.path);
    }
    const source = path.join(root, entry.source);
    const stat = fs.lstatSync(source);
    requireValid(stat.isFile() && !stat.isSymbolicLink(), 'source must be a regular file, not a symlink');
    requireValid(fs.realpathSync(source) === path.join(actualRoot, entry.source), 'source escapes release root');
    requireValid(!contains(actualOutput, fs.realpathSync(source)), 'output must not contain supplement inputs');
    requireValid(stat.size === entry.size, 'source size mismatch: ' + entry.role);
    const bytes = fs.readFileSync(source);
    requireValid(bytes.length === entry.size && digest(bytes) === entry.sha256, 'source hash or size mismatch: ' + entry.role);
    roles.set(entry.role, { ...entry, bytes });
    sources.add(entry.source);
  }
  requireValid(roles.has('section') && Object.keys(PUBLIC_ROLES).every(role => roles.has(role)), 'required supplement role missing');

  let section;
  try { section = new TextDecoder('utf-8', { fatal: true }).decode(roles.get('section').bytes); }
  catch { throw new Error('Homepage introduction: section must be valid UTF-8'); }
  requireValid(section.includes('{{POSTER_URL}}') && section.includes('{{VIDEO_URL}}'), 'section URL placeholders are required');
  requireValid(!section.includes('<!-- ' + ID + ':'), 'section must not contain insertion markers');
  section = section.split('{{POSTER_URL}}').join('/' + roles.get('poster').path)
    .split('{{VIDEO_URL}}').join('/' + roles.get('video').path);
  const insertions = [
    { position: uniquePosition(original, '</head>', 'head'),
      bytes: insertion('stylesheet', '  <link rel="stylesheet" href="/' + roles.get('stylesheet').path + '">') },
    { position: uniquePosition(original, PROJECT_ANCHOR, 'project library'), bytes: insertion('section', section) },
    { position: uniquePosition(original, '</body>', 'body'),
      bytes: insertion('script', '  <script src="/' + roles.get('script').path + '" defer></script>') },
  ].sort((a, b) => a.position - b.position);
  const chunks = [];
  let start = 0;
  for (const item of insertions) {
    chunks.push(original.subarray(start, item.position), item.bytes);
    start = item.position;
  }
  chunks.push(original.subarray(start));
  const updated = Buffer.concat(chunks);
  requireValid(updated.length <= MAX_FILE_BYTES, 'updated homepage exceeds file size limit');
  const result = new Map(files);
  result.set('index.html', updated);
  const addedFiles = [];
  for (const role of Object.keys(PUBLIC_ROLES)) {
    const entry = roles.get(role);
    result.set(entry.path, entry.bytes);
    addedFiles.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
  }
  let total = 0;
  for (const bytes of result.values()) {
    requireValid(Buffer.isBuffer(bytes) && bytes.length <= MAX_FILE_BYTES, 'invalid or oversized public file');
    total += bytes.length;
    requireValid(total <= MAX_TOTAL_BYTES, 'combined public files exceed release size limit');
  }
  return { files: result, override: { id: ID,
    modified_files: [{ path: 'index.html', input_sha256: config.input_index_sha256, output_sha256: digest(updated) }],
    added_files: addedFiles } };
}

module.exports = { applyHomepageIntroduction };
