# Reviewed production releases

Production publishes a frozen copy of a reviewed develop deployment. Drive and
the V3 registry continue to control develop; editing a Draft in Drive does not
silently update this production release. This is a release lane, not a migration
of the sandbox API into a full V3 production publisher.

Netlify's production context runs `scripts/build-production-release.cjs`. Other
contexts retain the existing registry build. The production builder requires
Netlify production/main identity and validates the checked-in archive and every
file against `release/production-release.json` before replacing its output.
Images, scientific values, page scripts, and downloads are preserved byte for
byte. Only deployment headers, robots rules, the public manifest's release
status, and the deployment receipt are regenerated for production.

The receipt records the actual main commit and Netlify build/deploy IDs. Its
top-level `verified: false` means that it is not a signed preview-hook receipt;
`source_preview` separately records the signed preview used for this release.
Archive SHA-256 and the per-file inventory provide reproducible content checks.

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
