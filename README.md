# AI4S demo dashboard

Static dashboard for the AI4S demo collection. Content lives in Google Drive,
the record lives in the registry sheet, and this repo turns both into a fast
public site on every build. The repo contains **zero demo content** — the whole
site is reproducible from Drive + Sheet alone.

```
Drive folder ──▶ Apps Script (sync + JSON feed) ──▶ this build ──▶ Netlify
                     ▲
              registry sheet (what's Live, all metadata)
```

## One-time setup (~20 min)

### A. Deploy the Apps Script as a web app
In the registry sheet: Extensions → Apps Script, then **Deploy → New
deployment** → gear icon → **Web app**:
- Description: anything
- Execute as: **Me**
- Who has access: **Anyone with the link** (the unguessable token in the URL is
  what actually gates it; the folder and sheet stay private)

Click Deploy, authorize if asked. Then back in the sheet:
**AI4S dashboard → Show build URL for Netlify** — copy the full URL it shows
(it ends in `?token=…`). That string is your `REGISTRY_URL`.

### B. Verify the feed (30 seconds, worth it)
Paste the build URL into a browser tab and add `&action=manifest` at the end.
You should see JSON with your site config and every **Live** demo. If `demos`
is `[]`, nothing is set to Live yet — that's the status column, not a bug.

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

### E. Create the build hook and wire it to the sheet
**Site configuration → Build & deploy → Build hooks → Add build hook** (name it
"registry publish", branch main). Copy the hook URL and paste it into the
sheet's **Config** tab, `netlify_build_hook` cell.

### F. First publish
In the sheet, set some demos to **Live**, then
**AI4S dashboard → Publish site**. ~1–2 minutes later the dashboard is up,
each demo at `/demos/<slug>/`.

## The routine forever after
1. Drop a new `.html` in the Drive folder.
2. Sync (menu, or the hourly auto-run) → fill the row → status **Live**.
3. Menu → **Publish site**.

Set `auto_publish` to `yes` in Config if you'd rather the hourly sync also
rebuild whenever it finds changes — then step 3 disappears.

## Local preview
`node build.js --mock` builds from `fixtures/` into `dist/` with no network —
open `dist/index.html` in a browser. With `REGISTRY_URL` exported in your
shell, plain `node build.js` builds from the real registry.

## What the build injects into each demo
A "← All demos" chip (bottom-left) and, when any provenance fields are filled,
a "Data & methods" panel (bottom-right) showing data source + license +
snapshot date, task, method, framework, training, metrics, and the workflow
link. Styles are inline and namespaced (`ai4s-*`), so demos don't need to know
about the dashboard at all.

## Troubleshooting
- **Build fails: "REGISTRY_URL is not set"** — add the env var in Netlify
  (step D), then trigger a redeploy.
- **Build fails: "bad token"** — the env var is missing the `?token=…` part;
  re-copy from "Show build URL for Netlify".
- **Site is empty** — no rows have status **Live**, or the deploy predates
  them: publish again from the sheet menu.
- **A demo is skipped with "file missing in Drive"** — its `file_check` says
  `missing`; the file was removed or unshared. Restore it or set the row to
  Archived.
- **You edited Code.gs later and the feed didn't change** — web apps serve a
  pinned version. In Apps Script: Deploy → **Manage deployments** → pencil →
  Version: **New version** → Deploy. The URL stays the same.
- **Changed a demo's slug** — its URL changes on next publish; old links break.
  Slugs are yours to keep stable once shared.
