# Payload v3 contract

Payload v3 separates domain results from their visual form. A data source says what values mean; a versioned recipe and explicit panel/layer grammar say how those values must be shown. The renderer validates both and never guesses a chart from an array shape or an artifact name.

The machine-readable authority is [payload-v3.schema.json](payload-v3.schema.json). The bundled `validatePayloadV3` validator adds reference, field, recipe, and renderer-capability checks that JSON Schema cannot express by itself.

## Envelope

Every entrypoint is one JSON object:

```json
{
  "schema_version": "3.0.0",
  "renderer_contract": {
    "name": "render-payload-dashboard",
    "version": "3.0.0",
    "strict": true
  },
  "report": {"title": "Scientific report"},
  "run": {"id": "run-001"},
  "dataset": {"id": "cohort", "title": "Study cohort"},
  "provenance": {
    "generator": {"name": "analysis-pipeline", "version": "1.0.0"},
    "inputs": []
  },
  "theme": {"name": "generic", "mode": "light", "palette": "colorblind-safe"},
  "presentation": {
    "locale": "en",
    "section_prefix": "Section",
    "show_figure_titles": true
  },
  "data": [],
  "sections": [
    {
      "id": "summary",
      "title": "Summary",
      "summary": "A valid text-only section.",
      "figure_ids": []
    }
  ],
  "figures": []
}
```

The core envelope fields shown above are required except optional `presentation`; `acts` is also optional and is omitted from this minimal example. `schema_version` versions author-facing input. `renderer_contract.version` versions the normalized renderer IR. An unsupported major or unknown property fails validation instead of being ignored. A payload must contain at least one section, but a section may be text-only with an empty `figure_ids` array, and the top-level `figures` array may therefore be empty.

`report` controls the page header. `sections` control the ordered vertical accordion. A section lists its figures with `figure_ids`; every figure must be referenced exactly once. `acts` is optional and groups the same ordered sections into larger navigation phases. When acts are present, their flattened `section_ids` must cover every section exactly once and preserve the global section order.

`report` already carries the domain-facing title, subtitle, facts, claim, and final verdict. These values describe the report; renderer or payload implementation details belong in provenance instead of replacing the report claim.

### Section presentation content

Section content remains declarative and ordered by semantic role:

```json
{
  "id": "structure",
  "number": 3,
  "title": "Structure survey",
  "short_label": "Structure",
  "badge": "Ch 03, 04",
  "concepts": [
    "**Ch 03** feature covariance · correlation between features",
    "**Ch 04** mutual information · dependence that correlation misses"
  ],
  "summary": "Optional short overview before the figures.",
  "figure_ids": ["structure-figure"],
  "findings": ["The strongest relationship is **surface gravity with stellar radius**."],
  "narrative": ["Optional supporting interpretation follows the emphasized findings."],
  "method_notes": [
    {"kind": "reports", "text": "Pearson correlation and plug-in mutual information"}
  ],
  "caveats": [
    {"kind": "scope", "text": "Median-filled for this survey only."},
    "A legacy plain-text caveat remains valid."
  ],
  "initial_state": "closed"
}
```

`badge`, `concepts`, `findings`, `narrative`, and `method_notes` are optional. `figure_position` may be `before_findings` (the default) or `after_findings`, allowing the payload to preserve a reference report's narrative order without renderer-specific code. `method_notes.kind` is the closed vocabulary `reports`, `minimises`, `uses`, `produces`, or `note`. A section may contain at most one `reports` note and at most one `minimises` note; `uses`, `produces`, and `note` are repeatable ordered entries. A method note may provide an optional `label`; otherwise the presentation label for its kind is used. `caveats` remains backward compatible with strings and additionally accepts `{kind,text}` objects, where kind is one of `limitation`, `scope`, `provenance`, `warning`, or `note`. Payload text uses only the runtime's safe Markdown subset; these fields never accept HTML or CSS.

An empty `figure_ids` array is intentional for a text-only section. The renderer must still preserve the section summary, findings, narrative, method notes, metrics, checks, and caveats rather than requiring a placeholder chart.

Acts use explicit references rather than inferred section ranges:

```json
{
  "acts": [
    {
      "id": "act-reduce",
      "numeral": "II",
      "title": "Reduce",
      "short_label": "Act II",
      "section_ids": ["preprocessing", "pca", "geometry"]
    }
  ]
}
```

## Presentation and theme

Domain content is independent of the page preset. `theme.name` is either `generic` or `tess`; `theme.mode` is `light` or `dark`. The existing `palette`, `density`, and `semantic_colors` fields remain available. The TESS reference report uses `{"name":"tess","mode":"light"}`, while a new domain should normally begin with the generic preset.

`theme.tokens` is an optional, bounded design-token object rather than an arbitrary style surface:

```json
{
  "theme": {
    "name": "generic",
    "mode": "light",
    "palette": "colorblind-safe",
    "tokens": {
      "accent": "#2563EB",
      "accent_contrast": "#FFFFFF",
      "background": "#F7F9FC",
      "surface": "#FFFFFF",
      "surface_muted": "#F1F5F9",
      "text": "#172033",
      "muted_text": "#667085",
      "border": "#D7DEE8",
      "radius": 10,
      "max_width": 1240
    }
  }
}
```

The eight color tokens accept hexadecimal colors only. `radius` is bounded to 0–24 and `max_width` to 720–1800. Unknown tokens, CSS property names, selectors, font imports, and raw style strings fail validation.

The optional `presentation` object controls locale-neutral shell wording and visibility without changing Figure → Panel → Layer semantics:

```json
{
  "presentation": {
    "locale": "zh-CN",
    "section_prefix": "步骤",
    "show_section_numbers": true,
    "show_figure_titles": true,
    "show_figure_descriptions": true,
    "show_coverage": true,
    "show_build_footer": false,
    "labels": {
      "fold_all": "全部收起",
      "unfold_all": "全部展开",
      "concepts_used": "使用的概念",
      "top": "返回顶部"
    }
  }
}
```

`locale` uses a bounded BCP-47-like language tag. `section_prefix` may be empty and is at most 64 characters. Every `show_*` field is Boolean. `labels` is a partial override object with the closed keys `fold_all`, `unfold_all`, `report_claim`, `coverage`, `concepts_used`, `reports`, `minimises`, `uses`, `produces`, `note`, `top`, `javascript_required`, `standalone_package`, `schema`, `figures`, `seed`, `payload_sha256`, `renderer`, `reset`, `status_pass`, `status_warn`, `status_fail`, and `status_not_applicable`. Missing values fall back to deterministic preset defaults. A `legend_filter`, `parameter`, or `zoom` interaction can also declare its own localized `label`. Payload v3 does not accept arbitrary localized keys or HTML in labels.

## Data catalog

`data` is an array of typed resources. A resource declares a semantic type, physical fields, and storage independently of any chart:

```json
{
  "id": "embedding-points",
  "semantic_type": "embedding.coordinates",
  "fields": [
    {"name": "object_id", "type": "string", "role": "id"},
    {"name": "x", "type": "number", "role": "measure"},
    {"name": "y", "type": "number", "role": "measure"}
  ],
  "storage": {
    "kind": "inline",
    "format": "rows",
    "rows": [{"object_id": "row-1", "x": 0.4, "y": -0.2}]
  }
}
```

Physical field types are `number`, `integer`, `string`, `boolean`, `date`, and `datetime`. Dates must be exact calendar values (`YYYY-MM-DD`); datetimes must contain an exact date, time, and `Z` or numeric UTC offset. Visual channel types are separate: `quantitative`, `nominal`, `ordinal`, and `temporal`.

### Inline data

Inline storage supports:

- `format: "rows"` with record objects or positional arrays;
- `format: "columns"` with an object of parallel arrays;
- `format: "values"` for a single declared field.

Every record key must be declared in `fields`. Required fields cannot be omitted, physical values must match their declarations, and parallel columns must have equal lengths. Use tidy rows for matrices rather than hiding row and column semantics in an anonymous nested array.

### Sidecar data

Large arrays do not belong in the entrypoint. Store them beside the payload and reference them with a verified sidecar:

```json
{
  "kind": "sidecar",
  "path": "data/embedding-points.jsonl.gz",
  "format": "jsonl",
  "compression": "gzip",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "rows": 7364,
  "bytes": 182430
}
```

The v3.0 MVP permits only `json` and `jsonl`, with `none` or `gzip` compression. Arrow, Parquet, NPZ, CSV, and other formats require a later declared renderer capability; naming one early must fail.

Sidecar paths must be normalized, relative package paths. Absolute paths, URLs, URI schemes, backslashes, `.`/`..` segments, symlink escapes, and hash mismatches fail. `compression`, SHA-256, stored byte count, and materialized row count are all required, so every sidecar receives the same integrity checks. The build process resolves and verifies sidecars before creating the final offline HTML.

As an authoring guideline, keep inline data below roughly 100 KB or 2,000 rows. This is not a semantic limit. An AI normally reads the entrypoint, field declarations, and figure specs; the deterministic compiler reads the large sidecars.

## Figure grammar

The visual hierarchy is:

```text
report
└── section
    └── figure
        └── panel
            └── layer
                ├── mark
                └── encoding
```

Every declared figure has a closed, versioned recipe name, layout, and `panels` array:

```json
{
  "id": "embedding-sweep",
  "recipe": "embedding.small-multiples@1",
  "layout": {"type": "grid", "columns": 3, "rows": 2, "gap": 16},
  "panels": []
}
```

Layout remains closed and deterministic: `type`, `columns`, optional `rows`, numeric `gap`/`row_gap`/`column_gap`, and optional positive `column_weights`. A weight vector requires an explicit `columns` value, must contain exactly one value per column, and is valid only for a grid. When `rows` is present, `columns × rows` must fit the cells required by all panel spans; `single` layout requires exactly one panel. Shared domains require an explicit common `scale_id`. Named CSS areas, arbitrary widths/heights, explicit CSS order, and raw layout strings remain forbidden.

Panels may request bounded presentation geometry without embedding renderer code. A panel fragment is:

```json
{
  "id": "uncertainty",
  "display": {
    "aspect_ratio": 1.65,
    "column_span": 2,
    "row_span": 1
  }
}
```

`aspect_ratio` is a positive width-to-height ratio no greater than 20. `column_span` is an integer from 1 to 12 and `row_span` from 1 to 24. Spans are grid-only, must fit declared layout dimensions, and contribute to declared row capacity. These fields describe layout intent; they do not accept pixels, CSS, template-area strings, or arbitrary style objects.

There are two valid authoring modes:

1. Put fully explicit panels and layers in `panels`. A registered recipe preserves them.
2. Leave `panels` empty and supply the registered recipe's `recipe_config`; the registry expands it deterministically.

`generic.figure@1` always requires explicit panels. The initial macro registry is:

- `pca.diagnostics@1`
- `embedding.small-multiples@1`
- `model.validation@1`
- `generic.figure@1`

Unknown recipes fail. Adding a recipe requires a registry implementation, validation, fixtures, rendering coverage, and a capability-version decision.

### Recipe bindings

Bindings map recipe roles directly to a data source and its declared field names:

```json
{
  "recipe_config": {
    "bindings": {
      "points": {
        "data": "embedding-points",
        "x": "embedding_x",
        "y": "embedding_y",
        "facet": "view_key",
        "color": "disposition"
      }
    },
    "params": {
      "columns": 3,
      "variants": [
        {"id": "umap-5", "label": "UMAP · n_neighbors 5", "value": "umap-5"}
      ]
    }
  }
}
```

Bindings do not contain JavaScript, expressions, callbacks, selectors, or renderer code. Recipe parameter names are checked by the registered recipe; parameter values are bounded scalars, scalar arrays, or declared facet variants.

Recipe configuration is fail-closed per recipe: binding group names, field-role names, parameter names, parameter types, and numeric ranges are explicit allowlists. Typos never become ignored metadata. `generic.figure@1` uses only explicit panels and rejects a non-empty `recipe_config`. PCA accepts positive component counts, a variance threshold in `(0, 1]`, and a unique non-empty positive-integer residual list. Embedding accepts 1–12 columns and exact `{id,label,value}` variants. Model validation accepts no parameters and requires learning-curve lower/upper bindings as a pair.

## Panels, layers, and encodings

A panel sets its data context, coordinate system, optional declarative transforms, and ordered layers:

```json
{
  "id": "roc",
  "type": "plot",
  "data_ref": "roc-points",
  "coordinate": {"type": "cartesian"},
  "layers": [
    {
      "id": "roc-line",
      "mark": {"type": "line"},
      "encoding": {
        "x": {"field": "fpr", "type": "quantitative"},
        "y": {"field": "tpr", "type": "quantitative"}
      }
    }
  ]
}
```

`panel.type`, when declared, must match its coordinate: `cartesian` and `canvas` use `plot`, `matrix` uses `matrix`, `tree` uses `tree`, and `flow` uses `diagram`. Omitting `panel.type` is preferred because normalization derives the same value deterministically. `equal_aspect` is implemented only for cartesian coordinates and fails closed on every other coordinate.

Coordinate types are `cartesian`, `matrix`, `tree`, `flow`, and `canvas`. Panel types remain `plot`, `matrix`, `tree`, and `diagram`. `canvas` is opt-in for an explicit generic panel containing exactly one `point` layer; neither the validator nor renderer guesses canvas mode from row count.

Coordinate capabilities are deliberately exact where the runtime consumes layers positionally: `matrix` requires exactly one `rect` layer and permits at most one `text` layer; `tree` requires exactly one `node` and one `link`; `flow` requires exactly one `node` and no link; `canvas` requires exactly one `point`. A tree additionally requires unique node keys, known link endpoints, exactly one root, no directed cycle, and reachability of every node from that root. Cartesian panels use only their declared cartesian mark allowlist.

Matrix `rect` layers require `x`, `y`, and `color`; tree/flow `node` layers require `key`; tree `link` layers require `from` and `to`. Alternative positional encodings that these renderers do not consume are rejected.

The primitive mark registry is deliberately closed:

- `bar`, `line`, `point`, `band`, `rule`, `rect`, `text`, `vector`;
- `node`, `link`;
- `errorbar`, `boxplot`, `ellipse`, `polygon`.

Encodings bind a channel to exactly one declared `field` or one non-null literal `value`. Literal physical and visual types receive the same compatibility checks as stored fields. A constant-only layer may omit `data_ref` and renders exactly once. A layer inherits `data_ref` from its panel unless it declares another source; channels cannot override the source with a `data` property. When a panel declares transforms, its layers cannot override the panel data source because those transforms would have different field meaning. The validator checks that fields exist, physical and visual types are compatible, required channels contain renderable values after transforms, scale references resolve, and a mark receives only supported channels.

The v3.0 visual surface is closed to runtime-backed properties. Channels do not compute `aggregate`, `bin`, or `sort`, and the grammar does not expose `opacity`, `size`, `shape`, `width`, `order`, `detail`, or `angle` encodings. Each mark has a smaller semantic channel and property allowlist published in `capabilities-v3.json`; a property accepted for one mark is not automatically accepted for another. A line mark may opt into a visible node at every declared row with `point: true`; `point_size` controls that line-node radius and remains a layer constant rather than a row-level size encoding. Axis objects support only `title`, `format`, `grid`, `ticks`, and `label_angle`; legend objects support only `title`. A channel-level `format` is rendered only on `text` and `tooltip`; positional formatting belongs in `axis.format`. Formats use the named allowlist exposed by the capability catalog or bounded fixed formats `.0f`…`.12f` and `.0%`…`.12%`; unknown printf/D3-style strings fail instead of falling back silently. Coordinates support only `type` and `equal_aspect`. Scale ranges are color arrays—not pixel ranges—and `nice`/`clamp` are not accepted. Numeric declared scale domains contain exactly two increasing finite numbers (`log` positive, `sqrt` non-negative), temporal domains contain two increasing parseable strings, and categorical domains are non-empty, unique, and must contain every materialized category. A panel has one x scale, one y scale, and one colour scale; all data-bound channels in an axis family either inherit the same implicit scale or declare the same `scale_id`. Colour channels support linear quantitative or ordinal categorical scales; matrix x/y scales are categorical. The compiler preflights required channels and every materialized value bound to an explicit scale, including verified sidecars, so incompatible types and invalid log/sqrt/time values fail before browser rendering. Figure-level annotations are not supported; use panel annotations, which normalize to ordinary layers.

Mutually exclusive interval shapes are explicit. A rule is exactly one x threshold, one y threshold, or a complete `x+y+x2+y2` segment. A bar or band cannot declare both `x2` and `y2`; an errorbar cannot declare both horizontal and vertical bounds. When `orient` is present on an interval mark it must agree with those channels.

Use `color` for both fills and strokes at the visual-grammar level; the mark determines how that color is painted. Use `scale_role: "semantic"` for stable class colors, `diverging` for signed values, and `sequential` for magnitude. A `bar` layer may opt into deterministic value labels with an explicit `text` channel. Its value and `format` come from that channel; ordinary bars place the text at the outer end, while precomputed interval/stacked bars place it in the segment centre when enough room exists. Dense histograms remain unlabelled unless the payload explicitly requests labels.

## Declarative transforms

Transforms are an MVP allowlist: `filter`, `sort`, and deterministic `sample`. A filter uses a structured predicate:

```json
{
  "op": "filter",
  "field": "view_key",
  "predicate": {"eq": "umap-15"}
}
```

There is no expression, calculate, aggregate, bin, stack, or fold transform in v3.0. Sampling permits only `first`, `stride`, or stable `hash`; randomness and current time are forbidden. Values that require domain computation must be computed upstream and stored as data.

## Annotations and interactions

Panel annotations compile to ordinary allowlisted layers. Version 3.0 supports `rule`, `text`, and `band` annotations with structured encodings. Identity lines are represented by a rule with explicit endpoints; reference thresholds are rules with a constant x or y channel.

Interactions are also closed and declarative: `hover`, `tooltip`, `legend_filter`, `parameter`, `linked_highlight`, and `zoom`. Targets use a panel id or the canonical `panel-id/layer-id` form. Unknown targets fail validation. Zoom is currently a two-axis viewBox operation, so `axes` must be `both`. Canvas targets permit hover, nearest-mode tooltip, legend filtering, parameters, and linked highlighting. A Canvas/SVG linked highlight is declarative: every target data source must declare the shared key fields with the same physical types, and the runtime propagates the stable typed key without executing payload code. Canvas is keyboard-focusable when interactive; arrow keys inspect visible points and drive the same linked profile, while Escape or blur clears the highlight.

Payload text is always handled as text. The visual specification rejects properties named `callback`, `code`, `expr`, `expression`, `function`, `html`, `href`, `javascript`, `script`, `src`, or `url` at any depth. A payload is data, never a program.

## Validation layers

Successful authoring requires both checks:

1. Draft 2020-12 JSON Schema validates the closed structure and primitive types.
2. `validatePayloadV3` validates unique ids, references, field compatibility, recipes, transforms, channel requirements, interactions, and renderer capabilities.

`normalizePayloadV3` runs only after validation. It expands recipes into a deterministic renderer-facing IR. The same payload and renderer version must produce the same normalized IR and output bytes.

Important semantic invariants include:

- every figure is referenced by exactly one section;
- text-only sections may reference no figures, and a text-only report may declare no figures at all;
- every `data_ref`, field, scale, panel, layer, and interaction target resolves;
- inline records conform to declared fields and physical types;
- unknown recipes, marks, coordinates, transforms, and interactions fail closed;
- explicit scale types are compatible with their channel types and materialized values;
- tree keys, endpoints, root, acyclicity, and connectivity are valid;
- no panel or layer is silently dropped;
- no visual inference depends on an id substring or array shape.

## Machine-readable capabilities

Producer tools should read the exported `PAYLOAD_V3_CAPABILITIES` value (or call `getPayloadV3Capabilities()`) from `scripts/lib/v3-capabilities.mjs`. It is JSON-serializable and declares the closed mark-to-channel surface, required channel alternatives, coordinate-to-mark support, transforms, interactions, recipes, panel types, and storage formats/compressions. The semantic validator imports the same declarations, so this capability description cannot drift from the channels, coordinates, transforms, interactions, or sidecar formats that validation accepts.

The capability object is a discovery aid, not a replacement for `payload-v3.schema.json`: producers should use capabilities to choose supported constructs and then run both Schema and semantic validation before delivery.

## Golden fixtures

The references directory contains four schema-valid and runtime-valid examples:

- [payload-v3-pca.fixture.json](payload-v3-pca.fixture.json): six explicit PCA panels;
- [payload-v3-embedding-sweep.fixture.json](payload-v3-embedding-sweep.fixture.json): explicit t-SNE/UMAP 2 × 3 small multiples;
- [payload-v3-model-validation.fixture.json](payload-v3-model-validation.fixture.json): recipe-expanded ROC, confusion, calibration, and learning-curve panels.
- [payload-v3-capabilities.fixture.json](payload-v3-capabilities.fixture.json): interval bars, horizontal uncertainty, boxplot, polygon, log scale, tree, flow, and interactive Canvas coverage.

These are contract examples, not domain claims. Keep their data small and deterministic so that schema, semantic, normalization, renderer, and browser tests can use them as golden inputs.

## Migration from 2.2

Schema 2.2 artifacts combine data semantics with renderer guesses. Migration must be explicit:

1. Move reusable arrays into typed v3 data resources.
2. Replace `kind` heuristics with a registered `recipe` or explicit panels and layers.
3. Bind every visual channel to a declared field.
4. State layout, semantic color roles, annotations, and interactions.
5. Move large arrays to verified sidecars.

An adapter may migrate only unambiguous cases. Ambiguous 2.2 artifacts must produce a diagnostic rather than a visually plausible substitute.
