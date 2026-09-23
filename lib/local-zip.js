'use strict';

const { deflateRawSync } = require('node:zlib');
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Small, deterministic ZIP writer for local downloads. No system zip binary,
// variable timestamps or absolute paths enter an archive.
function zipFiles(files) {
  if (!(files instanceof Map) || files.size > 65535) throw new Error('Invalid ZIP file collection.');
  const contents = [], directory = [];
  let offset = 0;
  for (const [name, value] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof name !== 'string' || !name || /[\\\x00-\x1f:]/.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe ZIP path: ' + name);
    }
    const filename = Buffer.from(name), bytes = Buffer.from(value);
    const compressed = deflateRawSync(bytes), crc = crc32(bytes);
    if (filename.length > 65535 || bytes.length > 0xffffffff || compressed.length > 0xffffffff
        || offset + compressed.length + filename.length + 30 > 0xffffffff) throw new Error('ZIP64 is not supported.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x5c21, 12); // 2026-01-01
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0x5c21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0o100644 * 65536, 38); central.writeUInt32LE(offset, 42);
    contents.push(local, filename, compressed); directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, central, end]);
}
module.exports = { zipFiles };
