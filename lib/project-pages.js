'use strict';

const path = require('node:path');

const TBB_SLUG = 'tbb-cluster-explorer-2';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const navigationStyle = `<style id="ais-project-navigation-style">
body[data-ais-project-page]{--ais-page-content-width:1200px;--ais-page-gutter:max(clamp(20px,5vw,72px),env(safe-area-inset-left),env(safe-area-inset-right));padding-bottom:calc(84px + env(safe-area-inset-bottom))}
/* Keep the content and both navigation rows on the same inset, including
   Insight templates whose original .wrap removes the reading-width limit. */
body[data-ais-project-page]>.wrap,.ais-project-breadcrumb,.ais-page-navigation-inner{box-sizing:border-box;width:calc(100% - 2 * var(--ais-page-gutter));max-width:var(--ais-page-content-width);min-width:0;margin-left:auto;margin-right:auto}
body[data-ais-project-page]>.wrap{padding-left:0;padding-right:0}
.ais-project-breadcrumb{padding:18px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--grid,#dce3e8);font:500 13px/1.5 system-ui,sans-serif;color:var(--text-secondary,#526675)}
.ais-project-breadcrumb a{color:var(--text-primary,#172938);text-decoration:none}
.ais-project-breadcrumb a:hover{text-decoration:underline}
.ais-project-breadcrumb span{text-align:right}
.ais-project-location{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 20px}
#ais-page-navigation{position:fixed;inset:auto 0 0;z-index:1000;border-top:1px solid var(--grid,#dce3e8);background:var(--page,#fcfcfb);padding:12px 0 max(12px,env(safe-area-inset-bottom))}
.ais-page-navigation-inner{display:flex;justify-content:space-between;gap:16px}
#ais-page-navigation a{box-sizing:border-box;min-height:44px;min-width:142px;display:inline-flex;align-items:center;justify-content:center;gap:12px;padding:10px 18px;border:1px solid var(--axis,#b6c2c9);border-radius:9px;background:var(--surface-1,#fff);color:var(--text-primary,#172938);font:600 14px/1.4 system-ui,sans-serif;text-decoration:none}
#ais-page-navigation a:last-child{background:var(--text-primary,#172938);color:var(--page,#fcfcfb);border-color:var(--text-primary,#172938)}
#ais-page-navigation a:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
.ais-project-breadcrumb a:focus-visible,#ais-page-navigation a:focus-visible{outline:3px solid var(--series-1,#2a78d6);outline-offset:3px}
@media(max-width:640px){.ais-project-breadcrumb{padding:14px 0;font-size:12px}#ais-page-navigation a{min-width:0;max-width:calc(50% - 8px);padding:10px 14px;gap:8px}}
</style>`;

function decoratePage(html, role, routes, project = {}) {
  if (!/<head\b/i.test(html) || !/<\/head\s*>/i.test(html) || !/<body\b/i.test(html) || !/<\/body\s*>/i.test(html)) {
    throw new Error('Project page must be a complete HTML document: ' + role);
  }
  const relative = destination => path.posix.relative(path.posix.dirname(routes[role]), destination);
  const entry = routes.insight ? 'insight' : 'key_findings';
  const label = project.navigation_label || (project.slug === TBB_SLUG ? 'TBB' : project.title) || 'TBB';
  const names = { insight: 'Insight', key_findings: 'Key Findings', workflow: 'Workflow', dataset: 'Dataset', home: 'All projects' };
  const datasetOrHome = routes.dataset ? 'dataset' : 'home';
  const targets = role === entry ? [datasetOrHome, 'workflow']
    : role === 'workflow' ? [entry, datasetOrHome] : [entry, 'workflow'];
  const link = (target, index) => `<a href="${escape(relative(target === 'home' ? 'index.html' : routes[target]))}${target === 'dataset' ? '#overview' : target === 'home' ? '#projects' : ''}">${index === 0 ? '<span aria-hidden="true">←</span>' : ''}<span>${names[target]}</span>${index === 1 ? '<span aria-hidden="true">→</span>' : ''}</a>`;
  const resources = project.resource_page
    ? `<a href="${escape(relative(project.resource_page))}">Notebook &amp; skills</a>` : '';
  const breadcrumb = `<nav class="ais-project-breadcrumb" aria-label="Project location"><a href="${escape(relative('index.html'))}#projects">← All projects</a><div class="ais-project-location">${resources}<span>${escape(label)} · ${names[role]}</span></div></nav>`;
  const navigation = `<nav id="ais-page-navigation" aria-label="${escape(label)} pages" data-page-role="${role}"><div class="ais-page-navigation-inner">${targets.map(link).join('')}</div></nav>`;
  let result = stripProjectNavigation(html);
  if (role === 'workflow' && routes.dataset) {
    result = result.replaceAll('../../datasets_v2/himawari-9-ahi/himawari-9-ahi.html#overview', relative(routes.dataset) + '#overview');
  }
  result = result.replace(/<\/head\s*>/i, () => navigationStyle + '\n</head>');
  result = result.replace(/<body\b[^>]*>/i, tag => tag.slice(0, -1) + ' data-ais-project-page>\n' + breadcrumb);
  const end = result.toLowerCase().lastIndexOf('</body>');
  if (end < 0) throw new Error('Project page is missing its closing body tag.');
  return result.slice(0, end) + navigation + '\n' + result.slice(end);
}


// A Drive export may already have navigation from a local preview. Remove only
// our named components; scientific scripts and the page's own layout survive.
function stripProjectNavigation(html) {
  return html.replace(/<style\b[^>]*id=["']ais-project-navigation-style["'][^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[^>]*class=["']ais-project-breadcrumb["'][^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<nav\b[^>]*id=["']ais-page-navigation["'][^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/\sdata-ais-project-page(?:=["'][^"']*["'])?/gi, '');
}

function datasetPlaceholder(template, title) {
  return template.replaceAll('__PROJECT_NAME__', escape(title));
}

module.exports = { TBB_SLUG, decoratePage, stripProjectNavigation, datasetPlaceholder };
