const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { mkdtemp, readFile, readdir, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(__dirname, "..");
const kitRoot = join(repositoryRoot, "payload-dashboard-kit");
const packageRoot = join(kitRoot, "examples", "tess-real-package");
const compilerPath = join(kitRoot, "scripts", "render-dashboard.mjs");
const sourceSha256 = "56cf0e720c5a3a16e08cb2dd9cafd453662038e85fe7750135991f4805def20c";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRows(resource) {
  const storage = resource.storage;
  const bytes = await readFile(join(packageRoot, storage.path));
  assert.equal(bytes.length, storage.bytes, resource.id);
  assert.equal(sha256(bytes), storage.sha256, resource.id);
  const decoded = storage.compression === "gzip" ? gunzipSync(bytes) : bytes;
  const rows = storage.format === "json"
    ? JSON.parse(decoded.toString("utf8"))
    : decoded.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(rows.length, storage.rows, resource.id);
  return rows;
}

function findLayer(payload, figureId, panelId, layerId) {
  const figure = payload.figures.find(({ id }) => id === figureId);
  const panel = figure.panels.find(({ id }) => id === panelId);
  return panel.layers.find(({ id }) => id === layerId);
}

function findFigure(payload, figureId) {
  return payload.figures.find(({ id }) => id === figureId);
}

function findPanel(payload, figureId, panelId) {
  return findFigure(payload, figureId).panels.find(({ id }) => id === panelId);
}

test("real TESS package is complete, source-grounded, and strictly renderable", { timeout: 60_000 }, async (context) => {
  const payloadBytes = await readFile(join(packageRoot, "payload.json"));
  const payload = JSON.parse(payloadBytes);
  const expectedBuild = JSON.parse(await readFile(join(packageRoot, "expected-build.json"), "utf8"));
  const dataNames = (await readdir(join(packageRoot, "data"))).sort();

  assert.equal(payload.schema_version, "3.0.0");
  assert.equal(payload.sections.length, 20);
  assert.equal(payload.figures.length, 24);
  assert.equal(payload.data.length, 69);
  assert.equal(dataNames.length, 69);
  assert.equal(payload.report.title, "TESS Objects of Interest — AIS5102 method spine");
  assert.deepEqual(payload.acts.map(({ numeral, title }) => [numeral, title]), [
    ["I", "Frame"],
    ["II", "Reduce"],
    ["III", "Partition"],
    ["IV", "Predict"]
  ]);
  const structureSection = payload.sections.find(({ id }) => id === "stage-03");
  assert.equal(payload.sections.find(({ id }) => id === "stage-00").figure_position, "after_findings");
  assert.equal(structureSection.title, "Structure survey");
  assert.equal(structureSection.badge, "Ch 03, 04");
  assert.equal(structureSection.concepts.length, 2);
  assert.ok(structureSection.findings.length > 0);
  assert.match(JSON.stringify(payload.provenance), new RegExp(sourceSha256));
  assert.doesNotMatch(JSON.stringify(payload), /controlled illustrative data/i);

  const declaredNames = payload.data
    .map(({ storage }) => storage.path.replace(/^data\//, ""))
    .sort();
  assert.deepEqual(dataNames, declaredNames);
  await Promise.all(payload.data.map(readRows));

  const byId = new Map(payload.data.map((resource) => [resource.id, resource]));
  const baselineFields = byId.get("baseline-two-feature").fields.map(({ name }) => name);
  assert.ok(baselineFields.includes("radius_log"));
  assert.ok(!baselineFields.includes("period_log"));

  const transit = findFigure(payload, "stage00-transit-question");
  assert.deepEqual(transit.layout.column_weights, [0.43, 0.57]);
  assert.equal(findPanel(payload, "stage00-transit-question", "transit-brightness").layers.length, 10);
  assert.deepEqual(findFigure(payload, "stage00-label-taxonomy").layout.column_weights, [0.62, 0.38]);
  assert.equal(findLayer(payload, "stage00-label-taxonomy", "disposition-counts", "count-labels").mark.type, "text");

  const structure = findFigure(payload, "stage03-structure");
  assert.deepEqual(structure.layout.column_weights, [1, 1, 1.08]);
  assert.deepEqual(structure.scales.find(({ id }) => id === "correlation-color").domain, [-1, 1]);
  assert.equal(structure.scales.find(({ id }) => id === "mi-color").scheme, "sequential");
  const uncertaintyPanel = findPanel(payload, "stage03-structure", "uncertainty");
  assert.equal(findLayer(payload, "stage03-structure", "uncertainty", "intervals").mark.type, "bar");
  assert.deepEqual(uncertaintyPanel.transform, [{
    op: "filter",
    field: "feature",
    predicate: { neq: "pm_total" }
  }]);
  const labelledBarLayers = payload.figures.flatMap(({ panels }) => panels)
    .flatMap(({ layers }) => layers)
    .filter(({ mark, encoding }) => mark.type === "bar" && encoding.text);
  assert.equal(labelledBarLayers.length, 10);
  assert.equal(findLayer(payload, "stage08-geometry", "density", "density-bars").encoding.text, undefined);

  const discreteLineNodes = [
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
  for (const location of discreteLineNodes) {
    const mark = findLayer(payload, ...location).mark;
    assert.equal(mark.point, true, location.join("/"));
    assert.equal(mark.point_size, 2.6, location.join("/"));
  }
  for (const location of [
    ["stage00-transit-question", "transit-brightness", "brightness"],
    ["stage05-baseline", "loss", "loss-line"],
    ["stage08-geometry", "k-distance", "distance-line"],
    ["stage08-geometry", "metric-comparison", "metric-lines"],
    ["stage16-interpretable-models", "roc", "roc-lines"]
  ]) assert.notEqual(findLayer(payload, ...location).mark.point, true, location.join("/"));
  assert.equal(findLayer(payload, "stage18-validation", "calibration", "observed-points").mark.type, "point");
  assert.equal(
    (await readRows(byId.get("silhouette-null"))).length + (await readRows(byId.get("gmm-bic"))).length,
    27,
    "Stage 13 renders one visible line node for each silhouette and BIC row"
  );

  assert.deepEqual(await readRows(byId.get("quality-rule-removals")), [
    { removed: 0, rule: "Exact duplicate" },
    { removed: 0, rule: "Duration >= period" },
    { removed: 1, rule: "st_rad > 100 R_sun" },
    { removed: 5, rule: "st_teff > 20,000 K" },
    { removed: 2, rule: "Missing disposition" }
  ]);
  assert.deepEqual(await readRows(byId.get("split-leakage")), [
    { shared_hosts: 41, strategy: "Stratified rows" },
    { shared_hosts: 0, strategy: "Grouped by TIC ID" }
  ]);

  const epsilon = findLayer(
    payload, "stage08-geometry", "k-distance", "epsilon"
  ).encoding.y.value;
  assert.ok(epsilon > 2.22 && epsilon < 2.23);
  const randomNull = findLayer(
    payload, "stage10-embedding-validation", "neighbourhood-quality", "random-null"
  ).encoding.y.value;
  assert.ok(randomNull > 0.78 && randomNull < 0.80);
  const majority = findLayer(
    payload, "stage18-validation", "cv", "majority"
  ).encoding.y.value;
  assert.equal(majority, 0.5);
  const baseRate = findLayer(
    payload, "stage14-vector-quantisation-a", "planet-fraction", "base-rate"
  ).encoding.y.value;
  assert.ok(Math.abs(baseRate - (1033 / 2239)) < 1e-12);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "tess-real-acceptance-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputPath = join(temporaryRoot, "dashboard.html");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    compilerPath,
    "--input", join(packageRoot, "payload.json"),
    "--output", outputPath,
    "--strict"
  ], { cwd: kitRoot, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(stderr, "");
  const receipt = JSON.parse(stdout);
  assert.deepEqual({
    sections: receipt.section_count,
    figures: receipt.figure_count,
    panels: receipt.panel_count,
    layers: receipt.layer_count,
    dataSources: receipt.data_source_count,
    sidecars: receipt.sidecar_count,
    interactions: receipt.interaction_count,
    interactiveFigures: receipt.interactive_figure_count
  }, {
    sections: 20,
    figures: 24,
    panels: 73,
    layers: 116,
    dataSources: 69,
    sidecars: 69,
    interactions: 5,
    interactiveFigures: 1
  });
  assert.deepEqual(receipt.warnings, []);
  assert.equal(expectedBuild.payload_sha256, receipt.payload_sha256);
  assert.equal(expectedBuild.bundle_sha256, receipt.bundle_sha256);
  const dashboard = await readFile(outputPath, "utf8");
  const metaMatch = dashboard.match(
    /<script id="dashboard-build-meta" type="application\/json">([^<]+)<\/script>/
  );
  assert.ok(metaMatch, "generated dashboard build metadata");
  const meta = JSON.parse(metaMatch[1]);
  assert.equal(meta.payload_sha256, expectedBuild.payload_sha256);
  assert.equal(meta.bundle_sha256, expectedBuild.bundle_sha256);
  assert.equal(sha256(Buffer.from(dashboard)), receipt.output_sha256);
  assert.deepEqual(await readFile(join(packageRoot, "payload.json")), payloadBytes);
  assert.ok((await stat(outputPath)).size > 20_000_000);
});
