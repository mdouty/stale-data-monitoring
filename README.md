# Stale Data Monitoring

An internal Google Apps Script application for reviewing stale Snowflake assets, managing lifecycle decisions, coordinating quarantine and purge handoffs, and delivering governed Slack notifications.

## Core workflows

- Import and review complete Snowflake asset extracts.
- Detect assets that exceed the configured inactivity threshold.
- Confirm deprecation, contest with an active exception, self-purge, restore access, or dismiss as an administrator.
- Reconcile lifecycle changes across recurring imports.
- Prepare controlled quarantine and purge handoffs for platform teams.
- Restrict record visibility by stewardship and managed teams while allowing administrators to see all records.
- Record status changes, comments, notifications, and partner actions in the lifecycle audit history.

## Repository structure

- `Code.js` — Apps Script web application entry point.
- `Config.js` — application constants, environments, lifecycle states, and data model headers.
- `SnowflakeAdapter.js` — CSV intake review, import processing, reconciliation, and dashboard refresh.
- `LifecycleService.js` — owner and administrator lifecycle actions.
- `DashboardService.js` — dashboard data access, filtering, details, and exports.
- `NotificationService.js` — notification grouping and Slack workflow delivery.
- `PlatformActionService.js` — quarantine, purge, and restoration handoffs.
- `ExceptionValidationService.js` — validation against the external exception log.
- `TeamService.js` — team membership and record-access rules.
- `AdminService.js` — administrator settings and operational controls.
- `Repository.js` — Google Sheets persistence helpers.
- `ReliabilityService.js` — durable batch plans, recovery storage, trigger replacement, and Slack delivery receipts.
- `Index.html`, `Client.html`, `Styles.html` — application UI.
- `snowflake_stale_asset_export_with_ownership.sql` — reference Snowflake export query.

## Prerequisites

- Access to the associated Google Apps Script project and foundation workbook.
- Node.js and the Google `clasp` CLI.
- A Salesforce Google Workspace account authorized for the project.

## Local setup

```bash
npm install -g @google/clasp
clasp login
clasp pull
```

The checked-in `.clasp.json` connects this repository to the existing Apps Script project. Do not replace its script ID unless intentionally creating a separate application.

## Validate source files

```bash
node -e 'const fs=require("fs"),vm=require("vm"); for (const f of fs.readdirSync(".").filter(x=>x.endsWith(".js"))) new vm.Script(fs.readFileSync(f,"utf8"),{filename:f}); const html=fs.readFileSync("Client.html","utf8").replace(/^<script>\s*/,"").replace(/\s*<\/script>\s*$/,""); new vm.Script(html,{filename:"Client.html"}); console.log("All Apps Script and client files parse successfully.");'
```

Run the local regression checks:

```bash
node tests/production-rollout.test.js
node tests/import-performance.test.js
node tests/import-reliability.test.js
```

Review calculation and source publication continuations process up to three original-sized batches per request, saving each batch before proceeding. They stop starting additional batches after 30 seconds; an in-flight batch finishes normally. Review merging, reconciliation, finalization, and notification delivery retain their existing checkpoints and rules. Browser status checks run independently of processing requests and retry after transient connection failures. Source progress measures evaluated rows; upload and finalization show their current stage without estimating an overall percentage.

## Connection recovery

- Browser status checks reconnect independently of background workers. Uploads queue review preparation on the server; reopening the app finds the staged review. Publication requests use the review token to recognize an already-started import rather than apply approval twice.
- Review and import workers install a watchdog before work. Replacement triggers are created before old triggers are deleted. Caught review/import failures retry the same checkpoint with a delay, then pause after three failures for explicit resumption.
- Source batches, candidate approvals, retained-case reconciliation, orphan handoffs, lifecycle action updates, and notification bookkeeping save write plans before applying changes. Replays use the saved IDs, values, append positions, and result counts. Recovery pauses rather than overwriting a conflicting append row introduced by another writer.
- Review caches and recovery payloads use alternating hidden sheets with a committed pointer. An interrupted replacement leaves the prior payload readable. Keep the `Recovery_*` and `Slack_Delivery_Receipts` sheets and their associated script properties intact.
- Slack sends record intent before contacting the webhook and retain accepted receipts for retries. A network timeout, an ambiguous server response, or an interrupted send leaves the attempt held for verification rather than automatically sending it again. Delivery workers share a lock.

For an uncertain Slack result, use **Admin → Operations → Verify uncertain Slack deliveries**, check Slack or its workflow history, and confirm **received** or **not received**. Received allows bookkeeping to finish using the saved receipt; not received authorizes a subsequent retry. Use the campaign retry control to continue, or retry the affected notification for an individual delivery. Verification itself does not send a message. Without receiver-side deduplication, an unknown webhook result cannot be safely retried automatically while also guaranteeing no duplicates.

The reliability checks inject failures before and after writes, during cache replacement, after buffer renames, and around Slack acceptance. They run with simulated services and do not send notifications. Recovery adds bounded storage operations per batch or owner message; it does not add per-asset network requests. Validate elapsed times with a representative DEV import and approved test recipients before deployment. Local tests do not establish production latency or availability during a Google service outage.

## Deploy

```bash
clasp push --force
clasp version "release description"
clasp deploy -i DEPLOYMENT_ID -V VERSION_NUMBER -d "release description"
```

Update the existing deployment rather than creating a new public URL unless a separate environment is intentional.

## Security

- Webhooks, API endpoints, and other integration secrets belong in Apps Script Script Properties and must never be committed.
- CSV extracts, generated UAT artifacts, and local credentials are ignored by Git.
- DEV Slack delivery should remain disabled or locked to approved test recipients during live-data testing.
- Production data and configuration must not be modified from DEV reset or UAT utilities.

## Environments

The application supports isolated `DEV` operational sheets and production sheets in the shared foundation workbook. Configuration, administrators, roles, and teams are shared deliberately; operational lifecycle records are environment-specific.
