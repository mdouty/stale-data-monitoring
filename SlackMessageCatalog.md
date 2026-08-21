# EDG Stale Data Monitoring — Slack Message Catalog

This catalog defines the stable `messageType` values sent by the Apps Script application to the Slack workflow webhook. Slack Workflow Builder should branch directly on `messageType` and construct all message content from the raw payload variables.

The wording follows the signed-off lifecycle: initial notification at T+2, contestation through T+9, restriction at T+16, quarantine at T+23, a 30-day purge notice at T+173, and verified purge at T+203. Orphaned assets and sandbox data use their separate PRD timelines. Exception reminders follow the EDG Exception Management App SOP.

## Workflow branches

| `messageType` | Recipient audience | Trigger | Intent |
| --- | --- | --- | --- |
| `STALE_ASSET_NOTICE` | Asset owner and stewards | T+2 after EDG validation | Initial action-required stale designation |
| `CONTESTATION_REMINDER` | Asset owner and stewards | Before T+9 | Warn that the contest window is closing |
| `OWNER_ESCALATION` | Leadership, DPMT, BDST, DPML | 7 days with no response | Escalate unresolved ownership/action |
| `CONTESTATION_RECEIVED` | Requester and EDG | On contestation | Confirm receipt and pause automation for review |
| `DEPRECATION_ACCEPTED` | Owner and stewards | Owner accepts | Confirm scheduled restriction/quarantine |
| `RESTRICTION_NOTICE` | Owner and stewards | T+16 | Explain restricted but recoverable state |
| `QUARANTINE_NOTICE` | Owner and stewards | T+23 | Explain isolated, recoverable state and purge date |
| `PURGE_NOTICE_30_DAY` | Owner, stewards, DPMT, BDST, DPML | T+173 | Final retention/legal-control check |
| `PURGE_COMPLETED` | Owner, stewards, EDG | T+203 after verification | Confirm irreversible deletion and audit evidence |
| `RESTORATION_CONFIRMED` | Requester, owner, stewards | On restoration | Confirm access and case closure |
| `ORPHAN_QUARANTINE_NOTICE` | EDG, DPMT, BDST, leadership | T0 | Establish ownership or authorize disposition |
| `SANDBOX_PURGE_NOTICE_7_DAY` | Sandbox owner | 7 days before purge | Final export/retention warning |
| `SANDBOX_PURGE_COMPLETED` | Sandbox owner and EDG | After verification | Confirm sandbox deletion |
| `PURGE_BLOCKED` | EDG and platform operators | Control blocks purge | Prevent deletion and request resolution |
| `LIFECYCLE_SLA_ALERT` | EDG operations | Milestone overdue | Resolve a delayed lifecycle case |

## Exact message content

Slack Workflow Builder owns the message wording. Tokens below show the raw values supplied by the application; use Slack's variable picker in place of the braces.

### `STALE_ASSET_NOTICE`

**Action required: review stale data asset**

EDG identified *{objectFqn}* on *{platform}* as a deprecation candidate. Its last recorded activity was {lastActivityDate} ({daysInactive} days inactive), which exceeds the {thresholdDays}-day threshold.

*Action required by {contestDeadline}:* confirm that deprecation may proceed, contest the designation if the asset is still used, or submit an exception when retention is business-critical. If there is no response, access restriction is scheduled for {restrictAt}.

Review the record: {applicationUrl}  
Request an exception when retention is business-critical: {exceptionAppUrl}  
Questions: {edgContact}

### `CONTESTATION_REMINDER`

**Reminder: stale-data review window is closing**

The review window for *{objectFqn}* closes on *{contestDeadline}*. We have not recorded a response. Contest the stale designation, confirm that deprecation may proceed, or submit an exception before the deadline. If no action is taken, the lifecycle will continue to restriction on {restrictAt}.

### `OWNER_ESCALATION`

**Escalation: stale asset has no owner response**

No response has been recorded after 7 days for stale asset *{objectFqn}*. Leadership support is requested to confirm ownership and obtain a disposition before {contestDeadline}. Without a response, EDG will continue the approved restriction and quarantine lifecycle.

### `CONTESTATION_RECEIVED`

**Contestation received**

Your contestation for *{objectFqn}* was received. Automated deprecation actions are paused while EDG validates the business use and supporting evidence. We will update this case after review.

### `DEPRECATION_ACCEPTED`

**Deprecation accepted**

Your confirmation that *{objectFqn}* may proceed through deprecation was recorded. Access restriction is scheduled for {restrictAt}, followed by quarantine on {quarantineAt}. Contact EDG immediately if the disposition changes.

### `RESTRICTION_NOTICE`

**Access restricted**

Standard access to *{objectFqn}* has been restricted as scheduled. The data has not been permanently deleted and remains recoverable. Quarantine is scheduled for {quarantineAt}. If the asset still serves a valid business purpose, request restoration or submit an exception.

### `QUARANTINE_NOTICE`

**Asset quarantined**

*{objectFqn}* is now quarantined. It is inaccessible to standard users but remains recoverable during the quarantine period. Permanent purge is scheduled for {purgeEligibleDate}. Request restoration or submit an approved exception before that date if retention is required.

### `PURGE_NOTICE_30_DAY`

**Final 30-day purge notice**

*{objectFqn}* is scheduled for permanent deletion on {purgeEligibleDate}. Confirm that no legal hold, regulatory obligation, active remediation, or approved business exception requires retention. After purge, restoration will not be available.

### `PURGE_COMPLETED`

**Purge completed**

Permanent deletion of *{objectFqn}* has been completed and verified. Lifecycle case *{caseId}* is closed, and the deletion evidence is recorded in the audit log.

### `RESTORATION_CONFIRMED`

**Restoration confirmed**

*{objectFqn}* has been restored and standard access is available again. The deprecation lifecycle has been closed, and the asset will return to normal activity monitoring.

### Special and operational messages

- `ORPHAN_QUARANTINE_NOTICE`: EDG could not identify an accountable owner. The asset moved directly to quarantine; leadership must establish ownership or authorize disposition.
- `SANDBOX_PURGE_NOTICE_7_DAY`: Seven-day warning to export required sandbox data or document a mandatory retention need.
- `SANDBOX_PURGE_COMPLETED`: Verified sandbox deletion and audit-record confirmation.
- `PURGE_BLOCKED`: No deletion occurred because a hold, dependency, or unresolved approval blocked the purge.
- `LIFECYCLE_SLA_ALERT`: A lifecycle case is past a scheduled milestone and requires EDG operational review.

## Webhook payload contract

Every webhook request includes workflow-safe scalar variables. Eligible notification events are grouped by `messageType` and `primaryRecipient`, producing one automatic Slack delivery per recipient and notification type. Per-asset notification records remain available for auditing; the internal draft state is not an operator step.

```json
{
  "messageType": "STALE_ASSET_NOTICE",
  "primaryRecipient": "owner@example.com",
  "assetCount": 137,
  "assetSummary": "• DATABASE.SCHEMA.OBJECT — 372 days inactive · respond by Aug 15, 2026\n• +136 additional assets — open the application to review",
  "objectFqn": "DATABASE.SCHEMA.OBJECT",
  "platform": "SNOWFLAKE",
  "environment": "PROD",
  "lifecycleState": "DETECTED",
  "caseId": "...",
  "lastActivityDate": "Jul 31, 2025",
  "daysInactive": "372",
  "thresholdDays": "180",
  "contestDeadline": "...",
  "restrictAt": "...",
  "quarantineAt": "...",
  "purgeEligibleDate": "...",
  "edgContact": "#data-management-at-salesforce",
  "exceptionAppUrl": "<https://...|Open form>",
  "applicationUrl": "<https://...|Open record>"
}
```

The URL fields and per-asset links inside `assetSummary` use Slack's labeled-link syntax so messages show compact actions instead of full URLs while retaining the complete destination in the link itself.

Message content is not constructed by Apps Script. Slack delivery remains disabled until `SLACK_NOTIFICATIONS_ENABLED` is true and a secure workflow webhook is configured.

## Single-recipient routing

The resolver chooses the first usable value in the applicable chain:

- Standard owner notices: `RECORD_OWNER` → `TECHNICAL_STEWARD` → `BUSINESS_STEWARD` → `SCHEMA_OWNER` → `DATABASE_OWNER`.
- Owner escalation: `EMP_L6` → `EMP_L5` → configured DPML → DPM team → BDS team → standard owner chain.
- Contestation and restoration confirmations: actor who performed the transition → standard owner chain.
- Orphan notices: configured DPMT → asset DPM team → configured BDST → asset BDS team → configured DPML → configured EDG operations → L6 → L5.
- Sandbox notices: configured sandbox owner → standard owner chain.
- Purge/SLA failures: configured EDG or platform operations recipient → standard owner chain.

Sending fails closed when the applicable chain produces no recipient. Optional Config-sheet keys are `DPMT_RECIPIENT`, `BDST_RECIPIENT`, `DPML_RECIPIENT`, `EDG_OPERATIONS_RECIPIENT`, `PLATFORM_OPERATIONS_RECIPIENT`, `SNOWFLAKE_OPERATIONS_RECIPIENT`, `DATA360_OPERATIONS_RECIPIENT`, and `SANDBOX_OWNER_RECIPIENT`.
