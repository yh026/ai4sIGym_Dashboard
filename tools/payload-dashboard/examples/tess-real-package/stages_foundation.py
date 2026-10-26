"""Real-data sidecars for TESS stages 00--08.

The functions in this module are deliberately presentation-agnostic: they
derive rows for the data-resource contracts already declared by the reference
payload.  Stage 00's transit diagram is the sole synthetic scientific graphic;
all remaining values are computed from the verified TOI snapshot held in
``state``.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.metrics import mutual_info_score
from sklearn.neighbors import NearestNeighbors


PLANET_CODES = frozenset({"KP", "CP"})
FALSE_POSITIVE_CODES = frozenset({"FP", "FA"})
ADJUDICATED_CODES = PLANET_CODES | FALSE_POSITIVE_CODES
DISPOSITION_ORDER = ("PC", "FP", "KP", "CP", "APC", "FA")
LOG_FEATURES = (
    "pl_orbper",
    "pl_trandurh",
    "pl_trandep",
    "pl_rade",
    "pl_insol",
    "st_dist",
    "st_rad",
    "pm_total",
)


def _plain_scalar(value: Any) -> str | int | float:
    """Return a JSON-safe native scalar and reject silent NaN/inf leakage."""

    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError(f"Non-finite foundation value: {result}")
        return result
    if isinstance(value, str):
        return value
    raise TypeError(f"Unsupported foundation scalar: {type(value).__name__}")


def _finish(resources: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict]]:
    """Normalise all row values to finite native Python scalars."""

    finished: dict[str, list[dict]] = {}
    for resource_id, rows in resources.items():
        if not rows:
            raise ValueError(f"{resource_id}: foundation resource has no rows")
        finished[resource_id] = [
            {str(key): _plain_scalar(value) for key, value in row.items()}
            for row in rows
        ]
    return finished


def _feature_frame(frame: pd.DataFrame, feature_names: list[str]) -> pd.DataFrame:
    """Select native features, deriving total proper motion when necessary."""

    columns: dict[str, pd.Series] = {}
    for name in feature_names:
        if name in frame:
            columns[name] = pd.to_numeric(frame[name], errors="coerce")
        elif name == "pm_total":
            pm_ra = pd.to_numeric(frame["st_pmra"], errors="coerce")
            pm_dec = pd.to_numeric(frame["st_pmdec"], errors="coerce")
            columns[name] = pd.Series(np.hypot(pm_ra, pm_dec), index=frame.index)
        else:
            raise KeyError(f"Missing feature column: {name}")
    return pd.DataFrame(columns, index=frame.index)


def _median_fill(values: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=float).copy()
    medians = np.nanmedian(result, axis=0)
    if not np.isfinite(medians).all():
        raise ValueError("Cannot median-fill a feature with no finite values")
    missing = ~np.isfinite(result)
    if missing.any():
        result[missing] = np.take(medians, np.nonzero(missing)[1])
    return result


def _histogram_rows(
    values: np.ndarray,
    *,
    bins: int,
    value_field: str,
) -> list[dict[str, Any]]:
    finite = np.asarray(values, dtype=float)
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        raise ValueError(f"Cannot histogram empty values for {value_field}")
    counts, edges = np.histogram(finite, bins=bins)
    centres = (edges[:-1] + edges[1:]) / 2.0
    return [
        {value_field: float(centre), "count": int(count)}
        for centre, count in zip(centres, counts, strict=True)
    ]


def _qc_counts(raw: pd.DataFrame) -> list[int]:
    """Apply the five declared QC rules sequentially and report removals."""

    current = raw.copy()
    counts: list[int] = []
    for rule in range(5):
        if rule == 0:
            mask = current.duplicated(keep="first")
        elif rule == 1:
            mask = (
                current["pl_trandurh"].notna()
                & current["pl_orbper"].notna()
                & ((current["pl_trandurh"] / 24.0) >= current["pl_orbper"])
            )
        elif rule == 2:
            mask = current["st_rad"].gt(100).fillna(False)
        elif rule == 3:
            mask = current["st_teff"].gt(20_000).fillna(False)
        else:
            disposition = current["tfopwg_disp"].astype("string")
            mask = current["tfopwg_disp"].isna() | disposition.str.strip().eq("").fillna(False)
        counts.append(int(mask.sum()))
        current = current.loc[~mask].copy()
    return counts


def _quantile_codes(values: np.ndarray, bins: int = 16) -> np.ndarray:
    """Discretise each column independently into equal-frequency bins."""

    array = np.asarray(values, dtype=float)
    result = np.empty(array.shape, dtype=np.int16)
    for column in range(array.shape[1]):
        codes = pd.qcut(
            pd.Series(array[:, column]),
            q=bins,
            labels=False,
            duplicates="drop",
        )
        if codes.isna().any():
            raise ValueError(f"Quantile binning produced missing codes in column {column}")
        result[:, column] = codes.to_numpy(dtype=np.int16)
    return result


def _reported_uncertainty_rows(
    clean: pd.DataFrame,
    feature_names: list[str],
) -> list[dict[str, Any]]:
    """Summarise archive error bars as percent of each feature's median.

    The archived ``pl_insolerr1/2`` columns contain no measurements.  That
    feature is intentionally omitted rather than assigned a fabricated value;
    every emitted row therefore represents an actually reported uncertainty.
    """

    native = _feature_frame(clean, feature_names)
    rows: list[dict[str, Any]] = []
    for feature in feature_names:
        values = native[feature].to_numpy(dtype=float)
        denominator = abs(float(np.nanmedian(values)))
        if not math.isfinite(denominator) or denominator <= 0:
            continue

        if feature == "pm_total":
            pm_ra = pd.to_numeric(clean["st_pmra"], errors="coerce").to_numpy(dtype=float)
            pm_dec = pd.to_numeric(clean["st_pmdec"], errors="coerce").to_numpy(dtype=float)
            sigma_ra = (
                pd.to_numeric(clean["st_pmraerr1"], errors="coerce").abs().to_numpy(dtype=float)
                + pd.to_numeric(clean["st_pmraerr2"], errors="coerce").abs().to_numpy(dtype=float)
            ) / 2.0
            sigma_dec = (
                pd.to_numeric(clean["st_pmdecerr1"], errors="coerce").abs().to_numpy(dtype=float)
                + pd.to_numeric(clean["st_pmdecerr2"], errors="coerce").abs().to_numpy(dtype=float)
            ) / 2.0
            total = np.hypot(pm_ra, pm_dec)
            with np.errstate(divide="ignore", invalid="ignore"):
                sigma = np.sqrt(
                    np.square(pm_ra / total * sigma_ra)
                    + np.square(pm_dec / total * sigma_dec)
                )
        else:
            err1 = f"{feature}err1"
            err2 = f"{feature}err2"
            if err1 not in clean or err2 not in clean:
                continue
            sigma = (
                pd.to_numeric(clean[err1], errors="coerce").abs().to_numpy(dtype=float)
                + pd.to_numeric(clean[err2], errors="coerce").abs().to_numpy(dtype=float)
            ) / 2.0

        percentages = 100.0 * sigma / denominator
        percentages = percentages[np.isfinite(percentages) & (percentages > 0)]
        if percentages.size == 0:
            continue
        lower, estimate, upper = np.quantile(percentages, [0.25, 0.5, 0.75])
        rows.append(
            {
                "feature": feature,
                "estimate": float(estimate),
                "lower": float(lower),
                "upper": float(upper),
            }
        )
    return rows


def _baseline_rows(state: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Recompute the declared two-feature, in-sample GD baseline."""

    clean = state["clean"]
    dispositions = clean["tfopwg_disp"].astype(str).to_numpy()
    selected = np.isin(dispositions, tuple(ADJUDICATED_CODES))
    # This baseline predates the later full-design-matrix pipeline.  Keep its
    # preprocessing scoped to the adjudicated subset and its two declared
    # features, matching the historical 0.6171 terminal mean NLL.
    model_frame = state["model_frame"]
    two_feature = _median_fill(
        model_frame.loc[selected, ["pl_rade", "pl_trandep"]].to_numpy(dtype=float)
    )
    means = two_feature.mean(axis=0)
    scales = two_feature.std(axis=0, ddof=0)
    if np.any(scales <= 0):
        raise ValueError("Baseline feature has zero variance")
    standardised = (two_feature - means) / scales
    labels = np.isin(dispositions[selected], tuple(PLANET_CODES)).astype(float)

    design = np.column_stack([np.ones(len(standardised)), standardised])
    weights = np.zeros(design.shape[1], dtype=float)
    loss_rows: list[dict[str, Any]] = []
    learning_rate = 0.2
    for iteration in range(1, 401):
        logits = np.clip(design @ weights, -709.0, 709.0)
        probability = 1.0 / (1.0 + np.exp(-logits))
        gradient = design.T @ (probability - labels) / len(labels)
        weights -= learning_rate * gradient
        logits = np.clip(design @ weights, -709.0, 709.0)
        probability = 1.0 / (1.0 + np.exp(-logits))
        probability = np.clip(probability, 1e-15, 1.0 - 1e-15)
        loss = -np.mean(
            labels * np.log(probability) + (1.0 - labels) * np.log(1.0 - probability)
        )
        loss_rows.append({"iteration": iteration, "loss": float(loss)})

    object_ids = state.get("object_ids")
    if object_ids is None:
        object_ids = [f"TOI-{value}" for value in clean["toi"]]
    selected_ids = np.asarray(object_ids, dtype=object)[selected]
    point_rows = [
        {
            "object_id": str(object_id),
            "radius_log": float(point[0]),
            "depth_log": float(point[1]),
            "class": "Planet" if label == 1.0 else "False_positive",
        }
        for object_id, point, label in zip(
            selected_ids, standardised, labels, strict=True
        )
    ]

    x_low = float(standardised[:, 0].min())
    x_high = float(standardised[:, 0].max())
    if abs(weights[2]) < 1e-12:
        raise ValueError("Baseline decision boundary is vertical")
    boundary_rows = [
        {"x": x_value, "y": float(-(weights[0] + weights[1] * x_value) / weights[2])}
        for x_value in (x_low, x_high)
    ]
    return {
        "baseline-loss": loss_rows,
        "baseline-two-feature": point_rows,
        "baseline-boundary": boundary_rows,
    }


def _preprocessing_rows(state: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    feature_names = list(state["feature_names"])
    native_frame = _feature_frame(state["clean"], feature_names)
    native = _median_fill(native_frame.to_numpy(dtype=float))
    x_scaled = np.asarray(state["X_scaled"], dtype=float)
    standard_pca = state["pca"]

    native_variance = [
        {"feature": feature, "variance": float(np.var(native[:, index], ddof=1))}
        for index, feature in enumerate(feature_names)
    ]
    native_pca = PCA(n_components=len(feature_names), svd_solver="full").fit(native)
    scree_rows: list[dict[str, Any]] = []
    for series, values in (
        ("Native", native_pca.explained_variance_ratio_),
        ("Standardised", standard_pca.explained_variance_ratio_),
    ):
        scree_rows.extend(
            {
                "component": component,
                "variance": float(variance),
                "series": series,
            }
            for component, variance in enumerate(values, start=1)
        )

    box_rows: list[dict[str, Any]] = []
    for index, feature in enumerate(feature_names):
        values = x_scaled[:, index]
        q1, median, q3 = np.quantile(values, [0.25, 0.5, 0.75])
        spread = q3 - q1
        inside = values[(values >= q1 - 1.5 * spread) & (values <= q3 + 1.5 * spread)]
        if inside.size == 0:
            raise ValueError(f"No finite boxplot whiskers for {feature}")
        box_rows.append(
            {
                "feature": feature,
                "q1": float(q1),
                "median": float(median),
                "q3": float(q3),
                "whisker_low": float(inside.min()),
                "whisker_high": float(inside.max()),
            }
        )
    return {
        "native-variance": native_variance,
        "preprocess-scree": scree_rows,
        "preprocess-boxes": box_rows,
    }


def _pca_rows(state: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    feature_names = list(state["feature_names"])
    x_scaled = np.asarray(state["X_scaled"], dtype=float)
    pca = state["pca"]
    stored_scores = state.get("pca_scores")
    scores = np.asarray(
        pca.transform(x_scaled) if stored_scores is None else stored_scores,
        dtype=float,
    )
    ratios = np.asarray(pca.explained_variance_ratio_, dtype=float)
    cumulative = np.cumsum(ratios)
    scree_rows = [
        {
            "component": component,
            "variance": float(ratios[component - 1]),
            "cumulative": float(cumulative[component - 1]),
        }
        for component in range(1, len(ratios) + 1)
    ]

    loading_rows = [
        {
            "component": component + 1,
            "feature": feature,
            "value": float(pca.components_[component, feature_index]),
        }
        for component in range(min(5, pca.components_.shape[0]))
        for feature_index, feature in enumerate(feature_names)
    ]

    combined = np.corrcoef(x_scaled.T, scores[:, :2].T)
    circle = combined[: len(feature_names), len(feature_names) :]
    circle_rows = [
        {"feature": feature, "x": float(circle[index, 0]), "y": float(circle[index, 1])}
        for index, feature in enumerate(feature_names)
    ]

    correlation = np.corrcoef(x_scaled, rowvar=False)
    residual_rows: list[dict[str, Any]] = []
    for component_count in (2, 6, 8):
        components = pca.components_[:component_count]
        eigenvalues = np.asarray(pca.explained_variance_[:component_count], dtype=float)
        reconstruction = components.T @ np.diag(eigenvalues) @ components
        residual = correlation - reconstruction
        residual_rows.extend(
            {
                "component": component_count,
                "row": row_name,
                "column": column_name,
                "value": float(residual[row_index, column_index]),
            }
            for row_index, row_name in enumerate(feature_names)
            for column_index, column_name in enumerate(feature_names)
        )
    return {
        "pca-scree": scree_rows,
        "pca-loadings": loading_rows,
        "pca-circle": circle_rows,
        "pca-residuals": residual_rows,
    }


def _geometry_rows(state: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    x_scaled = np.asarray(state["X_scaled"], dtype=float)
    if len(x_scaled) < 11:
        raise ValueError("Stage 08 requires at least 11 rows")

    euclidean = NearestNeighbors(
        n_neighbors=11,
        metric="euclidean",
        algorithm="auto",
        n_jobs=1,
    ).fit(x_scaled)
    distances = euclidean.kneighbors(x_scaled, return_distance=True)[0]
    kth = np.sort(distances[:, 10])
    k_distance_rows = [
        {"rank": rank, "distance": float(distance)}
        for rank, distance in enumerate(kth, start=1)
    ]

    mean_neighbour_distance = distances[:, 1:11].mean(axis=1)
    if np.any(mean_neighbour_distance <= 0):
        raise ValueError("Non-positive mean neighbour distance")
    log_density = np.log10(1.0 / mean_neighbour_distance)
    density_rows = _histogram_rows(
        log_density,
        bins=36,
        value_field="log10_density",
    )

    sample_size = min(2_500, len(x_scaled))
    rng = np.random.default_rng(int(state.get("seed", 0)))
    sample_indices = np.sort(rng.choice(len(x_scaled), size=sample_size, replace=False))
    sample = x_scaled[sample_indices]
    metric_rows: list[dict[str, Any]] = []
    for label, metric in (
        ("Euclidean", "euclidean"),
        ("Manhattan", "manhattan"),
        ("Cosine", "cosine"),
    ):
        neighbours = NearestNeighbors(
            n_neighbors=11,
            metric=metric,
            algorithm="brute" if metric == "cosine" else "auto",
            n_jobs=1,
        ).fit(sample)
        curve = np.sort(neighbours.kneighbors(sample, return_distance=True)[0][:, 10])
        scale = float(curve.max())
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError(f"Cannot normalise {label} metric curve")
        curve = curve / scale
        metric_rows.extend(
            {"rank": rank, "distance": float(distance), "metric": label}
            for rank, distance in enumerate(curve, start=1)
        )
    return {
        "k-distance": k_distance_rows,
        "density-histogram": density_rows,
        "metric-distances": metric_rows,
    }


def compute_foundation(state: dict[str, Any]) -> dict[str, list[dict]]:
    """Compute data rows for every declared TESS resource in stages 00--08."""

    raw: pd.DataFrame = state["raw"]
    clean: pd.DataFrame = state["clean"]
    feature_names = list(state["feature_names"])
    x_imputed = np.asarray(state["X_imputed"], dtype=float)
    if x_imputed.shape != (len(clean), len(feature_names)):
        raise ValueError(
            f"Foundation matrix shape {x_imputed.shape} does not match "
            f"({len(clean)}, {len(feature_names)})"
        )

    # Stage 00: the transit is intentionally a schematic; taxonomy is real.
    orbit_angles = np.linspace(0.0, 2.0 * math.pi, 49)
    times = np.linspace(0.0, 2.2, 221)
    transit_positions = (-1.35, -0.68, 0.0, 0.68, 1.35)

    def circle_vertices(
        region: str, center_x: float, center_y: float, radius: float
    ) -> list[dict[str, Any]]:
        return [
            {
                "region": region,
                "vertex_order": index,
                "x": float(center_x + radius * math.cos(angle)),
                "y": float(center_y + radius * math.sin(angle)),
            }
            for index, angle in enumerate(orbit_angles)
        ]

    def schematic_brightness(time: float) -> float:
        """Two deterministic trapezoidal dips, one orbital period apart."""

        brightness = 1.0
        for center in (0.55, 1.65):
            distance = abs(time - center)
            if distance <= 0.055:
                candidate = 0.78
            elif distance <= 0.09:
                candidate = 0.78 + 0.22 * (distance - 0.055) / 0.035
            else:
                candidate = 1.0
            brightness = min(brightness, candidate)
        return float(brightness)
    disposition_counts = raw["tfopwg_disp"].value_counts()
    adjudicated_count = int(raw["tfopwg_disp"].isin(ADJUDICATED_CODES).sum())
    resources: dict[str, list[dict[str, Any]]] = {
        "reference-one": [{"id": "reference"}],
        "transit-bodies": [
            *[
                {
                    "body": "StarRing",
                    "x": 0.0,
                    "y": 0.0,
                    "x_radius": radius,
                    "y_radius": radius,
                }
                for radius in (0.25, 0.48, 0.70, 0.90)
            ],
            *[
                {
                    "body": "PlanetOutline",
                    "x": float(position),
                    "y": 0.12,
                    "x_radius": 0.13,
                    "y_radius": 0.13,
                }
                for position in transit_positions
            ],
        ],
        "transit-orbit": [
            *circle_vertices("StarFill", 0.0, 0.0, 0.90),
            *[
                vertex
                for index, position in enumerate(transit_positions, start=1)
                for vertex in circle_vertices(
                    f"PlanetFill{index}", float(position), 0.12, 0.13
                )
            ],
        ],
        "transit-motion": [
            {"x": 0.0, "y": 0.12, "x2": 0.0, "y2": 0.37},
            {"x": 0.0, "y": 0.12, "x2": 0.0, "y2": -0.15},
            {"x": 0.0, "y": -0.15, "x2": 0.55, "y2": -0.60},
        ],
        "transit-light-curve": [
            {
                "time": float(time),
                "brightness": schematic_brightness(float(time)),
            }
            for time in times
        ],
        "label-dispositions": [
            {"disposition": code, "count": int(disposition_counts.get(code, 0))}
            for code in DISPOSITION_ORDER
        ],
        "label-adjudication": [
            {"status": "adjudicated", "count": adjudicated_count},
            {"status": "still open", "count": int(len(raw) - adjudicated_count)},
        ],
    }

    # Stage 01: missingness and host multiplicity are measured on raw rows.
    raw_features = _feature_frame(raw, feature_names)
    resources["provenance-missingness"] = [
        {"feature": feature, "missing_fraction": float(raw_features[feature].isna().mean())}
        for feature in feature_names
    ]
    multiplicity = raw.groupby("tid", dropna=True).size().value_counts()
    resources["host-multiplicity"] = [
        {
            "host_group": f"{count} signal{'s' if count != 1 else ''}",
            "hosts": int(multiplicity.get(count, 0)),
        }
        for count in range(1, 6)
    ]

    # Stage 02: sequential rule removals and the retained large-radius tail.
    qc_counts = _qc_counts(raw)
    expected_counts = state.get("qc_counts")
    if expected_counts is not None and list(expected_counts) != qc_counts:
        raise ValueError(f"QC count disagreement: {qc_counts} != {list(expected_counts)}")
    qc_rule_names = (
        "Exact duplicate",
        "Duration >= period",
        "st_rad > 100 R_sun",
        "st_teff > 20,000 K",
        "Missing disposition",
    )
    resources["quality-rule-removals"] = [
        {"rule": rule, "removed": removed}
        for rule, removed in zip(qc_rule_names, qc_counts, strict=True)
    ]
    radii = pd.to_numeric(clean["pl_rade"], errors="coerce").to_numpy(dtype=float)
    log_radii = np.log10(radii[np.isfinite(radii) & (radii > 0)])
    resources["retained-radius-histogram"] = _histogram_rows(
        log_radii,
        bins=40,
        value_field="log10_radius",
    )

    # Stage 03: post-log, median-filled dependence plus published error bars.
    correlation = np.corrcoef(x_imputed, rowvar=False)
    resources["structure-correlation"] = [
        {
            "row": row_name,
            "column": column_name,
            "value": float(correlation[row_index, column_index]),
        }
        for row_index, row_name in enumerate(feature_names)
        for column_index, column_name in enumerate(feature_names)
    ]
    quantile_codes = _quantile_codes(x_imputed, bins=16)
    resources["structure-mutual-information"] = [
        {
            "row": row_name,
            "column": column_name,
            "value": float(
                mutual_info_score(
                    quantile_codes[:, row_index],
                    quantile_codes[:, column_index],
                )
            ),
        }
        for row_index, row_name in enumerate(feature_names)
        for column_index, column_name in enumerate(feature_names)
        if row_index != column_index
    ]
    resources["structure-uncertainty"] = _reported_uncertainty_rows(
        clean, feature_names
    )

    # Stage 04: diagnose the equilibrium-temperature convention and log skew.
    insolation = pd.to_numeric(clean["pl_insol"], errors="coerce")
    equilibrium_temperature = pd.to_numeric(clean["pl_eqt"], errors="coerce")
    with np.errstate(divide="ignore", invalid="ignore"):
        implied_constant = equilibrium_temperature / np.power(insolation, 0.25)
    implied = implied_constant.to_numpy(dtype=float)
    finite_implied = np.isfinite(implied)
    is_255 = finite_implied & (np.abs(implied - 255.0) < np.abs(implied - 278.5))
    is_278 = finite_implied & ~is_255
    convention = np.full(len(clean), "missing", dtype=object)
    convention[is_255] = "255 K"
    convention[is_278] = "278.5 K"
    resources["implied-constant-histogram"] = [
        {"value": 255.0, "count": int(is_255.sum())},
        {"value": 278.5, "count": int(is_278.sum())},
    ]
    convention_rows: list[dict[str, Any]] = []
    disposition_values = clean["tfopwg_disp"].astype(str).to_numpy()
    for disposition in DISPOSITION_ORDER:
        selected = disposition_values == disposition
        total = int(selected.sum())
        start = 0.0
        for label in ("255 K", "278.5 K", "missing"):
            fraction = float(np.sum(selected & (convention == label)) / total)
            end = start + fraction
            convention_rows.append(
                {
                    "feature": disposition,
                    "convention": label,
                    "interval_start": start,
                    "interval_end": end,
                }
            )
            start = end
    resources["feature-conventions"] = convention_rows

    native_features = _feature_frame(clean, feature_names)
    model_frame = state["model_frame"]
    resources["skew-before-after"] = [
        {
            "feature": feature,
            "before": float(abs(pd.to_numeric(native_features[feature], errors="coerce").skew())),
            "after": float(abs(pd.to_numeric(model_frame[feature], errors="coerce").skew())),
        }
        for feature in LOG_FEATURES
    ]

    resources.update(_baseline_rows(state))
    resources.update(_preprocessing_rows(state))
    resources.update(_pca_rows(state))
    resources.update(_geometry_rows(state))
    return _finish(resources)
