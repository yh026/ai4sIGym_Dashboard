# Drive category layout and upload operations

Use the existing [AISInstrumentationGym root](https://drive.google.com/drive/folders/1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH). This guide describes the category layout introduced by the October 2026 migration; migration completion is recorded separately in its verification reports.

## Where files belong

```text
AISInstrumentationGym/
  datasets/
    001-tbb/                    # Actual data; raw/ and processed/ when available
    ...
  demo_html/
    001-tbb/                    # Reused original project folder ID
      develop/<version-id>/     # insight.html, workflow.html, cover and web assets
      dataset_pages/<version>/  # dataset.html and its web dependencies
    ...
  skills/
    001-tbb/resources/          # Existing notebooks, scripts and skill downloads
    ...
    _shared/                   # Reusable complete skill packages
  archive/
    001-tbb/<YYYY-MM-DD>/       # Reused original archive and dated-folder IDs
    ...
    _admin/                    # Historical Registry and backend migration backups
  _admin/
    <existing Registry sheets>
    _backend_develop/           # Existing imports, snapshots and backend records
    <project index and migration records>
```

Dataset **HTML pages** belong in `demo_html/.../dataset_pages`; CSV, matrices, source images and other actual data belong in `datasets`. An empty dataset folder does not mean that the underlying dataset has been uploaded. Keep the project index explicit about missing data or skills. Historical files stay in their dated archives even when they are named `SKILL.md`.

Use the same fixed three-digit project number and English short name in all four content categories. There are 16 registered project folders, including historical projects; the legacy V2 source allowlist contains 15. These counts are not the homepage display order or the number of current demos. Assign new projects the next unused number; never renumber existing projects to match a reordered homepage.

## Updating a current demo

1. Open the numbered project through the project index in `_admin`. Preserve existing folder IDs, version IDs, demo IDs and logical routes.
2. For a correction within the current Draft version, update the existing Drive file in place so its ID remains stable. Keep any needed previous content in a dated archive before replacement.
3. For a new version, create a separate version folder and retain the previous version. Register the version and its page/resource file IDs in the Develop Registry. A new physical source folder also requires an explicit backend mount before it can be read.
4. Keep raw data, Dataset documentation and processing skills separate. Update the relevant Registry links when adding a new file ID; a matching filename alone does not register a source.
5. Validate and sync the Develop Registry, build the develop preview, and check the affected pages and downloads. Retain the previous release until review is complete.

Creating, moving or uploading a Drive file does **not** authorize a main release. Production uses its reviewed release package. Publishing main remains a separate explicit release decision; migration helpers never call a build Hook or production publisher.

## Backend mappings

Physical folder labels organize Drive. Stable logical paths identify the website's sources. Preserve file IDs by moving existing folders/files instead of replacing them with copies or shortcuts.

**Develop V3:** `AIS_PROJECT_MOUNTS_V1` retains its property name and uses schema `2`. Each mount identifies the file's **exact immediate parent folder**, its complete ancestor-ID chain through the AIS root, and its unchanged logical path. For example (placeholder IDs):

```json
{
  "schema": 2,
  "root_id": "AIS_ROOT_ID",
  "mounts": [{
    "id": "VERSION_FOLDER_ID",
    "ancestor_chain": [
      "DEVELOP_FOLDER_ID", "NUMBERED_PROJECT_FOLDER_ID",
      "DEMO_HTML_CATEGORY_ID", "AIS_ROOT_ID"
    ],
    "logical_path": "projects/example/example-draft-v1"
  }]
}
```

Dataset-page mounts retain `datasets/<dataset-id>/<version>`. Skill/download mounts retain `projects/<demo-id>/<version>/resources[/subfolder]`, even when their physical files are under `skills`. Every nested download folder needs its own mount. A parent mount does not grant recursive access; unregistered folders, changed ancestor IDs and ambiguous parents fail validation.

The migration's compact V3 mount property is **8,658 UTF-8 bytes**, close to the Script Properties **9 KB per-value limit**. Before adding mounts or versions, review the backend storage design and measure the serialized size. Do not blindly append another mount or bypass ancestry validation to save space. A larger mapping may need a reviewed, integrity-checked configuration file or another versioned storage design.

**Legacy V2:** `AI4S_CATEGORY_LAYOUT_V1` contains `root_id`, `demo_html_id`, `archive_id`, and an explicit `projects` list. Each entry records `project_id`, `legacy_folder_name`, `folder_name`, `archive_id`, and `archive_name`. The original logical folder name controls legacy primary-page selection and slug identity; the numbered physical name does not create a new project. Only the 15 approved legacy projects are enumerated. New projects belong in V3 and are not automatically added to this allowlist.

Keep `AI4S_DATED_ARCHIVES_V1` unchanged: it pins original project, archive, dated-folder and source-file IDs. V2 verifies both approved category ancestry and these existing archive bindings. Clearing the category property is a rollback step only after the original physical layout has been restored.

Existing Registry Sheet IDs, bound Apps Script projects, backend root ID, source file IDs and date-folder IDs are retained. Tokens, Hook URLs and callback secrets stay in their existing private settings; never put them in project documentation, a mapping file or the project index.

## Migration verification and rollback

Migration records include the before-inventory, per-operation move journal, source-code backups, mapping configurations and baseline/verification reports. Keep these under `_admin` or its dated archive. Record each move's file/folder ID, old/new parent IDs and old/new names; verify the actual result before proceeding.

The V2 helper sequence is `categoryBeginV2`, `categoryInstallV2`, physical migration, `categoryVerifyV2`, then `categoryResumeV2`. Begin pauses the existing sync and records its original automation settings. Verification checks unchanged editor fields/formulas, public manifest content, source identities and raw-file SHA-256 values. Archived native Google documents use an explicit identity/metadata contract, not a claim of byte-identical exported content. Resume restores only previously existing hourly sync and a safe non-production automatic target; a previous production target stays off.

For V3, export the baseline with `categoryExportV3`, pause its existing automation, then install the reviewed schema-2 configuration with `categoryInstallV3` after the physical moves. Run `categoryVerifyV3` and inspect its report before restoring previously recorded develop automation. These helpers preserve the current snapshot and freshly verify each unique source; they do not publish.

To roll back:

1. Pause both backends' existing sync/preview automation; keep automatic production publishing off.
2. Reverse completed moves and renames from the journal, preserving IDs and any later human edits. Do not delete folders or replace files with newly uploaded copies.
3. Restore the corresponding mapping settings and backed-up deployed code together. Do not downgrade the code while files remain in a layout that it cannot resolve. Restore or clear the V2 category property only when its required physical layout is back in place.
4. Recheck source identities, raw hashes/native metadata, Registry human fields, logical routes, page/download access and manifest/snapshot content. Restore only the automation that previously existed after these checks pass.

Use the deployed source backups for rollback: repository code can contain unrelated fixes that were not deployed. Do not overwrite a Registry from an old Sheet backup without reconciling edits made since that backup.
