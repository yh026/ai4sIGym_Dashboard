# Producing a Payload Dashboard package

This guide is for an upstream workflow—human-authored code, an AI agent, a
notebook exporter, or an application—that must hand results to the renderer.
The hand-off boundary is always a package containing `payload.json` and any
declared `data/` sidecars. The renderer does not need the planner, analysis
source code, model environment, or original frontend.

## Start a package

Use Node.js 24 or newer and the dependency-free producer CLI bundled with this
kit:

```bash
node scripts/payload.mjs init /path/to/new-package
node scripts/payload.mjs validate /path/to/new-package/payload.json
node scripts/payload.mjs render /path/to/new-package/payload.json
node scripts/payload.mjs conformance /path/to/new-package/payload.json
```

`init` copies the small domain-neutral starter from `templates/generic-package`.
It refuses to overwrite a non-empty directory. Relative sidecar paths are
resolved from the directory containing `payload.json`, regardless of the
process working directory.

Use these examples for patterns, not as content templates:

- `examples/generic-manufacturing`: generic/light English, verified JSON
  sidecar, two chart panels, and a text-only workflow section;
- `examples/generic-clinical`: generic/dark English and inline uncertainty
  data;
- `examples/generic-sales`: generic/light Chinese with localized shell labels;
- `examples/tess-reference-package` and `examples/tess-real-package`: the first
  large reference implementation, retained as examples rather than a required
  domain or theme.

## The producer/renderer contract

The producer owns analytical meaning and visual intent. The renderer owns a
closed implementation of the declared grammar.

```text
upstream computation
        │
        ├── payload.json       compact catalog + report + visual declarations
        └── data/              optional verified JSON/JSONL sidecars
                    │
                    ▼
        strict validation and conformance
                    │
                    ▼
             one offline dashboard.html
```

A payload is data, never executable code. Do not place JavaScript, callbacks,
expressions, HTML, CSS, raw SVG, URLs, or rendering functions in it. Unknown
fields and capabilities fail closed instead of being ignored.

The authoritative structural rules are in
`references/payload-v3.schema.json`; cross-reference and renderer rules are in
`references/payload-v3-contract.md`. Query the concise machine-readable surface
before authoring a visual:

```bash
node scripts/payload.mjs capabilities
node scripts/payload.mjs capabilities --json
```

## Build the data catalog first

Every value used by a chart starts as an entry in the top-level `data` array.
Declare:

1. a stable `id` used by panels and layers;
2. a domain-facing `semantic_type` that explains what the resource means;
3. physical `fields`, their types, roles, units, and nullability;
4. either inline storage or a verified sidecar.

Example:

```json
{
  "id": "category-summary",
  "semantic_type": "operations.category-summary",
  "fields": [
    {"name": "category", "type": "string", "role": "dimension"},
    {"name": "count", "type": "integer", "role": "measure"}
  ],
  "storage": {
    "kind": "inline",
    "format": "rows",
    "rows": [
      {"category": "A", "count": 12},
      {"category": "B", "count": 18}
    ]
  }
}
```

Physical types (`number`, `integer`, `string`, `boolean`, `date`, `datetime`)
describe stored values. Visual channel types (`quantitative`, `nominal`,
`ordinal`, `temporal`) describe how a declared field is interpreted by a mark.
They are related but not interchangeable.

Keep small summaries inline. Move large coordinates, prediction rows, matrix
cells, or time series into sidecars so an AI can inspect the compact catalog
without consuming all values. Sidecars support only JSON or JSONL with `none`
or `gzip` compression. Each declaration includes the stored-file SHA-256,
bytes, row count, format, and compression.

Generate metadata without hand-counting:

```bash
# From the package root, preserve data/rows.json as storage.path.
node /path/to/kit/scripts/payload.mjs sidecar data/rows.json

# From elsewhere, declare the package root explicitly.
node scripts/payload.mjs sidecar rows.jsonl \
  --package-root /path/to/package \
  --compression gzip \
  --output data/rows.jsonl.gz \
  --metadata data/rows.storage.json

# Verify fields, replace one catalog entry, and update payload.json atomically.
node scripts/payload.mjs sidecar raw/rows.json \
  --payload package/payload.json \
  --data-id category-summary \
  --output data/category-summary.json \
  --write
```

Without `--payload`, the current working directory is the package root; use
`--package-root` when running from elsewhere. With `--payload`, its directory
is the package root and `--package-root` is unnecessary. In either mode, the
source `<file>`, `--output`, and `--metadata` are resolved from that root and
the receipt preserves their actual normalized package path (for example,
`data/rows.json`, not only `rows.json`). Every output is containment-checked
before writing, including symlinked parents. If `--path` is supplied, it must
exactly match the canonical package-relative output path. `--write` verifies
stored rows against the resource's declared fields and verifies the resulting
sidecar before updating the entrypoint.
Existing package roots and source files are canonicalized first, so equivalent
operating-system aliases such as `/tmp` and `/private/tmp` do not change the
declared package path.

## Declare the report and accordion

`report`, `run`, `dataset`, and `provenance` describe the result and its origin.
`sections` are the ordered accordion entries. An optional `acts` array groups
the same sections into larger phases without changing their order.

A section can contain narrative roles, metrics, checks, caveats, and figure
references. `figure_ids` may be empty: a workflow step that only records a
decision, validation, or caveat should remain text-only instead of inventing a
chart. Every figure that does exist must be referenced exactly once.

Use `method_notes` to state what a step reports, minimises, uses, or produces,
or to add a concise note. These values describe workflow semantics; they do not
control renderer code.

## Declare every Figure → Panel → Layer

The universal visual hierarchy is:

```text
section
└── figure              composite visual and grid layout
    └── panel           data context and coordinate system
        └── layer       mark + field/value encodings
```

For ordinary domain visuals, use `generic.figure@1` and explicit panels. A
minimal bar layer looks like this:

```json
{
  "id": "category-bars",
  "data_ref": "category-summary",
  "coordinate": {"type": "cartesian"},
  "layers": [
    {
      "id": "counts",
      "mark": {"type": "bar"},
      "encoding": {
        "x": {"field": "category", "type": "nominal"},
        "y": {"field": "count", "type": "quantitative"},
        "text": {"field": "count", "type": "quantitative", "format": "integer"}
      }
    }
  ]
}
```

That declaration is the answer to “what can these values be drawn as?” The
renderer does not infer a chart from an array shape, resource id, filename, or
domain. Precompute analytical operations upstream: v3 intentionally has no
arbitrary calculate, aggregate, bin, stack, fold, model, or embedding transform.

Use a registered recipe only when its role bindings exactly match the intended
composite. Recipes are deterministic shortcuts, not chart-guessing. The
capability catalog lists the supported recipes, coordinates, marks, channels,
transforms, interactions, scales, and storage formats. If a required visual is
not listed, extend the versioned renderer contract before emitting payloads that
request it.

## Choose presentation independently of the domain

`theme.name` selects a shell preset, not a data type:

- `generic` is the default cross-domain accordion shell;
- `tess` preserves the reference example's presentation.

Both presets support declared light/dark modes, palettes, density, semantic
colors, and bounded design tokens. `presentation` controls locale, section
prefix, numbering, figure-title visibility, coverage, build footer, and a
closed set of localized shell labels. Domain text remains in `report`,
`sections`, figures, panels, fields, and data.

Do not fork the renderer to change a report's language or brand. Declare those
choices in `theme` and `presentation`; keep analytical data independent.

## Validate the hand-off

Use `validate` during production. It checks JSON Schema, references, field and
channel compatibility, recipes, transforms, interactions, sidecar containment,
hashes, bytes, row counts, physical values, and renderer data domains.

Use `conformance` before delivery. It performs the same strict validation,
compiles the package into a temporary standalone HTML file, verifies that the
output contains no external script, stylesheet, image, CSS URL, fetch, or
XMLHttpRequest dependency, checks that only one HTML artifact was emitted, and
prints a machine-readable receipt. Temporary output is removed.

An upstream hand-off is complete only when:

- `conformance` exits successfully with `"conformant": true`;
- warnings have been reviewed rather than silently discarded;
- report, section, figure, panel, layer, and sidecar counts match intent;
- `payload.json` and every declared sidecar are included at their exact relative
  paths.

The downstream consumer then needs only:

```bash
node scripts/payload.mjs render /received/package/payload.json
```

The result is `dashboard.html` beside the payload unless `--output` declares a
different payload-relative destination.
