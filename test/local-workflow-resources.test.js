'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { methodBindings } = require('../lib/local-workflow-catalog');
const { loadWorkflowResources, enhanceWorkflow } = require('../lib/local-workflow-resources');
const { zipFiles } = require('../lib/local-zip');
const { createServer } = require('../scripts/preview-local.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originals = new Map();
  function write(relative, value) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    const bytes = Buffer.from(value);
    fs.writeFileSync(path.join(root, relative), bytes);
    originals.set(relative, bytes);
  }
  const index = { schema_version: 1, skills: ['pca', 'tsne', 'umap', 'kmeans'].map(id => ({
    id, title: id, path: id + '/SKILL.md', workflow_step_id: id, download: 'downloads/' + id + '.zip',
  })), step_skills: { crop: [], load: [], encode: [], pca: ['pca'], tsne: ['tsne'], umap: ['umap'], kmeans: ['kmeans'], evaluate: [] } };
  write('skills/index.json', JSON.stringify(index));
  write('skills/README.md', 'Reusable skills');
  for (const skill of index.skills) {
    write('skills/' + skill.path, 'Independent ' + skill.id + '\nLiteral $& $1 `code` </script><script>example()</script> 原文\n');
    write('skills/' + skill.download, 'Stale ZIP must not be used');
  }
  write('skills/notebook-workflow/index.json', 'Internal index is not a public download source');
  write('skills/notebook-workflow/analysis_skills/provenance-recording/SKILL.md', 'INTERNAL_INSTRUCTIONS');
  write('notebook/plan.json', '{"steps":[]}');
  write('notebook/aisgym.ipynb', '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
  write('notebook/inputs/data.bin', Buffer.from([0, 1, 255, 128]));
  write('notebook/.build/cache.bin', Buffer.from([34, 0, 72]));
  write('notebook/README.md', 'Original execution record');
  return { root, originals, write, index };
}

// Read the ZIP records independently of the writer, including the end record.
function unpack(bytes) {
  const result = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 8);
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    const data = inflateRawSync(bytes.subarray(start, start + length));
    assert.equal(data.length, bytes.readUInt32LE(offset + 22));
    assert.ok(!result.has(name));
    result.set(name, data);
    offset = start + length;
  }
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), result.size);
  assert.equal(bytes.readUInt32LE(end + 16), offset);
  return result;
}

test('public downloads contain only reusable methods, while Notebook and run files remain intact', t => {
  const sample = fixture(t);
  const { data, files } = loadWorkflowResources(sample.root);
  const downloads = new Map(files.map(file => [file.path, file.bytes]));
  assert.equal(downloads.size, 7);
  assert.equal(data.skills.length, 4);
  assert.deepEqual(data.bindings.map(binding => binding.step), ['pca', 'tsne', 'umap', 'kmeans']);
  assert.deepEqual(downloads.get(data.notebook), sample.originals.get('notebook/aisgym.ipynb'));
  for (const skill of data.skills) {
    const relative = skill.id + '/SKILL.md';
    const source = sample.originals.get('skills/' + relative);
    assert.equal(skill.source, undefined);
    const individual = unpack(downloads.get(skill.zip));
    assert.equal(individual.size, 1);
    assert.deepEqual(individual.get(relative), source);
  }
  const all = unpack(downloads.get(data.all));
  assert.equal([...all.keys()].filter(name => name.endsWith('/SKILL.md')).length, 4);
  assert.ok(![...all.keys()].some(name => /inputs\/|\.ipynb|notebook-workflow|analysis_skills/.test(name)));
  const run = unpack(downloads.get(data.notebookPackage));
  for (const [relative, bytes] of sample.originals) {
    assert.deepEqual(fs.readFileSync(path.join(sample.root, relative)), bytes);
    if (relative.startsWith('notebook/')) assert.deepEqual(run.get('tbb-' + relative), bytes);
  }
});

test('each node can have zero, one or multiple methods; only associated methods are packaged', t => {
  const sample = fixture(t);
  const save = () => sample.write('skills/index.json', JSON.stringify(sample.index));
  sample.index.step_skills = {};
  save();
  let result = loadWorkflowResources(sample.root);
  assert.deepEqual(result.data.bindings, []);
  assert.deepEqual(result.data.skills, []);
  assert.equal(result.data.all, null);
  assert.equal(result.files.length, 2);

  sample.index.step_skills = { tsne: ['tsne'], evaluate: [], load: [] };
  save();
  result = loadWorkflowResources(sample.root);
  assert.deepEqual(result.data.skills.map(skill => skill.id), ['tsne']);
  assert.deepEqual(result.data.bindings.map(binding => binding.skillIds), [['tsne']]);
  assert.equal(result.files.length, 4);

  for (const id of ['neighbor-agreement', 'ari']) {
    sample.index.skills.push({ id, title: id, path: id + '/SKILL.md' });
    sample.write('skills/' + id + '/SKILL.md', 'Reusable evaluation method ' + id);
  }
  sample.index.step_skills = { evaluate: ['neighbor-agreement', 'ari'] };
  save();
  result = loadWorkflowResources(sample.root);
  assert.deepEqual(result.data.bindings, [{ step: 'evaluate', target: 'map-and-curve-body', insertion: 'append', skillIds: ['neighbor-agreement', 'ari'] }]);
  assert.equal(result.data.skills.length, 2);
  assert.equal(result.files.filter(file => file.path.startsWith('resources/skills/')).length, 2);
  const legacy = fixture(t).index;
  delete legacy.step_skills;
  assert.equal(methodBindings(legacy).bindings.length, 4);
});

test('complete workflow is a current standalone download independent of method associations', t => {
  const sample = fixture(t);
  assert.equal(loadWorkflowResources(sample.root).data.workflow, null);
  sample.index.workflow_skill = { id: 'tbb-cluster-workflow', title: 'Complete workflow', path: 'tbb-cluster-workflow/SKILL.md' };
  const source = 'Complete instructions including data preparation, analysis and evaluation.';
  sample.write('skills/tbb-cluster-workflow/SKILL.md', source);
  sample.write('skills/downloads/tbb-cluster-workflow-skill.zip', 'stale copy');
  sample.write('skills/index.json', JSON.stringify(sample.index));
  let result = loadWorkflowResources(sample.root);
  assert.equal(result.files.length, 8);
  const workflow = result.files.find(file => file.path === result.data.workflow.zip);
  assert.deepEqual(unpack(workflow.bytes), new Map([['tbb-cluster-workflow/SKILL.md', Buffer.from(source)]]));
  const methods = unpack(result.files.find(file => file.path === result.data.all).bytes);
  assert.equal([...methods.keys()].filter(name => name.endsWith('/SKILL.md')).length, 4);
  assert.ok(![...methods.keys()].some(name => name.includes('tbb-cluster-workflow')));
  const html = enhanceWorkflow('<html><head></head><body></body></html>', result);
  assert.ok(!html.includes(source));

  sample.index.skills = [];
  sample.index.step_skills = {};
  sample.write('skills/index.json', JSON.stringify(sample.index));
  result = loadWorkflowResources(sample.root);
  assert.equal(result.files.length, 3);
  assert.equal(result.data.workflow.id, 'tbb-cluster-workflow');
  assert.deepEqual(result.data.bindings, []);
  assert.equal(result.data.all, null);

  sample.index.workflow_skill.path = '../outside.md';
  sample.write('skills/index.json', JSON.stringify(sample.index));
  assert.throws(() => loadWorkflowResources(sample.root), /Invalid or duplicate workflow skill/);
  sample.index.workflow_skill.path = 'tbb-cluster-workflow/SKILL.md';
  sample.write('skills/index.json', JSON.stringify(sample.index));
  fs.unlinkSync(path.join(sample.root, 'skills/tbb-cluster-workflow/SKILL.md'));
  assert.throws(() => loadWorkflowResources(sample.root), /ENOENT/);
});

test('incomplete, duplicate and escaping skill packages fail before publication', t => {
  const sample = fixture(t);
  sample.index.skills[1] = { ...sample.index.skills[0] };
  sample.write('skills/index.json', JSON.stringify(sample.index));
  assert.throws(() => loadWorkflowResources(sample.root), /duplicate method skill/);
  const independent = fixture(t);
  independent.index.skills[0].path = '../outside.md';
  independent.write('skills/index.json', JSON.stringify(independent.index));
  assert.throws(() => loadWorkflowResources(independent.root), /Invalid or duplicate method skill/);
  const incomplete = fixture(t);
  fs.unlinkSync(path.join(incomplete.root, 'skills/tsne/SKILL.md'));
  assert.throws(() => loadWorkflowResources(incomplete.root), /ENOENT/);
  const symlink = fixture(t);
  fs.symlinkSync(path.join(symlink.root, 'skills/README.md'), path.join(symlink.root, 'notebook/linked.md'));
  assert.throws(() => loadWorkflowResources(symlink.root), /symlink/);
  const unknown = fixture(t);
  unknown.index.step_skills.evaluate = ['missing'];
  unknown.write('skills/index.json', JSON.stringify(unknown.index));
  assert.throws(() => loadWorkflowResources(unknown.root), /Unknown method skill/);
});

test('page shows download metadata without skill prose and safely preserves scientific content', t => {
  const sample = fixture(t);
  sample.index.skills[0].title = 'PCA $& </script><script>example()</script>';
  sample.write('skills/index.json', JSON.stringify(sample.index));
  const resources = loadWorkflowResources(sample.root);
  const scientific = '<canvas id="original-plot"></canvas><script>const payload = {a:"$&"};</script>';
  const html = '<html><head><title>TBB</title></head><body>' + scientific
    + '<!-- TBB-SKILLS:pca:START -->old button<!-- TBB-SKILLS:pca:END --></body></html>';
  const output = enhanceWorkflow(html, resources);
  assert.ok(output.includes(scientific));
  assert.ok(!output.includes('old button'));
  assert.ok(!output.includes('<script>example()</script>'));
  assert.ok(!output.includes('Independent tsne'));
  assert.ok(!output.includes('INTERNAL_INSTRUCTIONS'));
  assert.ok(!output.includes('ais-skill-panel'));
  assert.ok(!output.includes('View skill'));
  const embedded = output.match(/<script id="ais-workflow-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(embedded), resources.data);
  assert.equal(enhanceWorkflow(html, null), html);
  assert.throws(() => enhanceWorkflow('<html>incomplete</html>', resources), /complete HTML/);
});

test('ZIP downloads have known CRC, preserve binary and Unicode names, and reject unsafe paths', () => {
  const input = new Map([['原文.md', Buffer.from('123456789')]]);
  const zip = zipFiles(input);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.deepEqual(unpack(zip), input);
  assert.deepEqual(zipFiles(input), zip);
  for (const name of ['../outside', '/absolute', 'a/../b', 'a\\b', 'C:file', 'a//b']) {
    assert.throws(() => zipFiles(new Map([[name, 'x']])), /Unsafe ZIP path/);
  }
});

test('preview serves downloadable resources with correct types and unchanged bytes', async t => {
  const sample = fixture(t);
  const examples = [
    ['download.zip', 'application/zip', zipFiles(new Map([['SKILL.md', 'instructions']]))],
    ['aisgym.ipynb', 'application/x-ipynb+json', Buffer.from('{"cells":[]}')],
    ['SKILL.md', 'text/plain; charset=utf-8', Buffer.from('# skill')],
  ];
  for (const [name, , bytes] of examples) sample.write('resources/' + name, bytes);
  const server = createServer(sample.root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [name, type, bytes] of examples) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/resources/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
});
