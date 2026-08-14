# AIS Instrument Gym

An interactive science map for the AIS Instrument Gym demo collection. The
home page is a hand-drawn world of the seven NUS Science departments: visitors can select a
region, preview its subtopics and current projects, then enter its full
collection. Every project opens as a self-contained demo. Content lives in Google Drive, the
record lives in the registry sheet, and this repo turns both into a fast public
site on every build. The repo contains **zero production demo content** — the
whole site is reproducible from Drive + Sheet alone.

The complete sheet-bound Apps Script is checked in at
[`google-apps-script/Code.gs`](google-apps-script/Code.gs). Its
[`usage guide`](google-apps-script/README.md) covers the separate Preview and
Production Netlify workflows.

```
Drive folder ──▶ Apps Script (sync + JSON feed) ──▶ this build ──▶ Netlify
                     ▲
              registry sheet (Draft / Live / Archived + metadata)
```

## One-time setup (~20 min)

### A. Deploy the Registry v2 Apps Script as a web app
In the **Registry v2** sheet, open **Extensions → Apps Script** and create the
new container-bound project. Install both [`Code.gs`](google-apps-script/Code.gs)
and [`appsscript.json`](google-apps-script/appsscript.json), then configure the
operational Script Properties listed in the
[Apps Script guide](google-apps-script/README.md). Before running `setup()`, set
automatic publishing to `off` and disable the old V1 hourly trigger. Run
`setup()` once as the
account that will own the Web App. It validates the existing V2 workbook and
installs the single hourly trigger; it never creates or migrates V1 tabs. Then use
**Deploy → New
deployment** → gear icon → **Web app**:
- Description: anything
- Execute as: **Me**
- Who has access: choose the option that permits access **without a Google
  login** (normally **Anyone**, not “Anyone with Google account”). The
  unguessable token in the URL is what gates the endpoint; verify it in an
  incognito window. If your organisation disables anonymous Web Apps, Netlify
  cannot call this endpoint until that policy or architecture changes.

Click Deploy, authorize if asked. Then back in the sheet:
**AI4S dashboard → Show Registry API URL for Netlify** — copy the full URL it shows
(it ends in `?token=…`). That string is your `REGISTRY_URL`.

### B. Verify the feed (30 seconds, worth it)
Paste the build URL into a browser tab and add `&action=manifest&schema=2` at the end.
You should see JSON with your site config and every **Live** demo. If `demos`
is `[]`, nothing is set to Live yet — that's the status column, not a bug.

For an intentional Preview check, add `&action=manifest&audience=preview`.
That closed audience returns healthy **Live + Draft** rows. The default and
`audience=production` remain Live-only; Archived, missing, empty, and unreadable
rows are excluded from both audiences. Treat either URL as a credential because
it still contains the Registry token.

### C. Put this repo on GitHub
```bash
cd ai4s-dashboard
git init && git add -A && git commit -m "AI4S dashboard"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOURNAME/ai4s-dashboard.git
git push -u origin main
```

### D. Create the Netlify site
On app.netlify.com: **Add new site → Import an existing project → GitHub** →
pick the repo. Build command and publish directory are read from
`netlify.toml` automatically. Before the first deploy, add the environment
variable: **Site configuration → Environment variables → Add**
`REGISTRY_URL` = the URL from step A. Deploy.

Mark `REGISTRY_URL` as a **secret** and give it the **Builds** scope. Provide it
to **Production** and the trusted `develop` **Branch deploy**. This repository is
public, so a Deploy Preview may receive the secret only when Netlify's public-PR
policy requires approval or deploys untrusted pull requests without sensitive
variables. Never use an unrestricted sensitive-variable policy for fork PRs.

### E. Create the build hook and wire it to the sheet
**Site configuration → Build & deploy → Build hooks → Add build hook** (name it
"registry production publish", branch main). Store its base URL in the new
bound project's `AI4S_NETLIFY_PRODUCTION_BUILD_HOOK` Script Property. Create a
second Hook for `develop` and store it in
`AI4S_NETLIFY_PREVIEW_BUILD_HOOK`; see the
[Apps Script guide](google-apps-script/README.md). Hooks and tokens never belong
in V2 `_Config` or another Sheet cell.

Treat both Hook URLs and the Registry token as credentials. Only fully trusted
people should administer the bound Apps Script project.

### F. First content publish
After reviewing Drafts on the private develop Preview, set the approved demos to
**Live**, then choose **AI4S dashboard → Rebuild production site (main)** once.
~1–2 minutes later each demo is available at `/demos/<slug>/`. This button is for
content-only Drive/Sheet releases when the approved code is already on `main`.

## The routine forever after
1. Add one English-named direct subfolder to the Drive root, with its primary
   `.html` inside.
2. Sync from V2 (menu, or the hourly auto-run) → the project is created as
   **Draft + Preview only**.
3. In `Projects`, complete the descriptive fields and choose any `Data Type`
   and `Instrument Type` labels defined by the visible `Options` table.
4. Build the stable `develop` Branch Deploy and review the Draft there.
5. When the content is approved, change its status to **Live** and its
   permission to **Public**.
6. Only after explicit approval, choose **Rebuild production site (main)**.

A warm sync still enumerates the complete Drive source inventory and rechecks
metadata, MIME and direct-parent boundaries. It may use a hash-only
Script Properties hint to avoid downloading unchanged, healthy HTML and
provenance blobs; cache loss or failure safely falls back to a full read. If the
verified target is already identical to V2, the no-op path also avoids an empty
Sheets write, flush, reopen and post-read. Any real change keeps the guarded
single-batch write and exact fresh-reopen verification. See the
[Apps Script guide](google-apps-script/README.md#4-%E6%97%A5%E5%B8%B8-v2-%E5%B7%A5%E4%BD%9C%E6%B5%81)
for the full safety contract.

Drive-scan skip notices are sanitised before batching under the 1,000-character
Audit limit. The usual three reasons use one append; oversized sets are
fragmented and batched without dropping any sanitised reason, and a `finally`
flush preserves reasons already observed if a later scan check fails closed.

The shipped Version 12 warm run completed in 27 seconds with 16/16 fingerprint
reuse and zero source parses. Against the previous 71-second no-change median
(104/71/56 seconds), that is 44 seconds or 61.97% faster and a 2.63× speedup,
meeting both the ≤35-second and ≥50% targets. The current classification code
baseline is `develop@a6611bcd4db31c39805a436a96d4eb9b259de204` and passes
345/345 tests. The formal Web App serves the same baseline as Version 15 at its
existing deployment ID and URL; deployment topology remains exactly two. All
related Git pushes used `[skip netlify]`, and both in-place rollouts executed no
functions or Hook, so none of these actions published a new Preview or Production
artifact. Published Production is the earlier
`6a7ee842b481720008e4cf70` artifact: schema 2 / taxonomy 4 with 16 demos,
including Raman. It was built before the editable-facet rollout and therefore
does not yet contain taxonomy 5 or the new filters.

Code changes follow the separate Git review path: review them on `develop`, then
merge to `main` only when the code is approved **and ready to go live**. With
Netlify continuous deployment enabled, merging `main` immediately creates the
Production deploy; do not also press **Rebuild production site (main)** for the
same release. A content-only Drive update does not require a Git merge and uses
the confirmed rebuild button instead. Netlify Project Visibility is configured as **Private → Previews
only**, so the stable develop Branch Deploy and PR Deploy Previews require a
project team login while Production remains public. Preview builds also send
`X-Robots-Tag: noindex, nofollow`; noindex is only an indexing hint, not the
authentication boundary.

`AI4S_AUTO_PUBLISH_TARGET` defaults to `off`. Set the Script Property explicitly to `preview` only
when hourly Drive syncs should rebuild the stable develop Preview. Production
is never an Apps Script automatic target; content-only Production releases use
the confirmed manual action, while approved code merges follow Netlify's Git
continuous-deployment path.

With automation `off`, sync may reuse its exact post-verified Preview snapshot
only to reconcile desired/callback state; it cannot POST the Preview Hook.
Manual Preview publishing and automatic `preview` mode both compile the live V2
workbook, and publish reconciliation rereads current operational Script
Properties before making any request.

Preview automation compares a deterministic Registry revision instead of only
the sync counters, so additions, edits, missing files, recovered files, and
publishable Sheet metadata changes are handled consistently. A Build Hook 2xx
means only **accepted**; the request becomes **ready** only after the successful
develop Branch Deploy sends Apps Script a matching HMAC-authenticated callback.
The callback is independent of visitor access to the private Preview URL. Hook
network/non-2xx failures use bounded retries, but an accepted request is never
automatically deployed again merely because its callback is delayed. Use
**AI4S dashboard → Preview publish status** for read-only status; after 15 minutes
without a callback, any retry must be explicitly requested by a person.

## Science-map taxonomy

Registry v2 `_Taxonomy` owns stable department, subtopic, task and method IDs.
Editors choose the corresponding English labels in `Projects`; `_Registry` and
`_Facets` must project the same IDs or the build fails closed. The map follows
the seven academic departments listed by
[NUS Faculty of Science](https://www.science.nus.edu.sg/our-departments/):

- `Physics` (`space-astronomy`)
- `Chemistry` (`chemistry-materials`)
- `Biological Sciences` (`biology-genomics`)
- `Food Science and Technology` (`food-science-technology`)
- `Mathematics` (`mathematics`)
- `Pharmacy and Pharmaceutical Sciences` (`pharmacy-biomedical`)
- `Statistics and Data Science` (`ai-mathematics-data`)

V2 never guesses taxonomy from a title, category or legacy alias at build time.
A new Draft with blank or unknown taxonomy stays blocked until a maintainer
chooses valid labels. Active taxonomy and current project counts drive the map,
filter chips and department pages.

### Editable Data Type and Instrument Type facets

The visible `Options` table is the controlled vocabulary for two flexible
project facets. `Category` is exactly `data_type` or `instrument_type`; each row
also has `Option ID`, `Option Label`, `Aliases`, `Display Order`, `Active` and
`Description`.

- Keep `Option ID` stable after first use. It is a lowercase kebab-case machine
  identity such as `satellite-imager`; changing a label must not change its ID.
- `Option Label` is the human-facing dropdown and website label. It must not
  contain commas, semicolons, pipes or line breaks because those characters
  delimit lists.
- `Aliases` is an optional list of older names or convenient input spellings.
  When renaming a label, add its previous label to `Aliases` so existing
  `Projects` values still resolve to the same stable ID.
- `Display Order` is a number controlling option/filter order. `Active` must be
  a real checked or unchecked checkbox. Before unchecking an option, remove or
  replace every assignment that uses it; an assigned inactive option blocks
  that project rather than silently changing its meaning.

In `Projects`, enter one or more labels in `Data Type` and `Instrument Type`,
separated by commas, for example `1D, 2D` and `Sensor`. The dropdowns are
suggestions generated from active `Options`; the compiler remains the authority
and also accepts an unambiguous ID or alias. Repeated selections of the same
stable ID are de-duplicated; unknown, ambiguous or inactive selections fail
closed.

After an option or assignment changes, run **AI4S dashboard → Sync Drive folder
now**, then **Build preview branch** and review the stable private `develop`
Preview. The page generates filter chips only for active options currently used
by visible projects. A selected chip matches membership in that facet (a
project tagged `1D, 2D` matches either `1D` or `2D`); filters from different
groups are combined with AND. Only after approval should a maintainer choose
**Rebuild production site (main)**. Sync never publishes Production by itself.

Registry v2 gives each project zero or one optional card image. Editors put the
image beside that project's HTML in Drive and enter only its direct-child file
name (for example `card.jpg`) in **Card Image**, plus human-written alt text.
V2 sync atomically maintains the matching `_Assets` row and hidden Registry
link; replacing the same filename adopts its new Drive ID, while clearing
**Card Image** removes that machine index.
The authenticated Registry service downloads the image during the build and
writes it to `dist/assets/cards/`; external image URLs are not enabled in the
first round. When **Card Image** is blank, the build reuses the matching
`site/assets/previews/<slug>.*` image. If neither source exists, the card shows a
quiet pending state rather than a generic science emblem.

## Local preview
Use Node.js 24 or newer. `node build.js --mock` builds from `fixtures/` into `dist/` with no network —
open `dist/index.html` in a browser. With `REGISTRY_URL` exported in your
shell, plain `node build.js` builds from the real registry.

## What the build injects into each demo
A department-aware return control (bottom-left), a route back to the main science map,
and, when any provenance fields are filled, a "Data & methods" panel
(bottom-right) showing data source + license + snapshot date, task, method,
framework, training, metrics, and the workflow link. Styles are inline and
namespaced (`ai4s-*`), so demos don't need to know about Instrument Gym at all.

## Troubleshooting
- **Build fails: "REGISTRY_URL is not set"** — add the env var in Netlify
  (step D), then trigger a redeploy.
- **Build fails: "bad token"** — the env var is missing the `?token=…` part;
  re-copy from "Show Registry API URL for Netlify".
- **Production is empty** — no healthy rows have status **Live**, or the deploy
  predates them: publish again from the sheet menu.
- **A Draft is absent from Preview** — confirm the deploy is the stable
  `develop` Branch Deploy (not a PR Deploy Preview) and that `file_check` is not
  `missing`, `unreadable`, or `page empty`.
- **A demo is skipped with "file missing in Drive"** — its `file_check` says
  `missing`; the file was removed or unshared. Restore it or set the row to
  Archived.
- **You edited Code.gs later and the feed didn't change** — web apps serve a
  pinned version. In Apps Script: Deploy → **Manage deployments** → pencil →
  Version: **New version** → Deploy. The URL stays the same.
- **Changed a demo's slug** — its URL changes on next publish; old links break.
  Slugs are yours to keep stable once shared.
