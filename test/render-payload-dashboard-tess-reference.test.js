const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, readdir, realpath, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(__dirname, "..");
const skillRoot = join(repositoryRoot, "payload-dashboard-kit");
const generatorPath = join(skillRoot, "scripts", "generate-tess-reference-package.mjs");
const compilerPath = join(skillRoot, "scripts", "render-dashboard.mjs");

async function runJsonCommand(argumentsList) {
  const { stdout, stderr } = await execFileAsync(process.execPath, argumentsList, {
    cwd: skillRoot,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

async function assertRegularFile(path) {
  const details = await stat(path);
  assert.equal(details.isFile(), true, path);
  assert.ok(details.size > 0, path);
  return details;
}

async function inputTreeDigest(packageDirectory) {
  const dataDirectory = join(packageDirectory, "data");
  const dataFiles = (await readdir(dataDirectory)).sort();
  const relativeFiles = ["payload.json", ...dataFiles.map((name) => `data/${name}`)];
  const hash = createHash("sha256");
  for (const relativePath of relativeFiles) {
    const bytes = await readFile(join(packageDirectory, relativePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return { files: relativeFiles, sha256: hash.digest("hex") };
}

test("TESS reference generator produces the complete deterministic strict package", { timeout: 120_000 }, async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tess-reference-acceptance-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstPackage = join(temporaryRoot, "first");
  const secondPackage = join(temporaryRoot, "second");

  const firstGeneration = await runJsonCommand([generatorPath, "--output", firstPackage]);
  const payloadPath = join(firstPackage, "payload.json");
  const dataDirectory = join(firstPackage, "data");
  const dashboardPath = join(firstPackage, "tess-reference.dashboard.html");
  await Promise.all([
    assertRegularFile(payloadPath),
    assertRegularFile(dashboardPath),
    stat(dataDirectory).then((details) => assert.equal(details.isDirectory(), true))
  ]);

  const payload = JSON.parse(await readFile(payloadPath, "utf8"));
  const sidecarNames = (await readdir(dataDirectory)).sort();
  assert.equal(payload.sections.length, 20);
  assert.equal(payload.figures.length, 24);
  assert.equal(payload.data.length, 69);
  assert.equal(sidecarNames.length, 69);
  assert.ok(sidecarNames.every((name) => name.endsWith(".json")));
  assert.match(await readFile(dashboardPath, "utf8"), /Standalone visualization package/);

  const lineNodeLocations = [
    ["stage06-preprocessing", "scree-comparison", "scree-lines"],
    ["stage10-embedding-validation", "neighbourhood-quality", "quality-curves"],
    ["stage13-partition-validation-a", "silhouette", "curves"],
    ["stage13-partition-validation-a", "bic", "bic-line"],
    ["stage14-vector-quantisation-a", "distortion", "distortion-line"],
    ["stage14-vector-quantisation-b", "reconstruction", "reconstruction-lines"],
    ["stage14-vector-quantisation-b", "map-agreement", "agreement-lines"],
    ["stage16-interpretable-models", "depth-sweep", "depth-lines"],
    ["stage18-validation", "learning", "learning-lines"],
    ["stage19-scientific-close", "time", "fraction-line"]
  ];
  for (const [figureId, panelId, layerId] of lineNodeLocations) {
    const figure = payload.figures.find(({ id }) => id === figureId);
    const panel = figure.panels.find(({ id }) => id === panelId);
    const layer = panel.layers.find(({ id }) => id === layerId);
    assert.equal(layer.mark.point, true, `${figureId}/${panelId}/${layerId}`);
    assert.equal(layer.mark.point_size, 2.6, `${figureId}/${panelId}/${layerId}`);
  }

  const strictOutput = join(temporaryRoot, "strict.dashboard.html");
  const strictReceipt = await runJsonCommand([
    await realpath(compilerPath),
    "--input", payloadPath,
    "--output", strictOutput,
    "--strict"
  ]);
  assert.deepEqual({
    sections: strictReceipt.section_count,
    figures: strictReceipt.figure_count,
    panels: strictReceipt.panel_count,
    layers: strictReceipt.layer_count,
    dataSources: strictReceipt.data_source_count,
    sidecars: strictReceipt.sidecar_count,
    interactions: strictReceipt.interaction_count,
    interactiveFigures: strictReceipt.interactive_figure_count
  }, {
    sections: 20,
    figures: 24,
    panels: 73,
    layers: 103,
    dataSources: 69,
    sidecars: 69,
    interactions: 5,
    interactiveFigures: 1
  });
  assert.deepEqual(strictReceipt.warnings, []);
  await assertRegularFile(strictOutput);
  assert.equal(strictReceipt.output_sha256, firstGeneration.output_sha256);

  const firstInputTree = await inputTreeDigest(firstPackage);
  const secondGeneration = await runJsonCommand([generatorPath, "--output", secondPackage]);
  const secondInputTree = await inputTreeDigest(secondPackage);
  assert.equal(secondGeneration.output_sha256, firstGeneration.output_sha256);
  assert.deepEqual(secondInputTree.files, firstInputTree.files);
  assert.equal(secondInputTree.sha256, firstInputTree.sha256);
});
