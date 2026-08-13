# Registry v2 technical contract

Registry v2 separates the small human-facing `Projects` sheet from the hidden,
normalised index consumed by the dashboard build. This document is an
engineering contract; it is not the project-owner status report.

## Delivery boundary

Registry v2 is a develop-only data source. The compiler, Sheet adapter, strict
build consumer, Apps Script snapshot/file/asset endpoints and owner-only V2
Sheet use one explicit contract. The stable `branch-deploy + develop` build
requests `schema=2`; Production/main and PR Deploy Previews force `schema=1`
and therefore remain on the proven V1 Registry.

The V2 Sheet has no trigger or credentials of its own. Its ID is stored in the
existing Apps Script project's `AI4S_REGISTRY_V2_SPREADSHEET_ID` Script
Property. The existing single `syncDrive` trigger reconciles both registries
from one Drive collection pass. `AI4S_PREVIEW_REGISTRY_SCHEMA=2` switches only
Preview automation's desired revision to V2. The default for both properties
is safe V1 behaviour, and no token or Hook is stored in the V2 workbook.

V2 automatic discovery accepts only an English-named direct child folder of the
configured Drive root with one unambiguous direct-child HTML page. A new page
is appended to the native `ProjectsCatalogV2` table and the plain-grid
`_Registry` / `_Facets` indexes in one Sheets API batch. It starts as `Draft`,
`Preview only`, `Featured=false`, with a stable `demo-<folder-slug>` identity.
Loose root HTML, shortcuts, non-English folder names and ambiguous primary
pages are outside this creation boundary. Re-running with the same Drive
`file_id` is idempotent; a slug or identity collision is reported and never
replaces an existing source.

Initial HTML or provenance metadata is only a convenience seed. Taxonomy is
copied only when the complete field resolves exactly; unknown initial values
remain blank and make that Draft locally blocked. Later non-empty unknown human
values remain structural errors. A blocked Draft is excluded from the
build-facing manifest, so its creation does not change the Registry revision or
request a deploy. Missing files remain as tombstones and recover when the same
Drive file returns. A delete/re-upload with a new `file_id` is deliberately not
guessed as a replacement and requires explicit migration.

## Human sheet

`Projects` has exactly 15 visible English-labelled columns, in this order:

```text
Status, Readiness, Preview URL, Project Title, Card Summary,
Department, Subtopic, Task Type, Methods, Card Image, Image Alt Text,
Audience, Featured, Data Source, Public Permission
```

The corresponding stable machine keys are `status`, `readiness`,
`preview_url`, `title`, `card_summary`, `department`, `subtopic`, `task`,
`methods`, `card_image`, `image_alt`, `audience`, `featured`, `data_source`
and `public_permission`.

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

The adapter accepts either the canonical English display labels or the stable
English keys in the header row. Non-English headers are not compatibility
aliases. It emits write-back patches only for `readiness` and `preview_url`.
Every patch carries a `demo_id` cell guard; a writer must re-read that hidden
cell immediately before applying the patch and re-adapt if the row has moved.

All visible tabs, hidden tabs, headers, taxonomy labels, dropdown values and
derived Sheet messages are English-only. Chinese is used only in operator
conversation and is not part of the Sheet or Registry contract. The adapter
rejects CJK text in any visible or hidden v2 Sheet cell, and the standalone
compiler enforces the same boundary for non-Sheet callers.

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

In the first round each selected asset has one Drive source:

```text
source_type=drive + drive_file_id + source_file_name
```

`Projects.Card Image` is the direct-child relative file name, such as
`card.jpg`; it is not a Drive ID or URL. The server requires that the registered
HTML and image share the same allowed Registry parent. External URLs remain in
the reserved machine schema for a future policy, but are rejected by both the
compiler and Apps Script today.

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

## Server-side integration

The v2 build client never fetches a human-entered image URL directly. It asks
the authenticated Registry service for
`action=asset&id=<asset_id>&registry_revision=<revision>`. Apps Script maps the
ID through `_Assets`, verifies that the HTML and image are direct children of
the same allowed Registry folder, rejects shortcuts and unsupported MIME types,
enforces the 5 MiB limit, checks the image signature, and rechecks Drive
metadata before and after reading. The response is the exact small envelope
tested by `build.js`; Drive IDs and tokens never enter public output.

The Registry revision includes current Drive modification state for visible
HTML and card-image sources. Replacing `card.jpg` in place therefore changes
the revision, invalidates the previous revision, and is observed by the next
private develop build without changing Production.
