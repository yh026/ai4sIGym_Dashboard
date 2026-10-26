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

## API and failure handling

The signed Apps Script API retains its `ais-manual-release-api-v1\n` domain. Hook envelopes use `ais-manual-release-hook-v1\n` with schema 2.

Actions: `begin_capsule`, `put_chunk`, `complete_capsule`, `upload_status`, `read_capsule`, `read_chunk`, `claim_production`, `production_prepared`, `deployment_succeeded`, `deployment_failed`. No API action creates a publication request or invokes a hook. Claims and artifact reads are bound to one exact build. The old review-claim and candidate-ready actions are unavailable.

Unknown hook, claim, preparation and success responses are not retried automatically. Immutable upload recovery queries `upload_status`, checks the original descriptor, and resends only authoritatively missing identical chunks. A pre-deployment failure can close its matching request. A post-deployment callback failure remains uncertain until the public receipt reconciles it; it must never be labelled a failed publication.

## Verified download cache

Production uses Netlify Build's standard cache for `.ais-release-cache-v1/`, outside the published directory. Every download still reads the authenticated capsule descriptor and validates chunk hashes, complete archive, provenance and individual files. Missing or corrupt cache bytes fall back to Drive; authorization failures do not. The cache stores content only, has a 512 MiB size bound, and can be disabled with `AIS_RELEASE_CACHE=off`.

## Installation and verification

Use the versioned [runtime bundle](../runtime-install/README.md), keeping the current Apps Script deployment URL and access settings. Production needs `AIS_RELEASE_PRODUCTION_HOOK`; Preview keeps `AI4S_NETLIFY_PREVIEW_BUILD_HOOK`. Both environments need their scoped Registry URL, instance and signing secret. A separate review hook or renderer-digest property is no longer needed. Keep historical release records and existing active capsules during migration.

```sh
node --test test/manual-release-*.test.js test/publishing-controls-sidebar.test.js
node --test google-apps-script/publishing-controls/manual-release/*.test.cjs
node --test google-apps-script/publishing-controls/production-release/*.test.cjs
node --test google-apps-script/publishing-controls/runtime-install/*.test.cjs
```

These tests use local fixtures and mocked transports. They cannot prove a real production publication succeeded. Validate a new private develop build after installation, and verify that preparing or cancelling a confirmation creates no Netlify deployment. A live Production publication remains a separate operator action.
