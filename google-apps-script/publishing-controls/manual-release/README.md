# Publish the checked develop preview

The active workflow has two environments: the private `develop` Preview and public `main` Production. The control panel prepares a confirmation immediately from saved artifact metadata. Only the explicit final confirmation invokes a production build. There is no separate review branch, build hook, deployment, or candidate website.

## Build commands

- Develop: `node google-apps-script/publishing-controls/manual-release/preview-build.cjs`
- Production: `node google-apps-script/publishing-controls/manual-release/production-build.cjs`
- Ignore ordinary pushes: `node google-apps-script/publishing-controls/manual-release/ignore-build.cjs`

Build hooks bypass Netlify's ignore command. Both build entry points therefore validate the intended site, branch, context and explicit request before publishing. The production envelope uses schema 2 and an HMAC signature. Old review/production envelopes are rejected. The existing Preview callback plugin must run before the manual-release activation plugin.

## Confirmed inputs and immutable artifacts

Preview saves its final files, renderer source digest, and per-project content digests in an immutable capsule before deployment. It records both standard digests and digests normalized for the established TBB download policy. The signed successful-deployment callback activates that exact capsule. A Preview created before this protocol needs one explicit **Update preview** to save the additional metadata.

**Publish to production** prepares a confirmation covering the Preview capsule, current production capsule, deploy identities, complete project selection, catalog, renderer digest and displayed changes. This creates no build request. The confirmation expires after 30 minutes. The existing internal `review` record names now describe this confirmation; they do not represent a deployed review site.

**Confirm publication** rechecks those inputs and the public production receipt. It records one durable, 15-minute production request before posting the main hook. The build claims that request, downloads only its pinned capsules, verifies their bytes and identities, and uses the existing selective renderer. It preserves production-only projects, the homepage introduction and the TBB publication policy while omitting excluded routes. The main checkout's renderer digest must match the checked Preview. Code changes therefore need to reach main before publication; a different renderer cannot silently publish the Preview.

The build uploads the completed production capsule and sends `production_prepared` with its render plan, source evidence and digests. The store rechecks the active sources, selection and catalog under its lock. Only accepted output reaches `dist`. A successful deployment activates the staged capsule; the next release uses that capsule as its production baseline. The served receipt records `publication_method=develop-promotion`, the confirmation digest and source Preview identity.

The gzip-compressed `ais-files-v1` archive contains a four-byte header length, a UTF-8 JSON header and concatenated file bytes. Safe paths, sizes, SHA256 inventory, provenance and 8 MiB chunks are verified. Descriptors and provenance remain immutable; activation receipts are separate.

Preview archives and unpacked files are limited to 512 MiB so the full catalog can retain larger original videos. Production retains its 256 MiB limit. Both the build client and Apps Script store enforce the environment-specific bounds; all existing chunk, checksum, provenance and activation checks still apply.

## API and failure handling

The signed Apps Script API retains its `ais-manual-release-api-v1\n` domain. Hook envelopes use `ais-manual-release-hook-v1\n` with schema 2.

Actions: `begin_capsule`, `put_chunk`, `complete_capsule`, `upload_status`, `read_capsule`, `read_chunk`, `claim_production`, `production_prepared`, `deployment_succeeded`, `deployment_failed`. No API action creates a publication request or invokes a hook. Claims and artifact reads are bound to one exact build. The old review-claim and candidate-ready actions are unavailable.

Unknown hook, claim, preparation and success responses are not retried automatically. Immutable upload recovery queries `upload_status`, checks the original descriptor, and resends only authoritatively missing identical chunks. A pre-deployment failure can close its matching request. A post-deployment callback failure remains uncertain until the public receipt reconciles it; it must never be labelled a failed publication.

## Verified content cache and bounded transfers

Production uses Netlify Build's standard cache for `.ais-release-cache-v1/`, outside the published directory. Every download still reads the authenticated capsule descriptor and validates chunk hashes, complete archive, provenance and individual files. Missing or corrupt cache bytes fall back to Drive; authorization failures do not. The cache stores content only, has a 512 MiB size bound, and can be disabled with `AIS_RELEASE_CACHE=off`.

Confirmed Production uploads also cache their exact output chunks, so the next release can reuse its current production baseline. Output is cached only after `complete_capsule` is confirmed, including reconciliation of a lost acknowledgement. Cache failures never turn a confirmed archive upload into a failed upload. The existing `onPostBuild` save persists this directory for subsequent builds; this is not a checkpoint or a guarantee of recovery after a hard timeout. Saving prunes the least recently used chunks to the existing size limit.

The client defaults to two concurrent API requests. Both production inputs share that one budget, including descriptor and upload-status requests. Chunk order is restored before full archive verification. Upload recovery is serialized and merges confirmed progress, so an older status snapshot cannot discard another worker's acknowledgement. A failed transfer stops assigning new chunks and drains requests already started before reporting failure. Claims, completion, preparation and success callbacks retain their existing phase ordering and retry rules. Set `AIS_RELEASE_TRANSFER_CONCURRENCY=1` in the relevant build environment to return to serial requests; only `1` and `2` are accepted.

`Release metrics:` log lines contain JSON for input reads, assembly, packing, upload, output caching, Netlify cache restore/save, preparation and the success callback. Read metrics report verified downloaded bytes and cache hits; upload metrics report archive size, attempted chunk bytes (including resends), status reads, busy responses and chunk latency percentiles. These byte counts exclude Base64/HTTP overhead. Chunk latency includes client queueing; overlapping input elapsed times must not be added together. `production_build` excludes Netlify's later deployment and success callback. Use these stages with Netlify's own log timestamps when measuring an entire release.

This change needs only the client-side build files on `develop` and `main`; it does not require a new Apps Script runtime, credentials, storage layout or page assets. Check transfers during the next normal Preview release; inspect output-cache saving during a normal Production release and cache hits when its successor reads that baseline. Do not create repeated live deployments solely to benchmark this change.

## Installation and verification

Use the versioned [runtime bundle](../runtime-install/README.md), keeping the current Apps Script deployment URL and access settings. Production needs `AIS_RELEASE_PRODUCTION_HOOK`; Preview keeps `AI4S_NETLIFY_PREVIEW_BUILD_HOOK`. Both environments need their scoped Registry URL, instance and signing secret. A separate review hook or renderer-digest property is no longer needed. Keep historical release records and existing active capsules during migration.

```sh
node --test test/manual-release-*.test.js test/publishing-controls-sidebar.test.js
node --test google-apps-script/publishing-controls/manual-release/*.test.cjs
node --test google-apps-script/publishing-controls/production-release/*.test.cjs
node --test google-apps-script/publishing-controls/runtime-install/*.test.cjs
```

These tests use local fixtures and mocked transports. They cannot prove a real production publication succeeded. Validate a new private develop build after installation, and verify that preparing or cancelling a confirmation creates no Netlify deployment. A live Production publication remains a separate operator action.
