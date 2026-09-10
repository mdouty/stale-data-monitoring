const SLACK_MESSAGE_TYPE_ALIASES = Object.freeze({
  STALE_NOTICE: 'STALE_ASSET_NOTICE',
  PURGE_NOTICE: 'PURGE_NOTICE_30_DAY'
});

const SLACK_WORKFLOW_PAYLOAD_FIELDS = Object.freeze([
  'caseId', 'applicationUrl', 'edgContact', 'exceptionAppUrl', 'purgeEligibleDate',
  'daysInactive', 'lastActivityDate', 'platform', 'assetSummary', 'lifecycleState',
  'thresholdDays', 'contestDeadline', 'quarantineAt', 'messageType',
  'primaryRecipient', 'environment', 'objectFqn', 'assetCount', 'restrictAt'
]);

const SLACK_MESSAGE_CATALOG = Object.freeze({
  STALE_ASSET_NOTICE: messageDefinition_('Action required: review stale data asset', 'DPMT accountable owner or BDST validation partner', 'T+2 after EDG intake approval', 'ACTION_REQUIRED'),
  CONTESTATION_REMINDER: messageDefinition_('Reminder: stale-data review window is closing', 'DPMT accountable owner or BDST validation partner', 'T+7, two days before the contest deadline', 'ACTION_REQUIRED'),
  OWNER_ESCALATION: messageDefinition_('Escalation: stale asset has no owner response', 'DPMT, BDST, and EDG', 'At the T+9 contest deadline', 'ESCALATION'),
  CONTESTATION_RECEIVED: messageDefinition_('Contestation received', 'Requester and EDG', 'Immediately after contestation', 'INFORMATIONAL'),
  DEPRECATION_ACCEPTED: messageDefinition_('Deprecation accepted', 'Asset owner and stewards', 'Immediately after owner acceptance', 'INFORMATIONAL'),
  RESTRICTION_NOTICE: messageDefinition_('Access restricted', 'Business or technical steward', 'Legacy compatibility only', 'WARNING'),
  QUARANTINE_NOTICE: messageDefinition_('Asset quarantined', 'Business or technical steward', 'After Snowflake confirms data status RESTRICTED', 'WARNING'),
  PURGE_NOTICE_30_DAY: messageDefinition_('Final 30-day purge notice', 'Business or technical steward', '30 days before purge eligibility', 'URGENT'),
  PURGE_COMPLETED: messageDefinition_('Purge completed', 'Business or technical steward and EDG', 'After Snowflake completion and next-extract absence verification', 'INFORMATIONAL'),
  RESTORATION_CONFIRMED: messageDefinition_('Restoration confirmed', 'Requester, asset owner, and stewards', 'Immediately after restoration', 'INFORMATIONAL'),
  ORPHAN_QUARANTINE_NOTICE: messageDefinition_('Orphan quarantine handoff initiated', 'EDG-coordinated outreach', 'T0 for an asset without DPMT or BDST ownership', 'ESCALATION'),
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
  const notificationIdsByRecipient = {};
  const drafted = createNotificationDraftBatch_(ids, type);
  const errors = drafted.errors;
  drafted.records.forEach(function (record) {
    const status = cleanText_(record.STATUS).toUpperCase();
    const recipient = cleanText_(record.RECIPIENTS).toLowerCase();
    if (['DRAFT', 'FAILED'].indexOf(status) !== -1 && recipient) {
      if (!representatives[recipient]) representatives[recipient] = record.NOTIFICATION_ID;
      if (!notificationIdsByRecipient[recipient]) notificationIdsByRecipient[recipient] = [];
      notificationIdsByRecipient[recipient].push(record.NOTIFICATION_ID);
    }
  });
  const recipientGroups = Object.keys(representatives);
  if (!recipientGroups.length) return { assetCount: 0, groupCount: 0, failedAssetCount: errors.length, messageType: type, batches: [], errors: errors };

  function deliverGroups() {
    const batches = [];
    recipientGroups.forEach(function (recipient) {
      try {
        batches.push(sendNotificationBatchInternal_(
          representatives[recipient], profile, null, notificationIdsByRecipient[recipient]
        ));
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

function createNotificationDraftBatch_(assetIds, messageType) {
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', ids), 'ASSET_ID');
  const cases = {};
  readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', ids).forEach(function (caseRecord) {
    if (assets[caseRecord.ASSET_ID]) cases[caseRecord.ASSET_ID] = caseRecord;
  });
  const eventsByAsset = {};
  if (['CONTESTATION_RECEIVED', 'RESTORATION_CONFIRMED'].indexOf(messageType) !== -1) {
    readObjects_(APP.sheets.events).forEach(function (event) {
      if (!assets[event.ASSET_ID]) return;
      if (!eventsByAsset[event.ASSET_ID]) eventsByAsset[event.ASSET_ID] = [];
      eventsByAsset[event.ASSET_ID].unshift(event);
    });
  }
  const existingByKey = {};
  const existingByCaseType = {};
  const caseIds = Object.keys(cases).map(function (assetId) {
    return cleanText_(cases[assetId].CASE_ID);
  }).filter(Boolean);
  readObjectsByKeys_(APP.sheets.notifications, 'CASE_ID', caseIds).forEach(function (record) {
    existingByKey[cleanText_(record.IDEMPOTENCY_KEY)] = record;
    let existingType = '';
    try { existingType = normalizeSlackMessageType_(record.TYPE); } catch (error) { return; }
    const caseTypeKey = cleanText_(record.CASE_ID) + '|' + existingType;
    const current = existingByCaseType[caseTypeKey];
    if (!current || cleanText_(record.STATUS).toUpperCase() === 'SENT') existingByCaseType[caseTypeKey] = record;
  });
  const records = [];
  const additions = [];
  const updates = [];
  const events = [];
  const errors = [];
  ids.forEach(function (assetId) {
    try {
      const asset = assets[assetId];
      const caseRecord = cases[assetId];
      if (!asset || !caseRecord) throw new Error('The asset or lifecycle case no longer exists.');
      validateNotificationState_(messageType, caseRecord.STATE);
      const detail = {
        asset: asset,
        caseRecord: caseRecord,
        events: eventsByAsset[assetId] || [],
        exceptionUrl: buildExceptionUrl_(assetId, caseRecord.CASE_ID)
      };
      const routing = resolvePrimaryRecipient_(detail, messageType);
      if (!routing.primaryRecipient) {
        throw new Error('No primary recipient could be resolved for ' + messageType + '. Add an owner or configure the applicable routing recipient.');
      }
      const idempotencyKey = [caseRecord.CASE_ID, messageType, caseRecord.STATE].join('|');
      let record = existingByKey[idempotencyKey] || existingByCaseType[cleanText_(caseRecord.CASE_ID) + '|' + messageType];
      if (!record) {
        record = {
          NOTIFICATION_ID: uuid_(),
          IDEMPOTENCY_KEY: idempotencyKey,
          CASE_ID: caseRecord.CASE_ID,
          ASSET_ID: asset.ASSET_ID,
          TYPE: messageType,
          CHANNEL: 'SLACK_WORKFLOW_WEBHOOK',
          RECIPIENTS: routing.primaryRecipient,
          STATUS: 'DRAFT',
          BATCH_ID: '',
          BATCH_SIZE: '',
          SENT_AT: '',
          RESPONSE_CODE: '',
          MESSAGE_PREVIEW: buildNotificationPreview_(buildSlackMessage_(detail, messageType)),
          ERROR: ''
        };
        existingByKey[idempotencyKey] = record;
        existingByCaseType[cleanText_(caseRecord.CASE_ID) + '|' + messageType] = record;
        additions.push(record);
        events.push(notificationEventRow_(record, 'NOTIFICATION_DRAFTED', caseRecord.STATE, caseRecord.STATE, '', {
          notificationId: record.NOTIFICATION_ID,
          messageType: messageType,
          primaryRecipient: routing.primaryRecipient,
          primaryRecipientSource: routing.primaryRecipientSource
        }));
      } else if (['DRAFT', 'FAILED'].indexOf(cleanText_(record.STATUS).toUpperCase()) !== -1) {
        const needsRefresh = cleanText_(record.STATUS).toUpperCase() === 'FAILED' ||
          cleanText_(record.TYPE) !== messageType ||
          cleanText_(record.CHANNEL) !== 'SLACK_WORKFLOW_WEBHOOK' ||
          cleanText_(record.RECIPIENTS).toLowerCase() !== cleanText_(routing.primaryRecipient).toLowerCase();
        if (needsRefresh) {
          record.TYPE = messageType;
          record.CHANNEL = 'SLACK_WORKFLOW_WEBHOOK';
          record.RECIPIENTS = routing.primaryRecipient;
          record.STATUS = 'DRAFT';
          record.BATCH_ID = '';
          record.BATCH_SIZE = '';
          record.SENT_AT = '';
          record.RESPONSE_CODE = '';
          record.MESSAGE_PREVIEW = buildNotificationPreview_(buildSlackMessage_(detail, messageType));
          record.ERROR = '';
          updates.push(record);
          events.push(notificationEventRow_(record, 'NOTIFICATION_DRAFT_REFRESHED', caseRecord.STATE, caseRecord.STATE, '', {
            notificationId: record.NOTIFICATION_ID,
            messageType: messageType,
            primaryRecipient: routing.primaryRecipient,
            primaryRecipientSource: routing.primaryRecipientSource
          }));
        }
      }
      records.push(record);
    } catch (error) {
      errors.push({ assetId: assetId, error: String(error.message || error).substring(0, 500) });
    }
  });
  if (additions.length) {
    const sheet = getSheet_(APP.sheets.notifications);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(cleanText_);
    appendObjectRows_(APP.sheets.notifications, headers, additions);
  }
  if (updates.length) updateObjectsByKey_(APP.sheets.notifications, 'NOTIFICATION_ID', updates);
  if (events.length) appendRawRows_(APP.sheets.events, events);
  return { records: records, errors: errors };
}

function sendPreparedNotificationOwnerGroup_(records, messageType, recipient) {
  const profile = assertEnvironmentWritable_();
  if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
    throw new Error('Slack notifications are disabled in Config. The drafts were retained.');
  }
  const url = PropertiesService.getScriptProperties().getProperty(APP.slackWorkflowProperty);
  if (!url) throw new Error('No Slack workflow webhook is configured in secure Script Properties.');
  const type = normalizeSlackMessageType_(messageType);
  const target = cleanText_(recipient).toLowerCase();
  if (!target || !isSlackEmail_(target)) throw new Error('The consolidated owner group has no valid primary recipient.');
  const selected = (records || []).filter(function (record) {
    return cleanText_(record.RECIPIENTS).toLowerCase() === target &&
      normalizeSlackMessageType_(record.TYPE) === type &&
      ['DRAFT', 'FAILED'].indexOf(cleanText_(record.STATUS).toUpperCase()) !== -1;
  });
  if (!selected.length) throw new Error('No eligible drafts remain for the consolidated owner group.');
  const sampleItems = prepareNotificationBatchItems_(selected.slice(0, 10), type);
  if (!sampleItems.length) throw new Error('No eligible assets remain for the consolidated owner message.');
  const payload = normalizeSlackWorkflowPayload_(buildSlackBatchMessage_(sampleItems, type, target, selected.length));
  if (profile.recipientLock && cleanText_(payload.primaryRecipient).toLowerCase() !== profile.recipientLock) {
    throw new Error('DEV recipient safety lock blocked this notification. Expected ' + profile.recipientLock + '.');
  }
  if (profile.key === 'DEV' && profile.recipientAllowlist.length && profile.recipientAllowlist.indexOf(target) === -1) {
    throw new Error('DEV recipient allowlist blocked this notification. Allowed recipients: ' + profile.recipientAllowlist.join(', ') + '.');
  }
  const batchId = uuid_();
  const response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error('Slack webhook returned HTTP ' + responseCode + ': ' + response.getContentText().substring(0, 500));
  }
  return {
    batchId: batchId,
    sentAt: nowIso_(),
    responseCode: responseCode,
    recipient: target,
    messageType: type,
    assetCount: selected.length,
    messagePreview: buildNotificationPreview_(payload)
  };
}

function finalizeNotificationOwnerGroupChunk_(records, receipt) {
  const delivery = receipt || {};
  const messageType = normalizeSlackMessageType_(delivery.messageType);
  const items = prepareNotificationBatchItems_(records || [], messageType);
  if (!items.length) return 0;
  const actor = getCurrentUserEmail_() || 'SYSTEM';
  const sentRecords = [];
  const sentEvents = [];
  items.forEach(function (item) {
    const record = item.record;
    record.TYPE = messageType;
    record.RECIPIENTS = delivery.recipient;
    record.STATUS = 'SENT';
    record.BATCH_ID = delivery.batchId;
    record.BATCH_SIZE = delivery.assetCount;
    record.SENT_AT = delivery.sentAt;
    record.RESPONSE_CODE = delivery.responseCode;
    record.MESSAGE_PREVIEW = delivery.messagePreview;
    record.ERROR = '';
    sentRecords.push(record);
    sentEvents.push(notificationEventRow_(record, 'NOTIFICATION_BATCH_SENT', item.detail.caseRecord.STATE, item.detail.caseRecord.STATE, actor, {
      notificationId: record.NOTIFICATION_ID, batchId: delivery.batchId, batchSize: delivery.assetCount,
      messageType: messageType, primaryRecipient: delivery.recipient, responseCode: delivery.responseCode
    }));
  });
  updateObjectsByKey_(APP.sheets.notifications, 'NOTIFICATION_ID', sentRecords);
  appendRawRows_(APP.sheets.events, sentEvents);
  if (messageType === 'STALE_ASSET_NOTICE') markInitialNotificationBatchNotified_(items, delivery.batchId, actor);
  return sentRecords.length;
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

function sendNotificationBatchInternal_(notificationId, profile, actorContext, allowedNotificationIds) {
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
  const allowed = Array.isArray(allowedNotificationIds) ? allowedNotificationIds.reduce(function (index, id) {
    const key = cleanText_(id);
    if (key) index[key] = true;
    return index;
  }, {}) : null;
  let records = readObjects_(APP.sheets.notifications).filter(function (record) {
    const status = cleanText_(record.STATUS).toUpperCase();
    let type = '';
    try { type = normalizeSlackMessageType_(record.TYPE); } catch (error) { return false; }
    return (!allowed || allowed[cleanText_(record.NOTIFICATION_ID)]) &&
      ['DRAFT', 'FAILED'].indexOf(status) !== -1 && type === messageType &&
      cleanText_(record.RECIPIENTS).toLowerCase() === recipient;
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

  const payload = normalizeSlackWorkflowPayload_(buildSlackBatchMessage_(batchItems, messageType, recipient));
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
  const contestDeadline = addDaysIso_(now, configNumber_('CONTEST_WINDOW_DAYS', 9));
  const cases = [];
  const assets = [];
  const events = [];
  items.forEach(function (item) {
    if (canonicalLifecycleState_(item.detail.caseRecord.STATE) !== APP.lifecycle.detected) return;
    const caseRecord = Object.assign({}, item.detail.caseRecord, {
      STATE: APP.lifecycle.notified,
      NOTIFIED_AT: now,
      CONTEST_DEADLINE: contestDeadline,
      LAST_TRANSITION_AT: now,
      NOTES: 'Consolidated Slack stale-data notice sent.'
    });
    const asset = Object.assign({}, item.detail.asset, {
      LIFECYCLE_STATE: APP.lifecycle.notified,
      CONTEST_DEADLINE: contestDeadline,
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
    ORPHAN_QUARANTINE_NOTICE: [APP.lifecycle.accepted, APP.lifecycle.quarantined]
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
    recipientCandidate_('TECHNICAL_STEWARD', asset.TECHNICAL_STEWARD),
    recipientCandidate_('BUSINESS_STEWARD', asset.BUSINESS_STEWARD),
    recipientCandidate_('SNOWFLAKE_TABLE_OWNER', asset.SNOWFLAKE_TABLE_OWNER),
    recipientCandidate_('SCHEMA_OWNER', asset.SCHEMA_OWNER),
    recipientCandidate_('DATABASE_OWNER', asset.DATABASE_OWNER),
    recipientCandidate_('EDG_OPERATIONS_RECIPIENT', config.EDG_OPERATIONS_RECIPIENT)
  ];
  const routeGroups = {
    OWNER_ESCALATION: ownerCandidates,
    CONTESTATION_RECEIVED: [
      recipientCandidate_('CONTESTATION_EVENT_ACTOR', latestEventActorForState_(detail, APP.lifecycle.contested))
    ].concat(ownerCandidates),
    RESTORATION_CONFIRMED: [
      recipientCandidate_('RESTORATION_EVENT_ACTOR', latestEventActorForState_(detail, APP.lifecycle.restored))
    ].concat(ownerCandidates),
    ORPHAN_QUARANTINE_NOTICE: ownerCandidates,
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
  return { source: source, value: firstRecipientEmail_(value, source) };
}

function firstRecipientEmail_(value, source) {
  const groups = cleanText_(value).split(/[;,\n]+/).map(cleanText_).filter(Boolean);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const parts = groups[groupIndex].split(/\s+/);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if (isSlackEmail_(parts[partIndex])) return cleanText_(parts[partIndex]).toLowerCase();
    }
    if (allowsSalesforceUserId_(source) && isSalesforceUserId_(groups[groupIndex])) {
      return groups[groupIndex].toLowerCase() + '@salesforce.com';
    }
  }
  return '';
}

function allowsSalesforceUserId_(source) {
  return ['TECHNICAL_STEWARD', 'BUSINESS_STEWARD', 'SCHEMA_OWNER', 'DATABASE_OWNER']
    .indexOf(cleanText_(source).toUpperCase()) !== -1;
}

function isSalesforceUserId_(value) {
  const identifier = cleanText_(value);
  return /^[a-z][a-z0-9.-]*$/i.test(identifier) &&
    !/^(sysadmin|accountadmin|securityadmin|useradmin|orgadmin|public)$/i.test(identifier);
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

function isSlackChannelId_(value) {
  return /^[CG][A-Z0-9]+$/i.test(cleanText_(value));
}

function expectedPrimarySource_(messageType) {
  if (messageType === 'OWNER_ESCALATION') return 'TECHNICAL_STEWARD';
  if (messageType === 'CONTESTATION_RECEIVED') return 'CONTESTATION_EVENT_ACTOR';
  if (messageType === 'RESTORATION_CONFIRMED') return 'RESTORATION_EVENT_ACTOR';
  if (messageType === 'ORPHAN_QUARANTINE_NOTICE') return 'TECHNICAL_STEWARD';
  if (messageType.indexOf('SANDBOX_') === 0) return 'SANDBOX_OWNER_RECIPIENT';
  if (messageType === 'PURGE_BLOCKED' || messageType === 'LIFECYCLE_SLA_ALERT') return 'EDG_OPERATIONS_RECIPIENT';
  return 'TECHNICAL_STEWARD';
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

function buildSlackBatchMessage_(items, messageType, recipient, totalAssetCount) {
  const first = items[0];
  const payload = buildSlackMessage_(first.detail, messageType, first.record);
  payload.primaryRecipient = recipient;
  const assetCount = Math.max(items.length, Number(totalAssetCount || 0));
  payload.assetCount = assetCount;
  payload.assetSummary = buildSlackAssetSummary_(items, messageType, assetCount);
  const applicationUrl = assetCount === 1
    ? buildApplicationAssetUrl_(items[0].detail.asset.ASSET_ID)
    : buildApplicationQueueUrl_();
  payload.applicationUrl = slackLink_(applicationUrl, assetCount === 1 ? 'Open record' : 'Open dashboard');
  return payload;
}

function normalizeSlackWorkflowPayload_(payload) {
  const source = payload || {};
  return SLACK_WORKFLOW_PAYLOAD_FIELDS.reduce(function (normalized, field) {
    normalized[field] = cleanText_(source[field]);
    return normalized;
  }, {});
}

function buildSlackAssetSummary_(items, messageType, totalAssetCount) {
  const sorted = items.slice().sort(function (left, right) {
    return cleanText_(left.detail.asset.OBJECT_FQN).localeCompare(cleanText_(right.detail.asset.OBJECT_FQN));
  });
  const maxItems = 10;
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
  const assetCount = Math.max(sorted.length, Number(totalAssetCount || 0));
  const remaining = assetCount - included;
  if (assetCount > 10) {
    const applicationLink = slackLink_(buildApplicationQueueUrl_(), 'Open the application');
    lines.push('');
    lines.push('*Note:* This notification contains ' + assetCount + ' assets. ' +
      (applicationLink ? applicationLink + ' to view the full asset list.' : 'Go to the application to view the full asset list.'));
  } else if (remaining > 0) {
    lines.push('• +' + remaining + ' additional asset' + (remaining === 1 ? '' : 's') + ' — open the application to review');
  }
  return lines.join('\n');
}

function slackAssetSummaryLine_(detail, messageType) {
  const asset = detail.asset;
  const caseRecord = detail.caseRecord;
  const objectFqn = truncateSlackText_(cleanText_(asset.OBJECT_FQN) || cleanText_(asset.ASSET_ID), 180);
  const environment = cleanText_(asset.ENVIRONMENT);
  const readInactivityDays = assetReadInactivityDays_(asset);
  const daysInactive = readInactivityDays === null ? '' : cleanText_(readInactivityDays);
  const contestDeadline = formatSlackDate_(caseRecord.CONTEST_DEADLINE);
  const restrictAt = formatSlackDate_(caseRecord.RESTRICT_AT);
  const quarantineAt = formatSlackDate_(caseRecord.QUARANTINE_START_DATE);
  const purgeAt = formatSlackDate_(caseRecord.PURGE_ELIGIBLE_DATE);
  let detailText = '';
  if (messageType === 'STALE_ASSET_NOTICE') {
    detailText = (daysInactive ? daysInactive + ' days since last read or creation' : 'read staleness signal unavailable') + (contestDeadline ? ' · respond by ' + contestDeadline : '');
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
    detailText = 'no accountable DPMT/BDST owner · EDG outreach and quarantine handoff initiated';
  } else if (messageType === 'PURGE_BLOCKED') {
    detailText = 'purge blocked · case ' + cleanText_(caseRecord.CASE_ID);
  } else if (messageType === 'LIFECYCLE_SLA_ALERT') {
    detailText = cleanText_(caseRecord.STATE) + ' · scheduled milestone overdue';
  } else {
    detailText = cleanText_(caseRecord.STATE);
  }
  return '• ' + objectFqn + (environment ? ' [' + environment + ']' : '') + (detailText ? ' — ' + detailText : '');
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
  const edgContact = cleanText_(config.EDG_CONTACT);
  if (!isSlackChannelId_(edgContact)) {
    throw new Error('EDG_CONTACT must be configured as a Slack channel ID such as C065MLQ2HLL.');
  }

  return {
    messageType: messageType,
    primaryRecipient: routing.primaryRecipient,
    objectFqn: cleanText_(asset.OBJECT_FQN),
    platform: cleanText_(asset.PLATFORM),
    environment: cleanText_(asset.ENVIRONMENT),
    lifecycleState: cleanText_(caseRecord.STATE),
    caseId: cleanText_(caseRecord.CASE_ID),
    lastActivityDate: formatSlackDate_(asset.ESTIMATED_LAST_ACTIVITY_DATE),
    daysInactive: assetReadInactivityDays_(asset) === null ? '' : cleanText_(assetReadInactivityDays_(asset)),
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
