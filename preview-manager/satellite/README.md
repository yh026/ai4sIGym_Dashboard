# Satellite Insight asset overlay

These tools extract images and scientific data from the supported Satellite Insight page into content-addressed files. The converter checks the input hash and uses the Production file inventory to preserve the spelling of existing resource links. The output is an overlay for the existing demo.

From the checkout root, place the source HTML at `.local/netlify-manager/satellite/input/index.html`, the corresponding inventory at `private-inputs/production-baseline.json`, and the demo's existing resources under `private-inputs/satellite/resources/`.

```sh
python3 preview-manager/satellite/convert.py \
  .local/netlify-manager/satellite/input/index.html \
  .local/netlify-manager/satellite/package
python3 preview-manager/satellite/prepare-fixtures.py --download-assets
node preview-manager/satellite/validate-import.mjs
node preview-manager/satellite/validate.cjs
```

The import check verifies the overlay against the inventory. The browser check compares reconstruction, classification, navigation and media behavior in two local fixtures. It requires Google Chrome and Playwright. Use `PLAYWRIGHT_MODULE` to supply a Playwright installation. Validation output is written under `.local/netlify-manager/satellite/`.
