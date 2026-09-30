import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32, posix } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

import {
  DiagnosticCollector,
  PayloadV3Error,
  assertNonEmptyString,
  assertUniqueIds,
  findUnknownKeys,
  formatDiagnostics,
  isFiniteNumber,
  isPlainObject,
  joinPointer,
  stableClone,
  stableStringify
} from "./v3-common.mjs";
import {
  RecipeExpansionError,
  SUPPORTED_PANEL_TYPES,
  SUPPORTED_PRIMITIVE_MARKS,
  defaultRecipeRegistry
} from "./v3-recipes.mjs";
import {
  PAYLOAD_V3_CANVAS_INTERACTION_TYPES,
  PAYLOAD_V3_CAPABILITIES,
  PAYLOAD_V3_CHANNEL_FORMATS,
  PAYLOAD_V3_CHANNEL_TYPES,
  PAYLOAD_V3_COORDINATE_MARKS,
  PAYLOAD_V3_COORDINATE_TYPES,
  PAYLOAD_V3_INTERACTION_TYPES,
  PAYLOAD_V3_MARK_CHANNEL_REQUIREMENTS,
  PAYLOAD_V3_MARK_CHANNELS,
  PAYLOAD_V3_MARK_PROPERTIES,
  PAYLOAD_V3_SIDECAR_COMPRESSIONS,
  PAYLOAD_V3_SIDECAR_FORMATS,
  PAYLOAD_V3_TRANSFORM_OPS,
  getPayloadV3Capabilities
} from "./v3-capabilities.mjs";
import { validatePayloadV3Schema } from "./v3-json-schema.mjs";

export const PAYLOAD_V3_SCHEMA_VERSION = "3.0.0";
export const PAYLOAD_V3_IR_VERSION = "3.0.0";
export const RENDERER_CONTRACT_NAME = "render-payload-dashboard";

const gunzip = promisify(gunzipCallback);

const PHYSICAL_FIELD_TYPES = new Set(["number", "integer", "string", "boolean", "date", "datetime"]);
const CHANNEL_TYPES = new Set(PAYLOAD_V3_CHANNEL_TYPES);
const CHANNEL_FORMATS = new Set(PAYLOAD_V3_CHANNEL_FORMATS);
const COORDINATE_TYPES = new Set(PAYLOAD_V3_COORDINATE_TYPES);
const LAYOUT_TYPES = new Set(["grid", "flow", "single"]);
const SCALE_TYPES = new Set(["linear", "log", "sqrt", "symlog", "band", "point", "ordinal", "time", "utc"]);
const SCALE_ROLES = new Set(["semantic", "diverging", "sequential", "continuous", "categorical"]);
const SIDECAR_FORMATS = new Set(PAYLOAD_V3_SIDECAR_FORMATS);
const SIDECAR_COMPRESSIONS = new Set(PAYLOAD_V3_SIDECAR_COMPRESSIONS);
const TRANSFORM_OPS = new Set(PAYLOAD_V3_TRANSFORM_OPS);
const INTERACTION_TYPES = new Set(PAYLOAD_V3_INTERACTION_TYPES);
const CANVAS_INTERACTION_TYPES = new Set(PAYLOAD_V3_CANVAS_INTERACTION_TYPES);
const MARKS = new Set(SUPPORTED_PRIMITIVE_MARKS);
const PANELS = new Set(SUPPORTED_PANEL_TYPES);

const DATA_KEYS = new Set(["id", "semantic_type", "title", "description", "fields", "storage"]);
const FIELD_KEYS = new Set(["name", "type", "role", "label", "unit", "nullable", "description"]);
const STORAGE_KEYS = new Set(["kind", "values", "rows", "path", "format", "compression", "sha256", "bytes"]);
const FIGURE_KEYS = new Set(["id", "title", "caption", "description", "recipe", "recipe_config", "layout", "panels", "scales", "interactions"]);
const RECIPE_CONFIG_KEYS = new Set(["bindings", "params"]);
const PANEL_KEYS = new Set(["id", "title", "subtitle", "description", "type", "position", "display", "data_ref", "coordinate", "transform", "layers", "annotations"]);
const PANEL_DISPLAY_KEYS = new Set(["aspect_ratio", "column_span", "row_span"]);
const LAYER_KEYS = new Set(["id", "description", "data_ref", "transform", "mark", "encoding"]);
const CHANNEL_KEYS = new Set(["field", "value", "type", "scale_id", "scale_role", "axis", "legend", "format", "title"]);
const SCALE_KEYS = new Set(["id", "type", "domain", "range", "scheme", "zero", "reverse", "title"]);
const LAYOUT_KEYS = new Set(["type", "columns", "rows", "column_weights", "gap", "row_gap", "column_gap"]);
const ACT_KEYS = new Set(["id", "numeral", "title", "short_label", "section_ids"]);
const METHOD_NOTE_KEYS = new Set(["kind", "label", "text"]);
const METHOD_NOTE_KINDS = new Set(["reports", "minimises", "uses", "produces", "note"]);
const SINGLETON_METHOD_NOTE_KINDS = new Set(["reports", "minimises"]);
const CAVEAT_KINDS = new Set(["limitation", "scope", "provenance", "warning", "note"]);
const THEME_KEYS = new Set(["name", "mode", "palette", "density", "semantic_colors", "tokens"]);
const THEME_TOKEN_KEYS = new Set(["accent", "accent_contrast", "background", "surface", "surface_muted", "text", "muted_text", "border", "radius", "max_width"]);
const PRESENTATION_KEYS = new Set(["locale", "section_prefix", "show_section_numbers", "show_figure_titles", "show_figure_descriptions", "show_coverage", "show_build_footer", "labels"]);
const PRESENTATION_LABEL_KEYS = new Set(["fold_all", "unfold_all", "report_claim", "coverage", "concepts_used", "reports", "minimises", "uses", "produces", "note", "top", "javascript_required", "standalone_package", "schema", "figures", "seed", "payload_sha256", "renderer", "reset", "status_pass", "status_warn", "status_fail", "status_not_applicable"]);
const COORDINATE_KEYS = new Set(["type", "equal_aspect"]);
const ANNOTATION_KEYS = new Set(["id", "type", "description", "encoding", "axis", "value", "from", "to", "text", "position", "space", "anchor", "label", "style"]);
const ANNOTATION_TYPES = new Set(["rule", "reference-line", "text", "label", "band"]);
const POSITIONAL_CHANNELS = new Set(["x", "x2", "x_lower", "x_upper", "y", "y2", "y_lower", "y_upper", "q1", "q3", "median", "whisker_low", "whisker_high", "x_radius", "y_radius"]);
const X_POSITIONAL_CHANNELS = new Set(["x", "x2", "x_lower", "x_upper", "x_radius"]);
const Y_POSITIONAL_CHANNELS = new Set(["y", "y2", "y_lower", "y_upper", "q1", "q3", "median", "whisker_low", "whisker_high", "y_radius"]);

const CHANNEL_REQUIREMENTS = PAYLOAD_V3_MARK_CHANNEL_REQUIREMENTS;
const ALLOWED_CHANNELS = Object.freeze(Object.fromEntries(
  Object.entries(PAYLOAD_V3_MARK_CHANNELS).map(([mark, channels]) => [mark, new Set(channels)])
));
const COORDINATE_MARK_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(PAYLOAD_V3_COORDINATE_MARKS).map(([coordinate, marks]) => [coordinate, new Set(marks)])
));

const RECIPE_CONFIG_SPECS = Object.freeze({
  "pca.diagnostics@1": {
    bindings: {
      scree: { required: ["data", "component", "variance", "cumulative"], optional: [] },
      loadings: { required: ["data", "component", "feature", "value"], optional: [] },
      circle: { required: ["data", "x", "y", "label"], optional: [] },
      residuals: { required: ["data", "component", "row", "column", "value"], optional: [] }
    },
    params: new Set(["selected_components", "variance_threshold", "residual_components"])
  },
  "embedding.small-multiples@1": {
    bindings: {
      points: { required: ["data", "facet", "x", "y"], optional: ["color", "tooltip"] }
    },
    params: new Set(["columns", "variants"])
  },
  "model.validation@1": {
    bindings: {
      roc: { required: ["data", "fpr", "tpr"], optional: ["series"] },
      confusion: { required: ["data", "actual", "predicted", "value"], optional: [] },
      calibration: { required: ["data", "predicted", "observed"], optional: ["series"] },
      learning_curve: { required: ["data", "size", "score"], optional: ["lower", "upper", "series"] }
    },
    params: new Set()
  }
});

/** Parse Payload v3 JSON without touching the filesystem. */
export function parsePayloadV3(raw, { sourceName = "<payload>" } = {}) {
  if (typeof raw !== "string") throw new TypeError("parsePayloadV3 expects a JSON string");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PayloadV3Error(`Invalid JSON in ${sourceName}: ${error.message}`, [
      { path: "/", code: "invalid_json", message: error.message }
    ], { cause: error });
  }
}

/**
 * Run structural and semantic validation beyond JSON Schema. This check is
 * synchronous: it validates sidecar paths/hash declarations but does not open
 * sidecar files. Use loadPayloadV3 or verifyPayloadV3Sidecars for integrity IO.
 */
export function validatePayloadV3(payload, { registry = defaultRecipeRegistry } = {}) {
  const collector = new DiagnosticCollector();
  collector.errors.push(...validatePayloadV3Schema(payload));
  if (!isPlainObject(payload)) return collectorError(collector, "/", "expected_object", "expected a JSON object");

  validateEnvelope(payload, collector);
  if (!Array.isArray(payload.data)) collector.error("/data", "expected_array", "expected an array");
  if (!Array.isArray(payload.sections) || payload.sections.length === 0) collector.error("/sections", "expected_nonempty_array", "expected a non-empty array");
  if (!Array.isArray(payload.figures)) collector.error("/figures", "expected_array", "expected an array");

  const dataIds = Array.isArray(payload.data) ? assertUniqueIds(payload.data, "/data", collector) : new Set();
  const sectionIds = Array.isArray(payload.sections) ? assertUniqueIds(payload.sections, "/sections", collector) : new Set();
  const figureIds = Array.isArray(payload.figures) ? assertUniqueIds(payload.figures, "/figures", collector) : new Set();

  const dataIndex = new Map();
  const dataSources = new Map();
  if (Array.isArray(payload.data)) payload.data.forEach((source, index) => {
    validateDataSource(source, `/data/${index}`, collector);
    if (typeof source?.id === "string") {
      dataIndex.set(source.id, buildFieldIndex(source));
      dataSources.set(source.id, { source, path: `/data/${index}` });
    }
  });

  const figureRefCounts = new Map([...figureIds].map((id) => [id, 0]));
  if (Array.isArray(payload.sections)) payload.sections.forEach((section, index) => {
    validateSection(section, `/sections/${index}`, collector, figureIds, figureRefCounts);
  });
  validateActs(payload.acts, "/acts", collector, payload.sections, sectionIds);
  for (const [figureId, count] of figureRefCounts) {
    if (count === 0) collector.error("/sections", "unreferenced_figure", `figure ${JSON.stringify(figureId)} is not referenced by any section`);
    else if (count > 1) collector.error("/sections", "duplicate_figure_reference", `figure ${JSON.stringify(figureId)} is referenced ${count} times; expected exactly once`);
  }

  const expandedFigures = new Map();
  if (Array.isArray(payload.figures)) payload.figures.forEach((figure, index) => {
    const path = `/figures/${index}`;
    validateFigureEnvelope(figure, path, collector, registry);
    if (!isPlainObject(figure) || !registry.has(figure.recipe)) return;
    validateRecipeConfigContract(figure, `${path}/recipe_config`, collector);
    validateRecipeConfigReferences(figure.recipe_config, `${path}/recipe_config`, collector, dataIndex);
    try {
      const panels = registry.expand(figure, { path });
      expandedFigures.set(figure.id, panels);
      validateExpandedFigure(figure, panels, path, collector, dataIndex, dataSources);
    } catch (error) {
      if (error instanceof RecipeExpansionError) collector.error(error.path, "recipe_expansion", error.message);
      else throw error;
    }
  });

  if (collector.errors.length === 0) {
    const rendererModel = {
      data: payload.data,
      figures: payload.figures.map((figure) => ({ ...figure, panels: expandedFigures.get(figure.id) || [] }))
    };
    collector.errors.push(...validateRendererDataDomainsV3(rendererModel));
  }

  const manifest = buildManifest(payload, expandedFigures);
  return collector.result({ manifest });
}

function validateRecipeConfigContract(figure, path, collector) {
  const config = figure.recipe_config;
  if (figure.recipe === "generic.figure@1") {
    if (isPlainObject(config) && Object.keys(config).length > 0) {
      collector.error(path, "generic_recipe_config", "generic.figure@1 uses explicit panels and does not accept a non-empty recipe_config");
    }
    return;
  }
  const spec = RECIPE_CONFIG_SPECS[figure.recipe];
  if (!spec || config === undefined || !isPlainObject(config)) return;
  if (!isPlainObject(config.bindings)) {
    collector.error(`${path}/bindings`, "recipe_bindings_required", `${figure.recipe} recipe_config requires a bindings object`);
  } else {
    findUnknownKeys(config.bindings, new Set(Object.keys(spec.bindings)), `${path}/bindings`, collector);
    for (const [groupName, groupSpec] of Object.entries(spec.bindings)) {
      const groupPath = `${path}/bindings/${groupName}`;
      const group = config.bindings[groupName];
      if (!isPlainObject(group)) {
        collector.error(groupPath, "recipe_binding_group_required", `${figure.recipe} requires binding group ${JSON.stringify(groupName)}`);
        continue;
      }
      const allowedRoles = new Set([...groupSpec.required, ...groupSpec.optional]);
      findUnknownKeys(group, allowedRoles, groupPath, collector);
      for (const role of groupSpec.required) {
        if (!Object.hasOwn(group, role)) collector.error(`${groupPath}/${role}`, "recipe_binding_required", `binding group ${JSON.stringify(groupName)} requires role ${JSON.stringify(role)}`);
      }
    }
    const learning = config.bindings.learning_curve;
    if (figure.recipe === "model.validation@1" && isPlainObject(learning)
      && Object.hasOwn(learning, "lower") !== Object.hasOwn(learning, "upper")) {
      collector.error(`${path}/bindings/learning_curve`, "recipe_binding_pair", "learning_curve lower and upper bindings must be provided together");
    }
  }
  const params = config.params ?? {};
  if (!isPlainObject(params)) return;
  findUnknownKeys(params, spec.params, `${path}/params`, collector);
  validateRecipeParams(figure.recipe, params, `${path}/params`, collector);
}

function validateRecipeParams(recipe, params, path, collector) {
  if (recipe === "pca.diagnostics@1") {
    if (params.selected_components !== undefined && (!Number.isInteger(params.selected_components) || params.selected_components < 1)) {
      collector.error(`${path}/selected_components`, "recipe_param_range", "selected_components must be a positive integer");
    }
    if (params.variance_threshold !== undefined && (!isFiniteNumber(params.variance_threshold) || params.variance_threshold <= 0 || params.variance_threshold > 1)) {
      collector.error(`${path}/variance_threshold`, "recipe_param_range", "variance_threshold must be a finite number in (0, 1]");
    }
    if (params.residual_components !== undefined) {
      if (!Array.isArray(params.residual_components) || params.residual_components.length === 0) {
        collector.error(`${path}/residual_components`, "recipe_param_type", "residual_components must be a non-empty array of positive integers");
      } else {
        const seen = new Set();
        params.residual_components.forEach((value, index) => {
          if (!Number.isInteger(value) || value < 1) collector.error(`${path}/residual_components/${index}`, "recipe_param_range", "residual component must be a positive integer");
          else if (seen.has(value)) collector.error(`${path}/residual_components/${index}`, "recipe_param_duplicate", `duplicate residual component ${value}`);
          seen.add(value);
        });
      }
    }
    return;
  }
  if (recipe === "embedding.small-multiples@1") {
    if (params.columns !== undefined && (!Number.isInteger(params.columns) || params.columns < 1 || params.columns > 12)) {
      collector.error(`${path}/columns`, "recipe_param_range", "columns must be an integer from 1 through 12");
    }
    if (params.variants !== undefined) validateEmbeddingVariants(params.variants, `${path}/variants`, collector);
  }
}

function validateEmbeddingVariants(variants, path, collector) {
  if (!Array.isArray(variants) || variants.length === 0) {
    collector.error(path, "recipe_param_type", "variants must be a non-empty array");
    return;
  }
  const ids = new Set();
  variants.forEach((variant, index) => {
    const itemPath = `${path}/${index}`;
    if (!isPlainObject(variant)) {
      collector.error(itemPath, "recipe_param_type", "variant must be an object");
      return;
    }
    findUnknownKeys(variant, new Set(["id", "label", "value"]), itemPath, collector);
    if (typeof variant.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(variant.id)) collector.error(`${itemPath}/id`, "recipe_param_type", "variant id must be a valid identifier");
    else if (ids.has(variant.id)) collector.error(`${itemPath}/id`, "recipe_param_duplicate", `duplicate variant id ${JSON.stringify(variant.id)}`);
    ids.add(variant.id);
    if (typeof variant.label !== "string" || variant.label.length === 0 || variant.label.length > 512) collector.error(`${itemPath}/label`, "recipe_param_type", "variant label must be a non-empty string of at most 512 characters");
    if (!(typeof variant.value === "string" || typeof variant.value === "boolean" || isFiniteNumber(variant.value))) collector.error(`${itemPath}/value`, "recipe_param_type", "variant value must be a finite number, string, or boolean");
  });
}

function validateRecipeConfigReferences(config, path, collector, dataIndex) {
  if (config === undefined || !isPlainObject(config) || config.bindings === undefined) return;
  if (!isPlainObject(config.bindings)) {
    collector.error(`${path}/bindings`, "expected_object", "recipe bindings must be an object");
    return;
  }
  for (const [groupName, group] of Object.entries(config.bindings)) {
    const groupPath = `${path}/bindings/${groupName}`;
    if (!isPlainObject(group)) {
      collector.error(groupPath, "expected_object", "recipe binding group must be an object");
      continue;
    }
    if (typeof group.data !== "string" || !dataIndex.has(group.data)) {
      collector.error(`${groupPath}/data`, "unknown_data_reference", `recipe binding requires a known data source; received ${JSON.stringify(group.data)}`);
      continue;
    }
    for (const [role, field] of Object.entries(group)) {
      if (role === "data") continue;
      if (typeof field !== "string" || field === "") collector.error(`${groupPath}/${role}`, "expected_field", "recipe field binding must be a non-empty field name");
      else if (!dataIndex.get(group.data).has(field)) collector.error(`${groupPath}/${role}`, "unknown_field", `field ${JSON.stringify(field)} is not declared by ${JSON.stringify(group.data)}`);
    }
  }
}

function collectorError(collector, path, code, message) {
  collector.error(path, code, message);
  return collector.result({ manifest: null });
}

function validateEnvelope(payload, collector) {
  if (payload.schema_version !== PAYLOAD_V3_SCHEMA_VERSION) {
    collector.error("/schema_version", "unsupported_schema_version", `expected ${PAYLOAD_V3_SCHEMA_VERSION}; received ${JSON.stringify(payload.schema_version)}`);
  }
  const contract = payload.renderer_contract;
  if (!isPlainObject(contract)) collector.error("/renderer_contract", "expected_object", "expected renderer_contract object");
  else {
    findUnknownKeys(contract, new Set(["name", "version", "strict"]), "/renderer_contract", collector);
    if (contract.name !== RENDERER_CONTRACT_NAME) collector.error("/renderer_contract/name", "unsupported_renderer", `expected ${JSON.stringify(RENDERER_CONTRACT_NAME)}`);
    if (contract.version !== PAYLOAD_V3_IR_VERSION) collector.error("/renderer_contract/version", "unsupported_renderer_version", `expected ${PAYLOAD_V3_IR_VERSION}`);
    if (contract.strict !== true) collector.error("/renderer_contract/strict", "strict_required", "strict must be true");
  }
  for (const key of ["report", "run", "dataset", "provenance", "theme"]) {
    if (!isPlainObject(payload[key])) collector.error(`/${key}`, "expected_object", "expected an object");
  }
  if (isPlainObject(payload.report)) assertNonEmptyString(payload.report.title, "/report/title", collector);
  validateTheme(payload.theme, "/theme", collector);
  validatePresentation(payload.presentation, "/presentation", collector);
}

function validateTheme(theme, path, collector) {
  if (!isPlainObject(theme)) return;
  findUnknownKeys(theme, THEME_KEYS, path, collector);
  if (theme.tokens !== undefined) {
    if (!isPlainObject(theme.tokens)) collector.error(`${path}/tokens`, "expected_object", "expected a theme tokens object");
    else findUnknownKeys(theme.tokens, THEME_TOKEN_KEYS, `${path}/tokens`, collector);
  }
}

function validatePresentation(presentation, path, collector) {
  if (presentation === undefined) return;
  if (!isPlainObject(presentation)) {
    collector.error(path, "expected_object", "expected a presentation object");
    return;
  }
  findUnknownKeys(presentation, PRESENTATION_KEYS, path, collector);
  if (presentation.labels !== undefined) {
    if (!isPlainObject(presentation.labels)) collector.error(`${path}/labels`, "expected_object", "expected a presentation labels object");
    else findUnknownKeys(presentation.labels, PRESENTATION_LABEL_KEYS, `${path}/labels`, collector);
  }
}

function validateDataSource(source, path, collector) {
  if (!isPlainObject(source)) {
    collector.error(path, "expected_object", "expected a data source object");
    return;
  }
  findUnknownKeys(source, DATA_KEYS, path, collector);
  assertNonEmptyString(source.semantic_type, `${path}/semantic_type`, collector);
  if (!Array.isArray(source.fields) || source.fields.length === 0) {
    collector.error(`${path}/fields`, "expected_nonempty_array", "expected at least one declared field");
    return;
  }
  const fieldNames = new Set();
  source.fields.forEach((field, index) => {
    const fieldPath = `${path}/fields/${index}`;
    if (!isPlainObject(field)) {
      collector.error(fieldPath, "expected_object", "expected a field object");
      return;
    }
    findUnknownKeys(field, FIELD_KEYS, fieldPath, collector);
    if (assertNonEmptyString(field.name, `${fieldPath}/name`, collector)) {
      if (fieldNames.has(field.name)) collector.error(`${fieldPath}/name`, "duplicate_field", `duplicate field ${JSON.stringify(field.name)}`);
      fieldNames.add(field.name);
    }
    if (!PHYSICAL_FIELD_TYPES.has(field.type)) collector.error(`${fieldPath}/type`, "unsupported_field_type", `unsupported physical field type ${JSON.stringify(field.type)}`);
    if (field.nullable !== undefined && typeof field.nullable !== "boolean") collector.error(`${fieldPath}/nullable`, "expected_boolean", "expected a boolean");
  });
  validateStorage(source.storage, `${path}/storage`, collector, source.fields, fieldNames);
}

function buildFieldIndex(source) {
  return new Map((source?.fields || []).filter((field) => typeof field?.name === "string").map((field) => [field.name, field]));
}

function validateStorage(storage, path, collector, fields, fieldNames) {
  if (!isPlainObject(storage)) {
    collector.error(path, "expected_object", "expected a storage object");
    return;
  }
  findUnknownKeys(storage, STORAGE_KEYS, path, collector);
  if (storage.kind === "inline") validateInlineStorage(storage, path, collector, fields, fieldNames);
  else if (storage.kind === "sidecar") validateSidecarStorage(storage, path, collector);
  else collector.error(`${path}/kind`, "unsupported_storage_kind", `unsupported storage kind ${JSON.stringify(storage.kind)}`);
}

function validateInlineStorage(storage, path, collector, fields, fieldNames) {
  if (storage.path !== undefined || storage.sha256 !== undefined || storage.bytes !== undefined || storage.compression !== undefined) {
    collector.error(path, "mixed_storage", "inline storage cannot declare sidecar path, hash, bytes, or compression");
  }
  const hasRows = storage.rows !== undefined;
  const hasValues = storage.values !== undefined;
  if (hasRows === hasValues) {
    collector.error(path, "inline_shape", "inline storage requires exactly one of rows or values");
    return;
  }
  if (hasRows) validateInlineRows(storage.rows, `${path}/rows`, collector, fields, fieldNames);
  else validateInlineValues(storage.values, `${path}/values`, collector, fields, fieldNames);
}

function validateInlineRows(rows, path, collector, fields, fieldNames) {
  if (!Array.isArray(rows)) {
    collector.error(path, "expected_array", "inline rows must be an array");
    return;
  }
  rows.forEach((row, rowIndex) => {
    const rowPath = `${path}/${rowIndex}`;
    if (Array.isArray(row)) {
      if (row.length !== fields.length) collector.error(rowPath, "row_width", `row has ${row.length} values; expected ${fields.length}`);
      fields.forEach((field, fieldIndex) => validatePhysicalValue(row[fieldIndex], field, `${rowPath}/${fieldIndex}`, collector));
      return;
    }
    if (!isPlainObject(row)) {
      collector.error(rowPath, "expected_record", "row must be an object or positional array");
      return;
    }
    for (const key of Object.keys(row)) if (!fieldNames.has(key)) collector.error(joinPointer(rowPath, key), "undeclared_field", `field ${JSON.stringify(key)} is not declared`);
    fields.forEach((field) => {
      const valuePath = joinPointer(rowPath, field.name);
      if (!Object.hasOwn(row, field.name)) {
        collector.error(valuePath, "missing_field", `missing required field ${JSON.stringify(field.name)}`);
      } else validatePhysicalValue(row[field.name], field, valuePath, collector);
    });
  });
}

function validateInlineValues(values, path, collector, fields, fieldNames) {
  if (Array.isArray(values)) {
    if (fields.length !== 1) collector.error(path, "ambiguous_values", "a primitive values array is allowed only for a single-field source");
    else values.forEach((value, index) => validatePhysicalValue(value, fields[0], `${path}/${index}`, collector));
    return;
  }
  if (!isPlainObject(values)) {
    collector.error(path, "expected_columns", "inline values must be an object of parallel field arrays");
    return;
  }
  for (const key of Object.keys(values)) if (!fieldNames.has(key)) collector.error(joinPointer(path, key), "undeclared_field", `field ${JSON.stringify(key)} is not declared`);
  let length = null;
  fields.forEach((field) => {
    const columnPath = joinPointer(path, field.name);
    const column = values[field.name];
    if (!Array.isArray(column)) {
      collector.error(columnPath, "expected_array", `missing or invalid column ${JSON.stringify(field.name)}`);
      return;
    }
    if (length === null) length = column.length;
    else if (column.length !== length) collector.error(columnPath, "column_length", `column length ${column.length} does not match ${length}`);
    column.forEach((value, index) => validatePhysicalValue(value, field, `${columnPath}/${index}`, collector));
  });
}

function validatePhysicalValue(value, field, path, collector) {
  if (value === null) {
    if (field.nullable !== true) collector.error(path, "null_not_allowed", `field ${JSON.stringify(field.name)} is not nullable`);
    return;
  }
  if (!matchesPhysicalValue(value, field.type)) collector.error(path, "field_type", `expected ${field.type} value for field ${JSON.stringify(field.name)}`);
}

function matchesPhysicalValue(value, type) {
  if (type === "number") return isFiniteNumber(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "date") return isExactCalendarDate(value);
  if (type === "datetime") {
    if (typeof value !== "string") return false;
    const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    return Boolean(match && isExactCalendarDate(match[1]) && !Number.isNaN(Date.parse(value)));
  }
  return false;
}

function isExactCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function stableValueCompare(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftKey = `${typeof left}:${String(left)}`;
  const rightKey = `${typeof right}:${String(right)}`;
  return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
}

/**
 * Validate parsed sidecar content against its declared fields and return the
 * canonical inline storage shape used by normalized IR.
 */
export function validateMaterializedDataV3(source, value, { path = "/data/sidecar" } = {}) {
  const collector = new DiagnosticCollector();
  if (!isPlainObject(source) || !Array.isArray(source.fields) || source.fields.length === 0) {
    collector.error(path, "sidecar_source_schema", "sidecar source requires declared fields before materialization");
  } else {
    const fieldNames = new Set(source.fields.map((field) => field?.name).filter((name) => typeof name === "string"));
    if (Array.isArray(value)) {
      value.forEach((row, index) => {
        if (!isPlainObject(row)) collector.error(`${path}/rows/${index}`, "sidecar_row_shape", "sidecar rows must be objects");
      });
      if (collector.errors.length === 0) validateInlineRows(value, `${path}/rows`, collector, source.fields, fieldNames);
    } else if (isPlainObject(value)) {
      validateInlineValues(value, `${path}/values`, collector, source.fields, fieldNames);
    } else collector.error(path, "sidecar_shape", "sidecar must contain row objects or parallel column arrays");
  }
  const result = collector.result();
  if (!result.valid) throw new PayloadV3Error(`Sidecar data validation failed:\n${formatDiagnostics(result.errors)}`, result.errors);
  return Array.isArray(value)
    ? stableClone({ kind: "inline", format: "rows", rows: value })
    : stableClone({ kind: "inline", format: "columns", values: value });
}

async function parseSidecarBytes(source, raw, path) {
  let decoded;
  try {
    decoded = source.storage.compression === "gzip" ? await gunzip(raw) : raw;
  } catch (error) {
    throw new PayloadV3Error(`Unable to decompress sidecar ${source.id}`, [
      { path: `${path}/compression`, code: "sidecar_decompression", message: error.message }
    ], { cause: error });
  }
  const text = decoded.toString("utf8");
  let parsed;
  if (source.storage.format === "jsonl") {
    parsed = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() === "") continue;
      try {
        parsed.push(JSON.parse(lines[index]));
      } catch (error) {
        throw new PayloadV3Error(`Invalid JSONL in sidecar ${source.id}`, [
          { path: `${path}/path`, code: "sidecar_invalid_jsonl", message: `line ${index + 1}: ${error.message}` }
        ], { cause: error });
      }
    }
  } else {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PayloadV3Error(`Invalid JSON in sidecar ${source.id}`, [
        { path: `${path}/path`, code: "sidecar_invalid_json", message: error.message }
      ], { cause: error });
    }
  }
  if (isPlainObject(parsed) && Array.isArray(parsed.rows) && Object.keys(parsed).length === 1) parsed = parsed.rows;
  if (isPlainObject(parsed) && isPlainObject(parsed.values) && Object.keys(parsed).length === 1) parsed = parsed.values;
  const inline = validateMaterializedDataV3(source, parsed, { path });
  const rowCount = inline.format === "rows"
    ? inline.rows.length
    : (Object.values(inline.values)[0]?.length || 0);
  if (Number.isInteger(source.storage.rows) && rowCount !== source.storage.rows) {
    throw new PayloadV3Error(`Row count mismatch for sidecar ${source.id}`, [
      { path: `${path}/rows`, code: "sidecar_row_count_mismatch", message: `expected ${source.storage.rows}; received ${rowCount}` }
    ]);
  }
  return { inline, row_count: rowCount };
}

function validateSidecarStorage(storage, path, collector) {
  if (storage.values !== undefined || Array.isArray(storage.rows) || isPlainObject(storage.rows)) {
    collector.error(path, "mixed_storage", "sidecar storage cannot contain inline values or row records");
  }
  const safety = inspectSafeRelativeSidecarPath(storage.path);
  if (!safety.safe) collector.error(`${path}/path`, "unsafe_sidecar_path", safety.message);
  if (!SIDECAR_FORMATS.has(storage.format)) collector.error(`${path}/format`, "unsupported_sidecar_format", `unsupported format ${JSON.stringify(storage.format)}`);
  if (storage.compression !== undefined && !SIDECAR_COMPRESSIONS.has(storage.compression)) collector.error(`${path}/compression`, "unsupported_compression", `unsupported compression ${JSON.stringify(storage.compression)}`);
  if (typeof storage.sha256 !== "string" || !/^(?:sha256:)?[0-9a-fA-F]{64}$/.test(storage.sha256)) {
    collector.error(`${path}/sha256`, "invalid_sha256", "sidecar storage requires a 64-character SHA-256 hash (optional sha256: prefix accepted)");
  }
  if (storage.rows !== undefined && (!Number.isInteger(storage.rows) || storage.rows < 0)) collector.error(`${path}/rows`, "invalid_row_count", "rows must be a non-negative integer");
  if (storage.bytes !== undefined && (!Number.isInteger(storage.bytes) || storage.bytes < 0)) collector.error(`${path}/bytes`, "invalid_byte_count", "bytes must be a non-negative integer");
}

export function inspectSafeRelativeSidecarPath(value) {
  if (typeof value !== "string" || value === "") return { safe: false, message: "expected a non-empty relative path" };
  if (value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) return { safe: false, message: "control characters are not allowed" };
  if (value.includes("\\")) return { safe: false, message: "use portable forward slashes; backslashes are not allowed" };
  if (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)) return { safe: false, message: "absolute paths are not allowed" };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return { safe: false, message: "URLs and URI schemes are not allowed" };
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return { safe: false, message: "empty, . and .. path segments are not allowed" };
  if (posix.normalize(value) !== value) return { safe: false, message: "path must already be normalized" };
  return { safe: true, normalized: value };
}

function validateSection(section, path, collector, figureIds, figureRefCounts) {
  if (!isPlainObject(section)) {
    collector.error(path, "expected_object", "expected a section object");
    return;
  }
  assertNonEmptyString(section.title, `${path}/title`, collector);
  if (section.badge !== undefined) assertNonEmptyString(section.badge, `${path}/badge`, collector);
  validateTextArray(section.concepts, `${path}/concepts`, collector);
  validateTextArray(section.findings, `${path}/findings`, collector);
  validateTextArray(section.narrative, `${path}/narrative`, collector);
  validateMethodNotes(section.method_notes, `${path}/method_notes`, collector);
  validateCaveats(section.caveats, `${path}/caveats`, collector);
  if (!Array.isArray(section.figure_ids)) {
    collector.error(`${path}/figure_ids`, "expected_array", "expected an array of figure ids");
    return;
  }
  const local = new Set();
  section.figure_ids.forEach((id, index) => {
    const refPath = `${path}/figure_ids/${index}`;
    if (typeof id !== "string" || id === "") collector.error(refPath, "expected_id_reference", "expected a non-empty figure id");
    else if (!figureIds.has(id)) collector.error(refPath, "unknown_figure_reference", `unknown figure ${JSON.stringify(id)}`);
    else {
      if (local.has(id)) collector.error(refPath, "duplicate_reference", `figure ${JSON.stringify(id)} is repeated in this section`);
      local.add(id);
      figureRefCounts.set(id, (figureRefCounts.get(id) || 0) + 1);
    }
  });
}

function validateTextArray(value, path, collector) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    collector.error(path, "expected_array", "expected an array of text values");
    return;
  }
  value.forEach((item, index) => assertNonEmptyString(item, `${path}/${index}`, collector));
}

function validateMethodNotes(notes, path, collector) {
  if (notes === undefined) return;
  if (!Array.isArray(notes)) {
    collector.error(path, "expected_array", "expected an array of method notes");
    return;
  }
  const kinds = new Set();
  notes.forEach((note, index) => {
    const notePath = `${path}/${index}`;
    if (!isPlainObject(note)) {
      collector.error(notePath, "expected_object", "expected a method note object");
      return;
    }
    findUnknownKeys(note, METHOD_NOTE_KEYS, notePath, collector);
    if (!METHOD_NOTE_KINDS.has(note.kind)) collector.error(`${notePath}/kind`, "unsupported_method_note", `unsupported method note kind ${JSON.stringify(note.kind)}`);
    else if (SINGLETON_METHOD_NOTE_KINDS.has(note.kind) && kinds.has(note.kind)) {
      collector.error(`${notePath}/kind`, "duplicate_method_note", `method note kind ${JSON.stringify(note.kind)} is repeated in this section`);
    } else if (SINGLETON_METHOD_NOTE_KINDS.has(note.kind)) kinds.add(note.kind);
    if (note.label !== undefined && typeof note.label !== "string") collector.error(`${notePath}/label`, "expected_string", "expected a label string");
    assertNonEmptyString(note.text, `${notePath}/text`, collector);
  });
}

function validateCaveats(caveats, path, collector) {
  if (caveats === undefined) return;
  if (!Array.isArray(caveats)) {
    collector.error(path, "expected_array", "expected an array of caveats");
    return;
  }
  caveats.forEach((caveat, index) => {
    const caveatPath = `${path}/${index}`;
    if (typeof caveat === "string") {
      assertNonEmptyString(caveat, caveatPath, collector);
      return;
    }
    if (!isPlainObject(caveat)) {
      collector.error(caveatPath, "expected_caveat", "expected caveat text or a structured caveat object");
      return;
    }
    if (caveat.kind !== undefined && !CAVEAT_KINDS.has(caveat.kind)) {
      collector.error(`${caveatPath}/kind`, "unsupported_caveat_kind", `unsupported caveat kind ${JSON.stringify(caveat.kind)}`);
    }
    assertNonEmptyString(caveat.text, `${caveatPath}/text`, collector);
  });
}

function validateActs(acts, path, collector, sections, sectionIds) {
  if (acts === undefined) return;
  if (!Array.isArray(acts) || acts.length === 0) {
    collector.error(path, "expected_nonempty_array", "acts must be a non-empty array when declared");
    return;
  }
  assertUniqueIds(acts, path, collector);
  const referenceCounts = new Map([...sectionIds].map((id) => [id, 0]));
  const flattened = [];
  acts.forEach((act, actIndex) => {
    const actPath = `${path}/${actIndex}`;
    if (!isPlainObject(act)) {
      collector.error(actPath, "expected_object", "expected an act object");
      return;
    }
    findUnknownKeys(act, ACT_KEYS, actPath, collector);
    assertNonEmptyString(act.title, `${actPath}/title`, collector);
    if (act.numeral !== undefined) assertNonEmptyString(act.numeral, `${actPath}/numeral`, collector);
    if (act.short_label !== undefined) assertNonEmptyString(act.short_label, `${actPath}/short_label`, collector);
    if (!Array.isArray(act.section_ids) || act.section_ids.length === 0) {
      collector.error(`${actPath}/section_ids`, "expected_nonempty_array", "act requires at least one section id");
      return;
    }
    const local = new Set();
    act.section_ids.forEach((id, sectionIndex) => {
      const refPath = `${actPath}/section_ids/${sectionIndex}`;
      if (typeof id !== "string" || id === "") collector.error(refPath, "expected_id_reference", "expected a non-empty section id");
      else if (local.has(id)) collector.error(refPath, "duplicate_reference", `section ${JSON.stringify(id)} is repeated in this act`);
      else if (!sectionIds.has(id)) collector.error(refPath, "unknown_section_reference", `unknown section ${JSON.stringify(id)}`);
      else {
        local.add(id);
        flattened.push(id);
        const nextCount = (referenceCounts.get(id) || 0) + 1;
        referenceCounts.set(id, nextCount);
        if (nextCount > 1) collector.error(refPath, "duplicate_act_section", `section ${JSON.stringify(id)} is assigned to more than one act`);
      }
    });
  });
  for (const [id, count] of referenceCounts) {
    if (count === 0) collector.error(path, "unassigned_act_section", `section ${JSON.stringify(id)} is not assigned to an act`);
  }
  const expectedOrder = Array.isArray(sections)
    ? sections.map((section) => section?.id).filter((id) => typeof id === "string" && sectionIds.has(id))
    : [];
  if (flattened.length === expectedOrder.length && flattened.some((id, index) => id !== expectedOrder[index])) {
    collector.error(path, "act_section_order", "flattened act section_ids must preserve the declared sections order");
  }
}

function validateFigureEnvelope(figure, path, collector, registry) {
  if (!isPlainObject(figure)) {
    collector.error(path, "expected_object", "expected a figure object");
    return;
  }
  findUnknownKeys(figure, FIGURE_KEYS, path, collector);
  assertNonEmptyString(figure.recipe, `${path}/recipe`, collector);
  if (typeof figure.recipe === "string" && !/^[a-z][a-z0-9.-]*@[1-9]\d*$/.test(figure.recipe)) {
    collector.error(`${path}/recipe`, "invalid_recipe_name", "recipe must be a versioned name such as generic.figure@1");
  } else if (typeof figure.recipe === "string" && !registry.has(figure.recipe)) {
    collector.error(`${path}/recipe`, "unknown_recipe", `unsupported recipe ${JSON.stringify(figure.recipe)}; supported: ${registry.list().join(", ")}`);
  }
  if (!Array.isArray(figure.panels)) collector.error(`${path}/panels`, "expected_array", "expected a panels array (it may be empty for recipe expansion)");
  if (figure.recipe_config !== undefined) {
    if (!isPlainObject(figure.recipe_config)) collector.error(`${path}/recipe_config`, "expected_object", "expected an object");
    else findUnknownKeys(figure.recipe_config, RECIPE_CONFIG_KEYS, `${path}/recipe_config`, collector);
  }
  validateLayout(figure.layout, `${path}/layout`, collector);
  validateScales(figure.scales, `${path}/scales`, collector);
  validateInteractionsEnvelope(figure.interactions, `${path}/interactions`, collector);
  rejectExecutableVisualKeys(figure.recipe_config, `${path}/recipe_config`, collector);
}

function validateLayout(layout, path, collector) {
  if (layout === undefined) return;
  if (!isPlainObject(layout)) {
    collector.error(path, "expected_object", "expected a layout object");
    return;
  }
  findUnknownKeys(layout, LAYOUT_KEYS, path, collector);
  if (layout.type !== undefined && !LAYOUT_TYPES.has(layout.type)) collector.error(`${path}/type`, "unsupported_layout", `unsupported layout ${JSON.stringify(layout.type)}`);
  for (const key of ["columns", "rows"]) if (layout[key] !== undefined && (!Number.isInteger(layout[key]) || layout[key] < 1)) collector.error(`${path}/${key}`, "invalid_grid_size", `${key} must be a positive integer`);
  if (layout.column_weights !== undefined) {
    if (!Array.isArray(layout.column_weights) || layout.column_weights.length === 0) {
      collector.error(`${path}/column_weights`, "expected_nonempty_array", "column_weights must be a non-empty array");
    } else {
      layout.column_weights.forEach((weight, index) => {
        if (!isFiniteNumber(weight) || weight <= 0) collector.error(`${path}/column_weights/${index}`, "invalid_column_weight", "column weights must be positive finite numbers");
      });
      if (!Number.isInteger(layout.columns)) collector.error(`${path}/column_weights`, "column_weights_require_columns", "column_weights requires an explicit columns value");
      else if (layout.column_weights.length !== layout.columns) collector.error(`${path}/column_weights`, "column_weight_count", `column_weights has ${layout.column_weights.length} values but columns is ${layout.columns}`);
      if (layout.type === "flow" || layout.type === "single") collector.error(`${path}/column_weights`, "column_weights_grid_only", "column_weights is supported only by grid layouts");
    }
  }
  for (const key of ["gap", "row_gap", "column_gap"]) if (layout[key] !== undefined && (!isFiniteNumber(layout[key]) || layout[key] <= 0)) collector.error(`${path}/${key}`, "invalid_layout_gap", `${key} must be a positive finite number`);
}

function validateScales(scales, path, collector) {
  if (scales === undefined) return;
  if (!Array.isArray(scales)) {
    collector.error(path, "expected_array", "expected an array");
    return;
  }
  assertUniqueIds(scales, path, collector);
  scales.forEach((scale, index) => {
    const scalePath = `${path}/${index}`;
    if (!isPlainObject(scale)) {
      collector.error(scalePath, "expected_object", "expected a scale object");
      return;
    }
    findUnknownKeys(scale, SCALE_KEYS, scalePath, collector);
    if (!SCALE_TYPES.has(scale.type)) collector.error(`${scalePath}/type`, "unsupported_scale", `unsupported scale type ${JSON.stringify(scale.type)}`);
    validateScaleDomain(scale, scalePath, collector);
  });
}

function validateScaleDomain(scale, path, collector) {
  if (scale.domain === undefined || !Array.isArray(scale.domain) || !SCALE_TYPES.has(scale.type)) return;
  const domain = scale.domain;
  if (["linear", "log", "sqrt", "symlog"].includes(scale.type)) {
    if (domain.length !== 2 || !domain.every(isFiniteNumber)) {
      collector.error(`${path}/domain`, "scale_domain_numeric", `${scale.type} scale domain must contain exactly two finite numbers`);
      return;
    }
    if (domain[0] >= domain[1]) collector.error(`${path}/domain`, "scale_domain_order", "numeric scale domain must be strictly increasing; use reverse to invert display direction");
    if (scale.type === "log" && domain.some((value) => value <= 0)) collector.error(`${path}/domain`, "scale_domain_log", "log scale domain values must both be greater than zero");
    if (scale.type === "sqrt" && domain.some((value) => value < 0)) collector.error(`${path}/domain`, "scale_domain_sqrt", "sqrt scale domain values must both be non-negative");
    return;
  }
  if (["time", "utc"].includes(scale.type)) {
    const parsed = domain.map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN);
    if (domain.length !== 2 || parsed.some(Number.isNaN)) {
      collector.error(`${path}/domain`, "scale_domain_temporal", `${scale.type} scale domain must contain exactly two parseable date strings`);
      return;
    }
    if (parsed[0] >= parsed[1]) collector.error(`${path}/domain`, "scale_domain_order", "temporal scale domain must be strictly increasing; use reverse to invert display direction");
    return;
  }
  if (domain.length === 0) collector.error(`${path}/domain`, "scale_domain_categorical", `${scale.type} scale domain must not be empty`);
  const seen = new Set();
  domain.forEach((value, index) => {
    if (seen.has(value)) collector.error(`${path}/domain/${index}`, "scale_domain_duplicate", `categorical scale domain value ${JSON.stringify(value)} is duplicated`);
    seen.add(value);
  });
}

function inlineRowsForRenderer(source) {
  if (!isPlainObject(source?.storage) || source.storage.kind !== "inline") return null;
  const value = source.storage.values ?? source.storage.rows;
  const fields = (source.fields || []).map((field) => field.name);
  if (Array.isArray(value)) {
    if (value.every((item) => isPlainObject(item))) return value;
    if (fields.length === 1 && value.every((item) => !Array.isArray(item))) return value.map((item) => ({ [fields[0]]: item }));
    return value.map((item) => Array.isArray(item)
      ? Object.fromEntries(fields.map((field, index) => [field, item[index]]))
      : { value: item });
  }
  if (isPlainObject(value)) {
    const columns = Object.keys(value);
    const length = columns.reduce((maximum, column) => Math.max(maximum, Array.isArray(value[column]) ? value[column].length : 0), 0);
    return Array.from({ length }, (_, index) => Object.fromEntries(columns.map((column) => [column, value[column]?.[index]])));
  }
  return [];
}

function applyRendererTransforms(rows, transforms = []) {
  let result = rows;
  for (const transform of transforms) {
    if (transform.op === "filter") {
      const predicate = transform.predicate || {};
      result = result.filter((row) => {
        const value = row[transform.field];
        if (Object.hasOwn(predicate, "eq")) return value === predicate.eq;
        if (Object.hasOwn(predicate, "neq")) return value !== predicate.neq;
        if (Object.hasOwn(predicate, "lt")) return value < predicate.lt;
        if (Object.hasOwn(predicate, "lte")) return value <= predicate.lte;
        if (Object.hasOwn(predicate, "gt")) return value > predicate.gt;
        if (Object.hasOwn(predicate, "gte")) return value >= predicate.gte;
        if (Array.isArray(predicate.in)) return predicate.in.includes(value);
        if (Array.isArray(predicate.not_in)) return !predicate.not_in.includes(value);
        if (Object.hasOwn(predicate, "valid")) {
          const valid = value !== null && value !== undefined && (typeof value !== "number" || Number.isFinite(value));
          return predicate.valid ? valid : !valid;
        }
        return true;
      });
    } else if (transform.op === "sort") {
      const direction = transform.order === "descending" ? -1 : 1;
      result = [...result].sort((left, right) => direction * stableValueCompare(left[transform.field], right[transform.field]));
    } else if (transform.op === "sample") {
      const size = Math.min(result.length, transform.size || result.length);
      if (transform.method === "first") result = result.slice(0, size);
      else if (transform.method === "stride") {
        const step = transform.step || Math.max(1, Math.floor(result.length / Math.max(1, size)));
        result = result.filter((_, index) => index % step === 0).slice(0, size);
      } else if (transform.method === "hash") {
        const hash = (value) => {
          let state = 2166136261;
          const text = String(value);
          for (let index = 0; index < text.length; index += 1) {
            state ^= text.charCodeAt(index);
            state = Math.imul(state, 16777619);
          }
          return state >>> 0;
        };
        result = [...result]
          .map((row, index) => ({ row, index, score: hash(row[transform.key]) }))
          .sort((left, right) => left.score - right.score || left.index - right.index)
          .slice(0, size)
          .sort((left, right) => left.index - right.index)
          .map((item) => item.row);
      }
    }
  }
  return result;
}

/**
 * Preflight every explicitly scaled channel against materialized renderer data.
 * Sidecars are checked after their one verified read in loadPayloadV3.
 */
export function validateRendererDataDomainsV3(model) {
  const collector = new DiagnosticCollector();
  const sources = new Map((model?.data || []).map((source) => [source?.id, source]));
  const rowCache = new Map();
  const rowsFor = (reference) => {
    if (!reference || !sources.has(reference)) return null;
    if (!rowCache.has(reference)) rowCache.set(reference, inlineRowsForRenderer(sources.get(reference)));
    return rowCache.get(reference);
  };
  const transformList = (value) => value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  for (const [figureIndex, figure] of (model?.figures || []).entries()) {
    const scaleIndex = new Map((figure?.scales || []).map((scale) => [scale?.id, scale]));
    const colourScaleIds = new Set();
    for (const candidatePanel of (figure?.panels || [])) {
      for (const candidateLayer of (candidatePanel?.layers || [])) {
        for (const channelName of ["color", "stroke"]) {
          const binding = candidateLayer?.encoding?.[channelName];
          if (typeof binding?.scale_id === "string") colourScaleIds.add(binding.scale_id);
        }
      }
    }
    for (const [panelIndex, panel] of (figure?.panels || []).entries()) {
      const coordinateType = coordinateTypeOf(panel?.coordinate);
      const layers = [...(panel?.layers || [])];
      for (const [layerIndex, layer] of layers.entries()) {
        const reference = layer?.data_ref ?? panel?.data_ref;
        const sourceRows = rowsFor(reference);
        const rows = sourceRows === null
          ? null
          : applyRendererTransforms(sourceRows, [...transformList(panel?.transform), ...transformList(layer?.transform)]);
        const layerPath = `/figures/${figureIndex}/panels/${panelIndex}/layers/${layerIndex}`;
        const requiredSet = (PAYLOAD_V3_MARK_CHANNEL_REQUIREMENTS[layer?.mark?.type] || [])
          .find((candidate) => candidate.every((channelName) => isPlainObject(layer?.encoding?.[channelName])));
        if (requiredSet) {
          const allConstants = requiredSet.every((channelName) => Object.hasOwn(layer.encoding[channelName], "value"));
          const requiredRows = rows === null ? (allConstants ? [{}] : null) : rows;
          if (requiredRows) {
            for (const channelName of requiredSet) {
              const channel = layer.encoding[channelName];
              const values = Object.hasOwn(channel, "value") ? [channel.value] : requiredRows.map((row) => row?.[channel.field]);
              for (const value of values) {
                const valid = channel.type === "quantitative"
                  ? isFiniteNumber(value)
                  : (channel.type === "temporal"
                    ? (matchesPhysicalValue(value, "date") || matchesPhysicalValue(value, "datetime"))
                    : value !== null && value !== undefined);
                if (!valid) {
                  collector.error(`${layerPath}/encoding/${channelName}`, "required_channel_value", `required ${channelName} channel contains a null, non-finite, or incompatible value after transforms`);
                  break;
                }
              }
            }
          }
        }
        for (const [channelName, channelValueSpec] of Object.entries(layer?.encoding || {})) {
          const channels = Array.isArray(channelValueSpec) ? channelValueSpec : [channelValueSpec];
          for (const [channelIndex, channel] of channels.entries()) {
            if (!isPlainObject(channel) || typeof channel.scale_id !== "string") continue;
            const scale = scaleIndex.get(channel.scale_id);
            if (!scale) continue;
            const channelPath = `/figures/${figureIndex}/panels/${panelIndex}/layers/${layerIndex}/encoding/${channelName}${Array.isArray(channelValueSpec) ? `/${channelIndex}` : ""}`;
            const numeric = ["linear", "log", "sqrt", "symlog"].includes(scale.type);
            const categorical = ["band", "point", "ordinal"].includes(scale.type);
            const temporal = ["time", "utc"].includes(scale.type);
            const colorChannel = ["color", "stroke"].includes(channelName);
            if (colorChannel) {
              const compatibleColorScale = (channel.type === "quantitative" && scale.type === "linear")
                || (["nominal", "ordinal"].includes(channel.type) && scale.type === "ordinal");
              if (!compatibleColorScale) {
                collector.error(`${channelPath}/scale_id`, "color_scale_type", "colour channels support linear quantitative scales or ordinal categorical scales only");
              }
              if (scale.zero !== undefined || scale.reverse !== undefined) {
                collector.error(`${channelPath}/scale_id`, "color_scale_option", "zero and reverse are not supported for colour scales; declare the desired domain/range explicitly");
              }
            } else if (POSITIONAL_CHANNELS.has(channelName)) {
              if ((scale.range !== undefined || scale.scheme !== undefined) && !colourScaleIds.has(scale.id)) {
                collector.error(`${channelPath}/scale_id`, "positional_scale_option", "range and scheme are colour-scale options and are not rendered on positional channels");
              }
              if (coordinateType === "matrix" && !categorical) {
                collector.error(`${channelPath}/scale_id`, "matrix_scale_type", "matrix x/y channels support band, point, or ordinal scales only");
              }
            }
            if (numeric && channel.type !== "quantitative") collector.error(`${channelPath}/scale_id`, "scale_channel_type", `${scale.type} scale requires a quantitative channel`);
            if (categorical && !["nominal", "ordinal"].includes(channel.type)) collector.error(`${channelPath}/scale_id`, "scale_channel_type", `${scale.type} scale requires a nominal or ordinal channel`);
            if (temporal && channel.type !== "temporal") collector.error(`${channelPath}/scale_id`, "scale_channel_type", `${scale.type} scale requires a temporal channel`);
            if (!POSITIONAL_CHANNELS.has(channelName) && !["color", "stroke"].includes(channelName)) {
              collector.error(`${channelPath}/scale_id`, "scale_channel_unsupported", `scale_id is not rendered for channel ${JSON.stringify(channelName)}`);
              continue;
            }
            if (rows === null && !Object.hasOwn(channel, "value")) continue;
            const values = Object.hasOwn(channel, "value") ? [channel.value] : rows.map((row) => row?.[channel.field]);
            for (const value of values) {
              if (numeric && !isFiniteNumber(value)) {
                collector.error(channelPath, "scale_data_numeric", `${scale.type} scale received a non-finite numeric value`);
                break;
              }
              if (scale.type === "log" && value <= 0) {
                collector.error(channelPath, "scale_data_log", `log scale received non-positive value ${JSON.stringify(value)}`);
                break;
              }
              if (scale.type === "sqrt" && value < 0) {
                collector.error(channelPath, "scale_data_sqrt", `sqrt scale received negative value ${JSON.stringify(value)}`);
                break;
              }
              if (temporal && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
                collector.error(channelPath, "scale_data_temporal", `${scale.type} scale received an invalid temporal value`);
                break;
              }
              if (categorical && (value === null || value === undefined)) {
                collector.error(channelPath, "scale_data_categorical", `${scale.type} scale received a null category`);
                break;
              }
              if (categorical && Array.isArray(scale.domain)
                  && !scale.domain.some((candidate) => typeof candidate === typeof value && Object.is(candidate, value))) {
                collector.error(channelPath, "scale_data_domain", `${scale.type} scale received value ${JSON.stringify(value)} outside its declared domain`);
                break;
              }
            }
          }
        }
      }
    }
  }
  return collector.errors;
}

function validateInteractionsEnvelope(interactions, path, collector) {
  if (interactions === undefined) return;
  if (!Array.isArray(interactions)) {
    collector.error(path, "expected_array", "expected an interactions array");
    return;
  }
  assertUniqueIds(interactions, path, collector);
  interactions.forEach((interaction, index) => {
    const interactionPath = `${path}/${index}`;
    if (!isPlainObject(interaction)) collector.error(interactionPath, "expected_object", "expected an interaction object");
    else if (!INTERACTION_TYPES.has(interaction.type)) collector.error(`${interactionPath}/type`, "unsupported_interaction", `unsupported interaction type ${JSON.stringify(interaction.type)}`);
    rejectExecutableVisualKeys(interaction, interactionPath, collector);
  });
}

function validateExpandedFigure(figure, panels, path, collector, dataIndex, dataSources) {
  const panelIds = assertUniqueIds(panels, `${path}/panels`, collector);
  const scaleIds = new Set((figure.scales || []).map((scale) => scale?.id).filter((id) => typeof id === "string"));
  const targetIndex = new Set();
  const targetDataRefs = new Map();
  const targetCoordinates = new Map();
  panels.forEach((panel, panelIndex) => {
    const panelPath = `${path}/panels/${panelIndex}`;
    validatePanel(panel, panelPath, collector, dataIndex, dataSources, scaleIds, targetIndex, targetDataRefs, targetCoordinates);
    if (typeof panel?.id === "string") targetIndex.add(panel.id);
  });
  validateLayoutCapacity(figure.layout, panels, `${path}/layout`, collector);
  validateInteractionTargets(figure.interactions, `${path}/interactions`, collector, panelIds, targetIndex, targetDataRefs, targetCoordinates, dataIndex);
}

function firstFitGridPlacements(panels, columns) {
  const occupied = [];
  const placements = [];
  for (const panel of panels) {
    const display = isPlainObject(panel?.display) ? panel.display : {};
    const columnSpan = Number.isInteger(display.column_span) ? display.column_span : 1;
    const rowSpan = Number.isInteger(display.row_span) ? display.row_span : 1;
    let placement = null;
    for (let row = 0; row <= occupied.length && !placement; row += 1) {
      for (let column = 0; column + columnSpan <= columns && !placement; column += 1) {
        let available = true;
        for (let rowOffset = 0; rowOffset < rowSpan && available; rowOffset += 1) {
          for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
            if (occupied[row + rowOffset]?.[column + columnOffset]) {
              available = false;
              break;
            }
          }
        }
        if (available) placement = { row: row + 1, column: column + 1, rowSpan, columnSpan };
      }
    }
    if (!placement) return { placements, requiredRows: Infinity };
    while (occupied.length < placement.row - 1 + rowSpan) occupied.push(Array(columns).fill(false));
    for (let row = placement.row - 1; row < placement.row - 1 + rowSpan; row += 1) {
      for (let column = placement.column - 1; column < placement.column - 1 + columnSpan; column += 1) occupied[row][column] = true;
    }
    placements.push(placement);
  }
  return { placements, requiredRows: occupied.length };
}

function validateLayoutCapacity(layout, panels, path, collector) {
  if (!isPlainObject(layout)) return;
  const panelsPath = path.endsWith("/layout") ? `${path.slice(0, -"/layout".length)}/panels` : `${path}/panels`;
  if (layout.type === "single" && panels.length !== 1) collector.error(path, "single_layout_panel_count", `single layout requires exactly one panel; received ${panels.length}`);
  const layoutType = layout.type || "grid";
  const columns = Number.isInteger(layout.columns) ? layout.columns : 1;
  let spansFitGrid = true;
  panels.forEach((panel, index) => {
    const display = isPlainObject(panel?.display) ? panel.display : {};
    const columnSpan = Number.isInteger(display.column_span) ? display.column_span : 1;
    const rowSpan = Number.isInteger(display.row_span) ? display.row_span : 1;
    if (layout.type === "flow" && (display.column_span !== undefined || display.row_span !== undefined)) {
      collector.error(`${panelsPath}/${index}/display`, "panel_span_grid_only", "column_span and row_span are supported only by grid layouts");
    }
    if (layout.type === "single" && (columnSpan !== 1 || rowSpan !== 1)) {
      collector.error(`${panelsPath}/${index}/display`, "single_layout_span", "single-layout panels cannot span multiple grid cells");
    }
    if (layoutType === "grid" && columnSpan > columns) {
      spansFitGrid = false;
      collector.error(`${panelsPath}/${index}/display/column_span`, "column_span_exceeds_layout", `column_span ${columnSpan} exceeds layout columns ${columns}`);
    }
    if (Number.isInteger(layout.rows) && rowSpan > layout.rows) {
      spansFitGrid = false;
      collector.error(`${panelsPath}/${index}/display/row_span`, "row_span_exceeds_layout", `row_span ${rowSpan} exceeds layout rows ${layout.rows}`);
    }
  });
  if (layoutType === "grid" && spansFitGrid) {
    const placement = firstFitGridPlacements(panels, columns);
    if (Number.isInteger(layout.rows) && placement.requiredRows > layout.rows) {
      collector.error(path, "layout_capacity", `row-major first-fit placement requires ${placement.requiredRows} rows but layout declares ${layout.rows}`);
    }
  }
}

function validatePanel(panel, path, collector, dataIndex, dataSources, scaleIds, targetIndex, targetDataRefs, targetCoordinates) {
  if (!isPlainObject(panel)) {
    collector.error(path, "expected_object", "expected a panel object");
    return;
  }
  findUnknownKeys(panel, PANEL_KEYS, path, collector);
  validatePanelDisplay(panel.display, `${path}/display`, collector);
  const panelType = panel.type ?? inferPanelType(panel.coordinate);
  if (!PANELS.has(panelType)) collector.error(`${path}/type`, "unknown_panel", `unsupported panel type ${JSON.stringify(panelType)}`);
  const coordinateType = coordinateTypeOf(panel.coordinate);
  if (!COORDINATE_TYPES.has(coordinateType)) collector.error(`${path}/coordinate/type`, "unsupported_coordinate", `unsupported coordinate type ${JSON.stringify(coordinateType)}`);
  else if (panel.type !== undefined && PANELS.has(panelType) && panelType !== inferPanelType(panel.coordinate)) {
    collector.error(`${path}/type`, "panel_coordinate_mismatch", `panel type ${JSON.stringify(panelType)} is incompatible with coordinate ${JSON.stringify(coordinateType)}; expected ${JSON.stringify(inferPanelType(panel.coordinate))}`);
  }
  if (isPlainObject(panel.coordinate) && panel.coordinate.equal_aspect !== undefined && coordinateType !== "cartesian") {
    collector.error(`${path}/coordinate/equal_aspect`, "equal_aspect_coordinate", "equal_aspect is supported only by cartesian coordinates");
  }
  if (isPlainObject(panel.coordinate)) findUnknownKeys(panel.coordinate, COORDINATE_KEYS, `${path}/coordinate`, collector);
  if (panel.data_ref !== undefined && !dataIndex.has(panel.data_ref)) collector.error(`${path}/data_ref`, "unknown_data_reference", `unknown data source ${JSON.stringify(panel.data_ref)}`);
  validateTransforms(panel.transform, `${path}/transform`, collector, panel.data_ref, dataIndex);
  if (!Array.isArray(panel.layers) || panel.layers.length === 0) {
    collector.error(`${path}/layers`, "expected_nonempty_array", "panel requires at least one layer");
    return;
  }
  const annotationLayers = validatePanelAnnotations(panel.annotations, `${path}/annotations`, collector);
  assertUniqueIds([...panel.layers, ...annotationLayers], `${path}/layers`, collector);
  if (panel.transform !== undefined) {
    panel.layers.forEach((layer, layerIndex) => {
      if (layer?.data_ref !== undefined && layer.data_ref !== panel.data_ref) {
        collector.error(`${path}/layers/${layerIndex}/data_ref`, "panel_transform_data_override", "a layer cannot override data_ref when its panel declares transforms; move the transform to the layer or use one panel data source");
      }
    });
  }
  const panelDataRefs = new Set();
  panel.layers.forEach((layer, layerIndex) => {
    const layerPath = `${path}/layers/${layerIndex}`;
    validateLayer(layer, layerPath, collector, panel.data_ref, dataIndex, scaleIds);
    if (typeof panel.id === "string" && typeof layer?.id === "string") {
      const target = `${panel.id}/${layer.id}`;
      targetIndex.add(target);
      const dataRef = layer.data_ref ?? panel.data_ref;
      const references = new Set(typeof dataRef === "string" ? [dataRef] : []);
      targetDataRefs.set(target, references);
      targetCoordinates.set(target, coordinateType);
      references.forEach((reference) => panelDataRefs.add(reference));
    }
  });
  annotationLayers.forEach((layer, annotationIndex) => {
    const annotationPath = `${path}/annotations/${annotationIndex}`;
    validateLayer(layer, annotationPath, collector, panel.data_ref, dataIndex, scaleIds);
    if (typeof panel.id === "string" && typeof layer?.id === "string") {
      const target = `${panel.id}/${layer.id}`;
      targetIndex.add(target);
      const references = new Set(typeof panel.data_ref === "string" ? [panel.data_ref] : []);
      targetDataRefs.set(target, references);
      targetCoordinates.set(target, coordinateType);
      references.forEach((reference) => panelDataRefs.add(reference));
    }
  });
  if (typeof panel.id === "string") {
    targetDataRefs.set(panel.id, panelDataRefs);
    targetCoordinates.set(panel.id, coordinateType);
  }
  validateCoordinateMarkCapabilities([...panel.layers, ...annotationLayers], coordinateType, path, collector);
  validatePanelScaleConsistency([...panel.layers, ...annotationLayers], path, collector);
  if (coordinateType === "tree") validateTreeTopology(panel, path, collector, dataSources);
}

function validatePanelScaleConsistency(layers, path, collector) {
  const families = {
    x: new Set(),
    y: new Set(),
    color: new Set()
  };
  const colourTypes = new Set();
  const colourRoles = new Set();
  for (const layer of layers) {
    for (const [channelName, binding] of Object.entries(layer?.encoding || {})) {
      if (!isPlainObject(binding)) continue;
      const axisScale = typeof binding.scale_id === "string"
        ? binding.scale_id
        : (Object.hasOwn(binding, "field") ? "(implicit)" : null);
      if (X_POSITIONAL_CHANNELS.has(channelName) && axisScale) families.x.add(axisScale);
      else if (Y_POSITIONAL_CHANNELS.has(channelName) && axisScale) families.y.add(axisScale);
      else if (["color", "stroke"].includes(channelName)) {
        if (axisScale) families.color.add(axisScale);
        if (typeof binding.type === "string") colourTypes.add(binding.type);
        if (typeof binding.scale_role === "string") colourRoles.add(binding.scale_role);
      }
    }
  }
  for (const [family, ids] of Object.entries(families)) {
    if (ids.size > 1) {
      collector.error(`${path}/layers`, "multiple_panel_scales", `one panel can render only one ${family} scale; received ${[...ids].map((id) => JSON.stringify(id)).join(", ")}`);
    }
  }
  if (colourTypes.size > 1) {
    collector.error(`${path}/layers`, "mixed_color_channel_types", `one panel cannot mix colour channel types ${[...colourTypes].map((type) => JSON.stringify(type)).join(", ")}`);
  }
  if (colourRoles.size > 1) {
    collector.error(`${path}/layers`, "mixed_color_scale_roles", `one panel cannot mix explicit colour scale roles ${[...colourRoles].map((role) => JSON.stringify(role)).join(", ")}`);
  }
}

function validatePanelDisplay(display, path, collector) {
  if (display === undefined) return;
  if (!isPlainObject(display)) {
    collector.error(path, "expected_object", "expected a panel display object");
    return;
  }
  findUnknownKeys(display, PANEL_DISPLAY_KEYS, path, collector);
  if (display.aspect_ratio !== undefined && (!isFiniteNumber(display.aspect_ratio) || display.aspect_ratio <= 0 || display.aspect_ratio > 20)) {
    collector.error(`${path}/aspect_ratio`, "invalid_aspect_ratio", "aspect_ratio must be a positive finite number no greater than 20");
  }
  if (display.column_span !== undefined && (!Number.isInteger(display.column_span) || display.column_span < 1 || display.column_span > 12)) {
    collector.error(`${path}/column_span`, "invalid_column_span", "column_span must be an integer from 1 to 12");
  }
  if (display.row_span !== undefined && (!Number.isInteger(display.row_span) || display.row_span < 1 || display.row_span > 24)) {
    collector.error(`${path}/row_span`, "invalid_row_span", "row_span must be an integer from 1 to 24");
  }
}

function validateCoordinateMarkCapabilities(layers, coordinateType, path, collector) {
  const supported = COORDINATE_MARK_CAPABILITIES[coordinateType];
  if (!supported || !Array.isArray(layers)) return;
  const marks = [];
  layers.forEach((layer, index) => {
    const mark = layer?.mark?.type;
    if (typeof mark !== "string") return;
    marks.push(mark);
    if (!supported.has(mark)) {
      collector.error(`${path}/layers/${index}/mark/type`, "unsupported_mark_coordinate", `${mark} is not supported in ${coordinateType} coordinates`);
    }
  });
  const count = (type) => marks.filter((mark) => mark === type).length;
  if (coordinateType === "matrix") {
    if (count("rect") !== 1) collector.error(`${path}/layers`, "matrix_rect_count", `matrix coordinates require exactly one rect layer; received ${count("rect")}`);
    if (count("text") > 1) collector.error(`${path}/layers`, "matrix_text_count", `matrix coordinates permit at most one text layer; received ${count("text")}`);
  }
  if (coordinateType === "tree") {
    if (count("node") !== 1) collector.error(`${path}/layers`, "tree_node_count", `tree coordinates require exactly one node layer; received ${count("node")}`);
    if (count("link") !== 1) collector.error(`${path}/layers`, "tree_link_count", `tree coordinates require exactly one link layer; received ${count("link")}`);
  }
  if (coordinateType === "flow" && count("node") !== 1) {
    collector.error(`${path}/layers`, "flow_node_count", `flow coordinates require exactly one node layer and no other marks; received ${count("node")} node layers`);
  }
  if (coordinateType === "canvas" && count("point") !== 1) {
    collector.error(`${path}/layers`, "canvas_point_count", `canvas coordinates require exactly one point layer and no other marks; received ${count("point")} point layers`);
  }
}

function validateTreeTopology(panel, path, collector, dataSources) {
  const nodeLayerIndex = panel.layers.findIndex((layer) => layer?.mark?.type === "node");
  const linkLayerIndex = panel.layers.findIndex((layer) => layer?.mark?.type === "link");
  if (nodeLayerIndex === -1 || linkLayerIndex === -1
    || panel.layers.filter((layer) => layer?.mark?.type === "node").length !== 1
    || panel.layers.filter((layer) => layer?.mark?.type === "link").length !== 1) return;

  const nodeLayer = panel.layers[nodeLayerIndex];
  const linkLayer = panel.layers[linkLayerIndex];
  const keyBinding = nodeLayer.encoding?.key;
  const fromBinding = linkLayer.encoding?.from;
  const toBinding = linkLayer.encoding?.to;
  if (!isPlainObject(keyBinding) || !isPlainObject(fromBinding) || !isPlainObject(toBinding)) return;

  const nodeRows = treeLayerRows(panel, nodeLayer, dataSources);
  const linkRows = treeLayerRows(panel, linkLayer, dataSources);
  if (nodeRows === null || linkRows === null) return;

  const nodeLayerPath = `${path}/layers/${nodeLayerIndex}`;
  const linkLayerPath = `${path}/layers/${linkLayerIndex}`;
  const adjacency = new Map();
  let duplicateNodeKey = false;
  for (const entry of nodeRows) {
    const key = treeChannelValue(entry.row, keyBinding);
    const keyPath = treeChannelPath(entry, keyBinding, nodeLayerPath, "key");
    if (adjacency.has(key)) {
      collector.error(keyPath, "tree_duplicate_node_key", `tree node key ${JSON.stringify(key)} is duplicated`);
      duplicateNodeKey = true;
    } else adjacency.set(key, []);
  }
  if (duplicateNodeKey) return;

  const indegree = new Map([...adjacency.keys()].map((key) => [key, 0]));
  let unknownEndpoint = false;
  for (const entry of linkRows) {
    const from = treeChannelValue(entry.row, fromBinding);
    const to = treeChannelValue(entry.row, toBinding);
    if (!adjacency.has(from)) {
      collector.error(treeChannelPath(entry, fromBinding, linkLayerPath, "from"), "tree_unknown_link_endpoint", `tree link source ${JSON.stringify(from)} does not reference a node key`);
      unknownEndpoint = true;
    }
    if (!adjacency.has(to)) {
      collector.error(treeChannelPath(entry, toBinding, linkLayerPath, "to"), "tree_unknown_link_endpoint", `tree link target ${JSON.stringify(to)} does not reference a node key`);
      unknownEndpoint = true;
    }
    if (adjacency.has(from) && adjacency.has(to)) {
      adjacency.get(from).push(to);
      indegree.set(to, indegree.get(to) + 1);
    }
  }
  if (unknownEndpoint) return;

  const roots = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key);
  if (roots.length !== 1) {
    collector.error(`${path}/layers`, "tree_root_count", `tree requires exactly one root; found ${roots.length}`);
  }

  const remainingIndegree = new Map(indegree);
  const topologicalQueue = roots.slice();
  let topologicalIndex = 0;
  let processed = 0;
  while (topologicalIndex < topologicalQueue.length) {
    const node = topologicalQueue[topologicalIndex++];
    processed += 1;
    for (const child of adjacency.get(node) || []) {
      const nextDegree = remainingIndegree.get(child) - 1;
      remainingIndegree.set(child, nextDegree);
      if (nextDegree === 0) topologicalQueue.push(child);
    }
  }
  if (processed !== adjacency.size) {
    collector.error(`${path}/layers`, "tree_cycle", "tree links contain a directed cycle");
  }

  if (roots.length === 1) {
    const visited = new Set();
    const queue = [roots[0]];
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const node = queue[queueIndex++];
      if (visited.has(node)) continue;
      visited.add(node);
      for (const child of adjacency.get(node) || []) queue.push(child);
    }
    if (visited.size !== adjacency.size) {
      collector.error(`${path}/layers`, "tree_disconnected", `tree must be connected from its root; reached ${visited.size} of ${adjacency.size} nodes`);
    }
  }
}

function treeLayerRows(panel, layer, dataSources) {
  const dataRef = layer.data_ref ?? panel.data_ref;
  const indexedSource = dataSources.get(dataRef);
  if (!indexedSource) return null;
  const rows = inlineTreeRows(indexedSource);
  if (rows === null) return null;
  const transforms = [];
  for (const value of [panel.transform, layer.transform]) {
    if (value === undefined) continue;
    if (Array.isArray(value)) transforms.push(...value);
    else transforms.push(value);
  }
  return applyTreeTransforms(rows, transforms);
}

function inlineTreeRows({ source, path }) {
  const storage = source?.storage;
  const fields = source?.fields;
  if (!isPlainObject(storage) || storage.kind !== "inline" || !Array.isArray(fields) || fields.length === 0) return null;
  const fieldNames = fields.map((field) => field?.name);
  if (fieldNames.some((name) => typeof name !== "string" || name === "")) return null;

  if (storage.rows !== undefined) {
    if (!Array.isArray(storage.rows)) return null;
    const entries = [];
    for (let rowIndex = 0; rowIndex < storage.rows.length; rowIndex += 1) {
      const value = storage.rows[rowIndex];
      const rowPath = `${path}/storage/rows/${rowIndex}`;
      if (Array.isArray(value)) {
        if (value.length !== fieldNames.length) return null;
        entries.push({
          row: Object.fromEntries(fieldNames.map((field, fieldIndex) => [field, value[fieldIndex]])),
          fieldPath: (field) => `${rowPath}/${fieldNames.indexOf(field)}`
        });
      } else if (isPlainObject(value) && fieldNames.every((field) => Object.hasOwn(value, field))) {
        entries.push({ row: value, fieldPath: (field) => joinPointer(rowPath, field) });
      } else return null;
    }
    return entries;
  }

  if (Array.isArray(storage.values)) {
    if (fieldNames.length !== 1) return null;
    return storage.values.map((value, rowIndex) => ({
      row: { [fieldNames[0]]: value },
      fieldPath: () => `${path}/storage/values/${rowIndex}`
    }));
  }
  if (!isPlainObject(storage.values)) return null;
  const columns = fieldNames.map((field) => storage.values[field]);
  if (columns.some((column) => !Array.isArray(column))) return null;
  const length = columns[0].length;
  if (columns.some((column) => column.length !== length)) return null;
  return Array.from({ length }, (_, rowIndex) => ({
    row: Object.fromEntries(fieldNames.map((field, fieldIndex) => [field, columns[fieldIndex][rowIndex]])),
    fieldPath: (field) => `${joinPointer(`${path}/storage/values`, field)}/${rowIndex}`
  }));
}

function applyTreeTransforms(rows, transforms) {
  let result = rows;
  for (const transform of transforms) {
    if (!isPlainObject(transform) || !TRANSFORM_OPS.has(transform.op)) return null;
    if (transform.op === "filter") {
      if (typeof transform.field !== "string" || !isPlainObject(transform.predicate)) return null;
      result = result.filter((entry) => {
        const value = entry.row[transform.field];
        const predicate = transform.predicate;
        if (Object.hasOwn(predicate, "eq")) return value === predicate.eq;
        if (Object.hasOwn(predicate, "neq")) return value !== predicate.neq;
        if (Array.isArray(predicate.in)) return predicate.in.includes(value);
        if (Array.isArray(predicate.not_in)) return !predicate.not_in.includes(value);
        if (Object.hasOwn(predicate, "lt")) return value < predicate.lt;
        if (Object.hasOwn(predicate, "lte")) return value <= predicate.lte;
        if (Object.hasOwn(predicate, "gt")) return value > predicate.gt;
        if (Object.hasOwn(predicate, "gte")) return value >= predicate.gte;
        if (Object.hasOwn(predicate, "valid")) {
          const valid = value !== null && value !== undefined && (typeof value !== "number" || Number.isFinite(value));
          return predicate.valid ? valid : !valid;
        }
        return true;
      });
    } else if (transform.op === "sort") {
      if (typeof transform.field !== "string") return null;
      const direction = transform.order === "descending" ? -1 : 1;
      result = [...result].sort((left, right) => direction * stableValueCompare(left.row[transform.field], right.row[transform.field]));
    } else if (transform.op === "sample") {
      const size = Math.min(result.length, transform.size || result.length);
      if (transform.method === "first") result = result.slice(0, size);
      else if (transform.method === "stride") {
        const step = transform.step || Math.max(1, Math.floor(result.length / Math.max(1, size)));
        result = result.filter((_, index) => index % step === 0).slice(0, size);
      } else if (transform.method === "hash" && typeof transform.key === "string") {
        const hash = (value) => {
          let state = 2166136261;
          const text = String(value);
          for (let index = 0; index < text.length; index += 1) {
            state ^= text.charCodeAt(index);
            state = Math.imul(state, 16777619);
          }
          return state >>> 0;
        };
        result = [...result]
          .map((entry, index) => ({ entry, index, score: hash(entry.row[transform.key]) }))
          .sort((left, right) => left.score - right.score || left.index - right.index)
          .slice(0, size)
          .sort((left, right) => left.index - right.index)
          .map((item) => item.entry);
      } else return null;
    }
  }
  return result;
}

function treeChannelValue(row, binding) {
  if (Object.hasOwn(binding, "value")) return binding.value;
  return row?.[binding.field];
}

function treeChannelPath(entry, binding, layerPath, channel) {
  return Object.hasOwn(binding, "field")
    ? entry.fieldPath(binding.field)
    : `${layerPath}/encoding/${channel}/value`;
}

function coordinateTypeOf(coordinate) {
  if (coordinate === undefined) return "cartesian";
  if (typeof coordinate === "string") return coordinate;
  return coordinate?.type;
}

function inferPanelType(coordinate) {
  const type = coordinateTypeOf(coordinate);
  if (type === "matrix" || type === "tree") return type;
  if (type === "flow") return "diagram";
  return "plot";
}

function validatePanelAnnotations(annotations, path, collector) {
  if (annotations === undefined) return [];
  if (!Array.isArray(annotations)) {
    collector.error(path, "expected_array", "expected an annotations array");
    return [];
  }
  const layers = [];
  annotations.forEach((annotation, index) => {
    const annotationPath = `${path}/${index}`;
    if (!isPlainObject(annotation)) {
      collector.error(annotationPath, "expected_object", "expected an annotation object");
      return;
    }
    findUnknownKeys(annotation, ANNOTATION_KEYS, annotationPath, collector);
    const type = annotation.type;
    if (!ANNOTATION_TYPES.has(type)) {
      collector.error(`${annotationPath}/type`, "unsupported_annotation", `unsupported annotation type ${JSON.stringify(type)}`);
      return;
    }
    try {
      layers.push(...annotationToLayers(annotation, index));
    } catch (error) {
      collector.error(annotationPath, "invalid_annotation", error.message);
    }
  });
  return layers;
}

function annotationToLayers(annotation, index) {
  const id = typeof annotation.id === "string" && annotation.id ? annotation.id : `annotation-${index + 1}`;
  if (isPlainObject(annotation.encoding) && ["rule", "text", "band"].includes(annotation.type)) {
    return [{ id, description: annotation.description || annotation.label, mark: { type: annotation.type, role: "annotation" }, encoding: annotation.encoding }];
  }
  const constant = (value) => ({ value, type: typeof value === "number" ? "quantitative" : "nominal" });
  if (["rule", "reference-line"].includes(annotation.type)) {
    if (!(["x", "y"].includes(annotation.axis))) throw new Error("rule/reference-line requires axis x or y");
    if (!Object.hasOwn(annotation, "value")) throw new Error("rule/reference-line requires value");
    const mark = { type: "rule", role: "annotation" };
    if (annotation.style?.color) mark.color = annotation.style.color;
    if (annotation.style?.line_style === "dashed") mark.dash = [6, 4];
    if (annotation.style?.line_style === "dotted") mark.dash = [2, 3];
    return [{ id, description: annotation.description || annotation.label, mark, encoding: { [annotation.axis]: constant(annotation.value) } }];
  }
  if (["text", "label"].includes(annotation.type)) {
    if (!isPlainObject(annotation.position) || !Object.hasOwn(annotation.position, "x") || !Object.hasOwn(annotation.position, "y")) throw new Error("text/label requires position.x and position.y");
    if (typeof annotation.text !== "string") throw new Error("text/label requires text");
    return [{
      id,
      description: annotation.description,
      mark: { type: "text", role: "annotation", anchor: annotation.anchor },
      encoding: { x: constant(annotation.position.x), y: constant(annotation.position.y), text: constant(annotation.text) }
    }];
  }
  if (annotation.type === "band") {
    if (!(["x", "y"].includes(annotation.axis))) throw new Error("band requires axis x or y");
    if (!Object.hasOwn(annotation, "from") || !Object.hasOwn(annotation, "to")) throw new Error("band requires from and to");
    const encoding = annotation.axis === "y"
      ? { x: constant(0), y: constant(annotation.from), y2: constant(annotation.to) }
      : { x: constant(annotation.from), x2: constant(annotation.to), y: constant(0) };
    return [{ id, description: annotation.description || annotation.label, mark: { type: "band", role: "annotation" }, encoding }];
  }
  return [];
}

function validateLayer(layer, path, collector, inheritedDataRef, dataIndex, scaleIds) {
  if (!isPlainObject(layer)) {
    collector.error(path, "expected_object", "expected a layer object");
    return;
  }
  findUnknownKeys(layer, LAYER_KEYS, path, collector);
  const dataRef = layer.data_ref ?? inheritedDataRef;
  if (layer.data_ref !== undefined && !dataIndex.has(layer.data_ref)) collector.error(`${path}/data_ref`, "unknown_data_reference", `unknown data source ${JSON.stringify(layer.data_ref)}`);
  validateTransforms(layer.transform, `${path}/transform`, collector, dataRef, dataIndex);
  if (!isPlainObject(layer.mark)) {
    collector.error(`${path}/mark`, "expected_object", "expected a mark object");
    return;
  }
  const markType = layer.mark.type;
  if (!MARKS.has(markType)) {
    collector.error(`${path}/mark/type`, "unknown_mark", `unsupported primitive mark ${JSON.stringify(markType)}`);
    return;
  }
  const allowedMarkKeys = new Set(["type", ...(PAYLOAD_V3_MARK_PROPERTIES[markType] || [])]);
  findUnknownKeys(layer.mark, allowedMarkKeys, `${path}/mark`, collector);
  if (markType === "line" && layer.mark.point_size !== undefined && layer.mark.point !== true) {
    collector.error(`${path}/mark/point_size`, "line_point_size_requires_point", "line point_size requires point=true");
  }
  if (!isPlainObject(layer.encoding)) {
    collector.error(`${path}/encoding`, "expected_object", "expected an encoding object");
    return;
  }
  const allowedChannels = ALLOWED_CHANNELS[markType];
  for (const channelName of Object.keys(layer.encoding)) {
    if (!allowedChannels.has(channelName)) collector.error(`${path}/encoding/${channelName}`, "unsupported_channel", `channel ${JSON.stringify(channelName)} is not supported by ${markType}`);
  }
  const alternatives = CHANNEL_REQUIREMENTS[markType];
  if (!alternatives.some((required) => required.every((name) => layer.encoding[name] !== undefined))) {
    collector.error(`${path}/encoding`, "missing_channels", `${markType} requires one of: ${alternatives.map((items) => items.join("+")).join(" or ")}`);
  }
  validateLayerChannelShape(layer, path, collector);
  for (const [channelName, binding] of Object.entries(layer.encoding)) {
    if (Array.isArray(binding)) {
      collector.error(`${path}/encoding/${channelName}`, "invalid_channel_array", "encoding channels must be single binding objects");
      binding.forEach((item, itemIndex) => validateChannel(item, `${path}/encoding/${channelName}/${itemIndex}`, collector, dataRef, dataIndex, scaleIds, channelName));
    } else validateChannel(binding, `${path}/encoding/${channelName}`, collector, dataRef, dataIndex, scaleIds, channelName);
  }
  rejectExecutableVisualKeys(layer.mark, `${path}/mark`, collector);
}

function validateLayerChannelShape(layer, path, collector) {
  const encoding = layer.encoding || {};
  const markType = layer.mark?.type;
  const has = (name) => isPlainObject(encoding[name]);
  if (markType === "rule") {
    const present = ["x", "x2", "y", "y2"].filter(has);
    const simple = present.length === 1 && ["x", "y"].includes(present[0]);
    const segment = present.length === 4;
    if (!simple && !segment) collector.error(`${path}/encoding`, "ambiguous_rule_channels", "rule requires exactly x, exactly y, or the complete x+y+x2+y2 segment");
  }
  if (["bar", "band"].includes(markType) && has("x2") && has("y2")) {
    collector.error(`${path}/encoding`, "ambiguous_interval_channels", `${markType} cannot declare x2 and y2 together`);
  }
  if (markType === "errorbar") {
    const vertical = has("y_lower") || has("y_upper");
    const horizontal = has("x_lower") || has("x_upper");
    if (vertical && horizontal) collector.error(`${path}/encoding`, "ambiguous_errorbar_channels", "errorbar cannot declare horizontal and vertical bounds together");
  }
  if (["bar", "band", "errorbar"].includes(markType) && layer.mark.orient) {
    const encodedHorizontal = markType === "errorbar" ? has("x_lower") && has("x_upper") : has("x2");
    const encodedVertical = markType === "errorbar" ? has("y_lower") && has("y_upper") : has("y2");
    if (encodedHorizontal && layer.mark.orient !== "horizontal") {
      collector.error(`${path}/mark/orient`, "orient_encoding_mismatch", `${markType} horizontal interval channels require orient=horizontal`);
    }
    if (encodedVertical && layer.mark.orient !== "vertical") {
      collector.error(`${path}/mark/orient`, "orient_encoding_mismatch", `${markType} vertical interval channels require orient=vertical`);
    }
  }
}

function validateChannel(binding, path, collector, inheritedDataRef, dataIndex, scaleIds, channelName) {
  if (!isPlainObject(binding)) {
    collector.error(path, "expected_object", "encoding channel must be an object");
    return;
  }
  findUnknownKeys(binding, CHANNEL_KEYS, path, collector);
  const hasField = Object.hasOwn(binding, "field");
  const hasValue = Object.hasOwn(binding, "value");
  let physicalType = null;
  if (hasField === hasValue) collector.error(path, "binding_shape", "channel requires exactly one of field or value");
  if (!CHANNEL_TYPES.has(binding.type)) collector.error(`${path}/type`, "unsupported_channel_type", `unsupported channel type ${JSON.stringify(binding.type)}`);
  const dataRef = inheritedDataRef;
  if (hasField) {
    if (typeof binding.field !== "string" || binding.field === "") collector.error(`${path}/field`, "expected_field", "field must be a non-empty string");
    if (typeof dataRef !== "string" || !dataIndex.has(dataRef)) collector.error(`${path}/data`, "missing_data_reference", `field binding requires a known data source; received ${JSON.stringify(dataRef)}`);
    else if (!dataIndex.get(dataRef).has(binding.field)) collector.error(`${path}/field`, "unknown_field", `field ${JSON.stringify(binding.field)} is not declared by data source ${JSON.stringify(dataRef)}`);
    else {
      const field = dataIndex.get(dataRef).get(binding.field);
      physicalType = field.type;
      validateChannelCompatibility(binding.type, field, `${path}/type`, collector);
    }
  }
  if (hasValue && !(binding.value === null || typeof binding.value === "string" || typeof binding.value === "boolean" || isFiniteNumber(binding.value))) {
    collector.error(`${path}/value`, "invalid_constant", "constant value must be null, string, boolean, or finite number");
  }
  if (hasValue) {
    if (isFiniteNumber(binding.value)) physicalType = "number";
    else if (typeof binding.value === "boolean") physicalType = "boolean";
    else if (typeof binding.value === "string") physicalType = binding.type === "temporal" ? "datetime" : "string";
    if (binding.value === null) collector.error(`${path}/value`, "null_constant", "constant channel values cannot be null");
    else if (physicalType) validateChannelCompatibility(binding.type, { type: physicalType }, `${path}/type`, collector);
    if (binding.type === "temporal" && !matchesPhysicalValue(binding.value, "datetime") && !matchesPhysicalValue(binding.value, "date")) {
      collector.error(`${path}/value`, "invalid_temporal_constant", "temporal constant must be an exact ISO date or timezone-qualified ISO datetime");
    }
  }
  if (binding.scale_id !== undefined && !scaleIds.has(binding.scale_id)) collector.error(`${path}/scale_id`, "unknown_scale_reference", `unknown scale ${JSON.stringify(binding.scale_id)}`);
  if (binding.scale_role !== undefined && !SCALE_ROLES.has(binding.scale_role)) collector.error(`${path}/scale_role`, "unsupported_scale_role", `unsupported scale role ${JSON.stringify(binding.scale_role)}`);
  if (binding.scale_role !== undefined && !["color", "stroke"].includes(channelName)) collector.error(`${path}/scale_role`, "scale_role_channel", `scale_role is rendered only for color and stroke channels, not ${JSON.stringify(channelName)}`);
  if (binding.legend !== undefined && !["color", "stroke"].includes(channelName)) collector.error(`${path}/legend`, "legend_channel", `legend is rendered only for color and stroke channels, not ${JSON.stringify(channelName)}`);
  if (binding.axis !== undefined && !POSITIONAL_CHANNELS.has(channelName)) collector.error(`${path}/axis`, "axis_channel", `axis is rendered only for positional channels, not ${JSON.stringify(channelName)}`);
  if (binding.axis !== undefined && binding.axis !== false && !isPlainObject(binding.axis)) collector.error(`${path}/axis`, "invalid_axis", "axis must be false or an object");
  if (binding.format !== undefined
      && !CHANNEL_FORMATS.has(binding.format)
      && !(typeof binding.format === "string" && /^\.(?:[0-9]|1[0-2])[f%]$/.test(binding.format))) {
    collector.error(`${path}/format`, "unsupported_format", `unsupported channel format ${JSON.stringify(binding.format)}`);
  }
  if (binding.format !== undefined && !["text", "tooltip"].includes(channelName)) {
    collector.error(`${path}/format`, "format_channel", `format is rendered only for text and tooltip channels; use axis.format for ${JSON.stringify(channelName)}`);
  }
  validateFormatCompatibility(binding.format, physicalType, `${path}/format`, collector);
  if (isPlainObject(binding.axis)) {
    validateFormatCompatibility(binding.axis.format, physicalType, `${path}/axis/format`, collector);
    const axisFormat = binding.axis.format;
    const temporalAxisFormat = ["date", "datetime"].includes(axisFormat);
    if (temporalAxisFormat && binding.type !== "temporal") collector.error(`${path}/axis/format`, "axis_format_channel_type", `${axisFormat} axis formatting requires a temporal channel`);
  }
}

function validateFormatCompatibility(format, physicalType, path, collector) {
  if (format === undefined || format === "auto" || format === "none" || !physicalType) return;
  const numericFormat = ["number", "integer", "percent", "scientific"].includes(format)
    || (typeof format === "string" && /^\.(?:[0-9]|1[0-2])[f%]$/.test(format));
  const temporalFormat = format === "date" || format === "datetime";
  const numericPhysical = physicalType === "number" || physicalType === "integer";
  const temporalPhysical = physicalType === "date" || physicalType === "datetime";
  if ((numericFormat && !numericPhysical) || (temporalFormat && !temporalPhysical)) {
    collector.error(path, "incompatible_format", `format ${JSON.stringify(format)} is incompatible with physical value type ${JSON.stringify(physicalType)}`);
  }
}

function validateChannelCompatibility(channelType, field, path, collector) {
  if (!CHANNEL_TYPES.has(channelType) || !field) return;
  const allowed = {
    number: new Set(["quantitative", "ordinal", "nominal"]),
    integer: new Set(["quantitative", "ordinal", "nominal"]),
    string: new Set(["nominal", "ordinal"]),
    boolean: new Set(["nominal", "ordinal"]),
    date: new Set(["temporal", "nominal", "ordinal"]),
    datetime: new Set(["temporal", "nominal", "ordinal"])
  }[field.type];
  if (allowed && !allowed.has(channelType)) collector.error(path, "incompatible_channel_type", `${channelType} is incompatible with physical field type ${field.type}`);
}

function validateTransforms(transforms, path, collector, dataRef, dataIndex) {
  if (transforms === undefined) return;
  const values = Array.isArray(transforms) ? transforms : [transforms];
  values.forEach((transform, index) => {
    const transformPath = Array.isArray(transforms) ? `${path}/${index}` : path;
    if (!isPlainObject(transform)) {
      collector.error(transformPath, "expected_object", "expected a transform object");
      return;
    }
    if (!TRANSFORM_OPS.has(transform.op)) collector.error(`${transformPath}/op`, "unsupported_transform", `unsupported transform ${JSON.stringify(transform.op)}`);
    const fields = [];
    if (typeof transform.field === "string") fields.push(transform.field);
    if (typeof transform.key === "string") fields.push(transform.key);
    if (Array.isArray(transform.fields)) fields.push(...transform.fields.filter((field) => typeof field === "string"));
    if (Array.isArray(transform.groupby)) fields.push(...transform.groupby.filter((field) => typeof field === "string"));
    if (fields.length && (!dataIndex.has(dataRef))) collector.error(transformPath, "missing_data_reference", "field transform requires a known data_ref");
    else for (const field of fields) if (!dataIndex.get(dataRef).has(field)) collector.error(`${transformPath}/field`, "unknown_field", `transform field ${JSON.stringify(field)} is not declared by ${JSON.stringify(dataRef)}`);
    if (transform.op === "filter") {
      if (typeof transform.field !== "string") collector.error(`${transformPath}/field`, "expected_field", "filter requires field");
      if (!isPlainObject(transform.predicate)) collector.error(`${transformPath}/predicate`, "expected_predicate", "filter requires a predicate object");
      else {
        const predicateKeys = Object.keys(transform.predicate);
        if (predicateKeys.length !== 1 || !["eq", "neq", "lt", "lte", "gt", "gte", "in", "not_in", "valid"].includes(predicateKeys[0])) {
          collector.error(`${transformPath}/predicate`, "unsupported_filter_predicate", "predicate requires exactly one of eq, neq, lt, lte, gt, gte, in, not_in, valid");
        }
      }
    }
    if (transform.op === "sample" && !["first", "stride", "hash"].includes(transform.method)) collector.error(`${transformPath}/method`, "nondeterministic_sample", "sample method must be first, stride, or hash");
    if (transform.op === "sample" && ["first", "hash"].includes(transform.method) && (!Number.isInteger(transform.size) || transform.size < 1)) {
      collector.error(`${transformPath}/size`, "sample_size_required", `${transform.method} sampling requires a positive integer size`);
    }
    if (transform.op === "sample" && transform.method === "hash" && (typeof transform.key !== "string" || transform.key.length === 0)) {
      collector.error(`${transformPath}/key`, "sample_key_required", "hash sampling requires a declared key field");
    }
    if (transform.op === "sample" && transform.method === "stride"
      && !((Number.isInteger(transform.size) && transform.size > 0) || (Number.isInteger(transform.step) && transform.step > 0))) {
      collector.error(transformPath, "sample_stride_bound", "stride sampling requires a positive integer size or step");
    }
    rejectExecutableVisualKeys(transform, transformPath, collector);
  });
}

function validateInteractionTargets(interactions, path, collector, panelIds, targetIndex, targetDataRefs, targetCoordinates, dataIndex) {
  if (!Array.isArray(interactions)) return;
  interactions.forEach((interaction, index) => {
    if (!isPlainObject(interaction)) return;
    const targets = interaction.targets ?? (interaction.target === undefined ? [] : [interaction.target]);
    if (!Array.isArray(targets)) {
      collector.error(`${path}/${index}/targets`, "expected_array", "targets must be an array");
      return;
    }
    const resolvedTargets = [];
    targets.forEach((target, targetIndexPosition) => {
      const targetPath = `${path}/${index}/targets/${targetIndexPosition}`;
      if (typeof target === "string") {
        if (!targetIndex.has(target) && !panelIds.has(target)) collector.error(targetPath, "unknown_interaction_target", `unknown panel/layer target ${JSON.stringify(target)}`);
        else resolvedTargets.push(target);
      } else if (isPlainObject(target)) {
        const canonical = target.layer_id ? `${target.panel_id}/${target.layer_id}` : target.panel_id;
        if (!targetIndex.has(canonical) && !panelIds.has(canonical)) collector.error(targetPath, "unknown_interaction_target", `unknown panel/layer target ${JSON.stringify(canonical)}`);
        else resolvedTargets.push(canonical);
      } else collector.error(targetPath, "invalid_interaction_target", "target must be a string or {panel_id, layer_id?}");
    });
    if (interaction.type === "linked_highlight" && new Set(resolvedTargets).size < 2) {
      collector.error(`${path}/${index}/targets`, "linked_highlight_distinct_targets", "linked_highlight requires at least two distinct canonical targets");
    }
    if (!CANVAS_INTERACTION_TYPES.has(interaction.type) && resolvedTargets.some((target) => targetCoordinates.get(target) === "canvas")) {
      collector.error(`${path}/${index}/type`, "canvas_interaction_unsupported", `${interaction.type} is not supported for canvas targets; use hover, tooltip, legend_filter, parameter, or linked_highlight`);
    }
    if (interaction.type === "tooltip" && interaction.mode === "pointer" && resolvedTargets.some((target) => targetCoordinates.get(target) === "canvas")) {
      collector.error(`${path}/${index}/mode`, "canvas_tooltip_mode", "canvas tooltip mode must be nearest; pointer mode is not implemented for canvas targets");
    }
    if (interaction.type === "zoom" && interaction.axes !== "both") collector.error(`${path}/${index}/axes`, "zoom_axes_unsupported", "zoom currently supports both axes only");
    validateInteractionFields(interaction, `${path}/${index}`, resolvedTargets, targetDataRefs, dataIndex, collector);
    validateParameterInteraction(interaction, `${path}/${index}`, collector);
  });
}

function validateInteractionFields(interaction, path, targets, targetDataRefs, dataIndex, collector) {
  const fields = [];
  if (["tooltip", "linked_highlight"].includes(interaction.type) && Array.isArray(interaction.fields)) {
    interaction.fields.forEach((field, index) => fields.push({ field, path: `${path}/fields/${index}` }));
  } else if (interaction.type === "legend_filter") fields.push({ field: interaction.field, path: `${path}/field` });
  else if (interaction.type === "parameter") fields.push({ field: interaction.parameter, path: `${path}/parameter` });
  if (fields.length === 0) return;
  for (const target of targets) {
    const references = targetDataRefs.get(target) || new Set();
    if (references.size === 0) {
      collector.error(path, "interaction_target_data", `interaction target ${JSON.stringify(target)} has no effective data_ref`);
      continue;
    }
    for (const reference of references) {
      const fieldIndex = dataIndex.get(reference);
      for (const binding of fields) {
        if (typeof binding.field === "string" && fieldIndex && !fieldIndex.has(binding.field)) {
          collector.error(binding.path, "interaction_unknown_field", `field ${JSON.stringify(binding.field)} is not declared by ${JSON.stringify(reference)} for target ${JSON.stringify(target)}`);
        } else if (interaction.type === "parameter" && typeof binding.field === "string" && fieldIndex?.has(binding.field)) {
          validateParameterFieldType(interaction, fieldIndex.get(binding.field), path, target, collector);
        }
      }
    }
  }
  if (interaction.type === "linked_highlight") {
    for (const binding of fields) {
      const physicalTypes = new Set();
      for (const target of targets) {
        for (const reference of targetDataRefs.get(target) || []) {
          const declaration = dataIndex.get(reference)?.get(binding.field);
          if (declaration?.type) physicalTypes.add(declaration.type);
        }
      }
      if (physicalTypes.size > 1) {
        collector.error(binding.path, "interaction_field_type_mismatch", `linked field ${JSON.stringify(binding.field)} must have one physical type across every target; received ${[...physicalTypes].sort().join(", ")}`);
      }
    }
  }
}

function validateParameterFieldType(interaction, field, path, target, collector) {
  if (interaction.control === "range") {
    if (!["number", "integer"].includes(field.type)) {
      collector.error(`${path}/parameter`, "parameter_field_type", `range parameter target ${JSON.stringify(target)} field ${JSON.stringify(field.name)} must be numeric, not ${field.type}`);
      return;
    }
    for (const key of ["minimum", "maximum", "default"]) {
      if (interaction[key] !== undefined && !matchesPhysicalValue(interaction[key], field.type)) collector.error(`${path}/${key}`, "parameter_value_type", `${key} must match ${field.type} field ${JSON.stringify(field.name)}`);
    }
    if (field.type === "integer" && interaction.step !== undefined && !Number.isInteger(interaction.step)) collector.error(`${path}/step`, "parameter_value_type", `step must be an integer for field ${JSON.stringify(field.name)}`);
  } else if (interaction.control === "select") {
    if (interaction.default !== undefined && !matchesPhysicalValue(interaction.default, field.type)) collector.error(`${path}/default`, "parameter_value_type", `default must match ${field.type} field ${JSON.stringify(field.name)}`);
    if (Array.isArray(interaction.options)) interaction.options.forEach((option, index) => {
      if (!matchesPhysicalValue(option, field.type)) collector.error(`${path}/options/${index}`, "parameter_value_type", `option must match ${field.type} field ${JSON.stringify(field.name)}`);
    });
  }
}

function validateParameterInteraction(interaction, path, collector) {
  if (interaction.type !== "parameter") return;
  if (interaction.control === "range") {
    for (const key of ["minimum", "maximum", "step", "default"]) {
      if (!isFiniteNumber(interaction[key])) collector.error(`${path}/${key}`, "parameter_range_number", `range parameter ${key} must be a finite number`);
    }
    if (isFiniteNumber(interaction.minimum) && isFiniteNumber(interaction.maximum) && interaction.minimum >= interaction.maximum) {
      collector.error(`${path}/maximum`, "parameter_range_order", "range parameter maximum must be greater than minimum");
    }
    if (isFiniteNumber(interaction.step) && interaction.step <= 0) collector.error(`${path}/step`, "parameter_range_step", "range parameter step must be greater than zero");
    if (isFiniteNumber(interaction.default) && isFiniteNumber(interaction.minimum) && isFiniteNumber(interaction.maximum)
      && (interaction.default < interaction.minimum || interaction.default > interaction.maximum)) {
      collector.error(`${path}/default`, "parameter_default_range", "range parameter default must be within minimum and maximum");
    }
  } else if (interaction.control === "select") {
    if (!Array.isArray(interaction.options) || interaction.options.length === 0) collector.error(`${path}/options`, "parameter_select_options", "select parameter requires non-empty options");
    else if (!interaction.options.some((option) => Object.is(option, interaction.default))) collector.error(`${path}/default`, "parameter_default_option", "select parameter default must be one of options");
  }
}

function rejectExecutableVisualKeys(value, path, collector) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectExecutableVisualKeys(item, `${path}/${index}`, collector));
    return;
  }
  if (!isPlainObject(value)) return;
  const blocked = /^(?:callback|code|expr|expression|function|html|href|javascript|script|src|url)$/i;
  for (const [key, child] of Object.entries(value)) {
    const childPath = joinPointer(path, key);
    if (blocked.test(key)) collector.error(childPath, "executable_visual_property", `visual specification cannot contain ${JSON.stringify(key)}`);
    else rejectExecutableVisualKeys(child, childPath, collector);
  }
}

function buildManifest(payload, expandedFigures) {
  const figures = Array.isArray(payload.figures) ? payload.figures : [];
  const panels = [...expandedFigures.values()].flat();
  const layers = panels.flatMap((panel) => [
    ...(panel?.layers || []),
    ...(panel?.annotations || []).flatMap(annotationToLayers)
  ]);
  const recipeCounts = {};
  const markCounts = {};
  for (const figure of figures) recipeCounts[figure?.recipe] = (recipeCounts[figure?.recipe] || 0) + 1;
  for (const layer of layers) {
    const mark = layer?.mark?.type;
    if (typeof mark === "string") markCounts[mark] = (markCounts[mark] || 0) + 1;
  }
  return stableClone({
    schema_version: payload.schema_version,
    data_source_count: Array.isArray(payload.data) ? payload.data.length : 0,
    sidecar_count: (Array.isArray(payload.data) ? payload.data : []).filter((source) => source?.storage?.kind === "sidecar").length,
    section_count: Array.isArray(payload.sections) ? payload.sections.length : 0,
    figure_count: figures.length,
    interaction_count: figures.reduce((count, figure) => count + (Array.isArray(figure?.interactions) ? figure.interactions.length : 0), 0),
    interactive_figure_count: figures.filter((figure) => Array.isArray(figure?.interactions) && figure.interactions.length > 0).length,
    panel_count: panels.length,
    layer_count: layers.length,
    recipes: recipeCounts,
    marks: markCounts
  });
}

/** Expand recipes and return a deterministic, renderer-facing intermediate representation. */
export function normalizePayloadV3(payload, { registry = defaultRecipeRegistry, validation = null } = {}) {
  const result = validation || validatePayloadV3(payload, { registry });
  if (!result.valid) {
    throw new PayloadV3Error(`Payload v3 validation failed:\n${formatDiagnostics(result.errors)}`, result.errors);
  }
  const figures = payload.figures.map((figure, index) => {
    const panels = registry.expand(figure, { path: `/figures/${index}` }).map(normalizePanel);
    return stableClone({
      id: figure.id,
      title: figure.title,
      caption: figure.caption,
      description: figure.description,
      recipe: figure.recipe,
      layout: normalizeLayout(figure.layout, figure, panels),
      scales: figure.scales || [],
      panels,
      interactions: figure.interactions || []
    });
  });
  return stableClone({
    ir_version: PAYLOAD_V3_IR_VERSION,
    schema_version: PAYLOAD_V3_SCHEMA_VERSION,
    source_schema_version: payload.schema_version,
    renderer_contract: payload.renderer_contract,
    report: payload.report,
    run: payload.run,
    dataset: payload.dataset,
    provenance: payload.provenance,
    theme: payload.theme,
    presentation: payload.presentation || {},
    data: payload.data.map(normalizeDataSource),
    sections: payload.sections.map((section) => ({ ...section, figure_refs: [...section.figure_ids] })),
    acts: payload.acts || [],
    figures,
    manifest: result.manifest
  });
}

function normalizeDataSource(source) {
  const storage = stableClone(source.storage);
  if (storage.kind === "sidecar") {
    storage.sha256 = storage.sha256.toLowerCase().replace(/^sha256:/, "");
    storage.compression ??= "none";
  } else if (storage.rows !== undefined) storage.format ??= "records";
  else storage.format ??= "columns";
  return stableClone({ ...source, fields: source.fields, storage });
}

function normalizePanel(panel) {
  const coordinateType = coordinateTypeOf(panel.coordinate);
  const coordinate = typeof panel.coordinate === "string" ? { type: panel.coordinate } : (panel.coordinate || { type: "cartesian" });
  const annotationLayers = (panel.annotations || []).flatMap(annotationToLayers).map((layer) => ({
    ...layer,
    data_ref: undefined,
    transform: []
  }));
  return stableClone({
    id: panel.id,
    title: panel.title,
    subtitle: panel.subtitle,
    description: panel.description,
    type: panel.type ?? inferPanelType(coordinateType),
    position: panel.position,
    display: panel.display,
    data_ref: panel.data_ref,
    coordinate,
    transform: panel.transform === undefined ? [] : (Array.isArray(panel.transform) ? panel.transform : [panel.transform]),
    layers: [...panel.layers.map((layer) => ({
      id: layer.id,
      description: layer.description,
      data_ref: layer.data_ref,
      transform: layer.transform === undefined ? [] : (Array.isArray(layer.transform) ? layer.transform : [layer.transform]),
      mark: layer.mark,
      encoding: layer.encoding
    })), ...annotationLayers],
    annotations: []
  });
}

function normalizeLayout(layout, figure, panels) {
  const defaults = { type: "grid", columns: 1, gap: 16 };
  if (figure.recipe === "pca.diagnostics@1") defaults.columns = 3;
  else if (figure.recipe === "embedding.small-multiples@1") defaults.columns = figure.recipe_config?.params?.columns || Math.min(3, panels.length);
  else if (figure.recipe === "model.validation@1") defaults.columns = 2;
  return stableClone({ ...defaults, ...(layout || {}) });
}

/**
 * Verify and materialize declared sidecars in one filesystem read. Symlink
 * escapes, integrity failures and declared-field mismatches fail closed.
 */
export async function verifyPayloadV3Sidecars(payload, {
  baseDirectory,
  validation = null,
  registry = defaultRecipeRegistry
} = {}) {
  const result = validation || validatePayloadV3(payload, { registry });
  if (!result.valid) throw new PayloadV3Error(`Payload v3 validation failed:\n${formatDiagnostics(result.errors)}`, result.errors);
  if (typeof baseDirectory !== "string" || baseDirectory === "") throw new TypeError("verifyPayloadV3Sidecars requires baseDirectory");

  const base = await realpath(resolve(baseDirectory));
  const verified = [];
  for (let sourceIndex = 0; sourceIndex < payload.data.length; sourceIndex += 1) {
    const source = payload.data[sourceIndex];
    if (source.storage.kind !== "sidecar") continue;
    const storagePath = `/data/${sourceIndex}/storage`;
    const declaredPath = source.storage.path;
    const resolvedPath = resolve(base, declaredPath);
    let canonical;
    try {
      canonical = await realpath(resolvedPath);
    } catch (error) {
      throw new PayloadV3Error(`Sidecar for ${source.id} cannot be opened: ${declaredPath}`, [
        { path: `${storagePath}/path`, code: "sidecar_unavailable", message: error.message }
      ], { cause: error });
    }
    const fromBase = relative(base, canonical);
    if (fromBase === "" || fromBase.startsWith("..") || isAbsolute(fromBase)) {
      throw new PayloadV3Error(`Sidecar for ${source.id} escapes the payload directory`, [
        { path: `${storagePath}/path`, code: "sidecar_escape", message: `${declaredPath} resolves outside ${base}` }
      ]);
    }
    const fileStat = await stat(canonical);
    if (!fileStat.isFile()) {
      throw new PayloadV3Error(`Sidecar for ${source.id} is not a regular file`, [
        { path: `${storagePath}/path`, code: "sidecar_not_file", message: declaredPath }
      ]);
    }
    const raw = await readFile(canonical);
    const actualHash = createHash("sha256").update(raw).digest("hex");
    const declaredHash = source.storage.sha256.toLowerCase().replace(/^sha256:/, "");
    if (actualHash !== declaredHash) {
      throw new PayloadV3Error(`SHA-256 mismatch for sidecar ${source.id}`, [
        { path: `${storagePath}/sha256`, code: "sidecar_hash_mismatch", message: `expected ${declaredHash}; received ${actualHash}` }
      ]);
    }
    if (source.storage.bytes !== undefined && source.storage.bytes !== raw.byteLength) {
      throw new PayloadV3Error(`Byte count mismatch for sidecar ${source.id}`, [
        { path: `${storagePath}/bytes`, code: "sidecar_byte_mismatch", message: `expected ${source.storage.bytes}; received ${raw.byteLength}` }
      ]);
    }
    const materialized = await parseSidecarBytes(source, raw, storagePath);
    verified.push(stableClone({
      id: source.id,
      path: declaredPath,
      sha256: actualHash,
      bytes: raw.byteLength,
      row_count: materialized.row_count,
      inline: materialized.inline
    }));
  }
  if (verified.length > 0) {
    const materializedPayload = stableClone(payload);
    const inlineById = new Map(verified.map((entry) => [entry.id, entry.inline]));
    for (const source of materializedPayload.data) {
      const inline = inlineById.get(source.id);
      if (inline) source.storage = inline;
    }
    const materializedValidation = validatePayloadV3(materializedPayload, { registry });
    if (!materializedValidation.valid) {
      throw new PayloadV3Error(`Materialized Payload v3 validation failed:\n${formatDiagnostics(materializedValidation.errors)}`, materializedValidation.errors);
    }
  }
  return verified;
}

/** Load, validate, normalize and (by default) verify a Payload v3 package entrypoint. */
export async function loadPayloadV3(inputPath, {
  registry = defaultRecipeRegistry,
  verifySidecars = true
} = {}) {
  const absoluteInput = resolve(inputPath);
  const raw = await readFile(absoluteInput, "utf8");
  const payload = parsePayloadV3(raw, { sourceName: absoluteInput });
  const validation = validatePayloadV3(payload, { registry });
  if (!validation.valid) throw new PayloadV3Error(`Payload v3 validation failed:\n${formatDiagnostics(validation.errors)}`, validation.errors);
  const sidecars = verifySidecars
    ? await verifyPayloadV3Sidecars(payload, { baseDirectory: dirname(absoluteInput), validation, registry })
    : [];
  const ir = normalizePayloadV3(payload, { registry, validation });
  const sidecarsById = new Map(sidecars.map((entry) => [entry.id, entry]));
  for (const source of ir.data) {
    const materialized = sidecarsById.get(source.id);
    if (materialized) source.storage = materialized.inline;
  }
  const rendererDiagnostics = validateRendererDataDomainsV3(ir);
  if (rendererDiagnostics.length) {
    throw new PayloadV3Error(`Renderer data preflight failed:\n${formatDiagnostics(rendererDiagnostics)}`, rendererDiagnostics);
  }
  return {
    source_path: absoluteInput,
    payload_sha256: createHash("sha256").update(stableStringify(payload)).digest("hex"),
    payload,
    ir,
    manifest: validation.manifest,
    warnings: validation.warnings,
    sidecars
  };
}

export { PayloadV3Error, formatDiagnostics, stableStringify } from "./v3-common.mjs";
export {
  PAYLOAD_V3_SCHEMA,
  PAYLOAD_V3_SCHEMA_PATH,
  validateJsonSchema,
  validatePayloadV3Schema
} from "./v3-json-schema.mjs";
export {
  RecipeExpansionError,
  RecipeRegistry,
  SUPPORTED_PANEL_TYPES,
  SUPPORTED_PRIMITIVE_MARKS,
  createDefaultRecipeRegistry,
  defaultRecipeRegistry
} from "./v3-recipes.mjs";
export {
  PAYLOAD_V3_CAPABILITIES,
  getPayloadV3Capabilities
};
