function queuePlatformAction(assetId, actionName) {
  const actor = assertRole_(['ADMIN', 'OPERATOR']);
  return queuePlatformActionInternal_(assetId, actionName, actor);
}

function queuePlatformActionInternal_(assetId, actionName, actorContext, forceNewRequest) {
  assertEnvironmentWritable_();
  const detail = getAssetDetail(assetId);
  if (!detail.caseRecord) throw new Error('A lifecycle case is required before a platform action.');
  let action = cleanText_(actionName).toUpperCase();
  if (action === 'RESTRICT') action = 'QUARANTINE';
  const allowed = ['QUARANTINE', 'RESTORE', 'PURGE'];
  if (allowed.indexOf(action) === -1) throw new Error('Unsupported platform action: ' + action);
  const currentState = canonicalLifecycleState_(detail.caseRecord.STATE);
  const requiredStates = {
    QUARANTINE: [APP.lifecycle.accepted],
    RESTORE: [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible, APP.lifecycle.selfPurgePending],
    PURGE: [APP.lifecycle.purgeEligible]
  };
  if (requiredStates[action].indexOf(currentState) === -1) {
    throw new Error(action + ' cannot be requested while the case is ' + currentState + '.');
  }
  if (action === 'PURGE') {
    if (!detail.caseRecord.PURGE_ELIGIBLE_DATE || new Date(detail.caseRecord.PURGE_ELIGIBLE_DATE) > new Date()) {
      throw new Error('Purge cannot be queued before the 181-day quarantine period is complete.');
    }
  }
  const baseIdempotencyKey = [detail.caseRecord.CASE_ID, action].join('|');
  const existing = findObjectRow_(APP.sheets.platformActions, 'IDEMPOTENCY_KEY', baseIdempotencyKey);
  if (existing && cleanText_(existing.value.STATUS).toUpperCase() !== 'CANCELLED' && !forceNewRequest) return existing.value;
  const idempotencyKey = existing ? baseIdempotencyKey + '|RETRY|' + uuid_() : baseIdempotencyKey;
  const requestedAt = nowIso_();
  const request = {
    action_id: uuid_(),
    idempotency_key: idempotencyKey,
    platform: detail.asset.PLATFORM,
    action: action,
    asset_id: assetId,
    object_fqn: detail.asset.OBJECT_FQN,
    case_id: detail.caseRecord.CASE_ID,
    requested_at: requestedAt,
    policy_rule: detail.asset.POLICY_RULE,
    desired_tag: action === 'QUARANTINE' ? 'RESTRICTED' : '',
    verify_object_absence_on_next_snapshot: action === 'PURGE'
  };
  const record = {
    ACTION_ID: request.action_id,
    IDEMPOTENCY_KEY: idempotencyKey,
    CASE_ID: detail.caseRecord.CASE_ID,
    ASSET_ID: assetId,
    PLATFORM: detail.asset.PLATFORM,
    ACTION: action,
    STATUS: 'READY',
    REQUESTED_AT: requestedAt,
    ACCEPTED_AT: '',
    COMPLETED_AT: '',
    PARTNER_REFERENCE: '',
    REQUEST_JSON: JSON.stringify(request),
    RESPONSE_JSON: '',
    ERROR: ''
  };
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  logEvent_(detail.caseRecord.CASE_ID, assetId, 'PLATFORM_ACTION_READY', currentState, currentState, '', {
    actionId: record.ACTION_ID, action: action, desiredTag: request.desired_tag
  });
  return record;
}

function queuePurgeAction(input) {
  const actor = assertAdmin_();
  const payload = input || {};
  const checks = payload.checks || {};
  const requiredChecks = ['noLegalHold', 'noRegulatoryRetention', 'noPendingRestoration', 'edgSignoff'];
  const missing = requiredChecks.filter(function (key) { return checks[key] !== true; });
  if (missing.length) throw new Error('Complete every pre-purge attestation before preparing the purge handoff.');
  const record = queuePlatformActionInternal_(cleanText_(payload.assetId), 'PURGE', actor);
  const request = JSON.parse(record.REQUEST_JSON || '{}');
  request.pre_purge_attestation = {
    no_legal_hold: true,
    no_regulatory_retention: true,
    no_pending_restoration: true,
    edg_signoff: true,
    attested_by: actor.email,
    attested_at: nowIso_()
  };
  record.REQUEST_JSON = JSON.stringify(request);
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  logEvent_(record.CASE_ID, record.ASSET_ID, 'PRE_PURGE_CHECKLIST_ATTESTED', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', request.pre_purge_attestation);
  return record;
}

function prepareEligiblePurgeHandoffs(input) {
  const actor = assertAdmin_();
  assertEnvironmentWritable_();
  const payload = input || {};

  const now = new Date();
  const existingPurgeCases = {};
  readObjects_(APP.sheets.platformActions).forEach(function (action) {
    const actionType = cleanText_(action.ACTION).toUpperCase();
    const actionStatus = cleanText_(action.STATUS).toUpperCase();
    if ((actionType === 'PURGE' && actionStatus !== 'CANCELLED') || (actionType === 'RESTORE' && actionStatus !== 'CANCELLED')) existingPurgeCases[action.CASE_ID] = true;
  });
  const eligibleCases = readObjects_(APP.sheets.cases).filter(function (caseRecord) {
    return canonicalLifecycleState_(caseRecord.STATE) === APP.lifecycle.purgeEligible &&
      caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= now &&
      !existingPurgeCases[caseRecord.CASE_ID];
  });
  const includedIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  const restoredIds = Array.from(new Set((payload.restoredAssetIds || []).map(cleanText_).filter(Boolean)));
  const heldIds = Array.from(new Set((payload.heldAssetIds || []).map(cleanText_).filter(Boolean)));
  const included = {};
  const restored = {};
  const held = {};
  includedIds.forEach(function (assetId) { included[assetId] = true; });
  restoredIds.forEach(function (assetId) { restored[assetId] = true; });
  heldIds.forEach(function (assetId) { held[assetId] = true; });
  const overlap = includedIds.filter(function (assetId) { return restored[assetId] || held[assetId]; })
    .concat(restoredIds.filter(function (assetId) { return held[assetId]; }));
  if (overlap.length) throw new Error('Choose only one purge-review outcome for each asset.');
  const casesToPrepare = includedIds.length || restoredIds.length || heldIds.length
    ? eligibleCases.filter(function (caseRecord) { return included[caseRecord.ASSET_ID]; })
    : eligibleCases;
  const casesToRestore = eligibleCases.filter(function (caseRecord) { return restored[caseRecord.ASSET_ID]; });
  const casesToHold = eligibleCases.filter(function (caseRecord) { return held[caseRecord.ASSET_ID]; });
  if (!casesToPrepare.length && !casesToRestore.length && !casesToHold.length) throw new Error('No currently eligible purge assets were selected.');
  if (casesToPrepare.length) {
    const checks = payload.checks || {};
    const requiredChecks = ['noLegalHold', 'noRegulatoryRetention', 'noPendingRestoration', 'edgSignoff'];
    const missing = requiredChecks.filter(function (key) { return checks[key] !== true; });
    if (missing.length) throw new Error('Complete every pre-purge attestation before preparing the purge handoffs.');
  }

  casesToPrepare.forEach(function (caseRecord) {
    const record = queuePlatformActionInternal_(caseRecord.ASSET_ID, 'PURGE', actor);
    const request = JSON.parse(record.REQUEST_JSON || '{}');
    request.pre_purge_attestation = {
      no_legal_hold: true,
      no_regulatory_retention: true,
      no_pending_restoration: true,
      edg_signoff: true,
      attested_by: actor.email,
      attested_at: nowIso_()
    };
    record.REQUEST_JSON = JSON.stringify(request);
    upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
    logEvent_(record.CASE_ID, record.ASSET_ID, 'PRE_PURGE_CHECKLIST_ATTESTED', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', request.pre_purge_attestation);
  });
  casesToRestore.forEach(function (caseRecord) {
    const record = queuePlatformActionInternal_(caseRecord.ASSET_ID, 'RESTORE', actor);
    logEvent_(record.CASE_ID, record.ASSET_ID, 'PURGE_REVIEW_RESTORE_REQUESTED', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', {
      actionId: record.ACTION_ID,
      actor: actor.email
    });
  });
  casesToHold.forEach(function (caseRecord) {
    placePurgeHold_(caseRecord, actor);
  });

  return {
    preparedCount: casesToPrepare.length,
    restoredCount: casesToRestore.length,
    heldCount: casesToHold.length,
    operations: getAdminOperations()
  };
}

function placePurgeHold_(caseRecord, actor) {
  const detail = getAssetDetail(caseRecord.ASSET_ID);
  const heldAt = nowIso_();
  const idempotencyKey = [caseRecord.CASE_ID, 'PURGE'].join('|');
  const request = {
    action_id: uuid_(),
    idempotency_key: idempotencyKey,
    platform: detail.asset.PLATFORM,
    action: 'PURGE',
    asset_id: caseRecord.ASSET_ID,
    object_fqn: detail.asset.OBJECT_FQN,
    case_id: caseRecord.CASE_ID,
    requested_at: heldAt,
    purge_hold: true,
    held_by: actor.email,
    held_at: heldAt
  };
  const record = {
    ACTION_ID: request.action_id,
    IDEMPOTENCY_KEY: idempotencyKey,
    CASE_ID: caseRecord.CASE_ID,
    ASSET_ID: caseRecord.ASSET_ID,
    PLATFORM: detail.asset.PLATFORM,
    ACTION: 'PURGE',
    STATUS: 'ON_HOLD',
    REQUESTED_AT: heldAt,
    ACCEPTED_AT: '',
    COMPLETED_AT: '',
    PARTNER_REFERENCE: actor.email,
    REQUEST_JSON: JSON.stringify(request),
    RESPONSE_JSON: '',
    ERROR: 'Purge placed on hold during admin pre-purge review.'
  };
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  logEvent_(caseRecord.CASE_ID, caseRecord.ASSET_ID, 'PURGE_HANDOFF_PLACED_ON_HOLD', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', {
    actionId: record.ACTION_ID,
    actor: actor.email,
    heldAt: heldAt
  });
  return record;
}

function releasePurgeHold(actionId) {
  const actor = assertAdmin_();
  assertEnvironmentWritable_();
  const found = findObjectRow_(APP.sheets.platformActions, 'ACTION_ID', cleanText_(actionId));
  if (!found) throw new Error('Purge hold not found.');
  const record = found.value;
  if (cleanText_(record.ACTION).toUpperCase() !== 'PURGE' || cleanText_(record.STATUS).toUpperCase() !== 'ON_HOLD') {
    throw new Error('This action is not an active purge hold.');
  }
  record.STATUS = 'CANCELLED';
  record.IDEMPOTENCY_KEY = record.IDEMPOTENCY_KEY + '|HOLD_RELEASED|' + nowIso_();
  record.PARTNER_REFERENCE = 'HOLD_RELEASED_BY:' + actor.email;
  record.ERROR = 'Purge hold released; asset returned to pre-purge review.';
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  logEvent_(record.CASE_ID, record.ASSET_ID, 'PURGE_HANDOFF_HOLD_RELEASED', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', {
    actionId: record.ACTION_ID,
    actor: actor.email
  });
  return getAdminOperations();
}

function cancelRestorationHandoff(actionId) {
  const actor = assertAdmin_();
  assertEnvironmentWritable_();
  const found = findObjectRow_(APP.sheets.platformActions, 'ACTION_ID', cleanText_(actionId));
  if (!found) throw new Error('Restoration handoff not found.');
  const record = found.value;
  if (cleanText_(record.ACTION).toUpperCase() !== 'RESTORE') throw new Error('This action is not a restoration handoff.');
  if (cleanText_(record.STATUS).toUpperCase() !== 'READY') {
    throw new Error('Only a READY restoration handoff can be cancelled. Exported or completed requests require platform-team coordination.');
  }
  const cancelledAt = nowIso_();
  record.STATUS = 'CANCELLED';
  record.PARTNER_REFERENCE = 'CANCELLED_BY:' + actor.email;
  record.ERROR = 'Restoration handoff cancelled by an administrator before export.';
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  logEvent_(record.CASE_ID, record.ASSET_ID, 'RESTORATION_HANDOFF_CANCELLED', APP.lifecycle.purgeEligible, APP.lifecycle.purgeEligible, '', {
    actionId: record.ACTION_ID,
    actor: actor.email,
    cancelledAt: cancelledAt
  });
  return getAdminOperations();
}

function dispatchPlatformAction(actionId) {
  assertAdmin_();
  assertEnvironmentWritable_();
  const found = findObjectRow_(APP.sheets.platformActions, 'ACTION_ID', actionId);
  if (!found) throw new Error('Platform action not found.');
  const record = found.value;
  if (['READY', 'FAILED'].indexOf(cleanText_(record.STATUS).toUpperCase()) === -1) return record;
  if (!platformHandoffEnabled_(record.PLATFORM)) {
    throw new Error((record.PLATFORM === 'DATA360' ? 'Data 360' : 'Snowflake') + ' handoffs are disabled. The ready request was retained.');
  }
  if (record.ACTION === 'PURGE' && !configBoolean_('PURGE_ACTIONS_ENABLED', false)) {
    throw new Error('Purge dispatch is disabled by the independent PURGE_ACTIONS_ENABLED safety gate. The ready request was retained.');
  }
  const propertyKey = record.PLATFORM === 'DATA360' ? APP.data360ActionEndpointProperty : APP.snowflakeActionEndpointProperty;
  const endpoint = PropertiesService.getScriptProperties().getProperty(propertyKey);
  if (!endpoint || endpoint.indexOf('https://') !== 0) throw new Error('A secure HTTPS partner endpoint is not configured.');
  try {
    const response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      payload: record.REQUEST_JSON,
      headers: { 'Idempotency-Key': record.IDEMPOTENCY_KEY },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    record.RESPONSE_JSON = response.getContentText().substring(0, 2000);
    if (code >= 200 && code < 300) {
      record.STATUS = 'ACCEPTED';
      record.ACCEPTED_AT = nowIso_();
      record.ERROR = '';
    } else {
      record.STATUS = 'FAILED';
      record.ERROR = 'HTTP ' + code;
    }
    upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  } catch (error) {
    record.STATUS = 'FAILED';
    record.ERROR = String(error.message || error).substring(0, 500);
    upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
    throw error;
  }
  return record;
}

function recordPlatformActionResult(input) {
  const actor = assertRole_(['ADMIN', 'OPERATOR']);
  assertEnvironmentWritable_();
  const payload = input || {};
  const found = findObjectRow_(APP.sheets.platformActions, 'ACTION_ID', payload.actionId);
  if (!found) throw new Error('Platform action not found.');
  const record = found.value;
  if (actor.role !== 'ADMIN') assertAssetResponseAuthorization_(record.ASSET_ID);
  record.STATUS = cleanText_(payload.status || 'COMPLETED').toUpperCase();
  record.PARTNER_REFERENCE = cleanText_(payload.partnerReference);
  record.RESPONSE_JSON = JSON.stringify(payload.response || {});
  if (record.STATUS === 'COMPLETED') record.COMPLETED_AT = cleanText_(payload.completedAt) || nowIso_();
  record.ERROR = cleanText_(payload.error);
  upsertObject_(APP.sheets.platformActions, 'ACTION_ID', record);
  if (record.STATUS === 'COMPLETED') applyPlatformOutcome_(record);
  return getAssetDetail(record.ASSET_ID);
}

function applyPlatformOutcome_(actionRecord) {
  const caseFound = findObjectRow_(APP.sheets.cases, 'CASE_ID', actionRecord.CASE_ID);
  if (!caseFound) throw new Error('The lifecycle case for this platform result no longer exists.');
  const caseRecord = caseFound.value;
  const fromState = canonicalLifecycleState_(caseRecord.STATE);
  const completedAt = actionRecord.COMPLETED_AT || nowIso_();
  let messageType = '';
  if (actionRecord.ACTION === 'QUARANTINE') {
    applyQuarantineState_(caseRecord, completedAt, 'Snowflake confirmed data status RESTRICTED; the 181-day quarantine clock has started.');
    messageType = 'QUARANTINE_NOTICE';
  } else if (actionRecord.ACTION === 'RESTORE') {
    caseRecord.STATE = APP.lifecycle.restored;
    caseRecord.NOTES = 'Snowflake confirmed restoration; the asset is restored with its prior lifecycle history retained.';
    messageType = 'RESTORATION_CONFIRMED';
  } else if (actionRecord.ACTION === 'PURGE') {
    caseRecord.NOTES = 'Snowflake reported purge complete; awaiting absence verification in the next complete extract.';
  }
  caseRecord.LAST_TRANSITION_AT = completedAt;
  upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
  if (actionRecord.ACTION === 'RESTORE') {
    const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', caseRecord.ASSET_ID);
    if (assetFound) {
      assetFound.value.SNOWFLAKE_DATA_STATUS = APP.lifecycle.active;
      assetFound.value.EVALUATION_STATUS = 'MANAGED_CASE';
      assetFound.value.IS_STALE_180 = false;
      assetFound.value.SOURCE_ACTIVITY_STATUS = 'PLATFORM_RESTORED_AWAITING_SNAPSHOT';
      assetFound.value.ASSET_STATUS = APP.assetStatus.active;
      upsertObject_(APP.sheets.assetsCurrent, 'ASSET_ID', assetFound.value);
    }
  }
  updateAssetState_(caseRecord.ASSET_ID, caseRecord.STATE, caseRecord);
  logEvent_(caseRecord.CASE_ID, caseRecord.ASSET_ID,
    actionRecord.ACTION === 'PURGE' ? 'PURGE_ACTION_COMPLETED_AWAITING_VERIFICATION' : 'PLATFORM_ACTION_COMPLETED',
    fromState, caseRecord.STATE, '', { actionId: actionRecord.ACTION_ID, action: actionRecord.ACTION, partnerReference: actionRecord.PARTNER_REFERENCE });
  if (messageType) {
    try { createAndSendNotificationGroups_([caseRecord.ASSET_ID], messageType); } catch (error) {}
  }
}

function runLifecycleAutomation(environment, options) {
  // Time-based triggers have no browser-selected environment. Keep no-argument
  // trigger executions in DEV; explicit/manual calls pass their environment.
  const manual = Boolean(options && options.manual);
  if (environment) setExecutionEnvironment_(environment, false);
  else setExecutionEnvironment_('DEV', false);
  const profile = assertEnvironmentWritable_();
  // The scheduled sweep can be paused so notifications are sent only when an admin
  // manually invokes them (Send reminders / Run automation now). Manual calls bypass
  // the pause; the master SLACK_NOTIFICATIONS_ENABLED gate still governs delivery.
  if (!manual && !configBoolean_('LIFECYCLE_AUTOMATION_ENABLED', true)) {
    return {
      environment: profile.key, paused: true,
      initialNoticeAssets: 0, initialNoticeGroups: 0,
      reminderAssets: 0, reminderGroups: 0,
      escalationAssets: 0, escalationGroups: 0,
      purgeNoticeAssets: 0, purgeNoticeGroups: 0,
      newlyPurgeEligible: 0, autoAccepted: 0, purgeActionsQueued: 0,
      notificationFailureCount: 0, notificationErrors: []
    };
  }
  const cases = readObjects_(APP.sheets.cases);
  const sentNotifications = {};
  readObjects_(APP.sheets.notifications).forEach(function (record) {
    if (cleanText_(record.STATUS).toUpperCase() !== 'SENT') return;
    sentNotifications[cleanText_(record.CASE_ID) + '|' + cleanText_(record.TYPE).toUpperCase()] = true;
  });
  const now = new Date();
  const reminderLeadDays = configNumber_('CONTEST_REMINDER_LEAD_DAYS', 2);
  const initialNoticeAssetIds = [];
  const reminderAssetIds = [];
  const escalationAssetIds = [];
  const purgeNoticeAssetIds = [];
  let newlyPurgeEligible = 0;
  let autoAccepted = 0;

  cases.forEach(function (caseRecord) {
    const lifecycleState = canonicalLifecycleState_(caseRecord.STATE);
    const notificationWasSent = function (messageType) {
      return Boolean(sentNotifications[cleanText_(caseRecord.CASE_ID) + '|' + messageType]);
    };
    const noticeDueAt = caseRecord.T0 || caseRecord.NOTICE_DUE_AT;
    if (lifecycleState === APP.lifecycle.detected && noticeDueAt &&
        new Date(noticeDueAt) <= now && !notificationWasSent('STALE_ASSET_NOTICE')) {
      initialNoticeAssetIds.push(caseRecord.ASSET_ID);
      return;
    }
    if (lifecycleState === APP.lifecycle.notified && caseRecord.CONTEST_DEADLINE) {
      const deadline = new Date(caseRecord.CONTEST_DEADLINE);
      const reminderAt = new Date(deadline.getTime());
      reminderAt.setUTCDate(reminderAt.getUTCDate() - reminderLeadDays);
      if (deadline <= now && !notificationWasSent('OWNER_ESCALATION')) {
        escalationAssetIds.push(caseRecord.ASSET_ID);
      } else if (reminderAt <= now && deadline > now && !notificationWasSent('CONTESTATION_REMINDER')) {
        reminderAssetIds.push(caseRecord.ASSET_ID);
      }
    }
  });

  let initialDelivery = { assetCount: 0, groupCount: 0 };
  let reminderDelivery = { assetCount: 0, groupCount: 0 };
  let escalationDelivery = { assetCount: 0, groupCount: 0 };
  const deliveryErrors = [];
  if (initialNoticeAssetIds.length) {
    try {
      initialDelivery = createAndSendNotificationGroups_(initialNoticeAssetIds, 'STALE_ASSET_NOTICE');
      (initialDelivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
    } catch (error) {
      deliveryErrors.push({ messageType: 'STALE_ASSET_NOTICE', error: String(error.message || error).substring(0, 500) });
    }
  }
  if (reminderAssetIds.length) {
    try {
      reminderDelivery = createAndSendNotificationGroups_(reminderAssetIds, 'CONTESTATION_REMINDER');
      (reminderDelivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
    } catch (error) {
      deliveryErrors.push({ messageType: 'CONTESTATION_REMINDER', error: String(error.message || error).substring(0, 500) });
    }
  }
  if (escalationAssetIds.length) {
    try {
      escalationDelivery = createAndSendNotificationGroups_(escalationAssetIds, 'OWNER_ESCALATION');
      (escalationDelivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
    } catch (error) {
      deliveryErrors.push({ messageType: 'OWNER_ESCALATION', error: String(error.message || error).substring(0, 500) });
    }
  }

  cases.forEach(function (caseRecord) {
    const lifecycleState = canonicalLifecycleState_(caseRecord.STATE);
    if (lifecycleState === APP.lifecycle.notified && caseRecord.CONTEST_DEADLINE && new Date(caseRecord.CONTEST_DEADLINE) <= now) {
      caseRecord.STATE = APP.lifecycle.accepted;
      caseRecord.LAST_TRANSITION_AT = nowIso_();
      caseRecord.NOTES = 'The contestation window expired without a contest or approved exception.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(caseRecord.ASSET_ID, caseRecord.STATE, caseRecord);
      logEvent_(caseRecord.CASE_ID, caseRecord.ASSET_ID, 'AUTO_ACCEPTED_NO_CONTEST', APP.lifecycle.notified, APP.lifecycle.accepted, '', {
        contestDeadline: caseRecord.CONTEST_DEADLINE
      });
      try { queuePlatformActionInternal_(caseRecord.ASSET_ID, 'QUARANTINE', { email: 'SYSTEM', role: 'SYSTEM' }); } catch (error) {}
      autoAccepted += 1;
      return;
    }
    if (lifecycleState !== APP.lifecycle.quarantined) return;
    if (caseRecord.PURGE_NOTICE_AT && new Date(caseRecord.PURGE_NOTICE_AT) <= now &&
        !sentNotifications[cleanText_(caseRecord.CASE_ID) + '|PURGE_NOTICE_30_DAY']) {
      purgeNoticeAssetIds.push(caseRecord.ASSET_ID);
    }
    if (caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= now) {
      const fromState = caseRecord.STATE;
      caseRecord.STATE = APP.lifecycle.purgeEligible;
      caseRecord.LAST_TRANSITION_AT = nowIso_();
      caseRecord.NOTES = 'The quarantine period is complete. Admin pre-purge review and platform handoff are required.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(caseRecord.ASSET_ID, caseRecord.STATE, caseRecord);
      logEvent_(caseRecord.CASE_ID, caseRecord.ASSET_ID, 'PURGE_ELIGIBILITY_REACHED', fromState, caseRecord.STATE, '', {
        purgeEligibleDate: caseRecord.PURGE_ELIGIBLE_DATE
      });
      newlyPurgeEligible += 1;
    }
  });
  let delivery = { assetCount: 0, groupCount: 0 };
  if (purgeNoticeAssetIds.length) {
    try {
      delivery = createAndSendNotificationGroups_(purgeNoticeAssetIds, 'PURGE_NOTICE_30_DAY');
      (delivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
    } catch (error) {
      deliveryErrors.push({ messageType: 'PURGE_NOTICE_30_DAY', error: String(error.message || error).substring(0, 500) });
    }
  }
  return {
    environment: profile.key,
    initialNoticeAssets: initialDelivery.assetCount,
    initialNoticeGroups: initialDelivery.groupCount,
    reminderAssets: reminderDelivery.assetCount,
    reminderGroups: reminderDelivery.groupCount,
    escalationAssets: escalationDelivery.assetCount,
    escalationGroups: escalationDelivery.groupCount,
    purgeNoticeAssets: delivery.assetCount,
    purgeNoticeGroups: delivery.groupCount,
    newlyPurgeEligible: newlyPurgeEligible,
    autoAccepted: autoAccepted,
    purgeActionsQueued: 0,
    notificationFailureCount: deliveryErrors.length,
    notificationErrors: deliveryErrors
  };
}

function runLifecycleAutomationNow() {
  assertAdmin_();
  return runLifecycleAutomation(getActiveEnvironment_(), { manual: true });
}

// --- Manual lifecycle reminder sweep (notifications only) -------------------
// Admin-initiated resend of the two lifecycle reminders — STALE_ASSET_NOTICE for
// DETECTED cases and CONTESTATION_REMINDER / OWNER_ESCALATION for NOTIFIED cases —
// WITHOUT the lifecycle state transitions runLifecycleAutomation performs. Two
// modes: 'DUE' respects the notice/reminder timing exactly as the daily automation
// does; 'ALL' ignores due dates and sweeps every DETECTED/NOTIFIED case. Both modes
// stay idempotent: a case that already has the same notice (DRAFT/SENT/FAILED) is
// skipped, so 'ALL' will not double-message an owner who was already notified.
//
// Scale: enumeration reads only the columns it needs via single-column ranges and
// accumulates asset-id strings, never full-row objects, so it survives the 62k-case
// scale that OOMs readObjects_. Delivery is bounded to REMINDER_SWEEP_BATCH_ASSETS
// per call and resumable: the notices sent this call become the idempotency gate
// that the next call skips, so repeated calls drain the backlog without a cursor.

function lifecycleReminderMaxAssetsPerBatch_() {
  const configured = configNumber_('REMINDER_SWEEP_BATCH_ASSETS', 500);
  return Math.max(50, Math.min(1000, Number(configured || 500)));
}

function collectExistingNotificationCaseTypeKeys_() {
  const sheet = getSheet_(APP.sheets.notifications);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const keys = {};
  if (lastRow < 2 || lastColumn < 1) return keys;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const caseIdCol = headers.indexOf('CASE_ID');
  const typeCol = headers.indexOf('TYPE');
  const statusCol = headers.indexOf('STATUS');
  if (caseIdCol === -1 || typeCol === -1) return keys;
  const rowCount = lastRow - 1;
  const caseIds = sheet.getRange(2, caseIdCol + 1, rowCount, 1).getDisplayValues();
  const types = sheet.getRange(2, typeCol + 1, rowCount, 1).getDisplayValues();
  const statuses = statusCol !== -1 ? sheet.getRange(2, statusCol + 1, rowCount, 1).getDisplayValues() : null;
  for (let i = 0; i < rowCount; i += 1) {
    const caseId = cleanText_(caseIds[i][0]);
    if (!caseId) continue;
    if (statuses) {
      const status = cleanText_(statuses[i][0]).toUpperCase();
      if (['DRAFT', 'SENT', 'FAILED'].indexOf(status) === -1) continue;
    }
    let type = '';
    try { type = normalizeSlackMessageType_(types[i][0]); } catch (error) { continue; }
    keys[caseId + '|' + type] = true;
  }
  return keys;
}

function normalizeLifecycleReminderScope_(value) {
  const scope = cleanText_(value).toUpperCase();
  return (scope === 'DETECTED' || scope === 'NOTIFIED') ? scope : 'ALL';
}

function collectLifecycleReminderTargets_(mode, limit, scope) {
  const ignoreTiming = cleanText_(mode).toUpperCase() === 'ALL';
  const scopeValue = normalizeLifecycleReminderScope_(scope);
  const includeDetected = scopeValue !== 'NOTIFIED';
  const includeNotified = scopeValue !== 'DETECTED';
  const now = new Date();
  const reminderLeadDays = configNumber_('CONTEST_REMINDER_LEAD_DAYS', 2);
  const cap = Number(limit || 0);
  const result = { stale: [], reminder: [], escalation: [], total: 0, remaining: 0, truncated: false };

  const sheet = getSheet_(APP.sheets.cases);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return result;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const caseIdCol = headers.indexOf('CASE_ID');
  const assetIdCol = headers.indexOf('ASSET_ID');
  const stateCol = headers.indexOf('STATE');
  const t0Col = headers.indexOf('T0');
  const noticeDueCol = headers.indexOf('NOTICE_DUE_AT');
  const deadlineCol = headers.indexOf('CONTEST_DEADLINE');
  if (assetIdCol === -1 || stateCol === -1) return result;
  const rowCount = lastRow - 1;

  const sentOrDrafted = collectExistingNotificationCaseTypeKeys_();
  const caseIds = caseIdCol !== -1 ? sheet.getRange(2, caseIdCol + 1, rowCount, 1).getDisplayValues() : null;
  const assetIds = sheet.getRange(2, assetIdCol + 1, rowCount, 1).getDisplayValues();
  const states = sheet.getRange(2, stateCol + 1, rowCount, 1).getDisplayValues();
  const t0s = t0Col !== -1 ? sheet.getRange(2, t0Col + 1, rowCount, 1).getDisplayValues() : null;
  const noticeDues = noticeDueCol !== -1 ? sheet.getRange(2, noticeDueCol + 1, rowCount, 1).getDisplayValues() : null;
  const deadlines = deadlineCol !== -1 ? sheet.getRange(2, deadlineCol + 1, rowCount, 1).getDisplayValues() : null;

  const selectedSoFar = function () { return result.stale.length + result.reminder.length + result.escalation.length; };
  const take = function (bucket, assetId) {
    result.total += 1;
    if (cap > 0 && selectedSoFar() >= cap) { result.remaining += 1; result.truncated = true; return; }
    bucket.push(assetId);
  };

  for (let i = 0; i < rowCount; i += 1) {
    const assetId = cleanText_(assetIds[i][0]);
    if (!assetId) continue;
    const lifecycleState = canonicalLifecycleState_(states[i][0]);
    const caseId = caseIds ? cleanText_(caseIds[i][0]) : '';
    const alreadySent = function (type) { return caseId ? Boolean(sentOrDrafted[caseId + '|' + type]) : false; };

    if (lifecycleState === APP.lifecycle.detected) {
      if (!includeDetected) continue;
      if (alreadySent('STALE_ASSET_NOTICE')) continue;
      if (!ignoreTiming) {
        const dueAt = t0s && cleanText_(t0s[i][0]) ? t0s[i][0] : (noticeDues ? noticeDues[i][0] : '');
        if (!cleanText_(dueAt) || new Date(dueAt) > now) continue;
      }
      take(result.stale, assetId);
      continue;
    }
    if (lifecycleState === APP.lifecycle.notified) {
      if (!includeNotified) continue;
      const deadlineText = deadlines ? cleanText_(deadlines[i][0]) : '';
      if (deadlineText) {
        const deadline = new Date(deadlineText);
        if (deadline <= now) {
          if (!alreadySent('OWNER_ESCALATION')) take(result.escalation, assetId);
          continue;
        }
        if (alreadySent('CONTESTATION_REMINDER')) continue;
        if (!ignoreTiming) {
          const reminderAt = new Date(deadline.getTime());
          reminderAt.setUTCDate(reminderAt.getUTCDate() - reminderLeadDays);
          if (reminderAt > now) continue;
        }
        take(result.reminder, assetId);
        continue;
      }
      // No contest deadline recorded — only actionable in ALL mode, as a reminder.
      if (ignoreTiming && !alreadySent('CONTESTATION_REMINDER')) take(result.reminder, assetId);
    }
  }
  return result;
}

function previewLifecycleReminders(input) {
  assertAdmin_();
  const mode = cleanText_((input || {}).mode).toUpperCase() === 'ALL' ? 'ALL' : 'DUE';
  const scope = normalizeLifecycleReminderScope_((input || {}).scope);
  const targets = collectLifecycleReminderTargets_(mode, 0, scope);
  return {
    environment: getActiveEnvironment_(),
    mode: mode,
    scope: scope,
    staleCount: targets.stale.length,
    reminderCount: targets.reminder.length,
    escalationCount: targets.escalation.length,
    total: targets.total
  };
}

function sendLifecycleReminderBatch(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const mode = cleanText_((input || {}).mode).toUpperCase() === 'ALL' ? 'ALL' : 'DUE';
  const scope = normalizeLifecycleReminderScope_((input || {}).scope);
  const targets = collectLifecycleReminderTargets_(mode, lifecycleReminderMaxAssetsPerBatch_(), scope);
  const deliveryErrors = [];
  const deliver = function (assetIds, type) {
    if (!assetIds.length) return { assetCount: 0, groupCount: 0 };
    try {
      const delivery = createAndSendNotificationGroups_(assetIds, type);
      (delivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
      return delivery;
    } catch (error) {
      deliveryErrors.push({ messageType: type, error: String(error.message || error).substring(0, 500) });
      return { assetCount: 0, groupCount: 0 };
    }
  };
  const staleDelivery = deliver(targets.stale, 'STALE_ASSET_NOTICE');
  const reminderDelivery = deliver(targets.reminder, 'CONTESTATION_REMINDER');
  const escalationDelivery = deliver(targets.escalation, 'OWNER_ESCALATION');
  return {
    environment: profile.key,
    mode: mode,
    scope: scope,
    processed: targets.stale.length + targets.reminder.length + targets.escalation.length,
    staleAssets: staleDelivery.assetCount, staleGroups: staleDelivery.groupCount,
    reminderAssets: reminderDelivery.assetCount, reminderGroups: reminderDelivery.groupCount,
    escalationAssets: escalationDelivery.assetCount, escalationGroups: escalationDelivery.groupCount,
    remaining: targets.remaining,
    done: !targets.truncated,
    notificationFailureCount: deliveryErrors.length,
    notificationErrors: deliveryErrors
  };
}

function notificationExists_(caseId, messageType) {
  return readObjectsByField_(APP.sheets.notifications, 'CASE_ID', caseId, 50).some(function (record) {
    return cleanText_(record.TYPE).toUpperCase() === messageType && ['DRAFT', 'SENT', 'FAILED'].indexOf(cleanText_(record.STATUS).toUpperCase()) !== -1;
  });
}

function ensureLifecycleAutomationTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'runLifecycleAutomation';
  });
  if (!exists) ScriptApp.newTrigger('runLifecycleAutomation').timeBased().everyDays(1).atHour(8).create();
}

function collectOwnerChangeTargets_(limit, excludeAssetIds) {
  // Scan Lifecycle_Events for OWNERSHIP_CHANGED rows and determine which assets need resend.
  // Returns targets where the new recipient is different from what was already notified.
  const excludeMap = {};
  (excludeAssetIds || []).forEach(function (id) { excludeMap[cleanText_(id)] = true; });

  const result = {
    targets: [],
    total: 0,
    remaining: 0,
    truncated: false,
    skipped: { notNotified: 0, alreadyInformed: 0, noRecipient: 0, assetGone: 0 }
  };

  // Scan events for OWNERSHIP_CHANGED type.
  const eventSheet = getSheet_(APP.sheets.events);
  const lastRow = eventSheet.getLastRow();
  const lastColumn = eventSheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return result;

  const headers = eventSheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const eventTypeCol = headers.indexOf('EVENT_TYPE');
  const assetIdCol = headers.indexOf('ASSET_ID');
  const caseIdCol = headers.indexOf('CASE_ID');
  const detailsCol = headers.indexOf('DETAILS_JSON');

  if (eventTypeCol === -1 || assetIdCol === -1 || caseIdCol === -1) return result;

  const rowCount = lastRow - 1;
  const eventTypes = eventTypeCol !== -1 ? eventSheet.getRange(2, eventTypeCol + 1, rowCount, 1).getDisplayValues() : [];
  const assetIds = eventSheet.getRange(2, assetIdCol + 1, rowCount, 1).getDisplayValues();
  const caseIds = caseIdCol !== -1 ? eventSheet.getRange(2, caseIdCol + 1, rowCount, 1).getDisplayValues() : [];
  const detailsRows = detailsCol !== -1 ? eventSheet.getRange(2, detailsCol + 1, rowCount, 1).getDisplayValues() : [];

  const uniqueAssets = {};
  for (let i = 0; i < rowCount; i += 1) {
    if (cleanText_(eventTypes[i][0]).toUpperCase() === 'OWNERSHIP_CHANGED') {
      const assetId = cleanText_(assetIds[i][0]);
      if (assetId && !uniqueAssets[assetId]) uniqueAssets[assetId] = true;
    }
  }

  // Bulk read current assets and cases.
  const assetIdList = Object.keys(uniqueAssets);
  const assetsMap = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', assetIdList), 'ASSET_ID');
  const casesMap = {};
  readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', assetIdList).forEach(function (caseRecord) {
    casesMap[caseRecord.ASSET_ID] = caseRecord;
  });

  // Build "informed set" from SENT notifications.
  const informedSet = {};
  const notificationsSheet = getSheet_(APP.sheets.notifications);
  const notLastRow = notificationsSheet.getLastRow();
  const notLastColumn = notificationsSheet.getLastColumn();
  if (notLastRow >= 2 && notLastColumn >= 1) {
    const notHeaders = notificationsSheet.getRange(1, 1, 1, notLastColumn).getDisplayValues()[0];
    const notRecipientCol = notHeaders.indexOf('RECIPIENTS');
    const notIdempCol = notHeaders.indexOf('IDEMPOTENCY_KEY');
    const notStatusCol = notHeaders.indexOf('STATUS');
    const notCaseIdCol = notHeaders.indexOf('CASE_ID');
    const notRowCount = notLastRow - 1;
    if (notStatusCol !== -1 && notRecipientCol !== -1) {
      const notStatuses = notStatusCol !== -1 ? notificationsSheet.getRange(2, notStatusCol + 1, notRowCount, 1).getDisplayValues() : [];
      const notRecipients = notRecipientCol !== -1 ? notificationsSheet.getRange(2, notRecipientCol + 1, notRowCount, 1).getDisplayValues() : [];
      const notIdempKeys = notIdempCol !== -1 ? notificationsSheet.getRange(2, notIdempCol + 1, notRowCount, 1).getDisplayValues() : [];
      const notCaseIds = notCaseIdCol !== -1 ? notificationsSheet.getRange(2, notCaseIdCol + 1, notRowCount, 1).getDisplayValues() : [];
      for (let i = 0; i < notRowCount; i += 1) {
        if (cleanText_(notStatuses[i][0]).toUpperCase() === 'SENT') {
          const recipient = cleanText_(notRecipients[i][0]).toLowerCase();
          const caseId = notCaseIds[i] ? cleanText_(notCaseIds[i][0]) : '';
          const idempKey = notIdempKeys[i] ? cleanText_(notIdempKeys[i][0]) : '';
          if (recipient && caseId) {
            if (!informedSet[caseId]) informedSet[caseId] = {};
            informedSet[caseId][recipient] = true;
          }
          // Extract owner-change suffix if present.
          if (idempKey.indexOf('|OWNER_CHANGE|') !== -1) {
            const parts = idempKey.split('|');
            if (parts.length >= 5) {
              const ownerChangeRecipient = cleanText_(parts[4]).toLowerCase();
              if (ownerChangeRecipient && caseId) {
                if (!informedSet[caseId]) informedSet[caseId] = {};
                informedSet[caseId][ownerChangeRecipient] = true;
              }
            }
          }
        }
      }
    }
  }

  const cap = Number(limit || 0);
  assetIdList.forEach(function (assetId) {
    if (excludeMap[cleanText_(assetId)]) return;
    if (cap > 0 && result.targets.length >= cap) {
      result.remaining += 1;
      result.truncated = true;
      return;
    }

    const asset = assetsMap[assetId];
    const caseRecord = casesMap[assetId];

    if (!asset) {
      result.skipped.assetGone += 1;
      return;
    }
    if (!caseRecord || canonicalLifecycleState_(caseRecord.STATE) !== APP.lifecycle.notified) {
      result.skipped.notNotified += 1;
      return;
    }

    // Resolve the new recipient.
    const routing = resolvePrimaryRecipient_({asset: asset}, 'STALE_ASSET_NOTICE');
    if (!routing.primaryRecipient || routing.primaryRecipientSource === 'EDG_OPERATIONS_RECIPIENT') {
      result.skipped.noRecipient += 1;
      return;
    }

    // Check if this recipient is already informed.
    const caseId = cleanText_(caseRecord.CASE_ID);
    const newRecipient = cleanText_(routing.primaryRecipient).toLowerCase();
    if (informedSet[caseId] && informedSet[caseId][newRecipient]) {
      result.skipped.alreadyInformed += 1;
      return;
    }

    result.total += 1;
    result.targets.push({
      assetId: assetId,
      caseId: caseId,
      objectFqn: asset.OBJECT_FQN,
      newRecipient: routing.primaryRecipient,
      newRecipientSource: routing.primaryRecipientSource
    });
  });

  return result;
}

function previewOwnerChangeNotifications() {
  assertAdmin_();
  const targets = collectOwnerChangeTargets_(100, []);
  const sample = targets.targets.slice(0, 10).map(function (target) {
    return {
      objectFqn: target.objectFqn,
      newRecipient: target.newRecipient,
      newRecipientSource: target.newRecipientSource
    };
  });
  return {
    environment: getActiveEnvironment_(),
    total: targets.total,
    skipped: targets.skipped,
    sample: sample
  };
}

function sendOwnerChangeNotificationBatch(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const sweepId = (input && input.sweepId) || uuid_();
  const excludeAssetIds = (input && input.excludeAssetIds) || [];

  const targets = collectOwnerChangeTargets_(lifecycleReminderMaxAssetsPerBatch_(), excludeAssetIds);

  if (!targets.targets.length) {
    return {
      environment: getActiveEnvironment_(),
      processed: 0,
      groups: 0,
      remaining: targets.remaining,
      done: targets.total === 0,
      failedAssetIds: [],
      notificationFailureCount: 0,
      notificationErrors: []
    };
  }

  // Build owner-change map for the notification creator.
  const ownerChangeMap = {};
  targets.targets.forEach(function (target) {
    ownerChangeMap[target.assetId] = {
      recipient: target.newRecipient,
      previousRecipient: target.previousRecipient || '',
      sweepId: sweepId
    };
  });

  const assetIds = targets.targets.map(function (t) { return t.assetId; });
  const deliveryErrors = [];
  let delivery = { assetCount: 0, groupCount: 0, failedAssetCount: 0, errors: [] };

  try {
    delivery = createAndSendNotificationGroups_(assetIds, 'STALE_ASSET_NOTICE', false, {ownerChange: ownerChangeMap});
    (delivery.errors || []).forEach(function (error) { deliveryErrors.push(error); });
  } catch (error) {
    deliveryErrors.push({ error: String(error.message || error).substring(0, 500) });
  }

  return {
    environment: getActiveEnvironment_(),
    processed: delivery.assetCount || 0,
    groups: delivery.groupCount || 0,
    remaining: targets.remaining,
    done: targets.remaining === 0,
    failedAssetIds: deliveryErrors.map(function (err) { return err.assetId; }).filter(Boolean),
    notificationFailureCount: deliveryErrors.length,
    notificationErrors: deliveryErrors
  };
}

// ---------------------------------------------------------------------------
// Delegate assignment: admin selects NOTIFIED assets and names a new owner who
// receives the stale-asset notice on demand. The asset's own owner fields are
// not modified; the delegation is audited in Lifecycle_Events.
// ---------------------------------------------------------------------------

function delegateAssignmentMaxAssets_() {
  return 200;
}

function normalizeDelegateOwner_(value) {
  const text = cleanText_(value).toLowerCase();
  if (!text) throw new Error('Enter the new owner as an email address or Salesforce username.');
  if (/[;,\s]/.test(text)) throw new Error('Enter exactly one new owner.');
  if (isSlackEmail_(text)) return text;
  if (text.indexOf('@') === -1 && isSalesforceUserId_(text)) return text + '@salesforce.com';
  throw new Error('"' + cleanText_(value) + '" is not a valid email address or Salesforce username.');
}

function collectDelegationTargets_(assetIds, newOwner) {
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  if (!ids.length) throw new Error('Select at least one asset.');
  if (ids.length > delegateAssignmentMaxAssets_()) {
    throw new Error('Delegation is limited to ' + delegateAssignmentMaxAssets_() + ' assets at a time.');
  }
  const recipient = normalizeDelegateOwner_(newOwner);
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', ids), 'ASSET_ID');
  const cases = {};
  readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', ids).forEach(function (caseRecord) {
    if (assets[caseRecord.ASSET_ID]) cases[caseRecord.ASSET_ID] = caseRecord;
  });
  const result = { recipient: recipient, targets: [], skipped: { notNotified: 0, assetGone: 0, alreadyOwner: 0 }, skippedAssets: [] };
  ids.forEach(function (assetId) {
    const asset = assets[assetId];
    const caseRecord = cases[assetId];
    if (!asset || !caseRecord) {
      result.skipped.assetGone += 1;
      return;
    }
    if (canonicalLifecycleState_(caseRecord.STATE) !== APP.lifecycle.notified) {
      result.skipped.notNotified += 1;
      result.skippedAssets.push({ assetId: assetId, objectFqn: asset.OBJECT_FQN || '', reason: 'Not NOTIFIED (' + cleanText_(caseRecord.STATE) + ')' });
      return;
    }
    const current = resolvePrimaryRecipient_({ asset: asset, caseRecord: caseRecord, events: [] }, 'STALE_ASSET_NOTICE', { ignoreRecipientLock: true });
    const previous = cleanText_(current.primaryRecipient).toLowerCase();
    if (previous && previous === recipient) {
      result.skipped.alreadyOwner += 1;
      result.skippedAssets.push({ assetId: assetId, objectFqn: asset.OBJECT_FQN || '', reason: 'Already the resolved owner' });
      return;
    }
    result.targets.push({ assetId: assetId, caseId: caseRecord.CASE_ID, objectFqn: asset.OBJECT_FQN || '', previousRecipient: previous });
  });
  return result;
}

function previewDelegateAssignment(input) {
  assertAdmin_();
  const targets = collectDelegationTargets_(input && input.assetIds, input && input.newOwner);
  return {
    environment: getActiveEnvironment_(),
    newOwner: targets.recipient,
    total: targets.targets.length,
    skipped: targets.skipped,
    skippedSample: targets.skippedAssets.slice(0, 5),
    sample: targets.targets.slice(0, 10).map(function (target) {
      return { objectFqn: target.objectFqn, previousRecipient: target.previousRecipient };
    })
  };
}

function sendDelegatedAssignmentNotifications(input) {
  const admin = assertAdmin_();
  assertEnvironmentWritable_();
  const sweepId = cleanText_(input && input.sweepId) || uuid_();
  const targets = collectDelegationTargets_(input && input.assetIds, input && input.newOwner);
  const base = {
    environment: getActiveEnvironment_(),
    newOwner: targets.recipient,
    sweepId: sweepId,
    skipped: targets.skipped
  };
  if (!targets.targets.length) {
    return Object.assign(base, { processed: 0, groups: 0, failedAssetIds: [], notificationFailureCount: 0, notificationErrors: [] });
  }
  const delegateMap = {};
  targets.targets.forEach(function (target) {
    delegateMap[target.assetId] = {
      recipient: targets.recipient,
      previousRecipient: target.previousRecipient,
      sweepId: sweepId,
      delegatedBy: admin.email
    };
  });
  const errors = [];
  let delivery = { assetCount: 0, groupCount: 0, errors: [] };
  try {
    delivery = createAndSendNotificationGroups_(
      targets.targets.map(function (target) { return target.assetId; }),
      'STALE_ASSET_NOTICE', false, { delegate: delegateMap }
    );
    (delivery.errors || []).forEach(function (error) { errors.push(error); });
  } catch (error) {
    errors.push({ error: String(error.message || error).substring(0, 500) });
  }
  return Object.assign(base, {
    processed: delivery.assetCount || 0,
    groups: delivery.groupCount || 0,
    failedAssetIds: errors.map(function (error) { return error.assetId; }).filter(Boolean),
    notificationFailureCount: errors.length,
    notificationErrors: errors
  });
}
