const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const kitRoot = join(repositoryRoot, "payload-dashboard-kit");
const corePath = join(kitRoot, "scripts", "lib", "payload-v3.mjs");
const capabilitiesPath = join(kitRoot, "scripts", "lib", "v3-capabilities.mjs");
const tessFixturePath = join(kitRoot, "references", "payload-v3-pca.fixture.json");
const starterPath = join(kitRoot, "templates", "generic-package", "payload.json");
const manufacturingPath = join(kitRoot, "examples", "generic-manufacturing", "payload.json");

let core;
let capabilities;

test.before(async () => {
  [core, capabilities] = await Promise.all([
    import(pathToFileURL(corePath)),
    import(pathToFileURL(capabilitiesPath))
  ]);
});

function textOnlyPayload() {
  return {
    schema_version: "3.0.0",
    renderer_contract: {
      name: "render-payload-dashboard",
      version: "3.0.0",
      strict: true
    },
    report: { title: "Factory quality review", claim: "The process is stable." },
    run: { id: "run-001", status: "complete" },
    dataset: { id: "factory", title: "Production lines", row_count: 0 },
    provenance: {
      generator: { name: "quality-pipeline", version: "1.0.0" },
      inputs: []
    },
    theme: {
      name: "generic",
      mode: "dark",
      palette: "colorblind-safe",
      density: "comfortable",
      tokens: {
        accent: "#4F46E5",
        accent_contrast: "#FFFFFFFF",
        background: "#111827",
        surface: "#1F2937",
        surface_muted: "#374151",
        text: "#F9FAFB",
        muted_text: "#D1D5DB",
        border: "#4B5563",
        radius: 12,
        max_width: 1280
      }
    },
    presentation: {
      locale: "zh-CN",
      section_prefix: "步骤",
      show_section_numbers: true,
      show_figure_titles: true,
      show_figure_descriptions: true,
      show_coverage: false,
      show_build_footer: false,
      labels: {
        fold_all: "全部收起",
        unfold_all: "全部展开",
        report_claim: "报告结论",
        coverage: "覆盖范围",
        concepts_used: "使用的概念",
        reports: "报告",
        minimises: "最小化",
        uses: "使用",
        produces: "产生",
        note: "说明",
        top: "返回顶部",
        javascript_required: "需要 JavaScript",
        standalone_package: "独立数据包",
        schema: "规范",
        figures: "图表",
        seed: "随机种子",
        payload_sha256: "Payload SHA-256",
        renderer: "渲染器"
      }
    },
    data: [],
    sections: [{
      id: "summary",
      number: 1,
      title: "Summary",
      summary: "This section intentionally has no chart.",
      figure_ids: [],
      method_notes: [
        { kind: "uses", label: "Input", text: "Verified production records" },
        { kind: "produces", text: "A quality decision" },
        { kind: "note", text: "No placeholder figure is required" }
      ]
    }],
    figures: []
  };
}

test("generic text-only reports validate and preserve presentation and theme tokens in normalized IR", () => {
  const payload = textOnlyPayload();
  const validation = core.validatePayloadV3(payload);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.manifest.section_count, 1);
  assert.equal(validation.manifest.figure_count, 0);
  assert.equal(validation.manifest.panel_count, 0);
  assert.equal(validation.manifest.layer_count, 0);

  const ir = core.normalizePayloadV3(payload, { validation });
  assert.deepEqual(ir.presentation, payload.presentation);
  assert.deepEqual(ir.theme, payload.theme);
  assert.deepEqual(ir.sections[0].figure_refs, []);
  assert.deepEqual(ir.figures, []);
  assert.equal(ir.sections[0].method_notes[0].label, "Input");
});

test("legacy TESS payloads remain valid and normalize with an empty presentation override", async () => {
  const payload = JSON.parse(await readFile(tessFixturePath, "utf8"));
  const validation = core.validatePayloadV3(payload);
  assert.deepEqual(validation.errors, []);

  const ir = core.normalizePayloadV3(payload, { validation });
  assert.deepEqual(ir.theme, payload.theme);
  assert.deepEqual(ir.presentation, {});
});

test("presentation and theme customization remain closed and bounded", () => {
  const invalidTheme = textOnlyPayload();
  invalidTheme.theme.name = "customer-css";
  assert.ok(core.validatePayloadV3(invalidTheme).errors.some((error) =>
    error.code === "schema_enum" && error.path === "/theme/name"
  ));

  const invalidLocale = textOnlyPayload();
  invalidLocale.presentation.locale = "../../en";
  assert.ok(core.validatePayloadV3(invalidLocale).errors.some((error) =>
    error.code === "schema_pattern" && error.path === "/presentation/locale"
  ));

  const unknownLabel = textOnlyPayload();
  unknownLabel.presentation.labels.chart_count = "Charts";
  assert.ok(core.validatePayloadV3(unknownLabel).errors.some((error) =>
    ["schema_additional_property", "unknown_property"].includes(error.code)
      && error.path === "/presentation/labels/chart_count"
  ));

  const unsafeToken = textOnlyPayload();
  unsafeToken.theme.tokens.font_family = "url(https://example.com/font.woff2)";
  assert.ok(core.validatePayloadV3(unsafeToken).errors.some((error) =>
    ["schema_additional_property", "unknown_property"].includes(error.code)
      && error.path === "/theme/tokens/font_family"
  ));

  const badColor = textOnlyPayload();
  badColor.theme.tokens.accent = "red";
  assert.ok(core.validatePayloadV3(badColor).errors.some((error) =>
    error.code === "schema_pattern" && error.path === "/theme/tokens/accent"
  ));

  const tooWide = textOnlyPayload();
  tooWide.theme.tokens.max_width = 2000;
  assert.ok(core.validatePayloadV3(tooWide).errors.some((error) =>
    error.code === "schema_maximum" && error.path === "/theme/tokens/max_width"
  ));
});

test("method-note vocabulary is generic, labelled, selectively unique, and closed", () => {
  const allKinds = textOnlyPayload();
  allKinds.sections[0].method_notes = [
    { kind: "reports", text: "Metric summary" },
    { kind: "minimises", text: "Expected loss" },
    { kind: "uses", label: "Reads", text: "Verified records" },
    { kind: "produces", text: "Decision" },
    { kind: "note", text: "Context" }
  ];
  assert.deepEqual(core.validatePayloadV3(allKinds).errors, []);

  const repeatedUses = textOnlyPayload();
  repeatedUses.sections[0].method_notes.push({ kind: "uses", text: "Another input" });
  assert.deepEqual(core.validatePayloadV3(repeatedUses).errors, []);

  const duplicateReports = textOnlyPayload();
  duplicateReports.sections[0].method_notes.push(
    { kind: "reports", text: "First summary" },
    { kind: "reports", text: "Second summary" }
  );
  assert.ok(core.validatePayloadV3(duplicateReports).errors.some((error) => error.code === "duplicate_method_note"));

  const unknownKey = textOnlyPayload();
  unknownKey.sections[0].method_notes[0].html = "<b>Input</b>";
  assert.ok(core.validatePayloadV3(unknownKey).errors.some((error) =>
    ["schema_additional_property", "unknown_property"].includes(error.code)
      && error.path.endsWith("/method_notes/0/html")
  ));
});

test("panel semantics and formatting fail closed while localized interaction labels remain valid", async () => {
  const starter = JSON.parse(await readFile(starterPath, "utf8"));

  const mismatchedPanel = structuredClone(starter);
  mismatchedPanel.figures[0].panels[0].type = "matrix";
  assert.ok(core.validatePayloadV3(mismatchedPanel).errors.some((error) =>
    error.code === "panel_coordinate_mismatch"
  ));

  const unsupportedEqualAspect = structuredClone(starter);
  unsupportedEqualAspect.figures[0].panels[0].type = "matrix";
  unsupportedEqualAspect.figures[0].panels[0].coordinate = { type: "matrix", equal_aspect: true };
  assert.ok(core.validatePayloadV3(unsupportedEqualAspect).errors.some((error) =>
    error.code === "equal_aspect_coordinate"
  ));

  const unknownFormat = structuredClone(starter);
  unknownFormat.figures[0].panels[0].layers[0].encoding.text.format = "printf:%Q";
  assert.ok(core.validatePayloadV3(unknownFormat).errors.some((error) =>
    ["schema_one_of", "unsupported_format"].includes(error.code)
      && error.path.includes("/encoding/text")
  ));

  const numericAsDate = structuredClone(starter);
  numericAsDate.figures[0].panels[0].layers[0].encoding.y.format = "date";
  assert.ok(core.validatePayloadV3(numericAsDate).errors.some((error) => error.code === "incompatible_format"));

  const categoryAsPercent = structuredClone(starter);
  categoryAsPercent.figures[0].panels[0].layers[0].encoding.x.format = "percent";
  assert.ok(core.validatePayloadV3(categoryAsPercent).errors.some((error) => error.code === "incompatible_format"));

  const localizedZoom = structuredClone(starter);
  localizedZoom.figures[0].panels[0].layers[0].encoding.text.format = ".3f";
  localizedZoom.figures[0].interactions = [{
    id: "zoom-chart",
    type: "zoom",
    label: "缩放",
    targets: ["category-bars/values"],
    axes: "both"
  }];
  assert.deepEqual(core.validatePayloadV3(localizedZoom).errors, []);

  const unverifiableSidecar = JSON.parse(await readFile(manufacturingPath, "utf8"));
  delete unverifiableSidecar.data[0].storage.bytes;
  assert.ok(core.validatePayloadV3(unverifiableSidecar).errors.some((error) =>
    error.code === "schema_required" && error.path === "/data/0/storage/bytes"
  ));
});

test("machine-readable capabilities share the validator's closed surface", () => {
  const value = capabilities.getPayloadV3Capabilities();
  assert.deepEqual(value, core.getPayloadV3Capabilities());
  assert.doesNotThrow(() => JSON.stringify(value));
  assert.deepEqual(Object.keys(value.marks), [
    "bar", "line", "point", "band", "rule", "rect", "text", "vector",
    "node", "link", "errorbar", "boxplot", "ellipse", "polygon"
  ]);
  assert.ok(value.marks.bar.channels.includes("text"));
  assert.deepEqual(value.marks.bar.properties, ["role", "orient", "opacity"]);
  assert.deepEqual(value.marks.line.properties, ["role", "opacity", "stroke_width", "point", "point_size"]);
  assert.deepEqual(value.marks.bar.required_channel_sets, [["x", "y"]]);
  assert.deepEqual(Object.keys(value.coordinates), ["cartesian", "matrix", "tree", "flow", "canvas"]);
  assert.deepEqual(value.transforms.operations, ["filter", "sort", "sample"]);
  assert.ok(value.channels.formats.named.includes("integer"));
  assert.ok(value.channels.formats.patterns.includes("^\\.(?:[0-9]|1[0-2])[f%]$"));
  assert.ok(value.interactions.types.includes("linked_highlight"));
  assert.ok(value.presentation.label_keys.includes("reset"));
  assert.ok(value.recipes.includes("generic.figure@1"));
  assert.deepEqual(value.storage.formats, ["json", "jsonl"]);
  assert.deepEqual(value.storage.compressions, ["none", "gzip"]);

  value.marks.bar.channels.push("script");
  assert.ok(!capabilities.PAYLOAD_V3_CAPABILITIES.marks.bar.channels.includes("script"));
});

test("literal values, required rows, dates, mark properties, transforms, and scales fail closed", async () => {
  const starter = JSON.parse(await readFile(starterPath, "utf8"));

  const wrongLiteral = structuredClone(starter);
  wrongLiteral.figures[0].panels[0].layers[0].encoding.x = { value: "oops", type: "quantitative" };
  assert.ok(core.validatePayloadV3(wrongLiteral).errors.some((error) => error.code === "incompatible_channel_type"));

  const badTemporalLiteral = structuredClone(starter);
  badTemporalLiteral.figures[0].panels[0].layers[0].encoding.x = { value: "2026-08T00:00:00Z", type: "temporal" };
  assert.ok(core.validatePayloadV3(badTemporalLiteral).errors.some((error) => error.code === "invalid_temporal_constant"));

  const nullablePosition = structuredClone(starter);
  nullablePosition.data[0].fields.find((field) => field.name === "value").nullable = true;
  nullablePosition.data[0].storage.rows[0].value = null;
  assert.ok(core.validatePayloadV3(nullablePosition).errors.some((error) => error.code === "required_channel_value"));

  const unsupportedMarkProperty = structuredClone(starter);
  unsupportedMarkProperty.figures[0].panels[0].layers[0].mark.point_size = 12;
  assert.ok(core.validatePayloadV3(unsupportedMarkProperty).errors.some((error) =>
    error.code === "unknown_property" && error.path.endsWith("/mark/point_size")
  ));

  const lineWithPoints = structuredClone(starter);
  lineWithPoints.figures[0].panels[0].layers[0].mark = {
    type: "line",
    point: true,
    point_size: 3.5
  };
  delete lineWithPoints.figures[0].panels[0].layers[0].encoding.text;
  assert.deepEqual(core.validatePayloadV3(lineWithPoints).errors, []);

  const orphanedLinePointSize = structuredClone(lineWithPoints);
  delete orphanedLinePointSize.figures[0].panels[0].layers[0].mark.point;
  assert.ok(core.validatePayloadV3(orphanedLinePointSize).errors.some((error) =>
    error.code === "line_point_size_requires_point" && error.path.endsWith("/mark/point_size")
  ));

  const transformedOverride = structuredClone(starter);
  transformedOverride.data.push({ ...structuredClone(transformedOverride.data[0]), id: "other-values" });
  transformedOverride.figures[0].panels[0].transform = { op: "filter", field: "category", predicate: { eq: "Alpha" } };
  transformedOverride.figures[0].panels[0].layers[0].data_ref = "other-values";
  assert.ok(core.validatePayloadV3(transformedOverride).errors.some((error) => error.code === "panel_transform_data_override"));

  const ambiguousRule = structuredClone(starter);
  ambiguousRule.figures[0].panels[0].layers[0] = {
    id: "bad-rule",
    mark: { type: "rule" },
    encoding: {
      x: { value: 1, type: "quantitative" },
      x2: { value: 2, type: "quantitative" }
    }
  };
  assert.ok(core.validatePayloadV3(ambiguousRule).errors.some((error) => error.code === "ambiguous_rule_channels"));

  const outsideDomain = structuredClone(starter);
  outsideDomain.figures[0].scales = [{ id: "categories", type: "band", domain: ["Alpha", "Beta"] }];
  outsideDomain.figures[0].panels[0].layers[0].encoding.x.scale_id = "categories";
  assert.ok(core.validatePayloadV3(outsideDomain).errors.some((error) => error.code === "scale_data_domain"));

  const mixedColourTypes = structuredClone(starter);
  mixedColourTypes.figures[0].scales = [{ id: "numeric-colour", type: "linear", domain: [0, 20], range: ["#000000", "#FFFFFF"] }];
  mixedColourTypes.figures[0].panels[0].layers.push({
    id: "numeric-points",
    mark: { type: "point" },
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "value", type: "quantitative" },
      color: { field: "value", type: "quantitative", scale_id: "numeric-colour" }
    }
  });
  assert.ok(core.validatePayloadV3(mixedColourTypes).errors.some((error) => error.code === "mixed_color_channel_types"));

  const mixedColourScaleFamilies = structuredClone(starter);
  mixedColourScaleFamilies.data[0].fields.push({ name: "second_group", type: "string", role: "dimension" });
  mixedColourScaleFamilies.data[0].storage.rows.forEach((row, index) => { row.second_group = index === 1 ? "D" : "C"; });
  mixedColourScaleFamilies.figures[0].scales = [{
    id: "explicit-colour",
    type: "ordinal",
    domain: ["C", "D"],
    range: ["#000000", "#FFFFFF"]
  }];
  mixedColourScaleFamilies.figures[0].panels[0].layers[0].encoding.color = {
    field: "category",
    type: "nominal"
  };
  mixedColourScaleFamilies.figures[0].panels[0].layers.push({
    id: "explicit-colour-points",
    mark: { type: "point" },
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "value", type: "quantitative" },
      color: { field: "second_group", type: "nominal", scale_id: "explicit-colour" }
    }
  });
  assert.ok(core.validatePayloadV3(mixedColourScaleFamilies).errors.some((error) => error.code === "multiple_panel_scales"));
});

test("physical dates and datetimes require exact calendar dates and timezone-qualified ISO values", async () => {
  const starter = JSON.parse(await readFile(starterPath, "utf8"));
  const source = starter.data[0];
  source.fields.push({ name: "observed_at", type: "datetime", role: "dimension" });
  source.storage.rows.forEach((row, index) => { row.observed_at = `2026-08-${String(19 + index).padStart(2, "0")}T00:00:00Z`; });
  assert.deepEqual(core.validatePayloadV3(starter).errors, []);

  source.storage.rows[0].observed_at = "2026-08T00:00:00Z";
  assert.ok(core.validatePayloadV3(starter).errors.some((error) => error.code === "field_type"));
  source.storage.rows[0].observed_at = "2026-02-30T00:00:00Z";
  assert.ok(core.validatePayloadV3(starter).errors.some((error) => error.code === "field_type"));
});
