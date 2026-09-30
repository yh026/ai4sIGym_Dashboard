# Registry v3 sandbox contract

The sandbox is a separate Google spreadsheet, bound Apps Script project and
Drive root. Its API serves only Preview. The existing V2 endpoint and production
build continue to use schema 2 without a configuration change.

## Operator tables

`Projects` retains the original 18 columns, IDs, native table and taxonomy. Its
two added columns, `Development version` and `Published version`, are derived.
All projects in the sandbox copy are Draft / Preview only. Projects without a
selected version remain in the workbook and are excluded from the test build.

`Versions` contains Version ID, demo_id, Layout (`single` or `three-page`), State
(`Draft` or `Reviewed`), Permission (`Preview only` or `Private`), Use in develop,
Collection, Snapshot digest and Check. Exactly one version may be selected per
project. The sandbox cannot create Published versions.

`Pages` contains Page ID, Version ID, Role, State, Source file, Dataset ID,
Dataset version and Route. Source file is an ordinary Drive URL. Roles are
`insight`, `dataset`, `workflow`, `legacy`, and optional `resource_page`.
Insight and Workflow are required in three-page mode. Dataset can explicitly be
Placeholder, with no source. Ready always requires a readable HTML file.

`Resources` contains Resource ID, Version ID, Role (`card` or `download`), Source
file and Route. `_Pages`, `_Resources`, `_Snapshots`, `_ImportFiles`, and
`_SandboxAudit` are protected machine tables.

## Source ownership and stable routes

Sources are copied under `projects/<slug>/<version>/`, with nested downloads
under `resources/`. Datasets live under `datasets/<dataset-id>/<version>/`.
Only files within the independent Drive root and correct version directory are
eligible. IDs do not depend on sheet order, display title or file name.

Entry remains `demos/<slug>/index.html`, Workflow remains `workflow.html`.
Existing `datasets/<dataset-id>/index.html` addresses are retained. New Dataset
placeholders use `demos/<slug>/dataset.html`; replacing a placeholder does not
change its route. Shared Dataset source identities resolve to exactly one file
per Dataset version, with separate navigation rendered for each project.

The two legacy projects retain one entry page. TBB retains
`workflow-resources.html`, its notebook and eight original download routes.

## Snapshot and API

Sync compiles the current Projects metadata, taxonomy, version selection, page
roles, Dataset states and every source hash. Its deterministic SHA-256 revision
also binds resources and navigation routes. No-change sync does not create a new
snapshot or publish request. A script lock prevents concurrent writes.

The immutable JSON snapshot is stored in the sandbox Drive. Its current pointer
is a Script Property. Before serving it, the API checks the current Sheet input
fingerprint. A manifest read also checks every selected file's timestamp, size,
MIME type and parent path. Individual reads verify the exact source hash as well.
The build compares the manifest at its start and end and does not clear its old
output until all required content has been read successfully.

Requests use the Web App URL with `token`, `schema=3`, `audience=preview`, and
`action=manifest|page|resource`. File requests additionally require logical `id`
and `registry_revision`. A Drive file ID alone is never an authorization token.
Wrong audience, missing token, unselected identity and stale revision fail.

The manifest has `schema_version: 3`, `registry_instance`, `environment`,
`audience`, `registry_revision`, V2-compatible `taxonomy` and `demos`, and a
`bundles` array. Each bundle binds one demo to one version, pages and resources.
Content responses echo instance, revision and logical identity. The build
verifies byte count and SHA-256 before using them.

The public generated manifest is separately allowlisted. It includes page
roles, states and public paths, never Drive IDs, source paths or credentials.

## Netlify boundary

The `REGISTRY_URL` query parameter selects schema 3 explicitly. Requests to the
existing URL continue to use schema 2. A sandbox manifest is accepted only by a
Netlify `branch-deploy` on `develop`, with the exact instance pinned through
branch-specific `AIS_REGISTRY_INSTANCE`. Production cannot consume it.

Only the `develop` values of `REGISTRY_URL`, `AI4S_PREVIEW_CALLBACK_SECRET` and
`AIS_REGISTRY_INSTANCE` may point at the sandbox. No Production hook is allowed
in sandbox Script Properties. Netlify access protection is separate from the
branch/content rules and must be checked for aliases and deploy permalinks.

Preview requests are saved before HTTP. Hook acceptance is not readiness. The
existing Netlify completion plugin signs a receipt containing the Registry
instance/schema, revision, request, branch, site, deploy and commit. The sandbox
accepts matching fresh HMAC callbacks; duplicate acknowledgments are idempotent,
and another deploy cannot replay a ready request. An uncertain HTTP result is
not automatically resubmitted.

Known failures also stop automatic retries. An operator may approve a retry only
after checking the previous Netlify build; the same revision is capped at three
attempts. A signed unverified Git deployment demotes stale ready status, and an
older callback cannot restore it. V3 callbacks allow three minutes for fresh
Drive/Sheet verification; V2 keeps its existing timeout.

## Repository and commissioning

`lib/registry-v3.js` is the shared pure contract, `registry-v3-client.js` reads and
verifies it, and `project-pages.js` renders the same navigation as local authoring.
`google-apps-script/sandbox/Adapter.gs` is intentionally independent of the old
production script. `scripts/bundle-sandbox.cjs <import-config-file-id>` combines
the tested compilers and adapter into a local ignored deployment artifact.

`scripts/prepare-backend-sandbox.cjs` prepares the reviewed local content, and
`scripts/check-backend-sandbox.cjs` rehearses all 13 projects through HTTP using
the real scientific HTML and downloads. Generated archives, credentials,
snapshots and verification records remain under ignored `local-content/`.

Original-backend migration is a later additive step. It must preserve the actual
production Published baseline, retain V2 compatibility, and never replace the
original Sheet with the local project list. The pure compiler includes Published
snapshot checks for that later migration; the current sandbox cannot publish.
