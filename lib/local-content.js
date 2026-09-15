'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compileRegistryV2Sheet } = require('./registry-v2-sheet-adapter');
const { toRegistryV2 } = require('./registry-v2');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
      || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '..' || p === '.')) {
    throw new Error('Unsafe local content path: ' + relative);
  }
  const base = fs.realpathSync(root);
  const file = fs.realpathSync(path.join(base, relative));
  if (!file.startsWith(base + path.sep)) throw new Error('Local content path escapes its directory.');
  if (!fs.statSync(file).isFile()) throw new Error('Local content path is not a file: ' + relative);
  return file;
}

function localContentPolicy(env = process.env) {
  if (String(env.NETLIFY || '').toLowerCase() === 'true'
      || ['production', 'branch-deploy', 'deploy-preview'].includes(env.CONTEXT)) {
    throw new Error('--local is for local development only; it cannot run in a Netlify deployment.');
  }
  return { audience: 'preview', context: 'local', branch: 'local', netlify: false };
}

function verifySnapshot(directory) {
  const inventoryBytes = fs.readFileSync(inside(directory, 'inventory.json'));
  const inventory = JSON.parse(inventoryBytes);
  if (inventory.schema_version !== 1 || !Array.isArray(inventory.files)
      || !Array.isArray(inventory.projects) || !inventory.files.length) {
    throw new Error('Unsupported or empty local content inventory.');
  }
  const snapshotBytes = fs.readFileSync(inside(directory, 'registry.snapshot.json'));
  if (sha256(snapshotBytes) !== inventory.registry_snapshot_sha256) {
    throw new Error('Registry snapshot changed. Refresh the Drive snapshot before building.');
  }
  const files = new Map();
  const paths = new Set();
  let bytes = 0;
  for (const file of inventory.files) {
    if (!file.id || files.has(file.id) || paths.has(file.path)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[0-9a-f]{64}$/.test(file.sha256 || '')) {
      throw new Error('Invalid or duplicate inventory file: ' + file.path);
    }
    const data = fs.readFileSync(inside(directory, file.path));
    if (data.length !== file.bytes || sha256(data) !== file.sha256) {
      throw new Error('Drive snapshot file changed: ' + file.path + '. Edit a copy in local-content/v2/.');
    }
    files.set(file.id, file);
    paths.add(file.path);
    bytes += data.length;
  }
  const slugs = new Set();
  for (const project of inventory.projects) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug || '') || slugs.has(project.slug)
        || files.get(project.primary_file_id)?.path !== project.primary_path) {
      throw new Error('Project entry is missing or ambiguous: ' + project.slug);
    }
    slugs.add(project.slug);
  }
  const allowed = new Set([...paths, 'inventory.json', 'registry.snapshot.json']);
  function checkExtraFiles(folder, prefix = '') {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Local snapshot contains a symlink: ' + relative);
      if (entry.isDirectory()) checkExtraFiles(path.join(folder, entry.name), relative + '/');
      else if (!allowed.has(relative)) {
        throw new Error('Unrecorded local file: ' + relative + '. Move authoring files to local-content/v2/ before refreshing.');
      }
    }
  }
  checkExtraFiles(directory);
  return {
    inventory, files, bytes,
    snapshot: JSON.parse(snapshotBytes),
    revision: 'sha256:' + sha256(Buffer.concat([inventoryBytes, snapshotBytes])),
  };
}

function loadLocalRegistry(directory) {
  const verified = verifySnapshot(directory);
  const result = compileRegistryV2Sheet(verified.snapshot);
  const manifest = toRegistryV2(result.compiled);
  const assets = new Map(result.compiled.hidden._Assets.map(asset => [asset.asset_id, asset]));
  const revision = verified.revision;

  function read(id) {
    const file = verified.files.get(id);
    if (!file) throw new Error('File is absent from the local snapshot: ' + id);
    const bytes = fs.readFileSync(inside(directory, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error('Source changed while building: ' + file.path);
    }
    return { file, bytes };
  }

  return {
    schemaVersion: manifest.schema_version,
    taxonomy: manifest.taxonomy,
    site: result.siteMetadata,
    demos: manifest.demos,
    audience: 'preview',
    registryRevision: revision,
    getHtml: async id => ({ html: read(id).bytes.toString('utf8'), registryRevision: revision }),
    getAsset: async id => {
      const asset = assets.get(id);
      if (!asset) throw new Error('Unknown local card asset: ' + id);
      const { bytes } = read(asset.drive_file_id);
      return {
        ok: true, kind: 'card_image', id,
        mime: asset.mime_type,
        extension: path.extname(asset.public_path).slice(1).toLowerCase(),
        size: bytes.length, base64: bytes.toString('base64'), registry_revision: revision,
      };
    },
    getRevision: async () => verifySnapshot(directory).revision,
  };
}

function compareSnapshots(before, after) {
  const oldFiles = new Map((before?.files || []).map(file => [file.path, file]));
  const newFiles = new Map(after.files.map(file => [file.path, file]));
  return {
    added: [...newFiles.keys()].filter(name => !oldFiles.has(name)),
    updated: [...newFiles.keys()].filter(name => oldFiles.has(name)
      && (oldFiles.get(name).sha256 !== newFiles.get(name).sha256
        || oldFiles.get(name).id !== newFiles.get(name).id)),
    removed: [...oldFiles.keys()].filter(name => !newFiles.has(name)),
  };
}

module.exports = { inside, sha256, localContentPolicy, verifySnapshot, loadLocalRegistry, compareSnapshots };
