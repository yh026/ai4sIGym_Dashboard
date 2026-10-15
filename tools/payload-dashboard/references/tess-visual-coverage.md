# TESS visual coverage target

The reference is the 20-stage “TESS Objects of Interest — AIS5102 method spine” page. It contains 23 static composite figures and one Stage-14 canvas explorer. A payload is complete only when every figure, panel, layer, annotation, and interaction below is represented explicitly; artifact counts are not a substitute for figure coverage.

| Stage | Figure | Required panels and marks |
|---:|---|---|
| 00 | Transit question | transit geometry diagram; annotated brightness-versus-time line |
| 00 | Label taxonomy | disposition bars; adjudicated/open horizontal bars |
| 01 | Provenance | missingness horizontal bars; log-scale host-multiplicity bars |
| 02 | Quality control | rule-removal bars; retained-radius histogram with threshold rule and label |
| 03 | Structure | diverging correlation heatmap; mutual-information heatmap; log-scale uncertainty bars |
| 04 | Feature audit | implied-constant histogram; 100% stacked convention bars; before/after skew scatter with identity rule |
| 05 | Baseline | optimisation-loss line; labelled two-feature scatter with decision boundary |
| 06 | Preprocessing | log-scale native variance bars; two-series scree lines; per-feature boxplots |
| 07 | PCA diagnostics | scree bars plus cumulative line and threshold; loadings heatmap; vector correlation circle; three covariance-residual heatmaps |
| 08 | Geometry | sorted k-distance line with epsilon rule; density histogram; three metric-distance lines |
| 09 | Embedding sweep | 2×3 t-SNE/UMAP point small multiples with shared semantic colours |
| 10 | Embedding validation | trust/continuity curves and null rules; Shepard point cloud; seed-disparity bars |
| 11 | Partition comparison | three UMAP point panels coloured by k-means/HDBSCAN/DBSCAN assignment and noise |
| 12 | Soft assignment | max-responsibility histogram with threshold; responsibility-coloured UMAP; sorted responsibility heatmap |
| 13 | Partition validation A | silhouette/null lines; BIC line; grouped horizontal ARI/NMI bars |
| 13 | Partition validation B | paired horizontal silhouette bars; reproducibility bars |
| 14 | Vector quantisation A | distortion line; cluster-sorted design-matrix heatmap; planet-fraction bars with base-rate rule |
| 14 | Vector quantisation B | two-space reconstruction lines; excess-error bars; silhouette/ARI lines |
| 14 | Codeword explorer | canvas scatter, explicit space toggle, codebook-size slider, hover highlight/profile, deterministic summary fallback |
| 15 | Task setup | grouped/ungrouped leakage bars; stacked train/test class bars; split→impute→scale→fit flow diagram |
| 16 | Interpretable models | diverging coefficient bars; three ROC lines plus identity rule; train/held-out depth lines; full decision tree |
| 17 | Ensembles | held-out AUC bars; permutation-importance bars with error bars; labelled coefficient/importance scatter |
| 18 | Validation | CV bars with errors and null rules; learning curves with band; calibration line with identity rule; labelled confusion heatmap |
| 19 | Scientific close | grouped NMI bars; RA/Dec point map; yearly fraction line with base-rate rule |

## Coverage rules

- Preserve the 20 ordered accordion sections and 24 ordered figures: 23 static composites plus one controlled interactive.
- A figure is `Figure → Panel → Layer`; a composite PNG is never modelled as one undifferentiated artifact.
- Shared labels, scales, category order, and semantic colours are declared in the spec rather than inferred from field names.
- PCA, embedding sweeps, clustering comparisons, model validation, and vector-quantisation exploration may use versioned recipes. Other figures should remain explicit generic panel/layer specifications.
- Large point sets require an explicit canvas renderer or an upstream-declared sampled/aggregated display dataset. The renderer must not silently drop rows.
- Stage 00 geometry uses a controlled recipe or safe geometry primitives. Payload JavaScript, raw SVG, HTML, URLs, and callbacks are forbidden.

## First complete acceptance receipt

The compiler receipt must report `section_count: 20`, `figure_count: 24`, `interactive_figure_count: 1`, the exact panel/layer counts, zero unresolved references, and zero dropped or substituted marks. Browser verification must find no render-error node or console error and no network request.
