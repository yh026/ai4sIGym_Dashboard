const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gzipSync } = require("node:zlib");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const skillRoot = join(repositoryRoot, "payload-dashboard-kit");
const compilerPath = join(skillRoot, "scripts", "render-dashboard.mjs");
const corePath = join(skillRoot, "scripts", "lib", "payload-v3.mjs");
const recipesPath = join(skillRoot, "scripts", "lib", "v3-recipes.mjs");
const references = join(skillRoot, "references");
const pcaFixturePath = join(references, "payload-v3-pca.fixture.json");
const capabilityFixturePath = join(references, "payload-v3-capabilities.fixture.json");
const goldenFixtures = [
  ["payload-v3-pca.fixture.json", 6, 11],
  ["payload-v3-embedding-sweep.fixture.json", 6, 6],
  ["payload-v3-model-validation.fixture.json", 4, 10]
];

let compiler;
let core;
let recipes;

test.before(async () => {
  [compiler, core, recipes] = await Promise.all([
    import(pathToFileURL(compilerPath)),
    import(pathToFileURL(corePath)),
    import(pathToFileURL(recipesPath))
  ]);
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function makeCanvasPayload() {
  const payload = await readJson(pcaFixturePath);
  const figure = payload.figures[0];
  figure.recipe = "generic.figure@1";
  delete figure.recipe_config;
  figure.layout = { type: "single", columns: 1, gap: 16 };
  figure.interactions = [];
  figure.panels = [{
    id: "canvas-panel",
    type: "plot",
    data_ref: "pca-scree",
    coordinate: { type: "canvas" },
    layers: [{
      id: "canvas-points",
      mark: { type: "point", point_size: 3 },
      encoding: {
        x: { field: "component", type: "ordinal" },
        y: { field: "explained_variance", type: "quantitative" }
      }
    }]
  }];
  return payload;
}

test("Payload v3 PCA fixture validates and expands every panel and layer", async () => {
  const payload = await readJson(pcaFixturePath);
  const validation = core.validatePayloadV3(payload);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.manifest.schema_version, "3.0.0");
  assert.equal(validation.manifest.section_count, 1);
  assert.equal(validation.manifest.figure_count, 1);
  assert.equal(validation.manifest.panel_count, 6);
  assert.equal(validation.manifest.layer_count, 11);

  const ir = core.normalizePayloadV3(payload, { validation });
  assert.equal(ir.schema_version, "3.0.0");
  assert.deepEqual(ir.sections[0].figure_refs, ["pca-diagnostics"]);
  assert.equal(ir.figures[0].panels.length, 6);
  const macroFigure = structuredClone(payload.figures[0]);
  macroFigure.panels = [];
  macroFigure.interactions = [];
  const cumulativeLine = recipes.defaultRecipeRegistry.expand(macroFigure, { path: "/figures/0" })
    .find((panel) => panel.id === "scree")
    .layers.find((layer) => layer.id === "cumulative-line");
  assert.equal(cumulativeLine.mark.point, true);
  assert.equal(cumulativeLine.mark.point_size, 2.6);
});

test("all v3 golden fixtures validate, normalize, and compile through one entrypoint", async () => {
  for (const [filename, panelCount, layerCount] of goldenFixtures) {
    const path = join(references, filename);
    const payload = await readJson(path);
    const validation = core.validatePayloadV3(payload);
    assert.deepEqual(validation.errors, [], filename);
    assert.equal(validation.manifest.panel_count, panelCount, filename);
    assert.equal(validation.manifest.layer_count, layerCount, filename);
    const ir = core.normalizePayloadV3(payload, { validation });
    assert.equal(ir.figures[0].panels.length, panelCount, filename);
    const receipt = await compiler.buildDashboard({ inputPath: path, validateOnly: true });
    assert.equal(receipt.figure_count, 1, filename);
    assert.equal(receipt.panel_count, panelCount, filename);
    assert.equal(receipt.layer_count, layerCount, filename);
    if (filename === "payload-v3-embedding-sweep.fixture.json") {
      assert.equal(validation.manifest.interaction_count, 3, filename);
      assert.equal(validation.manifest.interactive_figure_count, 1, filename);
      assert.equal(receipt.interaction_count, 3, filename);
      assert.equal(receipt.interactive_figure_count, 1, filename);
    }
    if (filename === "payload-v3-model-validation.fixture.json") {
      assert.equal(validation.manifest.interaction_count, 4, filename);
      assert.equal(validation.manifest.interactive_figure_count, 1, filename);
      assert.equal(receipt.interaction_count, 4, filename);
      assert.equal(receipt.interactive_figure_count, 1, filename);
    }
    assert.deepEqual(receipt.warnings, [], filename);
  }
});

test("renderer capability fixture validates, normalizes, compiles, and reports exact coverage", async (context) => {
  const payload = await readJson(capabilityFixturePath);
  const validation = core.validatePayloadV3(payload);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.manifest.schema_version, "3.0.0");
  assert.equal(validation.manifest.data_source_count, 11);
  assert.equal(validation.manifest.section_count, 1);
  assert.equal(validation.manifest.figure_count, 1);
  assert.equal(validation.manifest.panel_count, 10);
  assert.equal(validation.manifest.layer_count, 11);
  assert.equal(validation.manifest.interaction_count, 6);
  assert.equal(validation.manifest.interactive_figure_count, 1);
  assert.equal(validation.manifest.sidecar_count, 0);
  assert.deepEqual(validation.manifest.recipes, { "generic.figure@1": 1 });
  assert.deepEqual(validation.manifest.marks, {
    band: 1,
    bar: 1,
    boxplot: 1,
    errorbar: 1,
    link: 1,
    node: 2,
    point: 3,
    polygon: 1
  });

  const ir = core.normalizePayloadV3(payload, { validation });
  assert.equal(ir.figures[0].panels.length, 10);
  assert.equal(ir.figures[0].interactions.length, 6);
  assert.equal(ir.figures[0].panels.find((panel) => panel.id === "canvas-panel").coordinate.type, "canvas");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-capabilities-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const output = join(temporaryDirectory, "capabilities.html");
  const receipt = await compiler.buildDashboard({ inputPath: capabilityFixturePath, outputPath: output });
  assert.equal(receipt.data_source_count, 11);
  assert.equal(receipt.figure_count, 1);
  assert.equal(receipt.panel_count, 10);
  assert.equal(receipt.layer_count, 11);
  assert.equal(receipt.interaction_count, 6);
  assert.equal(receipt.interactive_figure_count, 1);
  assert.deepEqual(receipt.warnings, []);
  assert.ok(receipt.output_bytes > 0);
  assert.match(await readFile(output, "utf8"), /"type":"canvas"/);
});

test("unknown v3 marks and field bindings fail closed at precise paths", async () => {
  const unknownMark = await readJson(pcaFixturePath);
  unknownMark.figures[0].panels[0].layers[0].mark.type = "surprise";
  const markValidation = core.validatePayloadV3(unknownMark);
  assert.ok(markValidation.errors.some((error) => error.code === "unknown_mark" && error.path.includes("/mark/type")));

  const unknownField = await readJson(pcaFixturePath);
  unknownField.figures[0].panels[0].layers[0].encoding.y.field = "not_a_field";
  const fieldValidation = core.validatePayloadV3(unknownField);
  assert.ok(fieldValidation.errors.some((error) => error.code === "unknown_field" && error.path.includes("/encoding/y/field")));

  const wrongCoordinate = await readJson(pcaFixturePath);
  wrongCoordinate.figures[0].panels[1].coordinate.type = "cartesian";
  const coordinateValidation = core.validatePayloadV3(wrongCoordinate);
  assert.ok(coordinateValidation.errors.some((error) =>
    error.code === "unsupported_mark_coordinate" && error.path.includes("/panels/1/layers/0/mark/type")
  ));
});

test("checked-in JSON Schema rejects unknown top-level keys and missing report requirements", async (context) => {
  const unknownTopLevel = await readJson(pcaFixturePath);
  unknownTopLevel.undocumented = true;
  const unknownValidation = core.validatePayloadV3(unknownTopLevel);
  assert.ok(unknownValidation.errors.some((error) =>
    error.code === "schema_additional_property" && error.path === "/undocumented"
  ));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-schema-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const invalidInput = join(temporaryDirectory, "payload.json");
  await writeFile(invalidInput, JSON.stringify(unknownTopLevel), "utf8");
  await assert.rejects(
    () => compiler.buildDashboard({ inputPath: invalidInput, validateOnly: true }),
    /\/undocumented \[schema_additional_property\]/
  );

  const missingReport = await readJson(pcaFixturePath);
  delete missingReport.report;
  const missingReportValidation = core.validatePayloadV3(missingReport);
  assert.ok(missingReportValidation.errors.some((error) =>
    error.code === "schema_required" && error.path === "/report"
  ));

  const missingTitle = await readJson(pcaFixturePath);
  delete missingTitle.report.title;
  const missingTitleValidation = core.validatePayloadV3(missingTitle);
  assert.ok(missingTitleValidation.errors.some((error) =>
    error.code === "schema_required" && error.path === "/report/title"
  ));
});

test("JSON Schema rejects extra interaction properties at a precise pointer", async () => {
  const payload = await readJson(pcaFixturePath);
  payload.figures[0].interactions[0].callback = "alert(1)";
  const validation = core.validatePayloadV3(payload);
  assert.ok(validation.errors.some((error) =>
    error.code === "schema_additional_property"
      && error.path === "/figures/0/interactions/0/callback"
  ));
});

test("interaction fields and parameter controls validate against every target data source", async () => {
  const embeddingPath = join(references, "payload-v3-embedding-sweep.fixture.json");
  const unknownTooltipField = await readJson(embeddingPath);
  unknownTooltipField.figures[0].interactions = [{
    id: "bad-tooltip",
    type: "tooltip",
    targets: ["tsne-10-panel/tsne-10-points"],
    fields: ["not_declared"],
    mode: "nearest"
  }];
  const fieldValidation = core.validatePayloadV3(unknownTooltipField);
  assert.ok(fieldValidation.errors.some((error) =>
    error.code === "interaction_unknown_field" && error.path.endsWith("/fields/0")
  ));

  const invalidRange = await readJson(embeddingPath);
  invalidRange.figures[0].interactions = [{
    id: "bad-range",
    type: "parameter",
    parameter: "parameter",
    control: "range",
    label: "Neighborhood size",
    minimum: 5,
    maximum: 50,
    default: 80,
    targets: ["umap-15-panel/umap-15-points"]
  }];
  const rangeValidation = core.validatePayloadV3(invalidRange);
  assert.ok(rangeValidation.errors.some((error) => error.code === "parameter_range_number" && error.path.endsWith("/step")));
  assert.ok(rangeValidation.errors.some((error) => error.code === "parameter_default_range" && error.path.endsWith("/default")));

  const invalidSelect = await readJson(embeddingPath);
  invalidSelect.figures[0].interactions = [{
    id: "bad-select",
    type: "parameter",
    parameter: "parameter",
    control: "select",
    options: [5, 15],
    default: 50,
    targets: ["umap-15-panel/umap-15-points"]
  }];
  const selectValidation = core.validatePayloadV3(invalidSelect);
  assert.ok(selectValidation.errors.some((error) => error.code === "parameter_default_option" && error.path.endsWith("/default")));

  const mismatchedLinkedType = await readJson(capabilityFixturePath);
  const logData = mismatchedLinkedType.data.find((entry) => entry.id === "positive-log-points");
  logData.fields.find((field) => field.name === "sample_id").type = "integer";
  logData.storage.rows.forEach((row, index) => { row.sample_id = index + 1; });
  const linkedTypeValidation = core.validatePayloadV3(mismatchedLinkedType);
  assert.ok(linkedTypeValidation.errors.some((error) => error.code === "interaction_field_type_mismatch"));

  const duplicateLinkedTarget = await readJson(capabilityFixturePath);
  const linked = duplicateLinkedTarget.figures[0].interactions.find((interaction) => interaction.type === "linked_highlight");
  linked.targets = ["continuous-scatter/scatter-points", { panel_id: "continuous-scatter", layer_id: "scatter-points" }];
  const duplicateTargetValidation = core.validatePayloadV3(duplicateLinkedTarget);
  assert.ok(duplicateTargetValidation.errors.some((error) => error.code === "linked_highlight_distinct_targets"));

  const emptyParameterTargets = await readJson(embeddingPath);
  emptyParameterTargets.figures[0].interactions = [{
    id: "empty-targets",
    type: "parameter",
    parameter: "parameter",
    control: "select",
    options: [5, 15],
    default: 5,
    targets: []
  }];
  const emptyTargetValidation = core.validatePayloadV3(emptyParameterTargets);
  assert.ok(emptyTargetValidation.errors.some((error) => error.code === "schema_min_items" && error.path.endsWith("/targets")));

  const pointerCanvas = await makeCanvasPayload();
  pointerCanvas.figures[0].interactions = [{
    id: "pointer-tooltip",
    type: "tooltip",
    mode: "pointer",
    targets: ["canvas-panel/canvas-points"],
    fields: ["component"]
  }];
  const pointerCanvasValidation = core.validatePayloadV3(pointerCanvas);
  assert.ok(pointerCanvasValidation.errors.some((error) => error.code === "canvas_tooltip_mode" && error.path.endsWith("/mode")));
});

test("unimplemented transforms and layouts fail before normalization", async () => {
  const transformPayload = await readJson(pcaFixturePath);
  transformPayload.figures[0].panels[0].transform = [{ op: "aggregate", measures: [{ op: "count", as: "n" }] }];
  const transformValidation = core.validatePayloadV3(transformPayload);
  assert.ok(transformValidation.errors.some((error) =>
    error.code === "unsupported_transform" || error.code === "schema_one_of"
  ));

  const layoutPayload = await readJson(pcaFixturePath);
  layoutPayload.figures[0].layout = { type: "grid", columns: 2, rows: 2, gap: 16 };
  const layoutValidation = core.validatePayloadV3(layoutPayload);
  assert.ok(layoutValidation.errors.some((error) => error.code === "layout_capacity"));

  const unknownLayoutField = await readJson(pcaFixturePath);
  unknownLayoutField.figures[0].layout.width = 1200;
  const unknownLayoutValidation = core.validatePayloadV3(unknownLayoutField);
  assert.ok(unknownLayoutValidation.errors.some((error) =>
    error.code === "schema_additional_property" && error.path.endsWith("/layout/width")
  ));

  const hashWithoutKey = await readJson(pcaFixturePath);
  hashWithoutKey.figures[0].panels[0].transform = [{ op: "sample", method: "hash", size: 2 }];
  const hashValidation = core.validatePayloadV3(hashWithoutKey);
  assert.ok(hashValidation.errors.some((error) => error.code === "sample_key_required" && error.path.endsWith("/key")));

  const unboundedStride = await readJson(pcaFixturePath);
  unboundedStride.figures[0].panels[0].transform = [{ op: "sample", method: "stride" }];
  const strideValidation = core.validatePayloadV3(unboundedStride);
  assert.ok(strideValidation.errors.some((error) => error.code === "sample_stride_bound"));
});

test("runtime-backed visual properties are a closed schema surface", async () => {
  const cases = [
    ["/figures/0/panels/0/layers/0/encoding/x/aggregate", (payload) => { payload.figures[0].panels[0].layers[0].encoding.x.aggregate = "mean"; }],
    ["/figures/0/panels/0/layers/0/encoding/x/data", (payload) => { payload.figures[0].panels[0].layers[0].encoding.x.data = "pca-loadings"; }],
    ["/figures/0/panels/0/layers/0/encoding/x/axis/orient", (payload) => { payload.figures[0].panels[0].layers[0].encoding.x.axis.orient = "bottom"; }],
    ["/figures/0/panels/1/layers/0/encoding/color/legend/orient", (payload) => { payload.figures[0].panels[1].layers[0].encoding.color.legend.orient = "right"; }],
    ["/figures/0/panels/0/layers/0/mark/filled", (payload) => { payload.figures[0].panels[0].layers[0].mark.filled = true; }],
    ["/figures/0/panels/0/coordinate/transpose", (payload) => { payload.figures[0].panels[0].coordinate.transpose = true; }],
    ["/figures/0/layout/shared_scales", (payload) => { payload.figures[0].layout.shared_scales = true; }],
    ["/figures/0/scales/0/nice", (payload) => { payload.figures[0].scales = [{ id: "bad-scale", type: "linear", nice: true }]; }],
    ["/figures/0/annotations", (payload) => { payload.figures[0].annotations = []; }]
  ];
  for (const [path, mutate] of cases) {
    const payload = await readJson(pcaFixturePath);
    mutate(payload);
    const validation = core.validatePayloadV3(payload);
    assert.ok(validation.errors.some((error) => error.code === "schema_additional_property" && error.path === path), path);
  }

  const numericRange = await readJson(pcaFixturePath);
  numericRange.figures[0].scales = [{ id: "pixel-range", type: "linear", range: [0, 100] }];
  const rangeValidation = core.validatePayloadV3(numericRange);
  assert.ok(rangeValidation.errors.some((error) => error.code === "schema_type" && error.path === "/figures/0/scales/0/range/0"));
});

test("declared scale domains fail before browser-time scale construction", async () => {
  const valid = await readJson(pcaFixturePath);
  valid.figures[0].scales = [
    { id: "numeric", type: "linear", domain: [0, 1] },
    { id: "temporal", type: "utc", domain: ["2025-01-01", "2025-12-31"] },
    { id: "classes", type: "ordinal", domain: ["candidate", "confirmed"] }
  ];
  assert.deepEqual(core.validatePayloadV3(valid).errors, []);

  const invalid = await readJson(pcaFixturePath);
  invalid.figures[0].scales = [
    { id: "log-zero", type: "log", domain: [0, 10] },
    { id: "sqrt-negative", type: "sqrt", domain: [-1, 10] },
    { id: "bad-time", type: "time", domain: ["not-a-date", "2025-01-01"] },
    { id: "duplicate-class", type: "band", domain: ["a", "a"] }
  ];
  const validation = core.validatePayloadV3(invalid);
  assert.ok(validation.errors.some((error) => error.code === "scale_domain_log" && error.path.endsWith("/scales/0/domain")));
  assert.ok(validation.errors.some((error) => error.code === "scale_domain_sqrt" && error.path.endsWith("/scales/1/domain")));
  assert.ok(validation.errors.some((error) => error.code === "scale_domain_temporal" && error.path.endsWith("/scales/2/domain")));
  assert.ok(validation.errors.some((error) => error.code === "scale_domain_duplicate" && error.path.endsWith("/scales/3/domain/1")));
});

test("scale types and materialized values are preflighted even without an explicit domain", async () => {
  const logPayload = await readJson(pcaFixturePath);
  logPayload.data[0].storage.rows[0].component = 0;
  logPayload.figures[0].scales = [{ id: "component-log", type: "log" }];
  logPayload.figures[0].panels[0].layers.forEach((layer) => { if (layer.encoding.x) layer.encoding.x.scale_id = "component-log"; });
  const logValidation = core.validatePayloadV3(logPayload);
  assert.ok(logValidation.errors.some((error) => error.code === "scale_data_log"
    && error.path.endsWith("/panels/0/layers/0/encoding/x")));

  const sqrtPayload = await readJson(pcaFixturePath);
  sqrtPayload.data[0].storage.rows[0].explained_variance = -0.1;
  sqrtPayload.figures[0].scales = [{ id: "variance-sqrt", type: "sqrt" }];
  sqrtPayload.figures[0].panels[0].layers.forEach((layer) => { if (layer.encoding.y) layer.encoding.y.scale_id = "variance-sqrt"; });
  const sqrtValidation = core.validatePayloadV3(sqrtPayload);
  assert.ok(sqrtValidation.errors.some((error) => error.code === "scale_data_sqrt"
    && error.path.endsWith("/panels/0/layers/0/encoding/y")));

  const incompatible = await readJson(pcaFixturePath);
  incompatible.figures[0].scales = [{ id: "categorical-y", type: "band" }];
  incompatible.figures[0].panels[0].layers.forEach((layer) => { if (layer.encoding.y) layer.encoding.y.scale_id = "categorical-y"; });
  const typeValidation = core.validatePayloadV3(incompatible);
  assert.ok(typeValidation.errors.some((error) => error.code === "scale_channel_type"
    && error.path.endsWith("/panels/0/layers/0/encoding/y/scale_id")));
});

test("recipe configs reject unknown binding roles, parameter names, and wrong types", async () => {
  const roleTypo = await readJson(pcaFixturePath);
  roleTypo.figures[0].recipe_config.bindings.scree.varianc = "explained_variance";
  const roleValidation = core.validatePayloadV3(roleTypo);
  assert.ok(roleValidation.errors.some((error) => error.code === "unknown_property"
    && error.path === "/figures/0/recipe_config/bindings/scree/varianc"));

  const parameterTypo = await readJson(pcaFixturePath);
  parameterTypo.figures[0].recipe_config.params.variance_treshold = 0.9;
  const typoValidation = core.validatePayloadV3(parameterTypo);
  assert.ok(typoValidation.errors.some((error) => error.code === "unknown_property"
    && error.path === "/figures/0/recipe_config/params/variance_treshold"));

  const wrongType = await readJson(pcaFixturePath);
  wrongType.figures[0].recipe_config.params.variance_threshold = "0.9";
  const typeValidation = core.validatePayloadV3(wrongType);
  assert.ok(typeValidation.errors.some((error) => error.code === "recipe_param_range"
    && error.path === "/figures/0/recipe_config/params/variance_threshold"));

  const genericConfig = await readJson(pcaFixturePath);
  genericConfig.figures[0].recipe = "generic.figure@1";
  genericConfig.figures[0].recipe_config = { params: { columns: 3 } };
  const genericValidation = core.validatePayloadV3(genericConfig);
  assert.ok(genericValidation.errors.some((error) => error.code === "generic_recipe_config"
    && error.path === "/figures/0/recipe_config"));

  const macro = await readJson(pcaFixturePath);
  macro.figures[0].panels = [];
  macro.figures[0].interactions = [];
  const macroValidation = core.validatePayloadV3(macro);
  assert.deepEqual(macroValidation.errors, []);
  assert.equal(macroValidation.manifest.panel_count, 6);
});

test("coordinate capabilities use exact layer counts and canvas is explicit", async () => {
  const duplicateMatrix = await readJson(pcaFixturePath);
  const duplicateCellLayer = JSON.parse(JSON.stringify(duplicateMatrix.figures[0].panels[1].layers[0]));
  duplicateCellLayer.id = "duplicate-cells";
  duplicateMatrix.figures[0].panels[1].layers.push(duplicateCellLayer);
  const matrixValidation = core.validatePayloadV3(duplicateMatrix);
  assert.ok(matrixValidation.errors.some((error) => error.code === "matrix_rect_count"));

  const canvas = await makeCanvasPayload();
  assert.deepEqual(core.validatePayloadV3(canvas).errors, []);
  canvas.figures[0].interactions = [{
    id: "canvas-tooltip",
    type: "tooltip",
    targets: ["canvas-panel/canvas-points"],
    fields: ["component", "explained_variance"],
    mode: "nearest"
  }];
  assert.deepEqual(core.validatePayloadV3(canvas).errors, []);

  canvas.figures[0].panels.push({
    id: "canvas-profile",
    type: "plot",
    data_ref: "pca-scree",
    coordinate: { type: "cartesian" },
    layers: [{
      id: "profile-points",
      mark: { type: "point" },
      encoding: {
        x: { field: "component", type: "ordinal" },
        y: { field: "explained_variance", type: "quantitative" }
      }
    }]
  });
  canvas.figures[0].layout = { type: "grid", columns: 2, gap: 16 };
  canvas.figures[0].interactions = [{
    id: "canvas-linked-highlight",
    type: "linked_highlight",
    targets: ["canvas-panel/canvas-points", "canvas-profile/profile-points"],
    fields: ["component"]
  }];
  assert.deepEqual(core.validatePayloadV3(canvas).errors, []);

  canvas.figures[0].interactions = [{ id: "canvas-zoom", type: "zoom", targets: ["canvas-panel"], axes: "both" }];
  const canvasZoomValidation = core.validatePayloadV3(canvas);
  assert.ok(canvasZoomValidation.errors.some((error) => error.code === "canvas_interaction_unsupported"));

  canvas.figures[0].interactions = [];
  const duplicatePoint = JSON.parse(JSON.stringify(canvas.figures[0].panels[0].layers[0]));
  duplicatePoint.id = "duplicate-points";
  canvas.figures[0].panels[0].layers.push(duplicatePoint);
  const canvasLayerValidation = core.validatePayloadV3(canvas);
  assert.ok(canvasLayerValidation.errors.some((error) => error.code === "canvas_point_count"));

  const tree = await readJson(capabilityFixturePath);
  const treePanel = tree.figures[0].panels.find((panel) => panel.coordinate?.type === "tree");
  assert.deepEqual(core.validatePayloadV3(tree).errors, []);
  treePanel.layers.push({ id: "nodes-2", mark: { type: "node" }, encoding: { key: { field: "id", type: "nominal" } } });
  assert.ok(core.validatePayloadV3(tree).errors.some((error) => error.code === "tree_node_count"));

  const flow = await makeCanvasPayload();
  const flowPanel = flow.figures[0].panels[0];
  flowPanel.type = "diagram";
  flowPanel.coordinate = { type: "flow" };
  flowPanel.layers = [{ id: "stages", mark: { type: "node" }, encoding: { key: { field: "component", type: "ordinal" } } }];
  assert.deepEqual(core.validatePayloadV3(flow).errors, []);
  flowPanel.layers.push({ id: "ignored-links", mark: { type: "link" }, encoding: { from: { field: "component", type: "ordinal" }, to: { field: "component", type: "ordinal" } } });
  assert.ok(core.validatePayloadV3(flow).errors.some((error) => error.code === "unsupported_mark_coordinate"));
});

test("tree topology fails closed for duplicate keys, unknown endpoints, multiple roots, cycles, and disconnected nodes", async () => {
  const source = (payload, id) => payload.data.find((entry) => entry.id === id);

  const valid = await readJson(capabilityFixturePath);
  assert.deepEqual(core.validatePayloadV3(valid).errors, []);

  const duplicateKey = await readJson(capabilityFixturePath);
  source(duplicateKey, "tree-nodes").storage.rows[1].id = "root";
  assert.ok(core.validatePayloadV3(duplicateKey).errors.some((error) =>
    error.code === "tree_duplicate_node_key" && error.path.endsWith("/storage/rows/1/id")
  ));

  const unknownEndpoint = await readJson(capabilityFixturePath);
  source(unknownEndpoint, "tree-links").storage.rows[0].target = "missing";
  assert.ok(core.validatePayloadV3(unknownEndpoint).errors.some((error) =>
    error.code === "tree_unknown_link_endpoint" && error.path.endsWith("/storage/rows/0/target")
  ));

  const multipleRoots = await readJson(capabilityFixturePath);
  const multipleRootLinks = source(multipleRoots, "tree-links").storage.rows;
  source(multipleRoots, "tree-links").storage.rows = multipleRootLinks.filter((edge) => edge.target !== "right");
  assert.ok(core.validatePayloadV3(multipleRoots).errors.some((error) => error.code === "tree_root_count"));

  const cycle = await readJson(capabilityFixturePath);
  source(cycle, "tree-links").storage.rows.push({ source: "leaf", target: "root" });
  assert.ok(core.validatePayloadV3(cycle).errors.some((error) => error.code === "tree_cycle"));

  const disconnected = await readJson(capabilityFixturePath);
  source(disconnected, "tree-links").storage.rows = [
    { source: "root", target: "left" },
    { source: "left", target: "leaf" },
    { source: "right", target: "right" }
  ];
  const disconnectedErrors = core.validatePayloadV3(disconnected).errors;
  assert.ok(disconnectedErrors.some((error) => error.code === "tree_cycle"));
  assert.ok(disconnectedErrors.some((error) => error.code === "tree_disconnected"));
});

test("zoom and parameter controls match runtime and physical field capabilities", async () => {
  const pca = await readJson(pcaFixturePath);
  pca.figures[0].interactions = [{ id: "x-only", type: "zoom", targets: ["pca-circle-panel"], axes: "x" }];
  const zoomValidation = core.validatePayloadV3(pca);
  assert.ok(zoomValidation.errors.some((error) => error.code === "zoom_axes_unsupported" && error.path.endsWith("/axes")));

  const embeddingPath = join(references, "payload-v3-embedding-sweep.fixture.json");
  const stringRange = await readJson(embeddingPath);
  stringRange.figures[0].interactions = [{
    id: "string-range",
    type: "parameter",
    parameter: "disposition",
    control: "range",
    minimum: 0,
    maximum: 10,
    step: 1,
    default: 5,
    targets: ["tsne-10-panel/tsne-10-points"]
  }];
  const rangeValidation = core.validatePayloadV3(stringRange);
  assert.ok(rangeValidation.errors.some((error) => error.code === "parameter_field_type"));

  const integerSelect = await readJson(embeddingPath);
  integerSelect.figures[0].interactions = [{
    id: "string-select",
    type: "parameter",
    parameter: "parameter",
    control: "select",
    options: ["15"],
    default: "15",
    targets: ["umap-15-panel/umap-15-points"]
  }];
  const selectValidation = core.validatePayloadV3(integerSelect);
  assert.ok(selectValidation.errors.some((error) => error.code === "parameter_value_type" && error.path.endsWith("/default")));
  assert.ok(selectValidation.errors.some((error) => error.code === "parameter_value_type" && error.path.endsWith("/options/0")));
});

test("v3 build is deterministic, standalone, and embeds normalized IR", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-build-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const payload = await readJson(pcaFixturePath);
  payload.report.title = "Safe </script><script>alert(1)</script>";
  const input = join(temporaryDirectory, "payload.json");
  const firstOutput = join(temporaryDirectory, "first.html");
  const secondOutput = join(temporaryDirectory, "second.html");
  await writeFile(input, JSON.stringify(payload), "utf8");

  const first = await compiler.buildDashboard({ inputPath: input, outputPath: firstOutput });
  const second = await compiler.buildDashboard({ inputPath: input, outputPath: secondOutput });
  const html = await readFile(firstOutput, "utf8");

  assert.equal(first.schema_version, "3.0.0");
  assert.equal(first.figure_count, 1);
  assert.equal(first.panel_count, 6);
  assert.equal(first.output_sha256, second.output_sha256);
  assert.equal(html, await readFile(secondOutput, "utf8"));
  assert.deepEqual(compiler.verifyStandaloneHtml(html), []);
  assert.match(html, /"ir_version":"3\.0\.0"/);
  assert.match(html, /dashboard-runtime-v3|Standalone visualization package/);
  assert.ok(!html.includes("</script><script>alert(1)</script>"));
  assert.ok(html.includes("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"));

  const inputBefore = await readFile(input, "utf8");
  await assert.rejects(
    () => compiler.buildDashboard({ inputPath: input, outputPath: input }),
    /cannot overwrite payload\.json/
  );
  assert.equal(await readFile(input, "utf8"), inputBefore);
});

test("JSON sidecars are integrity-checked and inlined before standalone compilation", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-sidecar-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const payload = await readJson(pcaFixturePath);
  const source = payload.data[0];
  const rows = source.storage.rows;
  const bytes = Buffer.from(JSON.stringify(rows));
  const sidecarPath = join(temporaryDirectory, "pca-scree.json");
  await writeFile(sidecarPath, bytes);
  source.storage = {
    kind: "sidecar",
    path: "pca-scree.json",
    format: "json",
    compression: "none",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    rows: rows.length
  };
  const input = join(temporaryDirectory, "payload.json");
  const output = join(temporaryDirectory, "report.html");
  await writeFile(input, JSON.stringify(payload), "utf8");

  const result = await compiler.buildDashboard({ inputPath: input, outputPath: output });
  const html = await readFile(output, "utf8");

  assert.equal(result.sidecar_count, 1);
  assert.match(result.bundle_sha256, /^[0-9a-f]{64}$/);
  assert.ok(html.includes('"kind":"inline"'));
  assert.ok(!html.includes('"path":"pca-scree.json"'));
  assert.deepEqual(compiler.verifyStandaloneHtml(html), []);

  const sidecarBefore = await readFile(sidecarPath);
  await assert.rejects(
    () => compiler.buildDashboard({ inputPath: input, outputPath: sidecarPath }),
    /cannot overwrite declared sidecar/
  );
  assert.deepEqual(await readFile(sidecarPath), sidecarBefore);

  payload.data[0].storage.sha256 = "0".repeat(64);
  await writeFile(input, JSON.stringify(payload), "utf8");
  await assert.rejects(() => compiler.buildDashboard({ inputPath: input, validateOnly: true }), /SHA-256 mismatch/);
});

test("gzip JSONL sidecars keep the AI-facing entrypoint compact and compile offline", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-jsonl-gzip-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const payload = await readJson(pcaFixturePath);
  const source = payload.data[0];
  const rows = source.storage.rows;
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const compressed = gzipSync(Buffer.from(jsonl), { mtime: 0 });
  const sidecarName = "pca-scree.jsonl.gz";
  await writeFile(join(temporaryDirectory, sidecarName), compressed);
  source.storage = {
    kind: "sidecar",
    path: sidecarName,
    format: "jsonl",
    compression: "gzip",
    sha256: createHash("sha256").update(compressed).digest("hex"),
    bytes: compressed.length,
    rows: rows.length
  };
  const input = join(temporaryDirectory, "payload.json");
  const output = join(temporaryDirectory, "report.html");
  await writeFile(input, JSON.stringify(payload), "utf8");

  const receipt = await compiler.buildDashboard({ inputPath: input, outputPath: output });
  const html = await readFile(output, "utf8");
  assert.equal(receipt.sidecar_count, 1);
  assert.ok(html.includes('"kind":"inline"'));
  assert.ok(!html.includes(sidecarName));
  assert.deepEqual(compiler.verifyStandaloneHtml(html), []);
});

test("sidecar rows reject undeclared fields and wrong physical types before entering IR", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-v3-sidecar-schema-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const payload = await readJson(pcaFixturePath);
  const source = payload.data[0];
  const originalRows = source.storage.rows;
  const sidecarPath = join(temporaryDirectory, "pca-scree.json");
  const input = join(temporaryDirectory, "payload.json");

  async function writeSidecar(rows) {
    const bytes = Buffer.from(JSON.stringify(rows));
    await writeFile(sidecarPath, bytes);
    source.storage = {
      kind: "sidecar",
      path: "pca-scree.json",
      format: "json",
      compression: "none",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      rows: rows.length
    };
    await writeFile(input, JSON.stringify(payload), "utf8");
  }

  await writeSidecar([{ ...originalRows[0], undeclared: 1 }]);
  await assert.rejects(
    () => compiler.buildDashboard({ inputPath: input, validateOnly: true }),
    (error) => error instanceof core.PayloadV3Error
      && error.diagnostics.some((item) => item.code === "undeclared_field" && item.path.endsWith("/undeclared"))
  );

  await writeSidecar([{ ...originalRows[0], component: "PC1" }]);
  await assert.rejects(
    () => compiler.buildDashboard({ inputPath: input, validateOnly: true }),
    (error) => error instanceof core.PayloadV3Error
      && error.diagnostics.some((item) => item.code === "field_type" && item.path.endsWith("/component"))
  );
});

test("unsafe sidecar paths are rejected before filesystem access", async () => {
  const payload = await readJson(pcaFixturePath);
  payload.data[0].storage = {
    kind: "sidecar",
    path: "../escape.json",
    format: "json",
    compression: "none",
    sha256: "0".repeat(64),
    rows: 1
  };
  const validation = core.validatePayloadV3(payload);
  assert.ok(validation.errors.some((error) => error.code === "unsafe_sidecar_path"));
});
