#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRecipeRegistry } from "./lib/v3-recipes.mjs";
import { buildDashboard } from "./render-dashboard.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, "../examples/tess-reference-package");
const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
if (args.includes("--help")) {
  process.stdout.write("Usage: node scripts/generate-tess-reference-package.mjs [--output <directory>]\n");
  process.exit(0);
}
if (outputFlag >= 0 && !args[outputFlag + 1]) throw new Error("--output requires a directory");
const OUTPUT_DIR = outputFlag >= 0 ? resolve(args[outputFlag + 1]) : DEFAULT_OUTPUT;
const DATA_DIR = resolve(OUTPUT_DIR, "data");
const PAYLOAD_PATH = resolve(OUTPUT_DIR, "payload.json");
const DASHBOARD_PATH = resolve(OUTPUT_DIR, "tess-reference.dashboard.html");

const ILLUSTRATIVE = "Controlled illustrative data for renderer acceptance; values are not reconstructed TESS scientific results.";
const resources = [];
const sidecarFiles = [];
const sections = [];
const figures = [];

const F = Object.freeze({
  number: (name, role = "measure", extras = {}) => ({ name, type: "number", role, ...extras }),
  integer: (name, role = "measure", extras = {}) => ({ name, type: "integer", role, ...extras }),
  string: (name, role = "dimension", extras = {}) => ({ name, type: "string", role, ...extras })
});

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function addData(id, semanticType, fields, rows, title = id) {
  if (resources.some((resource) => resource.id === id)) throw new Error(`Duplicate data id: ${id}`);
  const content = stableJson(rows);
  const relativePath = `data/${id}.json`;
  resources.push({
    id,
    semantic_type: semanticType,
    title,
    description: ILLUSTRATIVE,
    fields,
    storage: {
      kind: "sidecar",
      path: relativePath,
      format: "json",
      compression: "none",
      sha256: createHash("sha256").update(content).digest("hex"),
      rows: rows.length,
      bytes: Buffer.byteLength(content)
    }
  });
  sidecarFiles.push({ id, relativePath, content });
  return id;
}

const q = (field, title, extras = {}) => {
  const { axisFormat, ...channelExtras } = extras;
  return {
    field,
    type: "quantitative",
    ...(title || axisFormat ? { axis: { ...(title ? { title } : {}), grid: true, ...(axisFormat ? { format: axisFormat } : {}) } } : {}),
    ...channelExtras
  };
};
const n = (field, title, extras = {}) => ({ field, type: "nominal", ...(title ? { axis: { title } } : {}), ...extras });
const o = (field, title, extras = {}) => ({ field, type: "ordinal", ...(title ? { axis: { title } } : {}), ...extras });
const v = (value, type = "quantitative", extras = {}) => ({ value, type, ...extras });

function layer(id, type, encoding, mark = {}, extras = {}) {
  return { id, ...(extras.dataRef ? { data_ref: extras.dataRef } : {}), ...(extras.transform ? { transform: extras.transform } : {}), mark: { type, ...mark }, encoding };
}

function panel(id, title, dataRef, layers, options = {}) {
  return {
    id,
    title,
    ...(options.description ? { description: options.description } : {}),
    ...(options.type ? { type: options.type } : {}),
    ...(dataRef ? { data_ref: dataRef } : {}),
    coordinate: { type: options.coordinate || "cartesian", ...(options.equalAspect ? { equal_aspect: true } : {}) },
    ...(options.transform ? { transform: options.transform } : {}),
    layers
  };
}

function genericFigure(id, title, panels, options = {}) {
  const columns = options.columns || Math.min(3, panels.length);
  const result = {
    id,
    title,
    caption: `${options.caption || title}. ${ILLUSTRATIVE}`,
    recipe: "generic.figure@1",
    layout: { type: panels.length === 1 ? "single" : "grid", columns, ...(options.rows ? { rows: options.rows } : {}), gap: 16 },
    panels,
    ...(options.scales?.length ? { scales: options.scales } : {}),
    ...(options.interactions?.length ? { interactions: options.interactions } : {})
  };
  figures.push(result);
  return id;
}

function recipeFigure(figure) {
  figures.push({ ...figure, caption: `${figure.caption || figure.title}. ${ILLUSTRATIVE}` });
  return figure.id;
}

function addStage(number, title, figureIds, summary) {
  sections.push({
    id: `stage-${String(number).padStart(2, "0")}`,
    number,
    title,
    short_label: title,
    summary,
    caveats: [ILLUSTRATIVE],
    figure_ids: figureIds,
    initial_state: number === 0 ? "open" : "closed"
  });
}

function linspace(start, end, count) {
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / Math.max(1, count - 1));
}

function matrixRows(rowNames, columnNames, value) {
  return rowNames.flatMap((row, rowIndex) => columnNames.map((column, columnIndex) => ({ row, column, value: value(rowIndex, columnIndex) })));
}

function clusteredPoints({ facets, count = 42, classes = ["Candidate", "Confirmed", "False_positive"], xField = "x", yField = "y" }) {
  return facets.flatMap((facet, facetIndex) => Array.from({ length: count }, (_, index) => {
    const classIndex = index % classes.length;
    const angle = index * 1.71 + facetIndex * 0.37;
    const radius = 0.35 + (index % 9) * 0.055;
    const centerX = [-1.2, 0.9, 0.1][classIndex] + 0.08 * facetIndex;
    const centerY = [0.65, 0.8, -1.0][classIndex] - 0.04 * facetIndex;
    return {
      facet,
      object_id: `${facet}-${String(index + 1).padStart(3, "0")}`,
      disposition: classes[classIndex],
      [xField]: Number((centerX + Math.cos(angle) * radius).toFixed(5)),
      [yField]: Number((centerY + Math.sin(angle) * radius).toFixed(5))
    };
  }));
}

const referenceOne = addData("reference-one", "renderer.constant-row", [F.string("id", "id")], [{ id: "reference" }], "One-row reference source");

// Stage 00 — framing and label taxonomy.
const transitBodies = addData("transit-bodies", "geometry.ellipses", [
  F.string("body"), F.number("x"), F.number("y"), F.number("x_radius"), F.number("y_radius")
], [
  { body: "Star", x: 0, y: 0, x_radius: 1, y_radius: 1 },
  { body: "Planet", x: 0.42, y: 0.08, x_radius: 0.2, y_radius: 0.2 }
]);
const transitOrbit = addData("transit-orbit", "geometry.polygon-vertices", [
  F.string("region"), F.integer("vertex_order", "metadata"), F.number("x"), F.number("y")
], linspace(0, Math.PI * 2, 41).map((angle, index) => ({ region: "Orbit", vertex_order: index, x: Number((1.55 * Math.cos(angle)).toFixed(5)), y: Number((0.55 * Math.sin(angle)).toFixed(5)) })));
const transitMotion = addData("transit-motion", "geometry.vectors", [F.number("x"), F.number("y"), F.number("x2"), F.number("y2")], [{ x: -1.35, y: 0.08, x2: 1.35, y2: 0.08 }]);
const transitCurve = addData("transit-light-curve", "timeseries.relative-brightness", [F.number("time"), F.number("brightness")], linspace(-1.2, 1.2, 61).map((time) => ({
  time: Number(time.toFixed(4)),
  brightness: Number((1 - 0.018 * Math.exp(-((Math.abs(time) / 0.32) ** 6))).toFixed(6))
})));
const figTransit = genericFigure("stage00-transit-question", "From geometry to a transit signal", [
  panel("transit-geometry", "Transit geometry", transitBodies, [
    layer("orbit", "polygon", { x: q("x", "Projected x"), y: q("y", "Projected y"), group: n("region"), color: v("Orbit", "nominal", { scale_role: "semantic" }) }, { opacity: 0.12, stroke_width: 1.5 }, { dataRef: transitOrbit }),
    layer("bodies", "ellipse", { x: q("x"), y: q("y"), x_radius: q("x_radius"), y_radius: q("y_radius"), color: n("body", undefined, { scale_role: "semantic", legend: { title: "Body" } }) }, { opacity: 0.72 }),
    layer("motion", "vector", { x: q("x"), y: q("y"), x2: q("x2"), y2: q("y2"), color: v("Motion", "nominal", { scale_role: "semantic" }) }, { role: "annotation", stroke_width: 2 }, { dataRef: transitMotion })
  ], { equalAspect: true }),
  panel("transit-brightness", "Annotated brightness versus time", transitCurve, [
    layer("brightness", "line", { x: q("time", "Time from mid-transit"), y: q("brightness", "Relative brightness") }, { stroke_width: 2.5 }),
    layer("baseline", "rule", { y: v(1) }, { role: "reference" }, { dataRef: referenceOne }),
    layer("depth-label", "text", { x: v(0.05), y: v(0.984), text: v("Transit depth", "nominal") }, { role: "annotation", dx: 6, dy: -6 }, { dataRef: referenceOne })
  ])
], { columns: 2 });

const dispositions = addData("label-dispositions", "labels.class-counts", [F.string("disposition"), F.integer("count")], [
  { disposition: "PC", count: 4690 }, { disposition: "FP", count: 1113 }, { disposition: "KP", count: 548 },
  { disposition: "CP", count: 485 }, { disposition: "APC", count: 438 }, { disposition: "FA", count: 96 }
]);
const adjudication = addData("label-adjudication", "labels.adjudication-counts", [F.string("status"), F.integer("count")], [
  { status: "Adjudicated", count: 2242 }, { status: "Open", count: 5130 }
]);
const figTaxonomy = genericFigure("stage00-label-taxonomy", "Label taxonomy and adjudication", [
  panel("disposition-counts", "Disposition counts", dispositions, [layer("bars", "bar", { x: n("disposition", "Disposition"), y: q("count", "Objects"), color: n("disposition", undefined, { scale_role: "semantic", legend: false }) })]),
  panel("adjudication-status", "Adjudicated versus open", adjudication, [layer("bars", "bar", { x: q("count", "Objects"), y: n("status", "Status"), color: n("status", undefined, { scale_role: "semantic", legend: false }) }, { orient: "horizontal" })])
], { columns: 2 });
addStage(0, "Scientific question", [figTransit, figTaxonomy], "Frame the transit signal and the controlled label vocabulary before analysis.");

// Stage 01 — provenance.
const missingness = addData("provenance-missingness", "data-quality.missingness", [F.string("feature"), F.number("missing_fraction")], [
  ["pl_orbper", 0.001], ["pl_trandurh", 0], ["pl_trandep", 0], ["pl_rade", 0.008], ["pl_insol", 0.047],
  ["st_tmag", 0], ["st_dist", 0.029], ["st_teff", 0.018], ["st_logg", 0.111], ["st_rad", 0.026], ["pm_total", 0.014]
].map(([feature, missing_fraction]) => ({ feature, missing_fraction })));
const hostMultiplicity = addData("host-multiplicity", "provenance.host-multiplicity", [F.string("host_group"), F.integer("hosts")], [1, 2, 3, 4, 5].map((multiplicity) => ({ host_group: `${multiplicity} signal${multiplicity === 1 ? "" : "s"}`, hosts: [6859, 176, 37, 10, 2][multiplicity - 1] })));
const figProvenance = genericFigure("stage01-provenance", "Data provenance and coverage", [
  panel("missingness", "Feature missingness", missingness, [layer("missing-bars", "bar", { x: q("missing_fraction", "Missing fraction", { axisFormat: "percent" }), y: n("feature", "Feature"), color: v("missing", "nominal", { scale_role: "semantic" }) }, { orient: "horizontal" })]),
  panel("host-multiplicity", "Host multiplicity (log scale)", hostMultiplicity, [layer("host-bars", "bar", { x: q("hosts", "Host systems", { scale_id: "host-log" }), y: n("host_group", "Signals per host"), color: v("hosts", "nominal", { scale_role: "semantic" }) }, { orient: "horizontal" })])
], { columns: 2, scales: [{ id: "host-log", type: "log", domain: [1, 7000], title: "Host systems" }] });
addStage(1, "Provenance", [figProvenance], "Audit source completeness and the repeated-host structure.");

// Stage 02 — quality control.
const removals = addData("quality-rule-removals", "data-quality.rule-removals", [F.string("rule"), F.integer("removed")], [
  ["Exact duplicate", 0], ["Duration >= period", 0], ["st_rad > 100 R_sun", 1], ["st_teff > 20,000 K", 5], ["Missing disposition", 2]
].map(([rule, removed]) => ({ rule, removed })));
const radiusHistogram = addData("retained-radius-histogram", "distribution.histogram-bins", [F.number("log10_radius"), F.integer("count")], linspace(-0.8, 2.0, 40).map((log10Radius, index) => ({ log10_radius: Number(log10Radius.toFixed(4)), count: Math.max(2, Math.round(510 * Math.exp(-((index - 15) ** 2) / 65) + 18 * Math.sin(index * 0.75))) })));
const figQuality = genericFigure("stage02-quality-control", "Rule-based quality control", [
  panel("rule-removals", "Rows removed by rule", removals, [layer("removal-bars", "bar", { x: q("removed", "Rows removed"), y: n("rule", "Rule"), color: v("removed", "nominal", { scale_role: "semantic" }) }, { orient: "horizontal" })]),
  panel("retained-radius", "Retained radius distribution", radiusHistogram, [
    layer("radius-bars", "bar", { x: q("log10_radius", "log10 planet radius (Earth radii)"), y: q("count", "Objects"), color: v("retained", "nominal", { scale_role: "semantic" }) }),
    layer("radius-threshold", "rule", { x: v(Number(Math.log10(30).toFixed(6))) }, { role: "threshold", stroke_width: 2 }, { dataRef: referenceOne }),
    layer("threshold-label", "text", { x: v(Number(Math.log10(30).toFixed(6))), y: v(500), text: v("30 R_earth · 49 retained", "nominal") }, { role: "annotation", dx: 5, dy: -5 }, { dataRef: referenceOne })
  ])
], { columns: 2 });
addStage(2, "Quality control", [figQuality], "Make row exclusions and retained measurement support visible.");

// Stage 03 — dependence structure.
const structureFeatures = ["pl_orbper", "pl_trandurh", "pl_trandep", "pl_rade", "pl_insol", "st_tmag", "st_dist", "st_teff", "st_logg", "st_rad", "pm_total"];
const correlation = addData("structure-correlation", "matrix.correlation", [F.string("row"), F.string("column"), F.number("value")], matrixRows(structureFeatures, structureFeatures, (row, column) => {
  if (row === column) return 1;
  if ((row === 8 && column === 9) || (row === 9 && column === 8)) return 0.81;
  if ((row === 6 && column === 10) || (row === 10 && column === 6)) return 0.78;
  return Number((Math.cos((row + 1) * (column + 2)) * 0.58).toFixed(4));
}));
const mutualInformation = addData("structure-mutual-information", "matrix.mutual-information", [F.string("row"), F.string("column"), F.number("value")], matrixRows(structureFeatures, structureFeatures, (row, column) => Number((0.08 + Math.abs(Math.sin((row + 1.3) * (column + 0.8))) * 0.62).toFixed(4))).filter((entry) => entry.row !== entry.column));
const uncertaintyMedians = [0.001, 10, 2.4, 8.5, 6.1, 0.4, 3.8, 1.7, 4.5, 5.2, 7.4];
const uncertainties = addData("structure-uncertainty", "estimate.log-uncertainty", [F.string("feature"), F.number("estimate"), F.number("lower"), F.number("upper")], structureFeatures.map((feature, index) => ({ feature, estimate: uncertaintyMedians[index], lower: uncertaintyMedians[index] * 0.72, upper: uncertaintyMedians[index] * 1.34 })));
const figStructure = genericFigure("stage03-structure", "Dependence and uncertainty structure", [
  panel("correlation", "Diverging correlation heatmap", correlation, [layer("cells", "rect", { x: n("column", "Feature"), y: n("row", "Feature"), color: q("value", undefined, { scale_role: "diverging", legend: { title: "Correlation" } }) })], { coordinate: "matrix", type: "matrix" }),
  panel("mutual-information", "Mutual information heatmap", mutualInformation, [layer("cells", "rect", { x: n("column", "Feature"), y: n("row", "Feature"), color: q("value", undefined, { scale_role: "sequential", legend: { title: "MI" } }) })], { coordinate: "matrix", type: "matrix" }),
  panel("uncertainty", "Measurement uncertainty (log scale)", uncertainties, [layer("intervals", "errorbar", { x: q("estimate", "Typical uncertainty", { scale_id: "uncertainty-log" }), x_lower: q("lower", undefined, { scale_id: "uncertainty-log" }), x_upper: q("upper", undefined, { scale_id: "uncertainty-log" }), y: n("feature", "Feature"), color: v("uncertainty", "nominal", { scale_role: "semantic" }) }, { orient: "horizontal", stroke_width: 2 })])
], { columns: 3, scales: [{ id: "uncertainty-log", type: "log", domain: [0.0001, 20], title: "Median reported uncertainty (%)" }] });
addStage(3, "Structure", [figStructure], "Compare linear, nonlinear, and measurement-level relationships.");

// Stage 04 — feature audit.
const constantHistogram = addData("implied-constant-histogram", "distribution.histogram-bins", [F.number("value"), F.integer("count")], [
  { value: 255.0, count: 2260 }, { value: 278.5, count: 4818 }
]);
const conventionIntervals = addData("feature-conventions", "summary.stacked-intervals", [F.string("feature"), F.string("convention"), F.number("interval_start"), F.number("interval_end")], [
  ["PC", "255 K", 0, 0.18], ["PC", "278.5 K", 0.18, 0.98], ["PC", "missing", 0.98, 1],
  ["FP", "255 K", 0, 0.72], ["FP", "278.5 K", 0.72, 0.97], ["FP", "missing", 0.97, 1],
  ["KP", "255 K", 0, 0.09], ["KP", "278.5 K", 0.09, 0.99], ["KP", "missing", 0.99, 1],
  ["CP", "255 K", 0, 0.11], ["CP", "278.5 K", 0.11, 0.99], ["CP", "missing", 0.99, 1],
  ["APC", "255 K", 0, 0.24], ["APC", "278.5 K", 0.24, 0.96], ["APC", "missing", 0.96, 1],
  ["FA", "255 K", 0, 0.84], ["FA", "278.5 K", 0.84, 0.95], ["FA", "missing", 0.95, 1]
].map(([feature, convention, interval_start, interval_end]) => ({ feature, convention, interval_start, interval_end })));
const skewAudit = addData("skew-before-after", "feature-audit.skewness", [F.string("feature"), F.number("before"), F.number("after")], [
  ["pl_orbper", 6.2, 0.84], ["pl_trandurh", 3.1, 0.62], ["pl_trandep", 18.7, 1.18], ["pl_rade", 7.9, 0.88],
  ["pl_insol", 15.2, 1.24], ["st_dist", 2.8, 0.41], ["st_rad", 5.3, 0.73], ["pm_total", 9.6, 0.97]
].map(([feature, before, after]) => ({ feature, before, after })));
const figAudit = genericFigure("stage04-feature-audit", "Feature semantics and transformation audit", [
  panel("implied-constant", "One column, two conventions", constantHistogram, [layer("histogram", "bar", { x: q("value", "Implied constant (K)"), y: q("count", "Objects"), color: v("constant", "nominal", { scale_role: "semantic" }) })]),
  panel("conventions", "The convention tracks the label", conventionIntervals, [layer("segments", "bar", { x: q("interval_end", "Fraction", { axisFormat: "percent" }), x2: q("interval_start"), y: n("feature", "Disposition"), color: n("convention", undefined, { scale_role: "semantic", legend: { title: "Convention" } }), group: n("convention") }, { orient: "horizontal" })]),
  panel("skew", "Skewness before and after", skewAudit, [
    layer("identity", "rule", { x: v(0), y: v(0), x2: v(4.5), y2: v(4.5) }, { role: "reference" }, { dataRef: referenceOne }),
    layer("features", "point", { x: q("before", "Before"), y: q("after", "After"), color: n("feature", undefined, { scale_role: "semantic", legend: false }), tooltip: n("feature") }, { point_size: 54 })
  ])
], { columns: 3 });
addStage(4, "Feature audit", [figAudit], "Expose constants, mixed conventions, and transformation effects.");

// Stage 05 — baseline.
const lossCurve = addData("baseline-loss", "optimization.loss-curve", [F.integer("iteration"), F.number("loss")], Array.from({ length: 400 }, (_, iteration) => ({ iteration: iteration + 1, loss: iteration === 399 ? 0.6171 : Number((0.6171 + 0.25 * Math.exp(-iteration / 72) + 0.004 * Math.sin(iteration / 11) * Math.exp(-iteration / 95)).toFixed(6)) })));
const baselinePoints = addData("baseline-two-feature", "classification.labelled-points", [F.string("object_id", "id"), F.number("period_log"), F.number("depth_log"), F.string("class")], Array.from({ length: 2242 }, (_, index) => ({
  object_id: `TOI-${String(100 + index).padStart(5, "0")}`,
  period_log: Number((-0.65 + (index % 67) * 0.034 + 0.09 * Math.sin(index * 0.37)).toFixed(5)),
  depth_log: Number((-3.1 + Math.floor(index / 67) * 0.052 + 0.12 * Math.cos(index * 0.29)).toFixed(5)),
  class: index < 1033 ? "Planet" : "False_positive"
})));
const decisionBoundary = addData("baseline-boundary", "classification.decision-boundary", [F.number("x"), F.number("y")], [{ x: -0.55, y: -1.7 }, { x: 1.55, y: -2.45 }]);
const figBaseline = genericFigure("stage05-baseline", "Interpretable baseline", [
  panel("loss", "Optimisation loss", lossCurve, [layer("loss-line", "line", { x: q("iteration", "Iteration"), y: q("loss", "Objective") }, { stroke_width: 2.5 })]),
  panel("decision", "Two-feature labelled baseline", baselinePoints, [
    layer("boundary", "line", { x: q("x"), y: q("y"), color: v("Decision boundary", "nominal", { scale_role: "semantic" }) }, { role: "reference", stroke_width: 2 }, { dataRef: decisionBoundary }),
    layer("objects", "point", { x: q("period_log", "log orbital period"), y: q("depth_log", "log transit depth"), color: n("class", undefined, { scale_role: "semantic", legend: { title: "Adjudicated label" } }), tooltip: n("object_id") }, { point_size: 18, opacity: 0.62 })
  ])
], { columns: 2 });
addStage(5, "Baseline", [figBaseline], "Establish a simple optimisation and decision-boundary reference.");

// Stage 06 — preprocessing.
const nativeVarianceValues = [1.2e6, 9.8, 2.1e8, 94, 4.2e11, 3.4, 8.6e4, 7.3e5, 0.18, 44, 2.5e7];
const nativeVariance = addData("native-variance", "preprocessing.feature-variance", [F.string("feature"), F.number("variance")], structureFeatures.map((feature, index) => ({ feature, variance: nativeVarianceValues[index] })));
const preprocessScreeValues = {
  Native: [0.612, 0.173, 0.082, 0.051, 0.031, 0.019, 0.012, 0.008, 0.006, 0.004, 0.002],
  Standardised: [0.409, 0.218, 0.125, 0.082, 0.061, 0.041, 0.025, 0.017, 0.011, 0.007, 0.004]
};
const preprocessScree = addData("preprocess-scree", "preprocessing.scree-comparison", [F.integer("component"), F.number("variance"), F.string("series")], Object.entries(preprocessScreeValues).flatMap(([series, values]) => values.map((variance, index) => ({ component: index + 1, variance, series }))));
const featureBoxes = addData("preprocess-boxes", "distribution.box-summary", [F.string("feature"), F.number("q1"), F.number("median"), F.number("q3"), F.number("whisker_low"), F.number("whisker_high")], structureFeatures.map((feature, index) => ({ feature, q1: -0.72 + index * 0.05, median: -0.04 + index * 0.02, q3: 0.69 + index * 0.04, whisker_low: -1.8 - index * 0.08, whisker_high: 1.7 + index * 0.11 })));
const figPreprocessing = genericFigure("stage06-preprocessing", "Preprocessing diagnostics", [
  panel("native-variance", "Native feature variance (log)", nativeVariance, [layer("variance-bars", "bar", { x: q("variance", "Variance", { scale_id: "variance-log" }), y: n("feature", "Feature"), color: v("native", "nominal", { scale_role: "semantic" }) }, { orient: "horizontal" })]),
  panel("scree-comparison", "Native versus standardised scree", preprocessScree, [layer("scree-lines", "line", { x: q("component", "Component"), y: q("variance", "Explained variance"), color: n("series", undefined, { scale_role: "semantic", legend: { title: "Representation" } }), group: n("series") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("feature-boxplots", "Standardised feature summaries", featureBoxes, [layer("boxes", "boxplot", { x: n("feature", "Feature"), q1: q("q1"), q3: q("q3"), median: q("median"), whisker_low: q("whisker_low"), whisker_high: q("whisker_high"), color: n("feature", undefined, { scale_role: "semantic", legend: false }) }, { opacity: 0.62 })])
], { columns: 3, scales: [{ id: "variance-log", type: "log", domain: [0.0001, 1000000000000], title: "Native variance" }] });
addStage(6, "Preprocessing", [figPreprocessing], "Verify scale imbalance, component concentration, and standardised ranges.");

// Stage 07 — PCA diagnostics via the registered deterministic recipe.
const pcaScree = addData("pca-scree", "pca.explained-variance", [F.integer("component"), F.number("variance"), F.number("cumulative")], (() => {
  const values = [0.41, 0.22, 0.12, 0.075, 0.052, 0.034, 0.027, 0.021, 0.017, 0.013, 0.011];
  let cumulative = 0;
  return values.map((variance, index) => ({ component: index + 1, variance, cumulative: Number((cumulative += variance).toFixed(5)) }));
})());
const pcaLoadings = addData("pca-loadings", "pca.loadings", [F.integer("component"), F.string("feature"), F.number("value")], Array.from({ length: 5 }, (_, componentIndex) => structureFeatures.map((feature, featureIndex) => ({ component: componentIndex + 1, feature, value: Number((Math.sin((componentIndex + 1) * (featureIndex + 1.4)) * 0.82).toFixed(5)) }))).flat());
const pcaCircle = addData("pca-circle", "pca.loading-vectors", [F.string("feature"), F.number("x"), F.number("y")], structureFeatures.map((feature, index) => ({ feature, x: Number((0.83 * Math.cos(index * 1.19)).toFixed(5)), y: Number((0.83 * Math.sin(index * 1.19)).toFixed(5)) })));
const pcaResiduals = addData("pca-residuals", "pca.covariance-residual", [F.integer("component"), F.string("row"), F.string("column"), F.number("value")], [2, 6, 8].flatMap((component) => matrixRows(structureFeatures, structureFeatures, (row, column) => Number((((row === column ? 0.12 : Math.sin((row + 1) * (column + 2))) / component)).toFixed(5))).map((entry) => ({ component, ...entry }))));
const figPca = recipeFigure({
  id: "stage07-pca-diagnostics",
  title: "PCA diagnostics",
  recipe: "pca.diagnostics@1",
  recipe_config: {
    bindings: {
      scree: { data: pcaScree, component: "component", variance: "variance", cumulative: "cumulative" },
      loadings: { data: pcaLoadings, component: "component", feature: "feature", value: "value" },
      circle: { data: pcaCircle, x: "x", y: "y", label: "feature" },
      residuals: { data: pcaResiduals, component: "component", row: "row", column: "column", value: "value" }
    },
    params: { selected_components: 6, variance_threshold: 0.9, residual_components: [2, 6, 8] }
  },
  layout: { type: "grid", columns: 3, rows: 2, gap: 16 },
  panels: []
});
addStage(7, "PCA diagnostics", [figPca], "Inspect explained variance, loadings, correlation geometry, and covariance residuals.");

// Stage 08 — neighbourhood geometry.
const kDistance = addData("k-distance", "geometry.k-distance", [F.integer("rank"), F.number("distance")], Array.from({ length: 7364 }, (_, index) => {
  const ratio = index / 7363;
  return { rank: index + 1, distance: Number((0.34 + 1.45 * ratio ** 2 + 0.82 * ratio ** 10).toFixed(5)) };
}));
const densityHistogram = addData("density-histogram", "distribution.local-density", [F.number("log10_density"), F.integer("count")], linspace(-1.4, 0.8, 36).map((density, index) => ({ log10_density: Number(density.toFixed(4)), count: Math.round(18 + 540 * Math.exp(-((index - 18) ** 2) / 82)) })));
const metricDistances = addData("metric-distances", "geometry.metric-curves", [F.integer("rank"), F.number("distance"), F.string("metric")], ["Euclidean", "Manhattan", "Cosine"].flatMap((metric, metricIndex) => Array.from({ length: 2500 }, (_, index) => ({ rank: index + 1, distance: Number((0.12 + 0.82 * (index / 2499) ** (1.35 - metricIndex * 0.12) + 0.025 * metricIndex).toFixed(5)), metric }))));
const figGeometry = genericFigure("stage08-geometry", "Neighbourhood geometry", [
  panel("k-distance", "Sorted k-distance", kDistance, [
    layer("distance-line", "line", { x: q("rank", "Sorted object rank"), y: q("distance", "k-distance") }, { stroke_width: 2.2 }),
    layer("epsilon", "rule", { y: v(2.19) }, { role: "threshold", stroke_width: 2 }, { dataRef: referenceOne })
  ]),
  panel("density", "Local-density distribution", densityHistogram, [layer("density-bars", "bar", { x: q("log10_density", "log10 local density"), y: q("count", "Objects"), color: v("density", "nominal", { scale_role: "semantic" }) })]),
  panel("metric-comparison", "Metric distance profiles", metricDistances, [layer("metric-lines", "line", { x: q("rank", "Sorted rank"), y: q("distance", "Normalised k-distance"), color: n("metric", undefined, { scale_role: "semantic", legend: { title: "Metric" } }), group: n("metric") }, { stroke_width: 2 })])
], { columns: 3 });
addStage(8, "Geometry", [figGeometry], "Compare epsilon evidence, local density, and metric sensitivity.");

// Stage 09 — embedding sweep via the registered small-multiples recipe.
const embeddingVariants = [
  { id: "tsne-10", label: "t-SNE · perplexity 10", value: "tsne-10" },
  { id: "tsne-30", label: "t-SNE · perplexity 30", value: "tsne-30" },
  { id: "tsne-80", label: "t-SNE · perplexity 80", value: "tsne-80" },
  { id: "umap-5", label: "UMAP · neighbours 5", value: "umap-5" },
  { id: "umap-15", label: "UMAP · neighbours 15", value: "umap-15" },
  { id: "umap-50", label: "UMAP · neighbours 50", value: "umap-50" }
];
const embeddingSweep = addData("embedding-sweep", "embedding.coordinates", [F.string("facet", "metadata"), F.string("object_id", "id"), F.string("disposition"), F.number("x"), F.number("y")], clusteredPoints({ facets: embeddingVariants.map((variant) => variant.value), count: 3000, classes: ["Planet", "False_positive", "Open"] }));
const figEmbeddingSweep = recipeFigure({
  id: "stage09-embedding-sweep",
  title: "t-SNE and UMAP sweep",
  recipe: "embedding.small-multiples@1",
  recipe_config: {
    bindings: { points: { data: embeddingSweep, facet: "facet", x: "x", y: "y", color: "disposition", tooltip: "object_id" } },
    params: { columns: 3, variants: embeddingVariants }
  },
  layout: { type: "grid", columns: 3, rows: 2, gap: 16 },
  panels: []
});
addStage(9, "Embedding sweep", [figEmbeddingSweep], "Compare two nonlinear embedding families under declared hyperparameters.");

// Stage 10 — embedding validation.
const embeddingQuality = addData("embedding-quality", "embedding.neighbourhood-quality", [F.integer("k"), F.number("score"), F.string("series")], ["UMAP trust", "UMAP continuity", "t-SNE trust", "t-SNE continuity", "PCA-2 trust", "PCA-2 continuity"].flatMap((series, seriesIndex) => [5, 10, 20, 40, 60, 80].map((k) => {
  const method = Math.floor(seriesIndex / 2);
  const continuity = seriesIndex % 2;
  const anchor = method === 0 ? (continuity ? 0.94 : 0.93) : method === 1 ? (continuity ? 0.90 : 0.92) : (continuity ? 0.96 : 0.86);
  return { k, score: Number((anchor - 0.00042 * Math.abs(k - 20) + 0.004 * Math.sin(k / 9 + seriesIndex)).toFixed(5)), series };
})));
const shepard = addData("shepard-distances", "embedding.shepard-pairs", [F.number("feature_distance"), F.number("embedding_distance")], Array.from({ length: 6000 }, (_, index) => {
  const featureDistance = 0.15 + (index % 211) / 35 + 0.08 * Math.sin(index * 0.31);
  return { feature_distance: Number(featureDistance.toFixed(5)), embedding_distance: Number((0.22 + 0.68 * featureDistance + 0.42 * Math.sin(index * 1.17)).toFixed(5)) };
}));
const seedDisparity = addData("seed-disparity", "embedding.procrustes-disparity", [F.string("seed_pair"), F.number("disparity")], [
  { seed_pair: "0 vs 1", disparity: 0.004 }, { seed_pair: "0 vs 2", disparity: 0.007 }, { seed_pair: "1 vs 2", disparity: 0.005 }
]);
const figEmbeddingValidation = genericFigure("stage10-embedding-validation", "Embedding validation", [
  panel("neighbourhood-quality", "Quality against neighbourhood size", embeddingQuality, [
    layer("quality-curves", "line", { x: q("k", "Neighbourhood size k"), y: q("score", "Score"), color: n("series", undefined, { scale_role: "semantic", legend: { title: "Method · metric" } }), group: n("series") }, { stroke_width: 2, point: true, point_size: 2.6 }),
    layer("random-null", "rule", { y: v(0.65) }, { role: "reference", stroke_width: 1.8 }, { dataRef: referenceOne })
  ]),
  panel("shepard", "Shepard diagram · Spearman rho = 0.71", shepard, [layer("pairs", "point", { x: q("feature_distance", "Feature-space distance"), y: q("embedding_distance", "Embedding distance"), color: v("sampled pairs", "nominal", { scale_role: "semantic" }) }, { point_size: 10, opacity: 0.24 })]),
  panel("seed-reproducibility", "Procrustes disparity across seeds", seedDisparity, [layer("disparity-bars", "bar", { x: n("seed_pair", "Seed pair"), y: q("disparity", "Disparity"), color: v("UMAP", "nominal", { scale_role: "semantic" }) })])
], { columns: 3 });
addStage(10, "Embedding validation", [figEmbeddingValidation], "Test neighbourhood preservation, distance agreement, and seed stability.");

// Stage 11 — partition comparison, shown on the same illustrative UMAP support.
const partitionMethods = ["kmeans", "hdbscan", "dbscan"];
const partitionPoints = addData("partition-overlays", "partition.embedding-overlay", [F.string("method", "metadata"), F.string("object_id", "id"), F.number("x"), F.number("y"), F.string("cluster")], partitionMethods.flatMap((method, methodIndex) => Array.from({ length: 1200 }, (_, index) => {
  const angle = index * 0.137;
  const radius = 0.5 + (index % 37) / 34;
  let cluster;
  if (method === "kmeans") cluster = `C${index % 4}`;
  else if (method === "hdbscan") cluster = index % 6 === 0 ? `H${index % 2}` : "noise";
  else cluster = index % 51 === 0 ? "noise" : "D0";
  const classOffset = cluster === "noise" ? 0 : Number.parseInt(cluster.slice(1), 10) || 0;
  return {
    method,
    object_id: `TOI-${String(index + 1).padStart(5, "0")}`,
    x: Number((Math.cos(angle) * radius + classOffset * 0.78 + methodIndex * 0.03).toFixed(5)),
    y: Number((Math.sin(angle) * radius + (classOffset % 2) * 0.65 - methodIndex * 0.04).toFixed(5)),
    cluster
  };
})));
const figPartitions = genericFigure("stage11-partition-comparison", "Partition comparison on UMAP", partitionMethods.map((method) => panel(
  `${method}-overlay`,
  method === "kmeans" ? "k-means · k=4" : method === "hdbscan" ? "HDBSCAN · min cluster size 25" : "DBSCAN · epsilon 2.19",
  partitionPoints,
  [layer("points", "point", { x: q("x", "UMAP 1"), y: q("y", "UMAP 2"), color: n("cluster", undefined, { scale_role: "semantic", legend: { title: "Assignment" } }), tooltip: n("object_id") }, { point_size: 14, opacity: 0.62 })],
  { transform: { op: "filter", field: "method", predicate: { eq: method } } }
)), { columns: 3 });
addStage(11, "Partition comparison", [figPartitions], "Fit partitions in the declared feature space and compare their assignments on one map.");

// Stage 12 — soft assignment.
const responsibilityHistogram = addData("max-responsibility-histogram", "mixture.max-responsibility-histogram", [F.number("responsibility"), F.integer("count")], linspace(0.25, 1, 30).map((responsibility, index) => ({ responsibility: Number(responsibility.toFixed(4)), count: Math.round(18 + 590 * Math.exp(-((index - 25) ** 2) / 42)) })));
const responsibilityMap = addData("responsibility-map", "mixture.embedding-responsibility", [F.string("object_id", "id"), F.number("x"), F.number("y"), F.number("max_responsibility")], Array.from({ length: 1400 }, (_, index) => ({
  object_id: `TOI-${String(index + 1).padStart(5, "0")}`,
  x: Number((Math.cos(index * 0.19) * (0.5 + (index % 43) / 31)).toFixed(5)),
  y: Number((Math.sin(index * 0.19) * (0.5 + (index % 43) / 31)).toFixed(5)),
  max_responsibility: Number((0.44 + 0.55 * ((index * 37) % 101) / 100).toFixed(5))
})));
const responsibilityMatrix = addData("responsibility-matrix", "mixture.responsibility-matrix", [F.string("object_id"), F.string("component"), F.number("responsibility")], Array.from({ length: 180 }, (_, index) => Array.from({ length: 4 }, (_, component) => {
  const primary = index % 4;
  const value = component === primary ? 0.58 + (index % 37) / 100 : (0.42 - (index % 37) / 100) / 3;
  return { object_id: `row-${String(primary)}-${String(index).padStart(3, "0")}`, component: `G${component + 1}`, responsibility: Number(Math.max(0.01, value).toFixed(5)) };
})).flat());
const figSoftAssignment = genericFigure("stage12-soft-assignment", "Gaussian-mixture soft assignment", [
  panel("max-responsibility", "How confident is the mixture?", responsibilityHistogram, [
    layer("histogram", "bar", { x: q("responsibility", "Maximum responsibility"), y: q("count", "Objects"), color: v("GMM", "nominal", { scale_role: "semantic" }) }),
    layer("threshold", "rule", { x: v(0.6) }, { role: "threshold", stroke_width: 2 }, { dataRef: referenceOne }),
    layer("threshold-label", "text", { x: v(0.6), y: v(560), text: v("280 below 0.6 (4%)", "nominal") }, { role: "annotation", dx: 5, dy: -5 }, { dataRef: referenceOne })
  ]),
  panel("responsibility-map", "Ambiguity is on the boundaries", responsibilityMap, [layer("points", "point", { x: q("x", "UMAP 1"), y: q("y", "UMAP 2"), color: q("max_responsibility", undefined, { scale_id: "responsibility-color", scale_role: "continuous", legend: { title: "Max responsibility" } }), tooltip: n("object_id") }, { point_size: 15, opacity: 0.72 })]),
  panel("responsibility-heatmap", "Sorted responsibility matrix", responsibilityMatrix, [layer("cells", "rect", { x: n("component", "Component"), y: n("object_id", "Objects sorted by component"), color: q("responsibility", undefined, { scale_id: "responsibility-color", scale_role: "sequential", legend: { title: "Responsibility" } }) })], { coordinate: "matrix", type: "matrix" })
], { columns: 3, scales: [{ id: "responsibility-color", type: "linear", domain: [0, 1], range: ["#E8EEF5", "#1D4E89"], scheme: "sequential", title: "Responsibility" }] });
addStage(12, "Soft assignment", [figSoftAssignment], "Show confidence, boundary ambiguity, and the full component responsibility pattern.");

// Stage 13 — partition validation, two ordered figures.
const silhouetteCurve = addData("silhouette-null", "partition.silhouette-null", [F.integer("k"), F.number("score"), F.string("series")], ["Observed", "Shuffled-feature null"].flatMap((series) => Array.from({ length: 9 }, (_, index) => {
  const k = index + 2;
  const observed = 0.19 + 0.11 * Math.exp(-((k - 4) ** 2) / 5);
  return { k, score: Number((series === "Observed" ? observed : 0.075 + 0.015 * Math.sin(k)).toFixed(5)), series };
})));
const bicCurve = addData("gmm-bic", "mixture.bic-curve", [F.integer("k"), F.number("bic")], Array.from({ length: 9 }, (_, index) => ({ k: index + 2, bic: Math.round(103500 - 1580 * index + 120 * Math.sin(index)) })));
const agreement = addData("partition-agreement", "partition.agreement-metrics", [F.string("comparison"), F.string("metric"), F.string("bar_label"), F.number("value")], [
  ["k-means vs GMM", 0.62, 0.58], ["k-means vs HDBSCAN", 0.18, 0.21], ["k-means vs DBSCAN", 0.04, 0.06], ["GMM vs disposition", 0.061, 0.079], ["k-means vs disposition", 0.054, 0.071]
].flatMap(([comparison, ari, nmi]) => [["ARI", ari], ["NMI", nmi]].map(([metric, value]) => ({ comparison, metric, bar_label: `${comparison} · ${metric}`, value }))));
const figPartitionValidationA = genericFigure("stage13-partition-validation-a", "Partition validation · model order and agreement", [
  panel("silhouette", "Silhouette never gets good", silhouetteCurve, [layer("curves", "line", { x: q("k", "Cluster count k"), y: q("score", "Silhouette"), color: n("series", undefined, { scale_role: "semantic", legend: { title: "Series" } }), group: n("series") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("bic", "BIC prefers k=10 at the range edge", bicCurve, [layer("bic-line", "line", { x: q("k", "Components k"), y: q("bic", "BIC") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("agreement", "Agreement between methods and labels", agreement, [layer("agreement-bars", "bar", { x: q("value", "Agreement"), y: n("bar_label", "Comparison"), color: n("metric", undefined, { scale_role: "semantic", legend: { title: "Metric" } }), group: n("metric") }, { orient: "horizontal" })])
], { columns: 3 });

const silhouetteSpaces = addData("silhouette-spaces", "partition.silhouette-by-space", [F.string("space"), F.string("scored_in"), F.string("bar_label"), F.number("score")], [
  ["UMAP-2", 0.42, 0.14], ["t-SNE-2", 0.39, 0.13], ["PCA-2", 0.24, 0.16], ["PCA-6", 0.20, 0.18], ["Standardised-11D", 0.18, 0.18]
].flatMap(([space, own, eleven]) => [["Own space", own], ["11-D", eleven]].map(([scored_in, score]) => ({ space, scored_in, bar_label: `${space} · ${scored_in}`, score }))));
const seedAri = addData("partition-seed-ari", "partition.seed-reproducibility", [F.string("method"), F.number("ari")], [
  { method: "UMAP seed rerun", ari: 0.879 }, { method: "k-means seed rerun", ari: 0.983 }
]);
const figPartitionValidationB = genericFigure("stage13-partition-validation-b", "Partition validation · space and reproducibility", [
  panel("space-scoring", "The same partition, scored two ways", silhouetteSpaces, [layer("space-bars", "bar", { x: q("score", "Silhouette"), y: n("bar_label", "Space · scoring space"), color: n("scored_in", undefined, { scale_role: "semantic", legend: { title: "Scored in" } }), group: n("scored_in") }, { orient: "horizontal" })]),
  panel("seed-reproducibility", "Is the partition reproducible?", seedAri, [layer("ari-bars", "bar", { x: q("ari", "ARI between reruns"), y: n("method", "Method"), color: n("method", undefined, { scale_role: "semantic", legend: false }) }, { orient: "horizontal" })])
], { columns: 2 });
addStage(13, "Partition validation", [figPartitionValidationA, figPartitionValidationB], "Separate apparent map tidiness from stable high-dimensional partition evidence.");

// Stage 14 — vector quantisation and the interactive codeword explorer.
const distortion = addData("vq-distortion", "vq.distortion-curve", [F.integer("k"), F.number("distortion")], [2, 4, 8, 16, 32, 64].map((k) => ({ k, distortion: Number((7.8 / Math.sqrt(k) + 1.35).toFixed(5)) })));
const designMatrix = addData("vq-design-matrix", "vq.cluster-sorted-design-matrix", [F.string("object_id"), F.string("feature"), F.number("z"), F.integer("codeword", "dimension")], Array.from({ length: 144 }, (_, row) => structureFeatures.map((feature, column) => ({ object_id: `C${row % 8}-${String(row).padStart(3, "0")}`, feature, z: Number((Math.max(-3, Math.min(3, Math.sin(row * 0.17 + column * 0.71) * 1.6 + (row % 8 - 3.5) * 0.08))).toFixed(5)), codeword: row % 8 }))).flat());
const planetFraction = addData("vq-planet-fraction", "vq.codeword-planet-fraction", [F.string("codeword"), F.integer("adjudicated"), F.number("planet_fraction")], [
  ["C0", 206, 0.08], ["C1", 188, 0.19], ["C2", 241, 0.31], ["C3", 305, 0.41], ["C4", 298, 0.49], ["C5", 342, 0.58], ["C6", 361, 0.69], ["C7", 301, 0.78]
].map(([codeword, adjudicated, planet_fraction]) => ({ codeword, adjudicated, planet_fraction })));
const figVqA = genericFigure("stage14-vector-quantisation-a", "Vector quantisation · codebook and profiles", [
  panel("distortion", "Distortion versus codebook size", distortion, [layer("distortion-line", "line", { x: q("k", "Codebook size k"), y: q("distortion", "Distortion") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("design-matrix", "Design matrix, cluster-sorted", designMatrix, [layer("cells", "rect", { x: n("feature", "Seriated feature"), y: n("object_id", "Objects sorted by codeword"), color: q("z", undefined, { scale_role: "diverging", legend: { title: "z score" } }) })], { coordinate: "matrix", type: "matrix" }),
  panel("planet-fraction", "Codewords are not classes", planetFraction, [
    layer("fractions", "bar", { x: n("codeword", "Codeword"), y: q("planet_fraction", "Planet fraction", { axisFormat: "percent" }), color: n("codeword", undefined, { scale_role: "semantic", legend: false }) }),
    layer("base-rate", "rule", { y: v(0.46) }, { role: "reference", stroke_width: 2 }, { dataRef: referenceOne })
  ])
], { columns: 3 });

const vqSizes = [2, 4, 6, 8, 10, 12, 14, 16];
const reconstruction = addData("vq-reconstruction", "vq.space-reconstruction", [F.integer("k"), F.string("space"), F.number("error")], ["PCA-6", "PCA-6-to-UMAP-2"].flatMap((space, spaceIndex) => vqSizes.map((k) => {
  const base = k === 8 ? 4.723 : 3.45 + 3.6 / Math.sqrt(k);
  return { k, space, error: Number((base * (spaceIndex ? 1.03 + 0.008 * k : 1)).toFixed(5)) };
})));
const excessError = addData("vq-excess-error", "vq.embedding-excess-error", [F.integer("k"), F.number("excess_percent")], vqSizes.map((k) => ({ k, excess_percent: Number((3 + 12 * (k - 2) / 14).toFixed(5)) })));
const vqAgreement = addData("vq-map-agreement", "vq.space-agreement", [F.integer("k"), F.string("series"), F.number("score")], ["PCA-6 silhouette", "Map silhouette", "ARI between codebooks"].flatMap((series, seriesIndex) => vqSizes.map((k) => {
  let score = seriesIndex === 0 ? 0.24 + 0.04 * Math.exp(-((k - 8) ** 2) / 18) : seriesIndex === 1 ? 0.20 + 0.04 * Math.exp(-((k - 8) ** 2) / 18) : 0.34 + 0.11 * Math.exp(-((k - 8) ** 2) / 20);
  if (k === 8) score = [0.28, 0.24, 0.45][seriesIndex];
  return { k, series, score: Number(score.toFixed(5)) };
})));
const figVqB = genericFigure("stage14-vector-quantisation-b", "Vector quantisation · space comparison", [
  panel("reconstruction", "What the codebook is for", reconstruction, [layer("reconstruction-lines", "line", { x: q("k", "Codebook size k"), y: q("error", "11-D reconstruction error"), color: n("space", undefined, { scale_role: "semantic", legend: { title: "Codebook space" } }), group: n("space") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("excess-error", "Cost of quantising in the embedding", excessError, [layer("excess-bars", "bar", { x: o("k", "Codebook size k"), y: q("excess_percent", "Excess error (%)"), color: v("embedding cost", "nominal", { scale_role: "semantic" }) })]),
  panel("map-agreement", "Tidiness on the map and agreement", vqAgreement, [layer("agreement-lines", "line", { x: q("k", "Codebook size k"), y: q("score", "Score"), color: n("series", undefined, { scale_role: "semantic", legend: { title: "Metric" } }), group: n("series") }, { stroke_width: 2.2, point: true, point_size: 2.6 })])
], { columns: 3 });

const explorerSpaces = ["PCA-6", "PCA-6-to-UMAP-2"];
const explorerSizes = vqSizes;
const explorerPoints = addData("vq-explorer-points", "vq.interactive-codeword-map", [F.string("object_id", "id"), F.string("space", "metadata"), F.integer("k", "metadata"), F.integer("codeword", "dimension"), F.number("x"), F.number("y")], explorerSpaces.flatMap((space, spaceIndex) => explorerSizes.flatMap((k) => Array.from({ length: 240 }, (_, index) => {
  const codeword = index % k;
  const angle = index * 0.193 + codeword * 0.47;
  const radius = 0.35 + (index % 29) / 25;
  return {
    object_id: `TOI-${String(index + 1).padStart(5, "0")}`,
    space,
    k,
    codeword,
    x: Number((Math.cos(angle) * radius + (codeword % 4) * 0.65 + spaceIndex * 0.12).toFixed(5)),
    y: Number((Math.sin(angle) * radius + Math.floor(codeword / 4) * 0.78 - spaceIndex * 0.08).toFixed(5))
  };
}))));
const explorerProfiles = addData("vq-explorer-profiles", "vq.codeword-feature-profile", [F.string("space", "metadata"), F.integer("k", "metadata"), F.integer("codeword", "dimension"), F.string("feature"), F.number("mean"), F.number("lower"), F.number("upper")], explorerSpaces.flatMap((space, spaceIndex) => explorerSizes.flatMap((k) => Array.from({ length: k }, (_, codeword) => structureFeatures.map((feature, featureIndex) => {
  const mean = Math.max(-2.5, Math.min(2.5, Math.sin((codeword + 1) * (featureIndex + 1) * 0.31 + spaceIndex * 0.4) * 1.65));
  const spread = 0.24 + ((codeword + featureIndex) % 5) * 0.07;
  return { space, k, codeword, feature, mean: Number(mean.toFixed(5)), lower: Number(Math.max(-3, mean - spread).toFixed(5)), upper: Number(Math.min(3, mean + spread).toFixed(5)) };
})).flat())));
const explorerTargets = ["codeword-map/codeword-points", "codeword-profile/profile-points", "codeword-profile/profile-errors"];
const figVqExplorer = genericFigure("stage14-codeword-explorer", "Interactive codeword explorer", [
  panel("codeword-map", "Codeword map", explorerPoints, [layer("codeword-points", "point", { x: q("x"), y: q("y"), color: n("codeword", undefined, { scale_role: "semantic", legend: { title: "Codeword" } }), tooltip: n("object_id") }, { point_size: 16, opacity: 0.72 })], { coordinate: "canvas" }),
  panel("codeword-profile", "Hovered codeword feature profile", explorerProfiles, [
    layer("profile-errors", "errorbar", { x: n("feature", "Feature"), y: q("mean", "Mean z score", { scale_id: "profile-y" }), y_lower: q("lower", undefined, { scale_id: "profile-y" }), y_upper: q("upper", undefined, { scale_id: "profile-y" }), color: n("codeword", undefined, { scale_role: "semantic", legend: { title: "Codeword" } }), group: n("codeword") }, { stroke_width: 1.5 }),
    layer("profile-points", "point", { x: n("feature", "Feature"), y: q("mean", "Mean z score", { scale_id: "profile-y" }), color: n("codeword", undefined, { scale_role: "semantic", legend: false }), group: n("codeword") }, { point_size: 32, opacity: 0.85 })
  ])
], {
  columns: 2,
  scales: [{ id: "profile-y", type: "linear", domain: [-3, 3], title: "Feature z score" }],
  interactions: [
    { id: "explorer-space", type: "parameter", parameter: "space", control: "select", label: "Codebook space", options: explorerSpaces, default: "PCA-6", targets: explorerTargets },
    { id: "explorer-k", type: "parameter", parameter: "k", control: "range", label: "Codebook size k", minimum: 2, maximum: 16, step: 2, default: 8, targets: explorerTargets },
    { id: "explorer-map-tooltip", type: "tooltip", targets: ["codeword-map/codeword-points"], fields: ["object_id", "codeword", "space", "k"], mode: "nearest" },
    { id: "explorer-profile-tooltip", type: "tooltip", targets: ["codeword-profile/profile-points", "codeword-profile/profile-errors"], fields: ["codeword", "feature", "mean", "lower", "upper"], mode: "nearest" },
    { id: "explorer-linked-codeword", type: "linked_highlight", targets: explorerTargets, fields: ["codeword"] }
  ]
});
addStage(14, "Vector quantisation", [figVqA, figVqB, figVqExplorer], "Compare codebook objectives, space dependence, class composition, and linked codeword profiles.");

// Stage 15 — supervised task setup.
const splitLeakage = addData("split-leakage", "supervised.split-leakage-audit", [F.string("strategy"), F.integer("shared_hosts")], [
  { strategy: "Stratified rows", shared_hosts: 41 }, { strategy: "Grouped by TIC ID", shared_hosts: 0 }
]);
const splitClasses = addData("split-class-balance", "supervised.split-class-counts", [F.string("split"), F.string("class"), F.number("interval_start"), F.number("interval_end"), F.integer("count")], [
  ["Train (n=1,567)", "Planet", 0, 720, 720], ["Train (n=1,567)", "False positive", 720, 1567, 847],
  ["Test (n=672)", "Planet", 0, 309, 309], ["Test (n=672)", "False positive", 309, 672, 363]
].map(([split, className, interval_start, interval_end, count]) => ({ split, class: className, interval_start, interval_end, count })));
const pipelineSteps = addData("pipeline-steps", "supervised.pipeline-order", [F.string("id", "id"), F.string("label", "label")], [
  { id: "split", label: "Split by host" }, { id: "impute", label: "Median impute" }, { id: "scale", label: "Standardise" }, { id: "fit", label: "Fit model" }
]);
const figTaskSetup = genericFigure("stage15-task-setup", "Leak-safe supervised task setup", [
  panel("split-leakage", "Why the split must be grouped", splitLeakage, [layer("leakage-bars", "bar", { x: n("strategy", "Split strategy"), y: q("shared_hosts", "Hosts in both splits"), color: n("strategy", undefined, { scale_role: "semantic", legend: false }) })]),
  panel("class-balance", "Class balance after the split", splitClasses, [layer("class-segments", "bar", { x: q("interval_end", "Rows"), x2: q("interval_start"), y: n("split", "Split"), color: n("class", undefined, { scale_role: "semantic", legend: { title: "Class" } }), group: n("class") }, { orient: "horizontal" })]),
  panel("pipeline-order", "Pipeline order · hard rule", pipelineSteps, [layer("steps", "node", { key: n("id"), text: n("label") })], { coordinate: "flow", type: "diagram" })
], { columns: 3 });
addStage(15, "Task setup", [figTaskSetup], "Audit host leakage, class balance, and the split-before-fit pipeline rule.");

// Stage 16 — interpretable supervised models.
const coefficients = addData("interpretable-coefficients", "model.logistic-coefficients", [F.string("feature"), F.number("coefficient")], structureFeatures.map((feature, index) => ({ feature, coefficient: [0.18, -0.12, 0.71, -0.86, 0.24, -0.09, 0.16, 0.08, -0.31, -0.44, 0.21][index] })));
const rocDefinitions = [
  ["Logistic · AUC 0.789", 0.789], ["Polynomial logistic · AUC 0.868", 0.868], ["CART depth 5 · AUC 0.794", 0.794]
];
const rocCurves = addData("interpretable-roc", "model.roc-curves", [F.string("model"), F.number("fpr"), F.number("tpr")], rocDefinitions.flatMap(([model, auc]) => {
  const exponent = 1 / auc - 1;
  return linspace(0, 1, 51).map((fpr) => ({ model, fpr: Number(fpr.toFixed(5)), tpr: Number((fpr ** exponent).toFixed(5)) }));
}));
const treeDepth = addData("tree-depth-sweep", "model.tree-depth-sweep", [F.integer("depth"), F.number("accuracy"), F.string("split")], ["Train", "Held-out"].flatMap((split) => Array.from({ length: 7 }, (_, index) => {
  const depth = index + 2;
  const accuracy = split === "Train" ? 0.72 + 0.036 * index : 0.713 + 0.032 * Math.exp(-((depth - 5) ** 2) / 5);
  return { depth, accuracy: Number(accuracy.toFixed(5)), split };
})));
const treeNodes = addData("decision-tree-nodes", "hierarchy.decision-tree-nodes", [F.string("id", "id"), F.string("label", "label"), F.string("kind")], Array.from({ length: 15 }, (_, index) => ({
  id: `node-${index}`,
  label: index < 7 ? `${structureFeatures[index % structureFeatures.length]} <= ${Number((0.2 + index * 0.17).toFixed(2))}` : `${index % 2 ? "Planet" : "False positive"} · ${8 + index}%`,
  kind: index < 7 ? "split" : "leaf"
})));
const treeLinks = addData("decision-tree-links", "hierarchy.decision-tree-links", [F.string("source", "id"), F.string("target", "id")], Array.from({ length: 14 }, (_, index) => ({ source: `node-${Math.floor(index / 2)}`, target: `node-${index + 1}` })));
const figInterpretable = genericFigure("stage16-interpretable-models", "Interpretable supervised models", [
  panel("coefficients", "What the linear model uses", coefficients, [layer("coefficient-bars", "bar", { x: q("coefficient", "Standardised coefficient"), y: n("feature", "Feature"), color: q("coefficient", undefined, { scale_role: "diverging", legend: { title: "Coefficient" } }) }, { orient: "horizontal" })]),
  panel("roc", "Held-out ROC", rocCurves, [
    layer("chance", "rule", { x: v(0), y: v(0), x2: v(1), y2: v(1) }, { role: "reference" }, { dataRef: referenceOne }),
    layer("roc-lines", "line", { x: q("fpr", "False-positive rate"), y: q("tpr", "True-positive rate"), color: n("model", undefined, { scale_role: "semantic", legend: { title: "Model" } }), group: n("model") }, { stroke_width: 2.2 })
  ]),
  panel("depth-sweep", "Where the tree starts memorising", treeDepth, [layer("depth-lines", "line", { x: q("depth", "Maximum depth"), y: q("accuracy", "Accuracy"), color: n("split", undefined, { scale_role: "semantic", legend: { title: "Split" } }), group: n("split") }, { stroke_width: 2.2, point: true, point_size: 2.6 })]),
  panel("decision-tree", "Depth-3 tree, in full", treeNodes, [
    layer("tree-links", "link", { from: n("source"), to: n("target") }, { stroke_width: 1.5 }, { dataRef: treeLinks }),
    layer("tree-nodes", "node", { key: n("id"), text: n("label"), color: n("kind", undefined, { scale_role: "semantic", legend: { title: "Node" } }) }, { opacity: 0.86 })
  ], { coordinate: "tree", type: "tree" })
], { columns: 2, rows: 2 });
addStage(16, "Interpretable models", [figInterpretable], "Compare linear effects, held-out discrimination, tree capacity, and the complete shallow tree.");

// Stage 17 — ensembles.
const ensembleAuc = addData("ensemble-auc", "model.heldout-auc", [F.string("model"), F.number("auc")], [
  ["Logistic", 0.789], ["CART depth 5", 0.794], ["Random forest", 0.913], ["Gradient boosting", 0.902], ["RF + ratio features", 0.919]
].map(([model, auc]) => ({ model, auc })));
const importanceMeans = [0.052, 0.031, 0.047, 0.081, 0.09, 0.018, 0.039, 0.022, 0.028, 0.064, 0.035];
const permutationImportance = addData("permutation-importance", "model.permutation-importance", [F.string("feature"), F.number("mean"), F.number("lower"), F.number("upper")], structureFeatures.map((feature, index) => {
  const spread = 0.004 + (index % 4) * 0.002;
  return { feature, mean: importanceMeans[index], lower: importanceMeans[index] - spread, upper: importanceMeans[index] + spread };
}));
const modelAgreement = addData("linear-nonlinear-agreement", "model.feature-agreement", [F.string("feature"), F.number("coefficient_abs"), F.number("importance")], structureFeatures.map((feature, index) => ({ feature, coefficient_abs: Math.abs([0.18, -0.12, 0.71, -0.86, 0.24, -0.09, 0.16, 0.08, -0.31, -0.44, 0.21][index]), importance: importanceMeans[index] })));
const figEnsembles = genericFigure("stage17-ensembles", "Ensemble gains and feature use", [
  panel("auc", "What the ensemble buys", ensembleAuc, [layer("auc-bars", "bar", { x: n("model", "Model"), y: q("auc", "Held-out AUC"), color: n("model", undefined, { scale_role: "semantic", legend: false }) })]),
  panel("importance", "What the forest uses", permutationImportance, [
    layer("importance-bars", "bar", { x: n("feature", "Feature"), y: q("mean", "Mean AUC drop"), color: v("Random forest", "nominal", { scale_role: "semantic" }) }),
    layer("importance-errors", "errorbar", { x: n("feature"), y: q("mean"), y_lower: q("lower"), y_upper: q("upper"), color: v("15 shuffles", "nominal", { scale_role: "semantic" }) }, { stroke_width: 1.6 })
  ]),
  panel("agreement", "Linear and nonlinear agreement", modelAgreement, [
    layer("features", "point", { x: q("coefficient_abs", "Absolute logistic coefficient"), y: q("importance", "Permutation importance"), color: n("feature", undefined, { scale_role: "semantic", legend: false }) }, { point_size: 44 }),
    layer("labels", "text", { x: q("coefficient_abs"), y: q("importance"), text: n("feature") }, { role: "annotation", dx: 5, dy: -5 })
  ])
], { columns: 3 });
addStage(17, "Ensembles", [figEnsembles], "Quantify ensemble gains and compare linear with nonlinear feature evidence.");

// Stage 18 — validation.
const cvScores = addData("cv-scores", "validation.grouped-cv", [F.string("model"), F.number("mean"), F.number("lower"), F.number("upper")], [
  ["Logistic", 0.703, 0.008], ["CART depth 5", 0.750, 0.007], ["Random forest", 0.826, 0.006]
].map(([model, mean, se]) => ({ model, mean, lower: mean - se, upper: mean + se })));
const learningCurve = addData("learning-curve", "validation.learning-curve", [F.integer("n_train"), F.string("series"), F.number("score"), F.number("lower"), F.number("upper")], [300, 550, 800, 1050, 1300, 1567].flatMap((nTrain, index) => {
  const train = 0.92 - index * 0.012;
  const held = 0.69 + index * 0.025;
  const spread = 0.032 - index * 0.003;
  return [
    { n_train: nTrain, series: "Train", score: train, lower: train, upper: train },
    { n_train: nTrain, series: "Held-out", score: held, lower: held - spread, upper: held + spread }
  ];
}));
const calibration = addData("calibration", "validation.calibration-curve", [F.number("predicted"), F.number("observed")], linspace(0.05, 0.95, 10).map((predicted, index) => ({ predicted: Number(predicted.toFixed(5)), observed: Number(Math.max(0, Math.min(1, predicted * 0.91 + 0.055 + 0.035 * Math.sin(index))).toFixed(5)) })));
const confusion = addData("confusion", "validation.row-normalised-confusion", [F.string("actual"), F.string("predicted"), F.number("value")], [
  ["False positive", "False positive", 0.83], ["False positive", "Planet", 0.17], ["Planet", "False positive", 0.15], ["Planet", "Planet", 0.85]
].map(([actual, predicted, value]) => ({ actual, predicted, value })));
const figValidation = genericFigure("stage18-validation", "Grouped validation and calibration", [
  panel("cv", "Scores against their nulls", cvScores, [
    layer("score-bars", "bar", { x: n("model", "Model"), y: q("mean", "Balanced accuracy"), color: n("model", undefined, { scale_role: "semantic", legend: false }) }),
    layer("score-errors", "errorbar", { x: n("model"), y: q("mean"), y_lower: q("lower"), y_upper: q("upper"), color: v("SE", "nominal", { scale_role: "semantic" }) }, { stroke_width: 1.6 }),
    layer("majority", "rule", { y: v(0.539) }, { role: "reference" }, { dataRef: referenceOne }),
    layer("permuted", "rule", { y: v(0.5) }, { role: "reference" }, { dataRef: referenceOne })
  ]),
  panel("learning", "More data would still help", learningCurve, [
    layer("heldout-band", "band", { x: q("n_train", "Training rows"), y: q("lower"), y2: q("upper"), color: v("Held-out uncertainty", "nominal", { scale_role: "semantic" }) }, { role: "uncertainty", opacity: 0.2 }, { transform: { op: "filter", field: "series", predicate: { eq: "Held-out" } } }),
    layer("learning-lines", "line", { x: q("n_train", "Training rows"), y: q("score", "Balanced accuracy"), color: n("series", undefined, { scale_role: "semantic", legend: { title: "Series" } }), group: n("series") }, { stroke_width: 2.2, point: true, point_size: 2.6 })
  ]),
  panel("calibration", "Calibration · random forest", calibration, [
    layer("identity", "rule", { x: v(0), y: v(0), x2: v(1), y2: v(1) }, { role: "reference" }, { dataRef: referenceOne }),
    layer("observed", "line", { x: q("predicted", "Predicted probability"), y: q("observed", "Observed frequency") }, { stroke_width: 2.2 }),
    layer("observed-points", "point", { x: q("predicted"), y: q("observed") }, { point_size: 34 })
  ]),
  panel("confusion", "Confusion · row normalised", confusion, [
    layer("cells", "rect", { x: n("predicted", "Predicted"), y: n("actual", "Actual"), color: q("value", undefined, { scale_role: "sequential", legend: { title: "Row fraction" } }) }),
    layer("values", "text", { x: n("predicted"), y: n("actual"), text: q("value", undefined, { format: "percent" }) }, { role: "annotation" })
  ], { coordinate: "matrix", type: "matrix" })
], { columns: 2, rows: 2 });
addStage(18, "Validation", [figValidation], "Use host-grouped folds, learning curves, calibration, and row-normalised errors; the leak probe is 0.720 versus 0.703 without the suspect column.");

// Stage 19 — scientific close.
const confounderNmi = addData("confounder-nmi", "science.metadata-nmi", [F.string("metadata"), F.string("target"), F.string("bar_label"), F.number("nmi")], [
  ["eqt_convention", 0.11, 0.08], ["tess_magnitude", 0.05, 0.16], ["dec_deg", 0.02, 0.04], ["ra_deg", 0.018, 0.035], ["row_updated_year", 0.044, 0.052], ["created_year", 0.038, 0.049]
].flatMap(([metadata, disposition, cluster]) => [["Disposition", disposition], ["k-means cluster", cluster]].map(([target, nmi]) => ({ metadata, target, bar_label: `${metadata} · ${target}`, nmi }))));
const skyMap = addData("sky-map", "science.sky-cluster-map", [F.number("ra_deg"), F.number("dec_deg"), F.string("cluster")], Array.from({ length: 1600 }, (_, index) => ({
  ra_deg: Number(((index * 137.508) % 360).toFixed(5)),
  dec_deg: Number((70 * Math.sin(index * 0.071) * Math.cos(index * 0.013)).toFixed(5)),
  cluster: `C${index % 4}`
})));
const yearlyFraction = addData("yearly-planet-fraction", "science.temporal-stationarity", [F.integer("year"), F.number("planet_fraction")], [2018, 2019, 2020, 2021, 2022, 2023, 2024].map((year, index) => ({ year, planet_fraction: [0.51, 0.49, 0.47, 0.45, 0.44, 0.43, 0.42][index] })));
const figScientificClose = genericFigure("stage19-scientific-close", "Back to the science", [
  panel("confounders", "Confounder check, every metadata column", confounderNmi, [layer("nmi-bars", "bar", { x: q("nmi", "Normalised mutual information"), y: n("bar_label", "Metadata · target"), color: n("target", undefined, { scale_role: "semantic", legend: { title: "Compared with" } }), group: n("target") }, { orient: "horizontal" })]),
  panel("sky", "Clusters are not a patch of sky", skyMap, [layer("sky-points", "point", { x: q("ra_deg", "Right ascension (deg)"), y: q("dec_deg", "Declination (deg)"), color: n("cluster", undefined, { scale_role: "semantic", legend: { title: "k-means cluster" } }) }, { point_size: 12, opacity: 0.48 })]),
  panel("time", "The sample is not stationary in time", yearlyFraction, [
    layer("fraction-line", "line", { x: q("year", "TOI-issued year"), y: q("planet_fraction", "Adjudicated planet fraction", { axisFormat: "percent" }) }, { stroke_width: 2.2, point: true, point_size: 2.6 }),
    layer("base-rate", "rule", { y: v(0.46) }, { role: "reference", stroke_width: 1.8 }, { dataRef: referenceOne })
  ])
], { columns: 3 });
addStage(19, "Scientific close", [figScientificClose], "Close with metadata, sky-position, and temporal confounder checks plus explicit provenance.");

const payload = {
  schema_version: "3.0.0",
  renderer_contract: { name: "render-payload-dashboard", version: "3.0.0", strict: true },
  report: {
    title: "TESS Objects of Interest · visualization reference package",
    subtitle: "20-stage method spine rendered from payload.json + verified data sidecars",
    summary: "A deterministic visual-coverage package reproducing the reference report's figure structure with declared illustrative arrays and Inventory-grounded summary values.",
    claim: "The package demonstrates that chart intent, data semantics, interactions, and accordion order can be carried entirely by a strict payload plus typed sidecars.",
    facts: [
      { label: "Raw TOIs", value: 7372 }, { label: "After QC", value: 7364 }, { label: "Features", value: 11 },
      { label: "Accordion stages", value: 20 }, { label: "Figures", value: 24 }
    ],
    final_verdict: "Renderer acceptance fixture only: controlled arrays are not a substitute for the original TESS analysis outputs."
  },
  run: { id: "tess-reference-package", label: "TESS visualization acceptance", status: "complete", seed: 0, notes: ILLUSTRATIVE },
  dataset: { id: "tess-toi-reference", title: "TESS Objects of Interest · controlled visual reference", description: ILLUSTRATIVE, row_count: 7364, feature_count: 11, target: "disposition" },
  provenance: {
    generator: { name: "generate-tess-reference-package", version: "1.0.0" },
    inputs: [
      { id: "tess-inventory", kind: "configuration", description: "Read-only Inventory summary of the reference dashboard." },
      { id: "controlled-arrays", kind: "dataset", description: "Deterministic illustrative arrays generated locally; not original scientific measurements." }
    ],
    notes: "Reference snapshot: 2025-02-03; seed 0; summary inventory reports sklearn 1.6.1 and umap-learn 0.5.12. Original PNG arrays were not digitised."
  },
  theme: {
    name: "tess",
    mode: "light",
    palette: "colorblind-safe",
    density: "comfortable",
    semantic_colors: {
      Planet: "#2F6B8A",
      False_positive: "#D97941",
      Open: "#8C96A5",
      Candidate: "#527EAA",
      Confirmed: "#2D7D63",
      noise: "#A9B0B8"
    }
  },
  data: resources,
  sections,
  figures
};

function assert(condition, message) {
  if (!condition) throw new Error(`TESS acceptance assertion failed: ${message}`);
}

function acceptanceReceipt() {
  assert(sections.length === 20, `expected 20 sections; received ${sections.length}`);
  assert(figures.length === 24, `expected 24 figures; received ${figures.length}`);
  sections.forEach((section, index) => {
    assert(section.number === index, `section ${index} has number ${section.number}`);
    assert(section.id === `stage-${String(index).padStart(2, "0")}`, `section order/id mismatch at ${index}`);
  });

  const figureIds = new Set(figures.map((figure) => figure.id));
  assert(figureIds.size === figures.length, "figure ids are not unique");
  const references = sections.flatMap((section) => section.figure_ids);
  assert(references.length === figures.length, `expected exactly one section reference per figure; received ${references.length}`);
  for (const id of figureIds) assert(references.filter((reference) => reference === id).length === 1, `figure ${id} is not referenced exactly once`);
  for (const reference of references) assert(figureIds.has(reference), `unknown figure reference ${reference}`);

  const expandedById = new Map(figures.map((figure, index) => [figure.id, defaultRecipeRegistry.expand(figure, { path: `/figures/${index}` })]));
  const panelCount = [...expandedById.values()].reduce((count, panels) => count + panels.length, 0);
  const layerCount = [...expandedById.values()].flat().reduce((count, currentPanel) => count + currentPanel.layers.length + (currentPanel.annotations?.length || 0), 0);
  assert(panelCount === 73, `expected 73 expanded panels; received ${panelCount}`);
  assert(layerCount === 103, `expected 103 expanded layers; received ${layerCount}`);
  assert(resources.length === 69, `expected 69 data sources; received ${resources.length}`);
  assert(sidecarFiles.length === 69, `expected 69 sidecars; received ${sidecarFiles.length}`);
  const expectedCumulativePanels = [4, 6, 8, 11, 14, 16, 19, 25, 28, 34, 37, 40, 43, 48, 56, 59, 63, 66, 70, 73];
  let cumulativePanels = 0;
  sections.forEach((section, index) => {
    cumulativePanels += section.figure_ids.reduce((count, id) => count + expandedById.get(id).length, 0);
    assert(cumulativePanels === expectedCumulativePanels[index], `stage ${index} cumulative panel count ${cumulativePanels}, expected ${expectedCumulativePanels[index]}`);
  });

  const interactiveFigures = figures.filter((figure) => figure.interactions?.length);
  assert(interactiveFigures.length === 1, `expected one interactive figure; received ${interactiveFigures.length}`);
  const explorer = figures.find((figure) => figure.id === "stage14-codeword-explorer");
  assert(explorer, "Stage 14 explorer is missing");
  assert(explorer.panels.length === 2, `Stage 14 explorer requires 2 panels; received ${explorer.panels.length}`);
  assert(explorer.panels[0].coordinate.type === "canvas" && explorer.panels[1].coordinate.type === "cartesian", "Stage 14 explorer must be Canvas + cartesian profile");
  assert(explorer.interactions.length === 5, `Stage 14 explorer requires 5 interactions; received ${explorer.interactions.length}`);

  return {
    section_count: sections.length,
    figure_count: figures.length,
    panel_count: panelCount,
    layer_count: layerCount,
    interactive_figure_count: interactiveFigures.length,
    data_source_count: resources.length,
    sidecar_count: sidecarFiles.length
  };
}

const receipt = acceptanceReceipt();
await mkdir(DATA_DIR, { recursive: true });
await Promise.all(sidecarFiles.map((file) => writeFile(resolve(OUTPUT_DIR, file.relativePath), file.content, "utf8")));
await writeFile(PAYLOAD_PATH, stableJson(payload), "utf8");
const compilation = await buildDashboard({ inputPath: PAYLOAD_PATH, outputPath: DASHBOARD_PATH });
for (const key of ["section_count", "figure_count", "panel_count", "layer_count", "interactive_figure_count", "data_source_count", "sidecar_count"]) {
  assert(compilation[key] === receipt[key], `compiler ${key} ${compilation[key]}, expected ${receipt[key]}`);
}
assert(compilation.warnings.length === 0, `compiler returned ${compilation.warnings.length} warning(s)`);
process.stdout.write(`${JSON.stringify({
  output: OUTPUT_DIR,
  payload: PAYLOAD_PATH,
  dashboard: DASHBOARD_PATH,
  ...receipt,
  interaction_count: compilation.interaction_count,
  output_bytes: compilation.output_bytes,
  output_sha256: compilation.output_sha256,
  warnings: compilation.warnings
}, null, 2)}\n`);
