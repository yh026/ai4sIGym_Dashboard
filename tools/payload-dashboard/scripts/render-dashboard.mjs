#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDiagnostics as formatV3Diagnostics,
  normalizePayloadV3,
  validatePayloadV3,
  verifyPayloadV3Sidecars
} from "./lib/payload-v3.mjs";

export const GENERATOR_VERSION = "2.0.0";
export const SUPPORTED_KINDS = new Set(["distribution", "matrix", "curve", "predictions", "assignments", "tree_structure"]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(scriptDirectory, "..");
const assetsDirectory = join(skillDirectory, "assets");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function uniqueValues(values) {
  return new Set(values).size === values.length;
}

function validateNumericArray(value, pointer, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${pointer}: expected an array`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isFiniteNumber(entry)) errors.push(`${pointer}/${index}: expected a finite number`);
  });
}

function validateArtifact(artifact, pointer, errors, warnings, artifactIds) {
  if (!isObject(artifact)) {
    errors.push(`${pointer}: expected an object`);
    return;
  }
  if (typeof artifact.id !== "string" || !artifact.id) errors.push(`${pointer}/id: expected a non-empty string`);
  else if (artifactIds.has(artifact.id)) errors.push(`${pointer}/id: duplicate artifact id ${artifact.id}`);
  else artifactIds.add(artifact.id);
  if (!SUPPORTED_KINDS.has(artifact.kind)) {
    errors.push(`${pointer}/kind: unsupported artifact kind ${String(artifact.kind)}`);
    return;
  }

  if (artifact.kind === "distribution") {
    const hasCategories = Array.isArray(artifact.categories) || Array.isArray(artifact.counts);
    const hasSamples = Array.isArray(artifact.samples);
    if (hasCategories) {
      if (!Array.isArray(artifact.categories) || !Array.isArray(artifact.counts)) errors.push(`${pointer}: categories and counts must both be arrays`);
      else {
        if (artifact.categories.length !== artifact.counts.length) errors.push(`${pointer}: categories and counts must have equal length`);
        validateNumericArray(artifact.counts, `${pointer}/counts`, errors);
      }
    } else if (hasSamples) validateNumericArray(artifact.samples, `${pointer}/samples`, errors);
    else errors.push(`${pointer}: distribution requires categories/counts or samples`);
  }

  if (artifact.kind === "matrix") {
    if (!Array.isArray(artifact.row_labels) || !Array.isArray(artifact.col_labels) || !Array.isArray(artifact.values)) {
      errors.push(`${pointer}: matrix requires row_labels, col_labels, and values arrays`);
    } else {
      if (artifact.values.length !== artifact.row_labels.length) errors.push(`${pointer}/values: row count must match row_labels`);
      artifact.values.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) errors.push(`${pointer}/values/${rowIndex}: expected an array`);
        else {
          if (row.length !== artifact.col_labels.length) errors.push(`${pointer}/values/${rowIndex}: column count must match col_labels`);
          validateNumericArray(row, `${pointer}/values/${rowIndex}`, errors);
        }
      });
      if (artifact.col_labels.length === 1 && artifact.row_labels.length > 8) warnings.push(`${pointer}: Nx1 matrix will use the diverging-value compatibility view`);
    }
  }

  if (artifact.kind === "curve") {
    if (!Array.isArray(artifact.series) || artifact.series.length === 0) errors.push(`${pointer}/series: expected a non-empty array`);
    else artifact.series.forEach((series, seriesIndex) => {
      const seriesPointer = `${pointer}/series/${seriesIndex}`;
      if (!isObject(series) || !Array.isArray(series.x) || !Array.isArray(series.y)) {
        errors.push(`${seriesPointer}: curve series requires x and y arrays`);
        return;
      }
      if (series.x.length !== series.y.length) errors.push(`${seriesPointer}: x and y must have equal length`);
      series.x.forEach((entry, index) => {
        if (!(typeof entry === "string" || isFiniteNumber(entry))) errors.push(`${seriesPointer}/x/${index}: expected a string or finite number`);
      });
      validateNumericArray(series.y, `${seriesPointer}/y`, errors);
      for (const bandName of ["y_lower", "y_upper"]) {
        if (series[bandName] !== undefined) {
          validateNumericArray(series[bandName], `${seriesPointer}/${bandName}`, errors);
          if (Array.isArray(series[bandName]) && series[bandName].length !== series.y.length) errors.push(`${seriesPointer}/${bandName}: length must match y`);
        }
      }
      if (Array.isArray(series.y_lower) && Array.isArray(series.y_upper) && series.y_lower.length === series.y.length && series.y_upper.length === series.y.length) {
        series.y.forEach((value, index) => {
          if (series.y_lower[index] > value || value > series.y_upper[index]) errors.push(`${seriesPointer}/y/${index}: expected y_lower <= y <= y_upper`);
        });
      }
    });
    if (artifact.id === "rf-reliability") warnings.push(`${pointer} (rf-reliability): compatibility view separates rows-per-bin onto a lower axis; add explicit view/encoding in the next schema version`);
  }

  if (artifact.kind === "predictions") {
    for (const field of ["row_ids", "y_true", "y_pred", "y_score"]) {
      if (!Array.isArray(artifact[field])) errors.push(`${pointer}/${field}: expected an array`);
    }
    if (["row_ids", "y_true", "y_pred", "y_score"].every((field) => Array.isArray(artifact[field]))) {
      const length = artifact.row_ids.length;
      for (const field of ["y_true", "y_pred", "y_score"]) if (artifact[field].length !== length) errors.push(`${pointer}/${field}: length must match row_ids`);
      validateNumericArray(artifact.y_score, `${pointer}/y_score`, errors);
    }
    if (!Array.isArray(artifact.classes) || artifact.classes.length < 2) errors.push(`${pointer}/classes: expected at least two class labels`);
    else warnings.push(`${pointer}: y_score is interpreted as the score for classes[1] (${artifact.classes[1]})`);
  }

  if (artifact.kind === "assignments") {
    if (!Array.isArray(artifact.row_ids) || !Array.isArray(artifact.labels)) errors.push(`${pointer}: assignments requires row_ids and labels arrays`);
    else if (artifact.row_ids.length !== artifact.labels.length) errors.push(`${pointer}: row_ids and labels must have equal length`);
  }

  if (artifact.kind === "tree_structure") {
    if (!Array.isArray(artifact.nodes) || !Array.isArray(artifact.edges) || artifact.nodes.length === 0) {
      errors.push(`${pointer}: tree_structure requires non-empty nodes and an edges array`);
    } else {
      const nodeIds = artifact.nodes.map((node) => node?.id);
      if (nodeIds.some((id) => typeof id !== "string" || !id)) errors.push(`${pointer}/nodes: every node requires a string id`);
      if (!uniqueValues(nodeIds)) errors.push(`${pointer}/nodes: node ids must be unique`);
      const known = new Set(nodeIds);
      const adjacency = new Map(nodeIds.map((id) => [id, []]));
      const targets = new Set();
      artifact.edges.forEach((edge, index) => {
        const edgePointer = `${pointer}/edges/${index}`;
        if (!known.has(edge?.from)) errors.push(`${edgePointer}/from: unknown node ${String(edge?.from)}`);
        if (!known.has(edge?.to)) errors.push(`${edgePointer}/to: unknown node ${String(edge?.to)}`);
        if (known.has(edge?.from) && known.has(edge?.to)) {
          adjacency.get(edge.from).push(edge.to);
          targets.add(edge.to);
        }
      });
      const roots = nodeIds.filter((id) => !targets.has(id));
      if (roots.length !== 1) errors.push(`${pointer}: tree must have exactly one root; found ${roots.length}`);
      if (roots.length === 1) {
        const visiting = new Set();
        const visited = new Set();
        let cycle = false;
        function visit(id) {
          if (visiting.has(id)) { cycle = true; return; }
          if (visited.has(id)) return;
          visiting.add(id);
          for (const child of adjacency.get(id) || []) visit(child);
          visiting.delete(id);
          visited.add(id);
        }
        visit(roots[0]);
        if (cycle) errors.push(`${pointer}: tree contains a cycle`);
        if (visited.size !== nodeIds.length) errors.push(`${pointer}: tree must be connected; reached ${visited.size} of ${nodeIds.length} nodes`);
      }
    }
  }
}

export function validatePayloadV2(payload) {
  const errors = [];
  const warnings = [];
  if (!isObject(payload)) return { errors: ["/: expected a JSON object"], warnings, manifest: null };
  if (typeof payload.schema_version !== "string" || !payload.schema_version) errors.push("/schema_version: expected a non-empty string");
  else if (!/^2\.2\.\d+$/.test(payload.schema_version)) errors.push(`/schema_version: unsupported schema version ${payload.schema_version}; expected 2.2.x`);
  if (!isObject(payload.header)) errors.push("/header: expected an object");
  if (!isObject(payload.dataset)) errors.push("/dataset: expected an object");
  if (!Array.isArray(payload.acts) || payload.acts.length === 0) errors.push("/acts: expected a non-empty array");
  if (!Array.isArray(payload.stages) || payload.stages.length === 0) errors.push("/stages: expected a non-empty array");
  if (errors.length) return { errors, warnings, manifest: null };

  const actIds = payload.acts.map((act) => act?.id);
  if (actIds.some((id) => typeof id !== "string" || !id)) errors.push("/acts: every act requires a string id");
  if (!uniqueValues(actIds)) errors.push("/acts: act ids must be unique");
  const stageIds = payload.stages.map((stage) => stage?.id);
  if (stageIds.some((id) => !(typeof id === "number" || typeof id === "string"))) errors.push("/stages: every stage requires a number or string id");
  if (!uniqueValues(stageIds)) errors.push("/stages: stage ids must be unique");
  const knownStages = new Set(stageIds);
  const knownActs = new Set(actIds);
  const artifactIds = new Set();

  payload.acts.forEach((act, actIndex) => {
    const pointer = `/acts/${actIndex}`;
    if (!Array.isArray(act.stage_ids)) errors.push(`${pointer}/stage_ids: expected an array`);
    else act.stage_ids.forEach((stageId, index) => {
      if (!knownStages.has(stageId)) errors.push(`${pointer}/stage_ids/${index}: unknown stage ${String(stageId)}`);
    });
  });

  payload.stages.forEach((stage, stageIndex) => {
    const pointer = `/stages/${stageIndex}`;
    if (!isObject(stage)) { errors.push(`${pointer}: expected an object`); return; }
    if (typeof stage.title !== "string" || !stage.title) errors.push(`${pointer}/title: expected a non-empty string`);
    if (typeof stage.act !== "string" || !knownActs.has(stage.act)) errors.push(`${pointer}/act: unknown act ${String(stage.act)}`);
    if (!Array.isArray(stage.artifacts)) errors.push(`${pointer}/artifacts: expected an array`);
    else stage.artifacts.forEach((artifact, artifactIndex) => validateArtifact(artifact, `${pointer}/artifacts/${artifactIndex}`, errors, warnings, artifactIds));
  });

  const finalReference = payload.header?.final_verdict?.stage_ref;
  if (finalReference !== undefined && !knownStages.has(finalReference)) errors.push(`/header/final_verdict/stage_ref: unknown stage ${String(finalReference)}`);

  const manifest = {
    schema_version: payload.schema_version,
    act_count: payload.acts.length,
    stage_count: payload.stages.length,
    artifact_count: artifactIds.size,
    artifact_kinds: Object.fromEntries([...SUPPORTED_KINDS].map((kind) => [kind, payload.stages.flatMap((stage) => stage.artifacts || []).filter((artifact) => artifact.kind === kind).length]))
  };
  return { errors, warnings, manifest };
}

export function validatePayload(payload) {
  if (isObject(payload) && typeof payload.schema_version === "string" && /^3\./.test(payload.schema_version)) {
    const validation = validatePayloadV3(payload);
    return {
      errors: validation.errors.map(({ path, code, message }) => `${path} [${code}]: ${message}`),
      warnings: validation.warnings.map(({ path, code, message }) => `${path} [${code}]: ${message}`),
      manifest: validation.manifest
    };
  }
  return validatePayloadV2(payload);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function safeJsonForHtml(value) {
  return stableStringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function verifyStandaloneHtml(html) {
  const errors = [];
  const forbidden = [
    [/<script\b[^>]*\bsrc\s*=/i, "external script source"],
    [/<link\b[^>]*\bhref\s*=/i, "external linked resource"],
    [/<img\b[^>]*\bsrc\s*=\s*["']https?:/i, "external image source"],
    [/url\(\s*["']?https?:/i, "external CSS URL"],
    [/\bfetch\s*\(/, "network fetch"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"]
  ];
  for (const [pattern, label] of forbidden) if (pattern.test(html)) errors.push(`standalone HTML contains ${label}`);
  if (!html.startsWith("<!doctype html>")) errors.push("standalone HTML must start with <!doctype html>");
  if (html.includes("__DASHBOARD_")) errors.push("standalone HTML contains an unreplaced template token");
  if (!html.includes('id="dashboard-payload"')) errors.push("standalone HTML is missing embedded payload JSON");
  return errors;
}

async function prospectiveCanonicalPath(path) {
  const target = resolve(path);
  let ancestor = target;
  let info;
  while (true) {
    try {
      info = await stat(ancestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Unable to resolve output path: ${target}`);
      ancestor = parent;
    }
  }
  const suffix = relative(ancestor, target);
  if (suffix && !info.isDirectory()) throw new Error(`Dashboard output has a non-directory parent: ${ancestor}`);
  if (!suffix && info.isDirectory()) throw new Error(`Dashboard output must be a file: ${target}`);
  return resolve(await realpath(ancestor), suffix);
}

async function assertSafeDashboardOutput(output, input, payload) {
  const canonicalOutput = await prospectiveCanonicalPath(output);
  const canonicalInput = await realpath(input);
  if (canonicalOutput === canonicalInput) throw new Error("Dashboard output cannot overwrite payload.json");
  for (const source of payload?.data || []) {
    if (source?.storage?.kind !== "sidecar" || typeof source.storage.path !== "string") continue;
    const canonicalSidecar = await realpath(resolve(dirname(input), source.storage.path));
    if (canonicalOutput === canonicalSidecar) {
      throw new Error(`Dashboard output cannot overwrite declared sidecar ${JSON.stringify(source.storage.path)}`);
    }
  }
}

async function preparePayloadV3(payload, inputPath) {
  const validation = validatePayloadV3(payload);
  if (!validation.valid) throw new Error(`Payload validation failed:\n${formatV3Diagnostics(validation.errors).split("\n").map((error) => `- ${error}`).join("\n")}`);
  const inputDirectory = dirname(inputPath);
  const sidecars = await verifyPayloadV3Sidecars(payload, { baseDirectory: inputDirectory, validation });
  const ir = normalizePayloadV3(payload, { validation });
  ir.schema_version ||= payload.schema_version;
  const sidecarsById = new Map(sidecars.map((sidecar) => [sidecar.id, sidecar]));
  for (const source of ir.data || []) {
    if (source.storage.kind !== "sidecar") continue;
    const sidecar = sidecarsById.get(source.id);
    if (!sidecar?.inline) throw new Error(`Verified sidecar materialization is missing for ${source.id}`);
    source.storage = sidecar.inline;
  }
  const bundleHash = createHash("sha256").update(stableStringify({
    payload: payload,
    sidecars: sidecars.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }))
  })).digest("hex");
  return { ir, validation, sidecars, bundleHash };
}

export async function buildDashboard({ inputPath, outputPath, validateOnly = false }) {
  const input = resolve(inputPath);
  const raw = await readFile(input, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${input}: ${error.message}`);
  }
  const isV3 = /^3\./.test(payload?.schema_version || "");
  let validation;
  let compiledPayload = payload;
  let bundleHash;
  if (isV3) {
    const prepared = await preparePayloadV3(payload, input);
    validation = {
      errors: [],
      warnings: prepared.validation.warnings.map(({ path, code, message }) => `${path} [${code}]: ${message}`),
      manifest: prepared.validation.manifest
    };
    compiledPayload = prepared.ir;
    bundleHash = prepared.bundleHash;
  } else {
    validation = validatePayloadV2(payload);
    if (validation.errors.length) {
      throw new Error(`Payload validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }
  }
  const canonicalPayload = stableStringify(payload);
  const payloadHash = createHash("sha256").update(canonicalPayload).digest("hex");
  const summary = { input, output: outputPath ? resolve(outputPath) : null, payload_sha256: payloadHash, ...(bundleHash ? { bundle_sha256: bundleHash } : {}), generator_version: GENERATOR_VERSION, ...validation.manifest, warnings: validation.warnings };
  if (validateOnly) return summary;

  const output = resolve(outputPath || join(dirname(input), `${basename(input, extname(input))}.dashboard.html`));
  await assertSafeDashboardOutput(output, input, payload);
  const [template, css, runtime] = await Promise.all([
    readFile(join(assetsDirectory, "standalone-template.html"), "utf8"),
    readFile(join(assetsDirectory, "dashboard.css"), "utf8"),
    readFile(join(assetsDirectory, isV3 ? "dashboard-runtime-v3.js" : "dashboard-runtime.js"), "utf8")
  ]);
  const meta = { generator_version: GENERATOR_VERSION, payload_sha256: payloadHash, ...(bundleHash ? { bundle_sha256: bundleHash } : {}), ...validation.manifest };
  const title = payload.report?.title || payload.header?.title || payload.dataset?.title || payload.dataset?.name || "Payload dashboard";
  const presentation = compiledPayload.presentation || payload.presentation || {};
  const locale = presentation.locale || "en";
  const noScript = presentation.labels?.javascript_required
    || "This dashboard requires JavaScript for its accordion and inline SVG charts.";
  const html = template
    .replace("__DASHBOARD_TITLE__", escapeHtml(title))
    .replace("__DASHBOARD_LANG__", escapeHtml(locale))
    .replace("__DASHBOARD_NOSCRIPT__", escapeHtml(noScript))
    .replace("__DASHBOARD_GENERATOR_VERSION__", GENERATOR_VERSION)
    .replace("/*__DASHBOARD_CSS__*/", css)
    .replace("__DASHBOARD_PAYLOAD__", safeJsonForHtml(compiledPayload))
    .replace("__DASHBOARD_META__", safeJsonForHtml(meta))
    .replace("/*__DASHBOARD_RUNTIME__*/", runtime);
  const verificationErrors = verifyStandaloneHtml(html);
  if (verificationErrors.length) throw new Error(`Standalone verification failed:\n${verificationErrors.map((error) => `- ${error}`).join("\n")}`);
  const temporary = join(dirname(output), `.${basename(output)}.tmp-${process.pid}`);
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, html, "utf8");
    await rename(temporary, output);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  summary.output = output;
  summary.output_bytes = Buffer.byteLength(html);
  summary.output_sha256 = createHash("sha256").update(html).digest("hex");
  return summary;
}

function usage() {
  return `Usage:\n  render-dashboard.mjs --input payload.json [--output dashboard.html] [--validate-only] [--strict]\n\nOptions:\n  --input PATH       Payload JSON to validate and render.\n  --output PATH      Destination HTML; defaults beside the payload.\n  --validate-only    Validate and inspect without writing HTML.\n  --strict           Accepted for forward compatibility; validation is strict by default.\n  --help             Show this help.`;
}

function parseArguments(argumentsList) {
  const options = { validateOnly: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--input" || argument === "-i") options.inputPath = argumentsList[++index];
    else if (argument === "--output" || argument === "-o") options.outputPath = argumentsList[++index];
    else if (!argument.startsWith("-") && !options.inputPath) options.inputPath = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!options.inputPath) throw new Error("--input is required");
    const summary = await buildDashboard(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
