# Project publishing controls

This directory implements manual Preview and Production publishing from the Registry. Installation status must be verified separately; the instructions below apply after the manual release runtime and build hooks are configured.

## Daily use

1. Select each project's **Include in preview** and **Include in production** checkboxes in the Control panel. These stage the next release; they do not change a website.
2. Choose **AIS Control → Update preview**. Wait for **Preview ready**, using **Refresh status** to check progress, then inspect the preview website.
3. Open **AIS Control → Open actions** and click **Review changes**. This builds a separate release preview. Use **Refresh status** when preparation finishes.
4. Review the **Add**, **Update**, and **Remove** list and open the release preview. Only click **Publish to production** when that exact release is approved.
5. Use **Refresh status** to check completion. The actual published state changes only after a successful deployment.

To take a project offline, clear its checkbox for the relevant environment and follow the corresponding update or publication flow. Excluding a project does not delete its Drive files, datasets, notebooks, or skills. A project retained in Production but excluded from Preview keeps its current Production version.

Opening the sheet or sidebar, editing checkboxes, refreshing status, and hourly status checks do not publish. Routine timestamps, synchronization information, and automation details are collapsed under **Details**. Displayed times use Singapore time.

## A disabled Publish button

- **Preparing:** wait for the release preview, then refresh status.
- **No changes:** there is nothing to publish.
- **Expired or changed:** review again after changing selections or updating either website.
- **Failed or uncertain:** read the error and refresh status before another attempt. An uncertain submission is never retried automatically.
- **Not connected:** the manual publishing runtime has not been fully configured.

## Implementation and checks

`sidebar.html` is the operator interface. `PublishingControlsModel.gs` and `RegistryPublishing.gs` provide project selection and Preview behavior. `manual-release/` adds the signed release store, isolated review build, explicit Production confirmation, and immutable artifact pipeline. See its [README](manual-release/README.md) for installation and build details.

Use the versioned [runtime installer](runtime-install/README.md) to generate the three installable Apps Script files. Do not copy an adapter source file directly into the bound project.

```sh
node --test test/publishing-controls-model.test.js test/publishing-controls-service.test.js test/publishing-controls-sidebar.test.js test/manual-release-ui.test.js
node --test google-apps-script/publishing-controls/production-release/*.test.cjs google-apps-script/publishing-controls/manual-release/*.test.cjs
node --test google-apps-script/publishing-controls/runtime-install/runtime-install.test.cjs
```
