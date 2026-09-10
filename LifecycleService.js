const ALLOWED_TRANSITIONS = Object.freeze({
  DETECTED: ['NOTIFIED', 'EXEMPT', 'DISMISSED', 'ACTIVE'],
  NOTIFIED: ['CONTESTED', 'ACCEPTED', 'EXEMPT', 'DISMISSED', 'ACTIVE'],
  CONTESTED: ['ACCEPTED', 'EXEMPT', 'DISMISSED', 'ACTIVE'],
  ACCEPTED: ['CONTESTED', 'EXEMPT', 'DISMISSED', 'ACTIVE', 'QUARANTINED'],
  EXEMPT: ['DETECTED', 'ACTIVE', 'DISMISSED'],
  QUARANTINED: ['PURGE_ELIGIBLE', 'RESTORED'],
  PURGE_ELIGIBLE: ['PURGED', 'RESTORED'],
  PURGED: ['RESTORED'],
  RESTORED: ['DETECTED'],
  ACTIVE: ['DETECTED'],
  SELF_PURGE_PENDING: ['DISMISSED', 'RESTORED', 'PURGED'],
  DISMISSED: ['DETECTED']
});

function transitionCase(caseId, toState, notes) {
  const found = findObjectRow_(APP.sheets.cases, 'CASE_ID', caseId);
  if (!found) throw new Error('Lifecycle case not found or you do not have access to it.');
  const actor = assertAssetResponseAuthorization_(found.value.ASSET_ID);
  return transitionCaseInternal_(caseId, toState, notes, true, actor);
}

function transitionCaseAndNotify(caseId, toState, notes) {
  const found = findObjectRow_(APP.sheets.cases, 'CASE_ID', caseId);
  if (!found) throw new Error('Lifecycle case not found or you do not have access to it.');
  const fromState = canonicalLifecycleState_(found.value.STATE);
  const targetState = canonicalLifecycleState_(toState);
  const actor = assertAssetResponseAuthorization_(found.value.ASSET_ID);
  transitionCaseInternal_(caseId, targetState, notes, false, actor);
  let platformAction = null;
  if (targetState === APP.lifecycle.accepted) {
    platformAction = queuePlatformActionInternal_(found.value.ASSET_ID, 'QUARANTINE', actor);
  }
  const messageType = immediateNotificationTypeForTransition_(fromState, targetState);
  const detail = getAssetDetail(found.value.ASSET_ID);
  detail.platformActionAutomation = platformAction;
  if (!messageType) return detail;
  const delivery = createAndSendNotificationGroups_([found.value.ASSET_ID], messageType);
  const refreshed = getAssetDetail(found.value.ASSET_ID);
  refreshed.notificationAutomation = delivery;
  return refreshed;
}

function immediateNotificationTypeForTransition_(fromState, toState) {
  if (toState === APP.lifecycle.contested) return 'CONTESTATION_RECEIVED';
  if (toState === APP.lifecycle.accepted) return 'DEPRECATION_ACCEPTED';
  if (toState === APP.lifecycle.quarantined) return 'QUARANTINE_NOTICE';
  return '';
}

function applyQuarantineState_(caseRecord, confirmedAt, notes) {
  const quarantineStart = caseRecord.QUARANTINE_START_DATE || confirmedAt || nowIso_();
  const ownerStatus = cleanText_(caseRecord.OWNER_STATUS).toUpperCase();
  const quarantineDays = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1
    ? configNumber_('ORPHAN_QUARANTINE_DAYS', 365)
    : configNumber_('QUARANTINE_DAYS', 181);
  caseRecord.STATE = APP.lifecycle.quarantined;
  caseRecord.RESTRICT_AT = caseRecord.RESTRICT_AT || quarantineStart;
  caseRecord.QUARANTINE_START_DATE = quarantineStart;
  caseRecord.PURGE_NOTICE_AT = caseRecord.PURGE_NOTICE_AT || addDaysIso_(quarantineStart,
    quarantineDays - configNumber_('PURGE_NOTICE_DAYS', 30));
  caseRecord.PURGE_ELIGIBLE_DATE = caseRecord.PURGE_ELIGIBLE_DATE || addDaysIso_(quarantineStart,
    quarantineDays);
  caseRecord.LAST_TRANSITION_AT = confirmedAt || quarantineStart;
  caseRecord.NOTES = cleanText_(notes) || caseRecord.NOTES;
  return caseRecord;
}

function transitionCaseInternal_(caseId, toState, notes, includeDetail, actorContext, auditEventType, allowAdminOverride) {
  const actor = actorContext || assertRole_(['ADMIN', 'OPERATOR']);
  assertEnvironmentWritable_();
  ensureDataModelV2_();
  const targetState = canonicalLifecycleState_(toState);
  if (targetState === APP.lifecycle.dismissed && actor.role !== 'ADMIN') {
    throw new Error('Only an administrator can dismiss an asset.');
  }
  const found = findObjectRow_(APP.sheets.cases, 'CASE_ID', caseId);
  if (!found) throw new Error('Lifecycle case not found.');
  const current = found.value;
  current.STATE = canonicalLifecycleState_(current.STATE);
  const allowed = ALLOWED_TRANSITIONS[current.STATE] || [];
  if (allowed.indexOf(targetState) === -1 && !(allowAdminOverride && actor.role === 'ADMIN')) {
    throw new Error('Transition from ' + current.STATE + ' to ' + targetState + ' is not allowed.');
  }
  const updated = Object.assign({}, current, {
    STATE: targetState,
    LAST_TRANSITION_AT: nowIso_(),
    NOTES: cleanText_(notes) || current.NOTES
  });
  if (targetState === APP.lifecycle.notified) updated.NOTIFIED_AT = nowIso_();
  upsertObject_(APP.sheets.cases, 'CASE_ID', updated);
  updateAssetState_(current.ASSET_ID, targetState, updated);
  logEvent_(caseId, current.ASSET_ID, auditEventType || 'STATE_TRANSITION', current.STATE, targetState, '', {
    actor: actor.email, notes: cleanText_(notes), comment: cleanText_(notes)
  });
  return includeDetail ? getAssetDetail(current.ASSET_ID) : { assetId: current.ASSET_ID, state: targetState };
}

function allowedAdminLifecycleTransitions_(state) {
  const current = canonicalLifecycleState_(state);
  return [
    APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested,
    APP.lifecycle.accepted, APP.lifecycle.exempt, APP.lifecycle.dismissed,
    APP.lifecycle.quarantined, APP.lifecycle.purgeEligible,
    APP.lifecycle.selfPurgePending, APP.lifecycle.restored,
    APP.lifecycle.purged, APP.lifecycle.active
  ].filter(function (target) { return target !== current; });
}

function adminChangeLifecycleStatus(input) {
  assertEnvironmentWritable_();
  const actor = assertAdmin_();
  const payload = input || {};
  const caseId = cleanText_(payload.caseId);
  const targetState = canonicalLifecycleState_(payload.targetState);
  const comment = cleanText_(payload.comment);
  if (!caseId) throw new Error('A lifecycle case is required.');
  if (!targetState) throw new Error('Select a new lifecycle status.');
  if (!comment) throw new Error('A comment is required for an administrator status change.');
  if (comment.length > 2000) throw new Error('Comments are limited to 2,000 characters.');
  const found = findObjectRow_(APP.sheets.cases, 'CASE_ID', caseId);
  if (!found) throw new Error('Lifecycle case not found.');
  const currentState = canonicalLifecycleState_(found.value.STATE);
  if (allowedAdminLifecycleTransitions_(currentState).indexOf(targetState) === -1) {
    throw new Error('Select a lifecycle status different from the current status.');
  }
  cancelPendingPlatformActionsForAsset_(found.value.ASSET_ID, 'Superseded by administrator lifecycle override to ' + targetState + ': ' + comment);
  transitionCaseInternal_(caseId, targetState, comment, false, actor, 'ADMIN_STATUS_CHANGE', true);
  const updatedFound = findObjectRow_(APP.sheets.cases, 'CASE_ID', caseId);
  const updatedCase = updatedFound.value;
  const changedAt = nowIso_();
  if (targetState === APP.lifecycle.detected) {
    updatedCase.T0 = '';
    updatedCase.NOTICE_DUE_AT = '';
    updatedCase.NOTIFIED_AT = '';
    updatedCase.CONTEST_DEADLINE = '';
    updatedCase.RESTRICT_AT = '';
    updatedCase.QUARANTINE_START_DATE = '';
    updatedCase.PURGE_NOTICE_AT = '';
    updatedCase.PURGE_ELIGIBLE_DATE = '';
  } else if (targetState === APP.lifecycle.notified) {
    updatedCase.T0 = changedAt;
    updatedCase.NOTICE_DUE_AT = changedAt;
    updatedCase.NOTIFIED_AT = changedAt;
    updatedCase.CONTEST_DEADLINE = addDaysIso_(changedAt, configNumber_('CONTEST_WINDOW_DAYS', 9));
    updatedCase.RESTRICT_AT = '';
    updatedCase.QUARANTINE_START_DATE = '';
    updatedCase.PURGE_NOTICE_AT = '';
    updatedCase.PURGE_ELIGIBLE_DATE = '';
  } else if (targetState === APP.lifecycle.accepted) {
    updatedCase.T0 = updatedCase.T0 || changedAt;
  } else if (targetState === APP.lifecycle.quarantined) {
    applyQuarantineState_(updatedCase, changedAt, comment);
  } else if (targetState === APP.lifecycle.purgeEligible) {
    if (!updatedCase.QUARANTINE_START_DATE) applyQuarantineState_(updatedCase, changedAt, comment);
    updatedCase.STATE = APP.lifecycle.purgeEligible;
    updatedCase.PURGE_ELIGIBLE_DATE = changedAt;
    updatedCase.PURGE_NOTICE_AT = updatedCase.PURGE_NOTICE_AT || changedAt;
  }
  updatedCase.STATE = targetState;
  updatedCase.LAST_TRANSITION_AT = changedAt;
  updatedCase.NOTES = comment;
  upsertObject_(APP.sheets.cases, 'CASE_ID', updatedCase);
  updateAssetState_(found.value.ASSET_ID, targetState, updatedCase);
  let platformAction = null;
  let notificationAutomation = null;
  if (targetState === APP.lifecycle.accepted) {
    platformAction = queuePlatformActionInternal_(found.value.ASSET_ID, 'QUARANTINE', actor, true);
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'DEPRECATION_ACCEPTED');
  } else if (targetState === APP.lifecycle.notified) {
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'STALE_ASSET_NOTICE');
  } else if (targetState === APP.lifecycle.contested) {
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'CONTESTATION_RECEIVED');
  } else if (targetState === APP.lifecycle.quarantined) {
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'QUARANTINE_NOTICE');
  } else if (targetState === APP.lifecycle.restored) {
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'RESTORATION_CONFIRMED');
  } else if (targetState === APP.lifecycle.purged) {
    notificationAutomation = createAndSendNotificationGroups_([found.value.ASSET_ID], 'PURGE_COMPLETED');
  }
  const detail = getAssetDetail(found.value.ASSET_ID);
  detail.platformActionAutomation = platformAction;
  detail.notificationAutomation = notificationAutomation;
  return detail;
}

function bulkTransitionCandidates(input) {
  assertEnvironmentWritable_();
  const payload = input || {};
  const action = cleanText_(payload.action).toUpperCase();
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one deprecation candidate.');
  if (assetIds.length > 50) throw new Error('Bulk actions are limited to 50 candidates at a time.');
  if (['CONFIRM_DEPRECATION', 'DISMISS'].indexOf(action) === -1) throw new Error('Unsupported bulk action.');
  const actor = action === 'DISMISS' ? assertAdmin_() : assertAssetsResponseAuthorization_(assetIds);

  const targetState = action === 'CONFIRM_DEPRECATION' ? APP.lifecycle.accepted : APP.lifecycle.dismissed;
  const eligibleStates = action === 'CONFIRM_DEPRECATION'
    ? [APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted]
    : [APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted, APP.lifecycle.selfPurgePending];
  const result = { processed: 0, skipped: 0, failed: 0, notificationAssets: 0, notificationGroups: 0, details: [] };
  const notificationAssetIds = [];

  assetIds.forEach(function (assetId) {
    try {
      const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
      if (!assetFound || deriveAssetStatus_(assetFound.value) !== APP.assetStatus.stale) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'Not a stale deprecation candidate.' });
        return;
      }
      const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
      const caseRecord = cases.length ? cases[cases.length - 1] : null;
      if (caseRecord) caseRecord.STATE = canonicalLifecycleState_(caseRecord.STATE);
      if (!caseRecord || eligibleStates.indexOf(caseRecord.STATE) === -1) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'Action is not allowed from the current lifecycle state.' });
        return;
      }
      if (caseRecord.STATE !== targetState) transitionCaseInternal_(caseRecord.CASE_ID, targetState, 'Bulk ' + action + ' action from dashboard.', false, actor);
      if (action === 'CONFIRM_DEPRECATION') queuePlatformActionInternal_(assetId, 'QUARANTINE', actor);
      else cancelPendingPlatformActionsForAsset_(assetId, 'Deprecation candidate dismissed by EDG.');
      result.processed += 1;
      result.details.push({ assetId: assetId, status: 'PROCESSED', toState: targetState });
      if (action === 'CONFIRM_DEPRECATION') notificationAssetIds.push(assetId);
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: assetId, status: 'FAILED', reason: error.message || String(error) });
    }
  });
  if (notificationAssetIds.length) {
    const delivery = createAndSendNotificationGroups_(notificationAssetIds, 'DEPRECATION_ACCEPTED');
    result.notificationAssets = delivery.assetCount;
    result.notificationGroups = delivery.groupCount;
  }
  return result;
}

function requestSelfPurge(input) {
  assertEnvironmentWritable_();
  ensureDataModelV2_();
  const payload = input || {};
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one asset to self purge.');
  if (assetIds.length > 50) throw new Error('Self purge is limited to 50 assets at a time.');
  const actor = assertAssetsResponseAuthorization_(assetIds);
  const allowedStates = [
    APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested,
    APP.lifecycle.accepted
  ];
  const result = { processed: 0, skipped: 0, failed: 0, details: [] };
  assetIds.forEach(function (assetId) {
    try {
      const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
      if (!assetFound) throw new Error('Asset not found.');
      const assetStatus = deriveAssetStatus_(assetFound.value);
      if (assetStatus !== APP.assetStatus.stale) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'Only accessible stale assets can enter self purge. Restore quarantined access first.' });
        return;
      }
      const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
      if (!cases.length) throw new Error('Lifecycle case not found.');
      const caseRecord = cases[cases.length - 1];
      const fromState = canonicalLifecycleState_(caseRecord.STATE);
      if (allowedStates.indexOf(fromState) === -1) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'Self purge cannot be requested from ' + fromState + '.' });
        return;
      }
      caseRecord.STATE = APP.lifecycle.selfPurgePending;
      caseRecord.LAST_TRANSITION_AT = nowIso_();
      caseRecord.NOTES = 'Owner committed to self-service deletion; completion awaits absence verification in a later complete import.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(assetId, caseRecord.STATE, caseRecord);
      const cancelledActions = cancelPendingPlatformActionsForAsset_(assetId, 'Owner self-purge intent recorded; awaiting source absence verification.');
      logEvent_(caseRecord.CASE_ID, assetId, 'OWNER_SELF_PURGE_REQUESTED', fromState, caseRecord.STATE, '', {
        actor: actor.email, cancelledPlatformActions: cancelledActions
      });
      result.processed += 1;
      result.details.push({ assetId: assetId, status: 'PROCESSED', toState: caseRecord.STATE });
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: assetId, status: 'FAILED', reason: error.message || String(error) });
    }
  });
  return result;
}

function requestAssetRestorations(input) {
  assertEnvironmentWritable_();
  const payload = input || {};
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one quarantined asset to restore.');
  if (assetIds.length > 50) throw new Error('Restoration requests are limited to 50 assets at a time.');
  const actor = assertAssetsResponseAuthorization_(assetIds);
  const result = { processed: 0, skipped: 0, failed: 0, details: [] };
  assetIds.forEach(function (assetId) {
    try {
      const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
      if (!assetFound || deriveAssetStatus_(assetFound.value) !== APP.assetStatus.quarantined) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'The asset is not currently quarantined.' });
        return;
      }
      const record = queuePlatformActionInternal_(assetId, 'RESTORE', actor);
      result.processed += 1;
      result.details.push({ assetId: assetId, status: 'PROCESSED', actionId: record.ACTION_ID });
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: assetId, status: 'FAILED', reason: error.message || String(error) });
    }
  });
  return result;
}

function updateAssetState_(assetId, state, caseRecord) {
  const found = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
  if (!found) return;
  const updated = Object.assign({}, found.value, {
    LIFECYCLE_STATE: state,
    STALE_DESIGNATION_DATE: caseRecord.T0 || found.value.STALE_DESIGNATION_DATE || '',
    CONTEST_DEADLINE: caseRecord.CONTEST_DEADLINE || '',
    QUARANTINE_START_DATE: caseRecord.QUARANTINE_START_DATE || '',
    QUARANTINE_EXPIRY_DATE: caseRecord.PURGE_ELIGIBLE_DATE || '',
    PURGE_ELIGIBLE_DATE: caseRecord.PURGE_ELIGIBLE_DATE || '',
    EXCEPTION_ID: caseRecord.EXCEPTION_ID || '',
    EXCEPTION_STATUS: caseRecord.EXCEPTION_STATUS || '',
    CONTEST_REFERENCE: caseRecord.CONTEST_REFERENCE || ''
  });
  updated.ASSET_STATUS = deriveAssetStatus_(updated, state);
  upsertObject_(APP.sheets.assetsCurrent, 'ASSET_ID', updated);
}

function buildExceptionUrl_(assetId, caseId) {
  const baseUrl = cleanText_(getConfig_().EXCEPTION_APP_URL);
  if (!baseUrl) return '';
  const separator = baseUrl.indexOf('?') === -1 ? '?' : '&';
  return baseUrl + separator + 'page=intake&asset_id=' + encodeURIComponent(assetId) +
    '&case_id=' + encodeURIComponent(caseId || '') + '&source=stale-data-monitor';
}

function getBulkExceptionRequestUrl(assetIds) {
  assertEnvironmentWritable_();
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  if (!ids.length) throw new Error('Select at least one deprecation candidate.');
  if (ids.length > 50) throw new Error('Bulk exception requests are limited to 50 candidates at a time.');
  assertAssetsResponseAuthorization_(ids);
  const baseUrl = cleanText_(getConfig_().EXCEPTION_APP_URL);
  if (!baseUrl) throw new Error('The exception application URL is not configured.');

  const validAssetIds = [];
  const caseIds = [];
  ids.forEach(function (assetId) {
    const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
    if (!assetFound || deriveAssetStatus_(assetFound.value) !== APP.assetStatus.stale) return;
    const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
    validAssetIds.push(assetId);
    caseIds.push(cases.length ? cases[cases.length - 1].CASE_ID : '');
  });
  if (!validAssetIds.length) throw new Error('None of the selected records are eligible deprecation candidates.');
  if (validAssetIds.length === 1) {
    return { url: buildExceptionUrl_(validAssetIds[0], caseIds[0]), assetCount: 1 };
  }
  const separator = baseUrl.indexOf('?') === -1 ? '?' : '&';
  return {
    url: baseUrl + separator + 'page=intake&asset_ids=' + encodeURIComponent(validAssetIds.join(',')) +
      '&case_ids=' + encodeURIComponent(caseIds.join(',')) + '&bulk=true&source=stale-data-monitor',
    assetCount: validAssetIds.length
  };
}

function contestAssets(input) {
  assertEnvironmentWritable_();
  ensureDataModelV2_();
  const payload = input || {};
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  const exceptionId = normalizeExceptionRequestId_(payload.exceptionId || payload.requestReference);
  if (!assetIds.length) throw new Error('Select at least one asset to contest.');
  if (assetIds.length > 50) throw new Error('Contestation is limited to 50 assets at a time.');
  const reason = cleanText_(payload.reason) || 'Business justification is recorded in exception request ' + exceptionId + '.';
  const actor = assertAssetsResponseAuthorization_(assetIds);
  const validatedException = validateActiveException_(exceptionId);
  const result = { processed: 0, skipped: 0, failed: 0, details: [] };
  const notificationAssetIds = [];
  assetIds.forEach(function (assetId) {
    try {
      const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
      if (!cases.length) throw new Error('Lifecycle case not found.');
      const caseRecord = cases[cases.length - 1];
      caseRecord.STATE = canonicalLifecycleState_(caseRecord.STATE);
      if ([APP.lifecycle.notified, APP.lifecycle.accepted].indexOf(caseRecord.STATE) === -1) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: 'The case cannot be contested from ' + caseRecord.STATE + '.' });
        return;
      }
      const fromState = caseRecord.STATE;
      caseRecord.STATE = APP.lifecycle.contested;
      caseRecord.CONTEST_REASON = reason;
      caseRecord.CONTEST_REFERENCE = exceptionId;
      caseRecord.EXCEPTION_ID = exceptionId;
      caseRecord.EXCEPTION_STATUS = validatedException.status;
      caseRecord.CONTESTED_AT = nowIso_();
      caseRecord.LAST_TRANSITION_AT = caseRecord.CONTESTED_AT;
      caseRecord.NOTES = 'Deprecation paused under active exception ' + exceptionId + '.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(assetId, caseRecord.STATE, caseRecord);
      cancelPendingPlatformActionsForAsset_(assetId, 'Contestation recorded; exception review is in progress.');
      logEvent_(caseRecord.CASE_ID, assetId, 'CONTESTATION_RECEIVED', fromState, caseRecord.STATE, '', {
        actor: actor.email, reason: reason, exceptionId: exceptionId,
        exceptionStatus: validatedException.status,
        exceptionDatabaseSheet: validatedException.sheetName,
        exceptionDatabaseRow: validatedException.rowNumber
      });
      result.processed += 1;
      result.details.push({ assetId: assetId, status: 'PROCESSED', toState: caseRecord.STATE, exceptionId: exceptionId });
      notificationAssetIds.push(assetId);
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: assetId, status: 'FAILED', reason: error.message || String(error) });
    }
  });
  if (notificationAssetIds.length) {
    try { result.notificationAutomation = createAndSendNotificationGroups_(notificationAssetIds, 'CONTESTATION_RECEIVED'); }
    catch (error) { result.notificationError = String(error.message || error); }
  }
  try { result.exceptionRequest = getBulkExceptionRequestUrl(notificationAssetIds); } catch (error) { result.exceptionRequest = null; }
  return result;
}

function markAssetsExempt(input) {
  assertEnvironmentWritable_();
  ensureDataModelV2_();
  const payload = input || {};
  const assetIds = Array.from(new Set((payload.assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one asset.');
  if (assetIds.length > 50) throw new Error('Exception updates are limited to 50 assets at a time.');
  const exceptionId = normalizeApprovedExceptionId_(payload.exceptionId);
  const actor = assertAssetsResponseAuthorization_(assetIds);
  if (actor.role === 'ASSET_RESPONDER') {
    throw new Error('Exception approval is reconciled automatically from the exception application. No second owner submission is allowed.');
  }
  const allowedStates = actor.role === 'ASSET_RESPONDER'
    ? []
    : [APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted, APP.lifecycle.exempt];
  const result = { processed: 0, skipped: 0, failed: 0, details: [] };
  assetIds.forEach(function (assetId) {
    try {
      const assetFound = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
      if (!assetFound) throw new Error('Asset not found.');
      const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
      if (!cases.length) throw new Error('Lifecycle case not found.');
      const caseRecord = cases[cases.length - 1];
      const fromState = canonicalLifecycleState_(caseRecord.STATE);
      if (allowedStates.indexOf(fromState) === -1) {
        result.skipped += 1;
        result.details.push({ assetId: assetId, status: 'SKIPPED', reason: actor.role === 'ASSET_RESPONDER'
          ? 'Record the contest before submitting the approved exception ID.'
          : 'The case cannot be exempted from ' + fromState + '.' });
        return;
      }
      const contestedExceptionId = cleanText_(caseRecord.CONTEST_REFERENCE).toUpperCase();
      if (contestedExceptionId && contestedExceptionId !== exceptionId) {
        throw new Error('The approved exception ID must match the ID used to record the contest: ' + contestedExceptionId + '.');
      }
      upsertExceptionForAsset_({
        EXCEPTION_ID: exceptionId,
        ASSET_ID: assetId,
        PLATFORM: assetFound.value.PLATFORM,
        CASE_ID: caseRecord.CASE_ID,
        TYPE: cleanText_(payload.type || 'BUSINESS'),
        STATUS: 'APPROVED',
        OWNER: actor.email,
        JUSTIFICATION: cleanText_(payload.justification || caseRecord.CONTEST_REASON),
        REVIEW_CADENCE: cleanText_(payload.reviewCadence),
        REQUESTED_AT: caseRecord.CONTESTED_AT || nowIso_(),
        APPROVED_AT: nowIso_(),
        EXPIRES_AT: cleanText_(payload.expiresAt),
        SOURCE_URL: cleanText_(payload.sourceUrl),
        LAST_SYNCED_AT: nowIso_()
      });
      caseRecord.STATE = APP.lifecycle.exempt;
      caseRecord.EXCEPTION_ID = exceptionId;
      caseRecord.EXCEPTION_STATUS = 'APPROVED';
      caseRecord.LAST_TRANSITION_AT = nowIso_();
      caseRecord.NOTES = 'Approved exception recorded; deprecation actions are suppressed.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(assetId, caseRecord.STATE, caseRecord);
      cancelPendingPlatformActionsForAsset_(assetId, 'Approved exception ' + exceptionId + ' recorded.');
      logEvent_(caseRecord.CASE_ID, assetId, 'EXCEPTION_APPROVED', fromState, APP.lifecycle.exempt, '', {
        actor: actor.email, exceptionId: exceptionId, expiresAt: cleanText_(payload.expiresAt)
      });
      result.processed += 1;
      result.details.push({ assetId: assetId, status: 'PROCESSED', toState: APP.lifecycle.exempt, exceptionId: exceptionId });
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: assetId, status: 'FAILED', reason: error.message || String(error) });
    }
  });
  return result;
}

function normalizeApprovedExceptionId_(value) {
  const exceptionId = cleanText_(value).toUpperCase();
  if (!exceptionId) throw new Error('An approved exception ID is required to complete the contest.');
  if (!/^EDG-EXC-\d{4}-\d{3,}$/.test(exceptionId)) {
    throw new Error('Approved exception IDs must use the format EDG-EXC-2026-009.');
  }
  return exceptionId;
}

function normalizeExceptionRequestId_(value) {
  const exceptionId = cleanText_(value).toUpperCase();
  if (!exceptionId) throw new Error('Submit an exception request and provide its generated exception ID before contesting.');
  if (!/^EDG-EXC-\d{4}-\d{3,}$/.test(exceptionId)) {
    throw new Error('Exception IDs must use the format EDG-EXC-2026-009.');
  }
  return exceptionId;
}

function registerException(input) {
  const payload = input || {};
  if (!cleanText_(payload.exceptionId)) throw new Error('An exception ID is required.');
  if (cleanText_(payload.status).toUpperCase() === 'APPROVED') {
    return markAssetsExempt({
      assetIds: [payload.assetId], exceptionId: payload.exceptionId, type: payload.type,
      justification: payload.justification, reviewCadence: payload.reviewCadence,
      expiresAt: payload.expiresAt, sourceUrl: payload.sourceUrl
    });
  }
  return contestAssets({
    assetIds: [payload.assetId],
    reason: payload.justification || 'Exception request is under review.',
    exceptionId: payload.exceptionId
  });
}

function assertAssetsResponseAuthorization_(assetIds) {
  const email = getCurrentUserEmail_();
  const role = getUserRole_(email);
  const accessEmails = getUserAccessEmails_(email, role);
  (assetIds || []).forEach(function (assetId) {
    const found = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
    if (!found || !canAccessAssetWithEmails_(found.value, accessEmails)) {
      throw new Error('One or more assets were not found or you do not have access to them.');
    }
  });
  return { email: email, role: ['ADMIN', 'OPERATOR'].indexOf(role) !== -1 ? role : 'ASSET_RESPONDER' };
}

function assertAssetResponseAuthorization_(assetId) {
  const email = getCurrentUserEmail_();
  const role = getUserRole_(email);
  const found = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
  if (!found) throw new Error('This asset was not found or you do not have access to it.');
  if (canUserRespondToAsset_(found.value, email, role)) {
    return { email: email, role: ['ADMIN', 'OPERATOR'].indexOf(role) !== -1 ? role : 'ASSET_RESPONDER' };
  }
  throw new Error('This asset was not found or you do not have access to it.');
}

function canUserRespondToAsset_(asset, email, role) {
  return canUserViewAsset_(asset, email, role);
}

function extractEmails_(values) {
  const seen = {};
  (values || []).forEach(function (value) {
    cleanText_(value).split(/[;,\s]+/).forEach(function (part) {
      const email = cleanText_(part).toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) seen[email] = true;
    });
  });
  return Object.keys(seen);
}

function cancelPendingPlatformActionsForAsset_(assetId, reason) {
  const updates = readObjectsByField_(APP.sheets.platformActions, 'ASSET_ID', assetId, 50).filter(function (action) {
    return ['QUARANTINE', 'PURGE', 'RESTORE'].indexOf(cleanText_(action.ACTION).toUpperCase()) !== -1 &&
      ['READY', 'EXPORTED', 'ACCEPTED', 'FAILED'].indexOf(cleanText_(action.STATUS).toUpperCase()) !== -1;
  }).map(function (action) {
    action.STATUS = 'CANCELLED';
    action.ERROR = cleanText_(reason);
    return action;
  });
  updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
  return updates.length;
}

function upsertExceptionForAsset_(record) {
  const sheet = getSheet_(APP.sheets.exceptions);
  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues() : [];
  const exceptionIndex = headers.indexOf('EXCEPTION_ID');
  const assetIndex = headers.indexOf('ASSET_ID');
  let rowNumber = 0;
  values.some(function (row, index) {
    if (cleanText_(row[exceptionIndex]) === record.EXCEPTION_ID && cleanText_(row[assetIndex]) === record.ASSET_ID) {
      rowNumber = index + 2;
      return true;
    }
    return false;
  });
  const row = objectToRow_(headers, record);
  if (rowNumber) sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
  else appendRawRows_(APP.sheets.exceptions, [row]);
}
