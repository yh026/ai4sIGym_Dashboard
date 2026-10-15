# Payload dashboard starter

Edit `payload.json`; keep large chart values in package-relative files under
`data/`. The payload must declare every Figure → Panel → Layer and field
binding—do not rely on the renderer to guess a chart.

From the renderer kit directory:

```bash
node scripts/payload.mjs validate /path/to/this/package/payload.json
node scripts/payload.mjs render /path/to/this/package/payload.json
node scripts/payload.mjs conformance /path/to/this/package/payload.json
```

Read the kit's `PRODUCER_GUIDE.md` before adding sidecars, recipes, transforms,
or interactions.
