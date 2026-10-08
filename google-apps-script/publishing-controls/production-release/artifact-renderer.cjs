'use strict';
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { digest, stable, assertCurrentIntent, HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION } = require('./release-plan.cjs');
const { inventoryDigest, validateArtifact } = require('./netlify-bridge.cjs');
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const need = (condition, message) => { if (!condition) throw new Error('Artifact renderer: ' + message); };
const TBB = 'tbb-cluster-explorer-2';
const forbiddenTbb = name => new RegExp('^demos/' + TBB + '/(?:resources/|workflow-resources(?:\\.|/|$))').test(name);
const safe = name => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..');
const clone = value => structuredClone(value);

function verifyPinnedSource({ metadata, inventory, files }, environment) {
  need(metadata && /^[a-f0-9]{24}$/.test(metadata.id || '') && metadata.state === 'ready'
    && files instanceof Map && Array.isArray(inventory) && inventory.length === files.size,
  'complete immutable source files and metadata are required');
  const listed = new Set(), digestFiles = {};
  for (const entry of inventory) {
    const name = String(entry.path || '').replace(/^\//, '');
    need(safe(name) && !listed.has(name) && entry.deploy_id === metadata.id, 'unsafe or ambiguous source inventory');
    listed.add(name);
    const bytes = files.get(name);
    need(Buffer.isBuffer(bytes) && hash(bytes, 'sha1') === entry.sha, 'source hash mismatch: ' + name);
    digestFiles['/' + name] = entry.sha;
  }
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const receipt = JSON.parse(files.get('deploy-receipt.json').toString('utf8'));
  need(manifest.schema_version === 3 && Array.isArray(manifest.demos) && manifest.taxonomy,
    'source must have a complete Registry v3 manifest');
  need(receipt.deploy_id === metadata.id && receipt.site_id === metadata.site_id
    && receipt.commit_ref === metadata.commit_ref && receipt.audience === environment
    && receipt.target === environment && receipt.branch === metadata.branch && receipt.context === metadata.context,
  'source receipt differs from immutable deployment metadata');
  if (environment === 'preview') need(receipt.verified === true && receipt.revision_bound === true,
    'preview source requires a verified Registry receipt');
  return { metadata: clone(metadata), files: new Map(files), inventory: clone(inventory), manifest, receipt,
    environment, inventory_digest: inventoryDigest(digestFiles), receipt_digest: 'sha256:' + hash(files.get('deploy-receipt.json')) };
}

function removeBytesOnce(bytes, needle) {
  const token = Buffer.from(needle), at = bytes.indexOf(token);
  need(at >= 0 && bytes.indexOf(token, at + token.length) === -1, 'unsupported TBB notebook navigation');
  return Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + token.length)]);
}

function localReferences(name, bytes, sourceFiles) {
  if (!/\.(?:html|css|js|json)$/i.test(name)) return [];
  const text = bytes.toString('utf8').replace(/\\\//g, '/'), result = new Set();
  const tokens = [...text.matchAll(/(?:^|[\s"'(\[=:])((?:\.\.\/|\.\/|\/)?[A-Za-z0-9_./-]{1,220}\.(?:html|js|css|json|csv|tsv|txt|md|ipynb|zip|pdf|png|jpe?g|gif|webp|avif|svg|mp4|woff2?|ttf|otf|ico))\b/g)]
    .map(match => match[1]);
  for (let token of tokens) {
    // A token is only a dependency when it resolves to an inventoried file.
    let target = token.startsWith('/') ? token.slice(1) : path.normalize(path.join(path.dirname(name), token));
    if (sourceFiles.has(target)) result.add(target);
    if (sourceFiles.has(token)) result.add(token);
  }
  return [...result];
}

function projectArtifact(source, demo, overrides = []) {
  const hidden = overrides.includes(HIDDEN_TBB_RESOURCES), prefix = 'demos/' + demo.slug + '/';
  const metadata = clone(demo), files = new Map(), transforms = [];
  need(Array.isArray(metadata.pages) && metadata.pages.length, 'project pages are missing');
  const originalResource = metadata.pages.find(page => page.role === 'resource_page');
  if (hidden && demo.slug === TBB) metadata.pages = metadata.pages.filter(page => page.role !== 'resource_page');
  const datasetPrefixes = metadata.pages.filter(page => page.role === 'dataset')
    .map(page => path.dirname(page.path) + '/');
  for (const [name, bytes] of source.files) {
    if (name.startsWith(prefix) && !(hidden && demo.slug === TBB && forbiddenTbb(name))) files.set(name, bytes);
  }
  for (const page of metadata.pages) {
    need(safe(page.path) && source.files.has(page.path), 'project references an unavailable page');
    files.set(page.path, source.files.get(page.path));
  }
  if (metadata.card_asset) {
    const card = metadata.card_asset.public_path;
    need(safe(card) && source.files.has(card), 'card file is missing'); files.set(card, source.files.get(card));
  }
  if (hidden && demo.slug === TBB && originalResource) {
    for (const page of metadata.pages.filter(page => ['insight', 'workflow', 'dataset'].includes(page.role))) {
      const href = path.relative(path.dirname(page.path), originalResource.path);
      const before = files.get(page.path);
      const after = removeBytesOnce(before, '<a href="' + href + '">Notebook &amp; skills</a>');
      files.set(page.path, after);
      transforms.push({ path: page.path, input_sha256: hash(before), output_sha256: hash(after) });
    }
  }
  const queue = [...files.keys()];
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    for (const dependency of localReferences(name, files.get(name), source.files)) {
      if (files.has(dependency) || hidden && demo.slug === TBB && forbiddenTbb(dependency)) continue;
      if (dependency.startsWith('assets/') || dependency.startsWith(prefix)
        || datasetPrefixes.some(dataset => dependency.startsWith(dataset))) {
        files.set(dependency, source.files.get(dependency)); queue.push(dependency);
      }
    }
  }
  metadata.status = 'Live'; metadata.public_page_permission = 'Public';
  const contentDigest = digest({ metadata, files: [...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path)) });
  return { metadata, files, transforms, content_digest: contentDigest };
}

function deploymentSnapshot(source, productionOverrides) {
  return { environment: source.environment, site_id: source.metadata.site_id, state: source.metadata.state,
    branch: source.metadata.branch, context: source.metadata.context, commit_ref: source.metadata.commit_ref,
    deploy_id: source.metadata.id, inventory_digest: source.inventory_digest, receipt_digest: source.receipt_digest,
    ...(source.environment === 'preview' ? { verified: true, registry_revision: source.receipt.registry_revision }
      : { publication_overrides: [...productionOverrides] }),
    projects: source.manifest.demos.map(demo => ({ demo_id: demo.demo_id, slug: demo.slug,
      content_digest: projectArtifact(source, demo, productionOverrides).content_digest })) };
}

function mergedTaxonomy(baseline, preview, selected) {
  const result = clone(baseline.manifest.taxonomy);
  const sources = [...new Set(selected.map(project => project.source_environment))];
  if (!sources.includes('preview')) return result;
  for (const [category, terms] of Object.entries(preview.manifest.taxonomy)) {
    need(Array.isArray(terms) && Array.isArray(result[category]), 'incompatible taxonomy schema');
    const base = new Map(result[category].map(term => [term.id, term]));
    for (const term of terms) {
      // A global taxonomy change affecting retained production content needs its
      // own explicit review. Do not silently reinterpret an older project.
      if (base.has(term.id)) need(stable(base.get(term.id)) === stable(term), 'conflicting shared taxonomy: ' + term.id);
      else { result[category].push(clone(term)); base.set(term.id, term); }
    }
  }
  return result;
}

function addFile(output, name, bytes) {
  need(safe(name) && Buffer.isBuffer(bytes), 'invalid output file');
  need(!output.has(name) || output.get(name).equals(bytes), 'conflicting shared route: ' + name);
  output.set(name, bytes);
}

function introSections(bytes) {
  const text = bytes.toString('utf8'), result = {};
  for (const role of ['stylesheet', 'section', 'script']) {
    const begin = '<!-- ' + HOMEPAGE_INTRODUCTION + ':' + role + ':begin -->';
    const end = '<!-- ' + HOMEPAGE_INTRODUCTION + ':' + role + ':end -->';
    const start = text.indexOf(begin), finish = text.indexOf(end);
    need(start >= 0 && finish > start && text.indexOf(begin, start + 1) < 0 && text.indexOf(end, finish + 1) < 0,
      'homepage introduction markers are missing or ambiguous');
    result[role] = text.slice(start, finish + end.length);
  }
  return result;
}

function retainIntroduction(output, baseline) {
  const sections = introSections(baseline.files.get('index.html'));
  let html = output.get('index.html').toString('utf8');
  for (const [role, anchor] of Object.entries({ stylesheet: '</head>',
    section: '  <section class="project-library" id="projects" aria-labelledby="projects-title">', script: '</body>' })) {
    need(html.indexOf(anchor) >= 0 && html.indexOf(anchor) === html.lastIndexOf(anchor), 'catalog insertion anchor changed');
    html = html.replace(anchor, sections[role] + '\n' + anchor);
  }
  output.set('index.html', Buffer.from(html));
  const override = baseline.receipt.publication_overrides.find(item => item.id === HOMEPAGE_INTRODUCTION);
  need(override && Array.isArray(override.added_files) && override.added_files.length === 4, 'homepage asset inventory is missing');
  for (const entry of override.added_files) {
    const bytes = baseline.files.get(entry.path);
    need(bytes && hash(bytes) === entry.sha256 && bytes.length === entry.size, 'homepage introduction asset changed');
    addFile(output, entry.path, bytes);
  }
  need(stable(introSections(output.get('index.html'))) === stable(sections), 'homepage introduction changed');
  return clone(override);
}

function collectCatalogAssets(output, baseline) {
  const home = baseline.files.get('index.html').toString('utf8');
  const map = home.match(/<img\b[^>]*\bclass="map-art"[^>]*>/g);
  need(map?.length === 1, 'baseline map image is missing or ambiguous');
  let generated = output.get('index.html').toString('utf8');
  need((generated.match(/<img\b[^>]*\bclass="map-art"[^>]*>/g) || []).length === 1, 'generated map image is missing');
  generated = generated.replace(/<img\b[^>]*\bclass="map-art"[^>]*>/, map[0]);
  output.set('index.html', Buffer.from(generated));
  const queue = [...output.keys()].filter(name => name === 'index.html' || name.startsWith('domains/'));
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    for (const dependency of localReferences(name, output.get(name), baseline.files)) {
      if (output.has(dependency) || !dependency.startsWith('assets/')) continue;
      addFile(output, dependency, baseline.files.get(dependency)); queue.push(dependency);
    }
  }
}

function validateOutputLinks(files) {
  // Audit concrete local HTML links and resource attributes. Fragment links,
  // external links and template-generated JavaScript strings are not routes.
  for (const [name, bytes] of files) {
    if (!name.endsWith('.html')) continue;
    const html = bytes.toString('utf8');
    for (const match of html.matchAll(/\b(?:href|src|poster)\s*=\s*(["'])([^"']+)\1/gi)) {
      const href = match[2].replace(/&amp;/g, '&');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
      const bare = href.split(/[?#]/, 1)[0]; if (!bare) continue;
      let target = bare.startsWith('/') ? bare.slice(1) : path.normalize(path.join(path.dirname(name), bare));
      if (!target || target.endsWith('/')) target += 'index.html';
      const candidates = [target, target + '.html', target + '/index.html'];
      need(candidates.some(candidate => files.has(candidate)), 'unresolved local link in ' + name + ': ' + href);
    }
  }
}

function renderArtifact({ intent, current, baseline, preview, catalogRenderer, now = intent.created_at }) {
  const originals = [baseline, preview].filter(Boolean).map(source => [source,
    digest([...source.files].map(([name, bytes]) => [name, hash(bytes)]).sort())]);
  assertCurrentIntent(intent, { ...current, now });
  need(baseline.metadata.id === intent.baseline.deploy_id && baseline.inventory_digest === intent.baseline.inventory_digest,
    'production artifact identity changed');
  if (intent.reviewed_preview) need(preview && preview.metadata.id === intent.reviewed_preview.deploy_id
    && preview.inventory_digest === intent.reviewed_preview.inventory_digest, 'preview artifact identity changed');
  need(catalogRenderer && typeof catalogRenderer.render === 'function' && /^sha256:[a-f0-9]{64}$/.test(catalogRenderer.source_digest),
    'verified catalog renderer is required');
  const output = new Map(), metadata = [], transforms = [];
  for (const project of intent.projects) {
    const source = project.source_environment === 'preview' ? preview : baseline;
    const demo = source.manifest.demos.find(row => row.demo_id === project.demo_id);
    need(demo, 'selected project disappeared from source');
    const built = projectArtifact(source, demo, intent.publication.required_overrides);
    need(built.content_digest === project.content_digest, 'project artifact changed after review');
    for (const [name, bytes] of built.files) addFile(output, name, bytes);
    metadata.push(built.metadata); transforms.push(...built.transforms);
  }
  const inputManifest = { ...clone(baseline.manifest), demos: metadata,
    taxonomy: mergedTaxonomy(baseline, preview, intent.projects), audience: 'production' };
  const catalog = catalogRenderer.render(inputManifest, now);
  for (const [name, bytes] of catalog.files) addFile(output, name, bytes);
  collectCatalogAssets(output, baseline);
  const overrides = [];
  if (intent.publication.preserve_homepage_introduction) overrides.push(retainIntroduction(output, baseline));
  let redirects = '';
  if (intent.publication.omit_notebook_downloads) {
    const tbb = intent.projects.find(project => project.slug === TBB);
    if (tbb) for (const suffix of ['', '/', '.html', '.html/']) redirects += '/demos/' + TBB
      + '/workflow-resources' + suffix + ' /demos/' + TBB + '/workflow.html 302\n';
    overrides.push({ id: HIDDEN_TBB_RESOURCES, demo_slug: TBB, modified_files: transforms,
      removed_page_role: 'resource_page' });
  }
  catalog.manifest.release = { mode: 'controlled-frozen-artifacts', intent_digest: intent.intent_digest,
    baseline_deploy_id: intent.baseline.deploy_id, source_preview_deploy_id: intent.reviewed_preview?.deploy_id || null,
    renderer_digest: catalogRenderer.source_digest, publication_overrides: overrides,
    projects: clone(intent.projects) };
  addFile(output, 'manifest.json', Buffer.from(JSON.stringify(catalog.manifest, null, 2) + '\n'));
  const receipt = { schema: 1, target: 'production', audience: 'production', platform: 'netlify',
    release_mode: 'controlled-frozen-artifacts', publication_method: 'manual-api', built_at: now,
    site_id: intent.site_id, intent_digest: intent.intent_digest, baseline_deploy_id: intent.baseline.deploy_id,
    source_main_commit_ref: intent.baseline.commit_ref, source_preview: clone(intent.reviewed_preview),
    renderer_digest: catalogRenderer.source_digest, publication_overrides: overrides, projects: clone(intent.projects) };
  addFile(output, 'deploy-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  addFile(output, 'robots.txt', Buffer.from('User-agent: *\nAllow: /\n'));
  addFile(output, '_headers', Buffer.from('/deploy-receipt.json\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n'
    + ['embedded', 'optimized', 'runtime'].map(kind => '\n/assets/' + kind + '/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n').join('')));
  if (redirects) addFile(output, '_redirects', Buffer.from(redirects));
  validateOutputLinks(output);
  for (const [source, before] of originals) need(before === digest([...source.files]
    .map(([name, bytes]) => [name, hash(bytes)]).sort()), 'renderer mutated an immutable source');
  const artifact = { schema: 1, intent_digest: intent.intent_digest, files: output };
  const artifactDigest = digest([...output].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  validateArtifact(intent, artifact, artifactDigest);
  return { artifact, artifact_digest: artifactDigest, renderer_evidence: {
    projects: clone(intent.projects), preserved_overrides: [...intent.publication.required_overrides],
    catalog_pages_regenerated: true, source_files_unchanged: true, unselected_routes_absent: true,
    notebook_downloads_absent: [...output.keys()].every(name => !forbiddenTbb(name)),
    homepage_introduction_unchanged: intent.publication.preserve_homepage_introduction,
    renderer_digest: catalogRenderer.source_digest, project_transformations: transforms } };
}

module.exports = { verifyPinnedSource, projectArtifact, deploymentSnapshot, renderArtifact,
  localReferences, validateOutputLinks, introSections };
