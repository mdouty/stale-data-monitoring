# Slack Message Catalog

This document catalogs all Slack message types sent by the EDG Stale Data Monitoring app, their triggers, recipients, and usage notes.

---

## Message Types (15 total)

| Type | Trigger | Recipient | Frequency | Notes |
|---|---|---|---|---|
| `STALE_ASSET_NOTICE` | Asset transitions to NOTIFIED (import) or ownership changes on NOTIFIED asset (admin resend) | Technical Steward, Schema Owner, or fallback | Once per owner per import; resent if ownership changes | Consolidated per recipient. Contains asset FQN, inactivity threshold, contest deadline. Also used for **owner-change resends** — when ownership changes on an already-NOTIFIED asset, the new owner receives the same notice. |
| `CONTESTATION_REMINDER` | Owner contests and exception window is open | Applicant of the exception | Periodically during contest window | Reminder to complete their exception case. |
| `CONTEST_RESOLUTION_NOTICE` | Contest resolved (exception approved or rejected) | Original asset owner | Once per resolution | Outcome confirmation. |
| `QUARANTINE_NOTICE` | Asset transitioned to QUARANTINED (contest window elapsed) | Technical Steward, Schema Owner, or fallback | Once per quarantine | Contains quarantine duration and restoration instructions. |
| `PURGE_ELIGIBLE_NOTICE` | Asset transitioned to PURGE_ELIGIBLE (quarantine expiry reached) | Technical Steward, Schema Owner, or fallback | Once per purge-eligible transition | Final notice before purge; includes deadline and override/restore links. |
| `PURGE_COMPLETION_NOTICE` | Asset purged by platform team | Technical Steward, Schema Owner, or fallback | Once per purge | Confirmation of completion. |
| `RESTORED_NOTICE` | Asset restored from quarantine or purge | Technical Steward, Schema Owner, or fallback | Once per restoration | Confirms access restored and case dismissed. |
| `SELF_PURGE_CONFIRMATION` | Owner requests self-purge | Requesting owner | Once per self-purge request | Confirmation that asset will be purged; no further action needed. |
| `EXEMPT_APPROVAL_NOTICE` | Exception approved and asset marked EXEMPT | Original asset owner | Once per exemption | Confirms asset moved to ACTIVE and removed from stale tracking. |
| `LIFECYCLE_REMINDER` | Admin-triggered bulk reminder campaign | Asset owners | On-demand (admin sweep) | Generic reminder of open cases with contest/quarantine/purge deadlines. |
| `IMPORT_SUMMARY` | Import completes successfully | Configured recipients (admin only in DEV/PRD) | Once per import | Counts of assets added, removed, state changes. |
| `ADMIN_ESCALATION` | Admin escalates a case for partner action | Platform team / stakeholders | On-demand | Handoff notification for out-of-app actions (quarantine, purge, restore). |
| (Internal tracking) | (Build-time tracking) | (N/A) | (N/A) | `NOTIFICATION_DRAFTED`, `NOTIFICATION_FAILED`, `NOTIFICATION_SENT` are lifecycle events logged to `Lifecycle_Events`, not Slack messages. |

---

## Owner-Change Resend Detail

**Feature:** When a Technical Steward or Schema Owner changes on an asset and the asset is already NOTIFIED (a stale-asset notice was sent), the new owner should receive the stale-asset notice.

**Message type:** `STALE_ASSET_NOTICE` (reused, no new type).

**Trigger:** Manual admin action via "Notify new owners" button after an import.

**Detection:** At import time, `SnowflakeAdapter.js:buildOwnershipChangeEvent_` compares previous and current assets. For each NOTIFIED case where the primary recipient changed, an `OWNERSHIP_CHANGED` event is logged to `Lifecycle_Events` with details.

**Collection:** Admin clicks "Notify new owners" → `previewOwnerChangeNotifications` scans events → `sendOwnerChangeNotificationBatch` collects targets and sends.

**Deduplication:** 
- Idempotency key includes recipient: `CASE_ID|TYPE|STATE|OWNER_CHANGE|<newRecipient>`.
- "Informed set" rule: new owner is skipped if they already received the original notice or were already informed by a prior owner-change sweep.

**Consolidation:** One Slack message per new owner, grouping all their assets with changed ownership (same as the import notification campaign).

---

## Consolidation & Grouping

All Slack sends are **consolidated one message per unique owner** across the set of assets being notified. For example:

- Import notifies of 15 stale assets.
- 10 go to owner A, 5 to owner B.
- **Two consolidated messages sent:** one to A (listing 10 assets), one to B (listing 5 assets).
- Owner-change resend: 3 assets changed ownership to owner C. One message sent to C if C has not already received the original notice.

---

## Delivery & Recovery

- **At-most-once delivery:** Each message is recorded in `Slack_Delivery_Receipts` with a durable intent before the webhook is called.
- **Ambiguous response handling:** If a webhook response is unclear (timeout, 5xx), the message is held for admin verification rather than blindly retried.
- **Admin verification:** "Verify uncertain deliveries" flow allows admin to mark a message RECEIVED (skip resend) or NOT_RECEIVED (allow retry).

---

## Configuration & Access Control

- **DEV environment:** `PRIMARY_RECIPIENT_LOCK` restricts Slack sends to a list of test recipients (e.g., `test-owner@domain.com`). Prevents live-data testing from sending to real owners.
- **PRD environment:** `ALLOWED_RECIPIENTS` may further restrict if needed; default is to send to resolved owner.
- **Message type branching:** Some message types have tenant/environment-specific variations (e.g., different wording for internal vs. external stakeholders); these are parameterized in `getSlackMessagePayload_` (`NotificationService.js`).

---

## Testing & Validation

- Manual testing in DEV verifies message formatting and recipient resolution before PRD deploy.
- Regression suite (`tests/`) includes snapshot tests of message payloads per type.
- Slack webhook URL is validated at app startup (`AdminService.js:onInstall`).
