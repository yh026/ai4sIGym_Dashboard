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

### A. Deploy the Apps Script as a web app
In the registry sheet, open **Extensions → Apps Script**, paste the complete
[`Code.gs`](google-apps-script/Code.gs), save, and run `setup()` once from the
editor as the account that will own the Web App. Do not have several editors run
`setup()` because each can install a separate hourly trigger. This stores the
bound Registry Sheet ID for web-app requests. Then use
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
Paste the build URL into a browser tab and add `&action=manifest` at the end.
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
"registry production publish", branch main). Copy the Hook base URL and paste
it into the sheet's **Config** tab, `netlify_build_hook` cell. To rebuild a
Branch Deploy from the Sheet, create a second Hook whose default is a
non-production branch and paste it into `netlify_preview_build_hook`; see the
[Apps Script guide](google-apps-script/README.md).

Treat both Hook URLs and `access_token` as credentials. Only fully trusted
people should be editors of the Registry Sheet / bound Apps Script project.

### F. First content publish
After reviewing Drafts on the private develop Preview, set the approved demos to
**Live**, then choose **AI4S dashboard → Rebuild production site (main)** once.
~1–2 minutes later each demo is available at `/demos/<slug>/`. This button is for
content-only Drive/Sheet releases when the approved code is already on `main`.

## The routine forever after
1. Drop a new `.html` in the Drive folder.
2. Sync (menu, or the hourly auto-run) → the new row is created as **Draft**.
3. Build the stable `develop` Branch Deploy and review the Draft there.
4. When the content is approved, change its status to **Live**.
5. Only after explicit approval, choose **Rebuild production site (main)**.

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

`auto_publish_target` defaults to `off`. Set it explicitly to `preview` only
when hourly Drive syncs should rebuild the stable develop Preview. Production
is never an Apps Script automatic target; content-only Production releases use
the confirmed manual action, while approved code merges follow Netlify's Git
continuous-deployment path.

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

Use `department_id` (or `department`) on each registry record when possible.
The map follows the seven academic departments listed by
[NUS Faculty of Science](https://www.science.nus.edu.sg/our-departments/):

- `Physics` (`space-astronomy`)
- `Chemistry` (`chemistry-materials`)
- `Biological Sciences` (`biology-genomics`)
- `Food Science and Technology` (`food-science-technology`)
- `Mathematics` (`mathematics`)
- `Pharmacy and Pharmaceutical Sciences` (`pharmacy-biomedical`)
- `Statistics and Data Science` (`ai-mathematics-data`)

Mark the dashboard's own Drive row as `record_type=site` (or
`is_project=false`) so it can never be counted as a project. Mark a legitimate
project explicitly as `record_type=project` if its entry file is also named
`index.html`. The build retains an exact compatibility filter for the current
legacy dashboard row, but explicit registry metadata is the durable solution.

Canonical department metadata has highest priority. Older `domain`,
`science_domain`, and `research_domain` labels remain supported, followed by
compatibility assignments for the current collection and then metadata
inference. Scientific subject matter takes priority over the analytical method:
for example, battery projects are Chemistry even when they use forecasting, and
single-cell projects are Biological Sciences even when they use clustering.
Unrecognised records remain visible under Statistics and Data Science with a
build warning.

The former `earth-climate` catch-all has been retired because its projects now
belong to Physics, Biological Sciences, or Statistics and Data Science. Its old
collection URL returns visitors to the map. `physics-simulation` remains a
redirect to Physics.

The build publishes both `department_id` and the backwards-compatible
`domain_id`, generates collection pages at `/domains/<domain_id>/`, and injects
a return link into every demo. `category`, `task_type`, `method`, and `framework`
remain useful metadata and do not determine the department when an explicit
department is present.

Each department has a stable subtopic taxonomy. Prefer
`department_subtopic_id` or `department_subtopic`; older `subtopic`,
`science_subtopic`, `research_subtopic`, `subdomain`, and `topic` labels remain
supported. The build then applies compatibility assignments, accepts a legacy
generated `subtopic_id`, or infers a subtopic within the resolved department.
Ambiguous records use `General & Interdisciplinary`.

Resolved records publish `department_subtopic_id`, `subtopic_id`, and
`subtopic_label`. Manifest taxonomy version 4 includes every department's
subtopics and live `project_count`, so hover panels always reflect the current
registry rather than hard-coded project totals.

Project cards use real 16:9 data previews from `site/assets/previews/<slug>.*`.
A record may instead provide an HTTPS `preview_image`, `picture`, or `thumbnail`.
When no image is available, the card shows a quiet pending state rather than a
generic science emblem.

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
