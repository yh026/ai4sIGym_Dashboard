These are exact, complete author scripts extracted from the six battery pages in
the 2026-09-30 preview baseline. Their complete SHA-256 hashes gate the transforms
in `lib/battery-startup-optimization.js`. They intentionally contain no copies of
the large scientific JSON payloads or images. A changed upstream program must be
reviewed before adding a new accepted hash.

- Curve Shape Insight: unchanged. Its only binary matrix is needed by the default
  main chart, so delaying it would delay the result.
- Curve Shape Dataset: decode the signed-byte matrix on the first heatmap or row
  request. Keep the original decoder, scale, row values, full dimensions, image
  smoothing setting and theme-specific heatmap cache.
- Curve Shape Workflow: decode the signed-byte matrix on the first `zAt` access,
  then use the original direct lookup and voltage reconstruction thereafter.
- SOH Insight: initialize the selected anchor and complete accessible data table
  without painting twice. The existing initial repaint draws the same default
  forecast. Subsequent anchor changes still draw immediately.
- SOH Dataset: preserve the complete accessible table even when the panel is
  closed, but replace its DOM only when the selected source series changes.
- SOH Workflow: calculate fixed training-window rows and fixed rollout MSE sweep
  statistics on first use and reuse them. The reviewed program only reads these
  derived results; input data and formulas are unchanged.

Tests compare signed-byte values, reconstructed floating-point values, heatmap
RGBA bytes, canvas drawing commands, table HTML, fixed training rows and MSE
statistics. Call counts verify deferred/reused work; no speed measurements or
benchmarks are included. Shared runtime delivery and caching are handled outside
this module. Air Quality and Singapore Road are outside its allowlist.
