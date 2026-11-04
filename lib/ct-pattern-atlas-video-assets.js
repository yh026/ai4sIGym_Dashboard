'use strict';

const { createHash } = require('node:crypto');
const { markupSegments, attributes, imageOptimizationSkipReason } = require('./embedded-image-assets');

// The complete imported player, trimmed, is retained in the test fixture.
// Only this known decoder can be replaced without discarding unrelated logic.
const PLAYER_SHA256 = '283ae37a13b41bba932156644fa6f7488a9a93d2ab2f3cb1d58aee689bdd1178';
const MARKER = '/* ais-ct-pattern-atlas-external-video-v1 */';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const EXTERNAL_PLAYER = `
${MARKER}
(() => {
  const video = document.getElementById('film');
  const button = document.getElementById('play');
  const status = document.getElementById('status');
  const failed = () => {
    button.hidden = false;
    status.hidden = false;
    status.textContent = 'The film could not be loaded. Please try again.';
  };
  button.addEventListener('click', () => {
    button.hidden = true;
    status.hidden = false;
    status.textContent = 'Loading the film…';
    video.controls = true;
    // No src exists before this user action, so even metadata is not fetched.
    if (!video.getAttribute('src') || video.error) video.src = video.dataset.videoSrc;
    video.play().catch(failed);
  });
  video.addEventListener('playing', () => { button.hidden = true; status.hidden = true; });
  video.addEventListener('error', failed);
})();
`;

function decodeBase64(value) {
  if (!value || value.length % 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function replaceAttribute(tag, name, value) {
  const original = attributes(tag).get(name);
  return tag.slice(0, original.valueStart) + value + tag.slice(original.valueStart + original.value.length);
}

function optimizeCtPatternAtlasVideo(html, { slug, role } = {}) {
  const stats = { applied: false, videoBytes: 0, posterBytes: 0, videoChunks: 0, skippedReason: null };
  const skip = reason => ({ html, assets: [], stats: { ...stats, skippedReason: reason } });
  if (slug !== 'ct-pattern-atlas' || role !== 'insight') return skip('unsupported-page');
  if (html.includes(MARKER)) return skip('already-externalized');
  const policy = imageOptimizationSkipReason(html);
  if (policy) return skip(policy);

  const segments = markupSegments(html);
  for (const segment of segments) segment.attrs = attributes(segment.tag || '');
  const byId = id => segments.filter(s => s.attrs.get('id')?.value === id);
  const videos = byId('film'), buttons = byId('play'), statuses = byId('status');
  const chunks = segments.filter(s => s.tagName === 'script' && s.attrs.has('data-video-chunk'));
  const programs = segments.filter(s => s.tagName === 'script' && !s.attrs.has('src')
    && ['', 'text/javascript', 'application/javascript'].includes(s.attrs.get('type')?.value || '')
    && s.closing && hash(s.body.trim()) === PLAYER_SHA256);
  if (videos.length !== 1 || videos[0].tagName !== 'video'
      || buttons.length !== 1 || buttons[0].tagName !== 'button'
      || statuses.length !== 1 || statuses[0].tagName !== 'p'
      || programs.length !== 1 || !chunks.length) return skip('unrecognized-video-template');
  const video = videos[0], program = programs[0];
  if ([video, program, buttons[0], statuses[0], ...chunks].some(s => [...s.attrs.values()].includes(null))
      || ['src', 'autoplay', 'data-video-src'].some(name => video.attrs.has(name))
      || video.attrs.get('preload')?.value !== 'metadata' || !video.attrs.get('preload')?.quoted
      || !video.attrs.get('poster')?.quoted
      || !/^<\/video\s*>$/i.test(segments[segments.indexOf(video) + 1]?.tag || '')
      || chunks.some(s => !s.closing || s.attrs.has('src')
        || s.attrs.get('type')?.value !== 'application/octet-stream')) return skip('unrecognized-video-template');

  // Decode each authored chunk independently, in document order, exactly as the
  // offline player does. Base64 padding may occur at an internal chunk boundary.
  const parts = chunks.map(s => decodeBase64(s.body.trim()));
  if (parts.some(part => !part)) return skip('invalid-video-chunks');
  const mp4 = Buffer.concat(parts);
  if (mp4.length < 12 || mp4.subarray(4, 8).toString() !== 'ftyp') return skip('invalid-video');
  const posterMatch = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(video.attrs.get('poster').value);
  const poster = posterMatch && decodeBase64(posterMatch[1]);
  if (!poster || !poster.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return skip('invalid-poster');

  const assets = [[mp4, 'mp4'], [poster, 'jpg']].map(([bytes, extension]) => {
    const filename = hash(bytes) + '.' + extension;
    return { filename, url: '/assets/embedded/' + filename, bytes };
  });
  video.tag = replaceAttribute(video.tag, 'poster', assets[1].url);
  video.tag = replaceAttribute(video.tag, 'preload', 'none')
    .replace(/>$/, ' data-video-src="' + assets[0].url + '">');
  program.body = EXTERNAL_PLAYER;
  const removed = new Set(chunks);
  return {
    html: segments.filter(s => !removed.has(s)).map(s => s.text !== undefined ? s.text
      : s.tag + (s.body === undefined ? '' : s.body + s.closing)).join(''),
    assets,
    stats: { ...stats, applied: true, videoBytes: mp4.length, posterBytes: poster.length, videoChunks: chunks.length },
  };
}

module.exports = { optimizeCtPatternAtlasVideo };
