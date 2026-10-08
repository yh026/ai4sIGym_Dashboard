# Project publishing controls: production contract

These files provide a local selective artifact renderer, release planner, and transport. They are not an installed cloud publishing service. Nothing in this directory runs on a schedule. One isolated 12-project Netlify draft was prepared and verified during implementation; no production publish or Git branch change was performed.

## Current deployment boundary

Production uses the frozen archive path in `main` (`scripts/build-production-release.cjs` and `lib/production-release.js`). A main build hook would rebuild that archive, not apply current Sheet checkboxes. The existing Apps Script sandbox explicitly rejects a production build hook.

The current production release also contains two publication overrides:

- `homepage-introduction-v1`: the homepage introduction, poster, player code, and video.
- `hide-tbb-notebook-resources-v1`: omission of TBB notebook and skills download routes and links.

The planner retains both policies. Publishing the raw develop deployment would lose these differences and is not an accepted substitute.

## Selection semantics

The input catalog must contain every known project. Every project must have explicit boolean `include_in_production` and `include_in_preview` values. Missing rows never imply removal.

| Production | Preview | Next production release |
| --- | --- | --- |
| On | On | Use this project's exact reviewed preview artifact. |
| On | Off | Retain this project's exact current production artifact. |
| Off | Either | Omit this project from the next production deployment. |

A project that has never been published cannot be retained from production. It must first appear in a verified preview. An empty production library is valid. The operation never deletes source files, datasets, notebooks, or skills.

`createReleaseIntent` pins the production deploy, reviewed preview deploy, receipts, immutable file inventories, selection, and each project's content digest. The intent expires after 30 minutes. Reorder-only changes do not change it. Changed content, selection, deployment identity, or publication policy requires a new review.

The deployed public manifests currently omit per-project version/digest fields. They prove membership, but they cannot independently prove whether a project has changed. The snapshot adapter must compute project digests from verified immutable file inventories and normalized publication metadata. It must not invent a digest from a version label or Sheet status.

## Artifact renderer

`artifact-renderer.cjs` and `catalog-renderer.cjs` perform the following steps:

1. Read files from the pinned immutable production and verified preview deploys and verify their inventory hashes.
2. Select project pages and dependencies according to the intent, retaining production-only projects from the pinned production deploy.
3. Regenerate homepage cards, map links, counts, filters, domain collections, and the public manifest for the selected projects.
4. Preserve production's homepage introduction and its exact video/player bytes. Preserve the hidden TBB resources policy, including navigation links and compatibility redirects.
5. Omit unpublished demo and dataset routes while retaining shared datasets still required by selected projects. Fail on conflicting shared routes.
6. Emit production headers, robots policy, and an honest release receipt carrying the intent and source identities. An API release must not claim that it created a Git commit or ran a main build.
7. Calculate the artifact digest and renderer evidence server-side. A browser form or Sheet cell is not proof of renderer validation.

The catalog adapter loads the existing repository's taxonomy, card, filter, map, and domain helpers into an in-memory Node module. It adds exports without editing or invoking `build.js`'s build entry point. The caller must supply a trusted local checkout and the expected digest of all six rendering inputs. Project scientific pages are copied from pinned source bytes, with only the established TBB navigation omission applied. Concrete local HTML links and recursively referenced static resources are checked before an artifact is accepted.

Sources must be complete exact-deploy downloads, with metadata and file inventories acquired through the authenticated Netlify API. The source adapter checks every file against that inventory and checks receipt identity. Arbitrarily authored local metadata does not establish remote provenance; the acquisition step remains the caller's responsibility.

The renderer rejects conflicting shared routes or taxonomy definitions rather than choosing one source silently. It supports production-only retention, reviewed preview updates and additions, removals, and an empty library. Source maps remain unchanged.

## Local commands

Run the tests without network access:

```sh
node --test google-apps-script/publishing-controls/production-release/*.test.cjs
```

Render a complete local release from exact-deployment downloads:

```sh
node google-apps-script/publishing-controls/production-release/release-cli.cjs render \
  --input render-config.json --artifact new-prepared-site --output new-render-report.json
```

`render-config.json` has `sources.production` and `sources.preview`, each with `metadata`, `inventory`, and `directory` paths; `renderer` contains `checkout` and its reviewed `digest`; `selection` contains every project's two publishing booleans. Paths resolve relative to the configuration file. The output report includes the artifact digest and companion `input`, `intent`, and `evidence` JSON paths for subsequent commands. The artifact and report paths must not already exist.

Create a plan from a fresh, verified input JSON file:

```sh
node google-apps-script/publishing-controls/production-release/release-cli.cjs plan \
  --input current-input.json --output reviewed-intent.json
```

Validate prepared bytes locally:

```sh
node google-apps-script/publishing-controls/production-release/release-cli.cjs verify \
  --input current-input.json --intent reviewed-intent.json \
  --artifact prepared-site --artifact-digest sha256:REVIEWED_DIGEST \
  --evidence renderer-evidence.json --output artifact-verification.json
```

`draft` takes the same inputs and creates only an isolated Netlify draft. After an interrupted creation, inspect Netlify and use `--resume-draft` with that exact deployment ID rather than creating another. The response must match the site and release title and identify an unpublished manual `deploy-preview`; Netlify omits the optional `draft` response boolean. `publish` requires `--candidate`, a fresh `--input`, `--intent`, and `--confirm` equal to the complete intent digest. These network actions require local `NETLIFY_AUTH_TOKEN` or `--cli-token-helper` pointing to the authenticated official Netlify CLI's `command-helpers.js`. Tokens are never printed or written to reports.

`publish` rechecks the exact candidate inventory and current published production deploy immediately before its sole production-changing request. The calling application must serialize release operations and refresh Sheet selection before invoking it. Netlify's restore API has no documented compare-and-swap field; a concurrent publish through another client can still race the final check. Do not claim stronger atomic coordination than this provides.

An uncertain network result is not retried. Inspect Netlify's current published deployment and candidate state before another operation. Output report paths must be new files.

## Cloud configuration and remaining decision

Read-only inspection on 2026-10-07 found only `AI4S_PREVIEW_CALLBACK_SECRET`, `AIS_REGISTRY_INSTANCE`, and `REGISTRY_URL` in this site's Netlify environment. No `NETLIFY_AUTH_TOKEN` is configured there. Installing a persistent cloud publisher therefore requires an additional production-capable credential and a service that runs this renderer against authenticated snapshots. Do not copy the operator's local CLI token to the cloud silently.

An API publication does not update the frozen archive in Git main. Before activating permanent Sheet-controlled production publication, reconcile that archive path or replace its release-source policy; otherwise a later main build could restore an older package. The new manual receipt deliberately records `publication_method: manual-api` and `source_main_commit_ref` instead of pretending to have generated a Git commit. Update status readers and the next-release snapshot adapter to validate this new publication contract against Netlify's actual current published deployment. Neither cutover was performed during these preview-only changes.

Until those pieces are authorized and installed, the Sheet can show actual production membership, staged production selections, and a review summary. It must identify publication as unavailable rather than present a working-looking Publish action.

## Integration evidence

On 2026-10-07, authenticated source acquisition reused 257 cached files and fetched 14 missing files. Local renders with all 13 projects, 12 projects excluding TBB, and zero projects passed. Normalizing the established TBB publication rule showed that all 13 current production and preview project content digests match.

The isolated Netlify draft `6ac60cc9cc76061564591b6c` reached `ready` with 12 projects and an exact 97-file inventory. Production remained `6ac4a593a0faca0008d12d0f` before and after. Anonymous HTTP requests returned 401. Subsequent authenticated Chrome inspection confirmed the 12-project homepage, absence of TBB, and presence of the homepage video introduction. Anonymous served-page behavior was not verified. No access settings were changed.

Netlify documents digest-based atomic deploys, `draft: true` preserving the published site, and a separate restore endpoint for publication. [Netlify API guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/). Manual API deployments do not run the repository build command. [Netlify deploy methods](https://docs.netlify.com/deploy/create-deploys/).
