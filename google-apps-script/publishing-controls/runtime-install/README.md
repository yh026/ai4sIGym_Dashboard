# Apps Script runtime bundle

This is the reproducible source for the manual publishing installation. It replaces the earlier assembly script that depended on untracked `.local` exports. Building this bundle performs no network request, edits no spreadsheet, and publishes no website.

## Build

Run from the repository root:

```sh
node google-apps-script/publishing-controls/runtime-install/bundle.cjs --out .local/manual-runtime
node --test google-apps-script/publishing-controls/runtime-install/runtime-install.test.cjs
node --test google-apps-script/publishing-controls/runtime-install/control-panel-actions.test.cjs
```

The output contains exactly three Apps Script files and `runtime-manifest.json`. The manifest records SHA256 hashes of every input and generated file; it contains no absolute local paths or credentials. Assembly stops if an expected adapter boundary has changed.

| Output | Contents |
| --- | --- |
| `Code.gs` | Existing V3 compiler, Drive/Sheet adapter, signed Preview API, manual release API routing, and status-only hourly handler |
| `RegistryUi.gs` | Worksheet buttons, daily menu, legacy sidebar, project selections, Preview adapter, and explicit manual-release delegates |
| `ManualRelease.gs` | Signed artifact store and develop publication confirmation service |

The base files preserve the established V3 runtime and its non-secret installation identifiers. They contain no registry rows, project data, hook URLs, access tokens, callback secret values, or account emails. Credentials and active release state remain in Apps Script Properties and Drive. The base is specific to the existing AIS Registry; it is not a generic new-workbook installer.

## Install or update

1. Build and run the relevant tests before changing the bound Apps Script project.
2. Save a backup of its current source. Replace its **Code**, **RegistryUi**, and **ManualRelease** file contents with the generated files as one coordinated update. Keep the current project manifest, properties, and deployments.
3. Save the source. Update the existing Web App deployment to the saved version when changing the API, preserving its deployment URL and access settings. Confirm the Apps Script timezone is `Asia/Singapore`.
4. Run `registryUiInstallActionButtons` once, or use **AIS Control → Maintenance → Restore action buttons**. Reload the Registry. The three buttons appear in row 4 of **Control panel**; the installer refuses to cover nonempty cells in A4:L4, preserves project rows and selections, and only replaces images bearing its own markers. It does not build or publish anything.
5. Test **Refresh status**, then open **Publish to production** and cancel its native confirmation. Check the three menu equivalents. An unconfigured release connection must remain disabled. For changes to the build or publication protocol, additionally verify a new private develop Preview before enabling operator use. Installing source does not constitute a successful end-to-end deployment test, and does not authorize a Production publication.

A UI-only update may replace only `RegistryUi.gs` when the other two generated file hashes are unchanged. Bound worksheet actions use saved source, so this does not require a new Web App deployment version.

The PNG artwork is embedded from `control-panel-buttons/artwork.json`; no external image host is used. Regenerate it with `python3 google-apps-script/publishing-controls/control-panel-buttons/render.py --font <font-path>` using Pillow. The buttons are anchored at A4, E4 and I4 without inserting rows. Their scripts execute in the desktop web version of Sheets, not the mobile apps.

The build hooks, signed callbacks, release-store folder, initial production capsule, and Netlify build commands are separate installation requirements described in [manual-release/README.md](../manual-release/README.md). This bundler does not configure them.

Do not install `RegistryPublishing.gs` alone: it retains the older adapter implementation for tests and composition. The bundler deliberately redirects its public Review and Confirm functions to `ManualReleaseUi.gs`. Likewise, the older `google-apps-script/Code.gs` at the parent directory describes the former V2 installation and is not the current V3 runtime.

For daily Preview / Confirm / Publish use, see [Project publishing controls](../README.md).
