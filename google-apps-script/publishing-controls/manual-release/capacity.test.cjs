'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pack, unpack, inventory, MAX_BYTES } = require('./capsule.cjs');

test('capsules round-trip a release larger than the previous 256 MiB limit', () => {
  const bytes = Buffer.alloc(65 * 1024 * 1024, 7);
  const files = new Map(Array.from({ length: 4 }, (_, i) => ['part-' + i + '.bin', bytes]));
  const prepared = pack(files, { kind: 'production' });
  assert.ok(prepared.capsule.unpacked_size > 256 * 1024 * 1024);
  const restored = unpack(prepared.capsule, prepared.chunks);
  assert.equal(restored.size, files.size);
  for (const [name, content] of restored) assert.ok(content.equals(files.get(name)));
  assert.throws(() => unpack({ ...prepared.capsule, unpacked_size: MAX_BYTES + 1 }, prepared.chunks), /invalid descriptor/);
  assert.throws(() => unpack({ ...prepared.capsule, archive_size: MAX_BYTES + 1 }, prepared.chunks), /invalid descriptor/);
  assert.throws(() => inventory(new Map(Array.from({ length: 8 }, (_, i) => ['part-' + i + '.bin', bytes]))), /artifact too large/);
});
