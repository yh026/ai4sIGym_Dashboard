'use strict';

// Shared, deterministic contract. No I/O: the Google adapter supplies verified
// bytes/metadata and both Node and Apps Script supply SHA-256.
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
const ROLES = ['insight', 'dataset', 'workflow', 'legacy', 'resource_page'];
const FORBIDDEN_SHEET = '1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE';
const FORBIDDEN_ROOT = '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH';

function need(ok, message) { if (!ok) throw new Error('Registry v3: ' + message); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function unique(rows, key, name) {
  const map = new Map();
  for (const row of rows) {
    need(row && ID.test(row[key] || ''), 'invalid ' + name + ' ID');
    need(!map.has(row[key]), 'duplicate ' + name + ': ' + row[key]); map.set(row[key], row);
  }
  return map;
}
function safeRoute(route) {
  return typeof route === 'string' && route.length < 240
    && !/[\\?#%:]/.test(route) && !route.startsWith('/')
    && route.split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) && p !== '..' && p !== '.')
    && !route.split('/').some(p => p.startsWith('.'));
}
function assertSandbox(config) {
  need(config && config.environment === 'sandbox', 'sandbox mode required');
  need(config.spreadsheet_id && config.spreadsheet_id !== FORBIDDEN_SHEET, 'official Sheet is forbidden');
  need(config.drive_root_id && config.drive_root_id !== FORBIDDEN_ROOT, 'official Drive root is forbidden');
  need(!config.production_hook, 'Production hook is forbidden in sandbox');
  need(config.branch === 'develop', 'sandbox must target develop');
}
function sourceDescriptor(source, html) {
  need(source && source.in_scope === true && source.trashed !== true, 'file missing or outside sandbox');
  need(typeof source.file_id === 'string' && source.file_id.length > 0, 'missing source file');
  need(SHA.test(source.sha256 || ''), 'invalid file hash');
  need(Number.isSafeInteger(source.size) && source.size > 0 && source.size <= 25 * 1024 * 1024, 'invalid file size');
  need(typeof source.modified_at === 'string' && Number.isFinite(Date.parse(source.modified_at)), 'invalid file timestamp');
  if (html) need(source.mime_type === 'text/html', 'HTML source required');
  return { file_id: source.file_id, sha256: source.sha256, size: source.size,
    mime_type: source.mime_type, modified_at: source.modified_at, parent_path: source.parent_path };
}

function compileRegistryV3(input, hash) {
  need(typeof hash === 'function', 'SHA-256 implementation required');
  need(['preview', 'production'].includes(input.audience), 'invalid audience');
  if (input.environment === 'sandbox') {
    assertSandbox(input); need(input.audience === 'preview', 'sandbox rejects Production');
  }
  need(ID.test(input.registry_instance || ''), 'invalid Registry instance');
  const projects = unique(input.projects || [], 'demo_id', 'project');
  const versions = unique(input.versions || [], 'version_id', 'version');
  const pages = unique(input.pages || [], 'page_id', 'page');
  const resources = unique(input.resources || [], 'resource_id', 'resource');
  unique([...projects.values()], 'slug', 'slug');
  for (const v of versions.values()) {
    need(projects.has(v.demo_id), 'version has no project');
    need(['single', 'three-page'].includes(v.layout), 'invalid layout');
    need(['Draft', 'Reviewed', 'Published'].includes(v.state), 'invalid version state');
    need(['Public', 'Preview only', 'Private'].includes(v.permission), 'invalid version permission');
    need(input.environment !== 'sandbox' || v.state !== 'Published', 'sandbox cannot publish versions');
  }
  for (const p of pages.values()) {
    need(versions.has(p.version_id), 'page has no version');
    need(ROLES.includes(p.role), 'invalid page role');
    need(['Ready', 'Placeholder'].includes(p.state), 'invalid page state');
    need(p.state !== 'Placeholder' || (p.role === 'dataset' && !p.source), 'only Dataset may be an empty placeholder');
  }
  for (const r of resources.values()) {
    need(versions.has(r.version_id), 'resource has no version');
    need(['card','download'].includes(r.role), 'invalid resource role');
  }
  const usedRoutes = new Set(), selectedFiles = new Map(), demos = [], bundles = [];
  for (const project of [...projects.values()].sort((a,b) => a.demo_id.localeCompare(b.demo_id))) {
    need(['Live', 'Draft', 'Archived'].includes(project.status), 'invalid project status');
    need(['Public', 'Preview only', 'Private'].includes(project.public_page_permission), 'invalid project permission');
    if (project.status === 'Archived' || project.public_page_permission === 'Private') continue;
    if (input.audience === 'production' && (project.status !== 'Live' || project.public_page_permission !== 'Public')) continue;
    const pointer = input.audience === 'production' ? project.published_version_id : project.development_version_id;
    if (!pointer) continue;
    const version = versions.get(pointer);
    need(version && version.demo_id === project.demo_id, 'version pointer belongs to another project');
    if (version.permission === 'Private') continue;
    if (input.audience === 'production') need(version.state === 'Published' && version.permission === 'Public', 'unpublished version selected');
    const base = 'demos/' + project.slug + '/';
    const sourceFolder = 'projects/' + project.slug + '/' + pointer;
    const versionPages = [...pages.values()].filter(p => p.version_id === pointer);
    const roles = new Set();
    const acceptRoute = route => {
      need(safeRoute(route), 'unsafe route'); need(!usedRoutes.has(route), 'duplicate output route: ' + route); usedRoutes.add(route);
    };
    const files = versionPages.map(p => {
      need(!roles.has(p.role), 'duplicate page role: ' + p.role); roles.add(p.role);
      acceptRoute(p.route);
      const expected = { insight: base + 'index.html', legacy: base + 'index.html', workflow: base + 'workflow.html', resource_page: base + 'workflow-resources.html' };
      if (p.role === 'dataset') {
        need(p.route === base + 'dataset.html' || /^datasets\/[a-z0-9-]+\/index\.html$/.test(p.route), 'invalid Dataset route');
        need(ID.test(p.dataset_id || '') && ID.test(p.dataset_version || ''), 'Dataset identity and version required');
      } else need(p.route === expected[p.role], 'page route does not match project and role');
      let source = null;
      if (p.state === 'Ready') {
        source = sourceDescriptor(p.source, true);
        need(source.parent_path === (p.role === 'dataset' ? 'datasets/' + p.dataset_id + '/' + p.dataset_version : sourceFolder), 'page belongs to a different source directory');
      }
      const result = { page_id: p.page_id, role: p.role, state: p.state, route: p.route,
        ...(p.role === 'dataset' ? { dataset_id: p.dataset_id, dataset_version: p.dataset_version } : {}), source };
      if (source) selectedFiles.set(p.page_id, { ...source, id: p.page_id, kind: 'page', demo_id: project.demo_id, version_id: pointer });
      return result;
    }).sort((a,b) => a.role.localeCompare(b.role));
    if (version.layout === 'three-page') need(['insight','dataset','workflow'].every(r => roles.has(r)) && !roles.has('legacy'), 'three-page version requires Insight, Dataset and Workflow');
    else need(roles.size === 1 && roles.has('legacy'), 'single-page version requires legacy only');
    const attached = [...resources.values()].filter(r => r.version_id === pointer).map(r => {
      acceptRoute(r.route); need(r.route.startsWith(base + 'resources/') || r.role === 'card', 'resource outside project resources');
      need(/\.(?:ipynb|zip|json|csv|txt|md|jpe?g|png|webp)$/.test(r.route), 'unsupported resource type');
      if (r.role === 'card') need(/^assets\/cards\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/.test(r.route), 'invalid card route');
      const source = sourceDescriptor(r.source, false);
      const resourceFolder = sourceFolder + '/resources';
      need(r.role === 'card' ? source.parent_path === sourceFolder : safeRoute(source.parent_path) && (source.parent_path === resourceFolder || source.parent_path.startsWith(resourceFolder + '/')), 'resource belongs to a different source directory');
      const result = { resource_id: r.resource_id, role: r.role || 'download', route: r.route, source };
      selectedFiles.set(r.resource_id, { ...source, id: r.resource_id, kind: 'resource', demo_id: project.demo_id, version_id: pointer });
      return result;
    }).sort((a,b) => a.resource_id.localeCompare(b.resource_id));
    const metadata = { ...(input.audience === 'production' ? version.frozen_metadata : project) };
    if (input.audience === 'production') need(metadata.demo_id === project.demo_id && metadata.slug === project.slug, 'Published metadata snapshot required');
    delete metadata.development_version_id; delete metadata.published_version_id;
    delete metadata.file_id; delete metadata.file_check;
    const snapshot = { metadata, version_id: pointer, layout: version.layout, pages: files, resources: attached };
    const digest = 'sha256:' + hash(stable(snapshot));
    if (['Reviewed','Published'].includes(version.state)) need(version.snapshot_digest === digest, 'reviewed snapshot changed; create a Draft version');
    if (input.audience === 'production') {
      need(version.frozen === true, 'Published version must use frozen copies');
      const draftFiles = new Set([...pages.values()].filter(p => versions.get(p.version_id).state === 'Draft' && p.source).map(p => p.source.file_id)
        .concat([...resources.values()].filter(r => versions.get(r.version_id).state === 'Draft' && r.source).map(r => r.source.file_id)));
      for (const item of files.concat(attached)) if (item.source) need(!draftFiles.has(item.source.file_id), 'Published file is shared with a mutable Draft');
    }
    const entry = files.find(p => ['legacy','insight'].includes(p.role));
    demos.push({ ...metadata, file_id: entry.page_id, file_check: 'ok', card_asset: null });
    bundles.push({ demo_id: project.demo_id, version_id: pointer, layout: version.layout,
      collection: version.collection || '', snapshot_digest: digest, pages: files, resources: attached });
  }
  // Shared Dataset identity must resolve to exactly one source in this release.
  const datasets = new Map();
  for (const b of bundles) for (const p of b.pages.filter(p=>p.role==='dataset')) {
    const key = p.dataset_id + '@' + p.dataset_version;
    const source = stable({state:p.state,source:p.source});
    need(!datasets.has(key) || datasets.get(key) === source, 'shared Dataset version resolves to different files'); datasets.set(key,source);
  }
  const manifest = { schema_version:3, registry_instance:input.registry_instance,
    environment:input.environment, audience:input.audience, site:input.site || {}, taxonomy:input.taxonomy,
    demos, bundles };
  manifest.registry_revision = 'sha256:' + hash(stable(manifest));
  return { manifest, files: [...selectedFiles.values()] };
}

function authorizedFile(snapshot, id, audience, revision) {
  need(snapshot.manifest.audience === audience, 'audience mismatch');
  need(snapshot.manifest.registry_revision === revision, 'revision mismatch');
  const file = snapshot.files.find(f=>f.id===id);
  need(file, 'file is not part of the selected release'); return file;
}

module.exports = { stable, safeRoute, assertSandbox, compileRegistryV3, authorizedFile,
  sourceDescriptor, FORBIDDEN_ROOT, FORBIDDEN_SHEET };
