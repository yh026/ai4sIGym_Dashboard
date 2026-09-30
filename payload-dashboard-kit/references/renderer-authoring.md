# Renderer authoring

Payload v3 is a closed declarative grammar. Extend it only when existing Figure→Panel→Layer primitives or a registered recipe cannot express a result without semantic distortion. Never add an artifact-id or array-shape heuristic to the v3 path.

## Required change set

1. Define or revise the author-facing contract in `payload-v3.schema.json` and `payload-v3-contract.md`.
2. Add the same capability to semantic validation and normalization in `scripts/lib/payload-v3.mjs`.
3. Add recipe expansion, when needed, to the closed registry in `scripts/lib/v3-recipes.mjs`.
4. Render the normalized primitive in `assets/dashboard-runtime-v3.js` without dependencies or network access.
5. Return accessible inline SVG, Canvas with a semantic fallback, or semantic HTML.
6. Escape payload text with `textContent`; never use payload-derived `innerHTML`.
7. Use stable ordering, colors, ticks, transforms, and sampling. Do not use randomness or current time.
8. Add a minimal valid fixture and targeted invalid cases for unknown fields, references, channels, and executable properties.
9. Test the manifest receipt, offline output, malicious `</script>` text, sidecar integrity, and deterministic output hashes.
10. Browser-test desktop and narrow viewports, Fold/Unfold, keyboard activation, `data-dashboard-status`, render errors, Canvas controls, and console errors.

## Visual rules

- Use the theme tokens from `dashboard.css`.
- Keep scientific semantics in data and encoding; keep paint details in the renderer/theme.
- Keep axes, labels, and units visible.
- Keep semantic class colors consistent across panels.
- Put quantities with incompatible units on separate axes or subplots.
- Do not smooth small samples into a density estimate.
- Do not connect categorical model names as if they were a continuous variable.
- Preserve zero values explicitly.
- Add an artifact note when compatibility logic, aggregation, top-k display, or sampling changes what is visible.

## Recipes versus primitives

Prefer explicit generic panels for ordinary charts. A recipe is justified for a stable multi-panel scientific diagnostic or a controlled interaction, such as PCA diagnostics, embedding sweeps, model validation, clustering comparison, or the vector-quantisation explorer. A recipe must expand deterministically to validated panels and layers; it cannot inspect arbitrary field names to choose a view.

Sidecars are build inputs, not browser resources. The compiler verifies and inlines only supported JSON/JSONL content. Runtime code must never call `fetch` or resolve a payload path.

## Failure rule

Unknown or ambiguous recipes, marks, coordinates, fields, transforms, annotations, and interactions fail closed. Never silently substitute a visually similar but semantically different chart or discard a panel/layer.
