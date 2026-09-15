#!/usr/bin/env python3
"""Materialize the real-data TESS visualization package.

This is a development-time reference builder.  The portable renderer remains
payload-only: its production input is the generated payload.json plus data/.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.metadata
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
KIT_ROOT = HERE.parents[1]
TEMPLATE_PAYLOAD = HERE.parent / "tess-reference-package" / "payload.json"
TESS_PRESENTATION = HERE / "tess-presentation.json"
EXPECTED_SOURCE_SHA256 = "56cf0e720c5a3a16e08cb2dd9cafd453662038e85fe7750135991f4805def20c"
SEED = 0
SCHEMATIC_RESOURCE_IDS = {
    "reference-one",
    "transit-bodies",
    "transit-orbit",
    "transit-motion",
    "transit-light-curve",
}

FEATURES = [
    "pl_orbper",
    "pl_trandurh",
    "pl_trandep",
    "pl_rade",
    "pl_insol",
    "st_tmag",
    "st_dist",
    "st_teff",
    "st_logg",
    "st_rad",
    "pm_total",
]
LOG_FEATURES = [
    "pl_orbper",
    "pl_trandurh",
    "pl_trandep",
    "pl_rade",
    "pl_insol",
    "st_dist",
    "st_rad",
    "pm_total",
]


# Presentation truth transcribed from the archived TESS dashboard and its
# payload.tess.json.  These strings describe the method and interpretation;
# numeric scientific arrays continue to come only from the recomputation.
TESS_ACTS = [
    {
        "id": "act-1",
        "numeral": "I",
        "title": "Frame",
        "short_label": "Frame",
        "section_ids": [f"stage-{number:02d}" for number in range(0, 6)],
    },
    {
        "id": "act-2",
        "numeral": "II",
        "title": "Reduce",
        "short_label": "Reduce",
        "section_ids": [f"stage-{number:02d}" for number in range(6, 11)],
    },
    {
        "id": "act-3",
        "numeral": "III",
        "title": "Partition",
        "short_label": "Partition",
        "section_ids": [f"stage-{number:02d}" for number in range(11, 15)],
    },
    {
        "id": "act-4",
        "numeral": "IV",
        "title": "Predict",
        "short_label": "Predict",
        "section_ids": [f"stage-{number:02d}" for number in range(15, 20)],
    },
]

TESS_STAGE_PRESENTATION: dict[int, dict[str, Any]] = {
    0: {
        "title": "Question and instrument",
        "short_label": "Question",
        "badge": "Ch 01",
        "summary": "State the falsifiable claim, explain the transit measurement, and expose the controlled label vocabulary before analysis.",
        "concepts": ["Ch 01 · supervised classification vs regression · features and labels · stating a claim that could be falsified"],
        "findings": ["2,242 of 7,372 TOIs are adjudicated; 5,130 remain open. The adjudicated sample contains 1,033 planets and 1,209 false positives."],
        "method_notes": ["Frames the scientific claim and counts TFOPWG dispositions on the raw archive table."],
        "caveats": ["The transit drawing is a schematic, not an observed system. Dispositions are human-curated labels that can change over time; they are not ground truth."],
    },
    1: {
        "title": "Provenance and design matrix", "short_label": "Provenance", "badge": "Ch 03, 09",
        "summary": "No feature exceeds 11% missingness; repeated host stars force the grouped split used later.",
        "concepts": ["Ch 03 · the design matrix as N × D · units and published uncertainties", "Ch 09 · missingness, and what each treatment assumes"],
        "findings": ["Transit duration and depth are complete. 225 host stars carry 2–5 TOIs, covering 513 rows whose stellar columns are shared."],
        "method_notes": ["Profiles missingness per feature and audits TOIs-per-host multiplicity using TIC ID."],
        "caveats": ["Published *err1/*err2 columns are uncertainty metadata, not model features."],
    },
    2: {
        "title": "Quality control", "short_label": "Quality control", "badge": "Ch 09",
        "summary": "Five stated physical rules remove 8 of 7,372 rows while preserving the large-radius false-positive population.",
        "concepts": ["Ch 09 · row deletion and its assumptions · duplicate detection · missingness mechanism"],
        "findings": ["The raw archive contains 49 objects larger than 30 R⊕. Radius is deliberately not a QC exclusion because these stellar companions belong to the false-positive class."],
        "method_notes": ["Sequential rules: duplicates; impossible duration; implausible host radius; implausible host temperature; missing disposition."],
        "caveats": ["No feature column is dropped here. The derived pl_eqt column is removed at Stage 04 after its processing-epoch convention is exposed."],
    },
    3: {
        "title": "Structure survey", "short_label": "Structure", "badge": "Ch 03, 04",
        "summary": "Compare linear, nonlinear, and measurement-level relationships before choosing a model geometry.",
        "concepts": ["Ch 03 · feature covariance · correlation between features", "Ch 04 · mutual information · dependence that correlation misses"],
        "findings": ["Reported precision spans roughly five orders of magnitude. Correlation and mutual information rank feature pairs differently, so both matrices are retained."],
        "method_notes": ["Reports Pearson correlation, plug-in mutual information with 16 quantile bins, and median archive-reported uncertainty as percent of the feature median."],
        "caveats": ["Median filling is used for this survey only; supervised stages impute inside folds. The MI diagonal is intentionally blank."],
    },
    4: {
        "title": "Feature engineering", "short_label": "Features", "badge": "Ch 03, 04, 09",
        "summary": "Remove the processing-epoch leak and apply log transforms to the eight heavy-tailed features.",
        "concepts": ["Ch 03 · collinearity, via centred rank", "Ch 09 · variance-stabilising log transform"],
        "findings": ["pl_eqt is dropped because its 255.0 K versus 278.5 K conversion convention reveals processing epoch and tracks the label. Log transforms reduce the dominant skews."],
        "method_notes": ["Audits the implied pl_eqt/pl_insol constant, centred rank, and before/after absolute skew."],
        "caveats": ["Derived ratio features are exact linear combinations in log space; they are withheld from the linear design and probed with trees later."],
    },
    5: {
        "title": "Baseline with a stated loss", "short_label": "Baseline", "badge": "Ch 05, 06, 07",
        "summary": "Use two features and a straight boundary as an interpretable lower bound.",
        "concepts": ["Ch 05 · Bernoulli negative log-likelihood · the minimised loss is not the reported metric", "Ch 06 · first-order gradient descent · watching an optimiser converge"],
        "findings": ["The two-feature optimiser converges, but one straight boundary cannot represent the non-monotonic false-positive rate across planet radius."],
        "method_notes": ["Minimises mean binary cross-entropy by batch gradient descent; reports balanced accuracy and ROC AUC in-sample."],
        "caveats": ["This is an in-sample baseline. Host-grouped validation appears at Stage 18."],
    },
    6: {
        "title": "Preprocessing decision", "short_label": "Preprocessing", "badge": "Ch 09",
        "summary": "Standardise columns so units do not determine the geometry, and refit the transform inside every later fold.",
        "concepts": ["Ch 09 · standardisation and robust scaling · column scaling versus row normalisation · scale-sensitive objectives"],
        "findings": ["Native-unit variance is highly uneven; standardisation redistributes PCA variance across several components instead of allowing one unit scale to dominate."],
        "method_notes": ["Compares covariance-PCA with correlation-PCA and inspects the standardised feature distributions."],
        "caveats": ["Standard scaling is used after the Stage 04 log transform and is refitted inside every validation fold."],
    },
    7: {
        "title": "Linear reduction and intrinsic dimension", "short_label": "Linear reduction", "badge": "Ch 08",
        "summary": "Choose the retained PCA dimension from cumulative variance and inspect what the components reconstruct.",
        "concepts": ["Ch 08 · scree plot · cumulative variance · loadings · correlation circle · low-rank covariance reconstruction"],
        "findings": ["Six components carry about 90% of the variance; residual maps show which covariance structure remains after L=2, 6, and 8."],
        "method_notes": ["Minimises squared reconstruction error by SVD; signs are arbitrary but the reconstructed covariance is not."],
        "caveats": ["PCA is fitted on all rows, including open candidates. Diverging colour domains must remain symmetric about zero."],
    },
    8: {
        "title": "Geometry and neighbourhoods", "short_label": "Geometry", "badge": "Ch 10",
        "summary": "Inspect neighbour distances before applying density- or neighbourhood-based algorithms.",
        "concepts": ["Ch 10 · Euclidean, Manhattan and cosine metrics · k-nearest-neighbour graph · k-distance · local density"],
        "findings": ["The k-distance curve rises smoothly and local density is unimodal: the sample is one connected cloud with a density gradient, not separated islands."],
        "method_notes": ["Reports distance to the 10th neighbour and reciprocal mean 10-NN distance; metric comparison uses a fixed 2,500-row subsample."],
        "caveats": ["Euclidean distance on standardised features is carried forward."],
    },
    9: {
        "title": "Non-linear cartography", "short_label": "Cartography", "badge": "Ch 11, 12",
        "summary": "Show the full t-SNE/UMAP hyperparameter sweep instead of selecting a visually convenient map.",
        "concepts": ["Ch 11 · t-SNE · perplexity · KL objective · Student-t kernel", "Ch 12 · UMAP · n_neighbors and min_dist · fuzzy cross-entropy"],
        "findings": ["Across all six settings the labels overlap with offset centres, while the apparent number of visual groups changes with the neighbourhood parameter."],
        "method_notes": ["t-SNE minimises symmetrised KL; UMAP minimises fuzzy cross-entropy. Both are local and seed-dependent."],
        "caveats": ["The sweep uses a 3,000-row seed-0 sample; the carried-forward UMAP uses all 7,364 rows. Colour is descriptive and was not used to fit the embedding."],
    },
    10: {
        "title": "Embedding validation", "short_label": "Embedding check", "badge": "Ch 13",
        "summary": "Score neighbourhood preservation, global distance fidelity, and seed stability rather than judging maps by eye.",
        "concepts": ["Ch 13 · trustworthiness · continuity · Shepard diagram · Procrustes across seeds · local versus global quality"],
        "findings": ["All declared embeddings beat the random-projection null, but exact map positions vary with seed; downstream partitioning therefore stays in feature space."],
        "method_notes": ["Reports trustworthiness, continuity, Spearman correlation of pairwise distances, and Procrustes disparity."],
        "caveats": ["Metrics use the declared 3,000-row sample with 1,500-point internal sampling; stability uses seeds 0, 1, and 2."],
    },
    11: {
        "title": "Partition", "short_label": "Partition", "badge": "Ch 14, 16, 17",
        "summary": "Compare centroid and density partitions in the same 11-D standardised space.",
        "concepts": ["Ch 14 · k-means · WCSS · Lloyd's algorithm", "Ch 16 · DBSCAN · epsilon · noise", "Ch 17 · HDBSCAN · cluster stability · unassigned points"],
        "findings": ["k-means divides the continuous cloud; density methods leave substantial regions unassigned, consistent with the smooth density profile at Stage 08."],
        "method_notes": ["Fits all methods in 11-D and uses UMAP only as a drawing surface."],
        "caveats": ["Noise is always the same neutral grey; cluster identifiers are partitions, not scientific classes."],
    },
    12: {
        "title": "Soft assignment", "short_label": "Soft assignment", "badge": "Ch 18, 19",
        "summary": "Expose mixture confidence and responsibility structure instead of presenting hard labels alone.",
        "concepts": ["Ch 18 · EM as alternating maximisation", "Ch 19 · Gaussian mixtures · responsibilities · BIC"],
        "findings": ["Low maximum responsibility is concentrated on component boundaries; high confidence describes the fitted density model, not proof of natural classes."],
        "method_notes": ["Minimises mixture negative log-likelihood by EM with four full-covariance components and three restarts."],
        "caveats": ["The displayed responsibility matrix is deterministically thinned for legibility."],
    },
    13: {
        "title": "Partition validation", "short_label": "Partition check", "badge": "Ch 20",
        "summary": "Separate internal compactness, external label agreement, and reproducibility across samples and seeds.",
        "concepts": ["Ch 20 · silhouette · adjusted Rand index · normalised mutual information · resampling stability"],
        "findings": ["The partitions are reproducible but agree weakly with planet/false-positive dispositions; embedding-space compactness does not justify clustering in the map."],
        "method_notes": ["Reports silhouette against a shuffled-feature null, GMM BIC, ARI/NMI, and seed/resampling agreement."],
        "caveats": ["Dispositions are external labels, not cluster ground truth. Silhouette and BIC use the declared 3,000-row sample."],
    },
    14: {
        "title": "Vector quantization", "short_label": "Vector quantization", "badge": "Ch 15",
        "summary": "Treat codewords as a compact description of a continuous distribution, not as recovered classes.",
        "concepts": ["Ch 15 · codebook · distortion against codebook size · reduced-space versus original-space quantisation"],
        "findings": ["Distortion decreases without a sharp elbow. Codewords can be enriched for planets without being pure; the shipped codebook remains PCA-6."],
        "method_notes": ["Minimises expected Lloyd/LBG distortion and reports reconstruction error in the original 11-D standardised space."],
        "caveats": ["Dense heatmaps are deterministically sampled for display. The explorer itself contains all declared points; repeated colours at large k do not imply identical codewords."],
    },
    15: {
        "title": "Task setup and leakage control", "short_label": "Task setup", "badge": "Ch 22, 09",
        "summary": "Hold out complete host stars and keep every learned preprocessing step inside the fold-local pipeline.",
        "concepts": ["Ch 09 · fitting every transform on training data only", "Ch 22 · stratification · group leakage · preprocessing leakage · pipelines"],
        "findings": ["An ordinary stratified split repeats host stars across train and test; grouping by TIC ID removes that leakage while preserving class balance."],
        "method_notes": ["Compares grouped and ungrouped splits, then enforces split → impute → scale → fit."],
        "caveats": ["The classes are close to balanced, so no resampling is applied."],
    },
    16: {
        "title": "Interpretable models", "short_label": "Interpretable", "badge": "Ch 21, 23",
        "summary": "Compare readable linear coefficients, a curved polynomial boundary, and a shallow decision tree.",
        "concepts": ["Ch 21 · logistic regression · convex NLL · nonlinear transformed features", "Ch 23 · CART · depth as the complexity control · overfitting"],
        "findings": ["Radius dominates the linear model while depth enters with the opposite sign; nonlinear terms improve discrimination, and deeper trees increasingly memorise training rows."],
        "method_notes": ["Logistic regression minimises cross-entropy; CART greedily minimises node impurity."],
        "caveats": ["One grouped split is shown for readability; fold-level error bars appear at Stage 18."],
    },
    17: {
        "title": "Ensembles", "short_label": "Ensembles", "badge": "Ch 24",
        "summary": "Measure the predictive gain bought by bagging and boosting against the loss of a single readable model.",
        "concepts": ["Ch 24 · bagging as a random forest · gradient boosting · accuracy bought against interpretability"],
        "findings": ["Tree ensembles improve held-out AUC over the linear model; permutation importance and coefficients both identify radius as a leading feature."],
        "method_notes": ["Random forest uses 400 trees; permutation importance is the mean held-out AUC drop over 15 shuffles."],
        "caveats": ["Correlated features share permutation credit, so importance is not a causal attribution."],
    },
    18: {
        "title": "Model validation and controls", "short_label": "Validation", "badge": "Ch 22, 20",
        "summary": "Use host-grouped folds, learning curves, calibration, and row-normalised errors to test generalisation.",
        "concepts": ["Ch 22 · k-fold cross-validation · confusion matrix · learning curve · bias and variance"],
        "findings": ["The best ensemble beats both majority-class and permuted-label controls; the held-out learning curve is still rising at the largest training size."],
        "method_notes": ["Reports five-fold host-grouped balanced accuracy with standard error and a 12-repeat permuted-label null."],
        "caveats": ["Calibration and the confusion matrix use the single grouped held-out split from Stage 15."],
    },
    19: {
        "title": "Back to the science", "short_label": "Back to science", "badge": "Ch 01",
        "summary": "Return to the Stage 00 claim, its telescope-time value, and the limits of extending it to open candidates.",
        "concepts": ["Ch 01 · returning to the claim · what would falsify it"],
        "findings": ["Sky position carries little cluster information; the strongest label association recovers the Stage 04 processing-epoch convention. The result is a triage rule whose value is telescope time."],
        "method_notes": ["Reports normalised mutual information against metadata and yearly adjudicated planet fraction."],
        "caveats": ["Open candidates were not selected for follow-up at random. Sector, camera, CCD, and source-pipeline identifiers are absent and should be acquired before extension."],
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Path to the verified TOI source snapshot")
    parser.add_argument("--output", type=Path, default=HERE)
    return parser.parse_args()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def qc_rows(raw: pd.DataFrame) -> tuple[pd.DataFrame, list[int]]:
    current = raw.copy()
    counts: list[int] = []

    masks = [
        current.duplicated(keep="first"),
        current["pl_trandurh"].notna()
        & current["pl_orbper"].notna()
        & ((current["pl_trandurh"] / 24.0) >= current["pl_orbper"]),
        current["st_rad"].gt(100).fillna(False),
        current["st_teff"].gt(20_000).fillna(False),
        current["tfopwg_disp"].isna()
        | current["tfopwg_disp"].astype("string").str.strip().eq("").fillna(False),
    ]
    for mask in masks:
        aligned = mask.reindex(current.index, fill_value=False)
        counts.append(int(aligned.sum()))
        current = current.loc[~aligned].copy()
    current = current.reset_index(drop=True)
    if counts != [0, 0, 1, 5, 2] or len(current) != 7_364:
        raise RuntimeError(f"QC contract drift: counts={counts}, rows={len(current)}")
    return current, counts


def object_id(value: Any) -> str:
    numeric = float(value)
    return f"TOI-{numeric:.2f}".rstrip("0").rstrip(".")


def prepare_state(source: Path) -> dict[str, Any]:
    source_hash = file_sha256(source)
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            f"Unexpected TOI snapshot SHA-256: {source_hash}; expected {EXPECTED_SOURCE_SHA256}"
        )
    raw = pd.read_csv(source, comment="#")
    if raw.shape != (7_372, 65):
        raise RuntimeError(f"Unexpected TOI shape: {raw.shape}")
    clean, qc_counts = qc_rows(raw)

    feature_frame = clean[
        [name for name in FEATURES if name != "pm_total"]
    ].copy()
    feature_frame["pm_total"] = np.hypot(clean["st_pmra"], clean["st_pmdec"])
    feature_frame = feature_frame[FEATURES]

    model_frame = feature_frame.copy()
    for name in LOG_FEATURES:
        positive = model_frame[name] > 0
        model_frame.loc[positive, name] = np.log10(model_frame.loc[positive, name])
        model_frame.loc[~positive & model_frame[name].notna(), name] = np.nan

    imputer = SimpleImputer(strategy="median")
    x_imputed = imputer.fit_transform(model_frame)
    scaler = StandardScaler()
    x_scaled = scaler.fit_transform(x_imputed)
    pca = PCA(n_components=len(FEATURES), svd_solver="full")
    pca_scores = pca.fit_transform(x_scaled)

    disposition_map = {
        "KP": "Planet",
        "CP": "Planet",
        "FP": "False_positive",
        "FA": "False_positive",
        "PC": "Open",
        "APC": "Open",
    }
    dispositions = clean["tfopwg_disp"].map(disposition_map).to_numpy(dtype=str)
    if set(dispositions) != {"Planet", "False_positive", "Open"}:
        raise RuntimeError(f"Unexpected disposition mapping: {set(dispositions)}")

    return {
        "raw": raw,
        "clean": clean,
        "feature_frame": feature_frame,
        "model_frame": model_frame,
        "X_imputed": x_imputed,
        "X_scaled": x_scaled,
        "imputer": imputer,
        "scaler": scaler,
        "pca": pca,
        "pca_scores": pca_scores,
        "feature_names": FEATURES,
        "log_features": LOG_FEATURES,
        "disposition_labels": dispositions,
        "object_ids": [object_id(value) for value in clean["toi"]],
        "host_ids": clean["tid"].astype(str).to_numpy(),
        "qc_counts": qc_counts,
        "source": source,
        "source_sha256": source_hash,
        "seed": SEED,
    }


def plain(value: Any) -> Any:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, np.ndarray, pd.Series)):
        return [plain(item) for item in value]
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"Non-finite value in generated data: {value}")
    if value is pd.NA:
        return None
    return value


def stable_json(value: Any, *, pretty: bool = False) -> bytes:
    options: dict[str, Any] = {
        "ensure_ascii": False,
        "allow_nan": False,
        "sort_keys": True,
    }
    if pretty:
        options["indent"] = 2
    else:
        options["separators"] = (",", ":")
    return (json.dumps(plain(value), **options) + "\n").encode("utf-8")


def write_resource(output: Path, resource: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    rows = plain(rows)
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{resource['id']}: expected non-empty row list")
    field_names = [field["name"] for field in resource["fields"]]
    expected = set(field_names)
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or set(row) != expected:
            raise ValueError(
                f"{resource['id']} row {index}: fields {sorted(row) if isinstance(row, dict) else type(row)}; "
                f"expected {sorted(expected)}"
            )

    data_dir = output / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    if len(rows) > 2_000:
        relative = f"data/{resource['id']}.jsonl.gz"
        raw = b"".join(stable_json(row) for row in rows)
        content = gzip.compress(raw, compresslevel=9, mtime=0)
        storage = {
            "kind": "sidecar",
            "path": relative,
            "format": "jsonl",
            "compression": "gzip",
            "sha256": hashlib.sha256(content).hexdigest(),
            "rows": len(rows),
            "bytes": len(content),
        }
    else:
        relative = f"data/{resource['id']}.json"
        content = stable_json(rows, pretty=True)
        storage = {
            "kind": "sidecar",
            "path": relative,
            "format": "json",
            "compression": "none",
            "sha256": hashlib.sha256(content).hexdigest(),
            "rows": len(rows),
            "bytes": len(content),
        }
    (output / relative).write_bytes(content)
    resource["storage"] = storage
    if resource["id"] == "reference-one":
        resource["description"] = (
            "A deterministic one-row rendering anchor; it carries no scientific observation."
        )
    elif resource["id"] in SCHEMATIC_RESOURCE_IDS:
        resource["description"] = (
            "Deterministic transit schematic geometry; this is an explanatory diagram, not an observed system."
        )
    else:
        resource["description"] = (
            "Deterministically derived from the verified 2025-02-03 NASA TOI snapshot."
        )


def remove_illustrative_language(value: Any) -> Any:
    phrase = "Controlled illustrative data for renderer acceptance; values are not reconstructed TESS scientific results."
    if isinstance(value, str):
        return value.replace(f" {phrase}", "").replace(phrase, "")
    if isinstance(value, list):
        return [remove_illustrative_language(item) for item in value]
    if isinstance(value, dict):
        return {key: remove_illustrative_language(item) for key, item in value.items()}
    return value


def load_tess_presentation() -> dict[int, dict[str, Any]]:
    """Load the archived Stage copy, with the hand-authored map as fallback."""

    if not TESS_PRESENTATION.exists():
        return plain(TESS_STAGE_PRESENTATION)
    document = json.loads(TESS_PRESENTATION.read_text(encoding="utf-8"))
    stages = document.get("stages")
    if not isinstance(stages, dict) or set(stages) != {
        f"{number:02d}" for number in range(20)
    }:
        raise ValueError(
            f"{TESS_PRESENTATION}: expected exact stage keys 00 through 19"
        )
    presentation: dict[int, dict[str, Any]] = {}
    required = {
        "number",
        "title",
        "short_label",
        "badge",
        "concepts",
        "findings",
        "method_notes",
        "caveats",
    }
    for number in range(20):
        item = stages[f"{number:02d}"]
        if not isinstance(item, dict) or not required.issubset(item):
            raise ValueError(
                f"{TESS_PRESENTATION}: stage {number:02d} lacks archived copy fields"
            )
        if int(item["number"]) != number:
            raise ValueError(
                f"{TESS_PRESENTATION}: stage key {number:02d} disagrees with number"
            )
        presentation[number] = plain(item)
    return presentation


def package_metadata(payload: dict[str, Any], state: dict[str, Any]) -> None:
    payload["report"].update(
        {
            "title": "TESS Objects of Interest — AIS5102 method spine",
            "subtitle": "NASA Exoplanet Archive TOI table · TESS photometer (four 24°×24° cameras, 27-day sectors) · snapshot 2025-02-03 06:18:31 UTC · NASA data, public domain",
            "summary": "A 20-stage, payload-driven recomputation of the archived TESS scientific narrative from the verified source table.",
            "claim": "Transit shape and host-star parameters can separate astrophysical false positives from genuine planets without using the light curve.",
            "facts": [
                {"label": "N × D", "value": "7,364 × 11"},
                {"label": "Shape family", "value": "wide-ish table, N ≫ D"},
                {"label": "Ground truth", "value": "none"},
                {"label": "Labels", "value": "2,239 adjudicated"},
                {"label": "Acquisition metadata", "value": "dates, sky position, brightness"},
                {"label": "Rows dropped by QC", "value": 8},
            ],
            "final_verdict": "Recomputed reference package; stochastic and library-version differences are disclosed rather than hidden.",
        }
    )
    payload["acts"] = plain(TESS_ACTS)
    payload["theme"].update(
        {
            "palette": "colorblind-safe",
            "semantic_colors": {
                "Planet": "#009E73",
                "False_positive": "#D55E00",
                "Open": "#9AA1AB",
                "PC": "#9AA1AB",
                "APC": "#9AA1AB",
                "FP": "#D55E00",
                "FA": "#D55E00",
                "KP": "#009E73",
                "CP": "#009E73",
                "Adjudicated": "#0072B2",
                "Star": "#E69F00",
                "Motion": "#0072B2",
                "Orbit": "#9AA1AB",
                "noise": "#9AA1AB",
                "Observed": "#0072B2",
                "Shuffled-feature-null": "#9AA1AB",
                "Train": "#E69F00",
                "Held-out": "#0072B2",
                "Native": "#D55E00",
                "Standardised": "#0072B2",
                "Euclidean": "#0072B2",
                "Manhattan": "#E69F00",
                "Cosine": "#CC79A7",
                "PCA-6": "#0072B2",
                "PCA-6-to-UMAP-2": "#D55E00",
                "ink": "#16181D",
                "uncertainty": "#CC79A7",
                "value-label": "#FFFFFF",
                "StarFill": "#E9B949",
                "StarRing": "#DCA834",
                "PlanetOutline": "#7C838D",
                "PlanetFill1": "#A3A8AE",
                "PlanetFill2": "#90969E",
                "PlanetFill3": "#727984",
                "PlanetFill4": "#90969E",
                "PlanetFill5": "#A3A8AE",
            },
        }
    )
    payload["run"] = {
        "id": "tess-real-package",
        "label": "TESS real-data visualization package",
        "status": "complete",
        "seed": SEED,
        "notes": "Scientific arrays were recomputed in the existing ais5102 environment.",
    }
    payload["dataset"].update(
        {
            "id": "tess-toi-2025-02-03",
            "title": "NASA Exoplanet Archive TESS Objects of Interest",
            "description": "Verified NASA TOI snapshot after the five declared QC rules.",
            "row_count": 7_364,
            "feature_count": 11,
            "target": "tfopwg_disp",
        }
    )
    packages = [
        "numpy",
        "pandas",
        "scipy",
        "scikit-learn",
        "umap-learn",
        "hdbscan",
    ]
    versions = {name: importlib.metadata.version(name) for name in packages}
    payload["provenance"] = {
        "generator": {"name": "build-real-tess-payload", "version": "1.0.0"},
        "inputs": [
            {
                "id": "toi-2025-02-03",
                "kind": "dataset",
                "description": f"TOI_2025.02.03_06.18.31.csv; sha256 {state['source_sha256']}",
            },
            *(
                [
                    {
                        "id": "tess-archived-presentation",
                        "kind": "configuration",
                        "digest": file_sha256(TESS_PRESENTATION),
                        "description": "Stage copy extracted from the archived TESS saved_resource.html.",
                    }
                ]
                if TESS_PRESENTATION.exists()
                else []
            ),
        ],
        "notes": f"seed={SEED}; QC 7372→7364; runtime versions {json.dumps(versions, sort_keys=True)}",
    }
    exact_presentation = load_tess_presentation()
    for section in payload["sections"]:
        number = int(section["number"])
        stage_spec = exact_presentation[number]
        section["summary"] = TESS_STAGE_PRESENTATION[number]["summary"]
        for field in (
            "title",
            "short_label",
            "badge",
            "concepts",
            "findings",
            "method_notes",
            "caveats",
        ):
            section[field] = plain(stage_spec[field])
        section["caveats"].append(
            "Recomputed from the verified source snapshot; stochastic layouts may differ from the archived PNG while preserving the declared method."
        )
        if number == 0:
            section["figure_position"] = "after_findings"


def align_real_data_spec(
    payload: dict[str, Any],
    rows_by_id: dict[str, list[dict[str, Any]]],
    unsupervised_context: dict[str, Any],
    state: dict[str, Any],
) -> None:
    """Replace historical display constants with values from this recomputation."""

    resource = next(
        item for item in payload["data"] if item["id"] == "baseline-two-feature"
    )
    field = next(item for item in resource["fields"] if item["name"] == "period_log")
    field["name"] = "radius_log"

    baseline = next(
        item for item in payload["figures"] if item["id"] == "stage05-baseline"
    )
    decision = next(item for item in baseline["panels"] if item["id"] == "decision")
    objects = next(item for item in decision["layers"] if item["id"] == "objects")
    objects["encoding"]["x"]["field"] = "radius_log"
    objects["encoding"]["x"]["axis"]["title"] = (
        "Standardised log10 planet radius (Earth radii)"
    )
    objects["encoding"]["y"]["axis"]["title"] = (
        "Standardised log10 transit depth"
    )

    quality = next(
        item for item in payload["figures"] if item["id"] == "stage02-quality-control"
    )
    retained = next(item for item in quality["panels"] if item["id"] == "retained-radius")
    threshold_label = next(
        item for item in retained["layers"] if item["id"] == "threshold-label"
    )
    threshold_label["encoding"]["text"]["value"] = "30 R_earth · 48 retained"
    threshold_label["encoding"]["y"]["value"] = 0.94 * max(
        row["count"] for row in rows_by_id["retained-radius-histogram"]
    )

    feature_audit = next(
        item for item in payload["figures"] if item["id"] == "stage04-feature-audit"
    )
    skew_panel = next(
        item for item in feature_audit["panels"] if item["id"] == "skew"
    )
    identity = next(
        item for item in skew_panel["layers"] if item["id"] == "identity"
    )
    skew_rows = rows_by_id["skew-before-after"]
    skew_low = min(0.0, *(min(row["before"], row["after"]) for row in skew_rows))
    skew_high = max(max(row["before"], row["after"]) for row in skew_rows)
    skew_padding = 0.02 * max(1.0, skew_high - skew_low)
    identity["encoding"]["x"]["value"] = skew_low - skew_padding
    identity["encoding"]["y"]["value"] = skew_low - skew_padding
    identity["encoding"]["x2"]["value"] = skew_high + skew_padding
    identity["encoding"]["y2"]["value"] = skew_high + skew_padding

    epsilon = float(unsupervised_context["dbscan_epsilon"])
    geometry = next(
        item for item in payload["figures"] if item["id"] == "stage08-geometry"
    )
    k_distance = next(
        item for item in geometry["panels"] if item["id"] == "k-distance"
    )
    k_distance["title"] = "Sorted 10th-nearest-neighbour distance"
    distance_line = next(
        item for item in k_distance["layers"] if item["id"] == "distance-line"
    )
    distance_line["encoding"]["y"]["axis"]["title"] = (
        "10th-nearest-neighbour distance"
    )
    epsilon_rule = next(
        item for item in k_distance["layers"] if item["id"] == "epsilon"
    )
    epsilon_rule["encoding"]["y"]["value"] = epsilon

    partition = next(
        item
        for item in payload["figures"]
        if item["id"] == "stage11-partition-comparison"
    )
    dbscan = next(
        item for item in partition["panels"] if item["id"] == "dbscan-overlay"
    )
    dbscan["title"] = f"DBSCAN · epsilon {epsilon:.3f}"

    embedding_validation = next(
        item
        for item in payload["figures"]
        if item["id"] == "stage10-embedding-validation"
    )
    shepard = next(
        item for item in embedding_validation["panels"] if item["id"] == "shepard"
    )
    shepard["title"] = (
        f"Shepard diagram · Spearman rho = {float(unsupervised_context['shepard_spearman']):.3f}"
    )
    quality = next(
        item
        for item in embedding_validation["panels"]
        if item["id"] == "neighbourhood-quality"
    )
    random_null = next(
        item for item in quality["layers"] if item["id"] == "random-null"
    )
    random_null["encoding"]["y"]["value"] = float(
        unsupervised_context["random_projection_null"]
    )

    soft_assignment = next(
        item
        for item in payload["figures"]
        if item["id"] == "stage12-soft-assignment"
    )
    max_responsibility = next(
        item
        for item in soft_assignment["panels"]
        if item["id"] == "max-responsibility"
    )
    responsibility_label = next(
        item
        for item in max_responsibility["layers"]
        if item["id"] == "threshold-label"
    )
    below = int(unsupervised_context["gmm_below_0_6"])
    clean_rows = len(rows_by_id["responsibility-map"])
    responsibility_label["encoding"]["y"]["value"] = 0.94 * max(
        row["count"] for row in rows_by_id["max-responsibility-histogram"]
    )
    responsibility_label["encoding"]["text"]["value"] = (
        f"{below:,} below 0.6 ({100.0 * below / clean_rows:.1f}%)"
    )

    validation = next(
        item
        for item in payload["figures"]
        if item["id"] == "stage13-partition-validation-a"
    )
    bic_panel = next(item for item in validation["panels"] if item["id"] == "bic")
    bic_rows = rows_by_id["gmm-bic"]
    best_k = int(min(bic_rows, key=lambda row: row["bic"])["k"])
    largest_k = int(max(row["k"] for row in bic_rows))
    bic_panel["title"] = (
        f"BIC minimum at range edge (k={best_k})"
        if best_k == largest_k
        else f"BIC minimum at k={best_k}"
    )

    labels = np.asarray(state["disposition_labels"], dtype=object)
    planet_count = int(np.sum(labels == "Planet"))
    false_positive_count = int(np.sum(labels == "False_positive"))
    adjudicated_base_rate = planet_count / (planet_count + false_positive_count)
    for figure_id, panel_id in (
        ("stage14-vector-quantisation-a", "planet-fraction"),
        ("stage19-scientific-close", "time"),
    ):
        figure = next(
            item for item in payload["figures"] if item["id"] == figure_id
        )
        panel = next(item for item in figure["panels"] if item["id"] == panel_id)
        base_rate = next(
            item for item in panel["layers"] if item["id"] == "base-rate"
        )
        base_rate["encoding"]["y"]["value"] = adjudicated_base_rate

    validation_figure = next(
        item for item in payload["figures"] if item["id"] == "stage18-validation"
    )
    cv_panel = next(
        item for item in validation_figure["panels"] if item["id"] == "cv"
    )
    majority = next(
        item for item in cv_panel["layers"] if item["id"] == "majority"
    )
    majority["encoding"]["y"]["value"] = 0.5

    structure = next(
        item for item in payload["sections"] if item["id"] == "stage-03"
    )
    structure["caveats"].append(
        "pl_insol has no reported lower or upper uncertainty and pm_total is derived, so the archive-error panel shows the nine directly published uncertainty summaries and invents no value."
    )

    transit_section = next(
        item for item in payload["sections"] if item["id"] == "stage-00"
    )
    transit_section["caveats"].append(
        "The transit geometry and light curve are explanatory schematic marks; the disposition taxonomy beside them is counted from the source table."
    )

    validation_section = next(
        item for item in payload["sections"] if item["id"] == "stage-18"
    )
    validation_section["summary"] = (
        "Use host-grouped folds, learning curves, calibration, and row-normalised errors to test generalisation without host leakage."
    )

    configure_tess_visual_spec(payload, rows_by_id)
    random_forest = next(
        row for row in rows_by_id["cv-scores"] if row["model"] == "Random forest"
    )
    half_interval = 0.5 * (random_forest["upper"] - random_forest["lower"])
    payload["report"]["final_verdict"] = (
        "Stage 19 verdict: supported on adjudicated TOIs under host-grouped "
        f"validation (random forest balanced accuracy {random_forest['mean']:.3f} "
        f"± {half_interval:.3f}); this is a triage result, not ground truth for "
        "the still-open candidates."
    )


def _figure(payload: dict[str, Any], figure_id: str) -> dict[str, Any]:
    return next(figure for figure in payload["figures"] if figure["id"] == figure_id)


def _panel(
    payload: dict[str, Any], figure_id: str, panel_id: str
) -> dict[str, Any]:
    figure = _figure(payload, figure_id)
    return next(panel for panel in figure["panels"] if panel["id"] == panel_id)


def _layer(panel: dict[str, Any], layer_id: str) -> dict[str, Any]:
    return next(layer for layer in panel["layers"] if layer["id"] == layer_id)


def _upsert_scale(figure: dict[str, Any], scale: dict[str, Any]) -> None:
    scales = figure.setdefault("scales", [])
    for index, current in enumerate(scales):
        if current["id"] == scale["id"]:
            scales[index] = plain(scale)
            return
    scales.append(plain(scale))


def _upsert_layer(panel: dict[str, Any], layer: dict[str, Any]) -> None:
    for index, current in enumerate(panel["layers"]):
        if current["id"] == layer["id"]:
            panel["layers"][index] = plain(layer)
            return
    panel["layers"].append(plain(layer))


def _bind_scale(layer: dict[str, Any], scale_id: str, *channels: str) -> None:
    for name in channels:
        channel = layer.get("encoding", {}).get(name)
        if channel is not None:
            channel["scale_id"] = scale_id


def _set_panel_display(
    panel: dict[str, Any],
    *,
    aspect_ratio: float | None = None,
    column_span: int | None = None,
    row_span: int | None = None,
) -> None:
    display = panel.setdefault("display", {})
    if aspect_ratio is not None:
        display["aspect_ratio"] = aspect_ratio
    if column_span is not None:
        display["column_span"] = column_span
    if row_span is not None:
        display["row_span"] = row_span


def _set_figure_layout(
    payload: dict[str, Any],
    figure_id: str,
    *,
    columns: int,
    column_weights: list[float],
    rows: int | None = None,
) -> None:
    layout = _figure(payload, figure_id)["layout"]
    layout["type"] = "grid"
    layout["columns"] = columns
    layout["column_weights"] = column_weights
    if rows is None:
        layout.pop("rows", None)
    else:
        layout["rows"] = rows


def configure_tess_visual_spec(
    payload: dict[str, Any], rows_by_id: dict[str, list[dict[str, Any]]]
) -> None:
    """Align declarative presentation with the archived TESS figures.

    This function changes titles, scales, encodings, and layout intent only.
    Scientific row values remain owned by the verified sidecars.
    """

    # Stage narrative already carries the explanatory prose.  The reference
    # fixture's one-line captions/descriptions would only repeat figure titles.
    for figure in payload["figures"]:
        figure.pop("caption", None)
        figure.pop("description", None)

    # Discrete sweeps expose each computed observation as a visible line node.
    # Dense trajectories (loss, k-distance, ROC, and raw light curves) remain
    # line-only so the page does not turn thousands of samples into visual noise.
    line_point_layers = (
        ("stage06-preprocessing", "scree-comparison", "scree-lines"),
        ("stage10-embedding-validation", "neighbourhood-quality", "quality-curves"),
        ("stage13-partition-validation-a", "silhouette", "curves"),
        ("stage13-partition-validation-a", "bic", "bic-line"),
        ("stage14-vector-quantisation-a", "distortion", "distortion-line"),
        ("stage14-vector-quantisation-b", "reconstruction", "reconstruction-lines"),
        ("stage14-vector-quantisation-b", "map-agreement", "agreement-lines"),
        ("stage16-interpretable-models", "depth-sweep", "depth-lines"),
        ("stage18-validation", "learning", "learning-lines"),
        ("stage19-scientific-close", "time", "fraction-line"),
    )
    for figure_id, panel_id, layer_id in line_point_layers:
        mark = _layer(_panel(payload, figure_id, panel_id), layer_id)["mark"]
        mark["point"] = True
        mark["point_size"] = 2.6

    panel_titles = {
        "stage00-transit-question": {
            "transit-geometry": "the planet crosses the star's disc",
            "transit-brightness": "…and TESS records only this: brightness against time",
        },
        "stage00-label-taxonomy": {
            "disposition-counts": "TFOPWG disposition",
            "adjudication-status": "supervised task is only the adjudicated half",
        },
        "stage01-provenance": {
            "missingness": "missingness per column",
            "host-multiplicity": "a row is a signal, not a star",
        },
        "stage02-quality-control": {
            "rule-removals": "QC rules, and what each removed",
            "retained-radius": "what we deliberately did not drop",
        },
        "stage03-structure": {
            "correlation": "correlation (standardised covariance)",
            "mutual-information": "mutual information [nats]",
            "uncertainty": "measured noise, from the archive's own error bars",
        },
        "stage04-feature-audit": {
            "implied-constant": "one column, two conventions",
            "conventions": "…and the convention tracks the label",
            "skew": "the log transform is what actually matters",
        },
        "stage05-baseline": {
            "loss": "the optimiser converging",
            "decision": "two features, one straight line",
        },
        "stage06-preprocessing": {
            "native-variance": "unscaled: one column would own the PCA",
            "scree-comparison": "the choice changes the answer",
            "feature-boxplots": "standardised design matrix",
        },
        "stage08-geometry": {
            "k-distance": "k-distance curve",
            "density": "density is smooth and unimodal",
            "metric-comparison": "metric choice (n=2,500 subsample)",
        },
        "stage10-embedding-validation": {
            "neighbourhood-quality": "quality against neighbourhood size",
            "shepard": "Shepard diagram",
            "seed-reproducibility": "reproducibility across seeds",
        },
        "stage11-partition-comparison": {
            "kmeans-overlay": "k-means, k=4",
            "hdbscan-overlay": "HDBSCAN",
            "dbscan-overlay": "DBSCAN",
        },
        "stage12-soft-assignment": {
            "max-responsibility": "how confident is the mixture?",
            "responsibility-map": "ambiguity is on the boundaries",
            "responsibility-heatmap": "the responsibility matrix",
        },
        "stage14-vector-quantisation-a": {
            "distortion": "distortion versus codebook size",
            "design-matrix": "design matrix, cluster-sorted",
            "planet-fraction": "codewords are not classes",
        },
        "stage14-codeword-explorer": {
            "codeword-map": "codeword map",
            "codeword-profile": "hovered codeword feature profile",
        },
        "stage19-scientific-close": {
            "confounders": "confounder check, every metadata column",
            "sky": "clusters are not a patch of sky",
            "time": "the sample is not stationary in time",
        },
    }
    for figure_id, titles in panel_titles.items():
        for panel_id, title in titles.items():
            _panel(payload, figure_id, panel_id)["title"] = title

    layouts = {
        "stage00-transit-question": (2, [0.43, 0.57], None),
        "stage00-label-taxonomy": (2, [0.62, 0.38], None),
        "stage01-provenance": (2, [1.08, 0.92], None),
        "stage02-quality-control": (2, [1.55, 1.0], None),
        "stage03-structure": (3, [1.0, 1.0, 1.08], None),
        "stage04-feature-audit": (3, [1.0, 1.0, 1.0], None),
        "stage05-baseline": (2, [1.0, 1.2], None),
        "stage06-preprocessing": (3, [1.1, 1.0, 1.05], None),
        "stage07-pca-diagnostics": (3, [1.0, 1.0, 1.0], 2),
        "stage08-geometry": (3, [1.0, 1.0, 1.0], None),
        "stage09-embedding-sweep": (3, [1.0, 1.0, 1.0], 2),
        "stage10-embedding-validation": (3, [1.0, 1.0, 1.0], None),
        "stage11-partition-comparison": (3, [1.0, 1.0, 1.0], None),
        "stage12-soft-assignment": (3, [1.0, 1.0, 1.0], None),
        "stage13-partition-validation-a": (3, [1.0, 1.0, 1.0], None),
        "stage13-partition-validation-b": (2, [1.0, 1.0], None),
        "stage14-vector-quantisation-a": (3, [1.0, 1.0, 1.0], None),
        "stage14-vector-quantisation-b": (3, [1.0, 1.0, 1.0], None),
        "stage14-codeword-explorer": (3, [1.0, 1.0, 1.0], None),
        "stage15-task-setup": (3, [1.0, 1.0, 1.0], None),
        "stage16-interpretable-models": (3, [1.0, 1.0, 1.0], 2),
        "stage17-ensembles": (3, [1.0, 1.0, 1.0], None),
        "stage18-validation": (4, [1.0, 1.0, 1.0, 1.0], None),
        "stage19-scientific-close": (3, [1.0, 1.0, 1.0], None),
    }
    for figure_id, (columns, weights, rows) in layouts.items():
        _set_figure_layout(
            payload,
            figure_id,
            columns=columns,
            column_weights=weights,
            rows=rows,
        )

    panel_aspects = {
        ("stage00-transit-question", "transit-geometry"): 1.15,
        ("stage00-transit-question", "transit-brightness"): 1.55,
        ("stage00-label-taxonomy", "disposition-counts"): 1.65,
        ("stage00-label-taxonomy", "adjudication-status"): 1.15,
        ("stage03-structure", "correlation"): 1.05,
        ("stage03-structure", "mutual-information"): 1.05,
        ("stage03-structure", "uncertainty"): 1.15,
    }
    for (figure_id, panel_id), aspect_ratio in panel_aspects.items():
        _set_panel_display(
            _panel(payload, figure_id, panel_id), aspect_ratio=aspect_ratio
        )

    for panel_id in ("codeword-map", "codeword-profile"):
        _set_panel_display(
            _panel(payload, "stage14-codeword-explorer", panel_id),
            aspect_ratio=2.8,
            column_span=3,
        )
    for panel_id in ("coefficients", "roc", "depth-sweep"):
        _set_panel_display(
            _panel(payload, "stage16-interpretable-models", panel_id),
            aspect_ratio=1.05,
        )
    _set_panel_display(
        _panel(payload, "stage16-interpretable-models", "decision-tree"),
        aspect_ratio=2.8,
        column_span=3,
    )
    for panel in _figure(payload, "stage18-validation")["panels"]:
        _set_panel_display(panel, aspect_ratio=1.0)

    # Stage 00: fixed domains, archive order, semantic colours, and counts.
    transit = _figure(payload, "stage00-transit-question")
    for scale in (
        {"id": "transit-x", "type": "linear", "domain": [-1.6, 1.6]},
        {"id": "transit-y", "type": "linear", "domain": [-1.05, 1.05]},
        {"id": "transit-time", "type": "linear", "domain": [0, 2.2]},
        {"id": "transit-brightness", "type": "linear", "domain": [0.68, 1.12]},
    ):
        _upsert_scale(transit, scale)
    geometry_panel = _panel(payload, "stage00-transit-question", "transit-geometry")
    for layer in geometry_panel["layers"]:
        _bind_scale(layer, "transit-x", "x", "x2", "x_radius")
        _bind_scale(layer, "transit-y", "y", "y2", "y_radius")
    orbit = _layer(geometry_panel, "orbit")
    orbit["mark"] = {"type": "polygon", "opacity": 0.58, "stroke_width": 1.0}
    orbit["encoding"]["color"] = {
        "field": "region",
        "type": "nominal",
        "scale_role": "semantic",
    }
    orbit["encoding"]["x"]["axis"] = False
    orbit["encoding"]["y"]["axis"] = False
    bodies = _layer(geometry_panel, "bodies")
    bodies["mark"] = {"type": "ellipse", "opacity": 0.55, "stroke_width": 1.2}
    bodies["encoding"]["color"]["legend"] = False
    motion = _layer(geometry_panel, "motion")
    motion["encoding"]["color"] = {
        "value": "Orbit",
        "type": "nominal",
        "scale_role": "semantic",
    }
    _upsert_layer(
        geometry_panel,
        {
            "id": "transit-chord",
            "data_ref": "reference-one",
            "mark": {"type": "rule", "role": "annotation", "stroke_width": 1.2},
            "encoding": {
                "x": {"value": -1.52, "type": "quantitative", "scale_id": "transit-x"},
                "y": {"value": 0.12, "type": "quantitative", "scale_id": "transit-y"},
                "x2": {"value": 1.52, "type": "quantitative", "scale_id": "transit-x"},
                "y2": {"value": 0.12, "type": "quantitative", "scale_id": "transit-y"},
                "color": {"value": "Orbit", "type": "nominal", "scale_role": "semantic"},
            },
        },
    )
    for layer_id, x, y, label in (
        ("radius-planet-label", -0.08, 0.43, "Rₚ"),
        ("impact-label", 0.10, -0.02, "b"),
        ("radius-star-label", 0.52, -0.62, "R★"),
    ):
        _upsert_layer(
            geometry_panel,
            {
                "id": layer_id,
                "data_ref": "reference-one",
                "mark": {"type": "text", "role": "annotation"},
                "encoding": {
                    "x": {"value": x, "type": "quantitative", "scale_id": "transit-x"},
                    "y": {"value": y, "type": "quantitative", "scale_id": "transit-y"},
                    "text": {"value": label, "type": "nominal"},
                    "color": {"value": "Orbit", "type": "nominal", "scale_role": "semantic"},
                },
            },
        )
    brightness_panel = _panel(
        payload, "stage00-transit-question", "transit-brightness"
    )
    for layer in brightness_panel["layers"]:
        _bind_scale(layer, "transit-time", "x", "x2")
        _bind_scale(layer, "transit-brightness", "y", "y2")
    brightness = _layer(brightness_panel, "brightness")
    brightness["encoding"]["x"]["axis"] = {"title": "time", "grid": False}
    brightness["encoding"]["y"]["axis"] = False
    brightness_panel["layers"] = [
        layer for layer in brightness_panel["layers"] if layer["id"] not in {"baseline", "depth-label"}
    ]
    for layer_id, x, y, x2, y2, color in (
        ("period-arrow", 0.55, 1.075, 1.65, 1.075, "uncertainty"),
        ("depth-arrow", 0.28, 1.0, 0.28, 0.78, "Native"),
        ("duration-arrow", 0.46, 0.715, 0.64, 0.715, "Planet"),
    ):
        _upsert_layer(
            brightness_panel,
            {
                "id": layer_id,
                "data_ref": "reference-one",
                "mark": {"type": "vector", "role": "annotation", "stroke_width": 1.8},
                "encoding": {
                    "x": {"value": x, "type": "quantitative", "scale_id": "transit-time"},
                    "y": {"value": y, "type": "quantitative", "scale_id": "transit-brightness"},
                    "x2": {"value": x2, "type": "quantitative", "scale_id": "transit-time"},
                    "y2": {"value": y2, "type": "quantitative", "scale_id": "transit-brightness"},
                    "color": {"value": color, "type": "nominal", "scale_role": "semantic"},
                },
            },
        )
    for layer_id, x, y, label, color in (
        ("full-label", 0.035, 1.005, "full", "ink"),
        ("dimmed-label", 0.035, 0.785, "dimmed", "ink"),
        ("period-label", 1.10, 1.095, "period 'pl_orbper'", "uncertainty"),
        ("depth-equation", 0.47, 0.875, "depth ≈ (Rₚ/R★)²", "Native"),
        ("depth-column", 0.69, 0.835, "the 'pl_trandep' column, in ppm", "Native"),
        ("duration-label", 0.55, 0.695, "duration 'pl_trandurh'", "Planet"),
    ):
        _upsert_layer(
            brightness_panel,
            {
                "id": layer_id,
                "data_ref": "reference-one",
                "mark": {"type": "text", "role": "annotation"},
                "encoding": {
                    "x": {"value": x, "type": "quantitative", "scale_id": "transit-time"},
                    "y": {"value": y, "type": "quantitative", "scale_id": "transit-brightness"},
                    "text": {"value": label, "type": "nominal"},
                    "color": {"value": color, "type": "nominal", "scale_role": "semantic"},
                },
            },
        )

    taxonomy = _figure(payload, "stage00-label-taxonomy")
    for scale in (
        {
            "id": "disposition-order",
            "type": "band",
            "domain": ["PC", "FP", "KP", "CP", "APC", "FA"],
        },
        {
            "id": "disposition-count",
            "type": "linear",
            "domain": [0, 5400],
            "zero": True,
        },
        {
            "id": "adjudication-count",
            "type": "linear",
            "domain": [0, 5400],
            "zero": True,
        },
        {
            "id": "adjudication-order",
            "type": "band",
            "domain": ["adjudicated", "still open"],
        },
        {
            "id": "adjudication-color",
            "type": "ordinal",
            "domain": ["adjudicated", "still open"],
            "range": ["#0072B2", "#9AA1AB"],
            "scheme": "categorical",
        },
    ):
        _upsert_scale(taxonomy, scale)
    disposition_panel = _panel(
        payload, "stage00-label-taxonomy", "disposition-counts"
    )
    disposition_bars = _layer(disposition_panel, "bars")
    _bind_scale(disposition_bars, "disposition-order", "x")
    _bind_scale(disposition_bars, "disposition-count", "y")
    disposition_bars["encoding"]["x"]["axis"] = {}
    disposition_bars["encoding"]["y"]["axis"] = {
        "title": "TOIs",
        "grid": True,
        "format": "integer",
    }
    _upsert_layer(
        disposition_panel,
        {
            "id": "count-labels",
            "mark": {"type": "text", "role": "annotation", "dy": -7},
            "encoding": {
                "x": {
                    "field": "disposition",
                    "type": "nominal",
                    "scale_id": "disposition-order",
                },
                "y": {
                    "field": "count",
                    "type": "quantitative",
                    "scale_id": "disposition-count",
                },
                "text": {"field": "count", "type": "quantitative", "format": "integer"},
                "color": {
                    "value": "ink",
                    "type": "nominal",
                    "scale_role": "semantic",
                },
            },
        },
    )
    adjudication_panel = _panel(
        payload, "stage00-label-taxonomy", "adjudication-status"
    )
    adjudication_bars = _layer(adjudication_panel, "bars")
    _bind_scale(adjudication_bars, "adjudication-count", "x")
    _bind_scale(adjudication_bars, "adjudication-order", "y")
    _bind_scale(adjudication_bars, "adjudication-color", "color")
    adjudication_bars["encoding"]["x"]["axis"] = {
        "title": "TOIs",
        "grid": False,
        "format": "integer",
    }
    adjudication_bars["encoding"]["y"]["axis"] = {}
    _upsert_layer(
        adjudication_panel,
        {
            "id": "count-labels",
            "mark": {"type": "text", "role": "annotation", "dx": -36, "dy": 4},
            "encoding": {
                "x": {
                    "field": "count",
                    "type": "quantitative",
                    "scale_id": "adjudication-count",
                },
                "y": {
                    "field": "status",
                    "type": "nominal",
                    "scale_id": "adjudication-order",
                },
                "text": {"field": "count", "type": "quantitative", "format": "integer"},
                "color": {
                    "value": "value-label",
                    "type": "nominal",
                    "scale_role": "semantic",
                },
            },
        },
    )

    # Stage 03: fixed covariance domain, sequential MI, and archive-error bars.
    structure = _figure(payload, "stage03-structure")
    mi_max = max(row["value"] for row in rows_by_id["structure-mutual-information"])
    uncertainty_order = [
        "pl_orbper",
        "st_tmag",
        "st_dist",
        "pl_trandep",
        "st_logg",
        "st_teff",
        "st_rad",
        "pl_rade",
        "pl_trandurh",
    ]
    for scale in (
        {"id": "structure-feature-order", "type": "band", "domain": FEATURES},
        {
            "id": "correlation-color",
            "type": "linear",
            "domain": [-1, 1],
            "range": ["#2166AC", "#F7F7F7", "#B2182B"],
            "scheme": "diverging",
            "title": "correlation",
        },
        {
            "id": "mi-color",
            "type": "linear",
            "domain": [0, mi_max],
            "range": ["#440154", "#3B528B", "#21918C", "#5EC962", "#FDE725"],
            "scheme": "sequential",
            "title": "mutual information [nats]",
        },
        {
            "id": "uncertainty-log",
            "type": "log",
            "domain": [0.0001, 20],
            "title": "median reported uncertainty (% of median value)",
        },
        {
            "id": "uncertainty-order",
            "type": "band",
            "domain": uncertainty_order,
        },
    ):
        _upsert_scale(structure, scale)
    for panel_id, color_scale in (
        ("correlation", "correlation-color"),
        ("mutual-information", "mi-color"),
    ):
        cells = _layer(_panel(payload, "stage03-structure", panel_id), "cells")
        _bind_scale(cells, "structure-feature-order", "x", "y")
        _bind_scale(cells, color_scale, "color")
    uncertainty = _panel(payload, "stage03-structure", "uncertainty")
    uncertainty["transform"] = [
        {
            "op": "filter",
            "field": "feature",
            "predicate": {"neq": "pm_total"},
        }
    ]
    intervals = _layer(uncertainty, "intervals")
    intervals["mark"] = {"type": "bar", "orient": "horizontal", "opacity": 0.9}
    intervals["encoding"].pop("x_lower", None)
    intervals["encoding"].pop("x_upper", None)
    _bind_scale(intervals, "uncertainty-log", "x")
    _bind_scale(intervals, "uncertainty-order", "y")
    intervals["encoding"]["x"]["axis"] = {
        "title": "median reported uncertainty (% of median value)",
        "grid": True,
    }
    intervals["encoding"]["y"]["axis"] = {}
    intervals["encoding"]["color"] = {
        "value": "uncertainty",
        "type": "nominal",
        "scale_role": "semantic",
    }

    # Ordered and oriented categorical summaries from the archived panels.
    provenance = _figure(payload, "stage01-provenance")
    for scale in (
        {
            "id": "missingness-order",
            "type": "band",
            "domain": [
                "pl_trandurh",
                "pl_trandep",
                "st_tmag",
                "pl_orbper",
                "pm_total",
                "st_teff",
                "pl_insol",
                "st_dist",
                "pl_rade",
                "st_rad",
                "st_logg",
            ],
        },
        {
            "id": "host-group-order",
            "type": "band",
            "domain": [
                "1 signal",
                "2 signals",
                "3 signals",
                "4 signals",
                "5 signals",
            ],
        },
        {"id": "host-log", "type": "log", "domain": [1, 7000]},
    ):
        _upsert_scale(provenance, scale)
    missing_bars = _layer(
        _panel(payload, "stage01-provenance", "missingness"), "missing-bars"
    )
    _bind_scale(missing_bars, "missingness-order", "y")
    missing_bars["encoding"]["x"]["axis"] = {
        "title": "missing rows / all rows",
        "format": "percent",
        "grid": True,
    }
    host_bars = _layer(
        _panel(payload, "stage01-provenance", "host-multiplicity"), "host-bars"
    )
    host_bars["mark"].pop("orient", None)
    host_bars["mark"].pop("orientation", None)
    host_bars["encoding"]["x"] = {
        "field": "host_group",
        "type": "nominal",
        "scale_id": "host-group-order",
        "axis": {"title": "TOIs per host star"},
    }
    host_bars["encoding"]["y"] = {
        "field": "hosts",
        "type": "quantitative",
        "scale_id": "host-log",
        "axis": {"title": "hosts (log)", "grid": True, "format": "integer"},
    }

    quality = _figure(payload, "stage02-quality-control")
    _upsert_scale(
        quality,
        {
            "id": "quality-rule-order",
            "type": "band",
            "domain": [
                "Missing disposition",
                "st_teff > 20,000 K",
                "st_rad > 100 R_sun",
                "Duration >= period",
                "Exact duplicate",
            ],
        },
    )
    removal_bars = _layer(
        _panel(payload, "stage02-quality-control", "rule-removals"),
        "removal-bars",
    )
    _bind_scale(removal_bars, "quality-rule-order", "y")
    removal_bars["encoding"]["x"]["axis"] = {
        "title": "rows removed",
        "grid": True,
        "format": "integer",
    }

    feature_audit = _figure(payload, "stage04-feature-audit")
    for scale in (
        {
            "id": "disposition-convention-order",
            "type": "band",
            "domain": ["CP", "KP", "PC", "APC", "FP", "FA"],
        },
        {
            "id": "convention-fraction",
            "type": "linear",
            "domain": [0, 1],
            "zero": True,
        },
    ):
        _upsert_scale(feature_audit, scale)
    convention_segments = _layer(
        _panel(payload, "stage04-feature-audit", "conventions"), "segments"
    )
    convention_segments["mark"].pop("orient", None)
    convention_segments["mark"].pop("orientation", None)
    convention_segments["encoding"]["x"] = {
        "field": "feature",
        "type": "nominal",
        "scale_id": "disposition-convention-order",
        "axis": {"title": "TFOPWG disposition"},
    }
    convention_segments["encoding"]["y"] = {
        "field": "interval_end",
        "type": "quantitative",
        "scale_id": "convention-fraction",
        "axis": {"title": "fraction within disposition", "format": "percent"},
    }
    convention_segments["encoding"]["y2"] = {
        "field": "interval_start",
        "type": "quantitative",
        "scale_id": "convention-fraction",
    }
    convention_segments["encoding"].pop("x2", None)

    skew_rows = rows_by_id["skew-before-after"]
    skew_low = min(0.0, *(min(row["before"], row["after"]) for row in skew_rows))
    skew_high = max(max(row["before"], row["after"]) for row in skew_rows)
    skew_padding = 0.02 * max(1.0, skew_high - skew_low)
    _upsert_scale(
        feature_audit,
        {
            "id": "skew-domain",
            "type": "linear",
            "domain": [skew_low - skew_padding, skew_high + skew_padding],
        },
    )
    skew = _panel(payload, "stage04-feature-audit", "skew")
    for layer in skew["layers"]:
        _bind_scale(layer, "skew-domain", "x", "x2", "y", "y2")

    # All three partition maps share the same drawing domain.
    partition = _figure(payload, "stage11-partition-comparison")
    partition_rows = rows_by_id["partition-overlays"]
    x_values = [float(row["x"]) for row in partition_rows]
    y_values = [float(row["y"]) for row in partition_rows]
    x_padding = 0.02 * max(1.0, max(x_values) - min(x_values))
    y_padding = 0.02 * max(1.0, max(y_values) - min(y_values))
    for scale in (
        {
            "id": "partition-x",
            "type": "linear",
            "domain": [min(x_values) - x_padding, max(x_values) + x_padding],
        },
        {
            "id": "partition-y",
            "type": "linear",
            "domain": [min(y_values) - y_padding, max(y_values) + y_padding],
        },
    ):
        _upsert_scale(partition, scale)
    for panel in partition["panels"]:
        points = _layer(panel, "points")
        _bind_scale(points, "partition-x", "x")
        _bind_scale(points, "partition-y", "y")

    soft_assignment = _figure(payload, "stage12-soft-assignment")
    _upsert_scale(
        soft_assignment,
        {
            "id": "responsibility-color",
            "type": "linear",
            "domain": [0, 1],
            "range": ["#440154", "#3B528B", "#21918C", "#5EC962", "#FDE725"],
            "scheme": "sequential",
            "title": "responsibility",
        },
    )
    for panel_id in ("responsibility-map", "responsibility-heatmap"):
        layer_id = "points" if panel_id == "responsibility-map" else "cells"
        _bind_scale(
            _layer(_panel(payload, "stage12-soft-assignment", panel_id), layer_id),
            "responsibility-color",
            "color",
        )

    quantisation = _figure(payload, "stage14-vector-quantisation-a")
    _upsert_scale(
        quantisation,
        {
            "id": "design-z",
            "type": "linear",
            "domain": [-3, 3],
            "range": ["#2166AC", "#F7F7F7", "#B2182B"],
            "scheme": "diverging",
            "title": "standardised value",
        },
    )
    _bind_scale(
        _layer(
            _panel(payload, "stage14-vector-quantisation-a", "design-matrix"),
            "cells",
        ),
        "design-z",
        "color",
    )

    task_setup = _figure(payload, "stage15-task-setup")
    split_rows = rows_by_id["split-class-balance"]
    split_order = list(dict.fromkeys(row["split"] for row in split_rows))
    split_max = max(row["interval_end"] for row in split_rows)
    for scale in (
        {"id": "split-order", "type": "band", "domain": split_order},
        {
            "id": "split-count",
            "type": "linear",
            "domain": [0, split_max],
            "zero": True,
        },
        {
            "id": "split-class-color",
            "type": "ordinal",
            "domain": ["Planet", "False positive"],
            "range": ["#009E73", "#D55E00"],
            "scheme": "categorical",
        },
    ):
        _upsert_scale(task_setup, scale)
    class_segments = _layer(
        _panel(payload, "stage15-task-setup", "class-balance"), "class-segments"
    )
    class_segments["mark"].pop("orient", None)
    class_segments["mark"].pop("orientation", None)
    class_segments["encoding"]["x"] = {
        "field": "split",
        "type": "nominal",
        "scale_id": "split-order",
        "axis": {},
    }
    class_segments["encoding"]["y"] = {
        "field": "interval_end",
        "type": "quantitative",
        "scale_id": "split-count",
        "axis": {"title": "adjudicated TOIs", "grid": True, "format": "integer"},
    }
    class_segments["encoding"]["y2"] = {
        "field": "interval_start",
        "type": "quantitative",
        "scale_id": "split-count",
    }
    class_segments["encoding"].pop("x2", None)
    _bind_scale(class_segments, "split-class-color", "color")

    interpretable = _figure(payload, "stage16-interpretable-models")
    coefficient_rows = rows_by_id["interpretable-coefficients"]
    coefficient_limit = max(abs(float(row["coefficient"])) for row in coefficient_rows)
    coefficient_limit *= 1.05
    for scale in (
        {
            "id": "coefficient-domain",
            "type": "linear",
            "domain": [-coefficient_limit, coefficient_limit],
            "range": ["#2166AC", "#F7F7F7", "#B2182B"],
            "scheme": "diverging",
        },
        {"id": "roc-domain", "type": "linear", "domain": [0, 1]},
    ):
        _upsert_scale(interpretable, scale)
    coefficients = _layer(
        _panel(payload, "stage16-interpretable-models", "coefficients"),
        "coefficient-bars",
    )
    _bind_scale(coefficients, "coefficient-domain", "x", "color")
    roc = _panel(payload, "stage16-interpretable-models", "roc")
    for layer in roc["layers"]:
        _bind_scale(layer, "roc-domain", "x", "x2", "y", "y2")

    validation = _figure(payload, "stage18-validation")
    for scale in (
        {"id": "cv-domain", "type": "linear", "domain": [0.45, 0.9]},
        {"id": "learning-domain", "type": "linear", "domain": [0.45, 1.0]},
        {"id": "unit-domain", "type": "linear", "domain": [0, 1]},
        {
            "id": "confusion-color",
            "type": "linear",
            "domain": [0, 1],
            "range": ["#F7FBFF", "#6BAED6", "#08519C"],
            "scheme": "sequential",
        },
    ):
        _upsert_scale(validation, scale)
    cv = _panel(payload, "stage18-validation", "cv")
    for layer in cv["layers"]:
        _bind_scale(layer, "cv-domain", "y", "y2", "y_lower", "y_upper")
    learning = _panel(payload, "stage18-validation", "learning")
    for layer in learning["layers"]:
        _bind_scale(layer, "learning-domain", "y", "y2")
    calibration = _panel(payload, "stage18-validation", "calibration")
    for layer in calibration["layers"]:
        _bind_scale(layer, "unit-domain", "x", "x2", "y", "y2")
    confusion = _layer(
        _panel(payload, "stage18-validation", "confusion"), "cells"
    )
    _bind_scale(confusion, "confusion-color", "color")

    # The archived report labels only compact summary bars.  Histograms,
    # coefficient/importance charts, stacked bars, and errorbar composites stay
    # unlabelled so the figure remains legible.  The explicit text channel keeps
    # this choice in the payload instead of hiding it in a renderer heuristic.
    bar_value_labels = (
        ("stage01-provenance", "missingness", "missing-bars", "missing_fraction", ".1%"),
        ("stage01-provenance", "host-multiplicity", "host-bars", "hosts", "integer"),
        ("stage02-quality-control", "rule-removals", "removal-bars", "removed", "integer"),
        ("stage04-feature-audit", "implied-constant", "histogram", "count", "integer"),
        ("stage10-embedding-validation", "seed-reproducibility", "disparity-bars", "disparity", None),
        ("stage13-partition-validation-b", "seed-reproducibility", "ari-bars", "ari", None),
        ("stage14-vector-quantisation-a", "planet-fraction", "fractions", "adjudicated", "integer"),
        ("stage14-vector-quantisation-b", "excess-error", "excess-bars", "excess_percent", "integer"),
        ("stage15-task-setup", "split-leakage", "leakage-bars", "shared_hosts", "integer"),
        ("stage17-ensembles", "auc", "auc-bars", "auc", None),
    )
    for figure_id, panel_id, layer_id, field, value_format in bar_value_labels:
        label_channel: dict[str, Any] = {"field": field, "type": "quantitative"}
        if value_format is not None:
            label_channel["format"] = value_format
        _layer(_panel(payload, figure_id, panel_id), layer_id)["encoding"][
            "text"
        ] = label_channel

def main() -> None:
    args = parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault(
        "NUMBA_CACHE_DIR", str(Path(tempfile.gettempdir()) / "tess-real-numba-cache")
    )

    state = prepare_state(args.source.resolve())
    from stages_foundation import compute_foundation
    from stages_supervised import compute_supervised
    from stages_unsupervised import compute_unsupervised

    rows_by_id: dict[str, list[dict[str, Any]]] = {}
    rows_by_id.update(compute_foundation(state))
    unsupervised_rows, unsupervised_context = compute_unsupervised(state)
    rows_by_id.update(unsupervised_rows)
    rows_by_id.update(compute_supervised(state, unsupervised_context))

    payload = remove_illustrative_language(
        json.loads(TEMPLATE_PAYLOAD.read_text(encoding="utf-8"))
    )
    package_metadata(payload, state)
    align_real_data_spec(payload, rows_by_id, unsupervised_context, state)
    declared_ids = {resource["id"] for resource in payload["data"]}
    generated_ids = set(rows_by_id)
    if declared_ids != generated_ids:
        raise RuntimeError(
            f"Data-id mismatch; missing={sorted(declared_ids - generated_ids)}, "
            f"extra={sorted(generated_ids - declared_ids)}"
        )
    for resource in payload["data"]:
        write_resource(output, resource, rows_by_id[resource["id"]])

    payload_path = output / "payload.json"
    payload_path.write_bytes(stable_json(payload, pretty=True))
    receipt = {
        "payload": str(payload_path),
        "source_sha256": state["source_sha256"],
        "raw_rows": len(state["raw"]),
        "clean_rows": len(state["clean"]),
        "data_sources": len(payload["data"]),
        "sidecar_rows": int(sum(len(rows) for rows in rows_by_id.values())),
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"build-real-tess-payload: {error}", file=sys.stderr)
        raise
