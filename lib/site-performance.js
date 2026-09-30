'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { optimizePageStartup } = require('./page-startup-optimization');
const { optimizeBatteryStartup } = require('./battery-startup-optimization');
const { optimizeForecastStartup } = require('./forecast-startup-optimization');
const { optimizeAstronomyCellStartup } = require('./astronomy-cell-startup-optimization');
const { optimizeSharedDemoAssets } = require('./shared-demo-assets');
const { optimizeEmbeddedImages, imageOptimizationSkipReason, rewriteImageElements } = require('./embedded-image-assets');

const SCRIPT_IMAGE_PROJECTS = new Set([
  'from-twelve-thousand-numbers-to-a-codebook',
  'galaxy2-does-rotation-augmentation-help',
]);
const EXCLUDED_PROJECTS = new Set([
  'air-quality-day-segment-pca-and-amp-umap-by-sensor',
  'singapore-road-speed-clusters-umap',
]);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function htmlFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.html')) result.push(file);
    }
  }
  visit(root);
  return result.sort();
}

/** Optimize generated previews only; authoring files and downloads are untouched. */
function optimizeSiteOutput(root) {
  root = path.resolve(root);
  const report = { schema: 1, pages: [], assets: [], homeMap: null };
  const written = new Map();
  function asset(directory, filename, bytes) {
    const valid = directory === 'runtime' ? /^[a-f0-9]{64}\.(?:js|css)$/
      : ['embedded', 'optimized'].includes(directory) ? /^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|avif)$/ : null;
    if (!valid?.test(filename)) throw new Error('Invalid optimized asset name');
    const relative = `assets/${directory}/${filename}`, target = path.join(root, relative);
    if (!written.has(relative)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) throw new Error('Optimized asset collision');
      fs.writeFileSync(target, bytes);
      const info = { path: relative, bytes: bytes.length, sha256: hash(bytes) };
      written.set(relative, info);
      report.assets.push(info);
    }
    return '/' + relative;
  }

  // The checked-in derivative has a reproducible, decoded-pixel identity receipt.
  const mapSource = path.join(root, 'assets/ais-science-map-v2-lines.png');
  const mapOutput = path.join(root, 'assets/ais-science-map-v2-lines.lossless.webp');
  const evidenceFile = path.join(__dirname, '../docs/evidence/home-map-lossless.json');
  let mapUrl = null;
  if (fs.existsSync(mapSource) && fs.existsSync(mapOutput) && fs.existsSync(evidenceFile)) {
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const source = fs.readFileSync(mapSource), output = fs.readFileSync(mapOutput);
    if (hash(source) === evidence.source.sha256 && hash(output) === evidence.output.sha256
        && evidence.verification.pixels_identical === true
        && evidence.verification.source_rgba_sha256 === evidence.verification.output_rgba_sha256) {
      mapUrl = asset('optimized', hash(output) + '.webp', output);
      report.homeMap = { sourceBytes: source.length, outputBytes: output.length, pixelsIdentical: true };
    }
  }

  for (const file of htmlFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const parts = relative.split('/');
    const slug = parts[0] === 'demos' ? parts[1] : '';
    const role = parts.at(-1) === 'index.html' ? 'insight' : parts.at(-1).replace(/\.html$/, '');
    const original = fs.readFileSync(file, 'utf8');
    if (EXCLUDED_PROJECTS.has(slug)) {
      report.pages.push({ path: relative, inputBytes: Buffer.byteLength(original), outputBytes: Buffer.byteLength(original),
        excluded: 'Project is being edited separately; preserve every page byte.' });
      continue;
    }
    const policySkipReason = imageOptimizationSkipReason(original);
    const inputBytes = Buffer.byteLength(original);
    const startup = policySkipReason
      ? { html: original, stats: { inputBytes, outputBytes: inputBytes, applied: [],
        skipped: [{ optimization: 'page-startup', reason: policySkipReason }] } }
      : optimizePageStartup(original, { slug, role });
    if (!policySkipReason) {
      for (const optimize of [optimizeBatteryStartup, optimizeForecastStartup, optimizeAstronomyCellStartup]) {
        const extra = optimize(startup.html, { slug, role });
        startup.html = extra.html;
        startup.stats.applied.push(...extra.stats.applied);
        startup.stats.skipped.push(...extra.stats.skipped.filter(item => item.reason !== 'unsupported-page'));
      }
      startup.stats.outputBytes = Buffer.byteLength(startup.html);
      if (startup.stats.applied.length) startup.stats.skipped = startup.stats.skipped.filter(item => item.reason !== 'unsupported-page');
    }
    const allowTbb = slug === 'tbb-cluster-explorer-2' && startup.stats.applied.length > 0;
    const images = optimizeEmbeddedImages(startup.html, {
      assetUrlPrefix: '/assets/embedded/',
      includeScriptImages: SCRIPT_IMAGE_PROJECTS.has(slug) || allowTbb,
      lazyAfterFirstImage: true,
    });
    for (const image of images.assets) asset('embedded', image.filename, image.bytes);

    // Keep existing JPEG/PNG bytes. Hash names allow reuse without stale images.
    const shared = optimizeSharedDemoAssets(images.html, { slug, role });
    for (const resource of shared.assets) asset('runtime', resource.filename, resource.bytes);
    let html = shared.html;
    const generatedListing = relative === 'index.html' || /^domains\/[a-z0-9-]+\/index\.html$/.test(relative);
    if (generatedListing && !policySkipReason) html = rewriteImageElements(html, (tag, attrs) => {
      const source = attrs.get('src');
      if (source?.quoted) {
        const src = source.value;
        if (/^(?:[a-z]+:|\/\/)/i.test(src) || /[?#]/.test(src)) return tag;
        const absolute = src.startsWith('/') ? path.join(root, src.slice(1)) : path.resolve(path.dirname(file), src);
        const local = path.relative(root, absolute).split(path.sep).join('/');
        let url = null;
        if (local === 'assets/ais-science-map-v2-lines.png' && mapUrl) url = mapUrl;
        else if (/^assets\/(?:cards|previews)\/[a-z0-9._/-]+\.(?:jpe?g|png|webp|avif)$/i.test(local)
            && !local.split('/').includes('..') && fs.existsSync(absolute)) {
          const bytes = fs.readFileSync(absolute);
          url = asset('optimized', hash(bytes) + path.extname(local).toLowerCase(), bytes);
        }
        if (url) tag = tag.slice(0, source.valueStart) + url + tag.slice(source.valueStart + src.length);
      }
      if ((attrs.get('class')?.value || '').split(/\s+/).includes('map-art')) {
        const added = (!attrs.has('fetchpriority') ? ' fetchpriority="high"' : '')
          + (!attrs.has('decoding') ? ' decoding="async"' : '');
        tag = tag.replace(/\s*\/?>$/, ending => added + ending);
      }
      return tag;
    });
    if (html !== original) fs.writeFileSync(file, html);
    report.pages.push({ path: relative, inputBytes: Buffer.byteLength(original), outputBytes: Buffer.byteLength(html), startup: startup.stats, images: images.stats, shared: shared.stats });
  }
  return report;
}

module.exports = { optimizeSiteOutput };
