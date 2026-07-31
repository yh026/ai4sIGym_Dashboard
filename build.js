#!/usr/bin/env node
/**
 * AI4S dashboard build.
 * Fetches the registry (Apps Script web app) and generates a static site:
 *   dist/index.html            the dashboard
 *   dist/demos/<slug>/index.html   each Live demo, with nav + provenance panel injected
 *   dist/manifest.json         public metadata (no file ids)
 *
 * Env:  REGISTRY_URL   the Apps Script /exec URL including ?token=...
 *       (from the sheet: AI4S dashboard → Show build URL for Netlify)
 * Local preview without the endpoint:  node build.js --mock   (uses fixtures/)
 */

const fs = require('fs');
const path = require('path');

const MOCK = process.argv.includes('--mock');
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const SITE = path.join(ROOT, 'site');

const CATEGORY_PALETTE = ['#1D9E75', '#D85A30', '#534AB7', '#B8860B', '#2F6DB4', '#A23B72', '#5F7A61', '#8A5A44'];
const NEW_WINDOW_DAYS = 14;

function fail(msg) { console.error('\nBUILD FAILED: ' + msg + '\n'); process.exit(1); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slugSafe(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'demo';
}

// ------------------------------------------------------------ registry I/O

async function getJson(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from registry');
  return r.json();
}

async function loadRegistry() {
  if (MOCK) {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'));
    return {
      site: man.site,
      demos: man.demos,
      getHtml: async (id) => fs.readFileSync(path.join(ROOT, 'fixtures', id + '.html'), 'utf8'),
    };
  }
  const base = process.env.REGISTRY_URL;
  if (!base) fail('REGISTRY_URL is not set. In Netlify: Site configuration → Environment variables. '
    + 'Get the value from the sheet: AI4S dashboard → Show build URL for Netlify.');
  const manUrl = new URL(base); manUrl.searchParams.set('action', 'manifest');
  const man = await getJson(manUrl.toString());
  if (!man.ok) fail('Registry error: ' + (man.error || 'unknown') +
    (man.error === 'bad token' ? ' — REGISTRY_URL must include the ?token=... part.' : ''));
  return {
    site: man.site,
    demos: man.demos,
    getHtml: async (id) => {
      const u = new URL(base);
      u.searchParams.set('action', 'file'); u.searchParams.set('id', id);
      const res = await getJson(u.toString());
      if (!res.ok) throw new Error(res.error || 'file fetch failed');
      return res.html;
    },
  };
}

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

async function withRetry(fn) {
  try { return await fn(); }
  catch (e) { await new Promise(r => setTimeout(r, 1500)); return fn(); }
}

// ------------------------------------------------- injected demo-page extras

function provenanceRows(d) {
  const rows = [];
  const add = (label, html) => { if (html) rows.push([label, html]); };
  add('Data', d.data_link
    ? `<a href="${esc(d.data_link)}" target="_blank" rel="noopener">${esc(d.data_source || d.data_link)}</a>`
    : esc(d.data_source));
  add('License', esc(d.data_license));
  add('Accessed', esc(d.data_accessed && d.data_accessed.length >= 10 && d.data_accessed.includes('T')
    ? d.data_accessed.slice(0, 10) : d.data_accessed));
  add('Data notes', esc(d.data_notes));
  add('Task', esc(d.task_type));
  add('Method', esc(d.method));
  add('Framework', esc(d.framework));
  add('Training', esc(d.training));
  add('Metrics', esc(d.metrics));
  add('Workflow', d.workflow_link
    ? `<a href="${esc(d.workflow_link)}" target="_blank" rel="noopener">Open the workflow behind this demo →</a>` : '');
  add('Author', esc(d.author));
  return rows;
}

function injectionSnippet(d) {
  const rows = provenanceRows(d);
  const goal = d.learning_goal
    ? `<p style="margin:0 0 10px;font-style:italic;color:#5C554C">${esc(d.learning_goal)}</p>` : '';
  const dl = rows.map(([k, v]) =>
    `<div style="display:flex;gap:10px;margin:6px 0"><span style="flex:0 0 84px;color:#8A8378;font-size:12px;text-transform:uppercase;letter-spacing:.04em">${k}</span><span style="flex:1;min-width:0;overflow-wrap:anywhere">${v}</span></div>`).join('');
  const hasPanel = rows.length > 0 || d.learning_goal;

  const panel = hasPanel ? `
<button id="ai4s-info-btn" aria-expanded="false" aria-controls="ai4s-info" style="position:fixed;right:16px;bottom:16px;z-index:2147483000;font:500 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:999px;border:1px solid #26211C;background:#FAF7F0;color:#26211C;cursor:pointer">Data &amp; methods</button>
<div id="ai4s-info" hidden style="position:fixed;right:16px;bottom:60px;z-index:2147483000;width:min(360px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:#FFFFFF;color:#26211C;border:1px solid #E4DDD0;border-radius:12px;padding:16px;font:14px/1.55 system-ui,sans-serif;box-shadow:0 8px 28px rgba(38,33,28,.14)">
<div style="font-weight:600;margin:0 0 8px">${esc(d.title)}</div>${goal}${dl}
</div>
<script>(function(){var b=document.getElementById('ai4s-info-btn'),p=document.getElementById('ai4s-info');function set(o){p.hidden=!o;b.setAttribute('aria-expanded',String(o));}b.addEventListener('click',function(){set(p.hidden);});document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false);});})();</script>` : '';

  return `
<!-- injected by AI4S dashboard build -->
<a id="ai4s-back" href="../../index.html" style="position:fixed;left:16px;bottom:16px;z-index:2147483000;font:500 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:999px;border:1px solid #26211C;background:#26211C;color:#FAF7F0;text-decoration:none">&#8592; All demos</a>${panel}
`;
}

function injectIntoDemo(html, d) {
  const snippet = injectionSnippet(d);
  const i = html.toLowerCase().lastIndexOf('</body>');
  if (i === -1) return html + snippet;
  return html.slice(0, i) + snippet + html.slice(i);
}

// -------------------------------------------------------------- dashboard

function badgeHtml(d, isNew) {
  const b = [];
  if (d.featured) b.push('<span class="badge star" title="Featured">&#9733;</span>');
  if (isNew) b.push('<span class="badge new">new</span>');
  if (d.provenance) b.push('<span class="badge prov" title="Data & method provenance recorded">&#10003; provenance</span>');
  return b.join('');
}

function cardHtml(d, catColor, isNew) {
  const meta = [d.task_type, d.framework].filter(Boolean).join(' &middot; ');
  const search = esc([d.title, d.description, d.category, d.task_type, d.method,
    d.framework, (d.tags || []).join(' ')].join(' ').toLowerCase());
  return `<a class="card" href="demos/${esc(d.slug)}/index.html" data-search="${search}" data-category="${esc(d.category)}" data-task="${esc(d.task_type)}">
  <div class="card-top"><span class="cat"><i style="background:${catColor}"></i>${esc(d.category || 'Uncategorised')}</span><span class="badges">${badgeHtml(d, isNew)}</span></div>
  <h2>${esc(d.title)}</h2>
  <p>${esc(d.description)}</p>
  ${meta ? `<div class="meta">${meta}</div>` : ''}
</a>`;
}

function chipHtml(group, value) {
  return `<button class="chip" data-group="${group}" data-value="${esc(value)}">${esc(value)}</button>`;
}

// ------------------------------------------------------------------ main

(async function main() {
  console.log(MOCK ? 'Build (mock fixtures)…' : 'Build (live registry)…');
  const reg = await loadRegistry();
  let demos = reg.demos || [];

  const missing = demos.filter(d => d.file_check === 'missing');
  missing.forEach(d => console.warn('  skipping (file missing in Drive): ' + d.title));
  demos = demos.filter(d => d.file_check !== 'missing');
  if (!demos.length) {
    console.warn('  No Live demos in the registry — the site will show an empty state.');
  }

  // Slugs: sanitise + de-duplicate defensively.
  const used = {};
  demos.forEach(d => {
    let s = slugSafe(d.slug || d.title);
    if (used[s]) { let n = 2; while (used[s + '-' + n]) n++; s = s + '-' + n; }
    used[s] = true; d.slug = s;
  });

  // Fetch content.
  const pages = await inChunks(demos, 3, async d => {
    const html = await withRetry(() => reg.getHtml(d.file_id));
    return { d, html };
  });

  // Write output.
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const { d, html } of pages) {
    const dir = path.join(DIST, 'demos', d.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), injectIntoDemo(html, d));
    console.log('  demo: /demos/' + d.slug + '/');
  }

  // Dashboard.
  const now = Date.now();
  const isNew = d => d.date_added && (now - Date.parse(d.date_added)) < NEW_WINDOW_DAYS * 864e5;
  demos.sort((a, b) => (b.featured - a.featured) ||
    ((Date.parse(b.date_added) || 0) - (Date.parse(a.date_added) || 0)));

  const cats = [...(reg.site.categories || [])].filter(c => demos.some(d => d.category === c));
  demos.forEach(d => { if (d.category && !cats.includes(d.category)) cats.push(d.category); });
  const catColor = {}; cats.forEach((c, i) => catColor[c] = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]);
  const tasks = [...new Set(demos.map(d => d.task_type).filter(Boolean))].sort();

  const built = new Date().toISOString().slice(0, 10);
  const nTasks = tasks.length;
  const countLine = `${demos.length} demo${demos.length === 1 ? '' : 's'}`
    + (nTasks ? ` &middot; ${nTasks} task type${nTasks === 1 ? '' : 's'}` : '')
    + ` &middot; growing`;

  const template = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
  const page = template
    .replaceAll('{{TITLE}}', esc(reg.site.title || 'AI for Science demos'))
    .replaceAll('{{TAGLINE}}', esc(reg.site.tagline || ''))
    .replaceAll('{{COUNT_LINE}}', countLine)
    .replaceAll('{{CHIPS_CATEGORY}}', cats.map(c => chipHtml('category', c)).join(''))
    .replaceAll('{{CHIPS_TASK}}', tasks.map(t => chipHtml('task', t)).join(''))
    .replaceAll('{{CARDS}}', demos.map(d => cardHtml(d, catColor[d.category] || '#8A8378', isNew(d))).join('\n'))
    .replaceAll('{{BUILT}}', built)
    .replaceAll('{{STYLES}}', fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8'))
    .replaceAll('{{SCRIPT}}', fs.readFileSync(path.join(SITE, 'app.js'), 'utf8'));

  if (page.includes('{{')) fail('Template placeholder left unreplaced — check site/template.html.');
  fs.writeFileSync(path.join(DIST, 'index.html'), page);

  // Public manifest (no Drive ids).
  const pub = demos.map(({ file_id, file_check, ...rest }) => rest);
  fs.writeFileSync(path.join(DIST, 'manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), site: reg.site, demos: pub }, null, 2));

  console.log(`Done: ${demos.length} demos → dist/ (built ${built})`);
})().catch(e => fail(e.message));
