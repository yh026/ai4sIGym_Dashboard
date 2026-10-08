'use strict';

// Pure release planning only. This module never reads Drive, calls Netlify,
// changes Git, or publishes a deployment. The transport must obtain snapshots
// from immutable deploy inventories and verified receipts before calling it.
const crypto = require('node:crypto');
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const DEPLOY = /^[a-f0-9]{24}$/;
const SITE = /^[a-f0-9-]{20,64}$/i;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LIFETIME_MS = 30 * 60 * 1000;
const HIDDEN_TBB_RESOURCES = 'hide-tbb-notebook-resources-v1';
const HOMEPAGE_INTRODUCTION = 'homepage-introduction-v1';
const KNOWN_OVERRIDES = new Set([HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION]);

function need(value, message) {
  if (!value) throw new Error('Release controls: ' + message);
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  need(value !== undefined && typeof value !== 'function', 'unsupported value in release contract');
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function unique(items, key, label) {
  need(Array.isArray(items), label + ' must be an array');
  const values = new Map();
  for (const item of items) {
    need(item && ID.test(item[key] || '') && !values.has(item[key]), 'invalid or duplicate ' + label);
    values.set(item[key], item);
  }
  return values;
}

function validateSnapshot(snapshot, environment) {
  need(snapshot && snapshot.environment === environment && SITE.test(snapshot.site_id || '')
    && DEPLOY.test(snapshot.deploy_id || '') && snapshot.state === 'ready'
    && SHA1.test(snapshot.commit_ref || '') && SHA256.test(snapshot.inventory_digest || '')
    && SHA256.test(snapshot.receipt_digest || ''), 'invalid ' + environment + ' deployment identity');
  need(snapshot.branch === (environment === 'production' ? 'main' : 'develop'), 'unexpected deployment branch');
  if (environment === 'preview') {
    need(snapshot.context === 'branch-deploy' && snapshot.verified === true
      && SHA256.test(snapshot.registry_revision || ''), 'preview must have a verified Registry receipt');
  } else {
    need(snapshot.context === 'production', 'invalid production context');
    need(Array.isArray(snapshot.publication_overrides)
      && snapshot.publication_overrides.every(id => KNOWN_OVERRIDES.has(id))
      && new Set(snapshot.publication_overrides).size === snapshot.publication_overrides.length,
    'unsupported production publication override');
  }
  const projects = unique(snapshot.projects, 'demo_id', environment + ' projects');
  const slugs = new Set();
  for (const project of projects.values()) {
    need(ID.test(project.slug || '') && !slugs.has(project.slug)
      && SHA256.test(project.content_digest || ''), 'invalid project slug or content digest');
    slugs.add(project.slug);
  }
  return projects;
}

function snapshotIdentity(snapshot) {
  return {
    deploy_id: snapshot.deploy_id,
    inventory_digest: snapshot.inventory_digest,
    receipt_digest: snapshot.receipt_digest,
    commit_ref: snapshot.commit_ref,
  };
}

function normalizeSelection(catalog, selection) {
  const projects = unique(catalog, 'demo_id', 'catalog');
  const settings = unique(selection, 'demo_id', 'selection');
  need(settings.size === projects.size && [...settings.keys()].every(id => projects.has(id)),
    'selection must explicitly cover every catalog project');
  const slugs = new Set();
  return [...projects.values()].map(project => {
    const row = settings.get(project.demo_id);
    need(ID.test(project.slug || '') && !slugs.has(project.slug), 'invalid or duplicate catalog slug');
    slugs.add(project.slug);
    need(typeof row.include_in_production === 'boolean' && typeof row.include_in_preview === 'boolean',
      'publishing controls must be booleans');
    return { demo_id: project.demo_id, slug: project.slug,
      include_in_production: row.include_in_production, include_in_preview: row.include_in_preview };
  }).sort((a, b) => a.demo_id.localeCompare(b.demo_id));
}

function createReleaseIntent({ catalog, selection, baseline, preview = null, now = new Date().toISOString() }) {
  const at = Date.parse(now);
  need(Number.isFinite(at) && new Date(at).toISOString() === now, 'invalid creation time');
  const production = validateSnapshot(baseline, 'production');
  const development = preview ? validateSnapshot(preview, 'preview') : new Map();
  need(!preview || preview.site_id === baseline.site_id, 'preview belongs to a different site');
  const rows = normalizeSelection(catalog, selection);
  const byId = new Map(rows.map(row => [row.demo_id, row]));
  for (const [id, project] of [...production, ...development]) {
    need(byId.has(id) && byId.get(id).slug === project.slug,
      'deployed project is missing from the catalog or has a changed route');
  }
  const projects = [], removals = [];
  for (const row of rows) {
    const old = production.get(row.demo_id);
    if (!row.include_in_production) {
      if (old) removals.push({ demo_id: row.demo_id, slug: row.slug, content_digest: old.content_digest });
      continue;
    }
    const environment = row.include_in_preview ? 'preview' : 'production';
    const source = environment === 'preview' ? development.get(row.demo_id) : old;
    need(source, row.include_in_preview
      ? 'update preview before publishing ' + row.demo_id
      : 'project has no published version to retain: ' + row.demo_id);
    const snapshot = environment === 'preview' ? preview : baseline;
    projects.push({ demo_id: row.demo_id, slug: row.slug, source_environment: environment,
      source_deploy_id: snapshot.deploy_id, content_digest: source.content_digest,
      action: !old ? 'add' : source.content_digest === old.content_digest ? 'keep' : 'update' });
  }
  const intent = {
    schema: 1, target: 'production', site_id: baseline.site_id,
    created_at: now, expires_at: new Date(at + MAX_LIFETIME_MS).toISOString(),
    baseline: snapshotIdentity(baseline),
    reviewed_preview: preview ? { ...snapshotIdentity(preview), registry_revision: preview.registry_revision } : null,
    selection_digest: digest(rows), projects, removals,
    publication: {
      shell_source_deploy_id: baseline.deploy_id,
      required_overrides: [...baseline.publication_overrides].sort(),
      regenerate_catalog_pages: true,
      omit_notebook_downloads: baseline.publication_overrides.includes(HIDDEN_TBB_RESOURCES),
      preserve_homepage_introduction: baseline.publication_overrides.includes(HOMEPAGE_INTRODUCTION),
      preserve_unselected_production_projects: true,
    },
  };
  return { ...intent, intent_digest: digest(intent) };
}

function checkIntent(intent) {
  need(intent && intent.schema === 1 && intent.target === 'production', 'invalid release intent');
  const { intent_digest, ...body } = intent;
  need(SHA256.test(intent_digest || '') && digest(body) === intent_digest, 'release intent changed');
}

// Call immediately before every draft-creation request and again before the
// sole explicit publish request. The transport must hold its own operation lock.
function assertCurrentIntent(intent, { catalog, selection, baseline, preview = null, now = new Date().toISOString() }) {
  checkIntent(intent);
  need(Number.isFinite(Date.parse(now)) && Date.parse(now) >= Date.parse(intent.created_at)
    && Date.parse(now) <= Date.parse(intent.expires_at), 'release review expired; review again');
  const current = createReleaseIntent({ catalog, selection, baseline, preview, now: intent.created_at });
  need(current.intent_digest === intent.intent_digest,
    'production, reviewed preview, or project selection changed; review again');
  return true;
}

// A renderer supplies this evidence after validating the complete assembled
// artifact. This contract does not turn a client-provided claim into evidence:
// the transport must calculate and persist it server-side, never accept it
// directly from a Sheet cell or browser form.
function assertCandidate(intent, candidate) {
  checkIntent(intent);
  need(candidate && candidate.site_id === intent.site_id && DEPLOY.test(candidate.deploy_id || '')
    && candidate.deploy_id !== intent.baseline.deploy_id
    && candidate.deploy_id !== intent.reviewed_preview?.deploy_id
    && candidate.state === 'ready' && candidate.draft === true
    && candidate.intent_digest === intent.intent_digest
    && SHA256.test(candidate.inventory_digest || '')
    && candidate.catalog_pages_regenerated === true, 'candidate must be a separate validated draft');
  const actual = unique(candidate.projects, 'demo_id', 'candidate projects');
  need(actual.size === intent.projects.length, 'candidate project membership differs from the reviewed plan');
  for (const expected of intent.projects) {
    const project = actual.get(expected.demo_id);
    need(project && project.slug === expected.slug && project.source_deploy_id === expected.source_deploy_id
      && project.content_digest === expected.content_digest, 'candidate project source differs from the reviewed plan');
  }
  need(stable([...(candidate.preserved_overrides || [])].sort())
    === stable(intent.publication.required_overrides), 'candidate lost production publication overrides');
  need(candidate.unselected_routes_absent === true && candidate.source_files_unchanged === true,
    'candidate must omit unpublished routes and preserve source files');
  if (intent.publication.omit_notebook_downloads) need(candidate.notebook_downloads_absent === true,
    'candidate exposes hidden notebook resources');
  if (intent.publication.preserve_homepage_introduction) need(candidate.homepage_introduction_unchanged === true,
    'candidate changed the homepage introduction');
  return true;
}

function createDraftRequest(intent, files) {
  checkIntent(intent);
  need(files && typeof files === 'object' && !Array.isArray(files), 'file digest is required');
  for (const [name, hash] of Object.entries(files)) {
    need(/^\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
      && !name.split('/').some(part => part === '.' || part === '..') && SHA1.test(hash), 'invalid file digest entry');
  }
  for (const name of ['/index.html', '/manifest.json', '/deploy-receipt.json', '/robots.txt', '/_headers']) {
    need(Object.hasOwn(files, name), 'missing generated release file: ' + name);
  }
  return { draft: true, async: true, title: 'Reviewed project release ' + intent.intent_digest.slice(7, 19),
    files: { ...files } };
}

module.exports = { createReleaseIntent, assertCurrentIntent, assertCandidate, createDraftRequest,
  validateSnapshot, normalizeSelection, stable, digest, HIDDEN_TBB_RESOURCES, HOMEPAGE_INTRODUCTION };
