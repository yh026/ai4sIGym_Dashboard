import { isPlainObject, stableClone } from "./v3-common.mjs";

export const SUPPORTED_PRIMITIVE_MARKS = Object.freeze([
  "bar",
  "line",
  "point",
  "band",
  "rule",
  "rect",
  "text",
  "vector",
  "node",
  "link",
  "errorbar",
  "boxplot",
  "ellipse",
  "polygon"
]);

export const SUPPORTED_PANEL_TYPES = Object.freeze(["plot", "matrix", "tree", "diagram"]);

export class RecipeExpansionError extends Error {
  constructor(recipe, path, message, options = {}) {
    super(`${recipe} at ${path}: ${message}`, options);
    this.name = "RecipeExpansionError";
    this.recipe = recipe;
    this.path = path;
  }
}

/**
 * A closed, versioned recipe registry. Recipes only expand declarative JSON into
 * panels/layers; they never execute expressions supplied by a payload.
 */
export class RecipeRegistry {
  #recipes = new Map();

  register(name, definition) {
    if (!/^[a-z][a-z0-9.-]*@[1-9]\d*$/.test(name)) throw new TypeError(`Invalid versioned recipe name: ${name}`);
    if (this.#recipes.has(name)) throw new TypeError(`Recipe already registered: ${name}`);
    if (!isPlainObject(definition) || typeof definition.expand !== "function") throw new TypeError(`Recipe ${name} requires an expand function`);
    this.#recipes.set(name, Object.freeze({ ...definition, name }));
    return this;
  }

  has(name) {
    return this.#recipes.has(name);
  }

  get(name) {
    return this.#recipes.get(name) || null;
  }

  list() {
    return [...this.#recipes.keys()].sort();
  }

  expand(figure, context = {}) {
    const definition = this.#recipes.get(figure?.recipe);
    if (!definition) throw new RecipeExpansionError(String(figure?.recipe), context.path || "/figures", "unknown recipe");
    const expanded = definition.expand(stableClone(figure), context);
    if (!Array.isArray(expanded) || expanded.length === 0) {
      throw new RecipeExpansionError(figure.recipe, context.path || "/figures", "recipe produced no panels");
    }
    return stableClone(expanded);
  }
}

function requireObject(value, recipe, path, label) {
  if (!isPlainObject(value)) throw new RecipeExpansionError(recipe, path, `${label} must be an object`);
  return value;
}

function requireString(value, recipe, path, label) {
  if (typeof value !== "string" || value.trim() === "") throw new RecipeExpansionError(recipe, path, `${label} must be a non-empty string`);
  return value;
}

function recipeConfig(figure, path) {
  const config = requireObject(figure.recipe_config, figure.recipe, `${path}/recipe_config`, "recipe_config");
  const bindings = requireObject(config.bindings, figure.recipe, `${path}/recipe_config/bindings`, "bindings");
  const params = config.params === undefined ? {} : requireObject(config.params, figure.recipe, `${path}/recipe_config/params`, "params");
  return { bindings, params };
}

function bindingGroup(figure, bindings, name, requiredFields, path) {
  const groupPath = `${path}/recipe_config/bindings/${name}`;
  const group = requireObject(bindings[name], figure.recipe, groupPath, `${name} binding`);
  requireString(group.data, figure.recipe, `${groupPath}/data`, `${name}.data`);
  for (const field of requiredFields) requireString(group[field], figure.recipe, `${groupPath}/${field}`, `${name}.${field}`);
  return group;
}

function channel(field, type, extras = {}) {
  return { field, type, ...extras };
}

function layer(id, type, encoding, options = {}) {
  return { id, mark: { type, ...options }, encoding };
}

function panel({ id, title, type = "plot", dataRef, coordinate = "cartesian", transform = [], layers }) {
  return {
    id,
    title,
    type,
    data_ref: dataRef,
    coordinate: { type: coordinate },
    transform,
    layers
  };
}

function explicitOr(figure, build, path) {
  if (Array.isArray(figure.panels) && figure.panels.length > 0) return figure.panels;
  return build(recipeConfig(figure, path));
}

function expandGeneric(figure, { path = "/figures" } = {}) {
  if (!Array.isArray(figure.panels) || figure.panels.length === 0) {
    throw new RecipeExpansionError(figure.recipe, `${path}/panels`, "generic.figure@1 requires at least one explicit panel");
  }
  return figure.panels;
}

function expandPca(figure, { path = "/figures" } = {}) {
  return explicitOr(figure, ({ bindings, params }) => {
    const scree = bindingGroup(figure, bindings, "scree", ["component", "variance", "cumulative"], path);
    const loadings = bindingGroup(figure, bindings, "loadings", ["component", "feature", "value"], path);
    const circle = bindingGroup(figure, bindings, "circle", ["x", "y", "label"], path);
    const residuals = bindingGroup(figure, bindings, "residuals", ["component", "row", "column", "value"], path);
    const selected = Number.isInteger(params.selected_components) && params.selected_components > 0 ? params.selected_components : 2;
    const threshold = typeof params.variance_threshold === "number" && Number.isFinite(params.variance_threshold) ? params.variance_threshold : 0.9;
    const residualComponents = Array.isArray(params.residual_components) && params.residual_components.length
      ? params.residual_components
      : [selected];

    const panels = [
      panel({
        id: "scree",
        title: "Explained variance",
        dataRef: scree.data,
        layers: [
          layer("variance-bars", "bar", { x: channel(scree.component, "ordinal"), y: channel(scree.variance, "quantitative") }),
          layer("cumulative-line", "line", { x: channel(scree.component, "ordinal"), y: channel(scree.cumulative, "quantitative") }, { point: true, point_size: 2.6 }),
          layer("variance-threshold", "rule", { y: { value: threshold, type: "quantitative" } }, { role: "threshold" }),
          layer("selected-components", "rule", { x: { value: selected, type: "ordinal" } }, { role: "selection" })
        ]
      }),
      panel({
        id: "loadings",
        title: "PCA loadings",
        type: "matrix",
        coordinate: "matrix",
        dataRef: loadings.data,
        layers: [layer("loading-cells", "rect", {
          x: channel(loadings.component, "ordinal"),
          y: channel(loadings.feature, "nominal"),
          color: channel(loadings.value, "quantitative", { scale_role: "diverging" })
        })]
      }),
      panel({
        id: "correlation-circle",
        title: "Correlation circle",
        dataRef: circle.data,
        layers: [
          layer("loading-vectors", "vector", {
            x: { value: 0, type: "quantitative" },
            y: { value: 0, type: "quantitative" },
            x2: channel(circle.x, "quantitative"),
            y2: channel(circle.y, "quantitative")
          }),
          layer("loading-labels", "text", {
            x: channel(circle.x, "quantitative"),
            y: channel(circle.y, "quantitative"),
            text: channel(circle.label, "nominal")
          })
        ]
      })
    ];

    residualComponents.forEach((component, index) => {
      if (!Number.isInteger(component) || component <= 0) {
        throw new RecipeExpansionError(figure.recipe, `${path}/recipe_config/params/residual_components/${index}`, "expected a positive integer");
      }
      panels.push(panel({
        id: `covariance-residual-l${component}`,
        title: `Covariance residual · L=${component}`,
        type: "matrix",
        coordinate: "matrix",
        dataRef: residuals.data,
        transform: [{ op: "filter", field: residuals.component, predicate: { eq: component } }],
        layers: [layer("residual-cells", "rect", {
          x: channel(residuals.column, "nominal"),
          y: channel(residuals.row, "nominal"),
          color: channel(residuals.value, "quantitative", { scale_role: "diverging" })
        })]
      }));
    });
    return panels;
  }, path);
}

function expandEmbeddingSmallMultiples(figure, { path = "/figures" } = {}) {
  return explicitOr(figure, ({ bindings, params }) => {
    const points = bindingGroup(figure, bindings, "points", ["x", "y", "facet"], path);
    const variants = params.variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new RecipeExpansionError(figure.recipe, `${path}/recipe_config/params/variants`, "expected a non-empty variants array");
    }
    return variants.map((variant, index) => {
      const variantPath = `${path}/recipe_config/params/variants/${index}`;
      const item = requireObject(variant, figure.recipe, variantPath, "variant");
      const id = requireString(item.id, figure.recipe, `${variantPath}/id`, "variant.id");
      const label = requireString(item.label, figure.recipe, `${variantPath}/label`, "variant.label");
      if (!(typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean")) {
        throw new RecipeExpansionError(figure.recipe, `${variantPath}/value`, "variant.value must be a string, number, or boolean");
      }
      const encoding = {
        x: channel(points.x, "quantitative"),
        y: channel(points.y, "quantitative")
      };
      if (typeof points.color === "string" && points.color) encoding.color = channel(points.color, "nominal", { scale_role: "semantic" });
      if (typeof points.tooltip === "string" && points.tooltip) encoding.tooltip = channel(points.tooltip, "nominal");
      return panel({
        id,
        title: label,
        dataRef: points.data,
        transform: [{ op: "filter", field: points.facet, predicate: { eq: item.value } }],
        layers: [layer("points", "point", encoding)]
      });
    });
  }, path);
}

function expandModelValidation(figure, { path = "/figures" } = {}) {
  return explicitOr(figure, ({ bindings }) => {
    const roc = bindingGroup(figure, bindings, "roc", ["fpr", "tpr"], path);
    const confusion = bindingGroup(figure, bindings, "confusion", ["actual", "predicted", "value"], path);
    const calibration = bindingGroup(figure, bindings, "calibration", ["predicted", "observed"], path);
    const learning = bindingGroup(figure, bindings, "learning_curve", ["size", "score"], path);

    const rocEncoding = { x: channel(roc.fpr, "quantitative"), y: channel(roc.tpr, "quantitative") };
    if (roc.series) rocEncoding.color = channel(roc.series, "nominal", { scale_role: "semantic" });
    const calibrationEncoding = { x: channel(calibration.predicted, "quantitative"), y: channel(calibration.observed, "quantitative") };
    if (calibration.series) calibrationEncoding.color = channel(calibration.series, "nominal", { scale_role: "semantic" });
    const learningEncoding = { x: channel(learning.size, "quantitative"), y: channel(learning.score, "quantitative") };
    if (learning.series) learningEncoding.color = channel(learning.series, "nominal", { scale_role: "semantic" });

    const learningLayers = [layer("score", "line", learningEncoding), layer("score-points", "point", learningEncoding)];
    if (learning.lower && learning.upper) {
      learningLayers.unshift(layer("uncertainty", "band", {
        x: channel(learning.size, "quantitative"),
        y: channel(learning.lower, "quantitative"),
        y2: channel(learning.upper, "quantitative")
      }));
    }

    return [
      panel({
        id: "roc",
        title: "ROC curve",
        dataRef: roc.data,
        layers: [
          layer("chance", "rule", {
            x: { value: 0, type: "quantitative" },
            y: { value: 0, type: "quantitative" },
            x2: { value: 1, type: "quantitative" },
            y2: { value: 1, type: "quantitative" }
          }, { role: "reference" }),
          layer("roc-line", "line", rocEncoding)
        ]
      }),
      panel({
        id: "confusion-matrix",
        title: "Confusion matrix",
        type: "matrix",
        coordinate: "matrix",
        dataRef: confusion.data,
        layers: [
          layer("cells", "rect", {
            x: channel(confusion.predicted, "nominal"),
            y: channel(confusion.actual, "nominal"),
            color: channel(confusion.value, "quantitative", { scale_role: "sequential" })
          }),
          layer("values", "text", {
            x: channel(confusion.predicted, "nominal"),
            y: channel(confusion.actual, "nominal"),
            text: channel(confusion.value, "quantitative")
          })
        ]
      }),
      panel({
        id: "calibration",
        title: "Calibration",
        dataRef: calibration.data,
        layers: [
          layer("ideal", "rule", {
            x: { value: 0, type: "quantitative" },
            y: { value: 0, type: "quantitative" },
            x2: { value: 1, type: "quantitative" },
            y2: { value: 1, type: "quantitative" }
          }, { role: "reference" }),
          layer("observed", "line", calibrationEncoding),
          layer("observed-points", "point", calibrationEncoding)
        ]
      }),
      panel({
        id: "learning-curve",
        title: "Learning curve",
        dataRef: learning.data,
        layers: learningLayers
      })
    ];
  }, path);
}

export function createDefaultRecipeRegistry() {
  return new RecipeRegistry()
    .register("generic.figure@1", { expand: expandGeneric })
    .register("pca.diagnostics@1", { expand: expandPca })
    .register("embedding.small-multiples@1", { expand: expandEmbeddingSmallMultiples })
    .register("model.validation@1", { expand: expandModelValidation });
}

export const defaultRecipeRegistry = createDefaultRecipeRegistry();
