#!/usr/bin/env node
/**
 * AI4S Atlas build.
 *
 * Generates:
 *   dist/index.html                         interactive domain atlas
 *   dist/domains/<domain>/index.html       domain project collections
 *   dist/demos/<slug>/index.html           Live demos with atlas navigation
 *   dist/manifest.json                     public metadata (no Drive ids)
 *
 * Env: REGISTRY_URL is the Apps Script /exec URL including ?token=...
 * Local preview: node build.js --mock
 */

const fs = require('fs');
const path = require('path');

const MOCK = process.argv.includes('--mock');
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const SITE = path.join(ROOT, 'site');
const NEW_WINDOW_DAYS = 14;

const DOMAIN_DEFINITIONS = [
  {
    id: 'space-astronomy',
    name: 'Space & Astronomy',
    short: 'Space',
    description: 'Explore planetary systems, galaxies, telescope observations, and the models used to understand the universe.',
    color: '#9db9ff',
    soft: '#15213a',
    x: '19%',
    y: '24%',
    aliases: ['space', 'astronomy', 'astrophysics', 'planetary science', 'cosmology'],
  },
  {
    id: 'earth-climate',
    name: 'Earth & Climate',
    short: 'Earth',
    description: 'Investigate our planet through climate, atmosphere, ocean, geospatial, and environmental data.',
    color: '#73d7bd',
    soft: '#0d2c2d',
    x: '81%',
    y: '23%',
    aliases: ['earth', 'climate', 'environment', 'geoscience', 'geospatial', 'weather'],
  },
  {
    id: 'biology-genomics',
    name: 'Biology & Genomics',
    short: 'Biology',
    description: 'Navigate DNA, RNA, proteins, cells, and the computational tools revealing how living systems work.',
    color: '#d7a7ff',
    soft: '#291d37',
    x: '19%',
    y: '70%',
    aliases: ['biology', 'genomics', 'bioinformatics', 'life science', 'biomedicine'],
  },
  {
    id: 'chemistry-materials',
    name: 'Chemistry & Materials',
    short: 'Chemistry',
    description: 'Examine molecules, reactions, crystals, and materials with interactive models across multiple scales.',
    color: '#ffb387',
    soft: '#352219',
    x: '81%',
    y: '69%',
    aliases: ['chemistry', 'materials', 'molecular science', 'chemical science', 'materials science'],
  },
  {
    id: 'physics-simulation',
    name: 'Physics & Simulation',
    short: 'Physics',
    description: 'Experiment with particles, waves, fields, mechanics, and simulations that make physical systems visible.',
    color: '#ffd779',
    soft: '#342b17',
    x: '51%',
    y: '77%',
    aliases: ['physics', 'simulation', 'mechanics', 'quantum science', 'physical science'],
  },
  {
    id: 'ai-mathematics-data',
    name: 'AI, Mathematics & Data',
    short: 'AI & Data',
    description: 'Discover the algorithms, statistics, visualisations, and data methods that connect every region of the atlas.',
    color: '#84d4f5',
    soft: '#102a39',
    x: '50%',
    y: '41%',
    aliases: ['ai', 'data', 'mathematics', 'statistics', 'machine learning', 'data visualisation', 'data visualization'],
  },
];

function fail(msg) {
  console.error('\nBUILD FAILED: ' + msg + '\n');
  process.exit(1);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugSafe(value) {
  const out = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'demo';
}

function normalKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toBoolean(value) {
  if (value === true || value === 1) return true;
  return ['true', 'yes', '1', 'y'].includes(String(value || '').trim().toLowerCase());
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
}

function pluralText(count, singular) {
  return count + ' ' + singular + (count === 1 ? '' : 's');
}

const DOMAIN_ALIASES = new Map();
DOMAIN_DEFINITIONS.forEach(domain => {
  [domain.id, domain.name, domain.short].concat(domain.aliases).forEach(alias => {
    DOMAIN_ALIASES.set(normalKey(alias), domain);
  });
});

function domainById(id) {
  return DOMAIN_DEFINITIONS.find(domain => domain.id === id) || DOMAIN_DEFINITIONS[DOMAIN_DEFINITIONS.length - 1];
}

function resolveDomain(demo) {
  const explicit = [demo.domain, demo.science_domain, demo.research_domain].find(Boolean);
  if (explicit && DOMAIN_ALIASES.has(normalKey(explicit))) return DOMAIN_ALIASES.get(normalKey(explicit));

  const text = [
    explicit,
    demo.category,
    demo.title,
    demo.description,
    demo.task_type,
    demo.method,
    toList(demo.tags).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/astronom|astrophys|planet|space|galax|cosmo|stellar|telescope|exoplanet/.test(text)) return domainById('space-astronomy');
  if (/biolog|genom|\bdna\b|\brna\b|protein|\bcells?\b|cellular|bioinform|neuro|medic|health|ecolog/.test(text)) return domainById('biology-genomics');
  if (/chemi|molecul|material|crystal|cataly|reaction|polymer/.test(text)) return domainById('chemistry-materials');
  if (/climate|earth|geoscience|environment|weather|ocean|atmos|geospatial|traffic|transport/.test(text)) return domainById('earth-climate');
  if (/physics|quantum|particle|wave|fluid|mechanic|simulation/.test(text)) return domainById('physics-simulation');
  return domainById('ai-mathematics-data');
}

function fillTemplate(template, values, label) {
  let page = template;
  Object.keys(values).forEach(key => {
    page = page.replaceAll('{{' + key + '}}', String(values[key]));
  });
  const leftovers = page.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftovers) fail(label + ' has unreplaced placeholders: ' + [...new Set(leftovers)].join(', '));
  return page;
}

// ------------------------------------------------------------ registry I/O

async function getJson(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from registry');
  return response.json();
}

async function loadRegistry() {
  if (MOCK) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'));
    return {
      site: manifest.site || {},
      demos: manifest.demos || [],
      getHtml: async id => fs.readFileSync(path.join(ROOT, 'fixtures', id + '.html'), 'utf8'),
    };
  }

  const base = process.env.REGISTRY_URL;
  if (!base) {
    fail('REGISTRY_URL is not set. In Netlify: Site configuration → Environment variables. '
      + 'Get the value from the sheet: AI4S dashboard → Show build URL for Netlify.');
  }

  const manifestUrl = new URL(base);
  manifestUrl.searchParams.set('action', 'manifest');
  const manifest = await getJson(manifestUrl.toString());
  if (!manifest.ok) {
    fail('Registry error: ' + (manifest.error || 'unknown')
      + (manifest.error === 'bad token' ? ' — REGISTRY_URL must include the ?token=... part.' : ''));
  }

  return {
    site: manifest.site || {},
    demos: manifest.demos || [],
    getHtml: async id => {
      const url = new URL(base);
      url.searchParams.set('action', 'file');
      url.searchParams.set('id', id);
      const result = await getJson(url.toString());
      if (!result.ok) throw new Error(result.error || 'file fetch failed');
      return result.html;
    },
  };
}

async function inChunks(items, size, fn) {
  const output = [];
  for (let i = 0; i < items.length; i += size) {
    output.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return output;
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return fn();
  }
}

// ------------------------------------------------------------ domain artwork

function domainIcon(id) {
  const icons = {
    'space-astronomy': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle class="symbol-fill" cx="50" cy="50" r="23"/><circle cx="50" cy="50" r="23"/>
      <ellipse cx="50" cy="50" rx="40" ry="13" transform="rotate(-15 50 50)"/>
      <path d="M38 31c8 7 20 9 30 5M31 57c10 8 25 11 38 7"/>
      <circle class="symbol-dot" cx="82" cy="25" r="3"/>
    </svg>`,
    'earth-climate': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle class="symbol-fill" cx="50" cy="50" r="35"/><circle cx="50" cy="50" r="35"/>
      <path d="M15 50h70M50 15c12 10 18 22 18 35S62 75 50 85M50 15C38 25 32 37 32 50s6 25 18 35"/>
      <path d="M24 31c16 6 36 6 52 0M24 69c16-6 36-6 52 0"/>
    </svg>`,
    'biology-genomics': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M30 12c48 19-8 57 40 76M70 12C22 31 78 69 30 88"/>
      <path d="M38 21h24M30 35h40M31 50h38M30 65h40M38 79h24"/>
      <circle class="symbol-dot" cx="30" cy="12" r="2.5"/><circle class="symbol-dot" cx="70" cy="88" r="2.5"/>
    </svg>`,
    'chemistry-materials': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M25 50 42 25l29 4 9 29-23 20-30-9Z"/>
      <path d="m42 25 15 53M25 50l55 8M71 29 27 69"/>
      <g class="symbol-fill"><circle cx="25" cy="50" r="8"/><circle cx="42" cy="25" r="7"/><circle cx="71" cy="29" r="8"/><circle cx="80" cy="58" r="7"/><circle cx="57" cy="78" r="8"/><circle cx="27" cy="69" r="6"/></g>
    </svg>`,
    'physics-simulation': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M9 52c12-32 22-32 33 0s22 32 33 0 17-26 20-18"/>
      <path d="M10 76h80M18 18v68"/>
      <circle class="symbol-dot" cx="42" cy="52" r="3"/><circle class="symbol-dot" cx="75" cy="52" r="3"/>
    </svg>`,
    'ai-mathematics-data': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M23 25 51 15l26 18-7 31-28 20-25-21Z"/>
      <path d="m23 25 47 39M51 15 42 84M77 33 17 63M23 25l54 8M17 63l53 1"/>
      <g class="symbol-fill"><circle cx="23" cy="25" r="7"/><circle cx="51" cy="15" r="6"/><circle cx="77" cy="33" r="7"/><circle cx="70" cy="64" r="7"/><circle cx="42" cy="84" r="6"/><circle cx="17" cy="63" r="7"/></g>
    </svg>`,
  };
  return icons[id] || icons['ai-mathematics-data'];
}

function atlasDomainHtml(domain, demos) {
  const count = demos.length;
  const detail = count ? pluralText(count, 'project') : 'Coming soon';
  const content = `<span class="atlas-domain-symbol">${domainIcon(domain.id)}</span>
      <span class="atlas-domain-label"><strong>${esc(domain.name)}</strong><small>${esc(detail)}</small></span>`;
  const style = `--x:${domain.x};--y:${domain.y};--accent:${domain.color}`;

  return `    <a class="atlas-domain" href="domains/${domain.id}/index.html" data-domain="${domain.id}" data-empty="${count ? 'false' : 'true'}" style="${style}" aria-label="${esc(domain.name + ', ' + detail)}">${content}</a>`;
}

// ------------------------------------------------- injected demo-page extras

function provenanceRows(demo) {
  const rows = [];
  const add = (label, html) => { if (html) rows.push([label, html]); };
  add('Data', demo.data_link
    ? `<a href="${esc(demo.data_link)}" target="_blank" rel="noopener">${esc(demo.data_source || demo.data_link)}</a>`
    : esc(demo.data_source));
  add('License', esc(demo.data_license));
  add('Accessed', esc(demo.data_accessed && demo.data_accessed.length >= 10 && demo.data_accessed.includes('T')
    ? demo.data_accessed.slice(0, 10) : demo.data_accessed));
  add('Data notes', esc(demo.data_notes));
  add('Task', esc(demo.task_type));
  add('Method', esc(demo.method));
  add('Framework', esc(demo.framework));
  add('Training', esc(demo.training));
  add('Metrics', esc(demo.metrics));
  add('Workflow', demo.workflow_link
    ? `<a href="${esc(demo.workflow_link)}" target="_blank" rel="noopener">Open the workflow behind this demo &#8599;</a>` : '');
  add('Author', esc(demo.author));
  return rows;
}

function injectionSnippet(demo) {
  const domain = domainById(demo._domain);
  const rows = provenanceRows(demo);
  const goal = demo.learning_goal
    ? `<p class="ai4s-goal">${esc(demo.learning_goal)}</p>` : '';
  const details = rows.map(([key, value]) =>
    `<div class="ai4s-row"><span>${key}</span><span>${value}</span></div>`).join('');
  const hasPanel = rows.length > 0 || demo.learning_goal;

  const panel = hasPanel ? `
<button id="ai4s-info-btn" class="ai4s-control" type="button" aria-expanded="false" aria-controls="ai4s-info">Data &amp; methods</button>
<section id="ai4s-info" hidden aria-labelledby="ai4s-info-title">
  <h2 id="ai4s-info-title">${esc(demo.title)}</h2>${goal}${details}
</section>
<script>(function(){var b=document.getElementById('ai4s-info-btn'),p=document.getElementById('ai4s-info');function set(open,restore){p.hidden=!open;b.setAttribute('aria-expanded',String(open));if(restore)b.focus();}b.addEventListener('click',function(){set(p.hidden,false);});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!p.hidden)set(false,true);});})();</script>` : '';

  return `
<!-- injected by AI4S Atlas build -->
<style>
#ai4s-nav{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;display:flex;gap:6px;font:650 13px/1 system-ui,sans-serif}
#ai4s-nav a,.ai4s-control{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border:1px solid #b6c2c9;border-radius:999px;background:#f7fbfd;color:#0b1724;text-decoration:none;box-shadow:0 6px 22px rgba(2,10,18,.2)}
#ai4s-nav a:first-child{background:#0b1724;border-color:#0b1724;color:#f7fbfd}
.ai4s-control{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;cursor:pointer;font:650 13px/1 system-ui,sans-serif}
#ai4s-info{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:68px;z-index:2147483000;width:min(390px,calc(100vw - 24px));max-height:min(70vh,620px);overflow:auto;padding:20px;border:1px solid #cbd4da;border-radius:14px;background:#fff;color:#0b1724;box-shadow:0 16px 44px rgba(2,10,18,.24);font:14px/1.55 system-ui,sans-serif}
#ai4s-info h2{margin:0 0 12px;font:650 17px/1.3 system-ui,sans-serif}.ai4s-goal{margin:0 0 14px;color:#435462;font-style:italic}.ai4s-row{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;margin:8px 0}.ai4s-row>span:first-child{color:#536674;font:700 10px/1.5 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.ai4s-row>span:last-child{min-width:0;overflow-wrap:anywhere}.ai4s-row a{color:#075f87}
#ai4s-nav a:focus-visible,.ai4s-control:focus-visible,#ai4s-info a:focus-visible{outline:3px solid #38a9df;outline-offset:3px}
@media(max-width:480px){#ai4s-nav a:last-child{display:none}.ai4s-row{grid-template-columns:72px minmax(0,1fr)}}
</style>
<nav id="ai4s-nav" aria-label="Atlas navigation">
  <a href="../../domains/${domain.id}/index.html" aria-label="Back to ${esc(domain.name)}">&#8592; ${esc(domain.short)}</a>
  <a href="../../index.html">Atlas</a>
</nav>${panel}
`;
}

function injectIntoDemo(html, demo) {
  const snippet = injectionSnippet(demo);
  const index = html.toLowerCase().lastIndexOf('</body>');
  if (index === -1) return html + snippet;
  return html.slice(0, index) + snippet + html.slice(index);
}

// -------------------------------------------------------------- dashboard

function badgeHtml(demo, isNew) {
  const badges = [];
  if (demo.featured) badges.push('<span class="badge featured">Featured</span>');
  if (isNew) badges.push('<span class="badge">New</span>');
  if (demo.provenance) badges.push('<span class="badge">Provenance</span>');
  return badges.join('');
}

function cardHtml(demo, domain, isNew, hrefBase, index) {
  const meta = [demo.task_type, demo.framework].filter(Boolean).map(esc).join(' &middot; ');
  const search = [
    demo.title,
    demo.description,
    domain.name,
    demo.category,
    demo.task_type,
    demo.method,
    demo.framework,
    toList(demo.tags).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  const cardNumber = String(index + 1).padStart(2, '0');

  return `<a class="project-card" href="${hrefBase}demos/${esc(demo.slug)}/index.html" style="--card-accent:${domain.color}" data-search="${esc(search)}" data-domain="${domain.id}" data-task="${esc(demo.task_type)}">
  <div class="card-visual">
    <span class="card-index" aria-hidden="true">${cardNumber}</span>
    <span class="badges">${badgeHtml(demo, isNew)}</span>
    <span class="card-emblem" aria-hidden="true">${domainIcon(domain.id)}</span>
  </div>
  <div class="card-body">
    <p class="card-domain">${esc(domain.name)}</p>
    <h3>${esc(demo.title || 'Untitled experiment')}</h3>
    <p class="card-description">${esc(demo.description || 'Open this interactive experiment to explore the project.')}</p>
    <div class="card-footer">
      <div class="card-meta">${meta || 'Interactive experiment'}</div>
      <span class="card-open"><span>Open project</span><span aria-hidden="true">&#8599;</span></span>
    </div>
  </div>
</a>`;
}

function chipHtml(group, value, label) {
  return `<button class="chip" type="button" data-group="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function filterGroupHtml(label, group, items) {
  if (!items.length) return '';
  return `        <div class="chiprow" role="group" aria-label="Filter by ${esc(label.toLowerCase())}">
          <span class="chiplabel">${esc(label)}</span>
          ${items.map(item => chipHtml(group, item.value, item.label)).join('\n          ')}
        </div>`;
}

function domainSwitcherHtml(currentDomain, grouped) {
  return DOMAIN_DEFINITIONS.map(domain => {
    const count = grouped[domain.id].length;
    const content = `<span><strong>${esc(domain.name)}</strong><small>${count ? pluralText(count, 'project') : 'Coming soon'}</small></span><span aria-hidden="true">${count && domain.id !== currentDomain.id ? '&#8599;' : '&#183;'}</span>`;
    if (domain.id === currentDomain.id) {
      return `      <span class="domain-switcher-link" aria-current="page">${content}</span>`;
    }
    return `      <a class="domain-switcher-link" href="../../domains/${domain.id}/index.html">${content}</a>`;
  }).join('\n');
}

// ------------------------------------------------------------------ main

(async function main() {
  console.log(MOCK ? 'Build Atlas (mock fixtures)…' : 'Build Atlas (live registry)…');
  const registry = await loadRegistry();
  const site = registry.site && typeof registry.site === 'object' ? registry.site : {};
  let demos = Array.isArray(registry.demos)
    ? registry.demos.filter(demo => demo && typeof demo === 'object')
    : [];

  const missing = demos.filter(demo => demo.file_check === 'missing');
  missing.forEach(demo => console.warn('  skipping (file missing in Drive): ' + demo.title));
  demos = demos.filter(demo => demo.file_check !== 'missing');
  if (!demos.length) console.warn('  No Live demos in the registry — the atlas will show an empty library.');

  const used = {};
  demos.forEach(demo => {
    let slug = slugSafe(demo.slug || demo.title);
    if (used[slug]) {
      let number = 2;
      while (used[slug + '-' + number]) number++;
      slug += '-' + number;
    }
    used[slug] = true;
    demo.slug = slug;
    demo.tags = toList(demo.tags);
    demo.featured = toBoolean(demo.featured);
    demo.provenance = toBoolean(demo.provenance);
    demo._domain = resolveDomain(demo).id;
    demo.domain_id = demo._domain;
  });

  const pages = await inChunks(demos, 3, async demo => {
    const html = await withRetry(() => registry.getHtml(demo.file_id));
    return { demo, html };
  });

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const { demo, html } of pages) {
    const directory = path.join(DIST, 'demos', demo.slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), injectIntoDemo(html, demo));
    console.log('  demo: /demos/' + demo.slug + '/');
  }

  demos.sort((a, b) => Number(b.featured) - Number(a.featured)
    || ((Date.parse(b.date_added) || 0) - (Date.parse(a.date_added) || 0)));

  const now = Date.now();
  const isNew = demo => {
    const date = Date.parse(demo.date_added);
    const elapsed = now - date;
    return Number.isFinite(date) && elapsed >= 0 && elapsed < NEW_WINDOW_DAYS * 864e5;
  };

  const grouped = Object.fromEntries(DOMAIN_DEFINITIONS.map(domain => [domain.id, []]));
  demos.forEach(demo => grouped[demo._domain].push(demo));
  const activeDomains = DOMAIN_DEFINITIONS.filter(domain => grouped[domain.id].length);
  const built = new Date().toISOString().slice(0, 10);
  const styles = fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');

  const template = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
  const countLine = pluralText(demos.length, 'interactive project')
    + ' · ' + pluralText(activeDomains.length, 'active domain');
  const rootCards = demos.map((demo, index) =>
    cardHtml(demo, domainById(demo._domain), isNew(demo), '', index)).join('\n');
  const domainFilters = filterGroupHtml('Domain', 'domain', activeDomains.map(domain => ({
    value: domain.id,
    label: domain.short,
  })));

  const page = fillTemplate(template, {
    PAGE_TITLE: 'AI for Science Atlas',
    COUNT_LINE: countLine,
    ATLAS_DOMAINS: DOMAIN_DEFINITIONS.map(domain => atlasDomainHtml(domain, grouped[domain.id])).join('\n'),
    DOMAIN_FILTERS: domainFilters,
    CARDS: rootCards,
    BUILT: built,
    STYLES: styles,
    SCRIPT: script,
  }, 'site/template.html');
  fs.writeFileSync(path.join(DIST, 'index.html'), page);

  const domainTemplate = fs.readFileSync(path.join(SITE, 'domain-template.html'), 'utf8');
  DOMAIN_DEFINITIONS.forEach((domain, domainIndex) => {
    const domainDemos = grouped[domain.id];
    const tasks = [...new Set(domainDemos.map(demo => demo.task_type).filter(Boolean))].sort();
    const taskFilters = filterGroupHtml('Task', 'task', tasks.map(task => ({ value: task, label: task })));
    const cards = domainDemos.map((demo, index) =>
      cardHtml(demo, domain, isNew(demo), '../../', index)).join('\n');
    const count = domainDemos.length;
    const domainPage = fillTemplate(domainTemplate, {
      PAGE_TITLE: esc(domain.name + ' | AI for Science Atlas'),
      DOMAIN_NAME: esc(domain.name),
      DOMAIN_SHORT: esc(domain.short),
      DOMAIN_DESCRIPTION: esc(domain.description),
      DOMAIN_NUMBER: String(domainIndex + 1).padStart(2, '0'),
      DOMAIN_COUNT: count ? esc(pluralText(count, 'interactive project') + ' in this domain') : 'No projects published yet',
      DOMAIN_COLOR: domain.color,
      DOMAIN_SOFT: domain.soft,
      DOMAIN_ICON: domainIcon(domain.id),
      TASK_FILTERS: taskFilters,
      FILTER_HIDDEN: count ? '' : 'hidden',
      CARDS: cards,
      EMPTY_HIDDEN: count ? 'hidden' : '',
      EMPTY_KICKER: count ? 'No signal found' : 'Coming soon',
      EMPTY_TITLE: count ? 'No projects match this search.' : 'This region is ready for its first experiment.',
      EMPTY_TEXT: count ? 'Clear the filters or try a broader term.' : 'New projects will appear here as they are added to the atlas.',
      DOMAIN_LINKS: domainSwitcherHtml(domain, grouped),
      BUILT: built,
      STYLES: styles,
      SCRIPT: script,
    }, 'site/domain-template.html (' + domain.id + ')');
    const directory = path.join(DIST, 'domains', domain.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), domainPage);
    console.log('  domain: /domains/' + domain.id + '/ (' + count + ')');
  });

  const publicDemos = demos.map(({ file_id, file_check, _domain, ...rest }) => rest);
  const publicDomains = DOMAIN_DEFINITIONS.map(domain => ({
    id: domain.id,
    name: domain.name,
    short: domain.short,
    description: domain.description,
    color: domain.color,
    project_count: grouped[domain.id].length,
  }));
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    site,
    domains: publicDomains,
    demos: publicDemos,
  }, null, 2));

  console.log('Done: ' + demos.length + ' demos across ' + activeDomains.length + ' active domains → dist/ (built ' + built + ')');
})().catch(error => fail(error.message));
