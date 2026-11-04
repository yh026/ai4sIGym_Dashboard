'use strict';

const { createHash } = require('node:crypto');
const { markupSegments, imageOptimizationSkipReason } = require('./embedded-image-assets');

// This is the authored video's complete mount block. Unknown implementations
// remain intact instead of losing their embedded media during a build.
const EMBEDDED_MOUNT = `  /* the narrated video ships inside the payload; decoded after the figure has drawn */
  (function mountVideo(){
    const card=$("storyVideoCard");
    if(!D.video||!D.video.mp4_b64){card.remove();return}
    if(D.video.poster)$("storyVideo").poster=D.video.poster;
    setTimeout(()=>{
      const bin=atob(D.video.mp4_b64),u8=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
      $("storyVideo").src=URL.createObjectURL(new Blob([u8],{type:"video/mp4"}));
    },0);
  })();`;
const MARKER = '/* ais-tbb-external-video-v1: native playback loads the separate MP4 on demand. */';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

// Change just one known string field, keeping every scientific-data byte exact.
function replaceField(source, key, before, nextKey, after) {
  const token = JSON.stringify(before), start = source.indexOf(token);
  if (start < 0 || source.indexOf(token, start + token.length) !== -1) return null;
  const prefix = source.slice(Math.max(0, start - key.length - 64), start);
  const property = new RegExp('"' + key + '"\\s*:\\s*$').exec(prefix);
  if (!property) return null;
  return source.slice(0, start - property[0].length) + JSON.stringify(nextKey) + ':'
    + JSON.stringify(after) + source.slice(start + token.length);
}

function optimizeTbbVideo(html, { slug, role } = {}) {
  const stats = { applied: false, videoBytes: 0, posterBytes: 0, skippedReason: null };
  const skip = reason => ({ html, assets: [], stats: { ...stats, skippedReason: reason } });
  if (slug !== 'tbb-cluster-explorer-2' || role !== 'insight') return skip('unsupported-page');
  if (html.includes(MARKER)) return skip('already-externalized');
  const policy = imageOptimizationSkipReason(html);
  if (policy) return skip(policy);
  const segments = markupSegments(html);
  const payloads = segments.filter(s => s.tagName === 'script'
    && /\bid=["']payload["']/.test(s.tag) && /\btype=["']application\/json["']/.test(s.tag));
  const programs = segments.filter(s => s.tagName === 'script' && s.body?.includes(EMBEDDED_MOUNT));
  const videos = segments.filter(s => s.tagName === 'video' && /\bid=["']storyVideo["']/.test(s.tag));
  if (payloads.length !== 1 || programs.length !== 1 || videos.length !== 1) return skip('unrecognized-video-template');
  const payload = payloads[0], program = programs[0], video = videos[0];
  if (/\b(?:src|poster|autoplay)\b/i.test(video.tag)
    || !/\bpreload=["']metadata["']/.test(video.tag)
    || !/^<\/video\s*>$/i.test(segments[segments.indexOf(video) + 1]?.tag || '')
    || program.body.indexOf(EMBEDDED_MOUNT) !== program.body.lastIndexOf(EMBEDDED_MOUNT)) {
    return skip('unrecognized-video-template');
  }
  let data;
  try { data = JSON.parse(payload.body); } catch { return skip('invalid-payload'); }
  const mp4 = decodeBase64(data?.video?.mp4_b64);
  const posterMatch = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(data?.video?.poster || '');
  const poster = posterMatch && decodeBase64(posterMatch[2]);
  if (!mp4 || mp4.length < 12 || mp4.subarray(4, 8).toString() !== 'ftyp'
    || data.video.bytes !== mp4.length || !poster) return skip('invalid-media');
  const extension = posterMatch[1] === 'jpeg' ? 'jpg' : 'png';
  const signature = extension === 'jpg' ? Buffer.from([255, 216, 255]) : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!poster.subarray(0, signature.length).equals(signature)) return skip('invalid-poster');
  const assets = [[mp4, 'mp4'], [poster, extension]].map(([bytes, ext]) => {
    const filename = hash(bytes) + '.' + ext;
    return { filename, url: '/assets/embedded/' + filename, bytes };
  });
  let body = replaceField(payload.body, 'mp4_b64', data.video.mp4_b64, 'src', assets[0].url);
  if (body === null) return skip('unrecognized-payload-encoding');
  body = replaceField(body, 'poster', data.video.poster, 'poster', assets[1].url);
  if (body === null) return skip('unrecognized-payload-encoding');
  payload.body = body;
  program.body = program.body.replace(EMBEDDED_MOUNT, '  ' + MARKER);
  video.tag = video.tag.replace(/\bpreload=["']metadata["']/, 'preload="none"')
    .replace(/>$/, ' src="' + assets[0].url + '" poster="' + assets[1].url + '">');
  return {
    html: segments.map(s => s.text !== undefined ? s.text : s.tag + (s.body === undefined ? '' : s.body + s.closing)).join(''),
    assets,
    stats: { ...stats, applied: true, videoBytes: mp4.length, posterBytes: poster.length },
  };
}

module.exports = { optimizeTbbVideo };
