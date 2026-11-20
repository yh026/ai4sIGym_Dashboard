# Instrumentation Gym management desk

Open the protected management desk with your authorized Netlify account. **Demo overview** shows the totals for published demos, available Previews and, for the owner, demos marked done. On a small screen, open **Menu** to choose a task. Each row links to the production Insight, Workflow, and Dataset pages. When a preview has been submitted, a second set of links opens that version. Each page opens in its own tab.

The owner can tick **Mark done** as a personal record of reviewing and publishing a demo. The entire row turns green when the check is saved. The default **Unchecked first** order keeps the remaining demos at the top. You can also sort by latest preview or name. A mark belongs to the current version of that demo. A new preview starts unchecked.

Use **Add a new demo** to enter a name, choose a category and upload a ZIP or folder. The name suggests an editable demo address. Include `index.html` (or `insight.html`), `workflow.html`, `dataset.html` and the files they reference. Use the `demo.json` page mapping below for custom filenames. The owner can create a demo once at an available address. When all three pages are ready on a protected deployment, the overview opens with the three shareable Preview links. The Production column reads **Not published yet**.

Use **Upload a Preview** to update an existing demo, import files, review the changes, and confirm the upload. The new submission becomes that demo's current Preview. A direct page link shared earlier still opens the version it was copied from for as long as Netlify retains the deployment. Reviewers need access to protected Netlify previews.

To add a colleague, open **Member access**. Use the Netlify project invitation link if they need permission to view protected previews. Enter their email, choose individual demos or **Select all**, and click **Save permissions**. **Clear selection** resets the form. Saving an empty selection revokes that member's upload access.

## Production releases

The owner's sidebar has a separate page for each task.

| Sidebar page | What you can do |
| --- | --- |
| Publish Previews to Production | Select one or more reviewed demos for one public release. The three links on each row open the selected version. Select a demo and expand **Version options** to use an earlier fixed URL. Selections are retained when you search. |
| Publish files to Production | Choose a demo and supply HTML, a ZIP or a folder. Review the changes, then publish the package and synchronize its private Preview. Both results use the same files. |
| Restore one demo | Choose a demo and a retained version. The impact summary shows which files will change. Other demos keep their current versions. |
| Restore the whole site | Choose an earlier Production version and review the affected demos. |
| Release receipts | Expand an operation to see its source and result pages, file changes and uploads. Completed actions open their receipt here. Previously shared receipt links still resolve. |

The owner confirms the public destination, `aisigym.netlify.app`, before publishing or restoring. The worker verifies the selected files in a protected deployment, reuses their hashes in the public deployment, then checks which deploy Netlify is serving. A pending operation holds the release slot. Open **Release receipts** to check it after a disconnection. A new review draft keeps its fixed Preview. A tracking Preview follows a direct release or rollback. The public TBB download policy and homepage introduction carry forward.

The one-time `connect-production <active-deployment-id>` handoff reads the published deployment and its file inventory and records that baseline in the desk's private Netlify Blobs store. The handoff creates zero deployments on the public site. Netlify's **Stopped builds** setting retires the old Google and Git build triggers. Manual deploys remain available. Earlier private rehearsals have their own receipt archive and cannot become Production history.

## Packages

A folder or ZIP can contain a full demo or an overlay. Include `demo.json` to map files to existing page roles. These roles retain their registered live routes, including Dataset pages under `/datasets/`. Files omitted from an overlay are inherited. Use an explicit `remove` list for deletions. A single HTML file can update Insight, and the standard `workflow.html` and `dataset.html` filenames update those roles.

```json
{
  "schema": 1,
  "slug": "butterfly-wing-scale",
  "pages": { "insight": "index.html", "workflow": "workflow.html", "dataset": "dataset.html" }
}
```

New packages should put media, images and scientific data under `resources/media/`, `resources/images/` and `resources/data/`. Asset-only overlays can use an empty `pages` object. Browser and CLI share path, digest, dependency and change calculations. This importer currently accepts files through 256 MiB and an aggregate through 512 MiB per input package. These are limits for a single submission. Previously deployed content is represented by its digest.

## Operation

Use Node 24. Install dependencies with `pnpm --dir preview-manager install --frozen-lockfile`. With `NETLIFY_AUTH_TOKEN` supplied by the operator's secret environment or `NETLIFY_CLI_HELPER` pointing to an authenticated official CLI's `dist/utils/command-helpers.js`, run these commands from the checkout.

```sh
node preview-manager/cli.mjs inspect <demo-slug> <html-folder-or-zip>
node preview-manager/cli.mjs submit <demo-slug> <html-folder-or-zip>
node preview-manager/cli.mjs create-preview <new-slug> <category-id> <demo-name> <zip-or-folder>
node preview-manager/cli.mjs report
node preview-manager/cli.mjs private-releases [demo-slug]
node preview-manager/cli.mjs promote-private <demo-slug> <fixed-reviewed-url-or-id>
node preview-manager/cli.mjs release-private <demo-slug> <html-folder-or-zip>
node preview-manager/cli.mjs rollback-demo-private <demo-slug> <retained-release-id>
node preview-manager/cli.mjs rollback-site-private <retained-release-id>
```

The one-time `adopt-preview <fixed-develop-deploy-id>` command compares a protected branch deployment to the registered Production catalog. Run it first to inspect the result, then add `--apply` to save it. It fills the demos that have no private desk submission, including their registered Dataset routes and demo resources. A personal check carries over when the imported files match the original demo. The desk keeps later submissions and links each imported page to its fixed deployment. All subsequent uploads use the desk or its CLI. They inherit the current demo files by hash, including resources present only in the original Preview.

`seed /path/to/production-baseline.json` verifies the active deployment and every file before initializing the baseline in Netlify Blobs. The web service uses Netlify's signed-in team identity. Its private background function checks the expected production ID and site protection, creates a draft and uploads the hashes Netlify requests. It verifies the complete native file inventory and anonymous access before advancing a demo's current version. A conditional update handles concurrent submissions to the same demo. Browser uploads use 3 MiB chunks. Completed browser jobs clear their temporary chunks. The operator can resume a private job with `retry <job-id>`, adding the original package path for CLI submissions.

To redeploy the management application, use the official Netlify CLI 27.20.0 or a compatible version. The deploy tool checks that the CLI bundles `@netlify/serverless-functions-api` 2.24.0 or later so the backend can identify the signed-in user. Supply an authorized credential via `GYM_PREVIEW_DEPLOY_TOKEN` or use the explicitly approved operator grant.

```sh
node preview-manager/deploy-desk.mjs /absolute/path/to/netlify-cli --use-approved-cli-grant
```

The provisioner uses the official CLI's per-deployment secret setting for functions on the management deployment. Browser requests authorize against the current signed-in user and per-demo grants. Only the owner on the management alias can start a public release. The live and rehearsal histories have separate storage keys. A replacement management deployment needs its own provisioned secret. The management alias can be redeployed independently of the fixed content previews.
