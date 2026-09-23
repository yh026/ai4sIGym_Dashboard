'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside } = require('./local-content');

const { TBB_SLUG, decoratePage } = require('./project-pages');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function projectPackages(workspace, demos) {
  const directory = path.join(workspace, 'projects');
  if (!fs.existsSync(directory)) return [];
  const packages = [];
  for (const folder of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const relative = 'projects/' + folder.name + '/project.json';
    if (!fs.existsSync(path.join(workspace, relative))) continue;
    const packageFile = inside(workspace, relative);
    const project = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const demo = demos.find(item => item.slug === project.slug);
    if (!demo) continue;
    if (![1, 2].includes(project.schema_version) || project.project_id !== demo.demo_id
        || !slugPattern.test(project.slug || '')
        || !slugPattern.test(project.dataset?.slug || '')
        || project.dataset.page !== 'datasets/' + project.dataset.slug + '/index.html') {
      throw new Error('Local project package does not match its Registry project or Dataset.');
    }
    packages.push({ packageFile, project, demo });
  }
  return packages;
}

function localPreviewProjectIds(workspace, demos) {
  return new Set(projectPackages(workspace, demos)
    .filter(({ project }) => project.local_preview === true)
    .map(({ demo }) => demo.demo_id));
}

function loadLocalProjectPages(workspace, demos) {
  const result = new Map();
  const usedDatasets = new Map();
  for (const { packageFile, project, demo } of projectPackages(workspace, demos)) {
    if (result.has(demo.slug)) throw new Error('Duplicate local project package: ' + demo.slug);
    const entry = project.schema_version === 2 ? 'insight' : 'key_findings';
    const routes = {
      [entry]: 'demos/' + demo.slug + '/index.html',
      workflow: 'demos/' + demo.slug + '/workflow.html',
      dataset: project.dataset.page,
    };
    const sources = {
      [entry]: inside(path.dirname(packageFile), project.pages?.[entry]),
      workflow: inside(path.dirname(packageFile), project.pages?.workflow),
      dataset: inside(workspace, project.dataset.page),
    };
    const { loadWorkflowResources, enhanceWorkflow } = require('./local-workflow-resources');
    const resources = loadWorkflowResources(path.dirname(packageFile));
    const pages = Object.entries(sources).map(([role, file]) => {
      let html = fs.readFileSync(file, 'utf8');
      if (role === 'workflow') html = enhanceWorkflow(html, resources);
      const decorated = decoratePage(html, role, routes, project);
      if (role === 'dataset') {
        if (usedDatasets.has(routes.dataset)) throw new Error('Dataset navigation requires a unique local dataset route: ' + routes.dataset);
        usedDatasets.set(routes.dataset, demo.slug);
      }
      return { path: routes[role], html: decorated };
    });
    if (resources) pages.push(...resources.files.map(file => ({ ...file,
      path: path.posix.dirname(routes.workflow) + '/' + file.path })));
    result.set(demo.slug, pages);
  }
  return result;
}

module.exports = { TBB_SLUG, decoratePage, loadLocalProjectPages, localPreviewProjectIds };
