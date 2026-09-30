#!/usr/bin/env node
'use strict';

// Mappings verified against each supplied page's Overview and Used by sections.
// CALCE's two feature sets intentionally have separate Dataset identities.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, 'datasets_upload'));
const mappings = [
  ['tbb-cluster-explorer-2', 'himawari-9-ahi', 'Himawari-9 AHI band 7'],
  ['pleiades-membership-explorer', 'gaia-edr3-pleiades', 'Gaia DR3'],
  ['superconductor-regression-explorer', 'uci-superconductivity', 'UCI superconductivity'],
  ['from-twelve-thousand-numbers-to-a-codebook', 'eurosat-rgb', 'EuroSAT RGB'],
  ['galaxy2-does-rotation-augmentation-help', 'galaxy10-decals', 'Galaxy10 DECaLS'],
  ['jae-joint-embedding-how-one-cell-becomes-61-numbers', 'neurips-bmmc-cite-seq', 'NeurIPS 2021 BMMC CITE-seq'],
  ['soh-battery', 'calce-cs2-soh', 'CALCE CS2 · SOH series'],
  ['battery-curve-shape-explorer', 'calce-cs2-shape', 'CALCE CS2 · voltage-shape matrix'],
  ['ceemdan-battery-forecasting', 'nasa-battery-capacity', 'NASA PCoE battery capacity'],
];
const manifestPath = path.join(root, 'demos_v4/collection.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const prepared = mappings.map(([slug, dataset_id, expectedTitle]) => {
  const project = manifest.projects.find(item => item.slug === slug);
  if (!project) throw new Error('Missing project: ' + slug);
  const filename = dataset_id + '_dataset.html';
  const bytes = fs.readFileSync(path.join(source, filename));
  const html = bytes.toString('utf8');
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (!title?.startsWith(expectedTitle) || !html.includes('data-page-role="dataset"')
      || !/<\/body\s*>/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error('Unexpected Dataset document: ' + filename);
  }
  project.dataset_source = dataset_id + '/' + filename;
  project.dataset_version = slug === 'tbb-cluster-explorer-2' ? 'v2' : 'v1';
  return { slug, dataset_id, dataset_version: project.dataset_version,
    filename, title, route: project.dataset, bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
const audit = path.join(root, 'local-content/dataset-import');
fs.mkdirSync(audit, { recursive: true });
const backup = path.join(audit, 'collection-before.json');
if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup);
for (const page of prepared) {
  const target = path.join(root, 'datasets_v4', page.dataset_id, page.filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, page.bytes);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const report = prepared.map(({ bytes, ...page }) => ({ ...page, size: bytes.length }));
fs.writeFileSync(path.join(audit, 'mapping.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
