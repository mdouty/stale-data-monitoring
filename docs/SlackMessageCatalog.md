# Slack Message Catalog

This document catalogs all Slack message types sent by the EDG Stale Data Monitoring app, their triggers, recipients, and usage notes.

---

## Message Types (15 total, from `SLACK_MESSAGE_CATALOG` in `NotificationService.js`)

| Type | Label | Audience | Timing | Severity |
|---|---|---|---|---|
| `STALE_ASSET_NOTICE` | Action required: review stale data asset | DPMT accountable owner or BDST validation partner | T+2 after EDG intake approval | ACTION_REQUIRED |
| `CONTESTATION_REMINDER` | Reminder: stale-data review window is closing | DPMT accountable owner or BDST validation partner | T+7 | ACTION_REQUIRED |
| `OWNER_ESCALATION` | Escalation: stale asset has no owner response | DPMT, BDST, and EDG | T+9 contest deadline | ESCALATION |
| `CONTESTATION_RECEIVED` | Contestation received | Requester and EDG | Immediately after contestation | INFORMATIONAL |
| `DEPRECATION_ACCEPTED` | Deprecation accepted | Asset owner and stewards | Immediately after owner acceptance | INFORMATIONAL |
| `RESTRICTION_NOTICE` | Access restricted | Business or technical steward | Legacy compatibility only | WARNING |
| `QUARANTINE_NOTICE` | Asset quarantined | Business or technical steward | After Snowflake confirms RESTRICTED | WARNING |
| `PURGE_NOTICE_30_DAY` | Final 30-day purge notice | Business or technical steward | 30 days before purge eligibility | URGENT |
| `PURGE_COMPLETED` | Purge completed | Business or technical steward and EDG | After completion and next-extract verification | INFORMATIONAL |
| `RESTORATION_CONFIRMED` | Restoration confirmed | Requester, asset owner, and stewards | Immediately after restoration | INFORMATIONAL |
| `ORPHAN_QUARANTINE_NOTICE` | Orphan quarantine handoff initiated | EDG-coordinated outreach | T0 for an asset without DPMT or BDST ownership | ESCALATION |
| `SANDBOX_PURGE_NOTICE_7_DAY` | Sandbox purge notice | Sandbox owner | 7 days before sandbox purge | WARNING |
| `SANDBOX_PURGE_COMPLETED` | Sandbox purge completed | Sandbox owner and EDG | After verified sandbox deletion | INFORMATIONAL |
| `PURGE_BLOCKED` | Purge blocked | EDG and platform operators | When a hold or control prevents purge | ESCALATION |
| `LIFECYCLE_SLA_ALERT` | Lifecycle SLA alert | EDG operations | When a milestone is overdue | ESCALATION |

`STALE_ASSET_NOTICE` is also used, unchanged, for **owner-change resends** and **delegated assignments** (below); neither adds a catalog type. Aliases: `STALE_NOTICE` -> `STALE_ASSET_NOTICE`, `PURGE_NOTICE` -> `PURGE_NOTICE_30_DAY`.

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

## Delegated Assignment Detail

**Feature:** An admin selects NOTIFIED assets, enters a new owner, and the stale-asset notice is sent to that owner on demand.

**Message type:** `STALE_ASSET_NOTICE` (reused).

**Idempotency key:** `CASE_ID|STALE_ASSET_NOTICE|STATE|DELEGATED|<recipient>|<sweepId>` (new sweepId per click, so retries resend).

**DEV safety:** the DEV recipient lock/allowlist is bypassed for delegated groups only.

**Audit:** draft events carry `reason: OWNER_DELEGATION`, `previousRecipient`, `newRecipient`, `delegatedBy`. See DESIGN.md section 9b.

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

---

## Testing & Validation

- Manual testing in DEV verifies message formatting and recipient resolution before PRD deploy.
