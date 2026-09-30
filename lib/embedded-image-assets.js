'use strict';

const { createHash } = require('node:crypto');

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const IMAGE_TYPES = {
  png: { extension: 'png', mimeType: 'image/png' },
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  jpg: { extension: 'jpg', mimeType: 'image/jpeg' },
  gif: { extension: 'gif', mimeType: 'image/gif' },
  webp: { extension: 'webp', mimeType: 'image/webp' },
  avif: { extension: 'avif', mimeType: 'image/avif' },
};

function attributes(tag) {
  const result = new Map();
  const opening = /^<\/?[a-z][a-z0-9:-]*/i.exec(tag);
  if (!opening) return result;
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  pattern.lastIndex = opening[0].length;
  for (let match; (match = pattern.exec(tag));) {
    const name = match[1].toLowerCase();
    const quoted = match[2] !== undefined || match[3] !== undefined;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const valueStart = quoted ? match.index + match[0].indexOf(match[2] !== undefined ? '"' : "'") + 1 : -1;
    // Duplicate attributes are ambiguous; do not rewrite their values.
    result.set(name, result.has(name) ? null : { value, valueStart, quoted });
  }
  return result;
}

function markupSegments(html) {
  const segments = [];
  const pattern = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let position = 0;
  for (let match; (match = pattern.exec(html));) {
    if (match.index > position) segments.push({ text: html.slice(position, match.index) });
    const tagName = (match[1] || '').toLowerCase();
    const opening = !match[0].startsWith('</');
    if (opening && RAW_TEXT_TAGS.has(tagName)) {
      const closing = new RegExp('</' + tagName + '\\s*>', 'gi');
      closing.lastIndex = pattern.lastIndex;
      const end = closing.exec(html);
      // An unterminated raw-text element consumes the remainder, as it does in HTML.
      const bodyEnd = end ? end.index : html.length;
      segments.push({ tagName, tag: match[0], body: html.slice(pattern.lastIndex, bodyEnd), closing: end ? end[0] : '' });
      pattern.lastIndex = end ? closing.lastIndex : html.length;
    } else {
      segments.push({ tagName: opening ? tagName : '', tag: match[0] });
    }
    position = pattern.lastIndex;
  }
  if (position < html.length) segments.push({ text: html.slice(position) });
  return segments;
}

function policySkipReason(segments) {
  if (segments.some(segment => {
    if (segment.tagName !== 'meta') return false;
    const attrs = attributes(segment.tag);
    const equivalent = attrs.get('http-equiv');
    return (attrs.has('http-equiv') && !equivalent)
      || (equivalent && (/^content-security-policy(?:-report-only)?$/i.test(equivalent.value.trim()) || equivalent.value.includes('&')));
  })) return 'Content-Security-Policy meta requires separate policy review.';
  if (segments.some(segment => segment.tagName === 'base' && attributes(segment.tag).has('href'))) {
    return 'A base URL requires separate same-origin URL review.';
  }
  return null;
}

function imageOptimizationSkipReason(html) {
  return policySkipReason(markupSegments(html));
}

/** Visit real HTML img elements only, preserving script/comment/raw-text strings. */
function rewriteImageElements(html, transform) {
  const segments = markupSegments(html);
  if (policySkipReason(segments)) return html;
  return segments.map(segment => {
    if (segment.text !== undefined) return segment.text;
    if (segment.body !== undefined) return segment.tag + segment.body + segment.closing;
    return segment.tagName === 'img' ? transform(segment.tag, attributes(segment.tag)) : segment.tag;
  }).join('');
}

function hasExpectedSignature(bytes, extension) {
  if (extension === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === 'jpg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (extension === 'webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === 'avif') return bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'));
  return false;
}

function replaceRanges(source, replacements) {
  if (!replacements.length) return source;
  const chunks = [];
  let position = 0;
  for (const { start, end, value } of replacements) {
    chunks.push(source.slice(position, start), value);
    position = end;
  }
  chunks.push(source.slice(position));
  return chunks.join('');
}

function rewriteJsonStrings(source, extract) {
  try { JSON.parse(source); } catch { return source; }
  const replacements = [];
  let position = 0;
  for (;;) {
    const start = source.indexOf('"', position);
    if (start < 0) break;
    let end = start + 1;
    let escaped = false;
    for (; end < source.length; end++) {
      if (source[end] === '\\') { escaped = true; end++; }
      else if (source[end] === '"') break;
    }
    position = end + 1;
    let after = position;
    while (/\s/.test(source[after] || '') && after < source.length) after++;
    // Do not rewrite object keys or escaped encodings. All other JSON bytes stay exact.
    if (escaped || source[after] === ':') continue;
    const value = source.slice(start + 1, end);
    const url = extract(value);
    if (url !== value) replacements.push({ start: start + 1, end, value: url });
  }
  return replaceRanges(source, replacements);
}

function rewriteSpriteDeclarations(source, extract) {
  // Only standalone URL declaration blocks are accepted. Arbitrary JavaScript can
  // inspect/decode data URIs, contain regex literals, or depend on their exact text.
  const pattern = /\s*(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(["'])(data:image\/[^"']+)\1\s*;\s*/gy;
  const declarations = [];
  let position = 0;
  for (let match; (match = pattern.exec(source));) {
    const start = match.index + match[0].indexOf(match[1]) + 1;
    declarations.push({ start, end: start + match[2].length, value: match[2] });
    position = pattern.lastIndex;
  }
  if (position !== source.length || !declarations.length) return source;
  const replacements = [];
  for (const declaration of declarations) {
    const value = extract(declaration.value);
    if (value !== declaration.value) replacements.push({ ...declaration, value });
  }
  return replaceRanges(source, replacements);
}

function rewriteInitialJsonDeclaration(source, extract) {
  // Some authored pages place their JSON payload at the start of a normal
  // script: const E={...}; followed by rendering code. Accept only that exact
  // boundary, with balanced JSON and a semicolon; never scan arbitrary JS.
  const prefix = /^\s*(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?=[{\[])/.exec(source);
  if (!prefix) return source;
  const start = prefix[0].length;
  let depth = 0;
  let quoted = false;
  for (let position = start; position < source.length; position++) {
    const character = source[position];
    if (quoted) {
      if (character === '\\') position++;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      depth--;
      if (depth === 0) {
        const end = position + 1;
        if (!/^\s*;/.test(source.slice(end))) return source;
        return source.slice(0, start) + rewriteJsonStrings(source.slice(start, end), extract) + source.slice(end);
      }
    }
  }
  return source;
}

/**
 * Externalize embedded raster images without decoding, recompressing, resizing,
 * or changing a single image byte. This is a build transformation, not a source
 * edit. Write each returned asset.bytes to the output path represented by asset.url.
 * The content-derived filename deduplicates images across independent page calls.
 *
 * Script images require explicit opt-in after auditing consumers: JSON image
 * values, initial JSON declarations, and standalone sprite URL declarations
 * must be used as image URLs, not
 * decoded as base64 or guarded by startsWith('data:'). Arbitrary JS is untouched.
 * Pages with a CSP meta are preserved because image and inline script policies
 * may prohibit the transform. The caller must also check response-header CSPs.
 */
function optimizeEmbeddedImages(html, {
  assetUrlPrefix = '/assets/embedded/',
  minBytes = 4096,
  includeScriptImages = false,
  lazyAfterFirstImage = false,
} = {}) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string.');
  if (typeof assetUrlPrefix !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(assetUrlPrefix)) {
    throw new Error('Embedded image assetUrlPrefix must be a same-origin absolute directory path.');
  }
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error('Embedded image minBytes must be a non-negative integer.');
  const stats = { htmlBytesBefore: Buffer.byteLength(html), htmlBytesAfter: Buffer.byteLength(html), htmlBytesSaved: 0,
    extractedOccurrences: 0, uniqueAssets: 0, assetBytes: 0, skippedReason: null };
  const segments = markupSegments(html);
  stats.skippedReason = policySkipReason(segments);
  if (stats.skippedReason) {
    return { html, assets: [], stats };
  }

  const assets = new Map();
  const uriCache = new Map();
  function extract(uri) {
    if (!uri.startsWith('data:image/')) return uri;
    if (uriCache.has(uri)) {
      const cached = uriCache.get(uri);
      if (cached !== uri) stats.extractedOccurrences++;
      return cached;
    }
    const match = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(uri);
    if (!match || match[2].length % 4 !== 0) return uri;
    const type = IMAGE_TYPES[match[1].toLowerCase()];
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < minBytes || bytes.toString('base64') !== match[2] || !hasExpectedSignature(bytes, type.extension)) {
      uriCache.set(uri, uri);
      return uri;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const filename = sha256 + '.' + type.extension;
    const url = assetUrlPrefix + filename;
    if (!assets.has(filename)) assets.set(filename, { filename, url, bytes, mimeType: type.mimeType, sha256 });
    uriCache.set(uri, url);
    stats.extractedOccurrences++;
    return url;
  }

  let extractedImgCount = 0;
  const transformed = segments.map(segment => {
    if (segment.text !== undefined) return segment.text;
    const attrs = attributes(segment.tag);
    if (segment.tagName === 'img') {
      const src = attrs.get('src');
      if (!src?.quoted) return segment.tag;
      const url = extract(src.value);
      if (url === src.value) return segment.tag;
      let tag = segment.tag.slice(0, src.valueStart) + url + segment.tag.slice(src.valueStart + src.value.length);
      extractedImgCount++;
      if (lazyAfterFirstImage && extractedImgCount > 1) {
        const added = (!attrs.has('loading') ? ' loading="lazy"' : '') + (!attrs.has('decoding') ? ' decoding="async"' : '');
        tag = tag.replace(/\s*\/?>$/, ending => added + ending);
      }
      return tag;
    }
    if (segment.body !== undefined) {
      let body = segment.body;
      if (segment.tagName === 'script' && includeScriptImages && !attrs.has('src') && !attrs.has('integrity')
          && !(attrs.has('type') && !attrs.get('type')) && segment.closing) {
        const type = (attrs.get('type')?.value || '').trim().toLowerCase();
        if (type === 'application/json') body = rewriteJsonStrings(body, extract);
        else if (['', 'text/javascript', 'application/javascript', 'module'].includes(type)) {
          body = rewriteInitialJsonDeclaration(rewriteSpriteDeclarations(body, extract), extract);
        }
      }
      return segment.tag + body + segment.closing;
    }
    return segment.tag;
  }).join('');
  stats.htmlBytesAfter = Buffer.byteLength(transformed);
  stats.htmlBytesSaved = stats.htmlBytesBefore - stats.htmlBytesAfter;
  stats.uniqueAssets = assets.size;
  stats.assetBytes = [...assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
  return { html: transformed, assets: [...assets.values()], stats };
}

module.exports = { optimizeEmbeddedImages, imageOptimizationSkipReason, rewriteImageElements };
