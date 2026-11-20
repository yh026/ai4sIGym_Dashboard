import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IMPORTED_PREVIEW, SITE, OWNER, access, contextFor, makeJob, read } from '../server/store.mjs';
import { runJob } from '../server/native.mjs';
import { deskCatalog, saveReviewCheck } from '../server/catalog.mjs';
import { adoptPreview } from '../server/adopt.mjs';
const sourceID = '111111111111111111111111',
  draftID = '222222222222222222222222';
const sha = (data) => createHash('sha1').update(data).digest('hex');
function memoryStore() {
  const data = new Map();
  let seq = 0;
  return {
    get: async (k) => data.get(k)?.data ?? null,
    getWithMetadata: async (k) => data.get(k) ?? null,
    set: async function (k, v, o) {
      return this.setJSON(k, v, o);
    },
    setJSON: async (k, v, opts = {}) => {
      if ((opts.onlyIfNew && data.has(k)) || (opts.onlyIfMatch && opts.onlyIfMatch !== data.get(k)?.etag))
        return { modified: false };
      data.set(k, { data: structuredClone(v), etag: String(++seq) });
      return { modified: true };
    },
    delete: async (k) => data.delete(k),
    list: async ({ prefix }) => ({
      blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }),
  };
}
function demo(slug) {
  return { slug, pages: [{ role: 'insight', path: 'demos/' + slug + '/index.html' }] };
}
test('an interrupted private upload resumes its original required hashes and exact other-demo snapshot', async (t) => {
  const db = memoryStore(),
    page = '/demos/ours/index.html',
    other = '/demos/other/index.html',
    asset = '/demos/ours/resources/data/a.json';
  const content = Buffer.from('[1,2]'),
    original = sha('<p>original</p>');
  const baseline = {
    deployment: { site_id: SITE, deploy_id: sourceID },
    demos: [demo('ours'), demo('other')],
    files: [page, other].map((path) => ({ path, sha1: original, size_bytes: 15 })),
  };
  await db.setJSON('production/baseline', baseline);
  const who = await access(db, { id: OWNER }),
    job = await makeJob(db, who, {
      slug: 'ours',
      base: sourceID,
      files: [{ path: asset, sha1: sha(content), size: content.length }],
    });
  const sources = new Map([[sha(content), new Blob([content])]]);
  let created = 0,
    puts = 0,
    manifest,
    ready = false;
  const draft = () => ({
    id: draftID,
    site_id: SITE,
    title: 'Gym private preview ' + job.id,
    context: 'deploy-preview',
    draft: true,
    state: ready ? 'ready' : 'uploading',
    required: [],
  });
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (opts.method === 'HEAD') return new Response(null, { status: 401 });
    if (path === '/api/v1/sites/' + SITE)
      return Response.json({
        id: SITE,
        name: 'aisigym',
        sso_login: true,
        sso_login_context: 'non_production',
        published_deploy: { id: sourceID },
      });
    if (opts.method === 'POST') {
      assert.equal(path, '/api/v1/sites/' + SITE + '/deploys');
      const body = JSON.parse(opts.body);
      assert.equal(body.draft, true);
      manifest = body.files;
      created++;
      return Response.json({ ...draft(), required: [sha(content)] });
    }
    if (opts.method === 'PUT') {
      puts++;
      if (puts === 1) return new Response(null, { status: 400 });
      assert.deepEqual(Buffer.from(opts.body), content);
      ready = true;
      return Response.json({});
    }
    if (path.endsWith('/files'))
      return Response.json(
        Object.entries(manifest).map(([path, sha]) => ({ path, sha, site_id: SITE, deploy_id: draftID })),
      );
    assert.equal(path, '/api/v1/deploys/' + draftID);
    return Response.json(draft());
  });
  await assert.rejects(runJob(db, 'test', job.id, sources), /HTTP 400/);
  assert.deepEqual((await read(db, 'jobs/' + job.id)).required, [sha(content)]);
  await db.setJSON('heads/other', {
    slug: 'other',
    id: '333333333333333333333333',
    overlay: { [other]: { sha1: sha('later'), size: 5 } },
    removed: [],
  });
  const result = await runJob(db, 'test', job.id, sources);
  assert.equal(created, 1);
  assert.equal(puts, 2);
  assert.equal(result.id, draftID);
  assert.equal(manifest[other], original);
  assert.equal(result.verifiedFiles, 3);
  assert.equal((await read(db, 'heads/other')).overlay[other].sha1, sha('later'));
  assert.equal((await runJob(db, 'test', job.id)).id, draftID);
  assert.equal(puts, 2);
});
test('Netlify identity grants upload only for a named demo', async () => {
  const db = memoryStore();
  await assert.rejects(access(db, null), (e) => e.status === 401);
  await assert.rejects(access(db, { id: 'someone', email: 'person@example.test' }), (e) => e.status === 403);
  await db.setJSON('access/person@example.test', { slugs: ['ours'] });
  const person = await access(db, { id: 'someone', email: 'PERSON@example.test' });
  assert.equal(person.owner, false);
  assert.deepEqual(person.slugs, ['ours']);
  await db.setJSON('production/baseline', {
    deployment: { site_id: SITE, deploy_id: sourceID },
    demos: [demo('ours'), demo('other')],
    files: [],
  });
  await assert.rejects(
    makeJob(db, person, { slug: 'other', base: sourceID, files: [] }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    makeJob(db, person, { slug: 'ours', base: 'stale', files: [] }),
    (e) => e.status === 409,
  );
});

test('a personal check follows the exact demo version and never changes Production or Preview', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('A personal checklist action must not call Netlify deploys.'),
  );
  const db = memoryStore();
  const owner = await access(db, { id: OWNER });
  const base = {
    deployment: { site_id: SITE, deploy_id: sourceID },
    demos: [demo('ours'), demo('other')],
    project_file_index: { ours: { content_digest: 'sha256:production-ours' } },
    files: [],
  };
  await db.setJSON('production/baseline', base);
  const home = (user = owner) => deskCatalog(db, user, null, { overview: true });
  const initial = await home();
  assert.deepEqual(Object.keys(initial.catalog), ['ours', 'other']);
  assert.equal(initial.catalog.ours.pages.insight.path, '/demos/ours/index.html');
  assert.equal(initial.selected, null);
  assert.deepEqual(initial.latest, {});
  assert.deepEqual(initial.checklist, {});
  assert.ok(!('files' in initial) && !('history' in initial) && !('files' in initial.catalog.ours));
  const mark = { slug: 'ours', version: initial.reviewVersions.ours, checked: true };
  const other = { slug: 'other', version: sourceID, checked: true };
  await Promise.all([saveReviewCheck(db, owner, mark), saveReviewCheck(db, owner, other)]);
  assert.deepEqual((await home()).checklist, { ours: mark.version, other: sourceID });
  const nextSite = { ...base, deployment: { ...base.deployment, deploy_id: draftID } };
  await db.setJSON('production/baseline', nextSite);
  assert.deepEqual((await home()).checklist, { ours: mark.version });
  const head = {
    id: draftID,
    slug: 'ours',
    created: '2026-11-19T00:00:00Z',
    pages: { insight: 'https://preview.example.test/insight' },
    url: 'https://preview.example.test/insight',
    actor: 'private-actor',
    overlay: {},
    removed: [],
    changes: [],
  };
  await db.setJSON('heads/ours', head);
  const current = await home();
  assert.deepEqual(current.checklist, {});
  assert.equal(current.latest.ours.pages.insight, head.pages.insight);
  assert.ok(!('actor' in current.latest.ours) && !('changes' in current.latest.ours));
  await assert.rejects(saveReviewCheck(db, owner, mark), (e) => e.status === 409);
  const previewMark = { ...mark, version: draftID };
  await saveReviewCheck(db, owner, previewMark);
  await saveReviewCheck(db, owner, previewMark);
  assert.deepEqual((await home()).checklist, { ours: draftID });
  const uploader = { id: 'collaborator', slugs: ['ours'], owner: false };
  const limited = await home(uploader);
  assert.deepEqual(Object.keys(limited.catalog), ['ours']);
  assert.ok(!('checklist' in limited));
  await assert.rejects(
    saveReviewCheck(db, uploader, { ...previewMark, checked: false }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    saveReviewCheck(db, owner, { ...previewMark, checked: 'true' }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    saveReviewCheck(db, owner, { ...previewMark, slug: 'missing' }),
    (e) => e.status === 404,
  );
  await saveReviewCheck(db, owner, { ...previewMark, checked: false });
  assert.deepEqual((await home()).checklist, {});
  assert.deepEqual(await read(db, 'production/baseline'), nextSite);
  assert.deepEqual(await read(db, 'heads/ours'), head);
});

test('a single protected import fills missing Previews and the next upload reuses private content', async (t) => {
  const db = memoryStore();
  const owner = await access(db, { id: OWNER });
  const legacy = '333333333333333333333333',
    existing = '444444444444444444444444';
  const slugs = ['ours', 'same', 'newer'];
  const demos = slugs.map((slug) => ({
    slug,
    pages: [
      { role: 'insight', path: '/demos/' + slug + '/index.html' },
      { role: 'workflow', path: '/demos/' + slug + '/workflow.html' },
      { role: 'dataset', path: '/datasets/' + slug + '/index.html' },
    ],
  }));
  const prod = Object.fromEntries(demos.flatMap((d) => d.pages.map((p) => [p.path, '<p>stable</p>'])));
  prod['/index.html'] = '<p>Production landing</p>';
  prod['/demos/ours/retired.png'] = 'old';
  const page = demos[0].pages[0].path,
    asset = '/demos/ours/resources/large.mp4';
  const content = {
    ...prod,
    [page]: '<link href="/assets/only.css"><video src="resources/large.mp4"></video>',
    [asset]: 'video bytes',
    '/assets/only.css': 'body{background:url(only.png)}',
    '/assets/only.png': 'pixels',
    '/index.html': '<p>Legacy landing</p>',
    '/assets/unused.png': 'unused',
    '/manifest.json': JSON.stringify({ demos }),
  };
  delete content['/demos/ours/retired.png'];
  const sourceRows = Object.entries(content).map(([path, body]) => ({
    path,
    sha: sha(body),
    size: Buffer.byteLength(body),
    site_id: SITE,
    deploy_id: legacy,
  }));
  const base = {
    demos,
    files: Object.entries(prod).map(([path, body]) => ({
      path,
      sha1: sha(body),
      size: Buffer.byteLength(body),
    })),
    project_file_index: { same: { content_digest: 'stable-version' } },
    deployment: { site_id: SITE, deploy_id: sourceID },
  };
  await db.setJSON('production/baseline', base);
  await saveReviewCheck(db, owner, { slug: 'same', version: 'stable-version', checked: true });
  await saveReviewCheck(db, owner, { slug: 'ours', version: sourceID, checked: true });
  const kept = {
    slug: 'newer',
    id: existing,
    created: '2026-11-17T00:00:00Z',
    pages: {},
    overlay: {},
    removed: [],
  };
  await db.setJSON('heads/newer', kept);
  const grant = { slugs: ['ours'] };
  await db.setJSON('access/member@example.test', grant);
  const reads = [];
  let branch = 'other',
    gate = 401,
    currentJob,
    postCount = 0,
    nativeManifest;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const { hostname, pathname } = new URL(url);
    if (opts.method === 'HEAD') {
      assert.equal(opts.headers?.Authorization, undefined);
      return new Response(null, { status: gate });
    }
    assert.equal(hostname, 'api.netlify.com');
    assert.equal(opts.headers.Authorization, 'Bearer test');
    if (pathname.endsWith('/sites/' + SITE))
      return Response.json({
        id: SITE,
        name: 'aisigym',
        sso_login: true,
        sso_login_context: 'non_production',
        published_deploy: { id: sourceID },
      });
    if (pathname.endsWith('/deploys/' + legacy))
      return Response.json({
        id: legacy,
        site_id: SITE,
        context: 'branch-deploy',
        branch,
        state: 'ready',
        created_at: '2026-11-01T00:00:00Z',
      });
    if (pathname.endsWith('/deploys/' + legacy + '/files')) return Response.json(sourceRows);
    if (pathname.includes('/deploys/' + legacy + '/files/')) {
      assert.equal(opts.headers.Accept, 'application/vnd.bitballoon.v1.raw');
      const path = pathname.split('/files')[1];
      reads.push(path);
      return new Response(content[path] ?? null, { status: path in content ? 200 : 404 });
    }
    if (opts.method === 'POST' && pathname.endsWith('/sites/' + SITE + '/deploys')) {
      const payload = JSON.parse(opts.body);
      assert.equal(payload.draft, true);
      postCount++;
      nativeManifest = payload.files;
      return Response.json({
        id: draftID,
        site_id: SITE,
        title: 'Gym private preview ' + currentJob.id,
        context: 'deploy-preview',
        draft: true,
        state: 'ready',
        required: [],
      });
    }
    if (pathname.endsWith('/deploys/' + draftID + '/files'))
      return Response.json(
        Object.entries(nativeManifest).map(([path, sha]) => ({
          site_id: SITE,
          deploy_id: draftID,
          path,
          sha,
        })),
      );
    throw Error('Unexpected transfer: ' + (opts.method || 'GET') + ' ' + pathname);
  });
  await assert.rejects(adoptPreview(db, 'test', legacy, true), /ready develop/);
  branch = 'develop';
  gate = 200;
  await assert.rejects(adoptPreview(db, 'test', legacy, true), /require sign-in/);
  gate = 401;
  assert.equal((await adoptPreview(db, 'test', legacy)).status, 'dry run');
  assert.equal(await read(db, IMPORTED_PREVIEW), null);
  const { record } = await adoptPreview(db, 'test', legacy, true);
  assert.deepEqual(record.retained, ['newer']);
  assert.deepEqual(Object.keys(record.heads).sort(), ['ours', 'same']);
  assert.deepEqual(record.heads.ours.removed, ['/demos/ours/retired.png']);
  assert.deepEqual(
    Object.keys(record.heads.ours.overlay).sort(),
    ['/assets/only.css', '/assets/only.png', asset, page].sort(),
  );
  assert.equal((await adoptPreview(db, 'test', legacy, true)).status, 'already imported');
  await assert.rejects(adoptPreview(db, 'test', existing, true), /different deployment/);
  const home = () => deskCatalog(db, owner, null, { overview: true });
  const overview = await home();
  assert.equal(overview.latest.newer.id, existing);
  assert.deepEqual(overview.checklist, { same: 'stable-version' });
  assert.equal(
    overview.latest.ours.pages.dataset,
    'https://' + legacy + '--aisigym.netlify.app/datasets/ours/index.html',
  );
  assert.equal((await contextFor(db)).files['/index.html'].sha1, sha(prod['/index.html']));
  await saveReviewCheck(db, owner, { slug: 'ours', version: legacy, checked: true });
  const file = { path: page, sha1: sha(content[page]), size: Buffer.byteLength(content[page]) };
  const copy = '/demos/ours/copy.html';
  await assert.rejects(
    makeJob(db, owner, { slug: 'ours', base: legacy, files: [{ ...file, size: file.size + 1 }] }),
    (err) => err.status === 422,
  );
  currentJob = await makeJob(db, owner, {
    slug: 'ours',
    base: legacy,
    files: [file, { ...file, path: copy }],
  });
  assert.deepEqual(currentJob.need, []);
  reads.length = 0;
  const result = await runJob(db, 'test', currentJob.id);
  assert.deepEqual(reads, [page]);
  assert.equal(postCount, 1);
  assert.equal(nativeManifest[asset], sha(content[asset]));
  assert.equal(nativeManifest[copy], file.sha1);
  assert.equal(nativeManifest['/demos/ours/retired.png'], undefined);
  assert.equal(nativeManifest['/assets/unused.png'], undefined);
  assert.equal(result.incomingBytes, 0);
  assert.equal(result.uploadedBytes, 0);
  assert.deepEqual((await home()).checklist, { same: 'stable-version' });
  assert.equal((await home()).latest.ours.id, draftID);
  assert.equal((await home()).latest.same.id, legacy);
  await assert.rejects(
    makeJob(db, owner, { slug: 'ours', base: legacy, files: [file] }),
    (e) => e.status === 409,
  );
  assert.equal((await read(db, 'heads/ours')).overlay[asset].sha1, sha(content[asset]));
  assert.deepEqual(await read(db, 'heads/newer'), kept);
  assert.deepEqual(await read(db, 'production/baseline'), base);
  assert.deepEqual(await read(db, 'access/member@example.test'), grant);
});
