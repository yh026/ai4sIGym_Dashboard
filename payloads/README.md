# Payloads

`payload.json` is the legacy 2.2 dashboard source. It remains supported while
new reports move to Payload v3. Generated HTML files are ignored by Git and can
be rebuilt from their source inputs.

Render it with:

```sh
node ../payload-dashboard-kit/render.mjs \
  --input payload.json \
  --output tess-dashboard-standalone.html
```

New visualization packages should use the v3 contract and explicit Figure → Panel → Layer views. The contract, JSON Schema, and PCA/embedding/model-validation fixtures live in `../payload-dashboard-kit/references/`. Large arrays may live in verified package-relative JSON/JSONL sidecars; the compiler inlines them and still emits one self-contained offline HTML file.

`v3-renderer-capabilities-demo.html` can be generated from the v3 capability
fixture. It includes 10 panels, tree and flow layouts, horizontal uncertainty
marks, a log scale, and an interactive Canvas panel:

```sh
node ../payload-dashboard-kit/render.mjs \
  --input ../payload-dashboard-kit/references/payload-v3-capabilities.fixture.json \
  --output v3-renderer-capabilities-demo.html
```

Render any 2.2 or 3.0 entrypoint with the same CLI:

```sh
npm run render:payload -- \
  --input path/to/payload.json \
  --output path/to/dashboard.html \
  --strict
```
