"""Real-data computations for TESS dashboard stages 15--19.

The public entry point returns renderer-ready rows keyed by the data ids used by
the reference payload.  It deliberately performs no file IO: the package
builder owns sidecar serialization and hashing.
"""

from __future__ import annotations

from math import sqrt
from typing import Any, Callable

import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    normalized_mutual_info_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import (
    GroupShuffleSplit,
    StratifiedGroupKFold,
    cross_val_score,
    learning_curve,
    train_test_split,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler
from sklearn.tree import DecisionTreeClassifier


PLANET_LABELS = frozenset({"KP", "CP", "PLANET"})
FALSE_POSITIVE_LABELS = frozenset(
    {"FP", "FA", "FALSE POSITIVE", "FALSE_POSITIVE"}
)

EXPECTED_DATA_IDS = (
    "split-leakage",
    "split-class-balance",
    "pipeline-steps",
    "interpretable-coefficients",
    "interpretable-roc",
    "tree-depth-sweep",
    "decision-tree-nodes",
    "decision-tree-links",
    "ensemble-auc",
    "permutation-importance",
    "linear-nonlinear-agreement",
    "cv-scores",
    "learning-curve",
    "calibration",
    "confusion",
    "confounder-nmi",
    "sky-map",
    "yearly-planet-fraction",
)


def _normalise_labels(values: Any) -> np.ndarray:
    series = pd.Series(np.asarray(values, dtype=object), dtype="object")
    return (
        series.fillna("MISSING")
        .astype(str)
        .str.strip()
        .str.upper()
        .to_numpy(dtype=object)
    )


def _find_column(frame: pd.DataFrame, aliases: tuple[str, ...]) -> str | None:
    lookup = {str(column).strip().lower(): column for column in frame.columns}
    for alias in aliases:
        match = lookup.get(alias.strip().lower())
        if match is not None:
            return match
    return None


def _numeric_series(
    frame: pd.DataFrame, aliases: tuple[str, ...], *, length: int
) -> pd.Series:
    column = _find_column(frame, aliases)
    if column is None:
        return pd.Series(np.full(length, np.nan), dtype=float)
    return pd.to_numeric(frame[column], errors="coerce").reset_index(drop=True)


def _object_series(
    frame: pd.DataFrame, aliases: tuple[str, ...], *, length: int
) -> pd.Series:
    column = _find_column(frame, aliases)
    if column is None:
        return pd.Series(np.full(length, None, dtype=object), dtype="object")
    return frame[column].reset_index(drop=True).astype("object")


def _finite_float(value: Any) -> float:
    result = float(value)
    if not np.isfinite(result):
        raise ValueError(f"non-finite supervised result: {value!r}")
    return result


def _finite_rows(result: dict[str, list[dict[str, Any]]]) -> None:
    """Reject numpy scalars and non-finite values before JSON serialization."""

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if not isinstance(key, str):
                    raise TypeError(f"{path} has a non-string key")
                visit(child, f"{path}.{key}")
            return
        if isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")
            return
        if isinstance(value, (np.generic, np.ndarray)):
            raise TypeError(f"{path} contains a non-native numpy value")
        if isinstance(value, float) and not np.isfinite(value):
            raise ValueError(f"{path} contains {value!r}")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise TypeError(f"{path} contains unsupported {type(value).__name__}")

    if tuple(result) != EXPECTED_DATA_IDS:
        raise ValueError(
            "supervised stage ids changed: "
            f"expected {EXPECTED_DATA_IDS!r}, received {tuple(result)!r}"
        )
    visit(result, "supervised")


def _group_values(
    clean: pd.DataFrame, object_ids: np.ndarray, expected_length: int
) -> np.ndarray:
    host_column = _find_column(
        clean,
        ("tid", "tic_id", "tic id", "ticid", "host_id", "host id"),
    )
    if host_column is None:
        raw = pd.Series(object_ids, dtype="object")
    else:
        raw = clean[host_column].reset_index(drop=True).astype("object")
    if len(raw) != expected_length:
        raise ValueError("host-group column is not aligned with the clean table")

    groups: list[str] = []
    for index, value in enumerate(raw):
        if pd.isna(value) or not str(value).strip():
            groups.append(f"missing-host::{object_ids[index]}")
        elif isinstance(value, (int, np.integer)):
            groups.append(str(int(value)))
        elif isinstance(value, (float, np.floating)) and np.isfinite(value):
            groups.append(str(int(value)) if float(value).is_integer() else str(value))
        else:
            groups.append(str(value).strip())
    return np.asarray(groups, dtype=object)


def _choose_grouped_holdout(
    y: np.ndarray, groups: np.ndarray, *, seed: int, test_size: float = 0.30
) -> tuple[np.ndarray, np.ndarray]:
    """Choose a deterministic group split with a close size and class balance."""

    splitter = GroupShuffleSplit(
        n_splits=256, test_size=test_size, random_state=seed
    )
    overall_rate = float(np.mean(y))
    best: tuple[tuple[int, float], np.ndarray, np.ndarray] | None = None
    positions = np.arange(len(y))
    target_rows = int(round(len(y) * test_size))
    for train_index, test_index in splitter.split(positions, y, groups):
        if np.unique(y[train_index]).size != 2 or np.unique(y[test_index]).size != 2:
            continue
        score = (
            abs(len(test_index) - target_rows),
            abs(float(np.mean(y[train_index])) - overall_rate)
            + abs(float(np.mean(y[test_index])) - overall_rate),
        )
        candidate = (score, train_index, test_index)
        if best is None or candidate[0] < best[0]:
            best = candidate
    if best is None:
        raise ValueError("could not construct a two-class host-grouped holdout")
    return best[1], best[2]


def _linear_factory(seed: int) -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("scale", StandardScaler()),
            (
                "model",
                LogisticRegression(
                    max_iter=4_000,
                    class_weight="balanced",
                    solver="lbfgs",
                    random_state=seed,
                ),
            ),
        ]
    )


def _polynomial_factory(seed: int) -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("scale", StandardScaler()),
            ("polynomial", PolynomialFeatures(degree=2, include_bias=False)),
            ("polynomial_scale", StandardScaler()),
            (
                "model",
                LogisticRegression(
                    max_iter=4_000,
                    class_weight="balanced",
                    solver="lbfgs",
                    random_state=seed,
                ),
            ),
        ]
    )


def _cart_factory(seed: int, depth: int) -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            (
                "model",
                DecisionTreeClassifier(
                    max_depth=depth, class_weight="balanced", random_state=seed
                ),
            ),
        ]
    )


def _forest_factory(seed: int) -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            (
                "model",
                RandomForestClassifier(
                    n_estimators=400,
                    class_weight="balanced_subsample",
                    random_state=seed,
                    n_jobs=-1,
                ),
            ),
        ]
    )


def _boost_factory(seed: int) -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("model", GradientBoostingClassifier(random_state=seed)),
        ]
    )


def _roc_rows(
    model_name: str,
    estimator: Pipeline,
    x_test: pd.DataFrame,
    y_test: np.ndarray,
) -> tuple[list[dict[str, Any]], float, np.ndarray]:
    probability = np.asarray(estimator.predict_proba(x_test)[:, 1], dtype=float)
    auc = _finite_float(roc_auc_score(y_test, probability))
    fpr, tpr, _ = roc_curve(y_test, probability)
    label = f"{model_name} · AUC {auc:.3f}"
    rows = [
        {
            "model": label,
            "fpr": _finite_float(x_value),
            "tpr": _finite_float(y_value),
        }
        for x_value, y_value in zip(fpr, tpr, strict=True)
    ]
    return rows, auc, probability


def _ratio_frame(clean: pd.DataFrame, base: pd.DataFrame) -> pd.DataFrame:
    """Add the three withheld, physically motivated ratio/proxy features."""

    length = len(clean)
    period = _numeric_series(clean, ("pl_orbper",), length=length).to_numpy()
    duration = _numeric_series(clean, ("pl_trandurh",), length=length).to_numpy()
    logg = _numeric_series(clean, ("st_logg",), length=length).to_numpy()
    stellar_radius = _numeric_series(clean, ("st_rad",), length=length).to_numpy()
    planet_radius = _numeric_series(clean, ("pl_rade",), length=length).to_numpy()
    insolation = _numeric_series(clean, ("pl_insol",), length=length).to_numpy()

    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        duty_cycle = duration / (24.0 * period)
        stellar_density_proxy = np.power(10.0, logg - 4.44) / stellar_radius
        radius_residual = np.log10(planet_radius) - 0.25 * np.log10(insolation)

    result = base.copy()
    for name, values in (
        ("ratio_duty_cycle", duty_cycle),
        ("ratio_stellar_density_proxy", stellar_density_proxy),
        ("ratio_radius_insolation_residual", radius_residual),
    ):
        result[name] = np.where(np.isfinite(values), values, np.nan)
    return result


def _tree_rows(
    x_train: pd.DataFrame,
    y_train: np.ndarray,
    feature_names: list[str],
    *,
    seed: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    imputer = SimpleImputer(strategy="median", keep_empty_features=True)
    transformed = imputer.fit_transform(x_train)
    model = DecisionTreeClassifier(
        max_depth=3, class_weight="balanced", random_state=seed
    ).fit(transformed, y_train)
    tree = model.tree_
    root_samples = max(1, int(tree.n_node_samples[0]))
    nodes: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []

    for node_index in range(tree.node_count):
        values = np.asarray(tree.value[node_index]).reshape(-1).astype(float)
        total = float(values.sum())
        proportions = values / total if total > 0 else np.array([0.5, 0.5])
        fp_fraction = float(proportions[0])
        planet_fraction = float(proportions[-1])
        sample_percent = 100.0 * float(tree.n_node_samples[node_index]) / root_samples
        left = int(tree.children_left[node_index])
        right = int(tree.children_right[node_index])
        if left == right:
            majority = "Planet" if planet_fraction >= fp_fraction else "False positive"
            label = (
                f"{majority} · {sample_percent:.1f}% rows · "
                f"FP {fp_fraction:.0%} / Planet {planet_fraction:.0%}"
            )
            kind = "leaf"
        else:
            feature_index = int(tree.feature[node_index])
            feature = feature_names[feature_index]
            threshold = _finite_float(tree.threshold[node_index])
            label = (
                f"{feature} <= {threshold:.4g} · {sample_percent:.1f}% rows · "
                f"FP {fp_fraction:.0%} / Planet {planet_fraction:.0%}"
            )
            kind = "split"
            links.extend(
                [
                    {"source": f"node-{node_index}", "target": f"node-{left}"},
                    {"source": f"node-{node_index}", "target": f"node-{right}"},
                ]
            )
        nodes.append({"id": f"node-{node_index}", "label": label, "kind": kind})
    return nodes, links


def _metadata_categories(values: pd.Series) -> np.ndarray:
    """Quantile-bin numeric metadata and explicitly retain missingness."""

    series = values.reset_index(drop=True)
    numeric = pd.to_numeric(series, errors="coerce")
    non_missing = int(numeric.notna().sum())
    if non_missing and non_missing >= int(0.8 * max(1, series.notna().sum())):
        unique = int(numeric.nunique(dropna=True))
        if unique > 1:
            q = min(10, unique)
            binned = pd.qcut(numeric, q=q, labels=False, duplicates="drop")
            return np.asarray(
                ["Missing" if pd.isna(value) else f"Q{int(value) + 1}" for value in binned],
                dtype=object,
            )
    return (
        series.fillna("Missing").astype(str).replace("", "Missing").to_numpy(object)
    )


def _metadata_inputs(clean: pd.DataFrame) -> list[tuple[str, pd.Series]]:
    length = len(clean)
    equilibrium = _numeric_series(clean, ("pl_eqt",), length=length).to_numpy()
    insolation = _numeric_series(clean, ("pl_insol",), length=length).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        implied_constant = equilibrium / np.power(insolation, 0.25)
    convention = np.full(length, "Missing", dtype=object)
    finite = np.isfinite(implied_constant)
    convention[finite] = np.where(
        np.abs(implied_constant[finite] - 255.0)
        <= np.abs(implied_constant[finite] - 278.5),
        "255 K convention",
        "278.5 K convention",
    )

    updated = _object_series(
        clean, ("rowupdate", "row_updated", "row_updated_at"), length=length
    )
    created = _object_series(
        clean, ("toi_created", "created", "created_at"), length=length
    )
    updated_year = pd.to_datetime(updated, errors="coerce").dt.year
    created_year = pd.to_datetime(created, errors="coerce").dt.year

    return [
        ("eqt_convention", pd.Series(convention, dtype="object")),
        (
            "tess_magnitude",
            _numeric_series(clean, ("st_tmag", "tess_magnitude"), length=length),
        ),
        ("dec_deg", _numeric_series(clean, ("dec", "dec_deg"), length=length)),
        ("ra_deg", _numeric_series(clean, ("ra", "ra_deg"), length=length)),
        ("row_updated_year", updated_year),
        ("created_year", created_year),
    ]


def compute_supervised(
    state: dict[str, Any], unsupervised_context: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """Compute all real-data sidecars used by TESS stages 15--19."""

    clean = state["clean"].reset_index(drop=True).copy()
    model_frame = state["model_frame"].reset_index(drop=True).copy()
    feature_names = [str(value) for value in state["feature_names"]]
    labels = _normalise_labels(state["disposition_labels"])
    object_ids = np.asarray(state["object_ids"], dtype=object)
    seed = int(state.get("seed", 0))
    row_count = len(clean)

    if not (
        len(model_frame)
        == len(labels)
        == len(object_ids)
        == row_count
    ):
        raise ValueError("supervised inputs are not row-aligned")
    missing_features = [name for name in feature_names if name not in model_frame]
    if missing_features:
        raise ValueError(f"model_frame is missing features: {missing_features}")

    full_x = model_frame.loc[:, feature_names].apply(pd.to_numeric, errors="coerce")
    planet_mask = np.isin(labels, tuple(PLANET_LABELS))
    false_positive_mask = np.isin(labels, tuple(FALSE_POSITIVE_LABELS))
    adjudicated_mask = planet_mask | false_positive_mask
    adjudicated_positions = np.flatnonzero(adjudicated_mask)
    if adjudicated_positions.size == 0:
        raise ValueError("no adjudicated KP/CP/FP/FA rows were found")

    x = full_x.iloc[adjudicated_positions].reset_index(drop=True)
    y = planet_mask[adjudicated_positions].astype(int)
    if np.unique(y).size != 2:
        raise ValueError("adjudicated target does not contain both binary classes")
    all_groups = _group_values(clean, object_ids, row_count)
    groups = all_groups[adjudicated_positions]
    train_index, test_index = _choose_grouped_holdout(y, groups, seed=seed)
    x_train, x_test = x.iloc[train_index], x.iloc[test_index]
    y_train, y_test = y[train_index], y[test_index]

    # Stage 15: demonstrate why an ordinary row-stratified split leaks hosts.
    row_train, row_test = train_test_split(
        np.arange(len(y)),
        test_size=len(test_index),
        stratify=y,
        random_state=seed,
    )
    stratified_shared = len(set(groups[row_train]) & set(groups[row_test]))
    grouped_shared = len(set(groups[train_index]) & set(groups[test_index]))
    split_leakage = [
        {"strategy": "Stratified rows", "shared_hosts": int(stratified_shared)},
        {"strategy": "Grouped by TIC ID", "shared_hosts": int(grouped_shared)},
    ]

    split_class_balance: list[dict[str, Any]] = []
    for split_name, split_y in (("Train", y_train), ("Test", y_test)):
        display = f"{split_name} (n={len(split_y):,})"
        start = 0
        for class_name, class_value in (("Planet", 1), ("False positive", 0)):
            count = int(np.sum(split_y == class_value))
            end = start + count
            split_class_balance.append(
                {
                    "split": display,
                    "class": class_name,
                    "interval_start": float(start),
                    "interval_end": float(end),
                    "count": count,
                }
            )
            start = end

    pipeline_steps = [
        {"id": "split", "label": "Split by host"},
        {"id": "impute", "label": "Median impute"},
        {"id": "scale", "label": "Standardise when required"},
        {"id": "fit", "label": "Fit model"},
    ]

    # Stages 16--17: one leak-safe holdout, shared by all model comparisons.
    linear = _linear_factory(seed).fit(x_train, y_train)
    polynomial = _polynomial_factory(seed).fit(x_train, y_train)
    cart5 = _cart_factory(seed, 5).fit(x_train, y_train)
    forest = _forest_factory(seed).fit(x_train, y_train)
    boosting = _boost_factory(seed).fit(x_train, y_train)

    coefficients = np.asarray(linear.named_steps["model"].coef_[0], dtype=float)
    coefficient_rows = [
        {"feature": feature, "coefficient": _finite_float(coefficient)}
        for feature, coefficient in zip(feature_names, coefficients, strict=True)
    ]

    linear_roc, linear_auc, _ = _roc_rows(
        "Logistic", linear, x_test, y_test
    )
    polynomial_roc, polynomial_auc, _ = _roc_rows(
        "Polynomial logistic", polynomial, x_test, y_test
    )
    cart_roc, cart_auc, _ = _roc_rows(
        "CART depth 5", cart5, x_test, y_test
    )
    roc_rows = linear_roc + polynomial_roc + cart_roc

    depth_rows: list[dict[str, Any]] = []
    for depth in range(2, 9):
        estimator = _cart_factory(seed, depth).fit(x_train, y_train)
        for split, features, target in (
            ("Train", x_train, y_train),
            ("Held-out", x_test, y_test),
        ):
            score = accuracy_score(target, estimator.predict(features))
            depth_rows.append(
                {
                    "depth": int(depth),
                    "accuracy": _finite_float(score),
                    "split": split,
                }
            )
    tree_nodes, tree_links = _tree_rows(
        x_train, y_train, feature_names, seed=seed
    )

    forest_probability = np.asarray(forest.predict_proba(x_test)[:, 1], dtype=float)
    boost_probability = np.asarray(boosting.predict_proba(x_test)[:, 1], dtype=float)
    forest_auc = _finite_float(roc_auc_score(y_test, forest_probability))
    boost_auc = _finite_float(roc_auc_score(y_test, boost_probability))

    ratio_full = _ratio_frame(clean, full_x)
    ratio_x = ratio_full.iloc[adjudicated_positions].reset_index(drop=True)
    ratio_train, ratio_test = ratio_x.iloc[train_index], ratio_x.iloc[test_index]
    ratio_forest = _forest_factory(seed).fit(ratio_train, y_train)
    ratio_auc = _finite_float(
        roc_auc_score(y_test, ratio_forest.predict_proba(ratio_test)[:, 1])
    )
    ensemble_auc = [
        {"model": "Logistic", "auc": linear_auc},
        {"model": "CART depth 5", "auc": cart_auc},
        {"model": "Random forest", "auc": forest_auc},
        {"model": "Gradient boosting", "auc": boost_auc},
        {"model": "RF + ratio features", "auc": ratio_auc},
    ]

    importance = permutation_importance(
        forest,
        x_test,
        y_test,
        scoring="roc_auc",
        n_repeats=15,
        random_state=seed,
        n_jobs=1,
    )
    importance_means = np.asarray(importance.importances_mean, dtype=float)
    importance_spread = np.std(importance.importances, axis=1, ddof=1)
    importance_rows = [
        {
            "feature": feature,
            "mean": _finite_float(mean),
            "lower": _finite_float(mean - spread),
            "upper": _finite_float(mean + spread),
        }
        for feature, mean, spread in zip(
            feature_names, importance_means, importance_spread, strict=True
        )
    ]
    importance_rows.sort(key=lambda row: (-row["mean"], row["feature"]))
    agreement_rows = [
        {
            "feature": feature,
            "coefficient_abs": _finite_float(abs(coefficient)),
            "importance": _finite_float(importance_value),
        }
        for feature, coefficient, importance_value in zip(
            feature_names, coefficients, importance_means, strict=True
        )
    ]

    # Stage 18: every fold contains the full impute/scale/model pipeline.
    grouped_cv = StratifiedGroupKFold(
        n_splits=5, shuffle=True, random_state=seed
    )
    cv_rows: list[dict[str, Any]] = []
    cv_specs: tuple[tuple[str, Callable[[], Pipeline]], ...] = (
        ("Logistic", lambda: _linear_factory(seed)),
        ("CART depth 5", lambda: _cart_factory(seed, 5)),
        ("Random forest", lambda: _forest_factory(seed)),
    )
    for model_name, factory in cv_specs:
        scores = np.asarray(
            cross_val_score(
                factory(),
                x,
                y,
                groups=groups,
                cv=grouped_cv,
                scoring="balanced_accuracy",
                n_jobs=1,
            ),
            dtype=float,
        )
        mean = _finite_float(np.mean(scores))
        standard_error = _finite_float(np.std(scores, ddof=1) / sqrt(len(scores)))
        cv_rows.append(
            {
                "model": model_name,
                "mean": mean,
                "lower": _finite_float(mean - standard_error),
                "upper": _finite_float(mean + standard_error),
            }
        )

    train_sizes, train_scores, heldout_scores = learning_curve(
        _forest_factory(seed),
        x,
        y,
        groups=groups,
        cv=grouped_cv,
        scoring="balanced_accuracy",
        train_sizes=np.linspace(0.2, 1.0, 6),
        shuffle=True,
        random_state=seed,
        n_jobs=1,
    )
    learning_rows: list[dict[str, Any]] = []
    for size_index, n_train in enumerate(train_sizes):
        for series, scores in (
            ("Train", train_scores[size_index]),
            ("Held-out", heldout_scores[size_index]),
        ):
            scores = np.asarray(scores, dtype=float)
            mean = _finite_float(np.mean(scores))
            standard_error = _finite_float(
                np.std(scores, ddof=1) / sqrt(len(scores))
            )
            learning_rows.append(
                {
                    "n_train": int(n_train),
                    "series": series,
                    "score": mean,
                    "lower": _finite_float(mean - standard_error),
                    "upper": _finite_float(mean + standard_error),
                }
            )

    observed, predicted = calibration_curve(
        y_test, forest_probability, n_bins=10, strategy="quantile"
    )
    calibration_rows = [
        {
            "predicted": _finite_float(predicted_value),
            "observed": _finite_float(observed_value),
        }
        for predicted_value, observed_value in zip(predicted, observed, strict=True)
    ]
    matrix = confusion_matrix(
        y_test, (forest_probability >= 0.5).astype(int), labels=[0, 1], normalize="true"
    )
    class_names = ("False positive", "Planet")
    confusion_rows = [
        {
            "actual": actual_name,
            "predicted": predicted_name,
            "value": _finite_float(matrix[actual_index, predicted_index]),
        }
        for actual_index, actual_name in enumerate(class_names)
        for predicted_index, predicted_name in enumerate(class_names)
    ]

    # Stage 19: metadata confounding checks use every post-QC row.
    kmeans_labels = np.asarray(unsupervised_context["kmeans_labels"], dtype=object)
    if len(kmeans_labels) != row_count:
        raise ValueError("kmeans_labels are not aligned with the clean table")
    disposition_categories = labels.astype(str)
    cluster_categories = np.asarray(
        [f"C{int(value)}" if str(value).lstrip("-").isdigit() else str(value) for value in kmeans_labels],
        dtype=object,
    )
    nmi_rows: list[dict[str, Any]] = []
    for metadata, values in _metadata_inputs(clean):
        categories = _metadata_categories(values)
        for target, target_values in (
            ("Disposition", disposition_categories),
            ("k-means cluster", cluster_categories),
        ):
            nmi = normalized_mutual_info_score(categories, target_values)
            nmi_rows.append(
                {
                    "metadata": metadata,
                    "target": target,
                    "bar_label": f"{metadata} · {target}",
                    "nmi": _finite_float(nmi),
                }
            )

    ra = _numeric_series(clean, ("ra", "ra_deg"), length=row_count).to_numpy()
    dec = _numeric_series(clean, ("dec", "dec_deg"), length=row_count).to_numpy()
    sky_rows = [
        {
            "ra_deg": _finite_float(ra[index]),
            "dec_deg": _finite_float(dec[index]),
            "cluster": str(cluster_categories[index]),
        }
        for index in range(row_count)
        if np.isfinite(ra[index]) and np.isfinite(dec[index])
    ]

    created = _object_series(
        clean, ("toi_created", "created", "created_at"), length=row_count
    )
    created_year = pd.to_datetime(created, errors="coerce").dt.year.to_numpy()
    yearly_rows: list[dict[str, Any]] = []
    for year in range(2018, 2025):
        mask = adjudicated_mask & (created_year == year)
        if not np.any(mask):
            continue
        fraction = float(np.mean(planet_mask[mask]))
        yearly_rows.append(
            {"year": int(year), "planet_fraction": _finite_float(fraction)}
        )

    result: dict[str, list[dict[str, Any]]] = {
        "split-leakage": split_leakage,
        "split-class-balance": split_class_balance,
        "pipeline-steps": pipeline_steps,
        "interpretable-coefficients": coefficient_rows,
        "interpretable-roc": roc_rows,
        "tree-depth-sweep": depth_rows,
        "decision-tree-nodes": tree_nodes,
        "decision-tree-links": tree_links,
        "ensemble-auc": ensemble_auc,
        "permutation-importance": importance_rows,
        "linear-nonlinear-agreement": agreement_rows,
        "cv-scores": cv_rows,
        "learning-curve": learning_rows,
        "calibration": calibration_rows,
        "confusion": confusion_rows,
        "confounder-nmi": nmi_rows,
        "sky-map": sky_rows,
        "yearly-planet-fraction": yearly_rows,
    }
    _finite_rows(result)
    return result
