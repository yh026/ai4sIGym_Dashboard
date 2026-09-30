'use strict';

// This release lane publishes one explicitly reviewed, immutable preview
// artifact. It never reads Drive or changes the normal Draft/Published policy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');

const AUTHORIZED_DEMOS = Object.freeze([
  'air-quality-day-segment-pca-and-amp-umap-by-sensor',
  'alzheimer-s-gene-co-expression-explorer',
  'battery-curve-shape-explorer',
  'ceemdan-battery-forecasting',
  'from-twelve-thousand-numbers-to-a-codebook',
  'from-twenty-thousand-genes-to-fourteen-cell-types',
  'galaxy2-does-rotation-augmentation-help',
  'jae-joint-embedding-how-one-cell-becomes-61-numbers',
  'pleiades-membership-explorer',
  'singapore-road-speed-clusters-umap',
  'soh-battery',
  'superconductor-regression-explorer',
  'tbb-cluster-explorer-2',
]);
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (condition, message) => { if (!condition) throw new Error('Production release: ' + message); };

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 240
    && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..');
}

function productionPolicy(env = process.env, { local = false } = {}) {
  const netlify = String(env.NETLIFY || '').toLowerCase() === 'true';
  if (local) {
    need(!netlify && !['production', 'branch-deploy', 'deploy-preview', 'dev'].includes(env.CONTEXT),
      '--local is forbidden in deployment environments');
    return { platform: 'local-release-validation', context: 'local', branch: 'local',
      site_id: null, commit_ref: null, build_id: null, deploy_id: null };
  }
  need(netlify && env.CONTEXT === 'production' && env.BRANCH === 'main',
    'requires NETLIFY=true, CONTEXT=production, BRANCH=main (or explicit --local)');
  need(COMMIT.test(env.COMMIT_REF || ''), 'missing current production commit');
  need(/^[a-f0-9-]{20,64}$/i.test(env.SITE_ID || ''), 'missing current production site identity');
  need(ID.test(env.BUILD_ID || '') && ID.test(env.DEPLOY_ID || ''), 'missing current production build/deploy identity');
  return { platform: 'netlify', context: 'production', branch: 'main', site_id: env.SITE_ID,
    commit_ref: env.COMMIT_REF, build_id: env.BUILD_ID, deploy_id: env.DEPLOY_ID };
}

function validateReleaseManifest(manifest) {
  need(manifest && manifest.schema === 1, 'unsupported manifest schema');
  need(manifest.archive && safePath(manifest.archive.path) && manifest.archive.path.endsWith('.tar.gz')
    && SHA.test(manifest.archive.sha256 || ''), 'invalid archive identity');
  const source = manifest.source;
  need(source && source.verified === true && COMMIT.test(source.commit_ref || '')
    && /^sha256:[a-f0-9]{64}$/.test(source.registry_revision || '') && ID.test(source.deploy_id || ''),
  'verified preview commit, revision and deploy identity are required');
  for (const [key, pattern] of Object.entries({ receipt_sha256: SHA, site_id: /^[a-f0-9-]{20,64}$/i,
    build_id: ID, registry_instance: /^[a-z0-9-]+$/ })) {
    need(source[key] === undefined || pattern.test(source[key]), 'invalid preview proof field: ' + key);
  }
  need(Array.isArray(manifest.demo_slugs)
    && JSON.stringify([...manifest.demo_slugs].sort()) === JSON.stringify(AUTHORIZED_DEMOS),
  'release must contain exactly the 13 authorized demos');
  need(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES,
    'invalid file inventory');
  const files = new Map();
  let total = 0;
  for (const file of manifest.files) {
    need(file && safePath(file.path) && !files.has(file.path) && SHA.test(file.sha256 || '')
      && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES,
    'invalid or duplicate inventory file');
    need(!['_headers', '_redirects', 'robots.txt', 'deploy-receipt.json'].includes(file.path),
      'deployment control files must be generated for Production');
    files.set(file.path, file); total += file.size;
  }
  need(total <= MAX_TOTAL_BYTES, 'file inventory exceeds release size limit');
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) need(!files.has(parts.slice(0, i).join('/')), 'file/directory path collision');
  }
  need(files.has('index.html') && files.has('manifest.json'), 'homepage and public manifest are required');
  return files;
}

function octal(field, name) {
  need(field[0] < 128, 'unsupported binary TAR ' + name);
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  need(/^[0-7]+$/.test(value), 'invalid TAR ' + name);
  const result = Number.parseInt(value, 8);
  need(Number.isSafeInteger(result), 'oversized TAR ' + name);
  return result;
}

function tarString(field) {
  const end = field.indexOf(0);
  if (end >= 0) need(field.subarray(end).every(byte => byte === 0), 'ambiguous TAR string');
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? field : field.subarray(0, end));
}

// No extraction tool runs on untrusted names. Reject all TAR link, sparse,
// PAX/GNU extension and device types; the release packager must emit USTAR.
function readUstar(bytes, inventory) {
  need(bytes.length <= MAX_TOTAL_BYTES + MAX_FILES * 1024 && bytes.length % 512 === 0, 'invalid TAR size');
  const files = new Map(), seen = new Set();
  let offset = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      need(bytes.length - offset >= 1024 && bytes.subarray(offset).every(byte => byte === 0), 'invalid TAR trailer');
      ended = true; break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    need(checksum === octal(header.subarray(148, 156), 'checksum'), 'TAR header checksum mismatch');
    need(header.subarray(257, 263).equals(Buffer.from('ustar\0')) && header.subarray(263, 265).toString('ascii') === '00',
      'only USTAR archives are accepted');
    const type = header[156];
    need(type === 0 || type === 48 || type === 53, 'TAR links, special files and extensions are forbidden');
    need(tarString(header.subarray(157, 257)) === '', 'TAR link target is forbidden');
    const prefix = tarString(header.subarray(345, 500)), leaf = tarString(header.subarray(0, 100));
    let name = (prefix ? prefix + '/' : '') + leaf;
    if (type === 53 && name.endsWith('/')) name = name.slice(0, -1);
    need(safePath(name) && !seen.has(name), 'unsafe or duplicate TAR path'); seen.add(name);
    const size = octal(header.subarray(124, 136), 'file size');
    const start = offset + 512, end = start + size;
    need(size <= MAX_FILE_BYTES && end <= bytes.length, 'truncated or oversized TAR file');
    if (type === 53) {
      need(size === 0 && [...inventory.keys()].some(file => file.startsWith(name + '/')), 'unexpected TAR directory');
    } else {
      const expected = inventory.get(name);
      need(expected && expected.size === size, 'unlisted TAR file or size mismatch: ' + name);
      const content = bytes.subarray(start, end);
      need(sha256(content) === expected.sha256, 'file checksum mismatch: ' + name);
      files.set(name, content);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  need(ended && files.size === inventory.size, 'TAR trailer or inventory files missing');
  return files;
}

function allowedFiles(files, manifest) {
  const publicManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('manifest.json')));
  need(publicManifest.schema_version === 3 && Array.isArray(publicManifest.demos)
    && JSON.stringify(publicManifest.demos.map(d => d.slug).sort()) === JSON.stringify(AUTHORIZED_DEMOS),
  'public manifest does not match the authorized release');
  const allowedPages = new Set(['index.html']);
  for (const demo of publicManifest.demos) {
    need(Array.isArray(demo.pages) && demo.pages.length > 0, 'project pages are missing');
    const base = 'demos/' + demo.slug + '/';
    let entry = false;
    for (const page of demo.pages) {
      const routes = { insight: base + 'index.html', legacy: base + 'index.html',
        workflow: base + 'workflow.html', resource_page: base + 'workflow-resources.html' };
      need(page && safePath(page.path) && (page.role === 'dataset'
        ? page.path === base + 'dataset.html' || /^datasets\/[a-z0-9-]+\/index\.html$/.test(page.path)
        : page.path === routes[page.role]), 'public page route does not match its project');
      need(files.has(page.path), 'public page is missing: ' + page.path);
      allowedPages.add(page.path);
      if (['insight', 'legacy'].includes(page.role)) entry = true;
    }
    need(entry, 'project entry page is missing');
    demo.status = 'Live'; demo.public_page_permission = 'Public';
  }
  const domains = new Set((publicManifest.domains || []).map(domain => domain.id));
  // These are the two compatibility redirects emitted by the reviewed build,
  // not additional demo collections. Keep existing inbound URLs working.
  const compatibilityRoutes = new Set(['domains/physics-simulation/index.html', 'domains/earth-climate/index.html']);
  for (const name of files.keys()) {
    if (allowedPages.has(name) || ['manifest.json', 'performance-report.json'].includes(name)) continue;
    if (compatibilityRoutes.has(name)) continue;
    const domain = /^domains\/([a-z0-9-]+)\/index\.html$/.exec(name);
    if (domain && domains.has(domain[1])) continue;
    if (/^assets\/(?:embedded|optimized|runtime)\//.test(name)) {
      const hashed = /^assets\/(?:embedded|optimized|runtime)\/([a-f0-9]{64})\.(?:png|jpe?g|webp|gif|avif|js|css)$/.exec(name);
      need(hashed && sha256(files.get(name)) === hashed[1], 'immutable resource filename does not match its bytes');
      continue;
    }
    if (/^assets\/.+\.(?:png|jpe?g|webp|gif|avif|svg|ico|js|css|json|woff2?|ttf|otf)$/i.test(name)) continue;
    const resource = /^demos\/([a-z0-9-]+)\/resources\/.+\.(?:zip|ipynb|json|csv|tsv|txt|md|pdf)$/i.exec(name);
    if (resource && manifest.demo_slugs.includes(resource[1])) continue;
    need(false, 'file is outside the authorized public routes: ' + name);
  }
  publicManifest.audience = 'production';
  publicManifest.release = { mode: 'frozen-preview-artifact', archive_sha256: manifest.archive.sha256,
    source_commit_ref: manifest.source.commit_ref, source_deploy_id: manifest.source.deploy_id };
  return Buffer.from(JSON.stringify(publicManifest, null, 2) + '\n');
}

function productionHeaders() {
  const blocks = ['/deploy-receipt.json', '  X-Robots-Tag: noindex, nofollow',
    '  Cache-Control: no-store', '  X-Content-Type-Options: nosniff'];
  for (const directory of ['embedded', 'optimized', 'runtime']) blocks.push('', '/assets/' + directory + '/*',
    '  Cache-Control: public, max-age=31536000, immutable', '  X-Content-Type-Options: nosniff');
  return blocks.join('\n') + '\n';
}

function regularFile(filename) {
  need(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink(), 'input must be a regular file');
  return fs.readFileSync(filename);
}

function buildProductionRelease({ manifestPath, outputDirectory, env = process.env, local = false } = {}) {
  const policy = productionPolicy(env, { local });
  need(typeof manifestPath === 'string' && typeof outputDirectory === 'string', 'manifest and output paths are required');
  const manifestFile = path.resolve(manifestPath), output = path.resolve(outputDirectory);
  need(fs.statSync(path.dirname(output)).isDirectory() && output !== path.parse(output).root, 'invalid output directory');
  need(!fs.existsSync(output) || (fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink()), 'output must not be a symlink or file');
  const manifestBytes = regularFile(manifestFile);
  need(manifestBytes.length <= 5 * 1024 * 1024, 'oversized release manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const inventory = validateReleaseManifest(manifest);
  need(local || !manifest.source.site_id || manifest.source.site_id === policy.site_id,
    'reviewed preview belongs to another Netlify site');
  const archiveFile = path.join(path.dirname(manifestFile), manifest.archive.path);
  const actualRoot = fs.realpathSync(path.dirname(manifestFile)), actualArchive = fs.realpathSync(archiveFile);
  need(actualArchive.startsWith(actualRoot + path.sep), 'archive escapes manifest directory');
  const actualOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  need(![fs.realpathSync(manifestFile), actualArchive].some(file => file === actualOutput || file.startsWith(actualOutput + path.sep)),
    'output must not contain release inputs');
  need(fs.statSync(archiveFile).size <= MAX_ARCHIVE_BYTES, 'oversized release archive');
  const archive = regularFile(archiveFile);
  need(sha256(archive) === manifest.archive.sha256, 'archive checksum mismatch');
  const files = readUstar(zlib.gunzipSync(archive, { maxOutputLength: MAX_TOTAL_BYTES + MAX_FILES * 1024 }), inventory);
  const publicManifest = allowedFiles(files, manifest);
  const receipt = { schema: 1, verified: false, revision_bound: true, target: 'production', audience: 'production',
    release_mode: 'frozen-preview-artifact', registry_revision: manifest.source.registry_revision,
    built_at: new Date().toISOString(), ...policy,
    release_manifest_sha256: sha256(manifestBytes), archive_sha256: manifest.archive.sha256,
    source_preview: { verified: true, commit_ref: manifest.source.commit_ref,
      registry_revision: manifest.source.registry_revision, deploy_id: manifest.source.deploy_id } };
  for (const key of ['receipt_sha256', 'site_id', 'build_id', 'registry_instance']) {
    if (manifest.source[key] !== undefined) receipt.source_preview[key] = manifest.source[key];
  }
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.production-release-'));
  try {
    for (const [name, bytes] of files) {
      const destination = path.join(temporary, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, name === 'manifest.json' ? publicManifest : bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(temporary, '_headers'), productionHeaders(), { flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'robots.txt'), 'User-agent: *\nAllow: /\n', { flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'deploy-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    // All validation and writes complete before replacing an earlier output.
    const previous = output + '.release-backup-' + crypto.randomBytes(8).toString('hex');
    const exists = fs.existsSync(output);
    if (exists) fs.renameSync(output, previous);
    try { fs.renameSync(temporary, output); } catch (error) { if (exists) fs.renameSync(previous, output); throw error; }
    if (exists) fs.rmSync(previous, { recursive: true, force: true });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { files: files.size + 3, demos: AUTHORIZED_DEMOS.length, receipt };
}

module.exports = { AUTHORIZED_DEMOS, sha256, safePath, productionPolicy, validateReleaseManifest,
  readUstar, productionHeaders, buildProductionRelease };
