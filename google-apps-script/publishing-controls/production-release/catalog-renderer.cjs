'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { digest } = require('./release-plan.cjs');
const INPUTS = ['build.js', 'site/map-regions.js', 'site/template.html', 'site/domain-template.html',
  'site/styles.css', 'site/app.js'];
const HELPERS = ['normalizeV2Taxonomy', 'normalizeV2Demo', 'pluralText', 'cardHtml', 'filterGroupHtml',
  'v2FacetFilterHtml', 'fillTemplate', 'mapHotspotHtml', 'mapMarkerHtml', 'mobileDomainLinkHtml',
  'appScriptForSchema', 'domainIcon', 'domainSwitcherHtml', 'subtopicStats', 'esc', 'RETIRED_DOMAIN_IDS'];

function rendererDigest(checkout) {
  return digest(INPUTS.map(name => {
    const filename = path.join(checkout, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Catalog renderer: source must be a regular file');
    return { path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') };
  }));
}

// Compile this explicitly trusted local repository module with additional
// exports in memory. require.main !== module, so its build entry point does not
// run. The repository and its files are never modified. This avoids copying an
// independent implementation of cards, map markers, filters and taxonomy rules.
function loadCatalogRenderer(checkout, expectedDigest) {
  const root = path.resolve(checkout);
  if (rendererDigest(root) !== expectedDigest) throw new Error('Catalog renderer: source changed after review');
  const filename = path.join(root, 'build.js'), source = fs.readFileSync(filename, 'utf8');
  const compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(root);
  const mapFilename = path.join(root, 'site/map-regions.js');
  const mapModule = new Module(mapFilename, compiled);
  mapModule.filename = mapFilename; mapModule.paths = Module._nodeModulePaths(path.dirname(mapFilename));
  mapModule._compile(fs.readFileSync(mapFilename, 'utf8'), mapFilename);
  compiled.require = id => id === mapFilename ? mapModule.exports : Module.prototype.require.call(compiled, id);
  compiled._compile(source + '\nmodule.exports.releaseHelpers = {' + HELPERS.join(',') + '};\n', filename);
  const h = compiled.exports.releaseHelpers;
  for (const name of HELPERS.filter(name => name !== 'RETIRED_DOMAIN_IDS')) {
    if (typeof h[name] !== 'function') throw new Error('Catalog renderer: unsupported build helper ' + name);
  }
  const read = name => fs.readFileSync(path.join(root, 'site', name), 'utf8');
  const templates = { home: read('template.html'), domain: read('domain-template.html'),
    styles: read('styles.css'), script: h.appScriptForSchema(read('app.js'), 2) };
  if (rendererDigest(root) !== expectedDigest) throw new Error('Catalog renderer: source changed during load');
  return { source_digest: expectedDigest, render: (manifest, now) => renderCatalog(h, templates, manifest, now) };
}

function renderCatalog(h, templates, input, now) {
  const taxonomy = h.normalizeV2Taxonomy(input.taxonomy), domains = taxonomy.domains;
  const seen = { demoIds: new Set(), slugs: new Set() };
  const demos = input.demos.map((source, index) => h.normalizeV2Demo({ ...source,
    file_id: 'immutable-release-input', file_check: 'ok', status: 'Live', public_page_permission: 'Public' }, taxonomy, seen, index));
  demos.sort((a, b) => Number(b.featured) - Number(a.featured) || Number(a.sort_order) - Number(b.sort_order)
    || Date.parse(b.date_added) - Date.parse(a.date_added));
  const grouped = Object.fromEntries(domains.map(d => [d.id, []]));
  demos.forEach(demo => grouped[demo._domain].push(demo));
  const active = domains.filter(domain => grouped[domain.id].length);
  const date = new Date(now), built = date.toISOString().slice(0, 10);
  const isNew = demo => { const elapsed = date.getTime() - Date.parse(demo.date_added);
    return elapsed >= 0 && elapsed < 14 * 86400000; };
  const facet = (label, key, terms, list, field) => h.v2FacetFilterHtml(label, key, terms, list, field);
  const filters = [h.filterGroupHtml('Department', 'domain', active.map(domain => ({
    value: domain.taxonomy_id || domain.id, label: domain.short }))),
  facet('Method', 'method', taxonomy.methods, demos, 'method_ids'),
  facet('Data Type', 'data-type', taxonomy.data_types, demos, 'data_type_ids'),
  facet('Instrument Type', 'instrument-type', taxonomy.instrument_types, demos, 'instrument_type_ids')].filter(Boolean).join('\n');
  const output = new Map();
  output.set('index.html', Buffer.from(h.fillTemplate(templates.home, {
    PAGE_TITLE: 'AIS Instrumentation Gym', COUNT_LINE: h.pluralText(demos.length, 'interactive project') + ' · '
      + h.pluralText(active.length, 'active department'), MAP_HOTSPOTS: domains.map(h.mapHotspotHtml).join('\n'),
    MAP_MARKERS: domains.map(domain => h.mapMarkerHtml(domain, grouped[domain.id])).join('\n'),
    MOBILE_DOMAIN_LINKS: domains.map(domain => h.mobileDomainLinkHtml(domain, grouped[domain.id])).join('\n'),
    DOMAIN_FILTERS: filters, CARDS: demos.map((demo, index) => h.cardHtml(demo,
      domains.find(domain => domain.id === demo._domain), isNew(demo), '', index)).join('\n'),
    BUILT: built, STYLES: templates.styles, SCRIPT: templates.script,
  }, 'release homepage')));
  for (const [index, domain] of domains.entries()) {
    const list = grouped[domain.id], count = list.length;
    const pageFilters = [facet('Task', 'task', taxonomy.tasks, list, 'task_ids'),
      facet('Data Type', 'data-type', taxonomy.data_types, list, 'data_type_ids'),
      facet('Instrument Type', 'instrument-type', taxonomy.instrument_types, list, 'instrument_type_ids')].filter(Boolean).join('\n');
    output.set('domains/' + domain.id + '/index.html', Buffer.from(h.fillTemplate(templates.domain, {
      PAGE_TITLE: h.esc(domain.name + ' | AIS Instrumentation Gym'), DOMAIN_NAME: h.esc(domain.name),
      DOMAIN_SHORT: h.esc(domain.short), DOMAIN_DESCRIPTION: h.esc(domain.description),
      DOMAIN_NUMBER: String(index + 1).padStart(2, '0'),
      DOMAIN_COUNT: count ? h.esc(h.pluralText(count, 'interactive project') + ' in this department') : 'No projects published yet',
      DOMAIN_COLOR: domain.color, DOMAIN_SOFT: domain.soft, DOMAIN_ICON: h.domainIcon(domain.id),
      TASK_FILTERS: pageFilters, FILTER_HIDDEN: count ? '' : 'hidden',
      CARDS: list.map((demo, n) => h.cardHtml(demo, domain, isNew(demo), '../../', n)).join('\n'),
      EMPTY_HIDDEN: count ? 'hidden' : '', EMPTY_KICKER: count ? 'No signal found' : 'Coming soon',
      EMPTY_TITLE: count ? 'No projects match this search.' : 'This region is ready for its first experiment.',
      EMPTY_TEXT: count ? 'Clear the filters or try a broader term.' : h.esc('Reserved paths include '
        + domain.futurePaths.join(', ') + '. New projects will appear here as they are added to AIS Instrumentation Gym.'),
      DOMAIN_LINKS: h.domainSwitcherHtml(domain, grouped, domains), BUILT: built,
      STYLES: templates.styles, SCRIPT: templates.script,
    }, 'release domain ' + domain.id)));
    for (const old of domain.legacyIds || []) output.set('domains/' + old + '/index.html', redirect('../' + domain.id + '/index.html'));
  }
  for (const old of h.RETIRED_DOMAIN_IDS) output.set('domains/' + old + '/index.html', redirect('../../index.html#science-map'));
  const manifest = structuredClone(input);
  manifest.generated = date.toISOString(); manifest.audience = 'production';
  manifest.demos = demos.map(d => ({ ...input.demos.find(source => source.demo_id === d.demo_id),
    status: 'Live', public_page_permission: 'Public' }));
  manifest.domains = domains.map(domain => ({ id: domain.id, name: domain.name, short: domain.short,
    description: domain.description, color: domain.color, future_paths: domain.futurePaths,
    subtopics: h.subtopicStats(domain, grouped[domain.id]).map(topic => ({ id: topic.id, name: topic.name,
      project_count: topic.projectCount })), legacy_ids: domain.legacyIds, project_count: grouped[domain.id].length }));
  return { files: output, manifest };
}

function redirect(target) {
  return Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Redirecting | AIS Instrumentation Gym</title><link rel="canonical" href="' + target
    + '"><meta http-equiv="refresh" content="0;url=' + target + '"></head><body><a href="' + target
    + '">Open collection</a><script>location.replace(' + JSON.stringify(target) + '+location.search+location.hash);</script></body></html>');
}

module.exports = { rendererDigest, loadCatalogRenderer };
