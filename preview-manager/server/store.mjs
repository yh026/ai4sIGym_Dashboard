import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import {
  catalogFromBaseline,
  fileMap,
  newDemoDescriptor,
  planChanges,
  requireFirstPages,
  validateChanges,
} from '../shared/package.mjs';

// Set the site and owner identifiers for the target installation.
export const SITE = '00000000-0000-4000-8000-000000000001';
export const ORIGIN = 'https://aisigym.netlify.app';
export const OWNER = '000000000000000000000001';
export const ALIAS = 'gym-preview';
export const IMPORTED_PREVIEW = 'imports/develop-v1';
export const PUBLIC_ROOT = 'production-desk/v1/';
export const PUBLIC_STATE = PUBLIC_ROOT + 'state';
export function effectivePreviews(upstream, state, anchor) {
  const previews = { ...upstream };
  for (const [slug, head] of Object.entries(state?.synced || {}))
    if (head.upstream === (upstream[slug]?.id || anchor)) previews[slug] = head;
  return previews;
}
export const CHUNK = 3 * 1024 * 1024;
export const SAT = 'from-twelve-thousand-numbers-to-a-codebook';
export const storeFor = (token) =>
  getStore({
    name: 'gym-private-preview-v1',
    consistency: 'strong',
    ...(token ? { siteID: SITE, token } : {}),
  });
export const read = (db, key) => db.get(key, { type: 'json' });
export function requireOk(test, message, status = 400) {
  if (!test) throw Object.assign(new Error(message), { status });
}
export function inventory(base, heads, { sources = false } = {}) {
  const files = fileMap(base.files);
  if (sources) {
    for (const file of Object.values(files)) file.sourceDeploy = base.deployment.deploy_id;
  }
  for (const head of Object.values(heads)) {
    for (const path of head.removed) delete files[path];
    for (const [path, file] of Object.entries(head.overlay)) {
      files[path] = sources ? { ...file, sourceDeploy: head.id } : file;
    }
  }
  return files;
}
export function metadata(files) {
  return files.map(({ path, sha1, size }) => ({ path, sha1, size }));
}
export function summary(head) {
  if (!head) return null;
  const { overlay, removed, actor, ...visible } = head;
  return visible;
}
export async function access(db, user) {
  requireOk(user?.id, 'Sign in with a Netlify team account that can access this site.', 401);
  const email = (user.email || '').trim().toLowerCase();
  if (user.id === OWNER) return { id: user.id, email, owner: true, slugs: null };
  const slugs = email ? (await read(db, 'access/' + email))?.slugs : [];
  requireOk(slugs?.length, 'Your account does not have access to the preview desk.', 403);
  return { id: user.id, email, owner: false, slugs };
}
export async function productionCatalog(db) {
  const base = await read(db, 'production/baseline');
  requireOk(base?.deployment?.site_id === SITE, 'The Production catalog has not been initialized.', 503);
  return { base, catalog: catalogFromBaseline(base) };
}
export const demoCategories = (base) =>
  (base.production_manifest?.domains || []).map(({ id, name }) => ({ id, name }));

// The first verified head is the registration. A failed upload never creates a catalog row.
export async function previewCatalog(db) {
  const [{ base, catalog }, { blobs }] = await Promise.all([
    productionCatalog(db),
    db.list({ prefix: 'heads/' }),
  ]);
  const privateHeads = Object.create(null);
  await Promise.all(
    blobs.map(async ({ key }) => {
      const slug = key.slice('heads/'.length);
      if (Object.hasOwn(catalog, slug)) return;
      const head = await read(db, key);
      if (head?.registration?.slug === slug && head.slug === slug) {
        catalog[slug] = newDemoDescriptor(head.registration);
        privateHeads[slug] = head;
      }
    }),
  );
  return { base, catalog, privateHeads };
}

export function availableNewDemo(registration, { base, catalog, files }) {
  const demo = newDemoDescriptor(registration);
  requireOk(
    demoCategories(base).some((category) => category.id === demo.department_id),
    'Choose a category from the list.',
  );
  const route = '/demos/' + demo.slug;
  requireOk(
    !Object.hasOwn(catalog, demo.slug) &&
      !Object.keys(files).some((path) => {
        const name = path.toLowerCase();
        return name === route || name === route + '.html' || name.startsWith(route + '/');
      }),
    'This demo address is already in use. Choose another address or use Upload a Preview to update the existing demo.',
    409,
  );
  return demo;
}

export async function currentHeads(db, slugs, known = {}) {
  const [imported, records] = await Promise.all([
    read(db, IMPORTED_PREVIEW),
    Promise.all(slugs.map((slug) => (Object.hasOwn(known, slug) ? known[slug] : read(db, 'heads/' + slug)))),
  ]);
  const heads = slugs.map((slug, i) => records[i] || imported?.heads[slug]);
  return Object.fromEntries(heads.filter(Boolean).map((head) => [head.slug, head]));
}
export async function contextFor(db) {
  const { base, catalog, privateHeads } = await previewCatalog(db);
  const [upstream, live] = await Promise.all([
    currentHeads(db, Object.keys(catalog), privateHeads),
    read(db, PUBLIC_STATE),
  ]);
  const heads = effectivePreviews(upstream, live, base.deployment.deploy_id);
  return { base, catalog, heads, upstream, live, files: inventory(base, heads, { sources: true }) };
}
export const authorized = (who, slug) => who.owner || who.slugs?.includes(slug);
export async function makeJob(db, who, body) {
  const creating = body.registration !== undefined;
  if (creating) requireOk(who.owner && who.id === OWNER, 'Only the owner can add a new demo.', 403);
  const { base, catalog, heads, files, live } = await contextFor(db);
  const { slug, remove = [], base: parent } = body;
  let demo = catalog[slug],
    registration;
  if (creating) {
    const details = body.registration;
    requireOk(
      details && details.slug === slug && Array.isArray(remove) && !remove.length,
      'Invalid new demo registration.',
    );
    demo = availableNewDemo(details, { base, catalog, files });
    registration = {
      slug,
      title: demo.title,
      departmentId: demo.department_id,
      entryPages: details.entryPages || {},
    };
  } else
    requireOk(
      Object.hasOwn(catalog, slug) && authorized(who, slug),
      'Your account does not have upload access to this demo.',
      403,
    );
  requireOk(
    parent === (heads[slug]?.id || base.deployment.deploy_id),
    'A newer preview is available. Refresh and review the changes before submitting.',
    409,
  );
  requireOk(
    Array.isArray(body.files) && body.files.length <= 10000 && Array.isArray(remove),
    'This file manifest is invalid.',
  );
  const incoming = metadata(body.files);
  requireOk(incoming.length || remove.length, 'Choose at least one file or a file to remove.');
  validateChanges(demo, incoming, remove, files);
  if (creating) requireFirstPages(demo, incoming);
  const known = new Map(Object.values(files).map((f) => [f.sha1, f.size]));
  for (const file of incoming) {
    requireOk(
      !known.has(file.sha1) || known.get(file.sha1) === file.size,
      'Size differs from the existing file: ' + file.path,
      422,
    );
  }
  const need = [...new Set(incoming.filter((f) => !known.has(f.sha1)).map((f) => f.sha1))];
  const job = {
    id: randomUUID(),
    slug,
    actor: who.id,
    created: new Date().toISOString(),
    parent,
    production: base.deployment.deploy_id,
    publicRevision: live?.revision || base.deployment.deploy_id,
    files: incoming,
    remove,
    need,
    phase: 'uploading',
    ...(registration && { registration }),
  };
  await db.setJSON('jobs/' + job.id, job, { onlyIfNew: true });
  return job;
}
export function describeFiles(files, remove, current) {
  return planChanges(current, files, remove).map(({ path, kind, before, after }) => ({
    path,
    kind,
    before: before?.sha1,
    after: after?.sha1,
    size: after?.size ?? 0,
  }));
}
export async function getJob(db, id) {
  requireOk(typeof id === 'string' && /^[\da-f-]{36}$/.test(id), 'This upload ID is invalid.');
  const job = await read(db, 'jobs/' + id);
  requireOk(job, 'This upload could not be found.', 404);
  return job;
}
export const partKey = (j, sha, n) => 'parts/' + j.id + '/' + sha + '/' + n;
