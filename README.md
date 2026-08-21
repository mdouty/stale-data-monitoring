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
