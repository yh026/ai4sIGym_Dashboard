# TESS real-data reference package

This directory is a development-time materialization of the generic payload dashboard contract. The portable renderer does **not** run this analysis: its only inputs are the generated `payload.json` and `data/` sidecars.

Generate the real-data package with the existing `ais5102` environment:

```bash
conda run -n ais5102 python -B build_payload.py \
  --source "/path/to/TOI_2025.02.03_06.18.31.csv"
```

Then compile the offline dashboard with Node.js 24 or newer:

```bash
node ../../render.mjs \
  --input payload.json \
  --output dashboard.html
```

The builder verifies the source snapshot SHA-256, applies the five declared QC rules, fixes every random seed, computes the stage artifacts, and writes deterministic JSON/JSONL sidecars with bytes/rows/SHA-256 metadata. The historical Notebook, split indices, and intermediate arrays were not archived, so stochastic layouts are recomputed rather than claimed to be byte-identical to the historical PNGs.

The source CSV path must be supplied explicitly with `--source`; this checkout
does not include that original CSV or require a personal filesystem layout.
Rendering and the Node test suite use the checked-in payload and sidecars
without running Python analysis.

Generated HTML is ignored by Git. `expected-build.json` preserves the payload
and bundle hashes from the reviewed reference output. The test suite builds a
fresh HTML file in a temporary directory and checks it against those hashes.
When intentionally updating scientific inputs, review and update that small
receipt together with the payload and sidecars.
