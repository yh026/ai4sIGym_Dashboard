# Registry v2 technical contract

Registry v2 separates the small human-facing `Projects` sheet from the hidden,
normalised index consumed by the dashboard build. This document is an
engineering contract; it is not the project-owner status report.

## Delivery boundary

This first round is a foundation and migration sandbox, not a live Registry
cutover. The compiler, Sheet adapter, strict build consumer, image
materialisation client and private owner-only shadow Sheet are implemented and
tested locally. The current production Registry Web App still serves schema v1.

Before schema v2 can become an automated data source, a later commissioning
stage must add and deploy the Apps Script v2 snapshot adapter plus the private
`action=asset` response, bind the live Sheet safely, and pass a real private
develop Preview canary. Until that stage, the shadow Sheet has no trigger,
Build Hook, Registry token or Netlify connection and cannot affect Production.

## Human sheet

`Projects` has exactly 15 visible columns, in this order:

```text
status, readiness, preview_url, title, card_summary,
department, subtopic, task, methods, card_image, image_alt,
audience, featured, data_source, public_permission
```

- Editors own `status`, `title`, `card_summary`, taxonomy selections, image,
  image alt text, audience, featured and `public_permission`.
- The compiler owns `readiness` and `preview_url`.
- Provenance import owns `data_source`. It may never grant publication
  permission.
- `status` is `Live`, `Draft` or `Archived`.
- `public_permission` is `Public`, `Preview only` or `Private`. Moving from
  `Preview only`/`Private` to `Public` is always a human decision.
- `featured` is a boolean.
- `question` is not a first-round card field and is not present in Registry v2.

There is one additional hidden, non-editable sixteenth column named `demo_id`.
It moves with its project when a user sorts or moves rows. The Sheet adapter
joins this hidden ID to `_Registry`, then supplies the compiler with the row's
current position. `_Registry.row_number` may be stale during that read and is
never used as the join key. Title and physical row position are not identities.

The adapter accepts either Chinese display labels (`状态`, `发布检查`, `项目标题`,
etc.) or the stable English keys in the header row. It emits write-back patches
only for `readiness` and `preview_url`. Every patch carries a `demo_id` cell
guard; a writer must re-read that hidden cell immediately before applying the
patch and re-adapt if the row has moved.

## Hidden sheets

Header constants and field ownership are exported by `lib/registry-v2.js`:

- `_Registry`: stable identity, normalised project record and Drive health.
- `_Taxonomy`: stable department, subtopic, task and method IDs.
- `_Facets`: one row per project/task or project/method relation.
- `_Assets`: source locator and safe published path for card images.
- `_Audit`: append-only operational events.
- `_Config`: non-secret configuration plus site metadata. `site_title` and
  `site_tagline` live here, not in a synthetic `site` row in `Projects`.
- `_Schema`: field type, owner and visibility dictionary.

Tokens, deploy hooks and credentials do not belong in any Sheet tab.

`lib/registry-v2-sheet-adapter.js` is the pure Node boundary for converting the
physical `_Registry`, `_Taxonomy`, `_Facets` and `_Assets` rows into compiler
input and converting normalised records back to exact Sheet rows. It performs
no Google API, filesystem or network operations. Every canonical machine
header is required; missing or additional machine columns fail closed (column
order may change because parsing is by header name). Every `_Taxonomy.active`
cell must also contain an explicit boolean. The adapter and the standalone
compiler both enforce this, so missing, blank or string values can never be
silently interpreted as active.

## Compiler input and readiness

```js
compileRegistryV2({
  projects,          // 15 visible values plus transient current row metadata
  sourceProjections, // joined by hidden demo_id; current row attached by adapter
  taxonomy,          // departments, subtopics, tasks and methods
  facets,            // optional materialised task/method index
  assets,            // normalised card image source and public path
});
```

All IDs and slugs are lowercase kebab-case. A supplied `_Facets` index must
match the human task/method selections; stale indexes fail validation rather
than silently overriding an editor.

First-round project readiness requires:

- title, card summary, department and subtopic;
- at least one task and at least one method;
- audience exactly one of `General`, `Intro`, `Intermediate`, `Advanced`;
- an explicit boolean `featured` value;
- a healthy Drive HTML source and the appropriate human permission.

These content requirements apply to Drafts too. A newly discovered HTML file
may enter as a blocked Draft, but it enters private Preview only after the
simple human fields are complete.

Each asset has exactly one source:

```text
drive_file_id XOR external_url
```

Card image output paths are limited to:

```text
assets/cards/*.(avif|gif|jpg|jpeg|png|webp)
```

A selected image requires human-authored alt text, `sync_status=ok`, and a
supported `image/*` MIME type that matches the extension of its safe public
path. The build-facing card asset contains only `asset_id`, `public_path` and
`alt_text`.

## Build-facing output

`toRegistryV2(compiled)` emits only this allowlisted contract:

```js
{
  schema_version: 2,
  taxonomy: {
    departments: [{ id, label, short_label, description, display_order,
      active, theme_key, icon_key }],
    subtopics: [{ id, department_id, label, display_order, active }],
    tasks: [{ id, label, active }],
    methods: [{ id, label, active }]
  },
  demos: [{
    demo_id, entry_type, slug, status, featured, sort_order, title,
    card_summary, department_id, subtopic_id, task_ids, method_ids,
    audience, data_source_label, public_page_permission,
    card_asset: { asset_id, public_path, alt_text } | null,
    file_id, file_check, date_added
  }]
}
```

The internal compile result retains all human rows and their diagnostics. It
does not expose a second `manifest` object; `toRegistryV2(compiled)` is the only
publication/export boundary. Build-facing output includes only healthy, ready
`Live` and `Draft` rows:

- a blocked `Live` row is a hard QA error and prevents export;
- a blocked `Draft` is retained for the human readiness report but omitted from
  Preview until fixed;
- `Archived`, `missing`, `unreadable` and `empty` rows are omitted;
- `Preview only` permits a healthy Draft in Preview;
- only `Public` permits a project to be Live.

Row-local content problems on a Draft mark only that Draft blocked and omit it
from Preview; they do not invalidate unrelated healthy rows. Structural errors
such as duplicate identities/slugs, a missing `_Registry` projection, invalid
taxonomy relationships, stale `_Facets`, or malformed asset indexes fail the
whole compile closed. A blocked Live row is also a whole-compile failure.

## Verification fixtures

`fixtures/registry-v2-current-21.json` models the migration source shape:

- 21 rows total;
- 15 Live, including one legacy `site` record and 14 projects;
- 4 Draft;
- 2 Archived;
- one multi-method project and one card asset.

The fixture intentionally includes one complete Preview-ready Draft, three
blocked Drafts and missing Archived rows. The Sheet-adapter test removes the
legacy `site` record to model the actual 20-project shadow Sheet, reads site
title/tagline from `_Config`, reverses project row order, and proves that all
source state remains attached through hidden `demo_id` rather than row number.

## Next server-side integration

The v2 build client intentionally does not fetch a human-entered image URL
directly. It asks the authenticated Registry service for
`action=asset&id=<asset_id>&registry_revision=<revision>` and accepts only a
small, revision-bound image envelope. The later Apps Script adapter must map
that asset ID through `_Assets`, re-check the source boundary, enforce MIME and
size limits, and return the exact tested response contract. External HTTPS
sources require an explicit redirect/host/size policy at that server boundary;
they are not live-enabled merely because the compiler can model them.
