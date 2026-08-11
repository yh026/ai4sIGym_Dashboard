# Phase 3 develop-only Preview automation runbook

This runbook verifies automatic Preview publishing with one harmless fixture.
It must never call the Production Hook, move `main`, or replace the published
Production deploy.

## Hard stop rules

Stop before the first write if any of these is false:

- Git `main` is still the recorded baseline SHA.
- Netlify's production branch is `main` and its current published deploy exactly
  matches the recorded baseline Deploy ID and commit.
- `preview_branch=develop`, `preview_url_branch=develop`, and `preview_url` is
  the stable develop Branch Deploy URL.
- `auto_publish_target=off` and legacy `auto_publish=no` while commissioning the
  receipt layer.
- Exactly one hourly `syncDrive` trigger exists and its error rate is zero.
- No other editor will upload, move, rename, or edit Registry content during the
  test window. Start just after the hourly trigger has completed.
- The pending Preview publish state is empty, or its previous request has been
  reconciled to `ready`.

Never print or record the Registry token, either Build Hook URL, browser cookies,
or a Netlify personal access token. Request IDs, Registry revisions, Git SHAs and
Deploy IDs are safe to record.

## Last known protected baseline

Re-read every value immediately before the real run. These values were observed
read-only before Phase 3 implementation:

| Invariant | Recorded value |
| --- | --- |
| Git `main` | `6c5488d9959cb4469c7f8960fb8cff6cdffba0aa` |
| Netlify published Production Deploy | `6a7554bf39cf8b00085699ef` |
| Production commit / branch / context | `6c5488d9959...` / `main` / `production` |
| Production URL | `https://aisigym.netlify.app` |
| Git `develop` before Phase 3 | `a0fa1778faf7a849f1d66c0091eda2606f0cb9bc` |
| Stable develop Deploy before Phase 3 | `6a79ed01a59f8a0008c816d3`, `ready` |
| Sheet data rows | 20: 15 Live, 4 Draft, 1 Archived |
| Config safety lock | `auto_publish_target=off`, `auto_publish=no` |
| Archived Phase 2 fixture row | row 21, `Archived + missing` |
| Archived Phase 2 fixture | `preview_draft_e2e_20260810_a.html`; Drive ID intentionally omitted from the public repository |
| QA Archive folder | `AIS Dashboard QA Archive`; Drive ID intentionally omitted from the public repository |

The Phase 2 fixture is audit evidence. Do not move, edit, rename, or reuse it.
Make a copy so the new run receives a new Drive file ID.

## Commission the accepted-to-ready receipt while automation is off

1. Push Phase 3 code only to `develop`; wait for its stable, unverified Branch
   Deploy to be `ready`. Do not merge or push `main`.
2. Deploy the Phase 3 Apps Script as a new version of the existing Web App. Do
   not create a second endpoint and do not run `setup()`.
3. Set `AI4S_NETLIFY_SITE_ID` and `AI4S_PREVIEW_CALLBACK_SECRET` only in Apps
   Script Properties, and set the same callback secret only in Netlify's Builds
   environment. Never put either value in the Sheet, Git, screenshots, or logs.
4. Refresh only the live `auto_publish_target` cell validation so its dropdown
   contains exactly `off` and `preview`; read it back as `off`. Do not run
   `setup()`, recreate the trigger, or change any other Config cell.
5. Keep `auto_publish_target=off` and request one manual develop Preview build.
6. Record the first `publish` event whose message says the request was
   accepted: request ID prefix, Registry revision prefix, HTTP status and
   timestamp. A 2xx response is not ready.
7. Wait for the corresponding `publish-ready` event with the same request ID
   and Registry revision. Record the receipt's Deploy ID, develop commit and
   timestamp.
8. Treat only the HMAC-authenticated Netlify `onSuccess` callback as the ready
   signal. It must match the exact request ID, requested_at, Registry revision,
   Site ID, `develop` branch and `branch-deploy` context. Do not anonymously
   fetch the private Preview URL.
9. Cross-check the callback Deploy ID with Netlify's read-only Deploy view. Its
   state must be `ready` before adopting this Registry revision as the baseline.
10. Reconfirm the exact Production Deploy ID and `main` SHA.

Run two no-change syncs. Both must report `0 new, 0 updated, 0 now missing`, and
neither may create an accepted event or a new develop Deploy.

## Prepare the harmless fixture atomically

1. Copy the archived fixture into a new subfolder inside the QA Archive. The
   original Phase 2 folder and file remain untouched.
2. Give the copy a unique run name such as `preview_auto_e2e_YYYYMMDD_b`; name
   its HTML file exactly after the folder.
3. Replace its contents with `fixtures/preview-auto-e2e-v1.html` while it is
   still outside the Registry root.
4. Verify the copy has a new file ID, contains marker
   `AI4S_PREVIEW_AUTO_E2E_V1`, and has no external resources or secrets.

## Enable the controlled canary

Set only `auto_publish_target=preview`; keep legacy `auto_publish=no`. Run one
no-change sync before moving the fixture. It must not create a Deploy. If it
does, set the target back to `off` and stop.

### Add

1. Move the completed copy into the configured Registry root in one operation.
2. Run one manual sync.
3. Accept only this result: exactly `1 new, 0 updated, 0 now missing`; one new
   Draft row; expected slug; new file ID; `file_check=ok — no provenance.md`.
4. Require one logical request to progress from `accepted` to `ready`.
5. Verify develop shows the V1 card and route with HTTP 200.
6. Verify Production does not contain the marker, its fixture route is 404, and
   its exact Deploy ID and `main` SHA are unchanged.

### Idempotency after add

Run sync twice without a Drive or Sheet change, then run the receipt reconcile
entry point once. There must be no new Hook POST, accepted event, or develop
Deploy. Reconciliation should reuse the matching ready receipt.

### Update

1. Replace the same Drive file's contents with
   `fixtures/preview-auto-e2e-v2.html`; do not create a second Drive file.
2. Wait longer than the tested Drive timestamp precision, then run sync.
3. Accept only `0 new, 1 updated, 0 now missing`; the row, file ID and slug must
   be unchanged and `last_modified` must advance.
4. Require one new logical request to reach `ready`.
5. Verify develop contains V2 and no longer contains V1. Production contains
   neither marker and its protected baseline is unchanged.

### Recoverable delete

"Delete" means removal from the configured Registry boundary, not permanent
Trash. Move the copied fixture folder back to the QA Archive while its row is
still Draft, then run sync.

Accept only `0 new, 0 updated, 1 now missing`. This change must create one
develop Preview request and reach `ready`, even though `nNew+nUpdated` is zero.
The card must disappear and the develop fixture route must return 404.
Production must remain on the exact baseline Deploy.

After the clean develop Deploy is ready, change the copied fixture's row to
Archived. It is already excluded because it is missing, so this cleanup must
not create another Deploy. Leave the copied folder in the QA Archive and retain
the Archived + missing row as audit evidence.

## Retry and idempotency acceptance

The mandatory real-service proof is deliberately non-destructive:

- `accepted` and `ready` are distinct phases with the same request ID.
- Once the Hook returns 2xx, hourly reconciliation never POSTs a duplicate.
  A missing callback becomes `verification-timeout` and requires a manual retry.
- Repeated no-change syncs do not create Deploys.
- Automatic retries occur only for an actual non-2xx/network Hook failure and
  preserve the logical request ID.

Use deterministic local tests for HTTP errors, stale receipts, retry cooldown,
maximum attempts, and success on a later attempt. Do not add a production-like
fault-injection switch merely to create a failed real Deploy. A deliberate
duplicate develop Deploy requires separate user approval.

## Final acceptance and rollback

Leave `auto_publish_target=preview` only when all of the following hold:

- no Preview request is pending;
- the stored ready Registry revision equals the current desired revision;
- the latest stable develop Deploy is `ready` and the fixture is absent;
- the copied fixture is in the QA Archive and its Sheet row is Archived + missing;
- one natural hourly no-change sync produces no new Deploy;
- Production still has the exact baseline Deploy ID, commit and `main` branch;
- no Production Hook was called and no `main` commit was created.

On any mismatch, immediately restore `auto_publish_target=off`, move the copied
fixture to the QA Archive, mark its row Archived, and request one clean manual
develop Preview build. Never use the Production Hook as a recovery mechanism.
