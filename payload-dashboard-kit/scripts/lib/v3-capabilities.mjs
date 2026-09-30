import {
  SUPPORTED_PANEL_TYPES,
  SUPPORTED_PRIMITIVE_MARKS,
  defaultRecipeRegistry
} from "./v3-recipes.mjs";

export const PAYLOAD_V3_CHANNEL_TYPES = Object.freeze(["quantitative", "nominal", "ordinal", "temporal"]);
export const PAYLOAD_V3_COORDINATE_TYPES = Object.freeze(["cartesian", "matrix", "tree", "flow", "canvas"]);
export const PAYLOAD_V3_TRANSFORM_OPS = Object.freeze(["filter", "sort", "sample"]);
export const PAYLOAD_V3_INTERACTION_TYPES = Object.freeze(["hover", "tooltip", "legend_filter", "parameter", "linked_highlight", "zoom"]);
export const PAYLOAD_V3_CANVAS_INTERACTION_TYPES = Object.freeze(["hover", "tooltip", "legend_filter", "parameter", "linked_highlight"]);
export const PAYLOAD_V3_SIDECAR_FORMATS = Object.freeze(["json", "jsonl"]);
export const PAYLOAD_V3_SIDECAR_COMPRESSIONS = Object.freeze(["none", "gzip"]);
export const PAYLOAD_V3_FIELD_TYPES = Object.freeze(["number", "integer", "string", "boolean", "date", "datetime"]);
export const PAYLOAD_V3_SCALE_TYPES = Object.freeze(["linear", "log", "sqrt", "symlog", "band", "point", "ordinal", "time", "utc"]);
export const PAYLOAD_V3_CHANNEL_FORMATS = Object.freeze(["auto", "number", "integer", "percent", "scientific", "date", "datetime", "none"]);

const PRESENTATION_LABEL_KEYS = Object.freeze([
  "fold_all",
  "unfold_all",
  "report_claim",
  "coverage",
  "concepts_used",
  "reports",
  "minimises",
  "uses",
  "produces",
  "note",
  "top",
  "javascript_required",
  "standalone_package",
  "schema",
  "figures",
  "seed",
  "payload_sha256",
  "renderer",
  "reset",
  "status_pass",
  "status_warn",
  "status_fail",
  "status_not_applicable"
]);

const THEME_TOKEN_KEYS = Object.freeze([
  "accent",
  "accent_contrast",
  "background",
  "surface",
  "surface_muted",
  "text",
  "muted_text",
  "border",
  "radius",
  "max_width"
]);

export const PAYLOAD_V3_MARK_CHANNEL_REQUIREMENTS = deepFreeze({
  bar: [["x", "y"]],
  line: [["x", "y"]],
  point: [["x", "y"]],
  band: [["x", "y", "y2"], ["x", "x2", "y"]],
  rule: [["x"], ["y"]],
  rect: [["x", "y", "color"]],
  text: [["x", "y", "text"]],
  vector: [["x", "y", "x2", "y2"]],
  node: [["key"]],
  link: [["from", "to"]],
  errorbar: [["x", "y_lower", "y_upper"], ["x_lower", "x_upper", "y"]],
  boxplot: [["x", "q1", "q3", "median", "whisker_low", "whisker_high"]],
  ellipse: [["x", "y", "x_radius", "y_radius"]],
  polygon: [["x", "y", "group"]]
});

export const PAYLOAD_V3_MARK_CHANNELS = deepFreeze({
  bar: ["x", "x2", "y", "y2", "color", "group", "text", "tooltip"],
  line: ["x", "y", "color", "stroke", "group", "tooltip"],
  point: ["x", "y", "color", "group", "tooltip"],
  band: ["x", "x2", "y", "y2", "color", "group", "tooltip"],
  rule: ["x", "x2", "y", "y2", "color", "stroke", "tooltip"],
  rect: ["x", "y", "color", "text", "tooltip"],
  text: ["x", "y", "text", "color", "tooltip"],
  vector: ["x", "y", "x2", "y2", "color", "stroke", "tooltip"],
  node: ["key", "text", "color", "tooltip"],
  link: ["from", "to", "text", "color", "tooltip"],
  errorbar: ["x", "x_lower", "x_upper", "y", "y_lower", "y_upper", "color", "group", "tooltip"],
  boxplot: ["x", "q1", "q3", "median", "whisker_low", "whisker_high", "color", "group", "tooltip"],
  ellipse: ["x", "y", "x_radius", "y_radius", "color", "group", "tooltip"],
  polygon: ["x", "y", "group", "color", "tooltip"]
});

// Mark properties are deliberately mark-specific.  The JSON Schema keeps one
// compact mark object shape, while semantic validation uses this registry to
// reject properties that the selected renderer would otherwise ignore.
export const PAYLOAD_V3_MARK_PROPERTIES = deepFreeze({
  bar: ["role", "orient", "opacity"],
  line: ["role", "opacity", "stroke_width", "point", "point_size"],
  point: ["role", "opacity", "point_size"],
  band: ["role", "orient", "opacity"],
  rule: ["role", "stroke_width"],
  rect: ["role"],
  text: ["role", "dx", "dy"],
  vector: ["role", "stroke_width"],
  node: ["role", "opacity"],
  link: ["role", "opacity", "stroke_width"],
  errorbar: ["role", "orient", "stroke_width"],
  boxplot: ["role", "opacity"],
  ellipse: ["role", "opacity", "stroke_width"],
  polygon: ["role", "opacity", "stroke_width"]
});

export const PAYLOAD_V3_COORDINATE_MARKS = deepFreeze({
  cartesian: ["bar", "line", "point", "band", "rule", "vector", "text", "errorbar", "boxplot", "ellipse", "polygon"],
  matrix: ["rect", "text"],
  tree: ["node", "link"],
  flow: ["node"],
  canvas: ["point"]
});

const channelNames = [...new Set(Object.values(PAYLOAD_V3_MARK_CHANNELS).flat())].sort();
const markCapabilities = Object.fromEntries(SUPPORTED_PRIMITIVE_MARKS.map((mark) => [mark, {
  properties: PAYLOAD_V3_MARK_PROPERTIES[mark],
  channels: PAYLOAD_V3_MARK_CHANNELS[mark],
  required_channel_sets: PAYLOAD_V3_MARK_CHANNEL_REQUIREMENTS[mark]
}]));
const coordinateCapabilities = Object.fromEntries(PAYLOAD_V3_COORDINATE_TYPES.map((coordinate) => [coordinate, {
  marks: PAYLOAD_V3_COORDINATE_MARKS[coordinate],
  options: coordinate === "cartesian" ? ["equal_aspect"] : []
}]));

/**
 * JSON-serializable producer-facing description of the renderer's closed v3
 * surface. The semantic validator imports the same declarations, so a producer
 * cannot be told about a channel, coordinate, or operation that validation will
 * later reject.
 */
export const PAYLOAD_V3_CAPABILITIES = deepFreeze({
  schema_version: "3.0.0",
  renderer_contract: {
    name: "render-payload-dashboard",
    version: "3.0.0",
    strict: true
  },
  presentation: {
    presets: ["generic", "tess"],
    modes: ["light", "dark"],
    palettes: ["scientific", "colorblind-safe"],
    density: ["compact", "comfortable"],
    locales: "BCP 47 language tags",
    options: [
      "locale",
      "section_prefix",
      "show_section_numbers",
      "show_figure_titles",
      "show_figure_descriptions",
      "show_coverage",
      "show_build_footer",
      "labels"
    ],
    label_keys: PRESENTATION_LABEL_KEYS,
    theme_token_keys: THEME_TOKEN_KEYS
  },
  marks: markCapabilities,
  channels: {
    names: channelNames,
    types: PAYLOAD_V3_CHANNEL_TYPES,
    formats: {
      named: PAYLOAD_V3_CHANNEL_FORMATS,
      patterns: ["^\\.(?:[0-9]|1[0-2])[f%]$"]
    }
  },
  coordinates: coordinateCapabilities,
  panel_types: SUPPORTED_PANEL_TYPES,
  transforms: {
    operations: PAYLOAD_V3_TRANSFORM_OPS,
    filter_predicates: ["eq", "neq", "lt", "lte", "gt", "gte", "in", "not_in", "valid"],
    sample_methods: ["first", "stride", "hash"]
  },
  interactions: {
    types: PAYLOAD_V3_INTERACTION_TYPES,
    canvas_types: PAYLOAD_V3_CANVAS_INTERACTION_TYPES
  },
  recipes: defaultRecipeRegistry.list(),
  storage: {
    kinds: ["inline", "sidecar"],
    inline_formats: ["rows", "columns", "values"],
    formats: PAYLOAD_V3_SIDECAR_FORMATS,
    compressions: PAYLOAD_V3_SIDECAR_COMPRESSIONS,
    integrity: ["sha256", "bytes", "rows"]
  },
  field_types: PAYLOAD_V3_FIELD_TYPES,
  visual_types: PAYLOAD_V3_CHANNEL_TYPES,
  scale_types: PAYLOAD_V3_SCALE_TYPES,
  constraints: {
    payload_is_data_not_code: true,
    unknown_capabilities_fail_closed: true,
    figure_panel_layer_intent_is_explicit: true,
    sidecar_paths_are_payload_relative: true,
    output_is_one_offline_html: true
  }
});

/** Return a mutable JSON value suitable for writing as capabilities-v3.json. */
export function getPayloadV3Capabilities() {
  return JSON.parse(JSON.stringify(PAYLOAD_V3_CAPABILITIES));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
