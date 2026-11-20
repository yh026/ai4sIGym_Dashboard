import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SITE, OWNER, ORIGIN, PUBLIC_STATE, access, makeJob, partKey, read } from '../server/store.mjs';
import { runJob } from '../server/native.mjs';
import { deskCatalog } from '../server/catalog.mjs';
import { beginRelease, releaseState, reviewedPreview, runRelease } from '../server/releases.mjs';
import { connectProduction } from '../server/production.mjs';
import { snapshotKey } from '../server/rollback.mjs';

const PUBLIC = '111111111111111111111111';
const sha = (bytes) => createHash('sha1').update(bytes).digest('hex');
// Release tests compare transferred bytes and hashes across deployments.
function mediaBox(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
const VIDEO = Buffer.concat([
  mediaBox('ftyp', Buffer.from('isom\0\0\0\0isomiso2', 'latin1')),
  mediaBox('mdat', Buffer.from('Generated media transfer fixture.')),
]);
const VIDEO_PATH = '/demos/ours/resources/clip.mp4';
const OURS = '/demos/ours/index.html';
const OTHER = '/demos/other/index.html';
const EXTRA = '/demos/ours/preview-only.json';
function memoryStore() {
  const data = new Map();
  let sequence = 0;
  const copy = (value) =>
    value instanceof Blob
      ? value
      : value instanceof ArrayBuffer
        ? value.slice(0)
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          : structuredClone(value);
  return {
    async get(key, options = {}) {
      const value = data.get(key)?.data;
      if (value === undefined) return null;
      if (options.type === 'blob') return value instanceof Blob ? value : new Blob([value]);
      if (options.type === 'arrayBuffer') return value instanceof Blob ? value.arrayBuffer() : copy(value);
      return copy(value);
    },
    async getWithMetadata(key) {
      const row = data.get(key);
      return row ? { data: copy(row.data), etag: row.etag } : null;
    },
    async set(key, value, options) {
      return this.setJSON(key, value, options);
    },
    async setJSON(key, value, options = {}) {
      if (
        (options.onlyIfNew && data.has(key)) ||
        (options.onlyIfMatch && options.onlyIfMatch !== data.get(key)?.etag)
      )
        return { modified: false };
      data.set(key, { data: copy(value), etag: String(++sequence) });
      return { modified: true };
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix }) {
      return { blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
const row = (path, bytes) => ({ path, sha1: sha(bytes), size: Buffer.byteLength(bytes) });
function mockNative(t, initialContent, live = false) {
  let published = PUBLIC,
    disconnect = false;
  const contents = new Map(Object.values(initialContent).map((bytes) => [sha(bytes), Buffer.from(bytes)]));
  const manifests = new Map([
    [PUBLIC, Object.fromEntries(Object.entries(initialContent).map(([path, bytes]) => [path, sha(bytes)]))],
  ]);
  const deployments = new Map();
  const posts = [],
    puts = [],
    reads = [];
  let sequence = 1;
  let failPost = null;
  const draft = (deployment) => ({
    ...deployment,
    state: deployment.required.every((hash) => contents.has(hash)) ? 'ready' : 'uploading',
  });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(url),
      path = decodeURIComponent(target.pathname),
      method = options.method || 'GET';
    if (method === 'HEAD') {
      assert.notEqual(target.hostname, 'api.netlify.com');
      return new Response(null, { status: 401 });
    }
    assert.equal(target.hostname, 'api.netlify.com', 'all transfers use the mocked native API');
    assert.equal(options.headers?.Authorization, 'Bearer test');
    if (path === '/api/v1/sites/' + SITE && method === 'GET')
      return Response.json({
        id: SITE,
        name: 'aisigym',
        sso_login: true,
        sso_login_context: 'non_production',
        build_settings: { stop_builds: true },
        published_deploy: { id: published, state: 'ready', context: 'production' },
      });
    if (path === '/api/v1/sites/' + SITE + '/deploys' && method === 'POST') {
      const request = JSON.parse(options.body);
      if (!live) assert.equal(request.draft, true, 'rehearsals must remain private drafts');
      assert.ok(!request.published && !request.production);
      if (failPost && failPost(request)) {
        failPost = null;
        return new Response(null, { status: 400 });
      }
      const id = (sequence++).toString(16).padStart(24, '0');
      const deployment = {
        id,
        site_id: SITE,
        title: request.title,
        context: request.draft ? 'deploy-preview' : 'production',
        draft: request.draft,
        required: [...new Set(Object.values(request.files))].filter((hash) => !contents.has(hash)),
      };
      posts.push({ id, ...request });
      manifests.set(id, request.files);
      deployments.set(id, deployment);
      if (!request.draft) {
        assert.equal(deployment.required.length, 0, 'verified candidate digests are already stored');
        published = id;
        if (disconnect) {
          disconnect = false;
          throw Error('Connection lost after publication');
        }
      }
      return Response.json(draft(deployment));
    }
    if (path === '/api/v1/sites/' + SITE + '/deploys' && method === 'GET')
      return Response.json([...deployments.values()].map(draft));
    const match = /^\/api\/v1\/deploys\/([a-f0-9]{24})(?:\/files(.*))?$/.exec(path);
    assert.ok(match, 'unexpected native mutation or request: ' + method + ' ' + path);
    const [, id, filename] = match,
      manifest = manifests.get(id);
    assert.ok(manifest, 'a deployment must exist before reading or uploading files');
    if (filename === undefined && method === 'GET') return Response.json(draft(deployments.get(id)));
    if (filename === '' && method === 'GET')
      return Response.json(
        Object.entries(manifest).map(([path, sha]) => ({
          path,
          sha,
          size: contents.get(sha)?.length,
          site_id: SITE,
          deploy_id: id,
        })),
      );
    assert.ok(filename && filename.startsWith('/'));
    if (method === 'PUT') {
      assert.notEqual(id, PUBLIC, 'the public deployment is immutable');
      const bytes = Buffer.from(options.body);
      assert.equal(sha(bytes), manifest[filename]);
      contents.set(sha(bytes), bytes);
      puts.push({ id, path: filename, sha1: sha(bytes), size: bytes.length });
      return Response.json({});
    }
    assert.equal(method, 'GET');
    reads.push({ id, path: filename });
    const bytes = contents.get(manifest[filename]);
    return new Response(bytes ?? null, { status: bytes ? 200 : 404 });
  });
  return {
    contents,
    manifests,
    posts,
    puts,
    reads,
    publicId: () => published,
    loseNextPublicResponse: () => {
      disconnect = true;
    },
    failNextPost(predicate) {
      failPost = predicate;
    },
  };
}
async function setup(
  t,
  { extraContent = {}, extraPages = {}, slugs = ['ours', 'other'], live = false } = {},
) {
  const db = memoryStore();
  const content = {
    '/index.html': '<h1>Public catalog</h1>',
    [OURS]: '<video src="resources/clip.mp4"></video>',
    [OTHER]: '<h1>Public other</h1>',
    [VIDEO_PATH]: VIDEO,
    ...(live && { '/manifest.json': '{}', '/deploy-receipt.json': '{}' }),
    ...extraContent,
  };
  const baseline = {
    deployment: { site_id: SITE, deploy_id: PUBLIC },
    ...(live && { production_manifest: { demos: [], domains: [] } }),
    demos: slugs.map((slug) => ({
      slug,
      title: slug,
      pages: [{ role: 'insight', path: '/demos/' + slug + '/index.html' }, ...(extraPages[slug] || [])],
    })),
    files: Object.entries(content).map(([path, bytes]) => row(path, bytes)),
  };
  await db.setJSON('production/baseline', baseline);
  const who = await access(db, { id: OWNER });
  const native = mockNative(t, content, live);
  const stage = async (slug, files) => {
    const current = await read(db, 'heads/' + slug);
    const metadata = files.map(([path, bytes]) => row(path, bytes));
    const sources = new Map(files.map(([, bytes]) => [sha(bytes), new Blob([bytes])]));
    const job = await makeJob(db, who, { slug, base: current?.id || PUBLIC, files: metadata, remove: [] });
    return runJob(db, 'test', job.id, sources);
  };
  return { db, baseline, who, native, stage };
}
function demoFiles(manifest, slug) {
  return Object.fromEntries(
    Object.entries(manifest).filter(([path]) => path.startsWith('/demos/' + slug + '/')),
  );
}
async function assertPublicUnchanged(db, baseline, native) {
  assert.deepEqual(await read(db, 'production/baseline'), baseline);
  assert.equal(native.manifests.get(PUBLIC)[OURS], baseline.files.find((file) => file.path === OURS).sha1);
  assert.ok(native.posts.every((post) => post.draft === true));
  assert.ok(native.puts.every((put) => put.id !== PUBLIC));
}

async function directText(env, slug, entries, remove = []) {
  const { db, who } = env;
  const state = await releaseState(db, who, slug);
  const job = await beginRelease(db, who, {
    mode: 'direct',
    slug,
    revision: state.revision,
    base: state.currentPreviewId,
    files: entries.map(([path, body]) => row(path, body)),
    remove,
  });
  return runRelease(db, 'test', job.id, new Map(entries.map(([, body]) => [sha(body), new Blob([body])])));
}

test('a new demo appears with all three private pages only after successful registration and keeps its identity across edits', async (t) => {
  const { db, baseline, native, who, stage } = await setup(t);
  baseline.production_manifest = { domains: [{ id: 'mathematics', name: 'Mathematics' }] };
  await db.setJSON('production/baseline', baseline);
  const slug = 'new-example',
    prefix = '/demos/' + slug + '/';
  const registration = { slug, title: 'New example', departmentId: 'mathematics' };
  const sources = ['index', 'workflow', 'dataset'].map((name) => [
    prefix + name + '.html',
    '<h1>' + name + '</h1>',
  ]);
  const blobs = new Map(sources.map(([, body]) => [sha(body), new Blob([body])]));
  const files = sources.map(([path, body]) => row(path, body));
  const body = { slug, registration, base: PUBLIC, files };
  const overview = () => deskCatalog(db, who, '', { overview: true });
  await assert.rejects(makeJob(db, { id: 'member', slugs: [slug] }, body), /Only the owner/);
  await assert.rejects(makeJob(db, who, { ...body, files: files.slice(0, 2) }), /Missing Dataset/);
  await assert.rejects(
    makeJob(db, who, { ...body, registration: { ...registration, departmentId: 'missing' } }),
    /category/,
  );
  const first = await makeJob(db, who, body),
    contender = await makeJob(db, who, body);
  assert(!Object.hasOwn((await overview()).catalog, slug));
  const [winner, loser] = await Promise.allSettled([
    runJob(db, 'test', first.id, blobs),
    runJob(db, 'test', contender.id, blobs),
  ]);
  const results = [winner, loser];
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const result = results.find((r) => r.status === 'fulfilled').value;
  assert.match(
    results.find((r) => r.status === 'rejected').reason.message,
    /first|already in use|newer preview/i,
  );
  const listing = await overview();
  assert.equal(listing.catalog[slug].published, false);
  assert.equal(listing.catalog[slug].productionVersion, null);
  assert.equal(listing.catalog[slug].departmentId, 'mathematics');
  assert.equal(listing.catalog.ours.published, true);
  for (const [role, name] of [
    ['insight', 'index'],
    ['workflow', 'workflow'],
    ['dataset', 'dataset'],
  ])
    assert.equal(
      listing.latest[slug].pages[role],
      'https://' + result.id + '--aisigym.netlify.app' + prefix + name + '.html',
    );
  assert.equal((await db.list({ prefix: 'versions/' + slug + '/' })).blobs.length, 1);
  await assert.rejects(makeJob(db, who, body), /already in use/);
  const edit = await stage(slug, [[prefix + 'index.html', '<h1>New finding</h1>']]);
  assert.equal((await overview()).catalog[slug].title, registration.title);
  assert.equal((await overview()).latest[slug].id, edit.id);
  assert.equal((await reviewedPreview(db, who, slug, result.id)).preview.pages.dataset, result.pages.dataset);
  const winningJob = result.job;
  const saved = await read(db, 'jobs/' + winningJob);
  await db.setJSON('jobs/' + winningJob, { ...saved, phase: 'processing', result: null });
  assert.equal((await runJob(db, 'test', winningJob)).id, result.id);
  const state = await releaseState(db, who, slug);
  const promotion = await beginRelease(db, who, {
    mode: 'promote',
    selection: { [slug]: edit.id },
    revision: state.revision,
  });
  const receipt = await runRelease(db, 'test', promotion.id);
  assert.equal(receipt.production.uploadedBytes, 0);
  for (const file of files) assert.ok(native.manifests.get(receipt.production.id)[file.path]);
  const rollback = await beginRelease(db, who, {
    mode: 'rollback-demo',
    slug,
    target: PUBLIC,
    revision: receipt.production.id,
  });
  const restored = await runRelease(db, 'test', rollback.id);
  assert(!Object.hasOwn(restored.production.demoPages, slug));
  assert.equal((await overview()).latest[slug].id, edit.id);
  await assertPublicUnchanged(db, baseline, native);
});

test('whole and individual private restores use exact retained files and preserve a later unrelated release', async (t) => {
  const env = await setup(t),
    { db, who, native, baseline } = env;
  const raw = native.manifests.get(PUBLIC);
  const satellite = await directText(env, 'ours', [
    [OURS, '<h1>Satellite revised</h1>'],
    [EXTRA, '{}'],
  ]);
  // Releases before the rollback feature have a receipt and frozen inputs but no dedicated snapshot.
  await db.delete(snapshotKey(satellite.id));
  const butterfly = await directText(env, 'other', [[OTHER, '<h1>Butterfly revised</h1>']]);
  const both = native.manifests.get(butterfly.production.id);
  const start = (mode, revision, target) => beginRelease(db, who, { mode, revision, target, slug: 'ours' });
  const initial = await releaseState(db, who, 'ours');
  assert.equal(initial.rollback.site[0].revision, satellite.production.id);
  assert.equal(initial.rollback.site.find((x) => x.baseline).changedFiles, 3);
  assert.deepEqual(
    initial.rollback.demo.map((x) => x.revision),
    [PUBLIC],
  );
  await assert.rejects(start('rollback-site', satellite.production.id, PUBLIC), /newer private release/);
  await assert.rejects(
    start('rollback-demo', initial.revision, butterfly.preview.id),
    /outside the retained/,
  );
  await assert.rejects(beginRelease(db, { id: 'member' }, { mode: 'rollback-site' }), /owner/);
  const sent = native.puts.length;
  const wholeJob = await start('rollback-site', initial.revision, PUBLIC);
  const full = await runRelease(db, 'test', wholeJob.id);
  assert.deepEqual(native.manifests.get(full.production.id), raw);
  assert.deepEqual(native.manifests.get(full.preview.id), raw);
  assert.deepEqual(full.rollback.affectedSlugs.sort(), ['other', 'ours']);
  assert.equal(full.rollback.changedFiles, 3);
  assert.equal(full.rollback.targetRevision, PUBLIC);
  const redo = await runRelease(
    db,
    'test',
    (await start('rollback-site', full.production.id, butterfly.production.id)).id,
  );
  assert.deepEqual(native.manifests.get(redo.production.id), both);
  const preDemo = await releaseState(db, who, 'ours');
  const singleJob = await start('rollback-demo', preDemo.revision, PUBLIC);
  let posts = 0;
  native.failNextPost(() => ++posts === 2);
  await assert.rejects(runRelease(db, 'test', singleJob.id), /HTTP 400/);
  assert.equal((await releaseState(db, who, 'ours')).revision, preDemo.revision);
  const checkedProduction = native.posts.at(-1).id;
  const single = await runRelease(db, 'test', singleJob.id);
  assert.equal(single.production.id, checkedProduction);
  const expected = { ...raw, [OTHER]: both[OTHER] };
  assert.deepEqual(native.manifests.get(single.production.id), expected);
  assert.deepEqual(native.manifests.get(single.preview.id), expected);
  const after = await releaseState(db, who, 'ours');
  assert.equal(after.previews.other.id, preDemo.previews.other.id);
  assert.equal(after.released.other.id, preDemo.released.other.id);
  assert.deepEqual(single.rollback.syncedSlugs, ['ours']);
  assert.deepEqual(single.rollback.preservedSlugs, ['other']);
  assert.equal(
    new URL(single.rollback.preservedPages.other.insight).hostname,
    single.production.id + '--aisigym.netlify.app',
  );
  assert.equal(single.rollback.changedFiles, 2);
  assert.deepEqual(await runRelease(db, 'test', singleJob.id), single);
  assert.equal(native.puts.length, sent, 'all retained file bodies were reused');
  await assertPublicUnchanged(db, baseline, native);
});

test('rolling back a release keeps a newer independent review Preview, including a rollback queued before that review', async (t) => {
  const env = await setup(t),
    { db, who, stage, native, baseline } = env;
  const initial = await directText(env, 'ours', [[OURS, '<h1>Released</h1>']]);
  const body = { mode: 'rollback-demo', revision: initial.production.id, target: PUBLIC, slug: 'ours' };
  const stale = await beginRelease(db, who, body);
  const pending = await stage('ours', [[OURS, '<h1>Under review</h1>']]);
  await assert.rejects(runRelease(db, 'test', stale.id), /pending Preview changed/);
  const restored = await runRelease(db, 'test', (await beginRelease(db, who, body)).id);
  assert.deepEqual(restored.rollback.syncedSlugs, []);
  assert.equal(restored.preview, null);
  assert.deepEqual(native.manifests.get(restored.production.id), native.manifests.get(PUBLIC));
  assert.equal((await releaseState(db, who, 'ours')).previews.ours.id, pending.id);
  await assertPublicUnchanged(db, baseline, native);
});

test('a demo rollback restores its external Dataset and a previously deleted resource', async (t) => {
  const external = '/datasets/ours-reference.html',
    retired = '/demos/ours/old.json';
  const env = await setup(t, {
    extraPages: { ours: [{ role: 'dataset', path: external }] },
    extraContent: { [external]: '<h1>Original dataset</h1>', [retired]: '{}' },
  });
  const { db, who, native } = env;
  await directText(env, 'ours', [[external, '<h1>Updated dataset</h1>']], [retired]);
  const later = await directText(env, 'other', [[OTHER, '<h1>Later release</h1>']]);
  const req = await beginRelease(db, who, {
    mode: 'rollback-demo',
    slug: 'ours',
    revision: later.production.id,
    target: PUBLIC,
  });
  const rolled = await runRelease(db, 'test', req.id);
  const expected = { ...native.manifests.get(PUBLIC), [OTHER]: sha('<h1>Later release</h1>') };
  assert.deepEqual(native.manifests.get(rolled.production.id), expected);
  assert.deepEqual(native.manifests.get(rolled.preview.id), expected);
  assert.equal(rolled.rollback.changedFiles, 2);
  assert.equal(new URL(rolled.production.pages.dataset).pathname, external);
});

test('fixed Preview promotion reuses tested MP4 hashes and excludes unrelated pending demos', async (t) => {
  const { db, baseline, who, native, stage } = await setup(t);
  assert.equal(VIDEO.subarray(4, 8).toString(), 'ftyp');
  const testedPage = '<h1>Tested</h1><video src="resources/clip.mp4"></video>';
  const tested = await stage('ours', [
    [OURS, testedPage],
    [VIDEO_PATH, VIDEO],
  ]);
  const pending = await stage('other', [[OTHER, '<h1>Other pending</h1>']]);
  const later = await stage('ours', [[OURS, '<h1>Newer untested Preview</h1>']]);
  assert.notEqual(tested.id, later.id);
  const fixed = await read(db, 'versions/ours/' + tested.id);
  assert.ok(fixed, 'ordinary Preview uploads persist an immutable selectable version');
  const state = await releaseState(db, who, 'ours', tested.id);
  assert.equal(state.revision, PUBLIC);
  const beforePuts = native.puts.length,
    beforePosts = native.posts.length;
  const job = await beginRelease(db, who, {
    mode: 'promote',
    revision: state.revision,
    selection: { ours: tested.id },
  });
  const result = await runRelease(db, 'test', job.id);
  assert.deepEqual(result.slugs, ['ours']);
  assert.equal(result.incomingBytes, 0);
  assert.equal(result.production.uploadedBytes, 0);
  assert.equal(result.preview.uploadedBytes, 0);
  assert.equal(result.preview.id, tested.id, 'promotion reuses its already-reviewed fixed Preview');
  assert.equal(native.posts.length, beforePosts + 1, 'promotion creates only a rehearsal Production draft');
  assert.equal(native.puts.length, beforePuts, 'promotion transfers no file bodies');
  const production = native.manifests.get(result.production.id),
    preview = native.manifests.get(result.preview.id);
  assert.equal(production[OURS], sha(testedPage));
  assert.equal(production[VIDEO_PATH], sha(VIDEO));
  assert.equal(production[OTHER], baseline.files.find((file) => file.path === OTHER).sha1);
  assert.deepEqual(demoFiles(preview, 'ours'), demoFiles(production, 'ours'));
  const afterState = await releaseState(db, who, 'ours');
  assert.equal(afterState.previews.other.id, pending.id);
  assert.equal(
    afterState.previews.ours.id,
    later.id,
    'releasing an older tested version preserves a newer pending Preview',
  );
  assert.equal((await read(db, 'heads/other')).id, pending.id);
  assert.equal((await read(db, 'heads/ours')).id, later.id);
  assert.equal(typeof result.production.files, 'number');
  assert.ok(result.production.pages.ours || result.production.pages.insight);
  await assertPublicUnchanged(db, baseline, native);
});

test('one release uses each checked demo’s pinned Preview and reports both sources and all result routes', async (t) => {
  const dataset = '/datasets/ours-data.html',
    third = '/demos/third/index.html';
  const env = await setup(t, {
    slugs: ['ours', 'other', 'third'],
    extraPages: { ours: [{ role: 'dataset', path: dataset }] },
    extraContent: {
      [dataset]: '<h1>Public data</h1>',
      [third]: '<h1>Third</h1>',
      '/demos/ours/workflow.html': 'First workflow',
      '/demos/other/workflow.html': 'Second workflow',
      '/demos/other/dataset.html': 'Second dataset',
    },
  });
  const { db, who, stage, native, baseline } = env;
  const first = await stage('ours', [
    [OURS, '<h1>First review</h1>'],
    [dataset, '<h1>Reviewed data</h1>'],
  ]);
  const second = await stage('other', [[OTHER, '<h1>Second review</h1>']]);
  const privateOnly = await directText(env, 'ours', [[OURS, '<h1>Synced rehearsal</h1>']]);
  const thirdVersion = await directText(env, 'third', [[third, '<h1>Previously released third demo</h1>']]);
  const state = await releaseState(db, who, 'ours');
  assert.equal(state.reviewPreviews.ours.id, first.id);
  assert.equal(state.previews.ours.id, privateOnly.preview.id);
  const lookup = await reviewedPreview(db, who, 'ours', first.pages.dataset);
  assert.equal(lookup.preview.id, first.id);
  assert.equal(lookup.preview.pages.dataset, first.pages.dataset);
  assert.equal(lookup.preview.overlay, undefined);
  await assert.rejects(reviewedPreview(db, { id: 'member', owner: false }, 'ours', first.id), {
    status: 403,
  });
  await assert.rejects(reviewedPreview(db, who, 'other', first.pages.dataset), /does not belong/);
  const selection = { other: second.id, ours: first.id };
  const job = await beginRelease(db, who, { mode: 'promote', revision: state.revision, selection });
  // The pending desk may advance between picking the two reviews and materializing the release.
  const latest = await stage('ours', [[OURS, '<h1>Next review</h1>']]);
  const beforePosts = native.posts.length,
    beforePuts = native.puts.length;
  const result = await runRelease(db, 'test', job.id);
  assert.deepEqual(await runRelease(db, 'test', job.id), result);
  assert.equal(native.posts.length, beforePosts + 1);
  assert.equal(native.puts.length, beforePuts);
  assert.equal(result.preview, null);
  assert.equal(result.channel, 'browser');
  assert.deepEqual(result.slugs, Object.keys(selection));
  assert.deepEqual(result.sourceVersions, selection);
  for (const [slug, src] of [
    ['ours', first],
    ['other', second],
  ]) {
    assert.equal(result.sourcePreviews[slug].id, src.id);
    assert.deepEqual(result.sourcePreviews[slug].pages, src.pages);
    for (const role of ['insight', 'workflow', 'dataset']) {
      const url = new URL(result.production.demoPages[slug][role]);
      assert.equal(url.hostname, result.production.id + '--aisigym.netlify.app');
      assert.equal(url.pathname, new URL(src.pages[role]).pathname);
    }
  }
  assert.equal(result.incomingBytes, 0);
  assert.equal(result.production.uploadedBytes, 0);
  assert.deepEqual(result.fileChanges, { added: 0, replaced: 3, removed: 0 });
  const published = native.manifests.get(result.production.id);
  assert.deepEqual(published, {
    ...native.manifests.get(thirdVersion.production.id),
    [OURS]: sha('<h1>First review</h1>'),
    [OTHER]: sha('<h1>Second review</h1>'),
    [dataset]: sha('<h1>Reviewed data</h1>'),
  });
  const after = await releaseState(db, who, 'other');
  assert.equal(after.reviewPreviews.ours.id, latest.id);
  assert.equal(after.reviewPreviews.other.id, second.id);
  assert.equal(after.released.third.id, thirdVersion.production.id);
  assert.equal(after.released.ours.id, result.production.id);
  assert.equal(after.released.other.id, result.production.id);
  assert.deepEqual(
    after.receipts.map((r) => r.id),
    [result.id, ...state.receipts.map((r) => r.id)],
  );
  await assertPublicUnchanged(db, baseline, native);
});

test('a private receipt link still resolves after newer operations scroll off the recent list', async (t) => {
  const { db, who } = await setup(t);
  const operations = Array.from({ length: 14 }, (_, i) => 'retained-' + i);
  const root = 'private-releases/v1/';
  await db.setJSON(root + 'state', {
    publicId: PUBLIC,
    revision: PUBLIC,
    released: {},
    synced: {},
    operations,
  });
  for (const id of operations) {
    await db.setJSON(root + 'receipts/' + id, { id });
    await db.setJSON(snapshotKey(id), { revision: PUBLIC, released: {} });
  }
  await db.setJSON(root + 'receipts/uncommitted', { id: 'uncommitted' });
  const list = async (id) => (await releaseState(db, who, 'ours', null, id)).receipts.map((r) => r.id);
  const recent = operations.slice(-12).reverse();
  assert.deepEqual(await list(), recent);
  assert.deepEqual(await list(operations[0]), [...recent, operations[0]]);
  assert.deepEqual(await list('uncommitted'), recent);
});

test('an invalid version or conflicting shared file cannot release half of a checked selection', async (t) => {
  const { db, who, stage, native, baseline } = await setup(t);
  const first = await stage('ours', [[OURS, '<h1>First</h1>']]);
  const second = await stage('other', [[OTHER, '<h1>Second</h1>']]);
  const start = (selection) => beginRelease(db, who, { mode: 'promote', revision: PUBLIC, selection });
  const jobsBefore = await db.list({ prefix: 'jobs/' });
  await assert.rejects(start({ ours: first.id, other: first.id }), /no registered Preview/);
  await assert.rejects(start([]), /registered demos/);
  assert.deepEqual(await db.list({ prefix: 'jobs/' }), jobsBefore);
  // Imported reviews can both include the same shared path outside their own directories.
  const path = '/assets/review-legend.json';
  for (const [slug, value] of [
    ['ours', '1'],
    ['other', '2'],
  ]) {
    const head = await read(db, 'heads/' + slug);
    head.overlay[path] = { sha1: sha(value), size: 1 };
    await db.setJSON('heads/' + slug, head);
  }
  const beforePosts = native.posts.length;
  const job = await start({ ours: first.id, other: second.id });
  await assert.rejects(runRelease(db, 'test', job.id), /conflict.*review-legend/);
  assert.equal(native.posts.length, beforePosts);
  assert.equal((await releaseState(db, who, 'ours')).revision, PUBLIC);
  await assertPublicUnchanged(db, baseline, native);
});

test('direct Production upload sends changed MP4 once, then syncs only that demo to Preview', async (t) => {
  const { db, baseline, who, native, stage } = await setup(t);
  const previous = await stage('ours', [
    [OURS, '<h1>Preview-only page</h1>'],
    [EXTRA, '{"private":true}'],
  ]);
  const pending = await stage('other', [[OTHER, '<h1>Unrelated pending</h1>']]);
  const state = await releaseState(db, who, 'ours');
  // A harmless MP4 free box changes the real video bytes without damaging playback.
  const changedVideo = Buffer.concat([
    VIDEO,
    Buffer.from([0, 0, 0, 12]),
    Buffer.from('free'),
    Buffer.from('test'),
  ]);
  const incoming = row(VIDEO_PATH, changedVideo);
  const job = await beginRelease(db, who, {
    mode: 'direct',
    revision: state.revision,
    slug: 'ours',
    base: previous.id,
    files: [incoming],
    remove: [],
  });
  await db.set(partKey(job, incoming.sha1, 0), changedVideo);
  const before = native.puts.length;
  const result = await runRelease(db, 'test', job.id);
  assert.deepEqual(result.slugs, ['ours']);
  assert.equal(result.incomingBytes, changedVideo.length);
  assert.equal(result.production.uploadedBytes, changedVideo.length);
  assert.equal(result.preview.uploadedBytes, 0);
  assert.deepEqual(
    native.puts.slice(before).map((put) => [put.path, put.sha1, put.size]),
    [[VIDEO_PATH, incoming.sha1, changedVideo.length]],
  );
  const production = native.manifests.get(result.production.id),
    preview = native.manifests.get(result.preview.id);
  assert.equal(production[VIDEO_PATH], incoming.sha1);
  assert.equal(production[OURS], baseline.files.find((file) => file.path === OURS).sha1);
  assert.equal(production[EXTRA], undefined);
  assert.equal(preview[EXTRA], undefined, 'synchronization resets Preview-only extras for the selected demo');
  assert.deepEqual(demoFiles(preview, 'ours'), demoFiles(production, 'ours'));
  assert.equal(preview[OTHER], sha('<h1>Unrelated pending</h1>'));
  assert.equal((await read(db, 'heads/other')).id, pending.id);
  const again = await runRelease(db, 'test', job.id);
  assert.equal(again.production.id, result.production.id);
  assert.equal(native.puts.length, before + 1, 'retrying a ready release is idempotent');
  await assertPublicUnchanged(db, baseline, native);
});

test('private release requires owner and exact current rehearsal Production revision', async (t) => {
  const { db, baseline, who, native } = await setup(t);
  const contributor = { id: 'member', owner: false, slugs: ['ours'] };
  const body = {
    mode: 'direct',
    revision: PUBLIC,
    slug: 'ours',
    base: PUBLIC,
    files: [row(VIDEO_PATH, VIDEO)],
    remove: [],
  };
  await assert.rejects(beginRelease(db, contributor, body), (error) => error.status === 403);
  await assert.rejects(releaseState(db, contributor, 'ours'), (error) => error.status === 403);
  await assert.rejects(
    beginRelease(db, who, { ...body, revision: 'stale' }),
    (error) => error.status === 409,
  );
  assert.equal(native.posts.length, 0);
  await assertPublicUnchanged(db, baseline, native);
});

test('retry after direct Preview synchronization failure reuses the completed rehearsal Production draft', async (t) => {
  const { db, baseline, who, native, stage } = await setup(t);
  const tested = await stage('ours', [[OURS, '<h1>Pending Preview before direct upload</h1>']]);
  const originalHead = await read(db, 'heads/ours');
  const state = await releaseState(db, who, 'ours');
  const changedVideo = Buffer.concat([
    VIDEO,
    Buffer.from([0, 0, 0, 12]),
    Buffer.from('free'),
    Buffer.from('next'),
  ]);
  const incoming = row(VIDEO_PATH, changedVideo);
  const job = await beginRelease(db, who, {
    mode: 'direct',
    revision: state.revision,
    slug: 'ours',
    base: tested.id,
    files: [incoming],
    remove: [],
  });
  await db.set(partKey(job, incoming.sha1, 0), changedVideo);
  const before = native.posts.length,
    beforePuts = native.puts.length;
  let attempts = 0;
  native.failNextPost(() => ++attempts === 2);
  await assert.rejects(runRelease(db, 'test', job.id), /HTTP 400/);
  assert.equal(
    native.posts.length,
    before + 1,
    'the rehearsal Production draft completed before sync failed',
  );
  const completedProduction = native.posts.at(-1).id;
  assert.deepEqual(
    await read(db, 'heads/ours'),
    originalHead,
    'failed sync must not overwrite the current Preview',
  );
  await assertPublicUnchanged(db, baseline, native);
  const result = await runRelease(db, 'test', job.id);
  assert.equal(result.production.id, completedProduction, 'retry must reuse the completed first stage');
  assert.equal(native.posts.length, before + 2, 'retry creates only the missing Preview draft');
  assert.equal(
    native.puts.length,
    beforePuts + 1,
    'retry reuses the video digest already uploaded to the first draft',
  );
  assert.deepEqual(
    demoFiles(native.manifests.get(result.production.id), 'ours'),
    demoFiles(native.manifests.get(result.preview.id), 'ours'),
  );
  await assertPublicUnchanged(db, baseline, native);
});

test('handoff only registers the existing deploy; subsequent owner publications, sync, and restores use the live revision', async (t) => {
  const { db, who, native, stage } = await setup(t, { live: true });
  await assert.rejects(connectProduction(db, 'test', who, 'different'));
  await assert.rejects(releaseState(db, who, 'ours', null, null, 'production'));
  const original = await connectProduction(db, 'test', who, PUBLIC);
  assert.deepEqual(await connectProduction(db, 'test', who, PUBLIC), original);
  assert.equal(original.files, 6);
  assert.equal(native.posts.length, 0);
  const live = () => releaseState(db, who, 'ours', null, null, 'production');
  assert.deepEqual((await live()).receipts, []);
  const ours = await stage('ours', [[OURS, '<h1>Reviewed one</h1>']]);
  const other = await stage('other', [[OTHER, '<h1>Reviewed two</h1>']]);
  const selected = { mode: 'promote', revision: PUBLIC, selection: { ours: ours.id, other: other.id } };
  await assert.rejects(beginRelease(db, who, selected, 'production'), /destination/);
  const begin = (body) => beginRelease(db, who, { ...body, destination: ORIGIN }, 'production');
  const promote = await begin(selected);
  native.loseNextPublicResponse();
  await assert.rejects(runRelease(db, 'test', promote.id), /Connection lost/);
  assert.equal((await read(db, PUBLIC_STATE)).pending, promote.id);
  await assert.rejects(begin(selected), /pending/);
  const batch = await runRelease(db, 'test', promote.id);
  assert.equal(batch.production.id, native.publicId());
  assert.equal(
    native.posts.filter((p) => !p.draft).length,
    1,
    'lost response resumes the existing deployment',
  );
  assert.deepEqual(batch.sourceVersions, selected.selection);
  assert.equal(batch.production.pages.insight, ORIGIN + OURS);
  const first = native.manifests.get(batch.production.id);
  assert.deepEqual([first[OURS], first[OTHER]], [sha('<h1>Reviewed one</h1>'), sha('<h1>Reviewed two</h1>')]);
  await assert.rejects(begin(selected), /newer Production/);
  const newerVideo = Buffer.concat([VIDEO, Buffer.from('new video')]);
  const update = await begin({
    mode: 'direct',
    slug: 'ours',
    revision: batch.production.id,
    base: ours.id,
    files: [row(VIDEO_PATH, newerVideo)],
  });
  const direct = await runRelease(
    db,
    'test',
    update.id,
    new Map([[sha(newerVideo), new Blob([newerVideo])]]),
  );
  assert.equal(native.puts.filter((p) => p.sha1 === sha(newerVideo)).length, 1);
  assert.equal((await deskCatalog(db, who, null, { overview: true })).latest.ours.id, direct.preview.id);
  const edit = await makeJob(db, who, {
    slug: 'ours',
    base: direct.preview.id,
    files: [row(OURS, '<p>Next review</p>')],
  });
  const pending = await runJob(
    db,
    'test',
    edit.id,
    new Map([[sha('<p>Next review</p>'), new Blob(['<p>Next review</p>'])]]),
  );
  const undo = await begin({
    mode: 'rollback-demo',
    slug: 'ours',
    revision: direct.production.id,
    target: PUBLIC,
  });
  const restored = await runRelease(db, 'test', undo.id);
  assert.equal(native.manifests.get(restored.production.id)[OTHER], first[OTHER]);
  assert.equal(native.manifests.get(restored.production.id)[OURS], native.manifests.get(PUBLIC)[OURS]);
  assert.equal((await live()).previews.ours.id, pending.id);
  const all = await begin({
    mode: 'rollback-site',
    slug: 'ours',
    revision: restored.production.id,
    target: PUBLIC,
  });
  const originalSite = await runRelease(db, 'test', all.id);
  assert.deepEqual(native.manifests.get(originalSite.production.id), native.manifests.get(PUBLIC));
  assert.equal((await live()).receipts.length, 4);
  assert.deepEqual((await releaseState(db, who, 'ours')).receipts, []);
});
