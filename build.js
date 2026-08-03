#!/usr/bin/env node
/**
 * AIS Instrument Gym build.
 *
 * Generates:
 *   dist/index.html                         interactive science map
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
const MAP_DATA = require(path.join(SITE, 'map-regions.js'));

const DOMAIN_DEFINITIONS = [
  {
    id: 'space-astronomy',
    name: 'Physics & Astronomy',
    short: 'Physics',
    description: 'Explore particles, waves, fields, planetary systems, galaxies, and the models used to understand the physical universe.',
    color: '#6950b8',
    soft: '#211b3b',
    subtopics: [
      { id: 'astrophysics', name: 'Astrophysics', aliases: ['astronomy', 'space science'], keywords: ['astronom*', 'astrophys*', 'galax*', 'cosmolog*', 'stellar', 'telescope*', 'exoplanet*', 'planetary'] },
      { id: 'quantum-particles', name: 'Quantum & Particles', aliases: ['quantum science', 'particle physics'], keywords: ['quantum', 'particle*', 'atomic', 'nuclear'] },
      { id: 'waves-fields', name: 'Waves & Fields', aliases: ['waves', 'fields', 'optics'], keywords: ['wave*', 'optic*', 'electromagnet*', 'field*', 'signal*'] },
      { id: 'mechanics-simulation', name: 'Mechanics & Simulation', aliases: ['physical simulation', 'mechanics'], keywords: ['mechanic*', 'fluid*', 'thermodynamic*', 'dynamic*', 'simulation*'] },
    ],
    legacyIds: ['physics-simulation'],
    aliases: ['space', 'space and astronomy', 'astronomy', 'astrophysics', 'planetary science', 'cosmology', 'physics', 'physics and simulation', 'physics-simulation', 'physical science', 'simulation', 'mechanics', 'quantum science'],
  },
  {
    id: 'chemistry-materials',
    name: 'Chemistry & Materials',
    short: 'Chemistry',
    description: 'Examine molecules, reactions, crystals, and materials with interactive models across multiple scales.',
    color: '#d97822',
    soft: '#352219',
    subtopics: [
      { id: 'molecular-systems', name: 'Molecular Systems', aliases: ['molecular science'], keywords: ['molecule*', 'molecular'] },
      { id: 'reactions-catalysis', name: 'Reactions & Catalysis', aliases: ['chemical reactions', 'catalysis'], keywords: ['reaction*', 'catalysis', 'catalyst*', 'kinetic*'] },
      { id: 'materials', name: 'Materials', aliases: ['materials science'], keywords: ['material*', 'crystal*', 'polymer*', 'alloy*', 'solid state'] },
      { id: 'nanoscience', name: 'Nanoscience', aliases: ['nanomaterials'], keywords: ['nanoscience', 'nanomaterial*', 'nanoparticle*', 'nanostructure*', 'graphene', 'surface chemistry', 'thin film*'] },
      { id: 'sustainable-chemistry', name: 'Sustainable Chemistry', aliases: ['green chemistry'], keywords: ['green chemistry', 'sustainable chemistry', 'circular chemistry', 'recycl*'], strongKeywords: ['green chemistry', 'sustainable chemistry', 'circular chemistry', 'recycl*'] },
    ],
    legacyIds: [],
    aliases: ['chemistry', 'materials', 'molecular science', 'chemical science', 'materials science'],
  },
  {
    id: 'biology-genomics',
    name: 'Biological Sciences',
    short: 'Biology',
    description: 'Navigate DNA, RNA, proteins, cells, organisms, and ecosystems to see how living systems work.',
    color: '#4d8b45',
    soft: '#17301c',
    subtopics: [
      { id: 'genomics-rna', name: 'Genomics & RNA', aliases: ['genomics', 'bioinformatics'], keywords: ['genom*', 'dna', 'rna', 'gene', 'genes', 'genetic*', 'bioinform*'] },
      { id: 'cell-biology', name: 'Cell Biology', aliases: ['cellular biology'], keywords: ['cell biology', 'cellular', 'cell', 'cells', 'microscopy'] },
      { id: 'protein-science', name: 'Protein Science', aliases: ['proteomics'], keywords: ['protein*', 'proteom*', 'enzyme*', 'structure prediction'] },
      { id: 'ecology-evolution', name: 'Ecology & Evolution', aliases: ['ecology', 'evolution'], keywords: ['ecolog*', 'ecosystem*', 'evolution*', 'biodiversity'] },
    ],
    legacyIds: [],
    aliases: ['biology', 'biology and genomics', 'genomics', 'bioinformatics', 'life science', 'biological sciences'],
  },
  {
    id: 'pharmacy-biomedical',
    name: 'Pharmacy & Biomedical Science',
    short: 'Pharmacy',
    description: 'Discover medicines, therapeutics, biomedical imaging, and data-driven approaches to human health.',
    color: '#c95878',
    soft: '#3a1c2a',
    subtopics: [
      { id: 'drug-discovery', name: 'Drug Discovery', aliases: ['molecular screening'], keywords: ['drug discovery', 'compound*', 'screening', 'qsar', 'molecular docking'] },
      { id: 'therapeutics', name: 'Therapeutics', aliases: ['pharmacology'], keywords: ['therapeut*', 'pharmac*', 'medicine*', 'clinical trial*'] },
      { id: 'medical-imaging', name: 'Medical Imaging', aliases: ['biomedical imaging'], keywords: ['medical imaging', 'mri', 'radiology', 'tomography', 'scan', 'scans', 'scanner*', 'scanning', 'imaging'] },
      { id: 'biomedical-data', name: 'Biomedical Data', aliases: ['health data'], keywords: ['biomedical data', 'health data', 'patient*', 'clinical data', 'medical ai'] },
    ],
    legacyIds: [],
    aliases: ['pharmacy', 'pharmaceutical science', 'pharmaceutical sciences', 'biomedicine', 'biomedical science', 'pharmacology', 'drug discovery'],
  },
  {
    id: 'food-science-technology',
    name: 'Food Science & Technology',
    short: 'Food Science',
    description: 'Explore nutrition, fermentation, food safety, analysis, and technologies across the food system.',
    color: '#5d8e39',
    soft: '#243219',
    subtopics: [
      { id: 'nutrition', name: 'Nutrition', aliases: ['nutritional science'], keywords: ['nutrition*', 'nutrient*', 'diet*', 'metabolism'] },
      { id: 'fermentation-bioprocessing', name: 'Fermentation & Bioprocessing', aliases: ['fermentation'], keywords: ['ferment*', 'bioprocess*', 'microb*', 'culture', 'cultures', 'starter culture'] },
      { id: 'food-safety', name: 'Food Safety', aliases: ['food quality'], keywords: ['food safety', 'contamin*', 'pathogen*', 'quality control'] },
      { id: 'food-analysis-engineering', name: 'Food Analysis & Engineering', aliases: ['food analysis', 'food engineering'], keywords: ['food analysis', 'food technology', 'processing', 'sensor*', 'texture*'] },
    ],
    legacyIds: [],
    aliases: ['food science', 'food technology', 'nutrition', 'fermentation', 'food safety', 'agriculture', 'crops'],
  },
  {
    id: 'earth-climate',
    name: 'Earth, Climate & Natural History',
    short: 'Earth',
    description: 'Investigate climate, oceans, landscapes, fossils, biodiversity, and the changing systems of our planet.',
    color: '#2d78a5',
    soft: '#122b38',
    subtopics: [
      { id: 'climate-atmosphere', name: 'Climate & Atmosphere', aliases: ['climate'], keywords: ['climate*', 'atmosphere*', 'weather', 'carbon', 'temperature*'] },
      { id: 'oceans-hydrology', name: 'Oceans & Hydrology', aliases: ['ocean science'], keywords: ['ocean*', 'marine', 'hydrolog*', 'water', 'coastal'] },
      { id: 'remote-sensing-geospatial', name: 'Remote Sensing & Geospatial', aliases: ['remote sensing', 'geospatial'], keywords: ['remote sensing', 'satellite*', 'geospatial', 'gis', 'traffic', 'transport*', 'point cloud*'] },
      { id: 'natural-history-geology', name: 'Natural History & Geology', aliases: ['natural history', 'geology'], keywords: ['natural history', 'geolog*', 'fossil*', 'palaeo*', 'paleo*', 'mineral*'] },
    ],
    legacyIds: [],
    aliases: ['earth', 'earth and climate', 'climate', 'environment', 'geoscience', 'geospatial', 'weather', 'ocean science', 'natural history'],
  },
  {
    id: 'mathematics',
    name: 'Mathematics',
    short: 'Mathematics',
    description: 'Explore equations, geometry, topology, optimisation, and mathematical models that describe complex systems.',
    color: '#4d5ba8',
    soft: '#1d2340',
    subtopics: [
      { id: 'pure-mathematics', name: 'Pure Mathematics', aliases: ['pure math'], keywords: ['algebra*', 'number theory', 'analysis', 'proof*'] },
      { id: 'mathematical-modelling', name: 'Mathematical Modelling', aliases: ['applied mathematics'], keywords: ['mathematical model*', 'modelling', 'modeling', 'differential equation*', 'simulation*'] },
      { id: 'geometry-topology', name: 'Geometry & Topology', aliases: ['topology'], keywords: ['geometr*', 'topolog*', 'manifold*', 'shape*'] },
      { id: 'optimisation', name: 'Optimisation', aliases: ['optimization'], keywords: ['optimisation', 'optimization', 'operations research'] },
    ],
    legacyIds: [],
    aliases: ['mathematics', 'mathematical sciences', 'applied mathematics', 'pure mathematics', 'topology', 'optimisation', 'optimization'],
  },
  {
    id: 'ai-mathematics-data',
    name: 'Statistics, Data Science & AI',
    short: 'Data & AI',
    description: 'Discover statistics, machine learning, visualisation, and data methods that connect every region of science.',
    color: '#5267a9',
    soft: '#102a39',
    subtopics: [
      { id: 'machine-learning', name: 'Machine Learning', aliases: ['artificial intelligence'], keywords: ['machine learning', 'deep learning', 'neural network*', 'clustering', 'k-means', 'classification'] },
      { id: 'scientific-machine-learning', name: 'Scientific Machine Learning', aliases: ['scientific ml'], keywords: ['scientific machine learning', 'physics informed', 'physics-informed', 'pinn', 'neural operator*', 'surrogate model*'], strongKeywords: ['scientific machine learning', 'physics informed', 'physics-informed', 'pinn', 'neural operator*'] },
      { id: 'statistics-inference', name: 'Statistics & Inference', aliases: ['statistics', 'inference'], keywords: ['statistics', 'statistical', 'inference', 'bayesian', 'probability', 'regression*'] },
      { id: 'forecasting-time-series', name: 'Forecasting & Time Series', aliases: ['forecasting', 'time series'], keywords: ['forecast*', 'time series', 'temporal', 'prediction'] },
      { id: 'data-visualisation', name: 'Visualisation & Exploration', aliases: ['data visualization', 'data visualisation', 'visualization', 'visualisation'], keywords: ['visualisation', 'visualization', 'interactive chart', 'dashboard', 'visual analytics'] },
      { id: 'scientific-computing', name: 'Scientific Computing', aliases: ['computational science'], keywords: ['scientific computing', 'numerical method', 'numerical solver', 'high performance computing', 'parallel computing'] },
    ],
    legacyIds: [],
    aliases: ['ai', 'ai and data', 'data', 'statistics', 'machine learning', 'data science', 'scientific computing', 'data visualisation', 'data visualization', 'AI, Mathematics & Data'],
  },
];

const GENERAL_SUBTOPIC = {
  id: 'general-interdisciplinary',
  name: 'General & Interdisciplinary',
  aliases: ['general', 'interdisciplinary'],
  keywords: [],
};

DOMAIN_DEFINITIONS.forEach(domain => {
  domain.futurePaths = domain.subtopics.map(subtopic => subtopic.name);
});

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
const SUBTOPIC_ALIASES = new Map();
DOMAIN_DEFINITIONS.forEach(domain => {
  [domain.id, domain.name, domain.short].concat(domain.legacyIds || [], domain.aliases).forEach(alias => {
    DOMAIN_ALIASES.set(normalKey(alias), domain);
  });
  const aliases = new Map();
  domain.subtopics.concat(GENERAL_SUBTOPIC).forEach(subtopic => {
    [subtopic.id, subtopic.name].concat(subtopic.aliases || []).forEach(alias => {
      aliases.set(normalKey(alias), subtopic);
    });
  });
  SUBTOPIC_ALIASES.set(domain.id, aliases);
});

function domainById(id) {
  return DOMAIN_DEFINITIONS.find(domain => domain.id === id)
    || DOMAIN_DEFINITIONS.find(domain => (domain.legacyIds || []).includes(id))
    || DOMAIN_DEFINITIONS[DOMAIN_DEFINITIONS.length - 1];
}

function resolveDomain(demo) {
  const candidates = [demo.domain, demo.science_domain, demo.research_domain, demo.domain_id].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = DOMAIN_ALIASES.get(normalKey(candidate));
    if (resolved) return resolved;
  }

  const text = [
    ...candidates,
    demo.category,
    demo.title,
    demo.description,
    demo.task_type,
    demo.method,
    toList(demo.tags).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/astronom|astrophys|planet|space|galax|cosmo|stellar|telescope|exoplanet/.test(text)) return domainById('space-astronomy');
  if (/physics|quantum|particle|\bwave|fluid|mechanic|electromagnet|thermodynamic/.test(text)) return domainById('space-astronomy');
  if (/pharmac|pharmaceut|drug|therapeut|biomed|medical imag|clinical|medicine|health/.test(text)) return domainById('pharmacy-biomedical');
  if (/food|nutrition|ferment|crop|agricultur|food safety/.test(text)) return domainById('food-science-technology');
  if (/biolog|genom|\bdna\b|\brna\b|protein|\bcells?\b|cellular|bioinform|neuro|ecolog/.test(text)) return domainById('biology-genomics');
  if (/chemi|molecul|material|crystal|cataly|reaction|polymer/.test(text)) return domainById('chemistry-materials');
  if (/climate|earth|geoscience|environment|weather|ocean|atmos|geospatial|traffic|transport|fossil|natural history/.test(text)) return domainById('earth-climate');
  if (/mathemat|topolog|geometr|algebra|calculus|optimis|optimiz|number theory/.test(text)) return domainById('mathematics');
  return domainById('ai-mathematics-data');
}

function subtopicById(domain, id) {
  return domain.subtopics.find(subtopic => subtopic.id === id) || GENERAL_SUBTOPIC;
}

function containsKeyword(value, keyword) {
  const text = String(value || '').toLowerCase();
  const raw = String(keyword || '').trim().toLowerCase();
  const stem = raw.endsWith('*');
  const term = stem ? raw.slice(0, -1) : raw;
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ending = stem ? '[a-z0-9-]*' : '([^a-z0-9]|$)';
  return new RegExp('(^|[^a-z0-9])' + escaped + ending).test(text);
}

function keywordSpecificity(keyword) {
  const term = String(keyword || '').replace(/\*$/, '').trim();
  const wordCount = term.split(/\s+/).filter(Boolean).length;
  return Math.min(1.5, Math.max(0, wordCount - 1) * .5 + Math.min(term.length, 50) / 100);
}

function subtopicEvidenceScore(value, weight, subtopic) {
  const matches = (subtopic.keywords || []).filter(keyword => containsKeyword(value, keyword));
  if (!matches.length) return 0;
  const specificity = Math.max(...matches.map(keywordSpecificity));
  const strongMatch = (subtopic.strongKeywords || []).some(keyword => containsKeyword(value, keyword));
  return weight + specificity + (strongMatch ? 6 : 0);
}

function resolveSubtopic(demo, domain) {
  const explicitFields = [
    demo.subtopic_id,
    demo.subtopic,
    demo.science_subtopic,
    demo.research_subtopic,
    demo.subdomain,
    demo.topic,
  ];
  const aliases = SUBTOPIC_ALIASES.get(domain.id);
  for (const field of explicitFields) {
    for (const value of toList(field)) {
      const resolved = aliases.get(normalKey(value));
      if (resolved) return resolved;
    }
  }

  const evidence = [
    [demo.title, 5],
    [toList(demo.tags).join(' '), 4],
    [demo.category, 4],
    [demo.task_type, 3],
    [demo.method, 3],
    [demo.framework, 2],
    [demo.description, 1],
    [demo.learning_goal, 1],
    [demo.data_source, 1],
  ];
  const scored = domain.subtopics.map(subtopic => ({
    subtopic,
    score: evidence.reduce((total, [value, weight]) => (
      total + subtopicEvidenceScore(value, weight, subtopic)
    ), 0),
  })).sort((a, b) => b.score - a.score);

  if (scored[0] && scored[0].score >= 4 && (!scored[1] || scored[0].score > scored[1].score)) {
    return scored[0].subtopic;
  }
  return GENERAL_SUBTOPIC;
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
    </svg>`,
    'earth-climate': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle class="symbol-fill" cx="50" cy="50" r="35"/><circle cx="50" cy="50" r="35"/>
      <path d="M15 50h70M50 15c12 10 18 22 18 35S62 75 50 85M50 15C38 25 32 37 32 50s6 25 18 35"/>
      <path d="M24 31c16 6 36 6 52 0M24 69c16-6 36-6 52 0"/>
    </svg>`,
    'biology-genomics': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M30 12c48 19-8 57 40 76M70 12C22 31 78 69 30 88"/>
      <path d="M38 21h24M30 35h40M31 50h38M30 65h40M38 79h24"/>
    </svg>`,
    'chemistry-materials': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M34 15h32M41 15v27L22 75c-4 7 1 12 9 12h38c8 0 13-5 9-12L59 42V15"/>
      <path class="symbol-fill" d="M28 68h44l7 13c1 3-3 6-8 6H29c-5 0-9-3-7-6Z"/>
      <path d="M29 68h42M38 53h24"/>
    </svg>`,
    'pharmacy-biomedical': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g transform="rotate(-38 50 50)"><rect class="symbol-fill" x="24" y="39" width="52" height="24" rx="12"/><rect x="24" y="39" width="52" height="24" rx="12"/><path d="M50 39v24"/></g>
      <path d="M69 20v18M60 29h18"/>
    </svg>`,
    'food-science-technology': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path class="symbol-fill" d="M49 84C21 66 19 31 52 17c9 28 7 50-3 67Z"/><path d="M49 84C21 66 19 31 52 17c9 28 7 50-3 67ZM48 74c4-20 13-35 29-47 5 26-5 44-29 47Z"/>
      <path d="M49 84C48 61 45 42 36 28M50 67c7-16 14-26 27-40"/>
    </svg>`,
    mathematics: `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M17 77h66M23 84V18M29 68c10-3 13-31 24-31s12 27 25 8"/>
      <path d="M32 25h43M72 21l6 4-6 4"/>
    </svg>`,
    'ai-mathematics-data': `<svg class="domain-symbol-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect class="symbol-fill" x="24" y="24" width="52" height="52" rx="8"/><rect x="24" y="24" width="52" height="52" rx="8"/>
      <path d="M36 62V48M50 62V36M64 62V43M24 34H14M24 50H14M24 66H14M76 34h10M76 50h10M76 66h10"/>
    </svg>`,
  };
  return icons[id] || icons['ai-mathematics-data'];
}

function mapHotspotHtml(domain) {
  const region = MAP_DATA.regions[domain.id];
  if (!region) fail('Missing map geometry for domain: ' + domain.id);
  const outside = `M0 0H${MAP_DATA.width}V${MAP_DATA.height}H0Z ${region.path}`;
  return `      <g class="map-region-effect" data-domain="${domain.id}" style="--domain-color:${domain.color}" aria-hidden="true">
        <path class="map-region-dimmer" d="${esc(outside)}" fill-rule="evenodd"/>
        <path class="map-region-lift" d="${esc(region.path)}"/>
        <path class="map-region-glow" d="${esc(region.path)}" vector-effect="non-scaling-stroke"/>
      </g>
      <a class="map-hotspot-link" href="domains/${domain.id}/index.html" data-domain="${domain.id}" tabindex="-1" aria-hidden="true" style="--domain-color:${domain.color}">
        <path class="map-hotspot" d="${esc(region.path)}" vector-effect="non-scaling-stroke"/>
      </a>`;
}

function subtopicStats(domain, demos) {
  const stats = domain.subtopics.map(subtopic => ({
    ...subtopic,
    projectCount: demos.filter(demo => demo._subtopic === subtopic.id).length,
  }));
  const generalCount = demos.filter(demo => demo._subtopic === GENERAL_SUBTOPIC.id).length;
  if (generalCount) stats.push({ ...GENERAL_SUBTOPIC, projectCount: generalCount });
  return stats;
}

function projectPreviewHtml(domain, demos) {
  const count = demos.length;
  const subtopics = subtopicStats(domain, demos);
  const subtopicList = `<div class="popover-subtopics"><p class="popover-label">Subtopics</p><ul>${subtopics.map(subtopic => `<li class="subtopic-chip" data-live="${subtopic.projectCount ? 'true' : 'false'}"><span>${esc(subtopic.name)}</span>${subtopic.projectCount ? `<small>${subtopic.projectCount}</small>` : ''}</li>`).join('')}</ul></div>`;
  const projects = count
    ? `<div class="popover-project-section"><p class="popover-label">Projects</p><ul class="popover-projects">${demos.slice(0, 4).map(demo => {
      const subtopic = subtopicById(domain, demo._subtopic);
      return `<li><a href="demos/${esc(demo.slug)}/index.html"><span><strong>${esc(demo.title || 'Untitled experiment')}</strong><small>${esc(subtopic.name)}</small></span><span aria-hidden="true">&#8599;</span></a></li>`;
    }).join('')}</ul></div>`
    : '<p class="popover-empty">No live projects yet. This region is ready for its first experiment.</p>';
  const action = count > 4 ? `View all ${count} projects` : 'Explore this domain';
  return `<div class="domain-popover-inner">
        <p class="popover-kicker">${count ? esc(pluralText(count, 'live project')) : 'Future region'}</p>
        <h3>${esc(domain.name)}</h3>
        ${subtopicList}
        ${projects}
        <a class="domain-popover-action" href="domains/${domain.id}/index.html"><span>${esc(action)}</span><span aria-hidden="true">&#8594;</span></a>
      </div>`;
}

function mapMarkerHtml(domain, demos) {
  const region = MAP_DATA.regions[domain.id];
  const count = demos.length;
  const detail = count ? pluralText(count, 'project') : 'Coming soon';
  const summary = `${domain.name}. ${count ? pluralText(count, 'live project') : 'No live projects yet'}. Subtopics: ${domain.subtopics.map(subtopic => subtopic.name).join(', ')}.`;
  return `      <li class="map-marker" data-domain="${domain.id}" data-popover-side="${esc(region.popover)}" style="--map-x:${region.label[0]}%;--map-y:${region.label[1]}%;--domain-color:${domain.color}">
        <a class="map-domain-label" href="domains/${domain.id}/index.html" aria-describedby="map-summary-${domain.id}" aria-controls="map-popover-${domain.id}" aria-expanded="false">
          <span><strong>${esc(domain.name)}</strong><small>${esc(detail)}</small></span>
        </a>
        <span class="sr-only" id="map-summary-${domain.id}">${esc(summary)}</span>
        <div class="domain-popover" id="map-popover-${domain.id}" hidden>${projectPreviewHtml(domain, demos)}</div>
      </li>`;
}

function mobileDomainLinkHtml(domain, demos) {
  const count = demos.length;
  return `      <a class="mobile-domain-link" href="domains/${domain.id}/index.html" data-domain="${domain.id}" style="--domain-color:${domain.color}">
        <span class="mobile-domain-icon" aria-hidden="true">${domainIcon(domain.id)}</span>
        <span><strong>${esc(domain.name)}</strong><small>${count ? esc(pluralText(count, 'project')) : 'Coming soon'}</small></span>
        <span aria-hidden="true">&#8594;</span>
      </a>`;
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
<!-- injected by AIS Instrument Gym build -->
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
<nav id="ai4s-nav" aria-label="AIS Instrument Gym navigation">
  <a href="../../domains/${domain.id}/index.html" aria-label="Back to ${esc(domain.name)}">&#8592; ${esc(domain.short)}</a>
  <a href="../../index.html">Instrument Gym</a>
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
  const subtopic = subtopicById(domain, demo._subtopic);
  const meta = [demo.task_type, demo.framework].filter(Boolean).map(esc).join(' &middot; ');
  const search = [
    demo.title,
    demo.description,
    domain.name,
    subtopic.name,
    demo.category,
    demo.task_type,
    demo.method,
    demo.framework,
    toList(demo.tags).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  const cardNumber = String(index + 1).padStart(2, '0');

  return `<a class="project-card" href="${hrefBase}demos/${esc(demo.slug)}/index.html" style="--card-accent:${domain.color}" data-search="${esc(search)}" data-domain="${domain.id}" data-subtopic="${esc(subtopic.id)}" data-task="${esc(demo.task_type)}">
  <div class="card-visual">
    <span class="card-index" aria-hidden="true">${cardNumber}</span>
    <span class="badges">${badgeHtml(demo, isNew)}</span>
    <span class="card-emblem" aria-hidden="true">${domainIcon(domain.id)}</span>
  </div>
  <div class="card-body">
    <p class="card-domain">${esc(domain.name)} <span aria-hidden="true">/</span> ${esc(subtopic.name)}</p>
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
  console.log(MOCK ? 'Build AIS Instrument Gym (mock fixtures)…' : 'Build AIS Instrument Gym (live registry)…');
  const registry = await loadRegistry();
  const site = registry.site && typeof registry.site === 'object' ? registry.site : {};
  let demos = Array.isArray(registry.demos)
    ? registry.demos.filter(demo => demo && typeof demo === 'object')
    : [];

  const missing = demos.filter(demo => demo.file_check === 'missing');
  missing.forEach(demo => console.warn('  skipping (file missing in Drive): ' + demo.title));
  demos = demos.filter(demo => demo.file_check !== 'missing');
  if (!demos.length) console.warn('  No Live demos in the registry — the Instrument Gym will show an empty library.');

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
    const domain = resolveDomain(demo);
    const subtopic = resolveSubtopic(demo, domain);
    demo._domain = domain.id;
    demo._subtopic = subtopic.id;
    demo.domain_id = demo._domain;
    demo.subtopic_id = demo._subtopic;
    demo.subtopic_label = subtopic.name;
  });

  const pages = await inChunks(demos, 3, async demo => {
    const html = await withRetry(() => registry.getHtml(demo.file_id));
    return { demo, html };
  });

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const assetSource = path.join(SITE, 'assets');
  if (fs.existsSync(assetSource)) fs.cpSync(assetSource, path.join(DIST, 'assets'), { recursive: true });
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
    PAGE_TITLE: 'AIS Instrument Gym',
    COUNT_LINE: countLine,
    MAP_HOTSPOTS: DOMAIN_DEFINITIONS.map(mapHotspotHtml).join('\n'),
    MAP_MARKERS: DOMAIN_DEFINITIONS.map(domain => mapMarkerHtml(domain, grouped[domain.id])).join('\n'),
    MOBILE_DOMAIN_LINKS: DOMAIN_DEFINITIONS.map(domain => mobileDomainLinkHtml(domain, grouped[domain.id])).join('\n'),
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
    const futureText = 'Reserved paths include ' + domain.futurePaths.join(', ') + '. New projects will appear here as they are added to AIS Instrument Gym.';
    const domainPage = fillTemplate(domainTemplate, {
      PAGE_TITLE: esc(domain.name + ' | AIS Instrument Gym'),
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
      EMPTY_TEXT: count ? 'Clear the filters or try a broader term.' : esc(futureText),
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

  DOMAIN_DEFINITIONS.forEach(domain => {
    (domain.legacyIds || []).forEach(legacyId => {
      const directory = path.join(DIST, 'domains', legacyId);
      fs.mkdirSync(directory, { recursive: true });
      const target = '../' + domain.id + '/index.html';
      const redirect = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting | AIS Instrument Gym</title><link rel="canonical" href="${target}"><meta http-equiv="refresh" content="0;url=${target}"></head><body><p>This domain has moved to <a href="${target}">${esc(domain.name)}</a>.</p><script>location.replace(${JSON.stringify(target)}+location.search+location.hash);</script></body></html>`;
      fs.writeFileSync(path.join(directory, 'index.html'), redirect);
      console.log('  legacy redirect: /domains/' + legacyId + '/ → /domains/' + domain.id + '/');
    });
  });

  const publicDemos = demos.map(({ file_id, file_check, _domain, _subtopic, ...rest }) => rest);
  const publicDomains = DOMAIN_DEFINITIONS.map(domain => ({
    id: domain.id,
    name: domain.name,
    short: domain.short,
    description: domain.description,
    color: domain.color,
    future_paths: domain.futurePaths,
    subtopics: subtopicStats(domain, grouped[domain.id]).map(subtopic => ({
      id: subtopic.id,
      name: subtopic.name,
      project_count: subtopic.projectCount,
    })),
    legacy_ids: domain.legacyIds,
    project_count: grouped[domain.id].length,
  }));
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    taxonomy_version: 3,
    site,
    domains: publicDomains,
    demos: publicDemos,
  }, null, 2));

  console.log('Done: ' + demos.length + ' demos across ' + activeDomains.length + ' active domains → dist/ (built ' + built + ')');
})().catch(error => fail(error.message));
