# Google-hosted Question Studio

The cloud worker runs on Google Apps Script time triggers without a laptop or a paid Compute Engine instance. Apps Script consumer quotas apply; this is not a continuously running Node.js server. The OpenAI bill and Firebase usage remain separate from the free execution runtime.

## Runtime

- Each trigger executes one resumable step. Background OpenAI requests are submitted once, then retrieved in later invocations.
- The existing run, questions, pending batches, repair attempts and complete API ledger are migrated. The $50 maximum is never reset. Every paid request is reserved before submission; an unknown submission outcome stops further paid work until reconciled.
- Drive keeps two compressed state snapshots. A pointer changes only after writing the next snapshot. ScriptLock excludes simultaneous UI and timer mutations.
- Transient API, Firebase and Google service errors defer work. Bounded content failures proceed to repair or the next topic. Authentication, corrupted accounting and uncertain charges fail closed.
- A prepaid six-minute runtime reservation survives an interrupted invocation. Completed invocations replace it with elapsed time. When the configured daily allowance is exhausted, work resumes in the next 24-hour window.
- Luna authors and repairs; Sol independently solves and reviews. Models, prices, limits and endpoints come from Script Properties populated from the deployment environment.
- Geometry and statement formulas are drawn privately with Slides, cropped to their content with a 24-pixel margin, and uploaded to Firebase Storage. Identical formulas and diagrams share one image across languages; translated instructions remain separate when possible. Answers, hints and explanations always remain Unicode text. Unsupported LaTeX goes through repair instead of being published as raw commands.
- The web app is deployed with `MYSELF` access and checks the exact configured owner for every operation. No public API or shared bearer link is enabled.

## Deployment

1. Configure the cloud fields from `.env.example` in the ignored `.env`. `STUDIO_CLOUD_OAUTH_SCOPES` must include Drive, Slides, external requests, installable triggers and user email. Configure service endpoints using the official Google API URLs.
2. Pause the local worker and wait until its status is paused. Reconcile any uncertain call first. Preserve `.data/state.json` as a migration backup.
3. Authorize the official `@google/clasp` CLI, create a private script project, and configure the ignored `.clasp.json` with that script ID and `rootDir: .cloud-build`.
4. Run `npm run check`, `npm run cloud:check`, then `npm run cloud:build -- --bootstrap` and `npx clasp push --force`.
5. In the Apps Script editor run `bootstrapCloud` once. The owner must authorize the displayed Google scopes. This imports secrets into Script Properties and state into private Drive files. It deliberately refuses to replace an existing ledger.
6. Remove the local generated `Bootstrap.html`, rebuild, and push the clean three-file bundle. Verify that the remote project no longer contains the bootstrap file before creating a deployment.
7. Run `activateCloud`. It creates one trigger and resumes the imported run. Deploy the private web app using `clasp deploy` and verify a timed execution and a newly published Firebase question.
8. Set local `STUDIO_EXECUTION_OWNER=google-apps-script` and stop the old local process. The old local snapshot must never be resumed alongside the cloud worker.

Build artifacts, bootstrap material, credentials and local state are ignored by Git. Do not share the script project: editors can access Script Properties and the deployment history. Removing a bootstrap file from the current project does not erase historical revisions.

## Operations

Use the private web UI to pause, resume, inspect costs and review questions. `cloudStatus` returns safe runtime diagnostics for script-level administration. Trigger failures also appear in Apps Script's Executions page. Pausing keeps pending responses and their reservations intact. The timer can remain installed while paused or budget exhausted; it issues no paid requests in those states.

To change the daily runtime allowance, set `STUDIO_CLOUD_DAILY_RUNTIME_MS` in the deployment environment, rebuild and push, then run `configureCloudRuntime` as the owner. The supported maximum is 90 minutes. This updates the allowance without resetting accumulated runtime, pending API reservations or spending. The six-minute reservation can stop new work before the full allowance is consumed; Google's account-wide quota can also stop execution earlier.

To return an existing run from the laptop, pause and stop the local worker, then stage its complete gzip-compressed state in the private `questionStudioMigrations/<runId>` record with destination `google-apps-script`, export timestamp and SHA-256 checksum. Run `acceptLocalHandoff`, then `activateCloud`. Import requires the same run, a paused checkpoint, a fresh checksum, nondecreasing settled charges and preservation of every existing call and question. It cannot increase the budget or erase an existing ledger. Repeating the same import is idempotent. Set local `STUDIO_EXECUTION_OWNER=google-apps-script` before restarting any local interface.

If the provider exceeds the reserved number of paid searches but its total charge still fits the monetary reservation, the completed response is retained and further web research is disabled for the run. Generation and review continue using cached references. A monetary overrun or uncertain charge remains an explicit stop.

Google documents that multiple signed-in Google accounts can break Apps Script web-app access. If the private web URL shows a Google “file not found” page, open it in a separate browser profile or private window signed in only as the configured owner. This does not affect already installed time triggers.

For rollback, first pause the cloud worker and remove or disable its trigger. Export and restore the current authoritative cloud ledger, including pending request identifiers and all charges, before switching `STUDIO_EXECUTION_OWNER` to `local`. Never roll back using the original pre-migration snapshot.

If the editor is unavailable, an administrator can request the same handoff through the private `questionStudioControl/<scriptId>` record: a UUID `id`, `action: handoff-local`, `requestedAt` in milliseconds and `status: pending`. Client writes to this path must remain denied. The timer accepts requests less than one hour old, exports the paused checkpoint under the execution lock, switches ownership and removes its triggers before marking the command completed. Restore locally only after the completed receipt and runtime diagnostics confirm local ownership and zero triggers. The runtime quota does not block this administrative handoff.
