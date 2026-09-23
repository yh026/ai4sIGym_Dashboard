'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside } = require('./local-content');
const { zipFiles } = require('./local-zip');
const { methodBindings, workflowSkill } = require('./local-workflow-catalog');

function loadWorkflowResources(projectDirectory) {
  const indexPath = 'skills/index.json';
  if (!fs.existsSync(path.join(projectDirectory, indexPath))) return null;
  const read = relative => fs.readFileSync(inside(projectDirectory, relative));
  const index = JSON.parse(read(indexPath));
  const methods = methodBindings(index);
  const workflowDefinition = workflowSkill(index);
  const files = [], allSkills = new Map();
  const emit = (name, bytes) => {
    const relative = 'resources/' + name;
    if (files.some(file => file.path === relative)) throw new Error('Duplicate workflow resource: ' + relative);
    files.push({ path: relative, bytes });
    return relative;
  };
  let workflow = null;
  if (workflowDefinition) {
    const { id, title, path: sourcePath } = workflowDefinition;
    const filename = id + '-skill.zip';
    const zip = emit('skills/' + filename, zipFiles(new Map([[sourcePath, read('skills/' + sourcePath)]])));
    workflow = { id, title, filename, zip };
  }
  const skills = methods.skills.map(entry => {
    const source = read('skills/' + entry.path);
    const filename = 'tbb-' + entry.id + '-skill.zip';
    // Always package the current standalone instructions, never a cached ZIP or
    // the internal skills used to generate the historical Notebook.
    const zip = emit('skills/' + filename, zipFiles(new Map([[entry.path, source]])));
    allSkills.set('tbb-analysis-skills/' + entry.path, source);
    return { id: entry.id, title: entry.title, zip, filename };
  });
  let all = null;
  if (skills.length) {
    const readme = '# Reusable analysis skills\n\nGive a chosen SKILL.md and your own dataset to an AI assistant and request an analysis Notebook. Each method explains its required input and how to adapt the analysis. These instructions use standard Python libraries; the TBB data and SciDGL runtime are not required.\n\nIncluded methods:\n\n'
      + methods.skills.map(skill => '- ' + skill.path).join('\n') + '\n';
    allSkills.set('tbb-analysis-skills/README.md', Buffer.from(readme));
    all = emit('tbb-analysis-skills.zip', zipFiles(allSkills));
  }
  const notebookBytes = read('notebook/aisgym.ipynb');
  const notebook = emit('aisgym.ipynb', notebookBytes);
  const run = new Map();
  function collect(directory, prefix = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '.DS_Store') continue;
      if (item.isSymbolicLink()) throw new Error('Notebook package contains a symlink.');
      const relative = prefix + item.name;
      if (item.isDirectory()) collect(path.join(directory, item.name), relative + '/');
      else if (item.isFile()) run.set('tbb-notebook/' + relative, read('notebook/' + relative));
    }
  }
  collect(path.join(projectDirectory, 'notebook'));
  run.set('README.md', Buffer.from('# TBB Notebook package\n\nOpen tbb-notebook/aisgym.ipynb to read the saved outputs. Re-running requires the SciDGL Python environment and project runtime. Set SCIDGL_RUN_DIR to the extracted tbb-notebook folder and SCIDGL_PROJECT_ROOT to your SciDGL project before starting the kernel. The runtime is not included. See tbb-notebook/README.md for the original execution record and interpretation limits.\n'));
  const notebookPackage = emit('tbb-notebook.zip', zipFiles(run));
  return { files, data: { workflow, skills, bindings: methods.bindings, all, notebook, notebookPackage,
    notebookBytes: notebookBytes.length, notebookPackageBytes: files.at(-1).bytes.length } };
}

function enhanceWorkflow(html, resources) {
  if (!resources) return html;
  if (!/<\/head\s*>/i.test(html) || !/<\/body\s*>\s*<\/html\s*>\s*$/i.test(html)) {
    throw new Error('Workflow resources require a complete HTML document.');
  }
  // Replace embedded legacy buttons with downloads from the optional associations.
  const clean = html.replace(/<!-- TBB-SKILLS:([a-z-]+):START -->[\s\S]*?<!-- TBB-SKILLS:\1:END -->\s*/g, '');
  const css = fs.readFileSync(path.join(__dirname, 'local-workflow.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, 'local-workflow.js'), 'utf8');
  const data = JSON.stringify(resources.data).replace(/</g, '\\u003c');
  return clean.replace(/<\/head\s*>/i, () => '<style id="ais-workflow-resource-style">' + css + '</style>\n</head>')
    .replace(/<\/body\s*>\s*<\/html\s*>\s*$/i,
      () => '<script id="ais-workflow-data" type="application/json">' + data + '</script>\n<script>' + js + '</script>\n</body>\n</html>');
}

module.exports = { loadWorkflowResources, enhanceWorkflow };
