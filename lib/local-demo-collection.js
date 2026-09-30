'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside } = require('./local-content');
const { decoratePage } = require('./local-project-pages');

function readDatasetPage(directory, project, title) {
  if (!project.dataset_source) return null;
  const datasetId = project.dataset_source.split('/')[0];
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*\.html$/.test(project.dataset_source)
      || !['demos/' + project.slug + '/dataset.html', 'datasets/' + datasetId + '/index.html'].includes(project.dataset)) {
    throw new Error('Invalid local collection Dataset source or route: ' + project.slug);
  }
  const datasetDirectory = path.resolve(directory, '..', 'datasets_v4');
  if (fs.existsSync(path.join(datasetDirectory, project.dataset_source))) {
    return fs.readFileSync(inside(datasetDirectory, project.dataset_source), 'utf8');
  }
  const label = String(project.navigation_label || title).replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return fs.readFileSync(path.join(__dirname, '../site/dataset-placeholder.html'), 'utf8')
    .replaceAll('__PROJECT_NAME__', label);
}

// Long fold subtitles must not impose their minimum content width on the page.
// Keep wide result tables inside their own scroll containers on small screens.
const workflowLayout = `<style id="ais-collection-workflow-layout">
body[data-ais-project-page] .fold-stack{min-width:0;grid-template-columns:minmax(0,1fr)}
body[data-ais-project-page] .fold-stack>.fold,body[data-ais-project-page] .fold-head{min-width:0}
body[data-ais-project-page] .fold-head>span{min-width:0;white-space:normal;overflow-wrap:anywhere}
</style>`;

// This collection is an explicit local overlay. The verified Drive snapshot and
// the production Registry retain their own metadata and publication decisions.
function loadLocalDemoCollection(directory, registryDemos) {
  if (!fs.existsSync(path.join(directory, 'collection.json'))) return null;
  const manifest = JSON.parse(fs.readFileSync(inside(directory, 'collection.json'), 'utf8'));
  if (manifest.schema_version !== 1 || !/^[a-z0-9-]+$/.test(manifest.id || '')
      || !manifest.label || !Array.isArray(manifest.projects) || !manifest.projects.length) {
    throw new Error('Invalid local demo collection.');
  }
  const entries = new Map(), demos = registryDemos.map(demo => ({ ...demo }));
  const previewIds = new Set();
  for (const project of manifest.projects) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug || '') || entries.has(project.slug)) {
      throw new Error('Invalid or duplicate local collection slug: ' + project.slug);
    }
    let demo = demos.find(candidate => candidate.slug === project.slug);
    if (!demo && project.new_demo) {
      if (project.new_demo.status !== 'Draft' || project.new_demo.public_page_permission !== 'Preview only') {
        throw new Error('New local collection demos must be Draft / Preview only.');
      }
      demo = { ...project.new_demo, demo_id: project.demo_id, slug: project.slug,
        file_id: 'local-collection:' + project.slug, file_check: 'ok' };
      demos.push(demo);
    }
    if (!demo || demo.demo_id !== project.demo_id) {
      throw new Error('Local collection does not match its Registry project: ' + project.slug);
    }
    if (project.card_summary) demo.card_summary = project.card_summary;
    const read = relative => fs.readFileSync(inside(directory, relative), 'utf8');
    entries.set(project.slug, { ...project,
      insightHtml: read(project.insight), workflowHtml: read(project.workflow),
      datasetHtml: readDatasetPage(directory, project, demo.title) });
    previewIds.add(demo.demo_id);
  }
  return { id: manifest.id, label: manifest.label, demos, entries, previewIds };
}

function integrateLocalDemoPages(collection, demos, authoredPages) {
  if (!collection) return authoredPages;
  const result = new Map(authoredPages);
  for (const demo of demos) {
    const project = collection.entries.get(demo.slug);
    if (!project) continue;
    const base = 'demos/' + demo.slug + '/';
    const routes = { insight: base + 'index.html', workflow: base + 'workflow.html' };
    const existing = authoredPages.get(demo.slug) || [];
    if (project.dataset) {
      if (!project.datasetHtml && !existing.some(page => page.path === project.dataset && page.html)) {
        throw new Error('Local collection Dataset is unavailable: ' + project.dataset);
      }
      routes.dataset = project.dataset;
    }
    const replacedRoutes = [routes.insight, routes.workflow, ...(project.datasetHtml ? [routes.dataset] : [])];
    const retained = existing.filter(page => !replacedRoutes.includes(page.path))
      .map(page => page.html ? { ...page, html: page.html.replaceAll('<span>Key Findings</span>', '<span>Insight</span>') } : page);
    const navigation = { ...project, title: demo.title };
    if (project.preserve_workflow_resources === true) {
      const workflow = existing.find(page => page.path === routes.workflow);
      if (!workflow) throw new Error('Workflow resources are unavailable: ' + demo.slug);
      navigation.resource_page = base + 'workflow-resources.html';
      retained.push({ ...workflow, path: navigation.resource_page,
        html: workflow.html.replaceAll('<span>Key Findings</span>', '<span>Insight</span>') });
    } else if (existing.length) {
      // An explicit opt-in is required before replacing an authored project.
      throw new Error('Local collection would replace an authored project: ' + demo.slug);
    }
    result.set(demo.slug, [
      { path: routes.insight, html: decoratePage(project.insightHtml, 'insight', routes, navigation) },
      { path: routes.workflow, html: decoratePage(project.workflowHtml, 'workflow', routes, navigation)
        .replace(/<\/head\s*>/i, () => workflowLayout + '\n</head>') },
      ...(project.datasetHtml
        ? [{ path: routes.dataset, html: decoratePage(project.datasetHtml, 'dataset', routes, navigation) }]
        : []),
      ...retained,
    ]);
  }
  return result;
}

module.exports = { loadLocalDemoCollection, integrateLocalDemoPages };
