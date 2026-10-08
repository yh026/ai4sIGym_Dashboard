'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
const need = (value, message) => { if (!value) throw new Error('Release capsule: ' + message); };
const safe = name => typeof name === 'string' && name.length < 240 && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..');

function inventory(files) {
  need(files instanceof Map && files.size > 0 && files.size <= MAX_FILES, 'invalid files');
  let total = 0;
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => {
    need(safe(name) && Buffer.isBuffer(bytes), 'unsafe file');
    total += bytes.length; need(total <= MAX_BYTES, 'artifact too large');
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) need(!files.has(parts.slice(0, i).join('/')), 'path collision');
    return { path: name, size: bytes.length, sha256: hash(bytes) };
  });
}
function pack(files, provenance, id = crypto.randomUUID()) {
  const entries = inventory(files);
  const header = Buffer.from(JSON.stringify({ schema: 1, format: 'ais-files-v1', files: entries, provenance }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  const raw = Buffer.concat([prefix, header, ...entries.map(item => files.get(item.path))]);
  need(raw.length <= MAX_BYTES, 'unpacked capsule too large');
  const archive = zlib.gzipSync(raw, { level: 6 });
  const chunks = [];
  for (let offset = 0; offset < archive.length; offset += CHUNK_SIZE) chunks.push(archive.subarray(offset, offset + CHUNK_SIZE));
  const capsule = { id, kind: provenance.kind, archive_sha256: hash(archive), archive_size: archive.length,
    unpacked_size: raw.length, inventory_digest: 'sha256:' + hash(stable(entries)), chunk_size: CHUNK_SIZE,
    chunks: chunks.map((bytes, index) => ({ index, size: bytes.length, sha256: hash(bytes) })), provenance };
  return { capsule, chunks };
}
function unpack(capsule, chunks) {
  need(capsule && capsule.chunk_size === CHUNK_SIZE && Array.isArray(capsule.chunks)
    && capsule.chunks.length === chunks.length && capsule.archive_size <= MAX_BYTES
    && Number.isSafeInteger(capsule.unpacked_size) && capsule.unpacked_size <= MAX_BYTES, 'invalid descriptor');
  chunks.forEach((bytes, index) => { const expected = capsule.chunks[index];
    need(expected.index === index && bytes.length === expected.size && bytes.length <= CHUNK_SIZE && hash(bytes) === expected.sha256, 'chunk mismatch'); });
  const archive = Buffer.concat(chunks);
  need(archive.length === capsule.archive_size && hash(archive) === capsule.archive_sha256, 'archive mismatch');
  const raw = zlib.gunzipSync(archive, { maxOutputLength: MAX_BYTES });
  need(raw.length === capsule.unpacked_size && raw.length > 4, 'unpacked size mismatch');
  const length = raw.readUInt32BE(0); need(length > 0 && length < 8 * 1024 * 1024 && 4 + length <= raw.length, 'invalid header');
  const header = JSON.parse(raw.subarray(4, 4 + length).toString('utf8'));
  need(header.schema === 1 && header.format === 'ais-files-v1' && Array.isArray(header.files)
    && header.files.length <= MAX_FILES && stable(header.provenance) === stable(capsule.provenance), 'invalid header identity');
  const files = new Map(); let offset = 4 + length;
  for (const entry of header.files) {
    need(safe(entry.path) && !files.has(entry.path) && Number.isSafeInteger(entry.size) && entry.size >= 0 && offset + entry.size <= raw.length, 'invalid file entry');
    const bytes = raw.subarray(offset, offset + entry.size); offset += entry.size;
    need(hash(bytes) === entry.sha256, 'file hash mismatch'); files.set(entry.path, bytes);
  }
  need(offset === raw.length && 'sha256:' + hash(stable(inventory(files))) === capsule.inventory_digest, 'inventory mismatch');
  return files;
}
function readDirectory(directory) {
  const files = new Map();
  function visit(current, prefix = '') { for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const name = prefix + entry.name, absolute = path.join(current, entry.name);
    need(!entry.isSymbolicLink(), 'symbolic links forbidden');
    if (entry.isDirectory()) visit(absolute, name + '/');
    else { need(entry.isFile() && safe(name), 'unsupported filesystem entry'); files.set(name, fs.readFileSync(absolute)); }
  } }
  visit(directory); inventory(files); return files;
}
function writeDirectory(files, directory) {
  inventory(files); need(!fs.existsSync(directory), 'output must not exist'); fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) { const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
}
module.exports = { CHUNK_SIZE, MAX_BYTES, hash, stable, safe, inventory, pack, unpack, readDirectory, writeDirectory };
