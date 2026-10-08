'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hash, CHUNK_SIZE } = require('./capsule.cjs');
const DIRECTORY = '.ais-release-cache-v1';
const LIMIT = 512 * 1024 * 1024;
const enabled = env => env.NETLIFY === 'true' && env.CONTEXT === 'branch-deploy'
  && env.BRANCH === 'codex/manual-production-review' && env.AIS_RELEASE_CACHE !== 'off';
const valid = item => item && /^[a-f0-9]{64}$/.test(item.sha256)
  && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= CHUNK_SIZE;
const matches = (bytes, item) => valid(item) && Buffer.isBuffer(bytes)
  && bytes.length === item.size && hash(bytes) === item.sha256;

// Only expendable content bytes live here. Descriptors, credentials, release
// requests and deployment state must always come from the authoritative API.
function createCache(directory = path.join(process.cwd(), DIRECTORY)) {
  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe cache directory.');
  }
  return {
    get(item) {
      if (!valid(item)) return null;
      let fd;
      try {
        ensureDirectory();
        const file = path.join(directory, item.sha256);
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== item.size) return null;
        const bytes = fs.readFileSync(fd);
        if (!matches(bytes, item)) return null;
        try { fs.futimesSync(fd, new Date(), new Date()); } catch {}
        return bytes;
      } catch { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
    put(item, bytes) {
      if (!matches(bytes, item)) return false;
      let temp;
      try {
        ensureDirectory();
        temp = path.join(directory, '.tmp-' + crypto.randomUUID());
        fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, path.join(directory, item.sha256));
        return true;
      } catch { return false; }
      finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
    },
    prune(limit = LIMIT) {
      try {
        ensureDirectory();
        const entries = [];
        for (const name of fs.readdirSync(directory)) {
          const file = path.join(directory, name), stat = fs.lstatSync(file);
          if (!/^[a-f0-9]{64}$/.test(name) || !stat.isFile() || stat.size > CHUNK_SIZE) {
            fs.rmSync(file, { recursive: true, force: true });
          } else entries.push({ file, size: stat.size, time: stat.mtimeMs });
        }
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries.sort((a, b) => a.time - b.time)) {
          if (total <= limit) break;
          fs.unlinkSync(entry.file); total -= entry.size;
        }
      } catch { /* Cache maintenance must not block a release. */ }
    },
  };
}
async function cacheLifecycle(operation, { utils = {}, env = process.env, log = console.log } = {}) {
  if (!enabled(env) || !utils.cache) return;
  try {
    if (operation === 'save') createCache().prune();
    const found = await utils.cache[operation](DIRECTORY);
    log('Release cache ' + operation + ': ' + (found ? 'available' : 'empty') + '.');
  } catch { log('Release cache ' + operation + ' unavailable; Drive fallback remains enabled.'); }
}
module.exports = { DIRECTORY, LIMIT, enabled, valid, matches, createCache, cacheLifecycle };
