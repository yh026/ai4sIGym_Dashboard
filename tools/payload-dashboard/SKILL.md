---
name: render-payload-dashboard
description: Produce, validate, and compile a declarative cross-domain visualization package into one self-contained offline HTML accordion report. Use when a payload must state explicit Figure→Panel→Layer intent, when large chart data belongs in verified sidecars, or when a legacy 2.2 dashboard must still render. Do not use for arbitrary web apps or for guessing charts from undocumented arrays.
---

# Render a payload dashboard

Use the bundled deterministic producer tools and compiler. Payload v3 is the
cross-domain authoring contract; schema 2.2 remains a legacy rendering path. Do
not rewrite the dashboard by hand, execute payload code, or infer a chart from
an id or array shape. A domain, locale, and shell preset are payload choices;
the renderer is shared.

## Produce a new package

Read [PRODUCER_GUIDE.md](PRODUCER_GUIDE.md) when creating a payload, defining an
upstream hand-off, adding sidecars, or selecting visual capabilities. Start
from the domain-neutral template rather than a large domain example:

```bash
node <skill-dir>/scripts/payload.mjs init <new-package-directory>
node <skill-dir>/scripts/payload.mjs capabilities --json
```

The producer must declare a typed data catalog and explicit
Figure → Panel → Layer views. It may use `generic.figure@1` with explicit
panels, or a registered recipe whose exact bindings fit the intended visual.
Text-only sections with no figures are valid. Run conformance before hand-off:

```bash
node <skill-dir>/scripts/payload.mjs conformance <package>/payload.json
```

Treat a successful machine-readable conformance receipt as the package
boundary. The renderer consumes only `payload.json` and its declared sidecars;
it never needs the upstream planner, analysis code, environment, or frontend.

## Workflow

1. Resolve the entrypoint and output path. The visualization-package entrypoint is named `payload.json`; its package-relative data sidecars normally live under `data/`.
2. Inspect `schema_version`:
   - for `3.0.0`, read [payload-v3-contract.md](references/payload-v3-contract.md) when authoring, repairing, or reviewing the package;
   - for `2.2.x`, read the [legacy payload contract](references/payload-contract.md) only when validation or compatibility guidance is needed;
   - reject other versions rather than adapting them implicitly.
3. Run `scripts/render-dashboard.mjs` with Node.js 24 or newer, resolving the script relative to this `SKILL.md`:

   ```bash
   node <skill-dir>/scripts/render-dashboard.mjs \
     --input <payload.json> \
     --output <dashboard.html> \
     --strict
   ```

4. Treat validation failures as package errors. Report the JSON Pointer-like path, code, and correction; never silently drop a figure, panel, layer, or data source.
5. For v3, review the compilation receipt: section, figure, panel, layer, recipe, mark, and sidecar counts must match the package. The compiler verifies sidecar path containment, SHA-256, bytes, row count, and JSON shape before inlining it.
6. For legacy 2.2, review compatibility warnings for one-column matrices, prediction score classes, and reliability-bin counts.
7. Verify that the result is one HTML file with no external resource or network call. Open it in a browser and check the localized header and controls, every accordion, every declared composite figure, text-only sections, narrow layout, `data-dashboard-status="ready"`, no `.render-error`, and no console error.

## Portable package

This folder is both the skill and the runnable renderer. For the default drop-in workflow, place the variable run inputs here:

```text
input/
├── payload.json
└── data/                 # optional JSON/JSONL sidecars declared by payload.json
```

Then run this from the skill directory:

```bash
node render.mjs
```

It creates `output/dashboard.html`, including the verified sidecar values, as one offline file. `node render.mjs --validate-only` checks the same default package without writing output. Use `--input` and `--output` to compile a package stored elsewhere. Paths declared inside `payload.json` remain relative to that file, not to the current shell directory.

## Invariants

- Preserve payload values, ordering, labels, caveats, and provenance.
- In v3, data declares domain meaning; recipes and explicit panels/layers declare visual intent; the renderer supplies implementation while payload `theme` and `presentation` select the shell.
- Keep large values in package-relative JSON/JSONL sidecars (`none` or `gzip`) so an AI can read the compact entrypoint while the compiler reads the data.
- Render text with the safe Markdown subset implemented by the runtime; never inject payload text as raw HTML.
- Keep one renderer across domains. Use the generic presentation preset by default; retain the reference preset only when that example's shell is intended.
- Keep the output offline: embed CSS, JavaScript, JSON, and SVG; use no CDN, fetch, external font, or external image.
- Fail closed on unknown schema versions, recipes, coordinates, marks, transforms, fields, and references.
- Never put JavaScript, callbacks, expressions, HTML, CSS, raw SVG, remote URLs, or renderer code in a payload.

## Authoring v3

For a new domain package, start with
`templates/generic-package/payload.json`. Use the closest golden fixture only
when its specialized renderer capability is relevant:

- [PCA composite](references/payload-v3-pca.fixture.json)
- [t-SNE/UMAP small multiples](references/payload-v3-embedding-sweep.fixture.json)
- [model validation composite](references/payload-v3-model-validation.fixture.json)
- [renderer capability matrix](references/payload-v3-capabilities.fixture.json)

Use the machine-readable [Payload v3 Schema](references/payload-v3.schema.json) plus semantic validation from the compiler. Read [TESS visual coverage](references/tess-visual-coverage.md) when implementing or auditing reference-page coverage. A successful artifact count is not evidence that all reference figures were represented.

Three small cross-domain examples prove that the same renderer accepts
different data, themes, locales, and section shapes:

- [manufacturing](examples/generic-manufacturing/payload.json): generic/light,
  verified sidecar, and a text-only workflow step;
- [clinical](examples/generic-clinical/payload.json): generic/dark and inline
  uncertainty values;
- [sales](examples/generic-sales/payload.json): generic/light with Chinese shell
  labels.

The large TESS packages below remain examples; never treat their stages,
terminology, counts, or presentation preset as universal authoring rules.

For a complete 20-section reference package, inspect [examples/tess-reference-package/payload.json](examples/tess-reference-package/payload.json) together with its `data/` directory and [compiled dashboard](examples/tess-reference-package/tess-reference.dashboard.html). Rebuild all three with:

```bash
node scripts/generate-tess-reference-package.mjs
```

The generator asserts 20 sections, 24 figures, 73 expanded panels, 103 layers, 69 verified sidecars, and five Stage 14 interactions before emitting the standalone HTML. Its deterministic arrays are renderer-acceptance data, not a reconstruction of unavailable original TESS scientific outputs.

When scientific values rather than renderer-acceptance values are required, use [examples/tess-real-package/payload.json](examples/tess-real-package/payload.json) with its `data/` directory and [compiled real-data dashboard](examples/tess-real-package/dashboard.html). Its development-only [materializer](examples/tess-real-package/build_payload.py) verifies the archived NASA TOI snapshot hash, recomputes the declared methods in the existing `ais5102` environment, and writes the portable payload package. The renderer still consumes only `payload.json + data/`; it never runs that Python analysis. Read the package README before rebuilding because the historical notebook and intermediate arrays were not archived, so stochastic layouts are reproducible recomputations rather than pixel-identical historical coordinates.

## Extending the renderer

Read [renderer-authoring.md](references/renderer-authoring.md) before adding a mark, coordinate, interaction, or versioned recipe. Update Schema, semantic validation, normalized IR, runtime rendering, valid and invalid fixtures, and browser coverage together.

## Resources

- `PRODUCER_GUIDE.md`: upstream package-production and hand-off guide.
- `scripts/payload.mjs`: dependency-free `init`, `capabilities`, `validate`,
  `render`, `conformance`, and `sidecar` CLI.
- `templates/generic-package/`: smallest domain-neutral starter.
- `references/capabilities-v3.json`: machine-readable closed capability surface.
- `render.mjs`: zero-configuration portable-package wrapper (`input/payload.json` to `output/dashboard.html`).
- `scripts/render-dashboard.mjs`: version dispatch, sidecar inlining, deterministic compilation, and standalone verification.
- `scripts/generate-tess-reference-package.mjs`: deterministic full-coverage TESS package and standalone-HTML generator.
- `scripts/lib/payload-v3.mjs`: v3 parsing, semantic validation, normalization, and sidecar integrity.
- `scripts/lib/v3-recipes.mjs`: closed recipe and primitive registries.
- `assets/standalone-template.html`: single-file shell.
- `assets/dashboard.css`: shared generic/TESS accordion and chart styling.
- `assets/dashboard-runtime-v3.js`: Figure/Panel/Layer SVG renderer.
- `assets/dashboard-runtime.js`: legacy 2.2 artifact renderer.
- [minimal.payload.json](references/minimal.payload.json): smallest legacy 2.2 example.
