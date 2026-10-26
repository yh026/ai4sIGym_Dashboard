"""Real-data computations for TESS stages 09--14.

The functions in this module are deliberately presentation-agnostic.  They
recompute the arrays declared by the reference payload and return ordinary
row dictionaries; the payload compiler remains responsible for rendering.
"""

from __future__ import annotations

from typing import Any

import hdbscan
import numpy as np
from scipy.cluster.hierarchy import leaves_list, linkage
from scipy.spatial import procrustes
from scipy.spatial.distance import pdist, squareform
from scipy.stats import spearmanr
from sklearn.cluster import DBSCAN, KMeans
from sklearn.manifold import TSNE, trustworthiness
from sklearn.metrics import (
    adjusted_rand_score,
    normalized_mutual_info_score,
    silhouette_score,
)
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import NearestNeighbors
from sklearn.random_projection import GaussianRandomProjection
from umap import UMAP


EMBEDDING_SAMPLE_SIZE = 3_000
METRIC_SAMPLE_SIZE = 1_500
SHEPARD_PAIR_COUNT = 100_000
EMBEDDING_K_GRID = (5, 10, 20, 40, 60, 80)
VQ_EXPLORER_SIZES = (2, 4, 6, 8, 10, 12, 14, 16)

STAGE_09_TO_14_DATA_IDS = {
    "embedding-sweep",
    "embedding-quality",
    "shepard-distances",
    "seed-disparity",
    "partition-overlays",
    "max-responsibility-histogram",
    "responsibility-map",
    "responsibility-matrix",
    "silhouette-null",
    "gmm-bic",
    "partition-agreement",
    "silhouette-spaces",
    "partition-seed-ari",
    "vq-distortion",
    "vq-design-matrix",
    "vq-planet-fraction",
    "vq-reconstruction",
    "vq-excess-error",
    "vq-map-agreement",
    "vq-explorer-points",
    "vq-explorer-profiles",
}


def _number(value: Any, digits: int = 8) -> float:
    """Return a finite, compact, JSON-native float."""

    result = float(value)
    if not np.isfinite(result):
        raise ValueError(f"Non-finite unsupervised result: {result}")
    return round(result, digits)


def _matrix(value: Any, *, name: str, rows: int | None = None) -> np.ndarray:
    result = np.asarray(value, dtype=np.float64)
    if result.ndim != 2:
        raise ValueError(f"{name} must be a two-dimensional array, got {result.shape}")
    if rows is not None and result.shape[0] != rows:
        raise ValueError(f"{name} has {result.shape[0]} rows; expected {rows}")
    if not np.isfinite(result).all():
        raise ValueError(f"{name} contains non-finite values")
    return result


def _vector(value: Any, *, name: str, rows: int) -> np.ndarray:
    result = np.asarray(value)
    if result.ndim != 1 or len(result) != rows:
        raise ValueError(f"{name} must have shape ({rows},), got {result.shape}")
    return result


def _fit_umap(values: np.ndarray, *, neighbours: int, seed: int) -> np.ndarray:
    effective_neighbours = min(max(2, int(neighbours)), len(values) - 1)
    model = UMAP(
        n_components=2,
        n_neighbors=effective_neighbours,
        min_dist=0.1,
        metric="euclidean",
        random_state=seed,
        transform_seed=seed,
        n_jobs=1,
        low_memory=True,
    )
    return _matrix(model.fit_transform(values), name="UMAP embedding", rows=len(values))


def _fit_tsne(values: np.ndarray, *, perplexity: int, seed: int) -> np.ndarray:
    # The clamp only affects small development fixtures; the TESS sample has
    # 3,000 rows and therefore uses the declared perplexity unchanged.
    effective_perplexity = min(float(perplexity), max(2.0, (len(values) - 1) / 3.0))
    model = TSNE(
        n_components=2,
        perplexity=effective_perplexity,
        init="pca",
        learning_rate="auto",
        max_iter=1_000,
        method="barnes_hut",
        angle=0.5,
        random_state=seed,
        n_jobs=1,
    )
    return _matrix(model.fit_transform(values), name="t-SNE embedding", rows=len(values))


def _fit_kmeans(
    values: np.ndarray, *, clusters: int, seed: int
) -> tuple[KMeans, np.ndarray]:
    model = KMeans(
        n_clusters=int(clusters),
        init="k-means++",
        n_init=10,
        max_iter=300,
        algorithm="lloyd",
        random_state=seed,
    )
    raw_labels = model.fit_predict(values)
    # Stabilise the human-facing codeword numbers by ordering centroids
    # lexicographically, starting with the first fitted dimension.
    order = sorted(
        range(clusters),
        key=lambda index: tuple(float(item) for item in model.cluster_centers_[index]),
    )
    remap = np.empty(clusters, dtype=np.int32)
    for canonical, original in enumerate(order):
        remap[original] = canonical
    return model, remap[np.asarray(raw_labels, dtype=np.int32)]


def _canonical_partition(labels: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Relabel a density partition deterministically while retaining -1 noise."""

    labels = np.asarray(labels, dtype=np.int32)
    clusters = [int(item) for item in np.unique(labels) if item >= 0]
    order = sorted(
        clusters,
        key=lambda label: tuple(
            float(item) for item in np.mean(values[labels == label], axis=0)
        ),
    )
    result = np.full(len(labels), -1, dtype=np.int32)
    for canonical, original in enumerate(order):
        result[labels == original] = canonical
    return result


def _cluster_name(method: str, label: int) -> str:
    if label < 0:
        return "noise"
    prefixes = {"kmeans": "C", "hdbscan": "H", "dbscan": "D"}
    return f"{prefixes[method]}{int(label)}"


def _fixed_silhouette(
    values: np.ndarray, labels: np.ndarray, positions: np.ndarray
) -> float:
    selected_values = values[positions]
    selected_labels = np.asarray(labels)[positions]
    unique = np.unique(selected_labels)
    if len(unique) < 2 or len(unique) >= len(selected_labels):
        raise RuntimeError(
            f"Silhouette requires 2..n-1 labels; observed {len(unique)} labels "
            f"for {len(selected_labels)} rows"
        )
    return float(silhouette_score(selected_values, selected_labels, metric="euclidean"))


def _cached_embedding(state: dict[str, Any], key: str, rows: int) -> np.ndarray | None:
    """Accept an orchestrator-supplied UMAP cache without owning cache I/O."""

    candidate = state.get(key)
    if candidate is None and isinstance(state.get("cache"), dict):
        candidate = state["cache"].get(key)
    if candidate is None:
        return None
    return _matrix(candidate, name=key, rows=rows)


def _reconstruction_error(values: np.ndarray, labels: np.ndarray) -> float:
    reconstructed = np.empty_like(values)
    for label in np.unique(labels):
        mask = labels == label
        reconstructed[mask] = np.mean(values[mask], axis=0)
    residual = values - reconstructed
    return float(np.mean(np.sum(residual * residual, axis=1)))


def _seriated_feature_indices(values: np.ndarray) -> np.ndarray:
    correlations = np.corrcoef(values, rowvar=False)
    distances = np.clip(1.0 - np.abs(correlations), 0.0, 2.0)
    np.fill_diagonal(distances, 0.0)
    tree = linkage(
        squareform(distances, checks=False),
        method="average",
        optimal_ordering=True,
    )
    return np.asarray(leaves_list(tree), dtype=np.int32)


def _embedding_rows(
    *,
    facet: str,
    coordinates: np.ndarray,
    object_ids: np.ndarray,
    dispositions: np.ndarray,
) -> list[dict[str, Any]]:
    return [
        {
            "facet": facet,
            "object_id": str(object_id),
            "disposition": str(disposition),
            "x": _number(point[0], 6),
            "y": _number(point[1], 6),
        }
        for point, object_id, disposition in zip(
            coordinates, object_ids, dispositions, strict=True
        )
    ]


def compute_unsupervised(
    state: dict[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """Compute every real-data sidecar row used by stages 09--14.

    Stage 09/10 sweeps use one deterministic 3,000-row sample.  The shipped
    UMAP, all stage-11/12 partitions, and every stage-14 explorer setting use
    the full post-QC table.  Optional UMAP arrays supplied by the orchestrator
    are consumed but this module never reads or writes cache files itself.
    """

    x_scaled = _matrix(state["X_scaled"], name="X_scaled")
    n_rows, n_features = x_scaled.shape
    if n_rows < 100:
        raise ValueError("At least 100 rows are required for stages 09--14")
    seed = int(state.get("seed", 0))
    feature_names = [str(item) for item in state["feature_names"]]
    if len(feature_names) != n_features:
        raise ValueError(
            f"feature_names has {len(feature_names)} entries for {n_features} columns"
        )

    object_ids = _vector(state["object_ids"], name="object_ids", rows=n_rows).astype(str)
    dispositions = _vector(
        state["disposition_labels"], name="disposition_labels", rows=n_rows
    ).astype(str)
    unexpected_dispositions = set(dispositions) - {
        "Planet",
        "False_positive",
        "Open",
    }
    if unexpected_dispositions:
        raise ValueError(f"Unexpected three-way dispositions: {unexpected_dispositions}")

    pca_scores_value = state.get("pca_scores")
    if pca_scores_value is None:
        pca_scores_value = state["pca"].transform(x_scaled)
    pca_scores = _matrix(pca_scores_value, name="pca_scores", rows=n_rows)
    if pca_scores.shape[1] < 6:
        raise ValueError("pca_scores must retain at least six components")

    sample_size = min(EMBEDDING_SAMPLE_SIZE, n_rows)
    sample_rng = np.random.default_rng(seed)
    sample_indices = np.sort(
        sample_rng.choice(n_rows, size=sample_size, replace=False)
    )
    x_sample = x_scaled[sample_indices]
    sample_object_ids = object_ids[sample_indices]
    sample_dispositions = dispositions[sample_indices]

    metric_size = min(METRIC_SAMPLE_SIZE, sample_size)
    metric_rng = np.random.default_rng(seed + 10_001)
    metric_positions = np.sort(
        metric_rng.choice(sample_size, size=metric_size, replace=False)
    )
    full_metric_size = min(3_000, n_rows)
    full_metric_rng = np.random.default_rng(seed + 10_002)
    full_metric_indices = np.sort(
        full_metric_rng.choice(n_rows, size=full_metric_size, replace=False)
    )

    # Stage 09: all six declared embeddings use the same rows and labels.
    tsne_embeddings = {
        perplexity: _fit_tsne(x_sample, perplexity=perplexity, seed=seed)
        for perplexity in (10, 30, 80)
    }
    umap_embeddings = {
        neighbours: _fit_umap(x_sample, neighbours=neighbours, seed=seed)
        for neighbours in (5, 15, 50)
    }
    embedding_sweep: list[dict[str, Any]] = []
    for perplexity in (10, 30, 80):
        embedding_sweep.extend(
            _embedding_rows(
                facet=f"tsne-{perplexity}",
                coordinates=tsne_embeddings[perplexity],
                object_ids=sample_object_ids,
                dispositions=sample_dispositions,
            )
        )
    for neighbours in (5, 15, 50):
        embedding_sweep.extend(
            _embedding_rows(
                facet=f"umap-{neighbours}",
                coordinates=umap_embeddings[neighbours],
                object_ids=sample_object_ids,
                dispositions=sample_dispositions,
            )
        )

    # Stage 10: trustworthiness and continuity are evaluated on one fixed
    # 1,500-row metric sample.  Continuity is reverse trustworthiness.
    metric_x = x_sample[metric_positions]
    metric_embeddings = {
        "UMAP": umap_embeddings[15][metric_positions],
        "t-SNE": tsne_embeddings[30][metric_positions],
        "PCA-2": pca_scores[sample_indices, :2][metric_positions],
    }
    random_projection = GaussianRandomProjection(
        n_components=2, random_state=seed
    ).fit_transform(metric_x)
    random_projection_null = float(
        trustworthiness(
            metric_x,
            random_projection,
            n_neighbors=min(20, max(1, (metric_size - 1) // 2)),
            metric="euclidean",
        )
    )
    embedding_quality: list[dict[str, Any]] = []
    for method, coordinates in metric_embeddings.items():
        trust_values: list[tuple[int, float]] = []
        continuity_values: list[tuple[int, float]] = []
        for k in EMBEDDING_K_GRID:
            effective_k = min(k, max(1, (metric_size - 1) // 2))
            trust_values.append(
                (
                    k,
                    float(
                        trustworthiness(
                            metric_x,
                            coordinates,
                            n_neighbors=effective_k,
                            metric="euclidean",
                        )
                    ),
                )
            )
            continuity_values.append(
                (
                    k,
                    float(
                        trustworthiness(
                            coordinates,
                            metric_x,
                            n_neighbors=effective_k,
                            metric="euclidean",
                        )
                    ),
                )
            )
        embedding_quality.extend(
            {"k": int(k), "score": _number(score), "series": f"{method} trust"}
            for k, score in trust_values
        )
        embedding_quality.extend(
            {
                "k": int(k),
                "score": _number(score),
                "series": f"{method} continuity",
            }
            for k, score in continuity_values
        )

    feature_distances = pdist(metric_x, metric="euclidean")
    embedding_distances = pdist(metric_embeddings["UMAP"], metric="euclidean")
    pair_count = min(SHEPARD_PAIR_COUNT, len(feature_distances))
    pair_rng = np.random.default_rng(seed + 10_003)
    pair_positions = np.sort(
        pair_rng.choice(len(feature_distances), size=pair_count, replace=False)
    )
    selected_feature_distances = feature_distances[pair_positions]
    selected_embedding_distances = embedding_distances[pair_positions]
    shepard_distances = [
        {
            "feature_distance": _number(feature_distance, 6),
            "embedding_distance": _number(embedding_distance, 6),
        }
        for feature_distance, embedding_distance in zip(
            selected_feature_distances,
            selected_embedding_distances,
            strict=True,
        )
    ]
    shepard_spearman = float(
        spearmanr(selected_feature_distances, selected_embedding_distances).statistic
    )

    seed_embeddings = {
        seed: umap_embeddings[15],
        seed + 1: _fit_umap(x_sample, neighbours=15, seed=seed + 1),
        seed + 2: _fit_umap(x_sample, neighbours=15, seed=seed + 2),
    }
    seed_disparity: list[dict[str, Any]] = []
    for left, right in ((seed, seed + 1), (seed, seed + 2), (seed + 1, seed + 2)):
        _, _, disparity = procrustes(seed_embeddings[left], seed_embeddings[right])
        seed_disparity.append(
            {
                "seed_pair": f"{left} vs {right}",
                "disparity": _number(disparity),
            }
        )

    umap_full = _cached_embedding(state, "umap_full", n_rows)
    if umap_full is None:
        umap_full = _fit_umap(x_scaled, neighbours=15, seed=seed)

    # Stage 11: fit every partition in the standardised 11-D feature space,
    # then join the assignments to the single shipped full-row UMAP.
    _, kmeans_labels = _fit_kmeans(x_scaled, clusters=4, seed=seed)

    dbscan_epsilon_value = state.get("dbscan_epsilon")
    if dbscan_epsilon_value is None:
        neighbour_count = min(11, n_rows)
        distances, _ = NearestNeighbors(
            n_neighbors=neighbour_count, metric="euclidean", n_jobs=1
        ).fit(x_scaled).kneighbors(x_scaled)
        dbscan_epsilon_value = np.quantile(distances[:, -1], 0.95)
    dbscan_epsilon = float(dbscan_epsilon_value)
    raw_dbscan_labels = DBSCAN(
        eps=dbscan_epsilon,
        min_samples=10,
        metric="euclidean",
        n_jobs=1,
    ).fit_predict(x_scaled)
    dbscan_labels = _canonical_partition(raw_dbscan_labels, x_scaled)

    hdbscan_minimum = min(25, max(2, n_rows // 10))
    raw_hdbscan_labels = hdbscan.HDBSCAN(
        min_cluster_size=hdbscan_minimum,
        min_samples=None,
        metric="euclidean",
        cluster_selection_method="eom",
        allow_single_cluster=False,
        core_dist_n_jobs=1,
        prediction_data=False,
    ).fit_predict(x_scaled)
    hdbscan_labels = _canonical_partition(raw_hdbscan_labels, x_scaled)

    partitions = {
        "kmeans": kmeans_labels,
        "hdbscan": hdbscan_labels,
        "dbscan": dbscan_labels,
    }
    partition_overlays: list[dict[str, Any]] = []
    for method in ("kmeans", "hdbscan", "dbscan"):
        partition_overlays.extend(
            {
                "method": method,
                "object_id": str(object_id),
                "x": _number(point[0], 6),
                "y": _number(point[1], 6),
                "cluster": _cluster_name(method, int(label)),
            }
            for point, object_id, label in zip(
                umap_full, object_ids, partitions[method], strict=True
            )
        )

    # Stage 12: the full-covariance four-component mixture supplies the map,
    # histogram, and a deterministically thinned, component-sorted heatmap.
    gmm = GaussianMixture(
        n_components=4,
        covariance_type="full",
        n_init=3,
        max_iter=300,
        reg_covar=1e-6,
        random_state=seed,
    ).fit(x_scaled)
    raw_responsibilities = gmm.predict_proba(x_scaled)
    component_order = sorted(
        range(4),
        key=lambda index: tuple(float(item) for item in gmm.means_[index]),
    )
    responsibilities = raw_responsibilities[:, component_order]
    gmm_labels = np.argmax(responsibilities, axis=1).astype(np.int32)
    max_responsibility = np.max(responsibilities, axis=1)

    responsibility_edges = np.linspace(0.25, 1.0, 31)
    responsibility_counts, _ = np.histogram(
        np.clip(max_responsibility, 0.25, 1.0), bins=responsibility_edges
    )
    responsibility_centres = (responsibility_edges[:-1] + responsibility_edges[1:]) / 2
    responsibility_histogram = [
        {"responsibility": _number(centre, 6), "count": int(count)}
        for centre, count in zip(
            responsibility_centres, responsibility_counts, strict=True
        )
    ]
    responsibility_map = [
        {
            "object_id": str(object_id),
            "x": _number(point[0], 6),
            "y": _number(point[1], 6),
            "max_responsibility": _number(confidence),
        }
        for point, object_id, confidence in zip(
            umap_full, object_ids, max_responsibility, strict=True
        )
    ]
    responsibility_order = np.lexsort((-max_responsibility, gmm_labels))[::12]
    responsibility_matrix: list[dict[str, Any]] = []
    for row_index in responsibility_order:
        for component in range(4):
            responsibility_matrix.append(
                {
                    "object_id": str(object_ids[row_index]),
                    "component": f"G{component + 1}",
                    "responsibility": _number(responsibilities[row_index, component]),
                }
            )

    # Stage 13: model-order curves use the declared 3,000-row sample.  Each
    # feature column is independently permuted for the shuffled-feature null.
    silhouette_null: list[dict[str, Any]] = []
    gmm_bic: list[dict[str, Any]] = []
    null_x = x_sample.copy()
    null_rng = np.random.default_rng(seed + 13_001)
    for column in range(n_features):
        null_rng.shuffle(null_x[:, column])
    for clusters in range(2, 11):
        _, observed_labels = _fit_kmeans(x_sample, clusters=clusters, seed=seed)
        _, null_labels = _fit_kmeans(null_x, clusters=clusters, seed=seed)
        silhouette_null.extend(
            [
                {
                    "k": clusters,
                    "score": _number(
                        _fixed_silhouette(x_sample, observed_labels, metric_positions)
                    ),
                    "series": "Observed",
                },
                {
                    "k": clusters,
                    "score": _number(
                        _fixed_silhouette(null_x, null_labels, metric_positions)
                    ),
                    "series": "Shuffled-feature null",
                },
            ]
        )
        order_model = GaussianMixture(
            n_components=clusters,
            covariance_type="full",
            n_init=3,
            max_iter=300,
            reg_covar=1e-6,
            random_state=seed,
        ).fit(x_sample)
        gmm_bic.append({"k": clusters, "bic": _number(order_model.bic(x_sample), 4)})

    agreement_definitions = [
        ("k-means vs GMM", kmeans_labels, gmm_labels),
        ("k-means vs HDBSCAN", kmeans_labels, hdbscan_labels),
        ("k-means vs DBSCAN", kmeans_labels, dbscan_labels),
        ("GMM vs disposition", gmm_labels, dispositions),
        ("k-means vs disposition", kmeans_labels, dispositions),
    ]
    partition_agreement: list[dict[str, Any]] = []
    for comparison, left, right in agreement_definitions:
        metrics = (
            ("ARI", adjusted_rand_score(left, right)),
            ("NMI", normalized_mutual_info_score(left, right)),
        )
        partition_agreement.extend(
            {
                "comparison": comparison,
                "metric": metric,
                "bar_label": f"{comparison} · {metric}",
                "value": _number(value),
            }
            for metric, value in metrics
        )

    space_values = {
        "UMAP-2": umap_embeddings[15],
        "t-SNE-2": tsne_embeddings[30],
        "PCA-2": pca_scores[sample_indices, :2],
        "PCA-6": pca_scores[sample_indices, :6],
        "Standardised-11D": x_sample,
    }
    silhouette_spaces: list[dict[str, Any]] = []
    for space, values in space_values.items():
        _, labels = _fit_kmeans(values, clusters=4, seed=seed)
        scores = (
            ("Own space", _fixed_silhouette(values, labels, metric_positions)),
            ("11-D", _fixed_silhouette(x_sample, labels, metric_positions)),
        )
        silhouette_spaces.extend(
            {
                "space": space,
                "scored_in": scored_in,
                "bar_label": f"{space} · {scored_in}",
                "score": _number(score),
            }
            for scored_in, score in scores
        )

    umap_full_seed_1 = _cached_embedding(state, "umap_full_seed_1", n_rows)
    if umap_full_seed_1 is None:
        umap_full_seed_1 = _fit_umap(x_scaled, neighbours=15, seed=seed + 1)
    _, map_seed_labels_0 = _fit_kmeans(umap_full, clusters=4, seed=seed)
    _, map_seed_labels_1 = _fit_kmeans(umap_full_seed_1, clusters=4, seed=seed)
    _, kmeans_seed_labels_1 = _fit_kmeans(x_scaled, clusters=4, seed=seed + 1)
    partition_seed_ari = [
        {
            "method": "UMAP seed rerun",
            "ari": _number(adjusted_rand_score(map_seed_labels_0, map_seed_labels_1)),
        },
        {
            "method": "k-means seed rerun",
            "ari": _number(adjusted_rand_score(kmeans_labels, kmeans_seed_labels_1)),
        },
    ]

    # Stage 14: fit complete codebook grids in PCA-6 and on the shipped UMAP.
    # Explorer rows always use the common UMAP coordinates so that changing
    # codebook space changes assignment, not the visual reference frame.
    pca_6 = pca_scores[:, :6]
    vq_fits: dict[tuple[str, int], tuple[KMeans, np.ndarray]] = {}
    for clusters in VQ_EXPLORER_SIZES:
        vq_fits[("PCA-6", clusters)] = _fit_kmeans(
            pca_6, clusters=clusters, seed=seed
        )
        vq_fits[("PCA-6-to-UMAP-2", clusters)] = _fit_kmeans(
            umap_full, clusters=clusters, seed=seed
        )
    for clusters in (32, 64):
        vq_fits[("PCA-6", clusters)] = _fit_kmeans(
            pca_6, clusters=clusters, seed=seed
        )

    vq_distortion = [
        {
            "k": clusters,
            "distortion": _number(
                vq_fits[("PCA-6", clusters)][0].inertia_ / n_rows
            ),
        }
        for clusters in (2, 4, 8, 16, 32, 64)
    ]

    shipped_vq_labels = vq_fits[("PCA-6", 8)][1]
    feature_order = _seriated_feature_indices(x_scaled)
    matrix_order = np.lexsort((pca_scores[:, 0], shipped_vq_labels))[::6]
    vq_design_matrix: list[dict[str, Any]] = []
    for row_index in matrix_order:
        for feature_index in feature_order:
            vq_design_matrix.append(
                {
                    "object_id": str(object_ids[row_index]),
                    "feature": feature_names[int(feature_index)],
                    "z": _number(np.clip(x_scaled[row_index, feature_index], -3.0, 3.0)),
                    "codeword": int(shipped_vq_labels[row_index]),
                }
            )

    vq_planet_fraction: list[dict[str, Any]] = []
    for codeword in range(8):
        mask = shipped_vq_labels == codeword
        adjudicated_mask = mask & np.isin(
            dispositions, ("Planet", "False_positive")
        )
        adjudicated = int(np.sum(adjudicated_mask))
        if adjudicated < 5:
            continue
        planet_fraction = float(
            np.mean(dispositions[adjudicated_mask] == "Planet")
        )
        vq_planet_fraction.append(
            {
                "codeword": f"C{codeword}",
                "adjudicated": adjudicated,
                "planet_fraction": _number(planet_fraction),
            }
        )

    reconstruction_values: dict[tuple[str, int], float] = {}
    vq_reconstruction: list[dict[str, Any]] = []
    vq_excess_error: list[dict[str, Any]] = []
    vq_map_agreement: list[dict[str, Any]] = []
    for clusters in VQ_EXPLORER_SIZES:
        labels_a = vq_fits[("PCA-6", clusters)][1]
        labels_b = vq_fits[("PCA-6-to-UMAP-2", clusters)][1]
        error_a = _reconstruction_error(x_scaled, labels_a)
        error_b = _reconstruction_error(x_scaled, labels_b)
        reconstruction_values[("PCA-6", clusters)] = error_a
        reconstruction_values[("PCA-6-to-UMAP-2", clusters)] = error_b
        vq_reconstruction.extend(
            [
                {"k": clusters, "space": "PCA-6", "error": _number(error_a)},
                {
                    "k": clusters,
                    "space": "PCA-6-to-UMAP-2",
                    "error": _number(error_b),
                },
            ]
        )
        vq_excess_error.append(
            {
                "k": clusters,
                "excess_percent": _number(100.0 * (error_b / error_a - 1.0)),
            }
        )
        map_silhouette_a = _fixed_silhouette(
            umap_full, labels_a, full_metric_indices
        )
        map_silhouette_b = _fixed_silhouette(
            umap_full, labels_b, full_metric_indices
        )
        vq_map_agreement.extend(
            [
                {
                    "k": clusters,
                    "series": "PCA-6 silhouette",
                    "score": _number(map_silhouette_a),
                },
                {
                    "k": clusters,
                    "series": "Map silhouette",
                    "score": _number(map_silhouette_b),
                },
                {
                    "k": clusters,
                    "series": "ARI between codebooks",
                    "score": _number(adjusted_rand_score(labels_a, labels_b)),
                },
            ]
        )

    vq_explorer_points: list[dict[str, Any]] = []
    vq_explorer_profiles: list[dict[str, Any]] = []
    for space in ("PCA-6", "PCA-6-to-UMAP-2"):
        for clusters in VQ_EXPLORER_SIZES:
            labels = vq_fits[(space, clusters)][1]
            vq_explorer_points.extend(
                {
                    "object_id": str(object_id),
                    "space": space,
                    "k": clusters,
                    "codeword": int(codeword),
                    "x": _number(point[0], 6),
                    "y": _number(point[1], 6),
                }
                for object_id, codeword, point in zip(
                    object_ids, labels, umap_full, strict=True
                )
            )
            for codeword in range(clusters):
                members = x_scaled[labels == codeword]
                means = np.mean(members, axis=0)
                spreads = np.std(members, axis=0, ddof=0)
                for feature_index, feature in enumerate(feature_names):
                    mean = float(means[feature_index])
                    spread = float(spreads[feature_index])
                    vq_explorer_profiles.append(
                        {
                            "space": space,
                            "k": clusters,
                            "codeword": codeword,
                            "feature": feature,
                            "mean": _number(np.clip(mean, -3.0, 3.0)),
                            "lower": _number(np.clip(mean - spread, -3.0, 3.0)),
                            "upper": _number(np.clip(mean + spread, -3.0, 3.0)),
                        }
                    )

    rows_by_id: dict[str, list[dict[str, Any]]] = {
        "embedding-sweep": embedding_sweep,
        "embedding-quality": embedding_quality,
        "shepard-distances": shepard_distances,
        "seed-disparity": seed_disparity,
        "partition-overlays": partition_overlays,
        "max-responsibility-histogram": responsibility_histogram,
        "responsibility-map": responsibility_map,
        "responsibility-matrix": responsibility_matrix,
        "silhouette-null": silhouette_null,
        "gmm-bic": gmm_bic,
        "partition-agreement": partition_agreement,
        "silhouette-spaces": silhouette_spaces,
        "partition-seed-ari": partition_seed_ari,
        "vq-distortion": vq_distortion,
        "vq-design-matrix": vq_design_matrix,
        "vq-planet-fraction": vq_planet_fraction,
        "vq-reconstruction": vq_reconstruction,
        "vq-excess-error": vq_excess_error,
        "vq-map-agreement": vq_map_agreement,
        "vq-explorer-points": vq_explorer_points,
        "vq-explorer-profiles": vq_explorer_profiles,
    }
    if set(rows_by_id) != STAGE_09_TO_14_DATA_IDS:
        raise AssertionError(
            f"Stage 09--14 data-id drift: {sorted(set(rows_by_id) ^ STAGE_09_TO_14_DATA_IDS)}"
        )

    context: dict[str, Any] = {
        "embedding_sample_indices": sample_indices,
        "umap_full": umap_full,
        "umap_full_seed_1": umap_full_seed_1,
        "kmeans_labels": kmeans_labels,
        "dbscan_labels": dbscan_labels,
        "hdbscan_labels": hdbscan_labels,
        "gmm_labels": gmm_labels,
        "gmm_responsibilities": responsibilities,
        "vq_labels": shipped_vq_labels,
        "cluster_labels": {
            "kmeans": kmeans_labels,
            "dbscan": dbscan_labels,
            "hdbscan": hdbscan_labels,
            "gmm": gmm_labels,
            "vq_pca6_k8": shipped_vq_labels,
        },
        "dbscan_epsilon": dbscan_epsilon,
        "random_projection_null": random_projection_null,
        "shepard_spearman": shepard_spearman,
        "gmm_bic_k4": float(gmm.bic(x_scaled)),
        "gmm_below_0_6": int(np.sum(max_responsibility < 0.6)),
        "vq_reconstruction": reconstruction_values,
    }
    return rows_by_id, context
