# Payload contract

## Contents

1. Top-level structure
2. Stage structure
3. Artifact kinds
4. Payload v3 visual specification
5. Validation rules

## Top-level structure

The compiler currently accepts the `2.2.x` family used by the reference TESS payload.

```json
{
  "schema_version": "2.2.0",
  "run": {},
  "dataset": {},
  "header": {},
  "acts": [],
  "stages": [],
  "glossary_intro": "",
  "glossary": []
}
```

Required fields:

- `schema_version`: non-empty string.
- `dataset`: object describing the source dataset.
- `header`: object with `title`, optional `subtitle`, `facts`, `claim`, and `final_verdict`.
- `acts`: ordered array of `{id, numeral, name, stage_ids}`.
- `stages`: ordered array of stage objects.

## Stage structure

```json
{
  "id": 0,
  "act": "act1",
  "short_label": "QC",
  "title": "Quality control",
  "summary": "Short result statement.",
  "concepts": ["Concept one · concept two"],
  "narrative": ["Paragraph with **bold** and `code`."],
  "metrics": [{"name": "rows kept", "value": 100}],
  "objective": {"minimises": "...", "reports": "..."},
  "checks": [{"id": "check-1", "kind": "sanity", "result": "pass"}],
  "caveats": ["Important limitation."],
  "artifacts": []
}
```

The safe inline Markdown subset supports `**bold**` and backtick code only. HTML is always displayed as text.

## Artifact kinds

Every artifact requires a globally unique `id`, a supported `kind`, and an optional `description`.

### `distribution`

Categorical counts:

```json
{"id":"counts","kind":"distribution","categories":["A","B"],"counts":[12,8],"variable":"rows"}
```

Raw samples:

```json
{"id":"null-scores","kind":"distribution","samples":[0.49,0.51,0.50],"variable":"score"}
```

### `curve`

```json
{
  "id": "learning-curve",
  "kind": "curve",
  "x_name": "training rows",
  "y_name": "score",
  "series": [
    {"name":"held-out","x":[100,200],"y":[0.72,0.78],"y_lower":[0.70,0.76],"y_upper":[0.74,0.80]}
  ]
}
```

`x` may be entirely numeric or categorical. `x` and `y` must have equal lengths. Optional bands must match `y` and satisfy `y_lower <= y <= y_upper`.

### `matrix`

```json
{"id":"confusion","kind":"matrix","row_labels":["A","B"],"col_labels":["A","B"],"values":[[10,2],[1,12]]}
```

The matrix must be rectangular. The compatibility renderer treats long `N × 1` matrices as diverging value bars.

### `predictions`

```json
{
  "id":"model-predictions",
  "kind":"predictions",
  "classes":["negative","positive"],
  "row_ids":["r1","r2"],
  "y_true":["negative","positive"],
  "y_pred":["negative","positive"],
  "y_score":[0.1,0.9]
}
```

All row arrays must align. In schema 2.2, `y_score` is interpreted as the score for `classes[1]`; future payloads should state this explicitly in `encoding.score_class`.

### `assignments`

```json
{"id":"split","kind":"assignments","row_ids":["r1","r2"],"labels":["train","test"]}
```

### `tree_structure`

```json
{
  "id":"tree",
  "kind":"tree_structure",
  "nodes":[{"id":"root","majority_class":"positive","samples_fraction":1,"class_fractions":{"positive":0.6}}],
  "edges":[]
}
```

The tree must have one root, valid edge references, no cycle, and one connected component.

## Payload v3 visual specification

Do not extend a 2.2 artifact with ad-hoc `view`, `encoding`, or `display` fields. Payload v3 now provides the explicit Figure→Panel→Layer visual contract, typed data catalog, registered recipes, and verified sidecars. Read [payload-v3-contract.md](payload-v3-contract.md) and migrate only unambiguous 2.2 artifacts. Ambiguous visual intent must remain a validation error.

## Validation rules

- IDs are unique and references resolve.
- Numeric arrays contain only finite JSON numbers.
- Parallel arrays have equal lengths.
- Matrices are rectangular.
- Curve bands are ordered.
- Prediction and assignment rows align.
- Trees are rooted, connected, and acyclic.
- Unknown artifact kinds fail the build.
- Unsupported schema majors require an explicit adapter rather than inference.
