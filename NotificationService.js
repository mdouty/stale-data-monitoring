const SLACK_MESSAGE_TYPE_ALIASES = Object.freeze({
  STALE_NOTICE: 'STALE_ASSET_NOTICE',
  PURGE_NOTICE: 'PURGE_NOTICE_30_DAY'
});

const SLACK_MESSAGE_CATALOG = Object.freeze({
  STALE_ASSET_NOTICE: messageDefinition_('Action required: review stale data asset', 'Business or technical steward', 'Immediately after EDG intake approval (T0)', 'ACTION_REQUIRED'),
  CONTESTATION_REMINDER: messageDefinition_('Reminder: stale-data review window is closing', 'Business or technical steward', 'Before the configured response deadline', 'ACTION_REQUIRED'),
  OWNER_ESCALATION: messageDefinition_('Escalation: stale asset has no owner response', 'Owner leadership, DPMT, BDST, and DPML', 'After 7 days without a response', 'ESCALATION'),
  CONTESTATION_RECEIVED: messageDefinition_('Contestation received', 'Requester and EDG', 'Immediately after contestation', 'INFORMATIONAL'),
  DEPRECATION_ACCEPTED: messageDefinition_('Deprecation accepted', 'Asset owner and stewards', 'Immediately after owner acceptance', 'INFORMATIONAL'),
  RESTRICTION_NOTICE: messageDefinition_('Access restricted', 'Business or technical steward', 'Legacy compatibility only', 'WARNING'),
  QUARANTINE_NOTICE: messageDefinition_('Asset quarantined', 'Business or technical steward', 'After Snowflake confirms data status RESTRICTED', 'WARNING'),
  PURGE_NOTICE_30_DAY: messageDefinition_('Final 30-day purge notice', 'Business or technical steward', '30 days before purge eligibility', 'URGENT'),
  PURGE_COMPLETED: messageDefinition_('Purge completed', 'Business or technical steward and EDG', 'After Snowflake completion and next-extract absence verification', 'INFORMATIONAL'),
  RESTORATION_CONFIRMED: messageDefinition_('Restoration confirmed', 'Requester, asset owner, and stewards', 'Immediately after restoration', 'INFORMATIONAL'),
  ORPHAN_QUARANTINE_NOTICE: messageDefinition_('Orphan asset quarantined', 'EDG, DPMT, BDST, and leadership', 'T0 for an ownerless asset', 'ESCALATION'),
  SANDBOX_PURGE_NOTICE_7_DAY: messageDefinition_('Sandbox purge notice', 'Sandbox owner', '7 days before sandbox purge', 'WARNING'),
  SANDBOX_PURGE_COMPLETED: messageDefinition_('Sandbox purge completed', 'Sandbox owner and EDG', 'After verified sandbox deletion', 'INFORMATIONAL'),
  PURGE_BLOCKED: messageDefinition_('Purge blocked', 'EDG and platform operators', 'When a hold or control prevents purge', 'ESCALATION'),
  LIFECYCLE_SLA_ALERT: messageDefinition_('Lifecycle SLA alert', 'EDG operations', 'When a lifecycle milestone is overdue', 'ESCALATION')
});

function messageDefinition_(label, audience, timing, severity) {
  return Object.freeze({ label: label, audience: audience, timing: timing, severity: severity });
}

function getSlackMessageCatalog() {
  return Object.keys(SLACK_MESSAGE_CATALOG).map(function(messageType) {
    return Object.assign({ messageType: messageType }, SLACK_MESSAGE_CATALOG[messageType]);
  });
}

function createNotificationDraft(assetId, notificationType, internalCall) {
  if (!internalCall) assertRole_(['ADMIN', 'OPERATOR']);
  assertEnvironmentWritable_();
  ensureNotificationBatchColumns_();
  const type = normalizeSlackMessageType_(notificationType || 'STALE_ASSET_NOTICE');
  const detail = getAssetDetail(assetId);
  if (!detail.caseRecord) throw new Error('A lifecycle case is required before notification.');

  const routing = resolvePrimaryRecipient_(detail, type);
  if (!routing.primaryRecipient) {
    throw new Error('No primary recipient could be resolved for ' + type + '. Add an owner or configure the applicable routing recipient.');
  }
  const idempotencyKey = [detail.caseRecord.CASE_ID, type, detail.caseRecord.STATE].join('|');
  const existing = findObjectRow_(APP.sheets.notifications, 'IDEMPOTENCY_KEY', idempotencyKey);
  if (existing) return existing.value;

  const notification = {
    NOTIFICATION_ID: uuid_(),
    IDEMPOTENCY_KEY: idempotencyKey,
    CASE_ID: detail.caseRecord.CASE_ID,
    ASSET_ID: detail.asset.ASSET_ID,
    TYPE: type,
    CHANNEL: 'SLACK_WORKFLOW_WEBHOOK',
    RECIPIENTS: routing.primaryRecipient,
    STATUS: 'DRAFT',
    BATCH_ID: '',
    BATCH_SIZE: '',
    SENT_AT: '',
    RESPONSE_CODE: '',
    MESSAGE_PREVIEW: buildNotificationPreview_(buildSlackMessage_(detail, type)),
    ERROR: ''
  };
  upsertObject_(APP.sheets.notifications, 'NOTIFICATION_ID', notification);
  logEvent_(detail.caseRecord.CASE_ID, detail.asset.ASSET_ID, 'NOTIFICATION_DRAFTED', detail.caseRecord.STATE, detail.caseRecord.STATE, '', {
    notificationId: notification.NOTIFICATION_ID,
    messageType: type,
    primaryRecipient: routing.primaryRecipient,
    primaryRecipientSource: routing.primaryRecipientSource
  });
  return notification;
}

function createNotificationDrafts(input) {
  assertRole_(['ADMIN', 'OPERATOR']);
  assertEnvironmentWritable_();
  const payload = input || {};
  const type = normalizeSlackMessageType_(payload.messageType);
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one asset.');
  if (assetIds.length > 50) throw new Error('Bulk notification drafting is limited to 50 assets at a time.');
  const result = { processed: 0, failed: 0, firstAssetId: '', firstNotificationId: '', errors: [] };
  assetIds.forEach(function (assetId) {
    try {
      const notification = createNotificationDraft(assetId, type);
      result.processed += 1;
      if (!result.firstNotificationId) {
        result.firstAssetId = assetId;
        result.firstNotificationId = notification.NOTIFICATION_ID;
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ assetId: assetId, error: String(error.message || error).substring(0, 500) });
    }
  });
  return result;
}

function createAndSendNotificationGroups_(assetIds, notificationType, skipLock) {
  const profile = assertEnvironmentWritable_();
  const type = normalizeSlackMessageType_(notificationType);
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  if (!ids.length) return { assetCount: 0, groupCount: 0, messageType: type, batches: [] };
  ensureNotificationBatchColumns_();
  const representatives = {};
  const errors = [];
  ids.forEach(function (assetId) {
    try {
      const record = createNotificationDraft(assetId, type, true);
      const status = cleanText_(record.STATUS).toUpperCase();
      const recipient = cleanText_(record.RECIPIENTS).toLowerCase();
      if (['DRAFT', 'FAILED'].indexOf(status) !== -1 && recipient && !representatives[recipient]) representatives[recipient] = record.NOTIFICATION_ID;
    } catch (error) {
      errors.push({ assetId: assetId, error: String(error.message || error).substring(0, 500) });
    }
  });
  const recipientGroups = Object.keys(representatives);
  if (!recipientGroups.length) return { assetCount: 0, groupCount: 0, failedAssetCount: errors.length, messageType: type, batches: [], errors: errors };

  function deliverGroups() {
    const batches = [];
    recipientGroups.forEach(function (recipient) {
      try {
        batches.push(sendNotificationBatchInternal_(representatives[recipient], profile));
      } catch (error) {
        errors.push({ recipient: recipient, error: String(error.message || error).substring(0, 500) });
      }
    });
    return {
      assetCount: batches.reduce(function (total, batch) { return total + Number(batch.BATCH_SIZE || 0); }, 0),
      groupCount: batches.length,
      failedAssetCount: errors.length,
      messageType: type,
      batches: batches.map(function (batch) { return { batchId: batch.BATCH_ID, assetCount: Number(batch.BATCH_SIZE || 0) }; }),
      errors: errors
    };
  }
  if (skipLock) return deliverGroups();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another consolidated Slack delivery is in progress. Try again shortly.');
  try { return deliverGroups(); } finally { lock.releaseLock(); }
}

function sendNotification(notificationId) {
  const actor = assertRole_(['ADMIN', 'OPERATOR']);
  const profile = assertEnvironmentWritable_();
  ensureNotificationBatchColumns_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another consolidated Slack delivery is in progress. Try again shortly.');
  try {
    return sendNotificationBatchInternal_(notificationId, profile, actor);
  } finally {
    lock.releaseLock();
  }
}

function sendNotificationBatchInternal_(notificationId, profile, actorContext) {
  const found = findObjectRow_(APP.sheets.notifications, 'NOTIFICATION_ID', notificationId);
  if (!found) throw new Error('Notification draft not found.');
  const selected = found.value;
  if (actorContext) assertAssetResponseAuthorization_(selected.ASSET_ID);
  if (cleanText_(selected.STATUS).toUpperCase() === 'SENT') return selected;
  if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
    throw new Error('Slack notifications are disabled in Config. The drafts were retained.');
  }
  const url = PropertiesService.getScriptProperties().getProperty(APP.slackWorkflowProperty);
  if (!url) throw new Error('No Slack workflow webhook is configured in secure Script Properties.');

  const messageType = normalizeSlackMessageType_(selected.TYPE);
  const recipient = cleanText_(selected.RECIPIENTS).toLowerCase();
  if (!recipient) throw new Error('The selected draft has no primary recipient.');
  let records = readObjects_(APP.sheets.notifications).filter(function (record) {
    const status = cleanText_(record.STATUS).toUpperCase();
    let type = '';
    try { type = normalizeSlackMessageType_(record.TYPE); } catch (error) { return false; }
    return ['DRAFT', 'FAILED'].indexOf(status) !== -1 && type === messageType && cleanText_(record.RECIPIENTS).toLowerCase() === recipient;
  });
  if (actorContext && actorContext.role !== 'ADMIN') {
    const accessEmails = getUserAccessEmails_(actorContext.email, actorContext.role);
    const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', records.map(function (record) {
      return record.ASSET_ID;
    })), 'ASSET_ID');
    records = records.filter(function (record) {
      return assets[record.ASSET_ID] && canAccessAssetWithEmails_(assets[record.ASSET_ID], accessEmails);
    });
  }
  const batchItems = prepareNotificationBatchItems_(records, messageType);
  if (!batchItems.some(function (item) { return item.record.NOTIFICATION_ID === notificationId; })) {
    throw new Error('The selected notification is no longer eligible for ' + messageType + '.');
  }
  if (!batchItems.length) throw new Error('No eligible notification drafts remain in this consolidated group.');

  const payload = buildSlackBatchMessage_(batchItems, messageType, recipient);
  if (profile.recipientLock && cleanText_(payload.primaryRecipient).toLowerCase() !== profile.recipientLock) {
    throw new Error('DEV recipient safety lock blocked this notification. Expected ' + profile.recipientLock + '.');
  }
  if (profile.key === 'DEV' && profile.recipientAllowlist.length && profile.recipientAllowlist.indexOf(cleanText_(payload.primaryRecipient).toLowerCase()) === -1) {
    throw new Error('DEV recipient allowlist blocked this notification. Allowed recipients: ' + profile.recipientAllowlist.join(', ') + '.');
  }
  const batchId = cleanText_(selected.BATCH_ID) || uuid_();
  let response;
  let responseCode = '';
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      throw new Error('Slack webhook returned HTTP ' + responseCode + ': ' + response.getContentText().substring(0, 500));
    }
  } catch (error) {
    markNotificationBatchFailed_(batchItems, batchId, responseCode, error);
    throw error;
  }

  const sentAt = nowIso_();
  const actor = getCurrentUserEmail_() || 'SYSTEM';
  const sentEvents = [];
  const sentRecords = [];
  batchItems.forEach(function (item) {
    const record = item.record;
    record.TYPE = messageType;
    record.RECIPIENTS = recipient;
    record.STATUS = 'SENT';
    record.BATCH_ID = batchId;
    record.BATCH_SIZE = batchItems.length;
    record.SENT_AT = sentAt;
    record.RESPONSE_CODE = responseCode;
    record.MESSAGE_PREVIEW = buildNotificationPreview_(payload);
    record.ERROR = '';
    sentRecords.push(record);
    sentEvents.push(notificationEventRow_(record, 'NOTIFICATION_BATCH_SENT', item.detail.caseRecord.STATE, item.detail.caseRecord.STATE, actor, {
      notificationId: record.NOTIFICATION_ID, batchId: batchId, batchSize: batchItems.length,
      messageType: messageType, primaryRecipient: recipient, responseCode: responseCode
    }));
  });
  updateObjectsByKey_(APP.sheets.notifications, 'NOTIFICATION_ID', sentRecords);
  appendRawRows_(APP.sheets.events, sentEvents);

  if (messageType === 'STALE_ASSET_NOTICE') {
    try {
      markInitialNotificationBatchNotified_(batchItems, batchId, actor);
    } catch (error) {
      appendRawRows_(APP.sheets.events, batchItems.map(function (item) {
        return notificationEventRow_(item.record, 'NOTIFICATION_POST_SEND_TRANSITION_FAILED', item.detail.caseRecord.STATE, item.detail.caseRecord.STATE, actor, {
          batchId: batchId, error: String(error.message || error).substring(0, 500)
        });
      }));
    }
  }
  return Object.assign({}, selected, { STATUS: 'SENT', BATCH_ID: batchId, BATCH_SIZE: batchItems.length, SENT_AT: sentAt, RESPONSE_CODE: responseCode });
}

function prepareNotificationBatchItems_(records, messageType) {
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', records.map(function (record) { return record.ASSET_ID; })), 'ASSET_ID');
  const cases = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'CASE_ID', records.map(function (record) { return record.CASE_ID; })), 'CASE_ID');
  const items = [];
  const skipped = [];
  records.forEach(function (record) {
    const asset = assets[record.ASSET_ID];
    const caseRecord = cases[record.CASE_ID];
    try {
      if (!asset || !caseRecord) throw new Error('The asset or lifecycle case no longer exists.');
      validateNotificationState_(messageType, caseRecord.STATE);
      items.push({
        record: record,
        detail: { asset: asset, caseRecord: caseRecord, events: [], exceptionUrl: buildExceptionUrl_(asset.ASSET_ID, caseRecord.CASE_ID) }
      });
    } catch (error) {
      record.STATUS = 'SKIPPED';
      record.ERROR = String(error.message || error).substring(0, 500);
      skipped.push(record);
    }
  });
  updateObjectsByKey_(APP.sheets.notifications, 'NOTIFICATION_ID', skipped);
  return items;
}

function markNotificationBatchFailed_(items, batchId, responseCode, error) {
  const message = String(error.message || error).substring(0, 500);
  const actor = getCurrentUserEmail_() || 'SYSTEM';
  const failedRecords = [];
  const failedEvents = [];
  items.forEach(function (item) {
    const record = item.record;
    record.STATUS = 'FAILED';
    record.BATCH_ID = batchId;
    record.BATCH_SIZE = items.length;
    record.RESPONSE_CODE = responseCode;
    record.ERROR = message;
    failedRecords.push(record);
    failedEvents.push(notificationEventRow_(record, 'NOTIFICATION_BATCH_SEND_FAILED', item.detail.caseRecord.STATE, item.detail.caseRecord.STATE, actor, {
      notificationId: record.NOTIFICATION_ID, batchId: batchId, batchSize: items.length,
      messageType: record.TYPE, responseCode: responseCode, error: message
    }));
  });
  updateObjectsByKey_(APP.sheets.notifications, 'NOTIFICATION_ID', failedRecords);
  appendRawRows_(APP.sheets.events, failedEvents);
}

function markInitialNotificationBatchNotified_(items, batchId, actor) {
  const now = nowIso_();
  const cases = [];
  const assets = [];
  const events = [];
  items.forEach(function (item) {
    if (canonicalLifecycleState_(item.detail.caseRecord.STATE) !== APP.lifecycle.detected) return;
    const caseRecord = Object.assign({}, item.detail.caseRecord, {
      STATE: APP.lifecycle.notified,
      NOTIFIED_AT: now,
      LAST_TRANSITION_AT: now,
      NOTES: 'Consolidated Slack stale-data notice sent.'
    });
    const asset = Object.assign({}, item.detail.asset, {
      LIFECYCLE_STATE: APP.lifecycle.notified,
      EXCEPTION_ID: caseRecord.EXCEPTION_ID || '',
      EXCEPTION_STATUS: caseRecord.EXCEPTION_STATUS || ''
    });
    cases.push(caseRecord);
    assets.push(asset);
    events.push(notificationEventRow_(item.record, 'STATE_TRANSITION', APP.lifecycle.detected, APP.lifecycle.notified, actor, {
      batchId: batchId, notes: 'Consolidated Slack stale-data notice sent.'
    }));
  });
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', cases);
  updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', assets);
  appendRawRows_(APP.sheets.events, events);
}

function notificationEventRow_(record, eventType, fromState, toState, actor, details) {
  return [
    uuid_(), record.CASE_ID || '', record.ASSET_ID, eventType, fromState || '', toState || '',
    nowIso_(), actor || 'SYSTEM', '', JSON.stringify(details || {})
  ];
}

function ensureNotificationBatchColumns_() {
  const sheet = getSheet_(APP.sheets.notifications);
  const headers = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  ['BATCH_ID', 'BATCH_SIZE'].forEach(function (header) {
    if (headers.indexOf(header) !== -1) return;
    const column = headers.length + 1;
    ensureSheetCapacity_(sheet, Math.max(1, sheet.getLastRow()), column);
    sheet.getRange(1, column).setValue(header);
    headers.push(header);
  });
}

function normalizeSlackMessageType_(notificationType) {
  const requested = cleanText_(notificationType).toUpperCase();
  const normalized = SLACK_MESSAGE_TYPE_ALIASES[requested] || requested;
  if (!SLACK_MESSAGE_CATALOG[normalized]) {
    throw new Error('Unsupported Slack messageType: ' + notificationType);
  }
  return normalized;
}

function validateNotificationState_(messageType, lifecycleState) {
  const state = canonicalLifecycleState_(lifecycleState);
  const allowedStates = {
    STALE_ASSET_NOTICE: [APP.lifecycle.detected, APP.lifecycle.notified],
    CONTESTATION_REMINDER: [APP.lifecycle.notified],
    OWNER_ESCALATION: [APP.lifecycle.notified],
    CONTESTATION_RECEIVED: [APP.lifecycle.contested],
    DEPRECATION_ACCEPTED: [APP.lifecycle.accepted],
    RESTRICTION_NOTICE: [APP.lifecycle.quarantined],
    QUARANTINE_NOTICE: [APP.lifecycle.quarantined],
    PURGE_NOTICE_30_DAY: [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible],
    PURGE_COMPLETED: [APP.lifecycle.purged],
    RESTORATION_CONFIRMED: [APP.lifecycle.restored],
    ORPHAN_QUARANTINE_NOTICE: [APP.lifecycle.quarantined]
  };
  if (allowedStates[messageType] && allowedStates[messageType].indexOf(state) === -1) {
    throw new Error(messageType + ' cannot be sent while the lifecycle state is ' + state + '.');
  }
}

function resolvePrimaryRecipient_(detail, messageType) {
  const asset = detail.asset || {};
  const config = getConfig_();
  const profile = getEnvironmentProfile_();
  if (profile.key === 'DEV' && profile.recipientLock) {
    return {
      primaryRecipient: profile.recipientLock,
      primaryRecipientSource: 'DEV_PRIMARY_RECIPIENT_LOCK',
      recipientFallbackUsed: false
    };
  }
  const ownerCandidates = [
    recipientCandidate_('BUSINESS_STEWARD', asset.BUSINESS_STEWARD),
    recipientCandidate_('TECHNICAL_STEWARD', asset.TECHNICAL_STEWARD),
    recipientCandidate_('RECORD_OWNER', asset.RECORD_OWNER),
    recipientCandidate_('DPM_TEAM', asset.DPM_TEAM),
    recipientCandidate_('BDS_TEAM', asset.BDS_TEAM),
    recipientCandidate_('EDG_OPERATIONS_RECIPIENT', config.EDG_OPERATIONS_RECIPIENT)
  ];
  const routeGroups = {
    OWNER_ESCALATION: [
      recipientCandidate_('EMP_L6', asset.EMP_L6),
      recipientCandidate_('EMP_L5', asset.EMP_L5),
      recipientCandidate_('DPML_RECIPIENT', config.DPML_RECIPIENT),
      recipientCandidate_('DPM_TEAM', asset.DPM_TEAM),
      recipientCandidate_('BDS_TEAM', asset.BDS_TEAM)
    ].concat(ownerCandidates),
    CONTESTATION_RECEIVED: [
      recipientCandidate_('CONTESTATION_EVENT_ACTOR', latestEventActorForState_(detail, APP.lifecycle.contested))
    ].concat(ownerCandidates),
    RESTORATION_CONFIRMED: [
      recipientCandidate_('RESTORATION_EVENT_ACTOR', latestEventActorForState_(detail, APP.lifecycle.restored))
    ].concat(ownerCandidates),
    ORPHAN_QUARANTINE_NOTICE: [
      recipientCandidate_('DPMT_RECIPIENT', config.DPMT_RECIPIENT),
      recipientCandidate_('DPM_TEAM', asset.DPM_TEAM),
      recipientCandidate_('BDST_RECIPIENT', config.BDST_RECIPIENT),
      recipientCandidate_('BDS_TEAM', asset.BDS_TEAM),
      recipientCandidate_('DPML_RECIPIENT', config.DPML_RECIPIENT),
      recipientCandidate_('EDG_OPERATIONS_RECIPIENT', config.EDG_OPERATIONS_RECIPIENT),
      recipientCandidate_('EMP_L6', asset.EMP_L6),
      recipientCandidate_('EMP_L5', asset.EMP_L5)
    ],
    SANDBOX_PURGE_NOTICE_7_DAY: [
      recipientCandidate_('SANDBOX_OWNER_RECIPIENT', config.SANDBOX_OWNER_RECIPIENT)
    ].concat(ownerCandidates),
    SANDBOX_PURGE_COMPLETED: [
      recipientCandidate_('SANDBOX_OWNER_RECIPIENT', config.SANDBOX_OWNER_RECIPIENT)
    ].concat(ownerCandidates),
    PURGE_BLOCKED: [
      recipientCandidate_('EDG_OPERATIONS_RECIPIENT', config.EDG_OPERATIONS_RECIPIENT),
      recipientCandidate_('PLATFORM_OPERATIONS_RECIPIENT', platformOperationsRecipient_(asset, config))
    ].concat(ownerCandidates),
    LIFECYCLE_SLA_ALERT: [
      recipientCandidate_('EDG_OPERATIONS_RECIPIENT', config.EDG_OPERATIONS_RECIPIENT)
    ].concat(ownerCandidates)
  };
  const selected = firstUsableRecipient_(routeGroups[messageType] || ownerCandidates);
  return {
    primaryRecipient: selected ? selected.value : '',
    primaryRecipientSource: selected ? selected.source : '',
    recipientFallbackUsed: Boolean(selected && selected.source !== expectedPrimarySource_(messageType))
  };
}

function recipientCandidate_(source, value) {
  return { source: source, value: cleanText_(value) };
}

function firstUsableRecipient_(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate && isSlackEmail_(candidate.value)) return candidate;
  }
  return null;
}

function isSlackEmail_(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanText_(value));
}

function expectedPrimarySource_(messageType) {
  if (messageType === 'OWNER_ESCALATION') return 'EMP_L6';
  if (messageType === 'CONTESTATION_RECEIVED') return 'CONTESTATION_EVENT_ACTOR';
  if (messageType === 'RESTORATION_CONFIRMED') return 'RESTORATION_EVENT_ACTOR';
  if (messageType === 'ORPHAN_QUARANTINE_NOTICE') return 'DPMT_RECIPIENT';
  if (messageType.indexOf('SANDBOX_') === 0) return 'SANDBOX_OWNER_RECIPIENT';
  if (messageType === 'PURGE_BLOCKED' || messageType === 'LIFECYCLE_SLA_ALERT') return 'EDG_OPERATIONS_RECIPIENT';
  return 'BUSINESS_STEWARD';
}

function latestEventActorForState_(detail, state) {
  const events = detail.events || [];
  for (let i = 0; i < events.length; i += 1) {
    if (cleanText_(events[i].TO_STATE).toUpperCase() === cleanText_(state).toUpperCase()) {
      const actor = cleanText_(events[i].ACTOR);
      if (actor && actor.toUpperCase() !== 'SYSTEM') return actor;
    }
  }
  return '';
}

function platformOperationsRecipient_(asset, config) {
  const platform = cleanText_(asset.PLATFORM).toUpperCase();
  if (platform === 'SNOWFLAKE') return cleanText_(config.SNOWFLAKE_OPERATIONS_RECIPIENT || config.PLATFORM_OPERATIONS_RECIPIENT);
  if (platform === 'DATA360' || platform === 'DATA 360') return cleanText_(config.DATA360_OPERATIONS_RECIPIENT || config.PLATFORM_OPERATIONS_RECIPIENT);
  return cleanText_(config.PLATFORM_OPERATIONS_RECIPIENT);
}

function buildNotificationPreview_(payload) {
  const scope = payload.assetCount ? payload.assetCount + ' assets' : payload.objectFqn;
  return [payload.messageType, scope, payload.primaryRecipient].filter(Boolean).join(' | ').substring(0, 500);
}

function buildSlackBatchMessage_(items, messageType, recipient) {
  const first = items[0];
  const payload = buildSlackMessage_(first.detail, messageType, first.record);
  payload.primaryRecipient = recipient;
  payload.assetCount = items.length;
  payload.assetSummary = buildSlackAssetSummary_(items, messageType);
  const applicationUrl = items.length === 1
    ? buildApplicationAssetUrl_(items[0].detail.asset.ASSET_ID)
    : buildApplicationQueueUrl_();
  payload.applicationUrl = slackLink_(applicationUrl, items.length === 1 ? 'Open record' : 'Open dashboard');
  return payload;
}

function buildSlackAssetSummary_(items, messageType) {
  const sorted = items.slice().sort(function (left, right) {
    return cleanText_(left.detail.asset.OBJECT_FQN).localeCompare(cleanText_(right.detail.asset.OBJECT_FQN));
  });
  const maxItems = 20;
  const maxCharacters = 2800;
  const lines = [];
  let included = 0;
  for (let index = 0; index < sorted.length && included < maxItems; index += 1) {
    const line = slackAssetSummaryLine_(sorted[index].detail, messageType);
    const projectedLength = lines.join('\n').length + (lines.length ? 1 : 0) + line.length;
    if (projectedLength > maxCharacters) break;
    lines.push(line);
    included += 1;
  }
  const remaining = sorted.length - included;
  if (remaining > 0) lines.push('• +' + remaining + ' additional asset' + (remaining === 1 ? '' : 's') + ' — open the application to review');
  return lines.join('\n');
}

function slackAssetSummaryLine_(detail, messageType) {
  const asset = detail.asset;
  const caseRecord = detail.caseRecord;
  const objectFqn = truncateSlackText_(cleanText_(asset.OBJECT_FQN) || cleanText_(asset.ASSET_ID), 180);
  const environment = cleanText_(asset.ENVIRONMENT);
  const daysInactive = cleanText_(asset.DAYS_SINCE_ANY_ACTIVITY);
  const contestDeadline = formatSlackDate_(caseRecord.CONTEST_DEADLINE);
  const restrictAt = formatSlackDate_(caseRecord.RESTRICT_AT);
  const quarantineAt = formatSlackDate_(caseRecord.QUARANTINE_START_DATE);
  const purgeAt = formatSlackDate_(caseRecord.PURGE_ELIGIBLE_DATE);
  let detailText = '';
  if (messageType === 'STALE_ASSET_NOTICE') {
    detailText = (daysInactive ? daysInactive + ' days inactive' : 'activity signal unavailable') + (contestDeadline ? ' · respond by ' + contestDeadline : '');
  } else if (messageType === 'CONTESTATION_REMINDER' || messageType === 'OWNER_ESCALATION') {
    detailText = (contestDeadline ? 'review by ' + contestDeadline : 'owner response overdue') + (restrictAt ? ' · restriction ' + restrictAt : '');
  } else if (messageType === 'CONTESTATION_RECEIVED') {
    detailText = 'contestation received · lifecycle paused';
  } else if (messageType === 'DEPRECATION_ACCEPTED') {
    detailText = 'deprecation confirmed · queued for Snowflake quarantine';
  } else if (messageType === 'RESTRICTION_NOTICE') {
    detailText = 'access restricted' + (quarantineAt ? ' · quarantine ' + quarantineAt : '');
  } else if (messageType === 'QUARANTINE_NOTICE') {
    detailText = 'Snowflake data status RESTRICTED confirmed · quarantine started' + (purgeAt ? ' · purge eligible ' + purgeAt : '');
  } else if (messageType === 'PURGE_NOTICE_30_DAY' || messageType === 'SANDBOX_PURGE_NOTICE_7_DAY') {
    detailText = purgeAt ? 'scheduled purge ' + purgeAt : 'purge date pending';
  } else if (messageType === 'PURGE_COMPLETED' || messageType === 'SANDBOX_PURGE_COMPLETED') {
    detailText = 'permanent deletion verified';
  } else if (messageType === 'RESTORATION_CONFIRMED') {
    detailText = 'standard access restored';
  } else if (messageType === 'ORPHAN_QUARANTINE_NOTICE') {
    detailText = 'no accountable owner · quarantined';
  } else if (messageType === 'PURGE_BLOCKED') {
    detailText = 'purge blocked · case ' + cleanText_(caseRecord.CASE_ID);
  } else if (messageType === 'LIFECYCLE_SLA_ALERT') {
    detailText = cleanText_(caseRecord.STATE) + ' · scheduled milestone overdue';
  } else {
    detailText = cleanText_(caseRecord.STATE);
  }
  const assetUrl = buildApplicationAssetUrl_(asset.ASSET_ID);
  return '• ' + objectFqn + (environment ? ' [' + environment + ']' : '') + (detailText ? ' — ' + detailText : '') + (assetUrl ? '\n  ' + slackLink_(assetUrl, 'View asset') : '');
}

function slackLink_(url, label) {
  const destination = cleanText_(url);
  if (!destination) return '';
  const linkLabel = cleanText_(label).replace(/[|<>]/g, '') || 'Open link';
  return '<' + destination.replace(/>/g, '%3E') + '|' + linkLabel + '>';
}

function truncateSlackText_(value, limit) {
  const text = cleanText_(value);
  const maximum = Number(limit || 0);
  return maximum > 1 && text.length > maximum ? text.substring(0, maximum - 1) + '…' : text;
}

function buildApplicationQueueUrl_() {
  const config = getConfig_();
  const baseUrl = cleanText_(config.APPLICATION_URL || config.WEB_APP_URL);
  if (!baseUrl) return '';
  const separator = baseUrl.indexOf('?') === -1 ? '?' : '&';
  return baseUrl + separator + 'app_env=' + encodeURIComponent(getEnvironmentProfile_().key);
}

function buildApplicationAssetUrl_(assetId) {
  const queueUrl = buildApplicationQueueUrl_();
  if (!queueUrl || !cleanText_(assetId)) return queueUrl;
  return queueUrl + '&asset_id=' + encodeURIComponent(cleanText_(assetId));
}

function buildSlackMessage_(detail, notificationType, notificationRecord) {
  const messageType = normalizeSlackMessageType_(notificationType);
  const asset = detail.asset;
  const caseRecord = detail.caseRecord;
  const routing = resolvePrimaryRecipient_(detail, messageType);
  const config = getConfig_();
  const actionUrl = cleanText_(detail.exceptionUrl) || cleanText_(config.EXCEPTION_APP_URL) || cleanText_(config.APPLICATION_URL);
  const applicationUrl = buildApplicationAssetUrl_(asset.ASSET_ID);
  const edgContact = cleanText_(config.EDG_CONTACT) || '#data-management-at-salesforce';

  return {
    messageType: messageType,
    primaryRecipient: routing.primaryRecipient,
    objectFqn: cleanText_(asset.OBJECT_FQN),
    platform: cleanText_(asset.PLATFORM),
    environment: cleanText_(asset.ENVIRONMENT),
    lifecycleState: cleanText_(caseRecord.STATE),
    caseId: cleanText_(caseRecord.CASE_ID),
    lastActivityDate: formatSlackDate_(asset.ESTIMATED_LAST_ACTIVITY_DATE),
    daysInactive: cleanText_(asset.DAYS_SINCE_ANY_ACTIVITY),
    thresholdDays: cleanText_(asset.STALE_THRESHOLD_DAYS),
    contestDeadline: formatSlackDate_(caseRecord.CONTEST_DEADLINE),
    restrictAt: formatSlackDate_(caseRecord.RESTRICT_AT),
    quarantineAt: formatSlackDate_(caseRecord.QUARANTINE_START_DATE),
    purgeEligibleDate: formatSlackDate_(caseRecord.PURGE_ELIGIBLE_DATE),
    edgContact: edgContact,
    exceptionAppUrl: slackLink_(actionUrl, 'Open form'),
    applicationUrl: slackLink_(applicationUrl, 'Open record')
  };
}

function formatSlackDate_(value) {
  const text = cleanText_(value);
  if (!text) return '';
  const date = new Date(text);
  if (isNaN(date.getTime())) return text;
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'America/Los_Angeles', 'MMM d, yyyy');
}
