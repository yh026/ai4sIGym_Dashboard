import {
  ORIGIN,
  PUBLIC_STATE,
  effectivePreviews,
  OWNER,
  SAT,
  authorized,
  currentHeads,
  inventory,
  previewCatalog,
  demoCategories,
  read,
  requireOk,
  summary,
} from './store.mjs';

const checksKey = 'personal/' + OWNER + '/reviewed-and-published';
const isOwner = (who) => who.owner && who.id === OWNER;
const productionVersion = (base, slug) =>
  base.project_file_index?.[slug]?.content_digest || base.deployment.deploy_id;
const reviewVersion = (base, slug, head) =>
  head?.carriedReviewVersion || head?.id || productionVersion(base, slug);

async function listedValues(db, prefix) {
  const { blobs } = await db.list({ prefix });
  return (await Promise.all(blobs.map(({ key }) => read(db, key)))).filter(Boolean);
}

export async function deskCatalog(db, who, requestedSlug, { overview = false } = {}) {
  const { base, catalog, privateHeads } = await previewCatalog(db);
  const allowed = Object.keys(catalog).filter((slug) => authorized(who, slug));
  const selected = overview ? null : requestedSlug || (allowed.includes(SAT) ? SAT : allowed[0]);
  if (!overview)
    requireOk(allowed.includes(selected), 'Your account does not have upload access to this demo.', 403);

  const owner = isOwner(who);
  const [upstream, grants, savedChecks, live] = await Promise.all([
    currentHeads(db, overview ? allowed : Object.keys(catalog), privateHeads),
    owner ? listedValues(db, 'access/') : [],
    owner ? read(db, checksKey) : null,
    read(db, PUBLIC_STATE),
  ]);
  const heads = effectivePreviews(upstream, live, base.deployment.deploy_id);
  const demos = {},
    latest = {},
    reviewVersions = {},
    checklist = {};
  for (const slug of allowed) {
    const { title, pages, readOnlyPaths, writableExternalPaths, files, department_id, previewOnly } =
      catalog[slug];
    const released = live?.released[slug];
    demos[slug] = {
      slug,
      title,
      pages,
      departmentId: department_id,
      published: !previewOnly || Boolean(released),
      productionVersion: released?.id || (previewOnly ? null : productionVersion(base, slug)),
      updated: released?.created || (previewOnly ? heads[slug]?.created : base.deployment.published_at),
    };
    if (!overview) Object.assign(demos[slug], { readOnlyPaths, writableExternalPaths, files });
    const head = heads[slug];
    if (head) {
      const { id, created, pages, url } = head;
      latest[slug] = overview ? { id, slug, created, pages, url } : summary(head);
    }
    const version = reviewVersion(base, slug, head);
    reviewVersions[slug] = version;
    if (owner && savedChecks?.[slug] === version) checklist[slug] = version;
  }
  const view = {
    who,
    catalog: demos,
    latest,
    origin: ORIGIN,
    production: live?.revision || base.deployment.deploy_id,
    anchor: base.deployment.deploy_id,
    ...(owner && live && { connection: live.connection }),
    selected,
    grants,
    ...(owner && { categories: demoCategories(base) }),
    reviewVersions,
  };
  if (owner) view.checklist = checklist;
  if (!overview) {
    view.files = inventory(base, heads);
    view.history = (await listedValues(db, 'versions/' + selected + '/'))
      .map(summary)
      .sort((a, b) => b.created.localeCompare(a.created));
  }
  return view;
}

export async function saveReviewCheck(db, who, body) {
  requireOk(isOwner(who), 'Only the owner can update this personal checklist.', 403);
  const { slug, checked, version } = body || {};
  requireOk(
    typeof slug === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
      typeof version === 'string' &&
      typeof checked === 'boolean',
    'Choose a demo and its current version.',
  );

  // Read the note before its version. A concurrent change to either row cannot
  // attach a stale check to a new preview or overwrite another demo's check.
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await db.getWithMetadata(checksKey, { type: 'json' });
    const [{ base, catalog }, upstream, live] = await Promise.all([
      previewCatalog(db),
      currentHeads(db, [slug]),
      read(db, PUBLIC_STATE),
    ]);
    const heads = effectivePreviews(upstream, live, base.deployment.deploy_id);
    requireOk(Object.hasOwn(catalog, slug), 'This demo is no longer in the catalog.', 404);
    requireOk(
      version === reviewVersion(base, slug, heads[slug]),
      'This demo has a new version. Refresh the overview to review it.',
      409,
    );
    const checks = { ...previous?.data };
    if ((checks[slug] === version) === checked) return { slug, version, checked };
    if (checked) checks[slug] = version;
    else delete checks[slug];
    const condition = previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
    if ((await db.setJSON(checksKey, checks, condition)).modified) return { slug, version, checked };
  }
  requireOk(false, 'The checklist changed in another tab. Refresh and try again.', 409);
}
