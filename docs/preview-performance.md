# Preview performance and image fidelity

The delivery optimization runs only for preview or local builds. Drive source
pages, download files, original images, scientific values and the Production
build path remain unchanged.

## What changes at build time

- A verified lossless WebP copy replaces the homepage map in generated pages.
  Both the original and derivative must match the recorded file hashes and
  decoded RGBA identity evidence. A changed source falls back to its original.
- Eligible embedded raster images become same-origin, SHA-256-named files.
  Their bytes are copied exactly, without resizing or recompression. Repeated
  images share a file across pages. Authored download files remain standalone.
- Generated homepage and domain card images use hash-named copies of their
  original bytes. Browser-private immutable caching prevents repeat transfers
  without making protected preview content publicly cacheable.
- Below-first embedded images use native lazy loading unless the author already
  selected a loading mode. First figures remain eager.
- Three explicitly reviewed Insight programs defer non-default view decoding.
  TBB also reuses its existing parsed payload. Arithmetic and array values are
  unchanged. A complete program hash mismatch preserves an unknown revision.

The generated `performance-report.json` records applied changes and skipped
programs. `docs/evidence/home-map-lossless.json` records pixel fidelity. Run
`scripts/optimize-home-map.py` with Pillow to reproduce the map derivative.

## Verification and limits

Automated coverage includes byte identity, numerical equality, lazy-view cache
behavior, unchanged unknown programs, image path safety, source-policy fallback,
local conditional requests, and preview-only cache rules. See
`docs/evidence/performance-20260930.json` for the source-snapshot audit.

Smaller HTML does not equal the same reduction in total cold-load traffic:
externalized images still need their first download. Subsequent pages and visits
can reuse them, and below-fold images can wait until needed. No fixed end-to-end
speed improvement is claimed without browser measurement.

The September 30 local browser inspection was denied by browser access approval.
Visual rendering and live interactions therefore remain an explicit acceptance
step; static and numerical checks do not substitute for that step.
