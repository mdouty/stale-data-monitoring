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

function runLifecycleAutomation() {
  const profile = assertEnvironmentWritable_();
  const cases = readObjects_(APP.sheets.cases);
  const now = new Date();
  const purgeNoticeAssetIds = [];
  let newlyPurgeEligible = 0;
  let autoAccepted = 0;
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
    if (caseRecord.PURGE_NOTICE_AT && new Date(caseRecord.PURGE_NOTICE_AT) <= now && !notificationExists_(caseRecord.CASE_ID, 'PURGE_NOTICE_30_DAY')) {
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
    try { delivery = createAndSendNotificationGroups_(purgeNoticeAssetIds, 'PURGE_NOTICE_30_DAY'); } catch (error) {}
  }
  return {
    environment: profile.key,
    purgeNoticeAssets: delivery.assetCount,
    purgeNoticeGroups: delivery.groupCount,
    newlyPurgeEligible: newlyPurgeEligible,
    autoAccepted: autoAccepted,
    purgeActionsQueued: 0
  };
}

function runLifecycleAutomationNow() {
  assertAdmin_();
  return runLifecycleAutomation();
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
