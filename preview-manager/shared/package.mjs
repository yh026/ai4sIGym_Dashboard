// Browser and Node share these rules. All output paths are canonical site paths.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{40}$/;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const ROLES = ['insight', 'workflow', 'dataset'];
const RESERVED = /^(?:_redirects|_headers|netlify\.toml)$/i;
function assertContentPath(path) {
  if (
    safePath(path)
      .split('/')
      .some((part) => RESERVED.test(part))
  )
    fail('Reserved package path: ' + path);
}
const fail = (message) => {
  throw new Error(message);
};

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\%?#:\x00-\x1f\x7f]/.test(value))
    fail('Unsafe path: ' + value);
  const path = value.startsWith('/') ? value : '/' + value;
  if (
    path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    fail('Unsafe path: ' + value);
  return path;
}

export function newDemoDescriptor({ slug, title, departmentId, entryPages = {} }) {
  if (
    typeof slug !== 'string' ||
    !SLUG.test(slug) ||
    slug.length > 100 ||
    Object.hasOwn(Object.prototype, slug)
  )
    fail('Use a demo address with lowercase letters, numbers and single hyphens (up to 100 characters).');
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.trim().length > 160 ||
    /[\x00-\x1f\x7f]/.test(title)
  )
    fail('Enter a demo name of up to 160 characters.');
  if (typeof departmentId !== 'string' || !SLUG.test(departmentId)) fail('Choose a category.');
  if (
    !entryPages ||
    typeof entryPages !== 'object' ||
    Array.isArray(entryPages) ||
    Object.keys(entryPages).some((key) => !ROLES.includes(key))
  )
    fail('Invalid demo page roles.');
  const pages = {};
  for (const role of ROLES) {
    const name = relativePath(entryPages[role] ?? (role === 'insight' ? 'index' : role) + '.html');
    if (!/\.html?$/i.test(name)) fail('Choose an HTML file for ' + role + '.');
    assertContentPath(name);
    pages[role] = { path: '/demos/' + slug + '/' + name, state: 'Ready' };
  }
  if (new Set(Object.values(pages).map((page) => page.path.toLowerCase())).size !== ROLES.length)
    fail('Choose a different HTML file for each of Insight, Workflow and Dataset.');
  return {
    slug,
    title: title.trim(),
    department_id: departmentId,
    pages,
    files: {},
    writableExternalPaths: [],
    readOnlyPaths: [],
    previewOnly: true,
  };
}

export function requireFirstPages(demo, files) {
  if (files.reduce((bytes, file) => bytes + file.size, 0) > MAX_TOTAL) fail('The package exceeds 512 MiB.');
  for (const [role, page] of Object.entries(demo.pages))
    if (!files.some((file) => file.path === page.path && file.size > 0))
      fail(
        'Missing ' +
          role.charAt(0).toUpperCase() +
          role.slice(1) +
          ' page. Include ' +
          page.path.split('/').pop() +
          ' in the package.',
      );
}
// Finder adds extended-attribute sidecars and directory metadata to ZIPs.
function finderMetadata(path) {
  if (typeof path !== 'string' || path.startsWith('/') || /[\\%?#:\x00-\x1f]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  return parts.includes('__MACOSX') || parts.some((part) => part === '.DS_Store' || part.startsWith('._'));
}
function relativePath(value) {
  if (typeof value !== 'string' || value.startsWith('/')) fail('Package path must be relative: ' + value);
  return safePath(value).slice(1);
}
export function fileMap(input = {}) {
  const entries =
    input instanceof Map
      ? [...input]
      : Array.isArray(input)
        ? input.map((file) => [file.path, file])
        : Object.entries(input);
  const result = Object.create(null);
  for (const [name, item] of entries) {
    const path = safePath(name);
    if (result[path]) fail('Duplicate file: ' + path);
    result[path] =
      typeof item === 'string'
        ? { sha1: item }
        : { ...item, sha1: item.sha1 || item.sha, size: item.size ?? item.size_bytes };
  }
  return result;
}
function pageDescriptors(demo) {
  const result = {};
  for (const [key, value] of Array.isArray(demo.pages)
    ? demo.pages.map((p) => [p.role, p])
    : Object.entries(demo.pages || {})) {
    const role = key === 'legacy' ? 'insight' : key;
    const route = typeof value === 'string' ? value : value?.path || value?.route;
    if (route)
      result[role] = {
        ...(typeof value === 'object' ? value : {}),
        path: safePath(route),
        state: value?.state || 'Ready',
      };
  }
  return result;
}
export function catalogFromBaseline(baseline) {
  const files = fileMap(baseline.files || {}),
    catalog = Object.create(null);
  const source =
    baseline.demos ||
    baseline.manifest?.demos ||
    baseline.production_manifest?.demos ||
    baseline.projects ||
    [];
  const demos = Array.isArray(source)
    ? source
    : Object.entries(source).map(([slug, demo]) => ({ ...demo, slug }));
  for (const raw of demos) {
    if (!SLUG.test(raw.slug || '') || catalog[raw.slug]) fail('Invalid or duplicate demo slug');
    const base = '/demos/' + raw.slug + '/';
    const pages = pageDescriptors(raw);
    for (const role of ROLES) {
      const path = base + (role === 'insight' ? 'index' : role) + '.html';
      if (!pages[role] && files[path]) pages[role] = { path, state: 'Ready' };
    }
    const resources = raw.resources || [];
    const owned = Object.create(null);
    const paths = new Set(Object.values(pages).map((p) => p.path));
    if (raw.card_asset?.public_path) paths.add(safePath(raw.card_asset.public_path));
    for (const name of baseline.project_file_index?.[raw.slug]?.files_under_demo_directory || [])
      paths.add(safePath(name));
    for (const resource of resources)
      if (resource.path || resource.route) paths.add(safePath(resource.path || resource.route));
    for (const name of ['card_image', 'preview_image', 'thumbnail', 'card']) {
      if (typeof raw[name] === 'string' && raw[name] && !/^(?:https?:|data:)/.test(raw[name]))
        paths.add(safePath(raw[name]));
    }
    for (const [path, file] of Object.entries(files))
      if (path.startsWith(base) || paths.has(path)) owned[path] = file;
    catalog[raw.slug] = {
      ...raw,
      slug: raw.slug,
      title: raw.title || raw.slug,
      pages,
      resources,
      files: owned,
    };
  }
  const owners = new Map();
  for (const demo of Object.values(catalog))
    for (const path of Object.keys(demo.files)) {
      if (!owners.has(path)) owners.set(path, new Set());
      owners.get(path).add(demo.slug);
    }
  for (const demo of Object.values(catalog)) {
    demo.readOnlyPaths = Object.keys(demo.files).filter((path) => owners.get(path).size > 1);
    demo.writableExternalPaths = Object.keys(demo.files).filter(
      (path) => !path.startsWith('/demos/') && owners.get(path).size === 1,
    );
    demo.sharedFiles = Object.fromEntries(
      Object.entries(files).filter(
        ([path]) => path.startsWith('/assets/') && !demo.writableExternalPaths.includes(path),
      ),
    );
  }
  return catalog;
}
export function canWrite(demo, value) {
  try {
    if (!SLUG.test(demo?.slug || '')) return false;
    const path = safePath(value);
    assertContentPath(path);
    if (demo.readOnlyPaths?.includes(path)) return false;
    if (path.startsWith('/demos/' + demo.slug + '/')) return true;
    if (!path.startsWith('/datasets/') && !path.startsWith('/assets/')) return false;
    if (Array.isArray(demo.writableExternalPaths)) return demo.writableExternalPaths.includes(path);
    return (
      Boolean(fileMap(demo.files || {})[path]) ||
      Object.values(pageDescriptors(demo)).some((page) => page.path === path) ||
      (demo.resources || []).some((resource) => safePath(resource.path || resource.route) === path)
    );
  } catch {
    return false;
  }
}
export function validateChanges(demo, files, remove = [], existingFiles = {}) {
  const existing = fileMap(existingFiles),
    seen = new Set(),
    removed = new Set();
  const required = new Set(Object.values(pageDescriptors(demo)).map((page) => page.path));
  for (const file of files) {
    const path = safePath(file.path);
    if (!canWrite(demo, path)) fail('File outside selected demo: ' + path);
    if (seen.has(path.toLowerCase())) fail('Duplicate file: ' + path);
    if (
      [...seen].some(
        (name) => name.startsWith(path.toLowerCase() + '/') || path.toLowerCase().startsWith(name + '/'),
      )
    )
      fail('Ambiguous file path: ' + path);
    if (
      !HASH.test(file.sha1 || '') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE
    )
      fail('Invalid file metadata: ' + path);
    for (const name of Object.keys(existing))
      if (
        name !== path &&
        (name.toLowerCase() === path.toLowerCase() ||
          name.toLowerCase().startsWith(path.toLowerCase() + '/') ||
          path.toLowerCase().startsWith(name.toLowerCase() + '/'))
      )
        fail('Ambiguous existing file path: ' + path);
    seen.add(path.toLowerCase());
  }
  for (const name of remove) {
    const path = safePath(name);
    if (!canWrite(demo, path) || !existing[path]) fail('Cannot remove unregistered file: ' + path);
    if (required.has(path)) fail('Cannot remove required page: ' + path);
    if (seen.has(path.toLowerCase()) || removed.has(path)) fail('Conflicting file operation: ' + path);
    removed.add(path);
  }
  return true;
}
export function planChanges(existingFiles, files, remove = []) {
  const existing = fileMap(existingFiles),
    result = [],
    seen = new Set();
  for (const file of files) {
    const path = safePath(file.path);
    if (seen.has(path)) fail('Duplicate file operation: ' + path);
    seen.add(path);
    const before = existing[path];
    result.push({
      path,
      kind: !before ? 'added' : before.sha1 === file.sha1 ? 'reused' : 'replaced',
      ...(before ? { before } : {}),
      after: file,
    });
  }
  for (const name of remove) {
    const path = safePath(name);
    if (!existing[path] || seen.has(path)) fail('Invalid removal: ' + path);
    seen.add(path);
    result.push({ path, kind: 'removed', before: existing[path] });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
async function unzip(blob) {
  if (blob.size > MAX_TOTAL) fail('ZIP too large');
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    view = new DataView(bytes.buffer);
  const u16 = (n) => view.getUint16(n, true),
    u32 = (n) => view.getUint32(n, true);
  let end = -1;
  for (let n = bytes.length - 22; n >= Math.max(0, bytes.length - 65557); n--)
    if (u32(n) === 0x06054b50 && n + 22 + u16(n + 20) === bytes.length) {
      end = n;
      break;
    }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    fail('Invalid or multipart ZIP');
  const count = u16(end + 10),
    centralSize = u32(end + 12),
    centralStart = u32(end + 16);
  if (count === 65535 || centralStart + centralSize !== end || count > 10000)
    fail('Invalid ZIP directory or ZIP64');
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    result = [],
    seen = new Set(),
    ranges = [];
  let cursor = centralStart,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('Invalid ZIP entry');
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      crc = u32(cursor + 16),
      compressed = u32(cursor + 20),
      size = u32(cursor + 24);
    const nameLength = u16(cursor + 28),
      extra = u16(cursor + 30),
      comment = u16(cursor + 32),
      offset = u32(cursor + 42);
    const finish = cursor + 46 + nameLength + extra + comment;
    if (
      finish > end ||
      u16(cursor + 34) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > MAX_FILE ||
      (total += size) > MAX_TOTAL
    )
      fail('Unsupported or oversized ZIP entry');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const directory = name.endsWith('/'),
      raw = directory ? name.slice(0, -1) : name;
    const ignored = finderMetadata(raw),
      path = ignored ? raw : relativePath(raw);
    const key = path.toLowerCase();
    if (seen.has(key)) fail('Duplicate or ambiguous ZIP path: ' + path);
    seen.add(key);
    const mode = u32(cursor + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000) fail('ZIP symlinks are forbidden');
    if (
      offset + 30 > centralStart ||
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method
    )
      fail('Invalid ZIP local header');
    const localName = u16(offset + 26),
      localExtra = u16(offset + 28),
      start = offset + 30 + localName + localExtra;
    if (
      start + compressed > centralStart ||
      decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName)) !== name
    )
      fail('ZIP path or size mismatch');
    if (
      !(flags & 8) &&
      (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size)
    )
      fail('ZIP local size mismatch');
    if (ranges.some(([a, b]) => offset < b && start + compressed > a)) fail('Overlapping ZIP entries');
    ranges.push([offset, start + compressed]);
    if (directory) {
      if (size) fail('Invalid ZIP directory');
      cursor = finish;
      continue;
    }
    if (ignored) {
      cursor = finish;
      continue;
    }
    let output = bytes.subarray(start, start + compressed);
    if (method === 8) {
      const reader = new Blob([output])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > size) {
            await reader.cancel();
            fail('ZIP inflated size mismatch');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      output = new Uint8Array(await new Blob(chunks).arrayBuffer());
    }
    if (output.length !== size || crc32(output) !== crc) fail('ZIP integrity check failed: ' + path);
    result.push({ path, blob: new Blob([output]) });
    cursor = finish;
  }
  if (cursor !== end) fail('ZIP directory size mismatch');
  return result;
}
function decodeEntities(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([a-f0-9]+));/gi, (match, dec, hex) =>
    dec || hex
      ? String.fromCodePoint(parseInt(dec || hex, dec ? 10 : 16))
      : { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[match.toLowerCase()],
  );
}
export function localReferences(text, path) {
  const refs = [];
  const add = (value) => {
    value = decodeEntities(value.trim());
    if (value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) refs.push(value);
  };
  const css = (source) => {
    for (const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi))
      add(match[1] ?? match[2] ?? match[3]);
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/gi)) add(match[1]);
  };
  if (/\.css$/i.test(path)) css(text.replace(/\/\*[\s\S]*?\*\//g, ''));
  else if (/\.html?$/i.test(path)) {
    const html = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (opening) =>
        opening.slice(0, opening.indexOf('>') + 1),
      );
    for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
      for (const attr of tag[0].matchAll(
        /\s(src|href|poster|data|srcset|style)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      )) {
        const value = attr[2] ?? attr[3] ?? attr[4];
        if (attr[1].toLowerCase() === 'style') css(value);
        else if (attr[1].toLowerCase() === 'srcset') {
          let remaining = value.trim();
          while (remaining) {
            remaining = remaining.replace(/^[\s,]+/, '');
            const token = /^(data:[^\s]+|[^\s,]+)/i.exec(remaining);
            if (!token) break;
            const url = token[0].replace(/,+$/, '');
            add(url);
            remaining = remaining.slice(token[0].length);
            if (token[0].endsWith(',')) continue;
            const comma = remaining.indexOf(',');
            remaining = comma < 0 ? '' : remaining.slice(comma + 1);
          }
        } else add(value);
      }
    }
    for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) css(block[1]);
  }
  return refs;
}
export function validateDependencies(files, existingFiles = {}, remove = []) {
  const available = new Set(Object.keys(fileMap(existingFiles)));
  for (const path of remove) available.delete(safePath(path));
  for (const file of files) available.add(safePath(file.path));
  const updated = new Set(files.map((file) => safePath(file.path)));
  const retained = remove.length
    ? Object.entries(fileMap(existingFiles))
        .filter(([path, file]) => !updated.has(path) && !remove.includes(path) && file.blob instanceof Blob)
        .map(([path, file]) => ({ ...file, path }))
    : [];
  return Promise.all(
    [...files, ...retained].map(async (file) => {
      if (!/\.(?:html?|css)$/i.test(file.path)) return;
      for (const reference of localReferences(await file.blob.text(), file.path)) {
        const url = new URL(reference, 'https://preview.invalid' + file.path);
        if (url.origin !== 'https://preview.invalid') continue;
        let decoded;
        try {
          decoded = decodeURIComponent(url.pathname);
        } catch {
          fail('Invalid reference: ' + reference);
        }
        const target = decoded.endsWith('/') ? decoded + 'index.html' : decoded;
        const path = safePath(target);
        if (!available.has(path) && !available.has(path + '/index.html') && !available.has(path + '.html'))
          fail('Missing dependency: ' + file.path + ' → ' + reference);
      }
    }),
  );
}
export async function importPackage(input, demo, existingFiles = {}, { registration } = {}) {
  if (!SLUG.test(demo?.slug || '')) fail('Invalid demo slug');
  if (!Array.isArray(input) || !input.length) fail('Choose an HTML file, ZIP, or folder');
  let entries = input;
  if (entries.length === 1 && /\.zip$/i.test(entries[0].path)) entries = await unzip(entries[0].blob);
  const seen = new Set();
  let total = 0;
  entries = entries
    .filter((item) => !finderMetadata(item.path))
    .map((item) => {
      const path = relativePath(item.path),
        key = path.toLowerCase();
      assertContentPath(path);
      if (seen.has(key)) fail('Duplicate or ambiguous package path: ' + path);
      seen.add(key);
      if (!(item.blob instanceof Blob) || item.blob.size > MAX_FILE || (total += item.blob.size) > MAX_TOTAL)
        fail('Invalid or oversized package file');
      return { path, blob: item.blob };
    });
  if (!entries.length) fail('Empty package');
  // New deliveries may wrap a complete demo in several folders. Existing overlays
  // can intentionally start at a site resource directory.
  const demoRoot = 'demos/' + demo.slug + '/';
  for (;;) {
    const folder = entries[0].path.split('/')[0];
    let prefix = folder + '/';
    if (!entries.every((entry) => entry.path.startsWith(prefix))) break;
    if (folder === 'demos') {
      if (registration && entries.every((entry) => entry.path.startsWith(demoRoot))) prefix = demoRoot;
      else if (
        !registration ||
        !entries.some((entry) =>
          /^demos\/(?:demo\.json|(?:index|insight|workflow|dataset)\.html)$/.test(entry.path),
        )
      )
        break;
    } else if (
      !registration &&
      ['assets', 'resources', 'data', 'media', 'images', 'css', 'js', 'datasets'].includes(folder)
    )
      break;
    entries = entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    if (!registration) break;
  }
  const manifestEntry = entries.find((entry) => entry.path === 'demo.json');
  let manifest = null;
  if (manifestEntry) {
    try {
      manifest = JSON.parse(await manifestEntry.blob.text());
    } catch {
      fail('Invalid demo.json');
    }
    if (
      manifest.schema !== 1 ||
      manifest.slug !== demo.slug ||
      !manifest.pages ||
      typeof manifest.pages !== 'object' ||
      Array.isArray(manifest.pages) ||
      Object.keys(manifest).some((key) => !['schema', 'slug', 'pages', 'remove'].includes(key)) ||
      Object.keys(manifest.pages).some((role) => !ROLES.includes(role)) ||
      (manifest.remove !== undefined && !Array.isArray(manifest.remove))
    )
      fail('Invalid demo.json schema or slug');
    for (const name of Object.values(manifest.pages)) relativePath(name);
  }
  if (registration) {
    // Keep the supplied page locations, so relative links in a new package still work.
    const entryPages = { ...manifest?.pages };
    if (
      !entryPages.insight &&
      !entries.some((e) => e.path === 'index.html') &&
      entries.some((e) => e.path === 'insight.html')
    )
      entryPages.insight = 'insight.html';
    registration = { ...registration, entryPages };
    demo = newDemoDescriptor(registration);
  }
  const base = '/demos/' + demo.slug + '/',
    pages = pageDescriptors(demo),
    mapping = new Map();
  for (const [role, name] of Object.entries(manifest?.pages || {})) {
    if (!pages[role]) fail('Unregistered page role: ' + role);
    if (!entries.some((entry) => entry.path === name) || mapping.has(name))
      fail('Missing or ambiguous manifest page: ' + name);
    mapping.set(name, pages[role].path);
  }
  const sitePath = (name) =>
    name.startsWith('demos/') ||
    (!demo.previewOnly &&
      demo.published !== false &&
      (name.startsWith('datasets/') || name.startsWith('assets/cards/')));
  const content = entries.filter((entry) => entry.path !== 'demo.json');
  const standalone =
    content.length === 1 && /\.html?$/i.test(content[0].path) && !manifest && !content[0].path.includes('/');
  const files = [];
  for (const entry of content) {
    let path = mapping.get(entry.path);
    if (!path && standalone && !['workflow.html', 'dataset.html'].includes(entry.path))
      path = pages.insight?.path || base + 'index.html';
    if (
      !registration &&
      !path &&
      ['index.html', 'insight.html', 'workflow.html', 'dataset.html'].includes(entry.path)
    ) {
      const role = /^(?:index|insight)\./.test(entry.path) ? 'insight' : entry.path.split('.')[0];
      if (!((demo.previewOnly || demo.published === false) && manifest?.pages?.[role]))
        path = pages[role]?.path || base + (role === 'insight' ? 'index' : role) + '.html';
    }
    path ||= sitePath(entry.path) ? safePath(entry.path) : base + entry.path;
    const sha1 = [...new Uint8Array(await crypto.subtle.digest('SHA-1', await entry.blob.arrayBuffer()))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    files.push({ path, sha1, size: entry.blob.size, blob: entry.blob });
  }
  const remove = (manifest?.remove || []).map((name) => {
    relativePath(name);
    return sitePath(name) ? safePath(name) : base + name;
  });
  validateChanges(demo, files, remove, existingFiles);
  if (registration) requireFirstPages(demo, files);
  await validateDependencies(files, existingFiles, remove);
  return { files, remove, ...(registration && { registration }) };
}
