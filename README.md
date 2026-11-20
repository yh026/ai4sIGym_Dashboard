# Instrumentation Gym management desk

This branch contains the management interface, Netlify functions, catalog renderer and automated tests. The desk accepts a new demo or an update as HTML, a folder or a ZIP. The owner can publish reviewed Previews, publish from files, restore a release and inspect its receipt.

## Run the checks

Use Node.js 24 and pnpm. Run the following commands from the checkout root.

```sh
pnpm --dir preview-manager install --frozen-lockfile
node --test --test-concurrency=1 preview-manager/test/*.mjs test/preview-package.test.js
node preview-manager/prepare.mjs
```

The tests use generated content and an in-memory release service. The preparation command builds the management pages and function entry points in `preview-manager/.preview/`.

## Configure an installation

Set `SITE` and `OWNER` in `preview-manager/server/store.mjs` to the Netlify site and owner account identifiers before provisioning. The checked-in identifiers are examples for running the local tests. Supply the production inventory and deployment credential through the operator setup. The operator guide covers site protection, member permissions, package formats and deployment commands.

- [Operator guide](preview-manager/README.md)
- [Satellite asset conversion tools](preview-manager/satellite/README.md)
