# Reviewed production releases

Production publishes a frozen copy of a reviewed develop deployment. Drive and
the V3 registry continue to control develop; editing a Draft in Drive does not
silently update this production release. This is a release lane, not a migration
of the sandbox API into a full V3 production publisher.

Netlify's production context runs `scripts/build-production-release.cjs`. Pull
request previews use the same package with `--review`, preview status, and global
noindex rules; they require a matching Netlify pull-request identity and do not
read Drive credentials. Branch deploys retain the existing registry build.
The production builder requires
Netlify production/main identity and validates the checked-in archive and every
file against `release/production-release.json` before replacing its output.
Images, scientific values, page scripts, and retained downloads are preserved
byte for byte. Deployment headers, robots rules, the public manifest's release
status, and the deployment receipt are regenerated for production. Explicit
publication overrides below record the additional output differences.

The receipt records the actual main commit and Netlify build/deploy IDs. Its
top-level `verified: false` means that it is not a signed preview-hook receipt;
`source_preview` separately records the signed preview used for this release.
Archive SHA-256 and the per-file inventory provide reproducible content checks.

## TBB publication override

After validating the entire original archive, production and its release review
hide TBB's Notebook & skills page and downloads. The builder removes only the
three reviewed navigation links from TBB Insight, Workflow, and Dataset, omits
the resource page and its `resources/` directory, and removes its entries from
the public manifest and performance report. Existing resource-page URLs redirect
to Workflow with HTTP 302; download URLs are no longer published.

The archive remains unchanged. The public manifest's
`release.publication_overrides` and the receipt's `publication_overrides` record
the exact changed-file hashes, omitted-file hashes, and redirects. All other
page and asset bytes are retained. This override requires TBB's declared
`resource_page`; a missing source page or changed navigation fails validation
before replacing output. The normal develop builder and Drive sources retain
their resource page and downloads.

Netlify Pretty URLs HTML rewriting is disabled: its post-processing changed
apostrophe-containing card search attributes into invalid HTML quoting. Native
page links already point to working files; preserve those links and validate
the extensionless URLs used by existing bookmarks after each deployment.

## Prepare another release

1. Finish and review the develop deployment, including its main charts,
   navigation, and changed interactions. Retrieve its complete deployment files
   and its real receipt. Do not substitute an older local receipt.
2. Update the packager's explicitly reviewed source identity and project list
   when approving a new source release. Generate the deterministic USTAR/gzip
   archive and inventory using `scripts/package-production-release.py`.
3. Run `node scripts/build-production-release.cjs --local --output <temp-dir>`
   outside Netlify and run `npm test`. Check the production output's routes,
   assets, and absence of a global `noindex` rule.
4. Commit the release package and manifest, then merge the reviewed release
   branch into main. Confirm the published Netlify deployment and its receipt
   match that main commit; check the public website.

## Rollback

The previous production deployment is retained in Netlify. Restore its published
deployment for an immediate rollback, then revert the corresponding main release
commit if necessary. The production builder never changes Drive, the V2 registry
configuration, or the previous deployment. Retaining a release commit retains
its complete inputs, so its pages can be reconstructed without a live Drive API.

## Release reviewed on 2026-10-02

This release freezes develop deployment `6abf25ef581f89000876e7fa`
(commit `ee1c49d6ed8e32ee17493a5c395bfe9245a60d52`, registry revision
`sha256:41094736529eb088d119a4f9c5e817f13c3b11f1dd8f68713b8b740f4b0bfcb8`).
It publishes the approved Air Quality and Singapore Road pages, the dark Battery
Curve Shape cover, and aligned Satellite reconstruction images. All 137 source
files were verified against the exact Netlify deployment inventory. The existing
TBB Notebook & skills publication override and HTML preservation settings remain
in effect.
