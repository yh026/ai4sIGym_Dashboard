# Registry v2 technical contract

Registry v2 separates the small human-facing `Projects` sheet from the hidden,
normalised index consumed by the dashboard build. This document is an
engineering contract; it is not the project-owner status report.

## Delivery boundary

Registry v2 is the sole live Registry and operator control plane. The compiler,
Sheet adapter, Apps Script sync/snapshot/file/asset endpoints and every Netlify
context use one schema-2 contract. Audience remains separate: Production gets
healthy `Live + Public` projects, while stable `branch-deploy + develop` may
also get healthy Draft projects. `schema=1` is rejected and cannot reopen the
archived V1 data plane.

The Apps Script project is container-bound to V2. `setup()` validates the
existing workbook, records its ID in `AI4S_REGISTRY_V2_SPREADSHEET_ID`, installs
the single owner-controlled hourly `syncDrive` trigger and adds the V2 menu. It
never creates or migrates legacy `Demos`, `Config` or `Log` tabs. Trigger and Web
App contexts reopen V2 by its stable ID.

Non-secret site metadata stays in V2 `_Config`. Operational values and every
credential are Script Properties only:

```text
AI4S_DRIVE_FOLDER_URL
AI4S_REGISTRY_ACCESS_TOKEN
AI4S_NETLIFY_PRODUCTION_BUILD_HOOK
AI4S_NETLIFY_PREVIEW_BUILD_HOOK
AI4S_PRODUCTION_BRANCH
AI4S_PREVIEW_BRANCH
AI4S_PREVIEW_URL
AI4S_PREVIEW_URL_BRANCH
AI4S_AUTO_PUBLISH_TARGET
AI4S_NETLIFY_SITE_ID
AI4S_PREVIEW_CALLBACK_SECRET
```

There is no V1 Config fallback. V1 can be moved, protected or archived without
affecting V2 sync, menus, publishing or the Web App. Operational events append
to V2 `_Audit`; tokens and Hooks never enter a workbook cell or public artifact.

V2 sync enumerates the configured Drive root once per run and reconciles
directly against `_Registry.file_id`; it never reads or writes a V1 row.
Automatic discovery accepts only an English-named direct child folder of the
configured Drive root with one unambiguous direct-child HTML page. A new page
is appended to the native `ProjectsCatalogV2` table and the plain-grid
`_Registry` / `_Facets` indexes. It starts as `Draft`, `Preview only`,
`Featured=false`, with a stable `demo-<folder-slug>` identity. Loose root HTML,
shortcuts, non-English folder names and ambiguous primary pages are outside
this creation boundary. Re-running with the same Drive `file_id` is idempotent;
a slug or identity collision is reported and never replaces an existing
source.

Initial HTML or provenance metadata is only a convenience seed. Taxonomy is
copied only when the complete field resolves exactly; unknown initial values
remain blank and make that Draft locally blocked. Later non-empty unknown human
values remain structural errors. A blocked Draft is excluded from the
build-facing manifest, so its creation does not change the Registry revision or
request a deploy. Missing files remain as tombstones and recover when the same
Drive file returns. A delete/re-upload with a new `file_id` is deliberately not
guessed as a replacement and requires explicit migration.

Every run revalidates the complete Drive metadata and direct-parent contract
before accepting its result. The fingerprint input binds the Spreadsheet ID,
configured root, folder edge, selected page, complete relevant HTML inventory,
`PROVENANCE.md`, supported image inventory, selection identities and collection
notes. Each Drive entry contributes its ID, name, MIME type, direct parent,
modification time and size. A cache hit therefore cannot bypass root/folder
containment, MIME checks, inventory changes or primary-page selection.

Blob ingestion is a separate, conservative optimisation. An unchanged,
healthy existing source may reuse a Script Properties fingerprint-hint schema
v1 entry only when both its complete input SHA-256 and its current `_Registry`
output SHA-256 match. The entry is namespaced by Spreadsheet ID and Drive root,
keyed per page identity, and its output binds `file_check` plus `date_added`.
Its value contains only the schema number and input/output hashes: no HTML,
provenance content, human fields, token, Hook or other secret is cached. Cold,
changed, corrupt/unhealthy and recovered sources fall back to downloading and
parsing their HTML and provenance; a source that is actually absent remains a
missing tombstone without an impossible blob read. A missing, malformed,
unavailable or quota-blocked property cache also degrades to this safe full-read
path. The cache affects performance only, never accepted Registry state.

Human-owned `Projects` fields are never overwritten. After Drive contract and
native-table metadata validation, a final full workbook equality check is the
linearisation point. If the guarded target exactly equals the initial workbook,
the no-op path skips the Sheets batch, `SpreadsheetApp.flush()`, reopen and
post-read. If any Sheet state must change, sync retains the guarded atomic
Sheets batch, flushes, reopens V2 by its stable ID and verifies the exact six-tab
result. Fingerprint hints are committed only after the no-op linearisation point
or that exact post-write verification; property-write failure cannot invalidate
the verified workbook.

After a successful sync, `AI4S_AUTO_PUBLISH_TARGET=off` may reuse the exact
post-verified Preview snapshot only to reconcile desired revision and callback
receipt state; it cannot send a Build Hook request. An explicit Preview build or
automatic `preview` mode always compiles the live V2 workbook. Immediately
before publish reconciliation, operational controls are reread from current
Script Properties; only a non-secret Sheet configuration base crosses the sync
boundary.

Drive-scan skip notices are sanitised before packing, using the same
English-only transform as the final `_Audit` append. Each packed detail stays
under the 1,000-character Audit cap. The normal three-notice case is one append;
an oversized notice is split into labelled fragments and a large notice set is
split into labelled batches without losing any sanitised reason. Collection
flushes already-observed notices from a `finally` block, so a later fail-closed
Drive scan error cannot erase earlier skip evidence.

The current classification implementation baseline is
`develop@a6611bcd4db31c39805a436a96d4eb9b259de204`; the
exact `Code.gs` SHA-256 is
`0dafd921e0ac4de430ec3b1902ddefecb1a3d1918159d0256c739def34e84a57`, and the
full suite is 345/345. The existing formal Apps Script deployment ID and URL
serve the same baseline as Version 15, with deployment topology still exactly
two. The Version 14 and Version 15 rollouts executed no functions or Netlify
Hook, and all related Git changes used `[skip netlify]`. Published Production
remains unchanged.

The Version 12 warm field run was Audit-visible from 17:41:10 to 17:41:37:
27 seconds, 16/16 fingerprint reuse, zero source parses and an already-current
Sheet. The prior no-change samples were 104/71/56 seconds (71-second median), so
the shipped path saves 44 seconds or 61.97%, is 2.63 times as fast, and satisfies
both the `≤35 seconds` and `≥50%` acceptance targets. That Version 12 field-run
readback was Projects 16, all `Live + Publication ready`, with `_Registry=16`,
`_Facets=50` and `_Assets=16`; it remains historical performance evidence.
Current Published Production is the later `6a7ee842b481720008e4cf70` artifact:
schema 2 / taxonomy 4 with 16 demos including Raman. It predates editable
facets, so the public site does not yet expose taxonomy 5 or these new filters.

## Human sheet

`Projects` has exactly 17 visible English-labelled columns, in this order:

```text
Status, Readiness, Preview URL, Project Title, Card Summary,
Department, Subtopic, Task Type, Methods, Data Type, Instrument Type,
Card Image, Image Alt Text, Audience, Featured, Data Source, Public Permission
```

The corresponding stable machine keys are `status`, `readiness`,
`preview_url`, `title`, `card_summary`, `department`, `subtopic`, `task`,
`methods`, `data_types`, `instrument_types`, `card_image`, `image_alt`,
`audience`, `featured`, `data_source` and `public_permission`.

- Editors own `status`, `title`, `card_summary`, taxonomy and option selections,
  image, image alt text, audience, featured and `public_permission`.
- The compiler owns `readiness` and `preview_url`.
- Provenance import owns `data_source`. It may never grant publication
  permission.
- `status` is `Live`, `Draft` or `Archived`.
- `public_permission` is `Public`, `Preview only` or `Private`. Moving from
  `Preview only`/`Private` to `Public` is always a human decision.
- `featured` is a boolean.
- `question` is not a first-round card field and is not present in Registry v2.

There is one additional hidden, non-editable eighteenth column named `demo_id`.
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

### Editable option vocabulary

The visible `OptionsCatalogV2` native table is the only human control plane for
the two flexible facet groups. It has exactly seven English headers:

```text
Category, Option ID, Option Label, Aliases, Display Order, Active, Description
```

`Category` is exactly `data_type` or `instrument_type`. `Option ID` is a stable
lowercase kebab-case identity; it must be unique within its category and must
not be changed merely to rename a label. `Option Label` is required and cannot
contain `,`, `;`, `|`, carriage returns or line feeds because those characters
are list delimiters. `Aliases` is input-only and may contain multiple values
separated by those delimiters. `Display Order` must be a finite number and
`Active` must be an explicit boolean checkbox value. `Description` is optional.

`Projects.Data Type` and `Projects.Instrument Type` are optional multi-value
cells. The normal human representation is a comma-separated label list such as
`1D, 2D`; the compiler also accepts a stable ID or one unambiguous alias. It
normalises those values into `_Registry.data_type_ids` /
`instrument_type_ids` and one `_Facets` row per selected `data_type` or
`instrument_type`. Repeated selections that resolve to the same stable ID are
de-duplicated. Unknown values, ambiguous alias collisions and inactive assigned
terms block the affected row; a blocked Live row fails the whole build.
Deactivation therefore requires removing or replacing all current assignments
first. A safe label rename retains the ID and adds the old label to `Aliases`
before changing `Option Label`.

The hidden `_OptionLists` sheet contains dynamic ranges used only for dropdown
suggestions. It is not compiler input and is never the semantic authority. A
dropdown or native multi-select chip may help an editor enter values, but the
comma-separated cell content and the strict compiler rules above remain the
portable contract.

For rollout compatibility, an old V2 workbook with no `Options` sheet may omit
all four new human/machine columns and is interpreted as having no such facets.
Once `Options` exists, both human columns and both `_Registry` ID columns are
mandatory; deleting any one of them fails closed. A completely unused physical
Options row whose only materialised value is `Active=false` is treated as a
Google Sheets checkbox placeholder. Any partly populated row, or an otherwise
empty row with `Active=true`, remains invalid.

## Other sheets

Header constants and field ownership are exported by `lib/registry-v2.js`:

- `_Registry`: stable identity, normalised project record and Drive health.
- `_Taxonomy`: stable department, subtopic, task and method IDs.
- `_Facets`: one row per project/task, project/method, project/data-type or
  project/instrument-type relation.
- `_Assets`: source locator and safe published path for card images.
- `_Audit`: append-only operational events.
- `_Config`: non-secret configuration plus site metadata. `site_title` and
  `site_tagline` live here, not in a synthetic `site` row in `Projects`.
- `_Schema`: field type, owner and visibility dictionary.

Tokens, deploy hooks and credentials do not belong in any Sheet tab.

`lib/registry-v2-sheet-adapter.js` is the pure Node boundary for converting the
physical `Projects`, `Options`, `_Registry`, `_Taxonomy`, `_Facets` and
`_Assets` rows into compiler input and converting normalised records back to
exact Sheet rows. It performs no Google API, filesystem or network operations.
Every canonical machine header is required after the Options rollout; missing
or additional machine columns fail closed (column order may change because
parsing is by header name). Every `_Taxonomy.active` and `Options.Active` cell
must contain an explicit boolean. The adapter and standalone compiler both
enforce this, so missing, blank or string values can never be silently
interpreted as active.

## Compiler input and readiness

```js
compileRegistryV2({
  projects,          // 17 visible values plus transient current row metadata
  sourceProjections, // joined by hidden demo_id; current row attached by adapter
  taxonomy,          // departments, subtopics, tasks and methods
  options,           // editable data_types and instrument_types definitions
  facets,            // optional materialised task/method/data/instrument index
  assets,            // normalised card image source and public path
});
```

All IDs and slugs are lowercase kebab-case. A supplied `_Facets` index must
match all human task/method/data-type/instrument-type selections; stale indexes
fail validation rather than silently overriding an editor.

First-round project readiness requires:

- title, card summary, department and subtopic;
- at least one task and at least one method;
- audience exactly one of `General`, `Intro`, `Intermediate`, `Advanced`;
- an explicit boolean `featured` value;
- a healthy Drive HTML source and the appropriate human permission.

Data Type and Instrument Type are optional readiness fields. Blank values do
not block a project. Every nonblank selection must, however, resolve uniquely
to a currently active `Options` row.

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

Drive sync resolves a non-empty selection against the images collected from
that exact project folder. It must match one supported, non-shortcut file
exactly. The same guarded Sheets batch updates `_Registry.card_asset_id` and the
single `_Assets` row with stable `asset-<slug>-card` identity. Replacing the
selected file under the same name updates its Drive ID and modification time;
clearing `Card Image` removes both machine links. A missing project page clears
the stale asset link but preserves the human filename so it can rebind when the
same page returns. Invalid paths, URLs, unsupported types and ambiguous names
stop the sync before any V2 write.

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
    methods: [{ id, label, active }],
    data_types: [{ id, label, description, display_order, active }],
    instrument_types: [{ id, label, description, display_order, active }]
  },
  demos: [{
    demo_id, entry_type, slug, status, featured, sort_order, title,
    card_summary, department_id, subtopic_id, task_ids, method_ids,
    data_type_ids, instrument_type_ids,
    audience, data_source_label, public_page_permission,
    card_asset: { asset_id, public_path, alt_text } | null,
    file_id, file_check, date_added
  }]
}
```

Aliases never cross this public boundary. The generated website manifest uses
`taxonomy_version: 5`; it exposes the allowlisted option terms and stable demo
ID arrays, then renders only active option chips used by at least one visible
project. Card attributes store pipe-separated IDs. Selecting a chip tests
membership in that array, while different filter groups are combined with AND.
Thus a project assigned `1D, 2D` matches either Data Type chip, and selecting
Data Type `2D` plus Instrument Type `Raman` requires both conditions. Option
labels are also included in free-text card search.

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
