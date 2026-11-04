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
- Six further demos share byte-identical drawing code, fold controllers and CSS
  across their eighteen Insight, Dataset and Workflow pages: Battery Curve Shape,
  CEEMDAN, SOH, JAE, Pleiades and Superconductor. The reviewed resources use
  same-origin content hashes and browser-private caching. Classic scripts remain
  in their original execution order; script preloads begin in the head.
- Fifteen of those pages also defer folded matrix/table preparation or reuse
  fixed calculations. The other three retain their already-necessary startup
  work. No scientific payload text, precision or drawing formula is reduced.
- Air Quality and Singapore Road bypass the entire page optimizer, including
  nested resource pages, while they are being edited separately.

The generated `performance-report.json` records applied changes and skipped
programs. `docs/evidence/home-map-lossless.json` records pixel fidelity. Run
`scripts/optimize-home-map.py` with Pillow to reproduce the map derivative.

## Verification and limits

Automated coverage includes byte identity, numerical equality, lazy-view cache
behavior, unchanged unknown programs, image path safety, source-policy fallback,
local conditional requests, and preview-only cache rules. See
`docs/evidence/performance-20260930.json` for the source-snapshot audit.
The remaining-demo audit is recorded in
`docs/evidence/remaining-demo-performance-20260930.json`; real JAE/Pleiades
value comparisons are in `docs/evidence/astronomy-cell-startup-20260930.json`.

Smaller HTML does not equal the same reduction in total cold-load traffic:
externalized images still need their first download. Subsequent pages and visits
can reuse them, and below-fold images can wait until needed. No fixed end-to-end
speed improvement is claimed without browser measurement.

The September 30 local browser inspection was denied by browser access approval.
Visual rendering and live interactions therefore remain an explicit acceptance
step; static and numerical checks do not substitute for that step.

## MSK / CT Pattern Atlas video delivery

`lib/ct-pattern-atlas-video-assets.js` handles the `ct-pattern-atlas` Insight in
the same `optimizeSiteOutput` chain as TBB. Its authored HTML contains ordered
`application/octet-stream` script chunks and a JPEG poster on `video#film`.
The adapter recognizes the complete imported player by hash, decodes each
chunk separately, and writes byte-identical MP4/JPEG files under
`/assets/embedded/<sha256>.<extension>`. Unknown players, malformed media,
ambiguous markup, CSP meta policies and base URLs remain untouched.

The generated player has `preload="none"` and a `data-video-src` attribute;
it assigns `src` only after the Play button is clicked. The old chunk scripts
and decoder are removed from generated HTML. The source stays self-contained,
and the poster, video, narrative, CSS and other scripts retain their contents.
The TBB adapter and its matching rules are unchanged.

To build this demo independently of Drive/Registry, run
`node scripts/build-ct-pattern-atlas.cjs` from the repo root. It reads
`content/projects/ct-pattern-atlas/ct_pattern_atlas_insight.html`, runs the
normal delivery optimizer in a staging directory, and writes the result to
`.local/ct-pattern-atlas-site/`. The local build refuses to replace an
unrecognized output directory or complete without successful video extraction.
`build-info.json` records source/output hashes and media sizes;
`performance-report.json` records the transformation. Neither file is a
deployment receipt.

To serve the generated directory locally, run:

```sh
node -e "require('./scripts/preview-local.cjs').createServer('./.local/ct-pattern-atlas-site').listen(4176,'127.0.0.1')"
```

Open `http://127.0.0.1:4176/demos/ct-pattern-atlas/`. The existing local server
provides MP4 byte-range responses. The standalone build does not register the
demo, add homepage/navigation entries, edit Drive/Sheets, or deploy to Netlify.
Only Insight is currently available. The Registry bundle renders Dataset and
Workflow as Coming soon pages with shared project navigation.

The 2026-11-04 local build reduced HTML from 38,062,080 to 13,220 bytes, with a
28,418,149-byte MP4 and a 117,674-byte JPEG. Local browser checks observed only
HTML/poster requests before clicking, then an HTTP 206 MP4 response and working
playback/pause after clicking. Theme switching and justified text were retained;
23 focused media/performance tests passed. Local evidence is in
`.local/reviews/ct-pattern-atlas-20261104/external-video-verification.json`
and the accompanying browser/network records. These checks cover local output,
not a Preview or Production deployment.

On 2026-11-04, CT Pattern Atlas was registered as project 014 in the existing
Google Drive and Registry workflow. Drive folder `014-ct-pattern-atlas` holds
the intact offline `insight.html` and its byte-identical `card.jpg`. The draft
version is `ct-pattern-atlas-draft-v1`; its explicit source-file mount was
verified against Drive ancestry, sizes, MIME types and SHA-256 hashes. Dataset
and Workflow use empty Placeholder records, without fabricated source files.

The Registry compiler and installed Apps Script runtime accept HTML sources up
to 48 MiB, while binary resources retain their 25 MiB limit. The page transport
allows 64 MiB for the JSON envelope. Control-panel readers now use registered
IDs rather than a fixed thirteen-row range. The existing backend Web App was
updated to version 11 with the same URL and access settings.

Validation compiled all fourteen projects in memory without activating a new
snapshot. A local build of the cloud-validated CT bundle produced a 16,194-byte
Insight with navigation, two Coming soon pages and the existing media bytes.
Browser checks confirmed deferred video loading, successful playback after
Play and Insight/Dataset/Workflow round-trip navigation. A bounded video request
also verified HTTP 206 byte-range serving. The 119 relevant tests
passed. The new project's Preview and Production selections remain false;
no Netlify build hook or website deployment was requested. See
`docs/evidence/ct-pattern-atlas-onboarding-20261104.json` and the local evidence
directory recorded there for the verified source IDs and release-state checks.
