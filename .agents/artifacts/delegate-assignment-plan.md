# Delegate Assignment Feature — Plan

## Overview
Admin manually selects one or more NOTIFIED assets and assigns them to a new owner, triggering an immediate stale-asset notice to that owner.

## Key Differences from Owner-Change
- **Trigger**: Admin manually specifies recipient (not detection-driven)
- **Scope**: Can assign assets without ownership field changing
- **UI**: Asset picker + owner input (email or username)
- **Idempotency**: `CASE_ID|TYPE|STATE|DELEGATED|<newRecipient>|<sweepId>`
- **Audit**: Log ASSIGNMENT_DELEGATION event to Lifecycle_Events

## Parts

### Part 1: Server Functions
- `collectDelegatableAssets_(limit)`: Returns NOTIFIED assets eligible for delegation
- `previewDelegateAssignment(assetIds, newOwner)`: Validates owner, shows preview
- `sendDelegateNotifications(input)`: `{assetIds, newOwner, sweepId}` → sends notices

### Part 2: UI
- New button "Delegate to new owner"
- Modal/form with:
  - Asset picker (searchable, multi-select)
  - Owner input (email/username with autocomplete)
  - Preview before send
- Progress loop like reminder sweep

### Part 3: Documentation & Tests
- Update DESIGN.md
- Update SlackMessageCatalog.md
- Add tests for delegation flow

## Key Design Questions
1. Should this bypass the PRIMARY_RECIPIENT_LOCK in DEV? (Recommend: yes, for testing)
2. Should delegated assignments update the asset owner fields? (Recommend: no, log event only)
3. Idempotency: should retry with same recipient skip or update? (Recommend: skip)
