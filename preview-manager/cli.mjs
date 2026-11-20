import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { catalogFromBaseline, importPackage, newDemoDescriptor, planChanges } from './shared/package.mjs';
import { SITE, OWNER, availableNewDemo, contextFor, makeJob, read, storeFor } from './server/store.mjs';
import { api, protectedSite, runJob } from './server/native.mjs';
import { connectProduction } from './server/production.mjs';
import { adoptPreview } from './server/adopt.mjs';
import { beginRelease, releaseState, runRelease } from './server/releases.mjs';
async function entries(input) {
  const full = path.resolve(input),
    info = await fs.lstat(full);
  if (info.isFile()) return [{ path: path.basename(full), blob: new Blob([await fs.readFile(full)]) }];
  if (!info.isDirectory()) throw Error('Expected a directory or regular file');
  const out = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const name = path.join(dir, e.name);
      if (e.name === '.DS_Store' || e.name === '__MACOSX') continue;
      if (e.isDirectory()) await walk(name);
      else if (e.isFile())
        out.push({
          path: path.relative(full, name).split(path.sep).join('/'),
          blob: new Blob([await fs.readFile(name)]),
        });
      else throw Error('Unsupported file ' + e.name);
    }
  }
  await walk(full);
  return out;
}
const [command, ...args] = process.argv.slice(2);
async function main() {
  let token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token && process.env.NETLIFY_CLI_HELPER) {
    const { getToken } = await import(pathToFileURL(process.env.NETLIFY_CLI_HELPER));
    [token] = await getToken();
  }
  if (!token) throw Error('Sign into Netlify and specify NETLIFY_CLI_HELPER, or provide NETLIFY_AUTH_TOKEN.');
  const db = storeFor(token),
    who = await api(token, '/user');
  if (who.id !== OWNER) throw Error('The CLI is reserved for the configured Preview administrator.');
  const owner = { id: OWNER, owner: true };
  if (command === 'connect-production') {
    if (args.length !== 1) throw Error('Use connect-production <active-deployment-id>.');
    console.log(JSON.stringify(await connectProduction(db, token, owner, args[0])));
    return;
  }
  if (
    [
      'private-releases',
      'promote-private',
      'release-private',
      'rollback-site-private',
      'rollback-demo-private',
    ].includes(command)
  ) {
    const wholeSite = command === 'rollback-site-private';
    const slug = wholeSite ? undefined : args[0],
      input = wholeSite ? args[0] : args[1];
    const state = await releaseState(db, owner, slug);
    if (command === 'private-releases') {
      console.log(
        JSON.stringify({
          publicBaseline: state.production,
          privateRevision: state.revision,
          rollback: state.rollback,
          receipts: state.receipts,
        }),
      );
      return;
    }
    let body,
      sources = new Map();
    if (wholeSite || command === 'rollback-demo-private') {
      if (args.length !== (wholeSite ? 1 : 2))
        throw Error(
          'Use rollback-site-private <retained-release-id> or rollback-demo-private <demo-slug> <retained-release-id>.',
        );
      body = {
        mode: wholeSite ? 'rollback-site' : 'rollback-demo',
        slug: state.selected,
        revision: state.revision,
        target: input,
      };
    } else if (command === 'promote-private') {
      if (args.length !== 2) throw Error('Use promote-private <demo-slug> <fixed-reviewed-URL-or-ID>.');
      body = { mode: 'promote', revision: state.revision, selection: { [slug]: input } };
    } else {
      if (args.length !== 2) throw Error('Use release-private <demo-slug> <html-folder-or-zip>.');
      const pkg = await importPackage(await entries(input), state.catalog[slug], state.files);
      body = {
        mode: 'direct',
        revision: state.revision,
        slug,
        base: state.previews[slug]?.id || state.production,
        files: pkg.files,
        remove: pkg.remove,
      };
      sources = new Map(pkg.files.map((f) => [f.sha1, f.blob]));
    }
    const job = await beginRelease(db, owner, body);
    await db.setJSON('jobs/' + job.id, { ...job, channel: 'cli' });
    console.log('Private release operation ' + job.id);
    console.log(JSON.stringify(await runRelease(db, token, job.id, sources)));
    return;
  }
  if (command === 'adopt-preview') {
    if (args.length !== 1 && !(args.length === 2 && args[1] === '--apply'))
      throw Error('Use adopt-preview <fixed-develop-deploy-id> [--apply].');
    const { status, record } = await adoptPreview(db, token, args[0], args[1] === '--apply');
    const imported = Object.values(record.heads);
    console.log(
      JSON.stringify({
        status,
        source: record.sourceDeploy,
        production: record.production,
        sourceFiles: record.sourceFiles,
        imported: imported.length,
        previewPages: imported.length * 3,
        kept: record.retained,
        changes: imported
          .filter((head) => !head.carriedReviewVersion)
          .map((head) => ({
            slug: head.slug,
            changedOrAdded: Object.keys(head.overlay).length,
            removed: head.removed.length,
          })),
      }),
    );
    return;
  }
  if (command === 'seed') {
    const base = JSON.parse(await fs.readFile(args[0], 'utf8')),
      site = await protectedSite(token);
    if (base.deployment.deploy_id !== site.published_deploy.id || base.deployment.site_id !== SITE)
      throw Error('Baseline is not current Production.');
    const files = await api(token, '/deploys/' + base.deployment.deploy_id + '/files');
    if (
      files.length !== base.files.length ||
      !files.every(
        (f) =>
          f.site_id === SITE &&
          f.deploy_id === base.deployment.deploy_id &&
          base.files.some((b) => b.path === f.path && b.sha1 === f.sha && b.size_bytes === f.size),
      )
    )
      throw Error('Baseline content differs.');
    const catalog = catalogFromBaseline(base),
      old = await read(db, 'production/baseline');
    if (old && old.deployment.deploy_id !== base.deployment.deploy_id)
      throw Error('Existing baseline has a different version.');
    await db.setJSON('production/baseline', base, { onlyIfNew: true });
    console.log(
      'Verified ' +
        Object.keys(catalog).length +
        ' demos, ' +
        files.length +
        ' files, Production ' +
        site.published_deploy.id,
    );
    return;
  }
  if (command === 'worker') {
    const watch = args.includes('--watch');
    do {
      const keys = (await db.list({ prefix: 'jobs/' })).blobs;
      const jobs = await Promise.all(keys.map((k) => read(db, k.key)));
      for (const j of jobs.filter((j) => j?.phase === 'queued')) {
        try {
          const v = await (j.releaseMode ? runRelease : runJob)(db, token, j.id);
          console.log(
            JSON.stringify({
              id: v.id,
              slug: v.slug,
              url: v.url,
              incoming: v.incomingBytes,
              uploaded: v.uploadedBytes,
            }),
          );
        } catch (e) {
          console.error('Job ' + j.id + ' ' + e.message);
        }
      }
      if (watch) await sleep(4000);
    } while (watch);
    return;
  }
  if (command === 'retry') {
    const j = await read(db, 'jobs/' + args[0]);
    if (!j) throw Error('Unknown job.');
    let sources = new Map();
    if (args[1]) {
      const { catalog, files } = j.releaseMode
        ? await releaseState(db, owner, j.slug, undefined, undefined, j.target)
        : await contextFor(db);
      const demo = j.registration ? newDemoDescriptor(j.registration) : catalog[j.slug];
      const pkg = await importPackage(await entries(args[1]), demo, files, { registration: j.registration });
      sources = new Map(pkg.files.map((f) => [f.sha1, f.blob]));
    }
    const v = await (j.releaseMode ? runRelease : runJob)(db, token, j.id, sources);
    if (j.releaseMode) {
      console.log(JSON.stringify(v));
      return;
    }
    console.log(
      JSON.stringify({ id: v.id, url: v.url, uploaded: v.uploadedBytes, verified: v.verifiedFiles }),
    );
    return;
  }
  if (command === 'report') {
    const { base, heads } = await contextFor(db);
    console.log(
      JSON.stringify({
        production: base.deployment.deploy_id,
        heads: Object.values(heads).map((h) => ({
          slug: h.slug,
          id: h.id,
          url: h.url,
          verified: h.verifiedFiles,
          incoming: h.incomingBytes,
          uploaded: h.uploadedBytes,
        })),
      }),
    );
    return;
  }
  if (!['submit', 'inspect', 'create-preview'].includes(command))
    throw Error(
      'Use seed, adopt-preview, inspect, submit, create-preview, worker, retry, report, private-releases, promote-private, release-private, rollback-site-private or rollback-demo-private.',
    );
  const creating = command === 'create-preview';
  if (creating && args.length !== 4)
    throw Error('Use create-preview <slug> <category-id> <demo-name> <zip-or-folder>.');
  const [slug] = args,
    input = creating ? args[3] : args[1];
  const registration = creating ? { slug, departmentId: args[1], title: args[2] } : undefined;
  const ctx = await contextFor(db),
    { base, catalog, heads, files } = ctx;
  const demo = creating ? availableNewDemo(registration, ctx) : catalog[slug];
  if (!demo) throw Error('Unknown demo ' + slug);
  const pkg = await importPackage(await entries(input), demo, files, { registration });
  const diff = planChanges(files, pkg.files, pkg.remove);
  const counts = Object.fromEntries(
    ['added', 'replaced', 'removed', 'reused'].map((k) => [k, diff.filter((f) => f.kind === k).length]),
  );
  console.log(
    JSON.stringify({
      slug,
      base: heads[slug]?.id || base.deployment.deploy_id,
      counts,
      bytes: pkg.files.reduce((n, f) => n + f.size, 0),
    }),
  );
  if (command === 'inspect') return;
  const job = await makeJob(
    db,
    { id: OWNER, owner: true },
    { slug, base: heads[slug]?.id || base.deployment.deploy_id, ...pkg },
  );
  await db.setJSON('jobs/' + job.id, { ...job, channel: 'cli' });
  console.log('Working on private job ' + job.id);
  const result = await runJob(db, token, job.id, new Map(pkg.files.map((f) => [f.sha1, f.blob])));
  console.log(
    JSON.stringify({
      url: result.url,
      pages: result.pages,
      id: result.id,
      uploaded: result.uploadedBytes,
      verified: result.verifiedFiles,
    }),
  );
}
try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
