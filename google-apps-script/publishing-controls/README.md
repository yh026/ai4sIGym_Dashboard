# Project publishing controls

Use `develop` to inspect all proposed changes. Publish the checked content to Production only after confirming the selected changes. There is no additional release-preview website.

1. Select **Include in preview** and **Include in production** for each project.
2. Choose **AIS Control → Update preview**. Wait for **Preview ready**, then inspect the private develop website.
3. Choose **Publish to production** in the menu or sidebar. A confirmation lists additions, updates and removals immediately; it does not start a build.
4. Confirm publication to start the main production build, or close/cancel to leave Production unchanged.
5. Use **Refresh status** to check completion. Do not retry an uncertain request until its status is reconciled.

The native menu confirmation remains available if Sheets cannot load the HTML sidebar. Preparing, viewing or cancelling a confirmation never publishes. Changed selection, catalog or deployment identity invalidates the confirmation.

## Project selection

| Include in production | Include in preview | Next Production version |
| --- | --- | --- |
| On | On | Exact checked develop project content |
| On | Off | Retain the existing Production project |
| Off | Either | Omit the project from Production |

Source files are preserved. Existing homepage introduction and TBB resource-publication rules remain in effect. A project without an existing Production version must be included in a verified Preview before it can be published.

## Implementation

`sidebar.html` and the native dialog provide confirmation. `PublishingControlsModel.gs` and `RegistryPublishing.gs` manage project selection and Preview. `manual-release/` stores immutable artifacts and signed explicit publication requests. Its [README](manual-release/README.md) describes the two-environment protocol.

Build the reproducible [Apps Script runtime](runtime-install/README.md) before installing changes. The previous branch-based publication records are historical; retain them for audit and recovery.
