# Manual publishing build lane

These Node modules move verified build artifacts through the signed Apps Script release store. They require no persistent Netlify account token. Google Sheets creates review and production requests; the build API cannot create either request or invoke a build hook.

## Build commands

- Develop: `node google-apps-script/publishing-controls/manual-release/preview-build.cjs`
- Review branch `codex/manual-production-review`: `node google-apps-script/publishing-controls/manual-release/review-build.cjs`
- Production main: `node google-apps-script/publishing-controls/manual-release/production-build.cjs`
- Ignore command: `node google-apps-script/publishing-controls/manual-release/ignore-build.cjs`

Register `./google-apps-script/publishing-controls/manual-release/netlify-plugin` after the existing preview-ready plugin. The existing callback verifies a successful develop deployment before the new capsule activation callback runs. Build hooks bypass Netlify's ignore command, so the build commands also reject missing, unsigned, expired, wrong-context, or mismatched requests. Ordinary Git pushes do not publish these three branches.

## Artifacts and publication

Preview stores its exact final build files before deployment. Its signed success callback activates that capsule. Review pins the active production capsule and reviewed preview capsule, explicit project selection, and catalog-renderer digest. It uses the selective renderer to preserve project scientific bytes, retain production-only projects, omit excluded routes, rebuild navigation and counts, preserve the homepage introduction, and keep the TBB notebook links hidden.

Review stores the candidate before deploying a separate review URL. Only successful review deployment enables the final confirmation. Production consumes the exact candidate selected by that confirmation. It changes only the deployment receipt to record its real main build identity, stores the resulting production capsule before deployment, and activates the capsule after success. The next release uses this new capsule rather than the old frozen Git archive.

The archive is gzip-compressed `ais-files-v1`: a four-byte unsigned big-endian JSON-header length, the UTF-8 header, and concatenated file bytes in header order. The header contains a safe path, size, and SHA256 for each file and the immutable provenance. Archives use 8 MiB chunks, each independently hashed. The complete archive and extracted inventory are also verified. Files are never extracted through an external archive utility. Capsule descriptors and their provenance must remain immutable; activation receipts are stored separately.

## API

POST to the configured Apps Script URL with `action=manual_release`. Each request is `{payload, signature}`, with a string JSON payload signed by HMAC-SHA256 using `AI4S_PREVIEW_CALLBACK_SECRET` and the domain prefix `ais-manual-release-api-v1\n`. All requests carry the site, branch, context, build, deploy, commit and timestamp identities. Hook envelopes use the distinct prefix `ais-manual-release-hook-v1\n`.

Actions: `begin_capsule`, `put_chunk`, `complete_capsule`, `upload_status`, `read_capsule`, `read_chunk`, `claim_review`, `candidate_ready`, `claim_production`, `deployment_succeeded`, `deployment_failed`. Claims are single-use and bound to the exact build; artifact reads remain bound to that claim. Production additionally pins the current baseline deploy and reviewed candidate digest. A review record is not authority to publish.

Publication requests, claims and success acknowledgements are never retried after an uncertain result. Immutable upload recovery first reads `upload_status` and verifies the exact original capsule descriptor. An already stored chunk is not sent again. An authoritatively missing chunk permits one resend of identical bytes; status reads themselves have at most three attempts. An unknown begin or completion acknowledgement can only be recovered by evidence that the original operation completed, without repeating that operation. A signed pre-deploy failure can mark the request failed. Once deployment may have begun, failures remain uncertain until status is reconciled against the served production receipt. An error in the post-deploy callback must never be labelled as a failed publication.

## Verification

```sh
node --test google-apps-script/publishing-controls/manual-release/*.test.cjs
node --test google-apps-script/publishing-controls/production-release/*.test.cjs
```

The local real-artifact verification record for this installation is `.local/reports/manual-publishing-20261008/node-flow-verification.json`. It covers all 13 projects, 12 projects excluding TBB, an empty library, and a subsequent production-source cycle. These checks perform no production network request.
