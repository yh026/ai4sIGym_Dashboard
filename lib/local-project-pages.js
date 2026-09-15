'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside } = require('./local-content');

const TBB_SLUG = 'tbb-cluster-explorer-2';
const PACKAGE_PATH = 'projects/tbb-cluster-explorer/project.json';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const navigationStyle = `<style id="ais-project-navigation-style">
body{padding-bottom:calc(84px + env(safe-area-inset-bottom))}
.ais-project-breadcrumb{max-width:1192px;width:calc(100% - 48px);margin:0 auto;padding:18px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--grid,#dce3e8);font:500 13px/1.5 system-ui,sans-serif;color:var(--text-secondary,#526675)}
.ais-project-breadcrumb a{color:var(--text-primary,#172938);text-decoration:none}
.ais-project-breadcrumb a:hover{text-decoration:underline}
.ais-project-breadcrumb span{text-align:right}
#ais-page-navigation{position:fixed;inset:auto 0 0;z-index:1000;border-top:1px solid var(--grid,#dce3e8);background:var(--page,#fcfcfb);padding:12px max(24px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
.ais-page-navigation-inner{max-width:1192px;margin:0 auto;display:flex;justify-content:space-between;gap:16px}
#ais-page-navigation a{box-sizing:border-box;min-height:44px;min-width:142px;display:inline-flex;align-items:center;justify-content:center;gap:12px;padding:10px 18px;border:1px solid var(--axis,#b6c2c9);border-radius:9px;background:var(--surface-1,#fff);color:var(--text-primary,#172938);font:600 14px/1.4 system-ui,sans-serif;text-decoration:none}
#ais-page-navigation a:last-child{background:var(--text-primary,#172938);color:var(--page,#fcfcfb);border-color:var(--text-primary,#172938)}
#ais-page-navigation a:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
.ais-project-breadcrumb a:focus-visible,#ais-page-navigation a:focus-visible{outline:3px solid var(--series-1,#2a78d6);outline-offset:3px}
@media(max-width:640px){.ais-project-breadcrumb{width:calc(100% - 32px);padding:14px 0;font-size:12px}#ais-page-navigation{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}#ais-page-navigation a{min-width:0;max-width:calc(50% - 8px);padding:10px 14px;gap:8px}}
</style>`;

function decoratePage(html, role, routes) {
  if (!/<head\b/i.test(html) || !/<\/head\s*>/i.test(html) || !/<body\b/i.test(html) || !/<\/body\s*>/i.test(html)) {
    throw new Error('Local project page must be a complete HTML document: ' + role);
  }
  const relative = destination => path.posix.relative(path.posix.dirname(routes[role]), destination);
  const names = { key_findings: 'Key Findings', workflow: 'Workflow', dataset: 'Dataset' };
  const targets = role === 'key_findings' ? ['dataset', 'workflow']
    : role === 'workflow' ? ['key_findings', 'dataset'] : ['key_findings', 'workflow'];
  const link = (target, index) => `<a href="${escape(relative(routes[target]))}${target === 'dataset' ? '#overview' : ''}">${index === 0 ? '<span aria-hidden="true">←</span>' : ''}<span>${names[target]}</span>${index === 1 ? '<span aria-hidden="true">→</span>' : ''}</a>`;
  const breadcrumb = `<nav class="ais-project-breadcrumb" aria-label="Project location"><a href="${escape(relative('index.html'))}#projects">← All projects</a><span>TBB · ${names[role]}</span></nav>`;
  const navigation = `<nav id="ais-page-navigation" aria-label="TBB pages" data-page-role="${role}"><div class="ais-page-navigation-inner">${targets.map(link).join('')}</div></nav>`;
  let result = html;
  if (role === 'workflow') {
    result = result.replaceAll('../../datasets_v2/himawari-9-ahi/himawari-9-ahi.html#overview', relative(routes.dataset) + '#overview');
  }
  result = result.replace(/<\/head\s*>/i, () => navigationStyle + '\n</head>');
  result = result.replace(/<body\b[^>]*>/i, tag => tag + '\n' + breadcrumb);
  const end = result.toLowerCase().lastIndexOf('</body>');
  if (end < 0) throw new Error('Local project page is missing its closing body tag.');
  return result.slice(0, end) + navigation + '\n' + result.slice(end);
}

function loadLocalProjectPages(workspace, demos) {
  const result = new Map();
  const demo = demos.find(item => item.slug === TBB_SLUG);
  if (!demo || !fs.existsSync(path.join(workspace, PACKAGE_PATH))) return result;
  const packageFile = inside(workspace, PACKAGE_PATH);
  const project = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (project.schema_version !== 1 || project.slug !== demo.slug || project.project_id !== demo.demo_id
      || !slugPattern.test(project.dataset?.slug || '')
      || project.dataset.page !== 'datasets/' + project.dataset.slug + '/index.html') {
    throw new Error('Local TBB package does not match its Registry project or Dataset.');
  }
  const routes = {
    key_findings: 'demos/' + demo.slug + '/index.html',
    workflow: 'demos/' + demo.slug + '/workflow.html',
    dataset: project.dataset.page,
  };
  const sources = {
    key_findings: inside(path.dirname(packageFile), project.pages?.key_findings),
    workflow: inside(path.dirname(packageFile), project.pages?.workflow),
    dataset: inside(workspace, project.dataset.page),
  };
  result.set(demo.slug, Object.entries(sources).map(([role, file]) => ({
    path: routes[role], html: decoratePage(fs.readFileSync(file, 'utf8'), role, routes),
  })));
  return result;
}

module.exports = { TBB_SLUG, loadLocalProjectPages };
