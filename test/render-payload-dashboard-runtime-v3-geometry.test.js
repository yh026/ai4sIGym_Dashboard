const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const vm = require("node:vm");

const runtimePath = resolve(__dirname, "..", "payload-dashboard-kit", "assets", "dashboard-runtime-v3.js");
const cssPath = resolve(__dirname, "..", "payload-dashboard-kit", "assets", "dashboard.css");
const corePath = resolve(__dirname, "..", "payload-dashboard-kit", "scripts", "lib", "payload-v3.mjs");
const capabilityFixturePath = resolve(__dirname, "..", "payload-dashboard-kit", "references", "payload-v3-capabilities.fixture.json");

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, toggle() {} };
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener() {}

  querySelector() {
    return null;
  }
}

function loadRuntimeHooks(payload = { schema_version: "3.0.0", data: [], figures: [], sections: [], theme: { palette: "colorblind-safe" } }) {
  const source = readFileSync(runtimePath, "utf8");
  const marker = "  try {\n    buildDashboard();";
  const markerIndex = source.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, "runtime build marker");
  const instrumented = `${source.slice(0, markerIndex)}
  globalThis.__runtimeTestHooks = {
    numericExtent,
    niceLinearDomain,
    ticks,
    formatNumber,
    formatValue,
    formatTemporalValue,
    formatLogTick,
    approximateTextWidth,
    truncateAxisLabel,
    categoricalAxisLabelPlan,
    resolvePalette,
    bandScale,
    barGroups,
    barValueLabelLayout,
    cartesianMargins,
    encodingUsesOnlyConstants,
    layerRows,
    resolveContinuousColorDomain,
    interpolateColor,
    firstFitGridPlacements,
    panelGridPlacement,
    panelRenderWidth,
    panelRenderHeight,
    matrixGeometry,
    renderMatrixPanel,
    renderCartesianPanel,
    renderTreePanel,
    renderFlowPanel,
    colorbarLegend,
    createPanelLegend,
    createSectionPanel
  };
})();`;
  const nodes = {
    "dashboard-payload": {
      textContent: JSON.stringify(payload)
    },
    "dashboard-build-meta": { textContent: "{}" },
    "dashboard-root": {}
  };
  const context = {
    document: {
      getElementById: (id) => nodes[id],
      createElement: (tagName) => new FakeNode(tagName),
      createTextNode: (textContent) => ({ textContent: String(textContent) }),
      createElementNS: (_namespace, tagName) => new FakeNode(tagName)
    }
  };
  vm.runInNewContext(instrumented, context, { filename: runtimePath });
  return context.__runtimeTestHooks;
}

const hooks = loadRuntimeHooks();

function descendantNodes(root) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    result.push(node);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return result;
}

test("fixed percent formatting keeps an explicit decimal place", () => {
  assert.equal(hooks.formatNumber(0, ".1%"), "0.0%");
  assert.equal(hooks.formatNumber(0.014, ".1%"), "1.4%");
  assert.equal(hooks.formatValue(1.2345, ".2f"), "1.23");
  assert.match(hooks.formatTemporalValue("2026-08-19T04:30:00Z", "datetime", true), /2026/);
  assert.notEqual(
    hooks.formatTemporalValue("2026-08-19T04:30:00Z", "datetime", true),
    hooks.formatTemporalValue("2026-08-19T09:30:00Z", "datetime", true),
    "datetime formatting must preserve within-day time differences"
  );
});

test("bar domains retain a true zero baseline and use readable nice ticks", () => {
  const extent = Array.from(hooks.numericExtent([96, 4690], true));
  assert.equal(extent[0], 0);
  assert.ok(extent[1] > 4690);
  assert.deepEqual(Array.from(hooks.niceLinearDomain(extent, 5)), [0, 5000]);
  assert.deepEqual(Array.from(hooks.ticks([0, 5000], 5, false)), [0, 1000, 2000, 3000, 4000, 5000]);

  const negative = Array.from(hooks.numericExtent([-5, -2], true));
  assert.ok(negative[0] < -5);
  assert.equal(negative[1], 0);
  assert.equal(hooks.formatLogTick(0.001), "10\u207b\u00b3");
});

test("bar colour does not imply dodge and reversed bands have a valid top-left origin", () => {
  const rows = [{ category: "PC", series: "A" }, { category: "FP", series: "B" }];
  const colourOnly = hooks.barGroups(rows, { color: { field: "category" } });
  assert.equal(colourOnly.length, 1);
  assert.equal(colourOnly[0][1].length, 2);

  const explicitlyGrouped = hooks.barGroups(rows, { color: { field: "category" }, group: { field: "series" } });
  assert.equal(explicitlyGrouped.length, 2);

  const scale = hooks.bandScale(["Adjudicated", "Open"], [292, 24]);
  for (const category of ["Adjudicated", "Open"]) {
    const start = scale(category);
    const center = scale.center(category);
    assert.ok(start >= 24 && start + scale.bandwidth <= 292);
    assert.ok(Math.abs(center - (start + scale.bandwidth / 2)) < 1e-9);
  }
});

test("line nodes render at every declared row when point is enabled", () => {
  const panel = {
    id: "line-panel",
    data_ref: "series",
    coordinate: { type: "cartesian" },
    layers: [{
      id: "series-line",
      mark: { type: "line", point: true, point_size: 4, opacity: 0.65 },
      encoding: {
        x: { field: "step", type: "quantitative" },
        y: { field: "value", type: "quantitative" }
      }
    }]
  };
  const figure = { id: "line-figure", layout: { type: "single" }, panels: [panel], scales: [], interactions: [] };
  const runtime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [figure],
    data: [{
      id: "series",
      storage: { kind: "inline", format: "rows", rows: [
        { step: 1, value: 2 },
        { step: 2, value: 3 },
        { step: 3, value: 2.5 }
      ] }
    }]
  });
  const svg = runtime.renderCartesianPanel(panel, figure);
  const marks = descendantNodes(svg).filter((node) => node.dataset?.layerId === "series-line");
  assert.equal(marks.filter((node) => node.tagName === "polyline").length, 1);
  const points = marks.filter((node) => node.tagName === "circle");
  assert.equal(points.length, 3);
  assert.ok(points.every((node) => node.attributes.r === "4"));
  assert.ok(points.every((node) => node.attributes.opacity === "0.65"));
});

test("categorical axes reserve label space and truncate before the SVG boundary", () => {
  const panel = {
    id: "long-label-panel",
    data_ref: "comparisons",
    coordinate: { type: "cartesian" },
    layers: [{
      id: "bars",
      mark: { type: "bar", orient: "horizontal" },
      encoding: {
        x: { field: "value", type: "quantitative", axis: { title: "Agreement" } },
        y: { field: "comparison", type: "nominal", axis: { title: "Comparison" } }
      }
    }]
  };
  const figure = { id: "labels-figure", layout: { type: "grid", columns: 3 }, panels: [panel], scales: [], interactions: [] };
  const runtime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [figure],
    data: [{
      id: "comparisons",
      storage: { kind: "inline", format: "rows", rows: [
        { comparison: "K-means versus disposition · normalised mutual information", value: 0.12 },
        { comparison: "Gaussian mixture versus disposition · adjusted Rand index", value: 0.08 }
      ] }
    }]
  });
  const width = runtime.panelRenderWidth(panel, figure, 620);
  const margin = runtime.cartesianMargins(panel, figure, width, 350);
  assert.ok(margin.left > 64, "long nominal labels must expand the left margin");
  assert.ok(width - margin.left - margin.right >= 120, "dynamic margins must retain a readable plot area");

  const svg = runtime.renderCartesianPanel(panel, figure);
  const labels = descendantNodes(svg).filter((node) =>
    node.tagName === "text" && node.attributes["text-anchor"] === "end"
  );
  const categoryLabels = labels.filter((node) => String(node.textContent).includes("…"));
  assert.ok(categoryLabels.length >= 1, "labels that exceed the safe margin are visibly elided");
  for (const label of categoryLabels) {
    assert.ok(label.attributes["data-full-label"], "elided labels retain their full value");
    const estimatedLeft = Number(label.attributes.x) - runtime.approximateTextWidth(label.textContent, 10);
    assert.ok(estimatedLeft >= 20, `axis label ${label.textContent} starts inside the SVG`);
  }
  assert.equal(runtime.truncateAxisLabel("short", 100, 10), "short");
});

test("constant-only layers materialize exactly one row with or without a data reference", () => {
  const payload = {
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [],
    data: [{
      id: "two-rows",
      storage: { kind: "inline", format: "rows", rows: [{ x: 1, group: "A" }, { x: 2, group: "B" }] }
    }]
  };
  const runtime = loadRuntimeHooks(payload);
  const constantEncoding = {
    x: { value: 0, type: "quantitative" },
    y: { value: 1, type: "quantitative" },
    tooltip: [{ value: "fixed", type: "nominal" }]
  };
  assert.equal(runtime.encodingUsesOnlyConstants(constantEncoding), true);
  const synthetic = runtime.layerRows({}, { encoding: constantEncoding });
  assert.equal(synthetic.length, 1);
  assert.deepEqual(Object.keys(synthetic[0]), []);

  const referenced = runtime.layerRows({ data_ref: "two-rows" }, { encoding: constantEncoding });
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].x, 1, "the first materialized row remains available to declared interactions");

  const fieldBound = runtime.layerRows({ data_ref: "two-rows" }, {
    encoding: { x: { field: "x", type: "quantitative" } }
  });
  assert.equal(fieldBound.length, 2);
});

test("constant point, rule, and text layers render once without a data source", () => {
  const panel = {
    id: "constant-panel",
    coordinate: { type: "cartesian" },
    layers: [
      {
        id: "constant-point",
        mark: { type: "point" },
        encoding: { x: { value: 1, type: "quantitative" }, y: { value: 2, type: "quantitative" } }
      },
      {
        id: "constant-rule",
        mark: { type: "rule" },
        encoding: { x: { value: 1.5, type: "quantitative" }, color: { value: "threshold", type: "nominal" } }
      },
      {
        id: "constant-text",
        mark: { type: "text" },
        encoding: {
          x: { value: 1, type: "quantitative" },
          y: { value: 2.5, type: "quantitative" },
          text: { value: "declared", type: "nominal" }
        }
      }
    ]
  };
  const figure = { id: "constant-figure", layout: { type: "single" }, panels: [panel], scales: [], interactions: [] };
  const runtime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    data: [],
    sections: [],
    figures: [figure]
  });
  const svg = runtime.renderCartesianPanel(panel, figure);
  const marks = descendantNodes(svg).filter((node) => node.dataset?.layerId);
  assert.equal(marks.filter((node) => node.dataset.layerId === "constant-point" && node.tagName === "circle").length, 1);
  assert.equal(marks.filter((node) => node.dataset.layerId === "constant-rule" && node.tagName === "line").length, 1);
  assert.equal(marks.filter((node) => node.dataset.layerId === "constant-text" && node.tagName === "text").length, 1);
});

test("rule colour channels resolve per row and constant rules do not repeat", () => {
  const panel = {
    id: "rule-panel",
    data_ref: "rules",
    coordinate: { type: "cartesian" },
    layers: [
      {
        id: "field-rules",
        mark: { type: "rule" },
        encoding: {
          x: { field: "x", type: "quantitative" },
          stroke: { field: "series", type: "nominal" }
        }
      },
      {
        id: "constant-rule-with-data",
        mark: { type: "rule" },
        encoding: {
          x: { value: 1.5, type: "quantitative" },
          color: { value: "threshold", type: "nominal" }
        }
      }
    ]
  };
  const figure = { id: "rules-figure", layout: { type: "single" }, panels: [panel], scales: [], interactions: [] };
  const runtime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [figure],
    data: [{
      id: "rules",
      storage: { kind: "inline", format: "rows", rows: [{ x: 1, series: "A" }, { x: 2, series: "B" }] }
    }]
  });
  const svg = runtime.renderCartesianPanel(panel, figure);
  const marks = descendantNodes(svg).filter((node) => node.dataset?.layerId && node.tagName === "line");
  const fieldRules = marks.filter((node) => node.dataset.layerId === "field-rules");
  assert.equal(fieldRules.length, 2);
  assert.equal(new Set(fieldRules.map((node) => node.attributes.stroke)).size, 2, "each field-bound rule resolves its own stroke");
  assert.equal(marks.filter((node) => node.dataset.layerId === "constant-rule-with-data").length, 1);
});

test("flow labels fall back to the declared key and node opacity is applied", () => {
  const panel = {
    id: "flow-panel",
    coordinate: { type: "flow" },
    data_ref: "flow-nodes",
    layers: [{
      id: "flow-nodes-layer",
      mark: { type: "node", opacity: 0.42 },
      encoding: { key: { field: "node_id", type: "nominal" } }
    }]
  };
  const figure = { id: "flow-figure", layout: { type: "single" }, panels: [panel], scales: [], interactions: [] };
  const runtime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [figure],
    data: [{
      id: "flow-nodes",
      storage: { kind: "inline", format: "rows", rows: [{ node_id: "ingest" }, { node_id: "publish" }] }
    }]
  });
  const svg = runtime.renderFlowPanel(panel, figure);
  const nodes = descendantNodes(svg);
  const labels = nodes.filter((node) => node.tagName === "text").map((node) => node.textContent);
  assert.deepEqual(labels.sort(), ["ingest", "publish"]);
  const rectangles = nodes.filter((node) => node.tagName === "rect" && node.dataset?.layerId === "flow-nodes-layer");
  assert.equal(rectangles.length, 2);
  assert.ok(rectangles.every((node) => node.attributes.opacity === "0.42"));
});

test("tree and boxplot render declared stroke width and opacity", () => {
  const treePanel = {
    id: "tree-panel",
    coordinate: { type: "tree" },
    layers: [
      {
        id: "tree-nodes",
        data_ref: "tree-nodes-data",
        mark: { type: "node", opacity: 0.27 },
        encoding: {
          key: { field: "id", type: "nominal" }
        }
      },
      {
        id: "tree-links",
        data_ref: "tree-links-data",
        mark: { type: "link", stroke_width: 3.25, opacity: 0.36 },
        encoding: {
          from: { field: "from", type: "nominal" },
          to: { field: "to", type: "nominal" }
        }
      }
    ]
  };
  const treeFigure = { id: "tree-figure", layout: { type: "single" }, panels: [treePanel], scales: [], interactions: [] };
  const treeRuntime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [treeFigure],
    data: [
      { id: "tree-nodes-data", storage: { kind: "inline", format: "rows", rows: [{ id: "root", name: "Root" }, { id: "leaf", name: "Leaf" }] } },
      { id: "tree-links-data", storage: { kind: "inline", format: "rows", rows: [{ from: "root", to: "leaf" }] } }
    ]
  });
  const treeSvg = treeRuntime.renderTreePanel(treePanel, treeFigure);
  const treeMarks = descendantNodes(treeSvg).filter((node) => node.dataset?.layerId);
  assert.ok(treeMarks.filter((node) => node.dataset.layerId === "tree-nodes").every((node) => node.attributes.opacity === "0.27"));
  const treeLabels = descendantNodes(treeSvg).filter((node) => node.tagName === "text").map((node) => node.textContent);
  assert.deepEqual(treeLabels.sort(), ["leaf", "root"], "tree nodes fall back to the declared key instead of guessing a label field");
  const link = treeMarks.find((node) => node.dataset.layerId === "tree-links");
  assert.equal(link.attributes["stroke-width"], "3.25");
  assert.equal(link.attributes.opacity, "0.36");

  const boxPanel = {
    id: "box-panel",
    data_ref: "boxes",
    coordinate: { type: "cartesian" },
    layers: [{
      id: "boxes-layer",
      mark: { type: "boxplot", opacity: 0.23 },
      encoding: {
        x: { field: "group", type: "nominal" },
        q1: { field: "q1", type: "quantitative" },
        q3: { field: "q3", type: "quantitative" },
        median: { field: "median", type: "quantitative" },
        whisker_low: { field: "low", type: "quantitative" },
        whisker_high: { field: "high", type: "quantitative" }
      }
    }]
  };
  const boxFigure = { id: "box-figure", layout: { type: "single" }, panels: [boxPanel], scales: [], interactions: [] };
  const boxRuntime = loadRuntimeHooks({
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [boxFigure],
    data: [{
      id: "boxes",
      storage: { kind: "inline", format: "rows", rows: [{ group: "A", q1: 1, q3: 3, median: 2, low: 0, high: 4 }] }
    }]
  });
  const boxSvg = boxRuntime.renderCartesianPanel(boxPanel, boxFigure);
  const box = descendantNodes(boxSvg).find((node) => node.tagName === "rect" && node.dataset?.layerId === "boxes-layer");
  assert.equal(box.attributes.opacity, "0.23");
});

test("bar value labels use outer ends and stacked centres without clipping", () => {
  const vertical = hooks.barValueLabelLayout({
    vertical: true,
    stacked: false,
    categoryPosition: 100,
    thickness: 24,
    valuePosition: 30,
    baselinePosition: 250,
    plotStart: 24,
    plotEnd: 292,
    label: "4,690"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(vertical)), {
    x: 112,
    y: 34,
    anchor: "middle",
    inside: false
  });

  const horizontal = hooks.barValueLabelLayout({
    vertical: false,
    stacked: false,
    categoryPosition: 80,
    thickness: 20,
    valuePosition: 280,
    baselinePosition: 64,
    plotStart: 64,
    plotEnd: 300,
    label: "2,242"
  });
  assert.equal(horizontal.anchor, "end");
  assert.equal(horizontal.inside, true);

  assert.equal(hooks.barValueLabelLayout({
    vertical: true,
    stacked: true,
    categoryPosition: 10,
    thickness: 20,
    valuePosition: 100,
    baselinePosition: 108,
    plotStart: 24,
    plotEnd: 292,
    label: "2%"
  }), null);

});

test("continuous colour domains do not inherit coordinate padding", () => {
  const correlation = hooks.resolveContinuousColorDomain([-0.806148, 1], undefined, "diverging", undefined);
  assert.deepEqual(Array.from(correlation.domain), [-1, 1]);
  assert.equal(correlation.diverging, true);

  const mutualInformation = hooks.resolveContinuousColorDomain([0.030851, 1.137665], undefined, "sequential", undefined);
  assert.deepEqual(Array.from(mutualInformation.domain), [0, 1.137665]);
  assert.equal(mutualInformation.diverging, false);

  const explicit = hooks.resolveContinuousColorDomain([-0.8, 1], [-2, 3], "diverging", undefined);
  assert.deepEqual(Array.from(explicit.domain), [-2, 3]);
});

test("continuous palettes preserve declared alpha channels", () => {
  const midpoint = hooks.interpolateColor(0.5, [0, 1], false, ["#00000080", "#FFFFFF40"]);
  assert.match(midpoint, /^rgba\(128,128,128,0\.376\)$/);
});

test("named palettes resolve deterministically and unknown names fail closed", () => {
  const safe = Array.from(hooks.resolvePalette("colorblind-safe"));
  const scientific = Array.from(hooks.resolvePalette("scientific"));
  assert.equal(safe.length, 8);
  assert.equal(scientific.length, 8);
  assert.notDeepEqual(safe, scientific);
  assert.throws(() => hooks.resolvePalette("unknown-palette"), /Unknown or empty colour palette/);
});

test("panel legends keep global semantic colours without leaking unrelated categories", () => {
  const semanticPayload = {
    schema_version: "3.0.0",
    data: [{
      id: "values",
      storage: { kind: "inline", format: "rows", rows: [{ category: "A", value: 1 }, { category: "B", value: 2 }] }
    }],
    figures: [],
    sections: [],
    theme: { palette: "colorblind-safe", semantic_colors: { primary: "#123456", secondary: "#654321" } }
  };
  const localHooks = loadRuntimeHooks(semanticPayload);
  const constantPanel = {
    data_ref: "values",
    coordinate: { type: "cartesian" },
    layers: [{ id: "constant", mark: { type: "bar" }, encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "value", type: "quantitative" },
      color: { value: "primary", type: "nominal", scale_role: "semantic" }
    }}]
  };
  assert.equal(localHooks.createPanelLegend(constantPanel, { panels: [constantPanel] }), null, "constant colour should not create an implicit legend");

  const fieldPanel = structuredClone(constantPanel);
  fieldPanel.layers[0].encoding.color = { field: "category", type: "nominal", scale_role: "semantic" };
  const legend = localHooks.createPanelLegend(fieldPanel, { panels: [fieldPanel] });
  assert.equal(legend.children.filter((child) => child.className === "v3-legend-item").length, 2);
});

test("categorical matrix colours and legends use the nominal palette", () => {
  const matrixPayload = {
    schema_version: "3.0.0",
    data: [{
      id: "matrix-values",
      storage: { kind: "inline", format: "rows", rows: [
        { column: "A", row: "one", state: "pass" },
        { column: "B", row: "one", state: "warn" }
      ] }
    }],
    figures: [],
    sections: [],
    theme: { palette: "colorblind-safe", semantic_colors: { pass: "#009E73", warn: "#E6AB02" } }
  };
  const localHooks = loadRuntimeHooks(matrixPayload);
  const panel = {
    id: "status-matrix",
    data_ref: "matrix-values",
    coordinate: { type: "matrix" },
    layers: [{ id: "cells", mark: { type: "rect" }, encoding: {
      x: { field: "column", type: "nominal" },
      y: { field: "row", type: "nominal" },
      color: { field: "state", type: "nominal", scale_role: "semantic", legend: { title: "State" } }
    }}]
  };
  const figure = { panels: [panel] };
  const svg = localHooks.renderMatrixPanel(panel, figure);
  const cellGroup = svg.children.find((child) => child.attributes?.["data-layer-id"] === "cells");
  assert.deepEqual(cellGroup.children.map((cell) => cell.attributes.fill), ["#009E73", "#E6AB02"]);
  const legend = localHooks.createPanelLegend(panel, figure);
  assert.equal(legend.children.filter((child) => child.className === "v3-legend-item").length, 2);
});

test("three-column charts and very large matrices use bounded renderer geometry", () => {
  const panel = {};
  const figure = { layout: { type: "grid", columns: 3, gap: 16 }, panels: [panel, {}, {}] };
  assert.equal(hooks.panelRenderWidth(panel, figure, 620), 342);

  const ordinary = hooks.matrixGeometry(panel, figure, 11, 11);
  assert.equal(ordinary.width, 342);
  assert.ok(ordinary.showXLabels);
  assert.ok(ordinary.showYLabels);
  assert.ok(ordinary.cellWidth > 20);

  const longLabels = hooks.matrixGeometry(
    panel,
    figure,
    2,
    2,
    ["A very long matrix column label", "Another matrix column"],
    ["A very long matrix row label that must not leave the SVG", "Another matrix row"]
  );
  assert.ok(longLabels.margin.left > ordinary.margin.left);
  assert.ok(longLabels.width - longLabels.margin.left - longLabels.margin.right >= 120);
  assert.ok(longLabels.margin.top >= ordinary.margin.top);

  const large = hooks.matrixGeometry(panel, figure, 600, 1200);
  assert.ok(large.width < 700);
  assert.ok(large.height < 500);
  assert.ok(large.cellWidth > 0 && large.cellWidth < 1);
  assert.ok(large.cellHeight > 0 && large.cellHeight < 1);
  assert.equal(large.showXLabels, false);
  assert.equal(large.showYLabels, false);
  assert.equal(large.showCellText, false);
  assert.equal(large.cellStroke, "none");

  const explicitPanel = { display: { width: 500, height: 280 } };
  const explicitFigure = { layout: { type: "grid", columns: 3 }, panels: [explicitPanel] };
  const explicit = hooks.matrixGeometry(explicitPanel, explicitFigure, 20, 20);
  assert.equal(explicit.width, 500);
  assert.equal(explicit.height, 280);
});

test("grid placement, render width, and declared row capacity use the same row-major first-fit rule", () => {
  const panels = [
    { id: "wide-a", display: { column_span: 2 } },
    { id: "narrow" },
    { id: "wide-b", display: { column_span: 2 } }
  ];
  const figure = {
    layout: { type: "grid", columns: 3, rows: 2, column_weights: [1, 2, 3], gap: 16 },
    panels
  };
  const result = hooks.firstFitGridPlacements(panels, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.placements)),
    [
      { row: 1, column: 1, rowSpan: 1, columnSpan: 2 },
      { row: 1, column: 3, rowSpan: 1, columnSpan: 1 },
      { row: 2, column: 1, rowSpan: 1, columnSpan: 2 }
    ]
  );
  assert.equal(hooks.panelRenderWidth(panels[0], figure, 620), 530);
  assert.equal(hooks.panelRenderWidth(panels[1], figure, 620), 514);
  assert.equal(hooks.panelRenderWidth(panels[2], figure, 620), 530);

  figure.layout.rows = 1;
  assert.throws(() => hooks.panelGridPlacement(panels[2], figure), /requires 2 rows but layout declares 1/);
});

test("aspect ratios honor the contract range with bounded safe SVG heights", () => {
  assert.equal(hooks.panelRenderHeight({ display: { aspect_ratio: 20 } }, 620, 350), 100);
  assert.equal(hooks.panelRenderHeight({ display: { aspect_ratio: 0.1 } }, 620, 350), 1200);
  assert.equal(hooks.panelRenderHeight({}, 620, 350), 350);
});

test("matrix colour bars expose a visible title and narrow CSS overrides inline grid placement", () => {
  const legend = hooks.colorbarLegend(
    { field: "correlation", title: "Pearson correlation" },
    [-1, 1],
    true,
    undefined,
    true
  );
  assert.equal(legend.children[0].className, "v3-colorbar-title");
  assert.equal(legend.children[0].textContent, "Pearson correlation");

  const css = readFileSync(cssPath, "utf8");
  assert.match(css, /\.v3-figure-grid\s*\{\s*grid-template-columns:\s*1fr\s*!important;/);
  assert.match(css, /\.v3-panel\s*\{\s*grid-column:\s*auto\s*!important;\s*grid-row:\s*auto\s*!important;/);
  assert.match(css, /\.v3-matrix-visual\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
});

test("semantic validation rejects first-fit overflow even when total span area equals declared capacity", async () => {
  const core = await import(pathToFileURL(corePath));
  const payload = JSON.parse(readFileSync(capabilityFixturePath, "utf8"));
  const figure = payload.figures[0];
  figure.layout = { type: "grid", columns: 3, rows: 2, gap: 16 };
  figure.panels = figure.panels.slice(0, 3);
  figure.interactions = [];
  figure.panels.forEach((panel) => {
    panel.display = { column_span: 2 };
  });
  const validation = core.validatePayloadV3(payload);
  assert.ok(validation.errors.some((error) =>
    error.code === "layout_capacity"
    && error.path === "/figures/0/layout"
    && error.message.includes("requires 3 rows")
  ));
});

test("bar value labels are an explicit validated text channel", async () => {
  const core = await import(pathToFileURL(corePath));
  const payload = JSON.parse(readFileSync(capabilityFixturePath, "utf8"));
  const bar = payload.figures[0].panels.find((panel) => panel.id === "stacked-bars").layers[0];
  bar.encoding.text = { field: "interval_end", type: "quantitative", format: "integer" };
  assert.deepEqual(core.validatePayloadV3(payload).errors, []);

  bar.encoding.text.field = "missing_label";
  assert.ok(core.validatePayloadV3(payload).errors.some((error) =>
    error.code === "unknown_field" && error.path.endsWith("/encoding/text/field")
  ));
});

test("section concepts are visibly separated and method note markdown is rendered", () => {
  const runtime = loadRuntimeHooks();
  const section = runtime.createSectionPanel({
    id: "structure",
    number: 3,
    title: "Structure",
    figure_ids: [],
    concepts: ["**Ch 03** feature covariance", "**Ch 04** mutual information"],
    method_notes: [{ kind: "reports", text: "Uses **Pearson correlation**." }]
  }, 3);

  const descendants = [];
  const stack = [section];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    descendants.push(node);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  const textOf = (node) => `${node?.textContent || ""}${(node?.children || []).map(textOf).join("")}`;
  const concepts = descendants.find((node) => node.className === "concepts");
  assert.match(textOf(concepts), /feature covariance · Ch 04/);
  const methodNote = descendants.find((node) => node.className === "method-note reports");
  assert.equal(textOf(methodNote).includes("**"), false);
  assert.ok((methodNote.children || []).some((node) => node.tagName === "strong" && node.textContent === "Pearson correlation"));
});

test("large matrix rendering retains every declared rect while suppressing dense labels", () => {
  const xDomain = Array.from({ length: 600 }, (_, index) => `x-${index}`);
  const yDomain = ["top", "bottom"];
  const rows = yDomain.flatMap((row) => xDomain.map((column, index) => ({ row, column, value: index / xDomain.length })));
  const panel = {
    id: "large-matrix",
    coordinate: { type: "matrix" },
    data_ref: "matrix-data",
    layers: [{
      id: "cells",
      mark: { type: "rect" },
      encoding: {
        x: { field: "column", type: "nominal" },
        y: { field: "row", type: "nominal" },
        color: { field: "value", type: "quantitative", scale_role: "sequential" }
      }
    }]
  };
  const figure = { id: "matrix-figure", layout: { type: "grid", columns: 3, gap: 16 }, panels: [panel, {}, {}], scales: [], interactions: [] };
  const payload = {
    schema_version: "3.0.0",
    theme: { palette: "colorblind-safe" },
    sections: [],
    figures: [figure],
    data: [{ id: "matrix-data", storage: { kind: "inline", format: "rows", rows } }]
  };
  const runtime = loadRuntimeHooks(payload);
  const svg = runtime.renderMatrixPanel(panel, figure);
  const stack = [svg];
  let rects = 0;
  let texts = 0;
  while (stack.length) {
    const node = stack.pop();
    if (node.tagName === "rect") rects += 1;
    if (node.tagName === "text") texts += 1;
    stack.push(...node.children.filter((child) => child && typeof child === "object"));
  }
  assert.equal(rects, rows.length);
  assert.equal(texts, 2, "only the two readable y labels remain");
  const [, , width, height] = svg.attributes.viewBox.split(/\s+/).map(Number);
  assert.ok(width < 700);
  assert.ok(height < 500);
});
