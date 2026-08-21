const SNOWFLAKE_V2_REQUIRED_HEADERS = Object.freeze([
  'TABLE_FQN', 'DATABASE_NAME', 'SCHEMA_NAME', 'TABLE_NAME', 'TABLE_TYPE',
  'SNOWFLAKE_TABLE_OWNER', 'SF_DPM_TEAM', 'SF_BDS_TEAM',
  'SF_BUSINESS_STEWARD', 'SF_TECHNICAL_STEWARD', 'OWNERSHIP_STATUS',
  'OWNERSHIP_SOURCE', 'SF_DOMAIN', 'SF_SUB_DOMAIN', 'ROW_COUNT', 'BYTES',
  'LAST_READ', 'LAST_WRITE', 'LAST_LOAD', 'LAST_ALTERED',
  'SOURCE_SNAPSHOT_AT', 'SNOWFLAKE_DATA_STATUS'
]);

function importStateProperty_(environment) {
  return APP.importStateProperty + '_' + normalizeEnvironment_(environment || getActiveEnvironment_());
}

function getImportState_(environment) {
  const raw = PropertiesService.getScriptProperties().getProperty(importStateProperty_(environment));
  return raw ? JSON.parse(raw) : null;
}

function setImportState_(state) {
  PropertiesService.getScriptProperties().setProperty(importStateProperty_(state.environment), JSON.stringify(state));
}

function clearImportState_(environment) {
  PropertiesService.getScriptProperties().deleteProperty(importStateProperty_(environment));
}

function getAnyImportState_() {
  return getImportState_('DEV') || getImportState_('PRD');
}

function getImportStatus() {
  const state = getImportState_();
  if (state) {
    const completed = state.phase === 'IMPORT' ? Number(state.processedRows || Math.max(0, state.cursorRow - 2)) : state.sourceRows;
    return {
      running: true,
      environment: state.environment,
      runId: state.runId,
      phase: state.phase,
      completed: completed,
      processedRows: Number(state.processedRows || completed || 0),
      total: state.sourceRows,
      percent: state.sourceRows ? Math.min(100, Math.round(completed * 100 / state.sourceRows)) : 0,
      candidates: Number(state.writtenRows || 0),
      writtenRows: Number(state.writtenRows || 0),
      errors: Number(state.errors || 0),
      fileName: state.sourceFileName || '',
      startedAt: state.startedAt || '',
      message: state.message || ''
    };
  }
  const jobs = readObjects_(APP.sheets.jobs);
  const latest = jobs.length ? jobs[jobs.length - 1] : null;
  return {
    running: false,
    environment: getActiveEnvironment_(),
    runId: latest ? latest.RUN_ID : '',
    phase: latest ? latest.STATUS : 'NOT_RUN',
    completed: latest ? Number(latest.PROCESSED_ROWS || 0) : 0,
    processedRows: latest ? Number(latest.PROCESSED_ROWS || 0) : 0,
    total: latest ? Number(latest.SOURCE_ROWS || 0) : 0,
    candidates: latest ? Number(latest.WRITTEN_ROWS || 0) : 0,
    writtenRows: latest ? Number(latest.WRITTEN_ROWS || 0) : 0,
    errors: latest ? Number(latest.ERROR_COUNT || 0) : 0,
    fileName: '',
    startedAt: latest ? latest.STARTED_AT : '',
    percent: latest && Number(latest.SOURCE_ROWS) ? Math.round(Number(latest.PROCESSED_ROWS) * 100 / Number(latest.SOURCE_ROWS)) : 0,
    message: latest ? latest.MESSAGE : 'No import has run.'
  };
}

function intakeReviewProperty_(environment) {
  return APP.intakeReviewProperty + '_' + normalizeEnvironment_(environment || getActiveEnvironment_());
}

function getPendingIntakeReview_(environment) {
  const raw = PropertiesService.getScriptProperties().getProperty(intakeReviewProperty_(environment));
  return raw ? JSON.parse(raw) : null;
}

function setPendingIntakeReview_(review) {
  PropertiesService.getScriptProperties().setProperty(intakeReviewProperty_(review.environment), JSON.stringify(review));
}

function clearPendingIntakeReview_(environment) {
  PropertiesService.getScriptProperties().deleteProperty(intakeReviewProperty_(environment));
}

function stageSnowflakeCsvUpload(formObject) {
  const actor = assertAdmin_();
  const profile = assertEnvironmentWritable_();
  if (!profile.importEnabled) throw new Error(profile.label + ' imports are disabled.');
  if (getAnyImportState_()) throw new Error('An import is already running. Wait for it to finish before uploading another file.');
  const blob = formObject && formObject.intakeFile;
  if (!blob || typeof blob.getBytes !== 'function') throw new Error('Choose a CSV file to import.');
  const fileName = cleanText_(blob.getName && blob.getName()) || 'Snowflake intake.csv';
  if (!/\.csv$/i.test(fileName)) throw new Error('The intake must be a .csv file.');
  const bytes = blob.getBytes();
  const maximumBytes = 15 * 1024 * 1024;
  if (!bytes.length) throw new Error('The selected CSV file is empty.');
  if (bytes.length > maximumBytes) throw new Error('The CSV is larger than the 15 MB intake limit.');
  const csvText = blob.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
  const parsed = Utilities.parseCsv(csvText);
  if (parsed.length < 2) throw new Error('The CSV must contain a header row and at least one data row.');
  const headers = parsed.shift().map(function (value) { return cleanText_(value).toUpperCase(); });
  validateSnowflakeV2Headers_(headers);
  const rows = parsed.filter(function (row) { return row.some(function (value) { return cleanText_(value); }); });
  const review = calculateIntakeReview_(headers, rows, {
    fileName: fileName,
    fileSizeBytes: bytes.length,
    uploadedBy: actor.email,
    environment: profile.key
  });
  const sheet = writeIntakeUploadSheet_(headers, rows, profile.key);
  review.token = uuid_();
  review.sourceSpreadsheetId = APP.foundationSpreadsheetId;
  review.sourceSheetName = sheet.getName();
  review.headerSignature = headers.join('|');
  review.uploadedAt = nowIso_();
  review.reviewedAt = review.uploadedAt;
  setPendingIntakeReview_({
    token: review.token,
    environment: review.environment,
    sourceSpreadsheetId: review.sourceSpreadsheetId,
    sourceSheetName: review.sourceSheetName,
    sourceRows: review.sourceRows,
    sourceColumns: review.sourceColumns,
    headerSignature: review.headerSignature,
    sourceSnapshotAt: review.sourceSnapshotAt,
    fileName: review.fileName,
    fileSizeBytes: review.fileSizeBytes,
    uploadedBy: review.uploadedBy,
    uploadedAt: review.uploadedAt,
    candidates: review.candidates,
    unassessable: review.unassessable,
    newCandidates: review.newCandidates,
    changedCandidates: review.changedCandidates,
    unchangedCandidates: review.unchangedCandidates,
    noLongerCandidates: review.noLongerCandidates,
    missingFromExtract: review.missingFromExtract,
    expectedPurges: review.expectedPurges,
    expectedSelfPurges: review.expectedSelfPurges,
    newlyStaleRecords: review.newlyStaleRecords,
    existingLifecycleChanges: review.existingLifecycleChanges,
    quarantinePurgeChanges: review.quarantinePurgeChanges,
    notificationAssets: review.notificationAssets,
    restrictedAssets: review.restrictedAssets,
    initialRestrictedAssets: review.initialRestrictedAssets,
    restrictionTransitions: review.restrictionTransitions,
    restrictionCleared: review.restrictionCleared,
    quarantineNotificationAssets: review.quarantineNotificationAssets,
    quarantineNotificationGroups: review.quarantineNotificationGroups,
    restorationNotificationAssets: review.restorationNotificationAssets,
    restorationNotificationGroups: review.restorationNotificationGroups
  });
  return review;
}

function calculateIntakeReview_(headers, rows, metadata) {
  const headerMap = validateSnowflakeV2Headers_(headers);
  const reviewSampleLimit = Math.max(20, Number(metadata && metadata.reviewSampleLimit) || 250);
  const currentAssets = indexObjectsBy_(readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const cases = loadCaseMap_();
  const completedPurgeActions = {};
  readObjects_(APP.sheets.platformActions).forEach(function (action) {
    if (cleanText_(action.ACTION).toUpperCase() === 'PURGE' && cleanText_(action.STATUS).toUpperCase() === 'COMPLETED') {
      completedPurgeActions[action.ASSET_ID] = true;
    }
  });
  const candidateIds = {};
  const managedImportIds = {};
  const fullFqns = {};
  const duplicateCandidates = {};
  const tableTypes = {};
  const domains = {};
  const notificationRecipients = {};
  const quarantineNotificationRecipients = {};
  const restorationNotificationRecipients = {};
  const newItems = [];
  const changedItems = [];
  const unchangedItems = [];
  const initialRestrictionItems = [];
  const restrictionItems = [];
  const restrictionClearedItems = [];
  const reappearanceItems = [];
  const unassessableItems = [];
  let candidates = 0;
  let belowThreshold = 0;
  let restrictedAssets = 0;
  let initialRestrictedAssets = 0;
  let restrictionTransitions = 0;
  let restrictionCleared = 0;
  let invalidIdentifiers = 0;
  let missingContact = 0;
  let missingDomain = 0;
  let notificationAssets = 0;
  let unassessable = 0;
  let expectedPurges = 0;
  let expectedSelfPurges = 0;
  let sourceSnapshotAt = '';

  rows.forEach(function (row) {
    const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(row, headerMap, 'TABLE_NAME');
    const fqn = (sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
    if (!fqn) {
      invalidIdentifiers += 1;
      return;
    }
    fullFqns[fqn] = true;
    const snapshot = sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT');
    if (snapshot > sourceSnapshotAt) sourceSnapshotAt = snapshot;
    const assetId = 'SNOWFLAKE|' + fqn;
    const existing = currentAssets[assetId];
    const caseRecord = cases[assetId];
    const currentState = canonicalLifecycleState_(caseRecord && caseRecord.STATE);
    const businessSteward = sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD');
    const technicalSteward = sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD');
    const contact = firstEmail_([businessSteward, technicalSteward]);
    const sourceDataStatus = normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS'));
    const isRestricted = sourceDataStatus === APP.lifecycle.restricted;
    const wasRestricted = normalizedSnowflakeDataStatus_(existing && existing.SNOWFLAKE_DATA_STATUS) === APP.lifecycle.restricted;
    const hasExistingBaseline = Boolean(existing || caseRecord);
    const isInitialRestriction = isRestricted && !hasExistingBaseline;
    const activity = deriveSourceActivity_(row, headerMap, snapshot || metadata.sourceSnapshotAt || nowIso_(),
      configNumber_('STALE_THRESHOLD_DAYS', 180));
    const summary = intakeAssetSummary_(row, headerMap, assetId, fqn, activity);
    summary.lifecycleState = currentState;
    summary.dismissible = activity.isStale && !isRestricted && isIntakeDismissibleState_(currentState);
    const isReappearance = currentState === APP.lifecycle.purged;
    if (isReappearance) {
      const restorationRecipient = getEnvironmentProfile_().recipientLock || contact || cleanText_(getConfig_().EDG_OPERATIONS_RECIPIENT).toLowerCase();
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'Previously purged asset reappeared → Restored';
      summary.messageType = 'RESTORATION_CONFIRMED';
      summary.primaryRecipient = restorationRecipient || 'No Slack recipient';
      summary.dismissible = false;
      reappearanceItems.push(summary);
      if (restorationRecipient) restorationNotificationRecipients[restorationRecipient] = true;
    }
    if (!activity.assessable) {
      unassessable += 1;
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'No valid activity timestamp was available; no stale designation will be made.';
      unassessableItems.push(summary);
    }
    if (isRestricted || activity.isStale || currentState === APP.lifecycle.selfPurgePending) managedImportIds[assetId] = true;
    if (isRestricted && !isReappearance) {
      restrictedAssets += 1;
      if ([APP.lifecycle.quarantined, APP.lifecycle.purgeEligible, APP.lifecycle.selfPurgePending].indexOf(currentState) === -1) {
        const restrictionRecipient = getEnvironmentProfile_().recipientLock || contact || cleanText_(getConfig_().EDG_OPERATIONS_RECIPIENT).toLowerCase();
        summary.messageType = !contact && ['ORPHANED', 'UNKNOWN'].indexOf(cleanText_(summary.ownershipStatus).toUpperCase()) !== -1
          ? 'ORPHAN_QUARANTINE_NOTICE' : 'QUARANTINE_NOTICE';
        summary.primaryRecipient = restrictionRecipient || 'No Slack recipient';
        if (isInitialRestriction) {
          initialRestrictedAssets += 1;
          summary.reviewGroup = 'QUARANTINE_PURGE';
          summary.changeSummary = 'First observed source status is RESTRICTED; asset will enter the lifecycle as QUARANTINED';
          initialRestrictionItems.push(summary);
        } else {
          restrictionTransitions += 1;
          summary.reviewGroup = 'QUARANTINE_PURGE';
          summary.changeSummary = 'Snowflake data status: ' + (existing ? (existing.SNOWFLAKE_DATA_STATUS || 'ACTIVE') : (currentState || 'EXISTING CASE')) + ' → RESTRICTED; lifecycle will become QUARANTINED';
          restrictionItems.push(summary);
        }
        if (restrictionRecipient) quarantineNotificationRecipients[restrictionRecipient] = true;
      }
    } else if (wasRestricted && !isReappearance) {
      restrictionCleared += 1;
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'Snowflake data status: RESTRICTED → ' + sourceDataStatus + '; lifecycle is not restored automatically';
      restrictionClearedItems.push(summary);
    }
    if (!activity.isStale) {
      belowThreshold += 1;
      return;
    }
    candidates += 1;
    if (candidateIds[assetId]) duplicateCandidates[assetId] = true;
    candidateIds[assetId] = true;
    const domain = sourceValue_(row, headerMap, 'SF_DOMAIN');
    if (!contact) missingContact += 1;
    if (!domain) missingDomain += 1;
    incrementCount_(tableTypes, sourceValue_(row, headerMap, 'TABLE_TYPE') || 'UNKNOWN');
    incrementCount_(domains, domain || 'UNASSIGNED');
    const opensNewCase = !caseRecord || [APP.lifecycle.dismissed, APP.lifecycle.restored, APP.lifecycle.active].indexOf(currentState) !== -1;
    summary.opensNewCase = opensNewCase;
    if (isInitialRestriction) {
      // Reviewed above as an initial source condition; do not also classify it as new or changed.
    } else if (!existing) {
      newItems.push(summary);
    } else {
      const changes = materialIntakeChanges_(existing, row, headerMap);
      summary.changes = changes;
      if (changes.length) changedItems.push(summary);
      else unchangedItems.push(summary);
    }
    if (opensNewCase && !isRestricted) {
      const profile = getEnvironmentProfile_();
      const recipient = profile.recipientLock || contact || cleanText_(getConfig_().EDG_OPERATIONS_RECIPIENT).toLowerCase();
      const isOrphan = !contact && ['ORPHANED', 'UNKNOWN'].indexOf(cleanText_(summary.ownershipStatus).toUpperCase()) !== -1;
      if (isOrphan) {
        summary.messageType = 'None until quarantine is confirmed';
        summary.primaryRecipient = recipient || 'EDG recipient not configured';
      } else {
        notificationAssets += 1;
        summary.messageType = 'STALE_ASSET_NOTICE';
        summary.primaryRecipient = recipient || 'No Slack recipient';
        if (recipient) notificationRecipients[recipient] = true;
      }
    }
  });
  if (Object.keys(duplicateCandidates).length) {
    throw new Error('The intake contains ' + Object.keys(duplicateCandidates).length + ' duplicate stale-candidate FQN values. Correct the file before EDG review.');
  }

  const noLonger = [];
  const missing = [];
  Object.keys(currentAssets).forEach(function (assetId) {
    const asset = currentAssets[assetId];
    const currentAssetStatus = deriveAssetStatus_(asset);
    if (managedImportIds[assetId]) return;
    const caseRecord = cases[assetId] || {};
    const currentState = canonicalLifecycleState_(caseRecord.STATE || asset.LIFECYCLE_STATE);
    if ([APP.assetStatus.stale, APP.assetStatus.quarantined].indexOf(currentAssetStatus) === -1 && currentState !== APP.lifecycle.selfPurgePending) return;
    const item = {
      assetId: assetId,
      fqn: asset.OBJECT_FQN,
      type: asset.ASSET_TYPE,
      domain: asset.DOMAIN || 'UNASSIGNED',
      lifecycleState: currentState,
      assetStatus: currentAssetStatus,
      messageType: '',
      primaryRecipient: ''
    };
    if (fullFqns[cleanText_(asset.OBJECT_FQN).toUpperCase()]) {
      if (currentAssetStatus === APP.assetStatus.stale) {
        item.changeSummary = 'Application activity analysis changed from STALE to ACTIVE';
        noLonger.push(item);
      }
    } else {
      const purgeDue = caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= new Date();
      const willVerifyPurge = [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(currentState) !== -1 &&
        Boolean(completedPurgeActions[assetId]) && Boolean(purgeDue);
      const willVerifySelfPurge = currentState === APP.lifecycle.selfPurgePending;
      if (willVerifyPurge || willVerifySelfPurge) {
        if (willVerifySelfPurge) expectedSelfPurges += 1;
        else expectedPurges += 1;
        item.purgeVerification = true;
        item.changeSummary = willVerifySelfPurge
          ? 'Absent after owner self-purge intent; publication will verify PURGED'
          : 'Absent after completed purge handoff; publication will verify PURGED';
        item.messageType = willVerifySelfPurge ? 'None — owner self-service' : 'PURGE_COMPLETED';
        item.primaryRecipient = willVerifySelfPurge ? 'No notification' : (getEnvironmentProfile_().recipientLock || firstEmail_([
          asset.BUSINESS_STEWARD, asset.TECHNICAL_STEWARD, asset.RECORD_OWNER
        ]) || 'No Slack recipient');
      } else {
        item.purgeVerification = false;
        item.changeSummary = 'Not present in the uploaded complete extract; lifecycle will be retained for reconciliation';
      }
      missing.push(item);
    }
  });

  const newlyStaleRecords = newItems.concat(changedItems).filter(function (item) {
    return !item.reviewGroup && item.opensNewCase;
  }).length;
  const existingLifecycleChanges = noLonger.length + reappearanceItems.length;
  const quarantinePurgeChanges = initialRestrictionItems.length + restrictionItems.length + missing.filter(function (item) {
    return item.purgeVerification;
  }).length;

  return {
    environment: metadata.environment,
    fileName: metadata.fileName,
    fileSizeBytes: metadata.fileSizeBytes,
    uploadedBy: metadata.uploadedBy,
    sourceRows: rows.length,
    sourceColumns: headers.length,
    sourceSnapshotAt: sourceSnapshotAt,
    candidates: candidates,
    belowThreshold: belowThreshold,
    unassessable: unassessable,
    restrictedAssets: restrictedAssets,
    initialRestrictedAssets: initialRestrictedAssets,
    restrictionTransitions: restrictionTransitions,
    restrictionCleared: restrictionCleared,
    newCandidates: newItems.length,
    changedCandidates: changedItems.length,
    unchangedCandidates: unchangedItems.length,
    noLongerCandidates: noLonger.length,
    missingFromExtract: missing.length,
    expectedPurges: expectedPurges,
    expectedSelfPurges: expectedSelfPurges,
    newlyStaleRecords: newlyStaleRecords,
    existingLifecycleChanges: existingLifecycleChanges,
    quarantinePurgeChanges: quarantinePurgeChanges,
    notificationAssets: notificationAssets,
    notificationGroups: Object.keys(notificationRecipients).length,
    quarantineNotificationAssets: initialRestrictedAssets + restrictionTransitions,
    quarantineNotificationGroups: Object.keys(quarantineNotificationRecipients).length,
    restorationNotificationAssets: reappearanceItems.length,
    restorationNotificationGroups: Object.keys(restorationNotificationRecipients).length,
    invalidIdentifiers: invalidIdentifiers,
    duplicateFqns: 0,
    missingContact: missingContact,
    missingDomain: missingDomain,
    tableTypes: countMapToArray_(tableTypes),
    domains: countMapToArray_(domains),
    samples: {
      initialRestrictions: initialRestrictionItems.slice(0, reviewSampleLimit),
      newCandidates: newItems.slice(0, reviewSampleLimit),
      changedCandidates: changedItems.slice(0, reviewSampleLimit),
      restrictionTransitions: restrictionItems.slice(0, reviewSampleLimit),
      restrictionCleared: restrictionClearedItems.slice(0, reviewSampleLimit),
      reappearances: reappearanceItems.slice(0, reviewSampleLimit),
      unassessable: unassessableItems.slice(0, reviewSampleLimit),
      noLongerCandidates: noLonger.slice(0, reviewSampleLimit),
      missingFromExtract: missing.slice(0, reviewSampleLimit)
    }
  };
}

function isIntakeDismissibleState_(state) {
  const current = canonicalLifecycleState_(state);
  return !current || [
    APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested,
    APP.lifecycle.accepted, APP.lifecycle.selfPurgePending, APP.lifecycle.exempt, APP.lifecycle.active,
    APP.lifecycle.restored, APP.lifecycle.dismissed
  ].indexOf(current) !== -1;
}

function intakeAssetSummary_(row, headerMap, assetId, fqn, activity) {
  const derived = activity || deriveSourceActivity_(row, headerMap,
    sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT') || nowIso_(), configNumber_('STALE_THRESHOLD_DAYS', 180));
  return {
    assetId: assetId,
    fqn: fqn,
    type: sourceValue_(row, headerMap, 'TABLE_TYPE') || 'UNKNOWN',
    domain: sourceValue_(row, headerMap, 'SF_DOMAIN') || 'UNASSIGNED',
    subDomain: sourceValue_(row, headerMap, 'SF_SUB_DOMAIN'),
    snowflakeDataStatus: normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')),
    ownershipStatus: sourceValue_(row, headerMap, 'OWNERSHIP_STATUS') || 'UNKNOWN',
    primarySteward: firstEmail_([
      sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD'),
      sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD')
    ]) || 'No Slack email',
    daysInactive: derived.daysInactive === null ? 'Signal gap' : derived.daysInactive,
    assetStatus: normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')) === APP.lifecycle.restricted
      ? APP.assetStatus.quarantined : (derived.isStale ? APP.assetStatus.stale : APP.assetStatus.active),
    activitySource: derived.source,
    messageType: '',
    primaryRecipient: ''
  };
}

function materialIntakeChanges_(asset, row, headerMap) {
  const comparisons = [
    ['Asset type', asset.ASSET_TYPE, sourceValue_(row, headerMap, 'TABLE_TYPE')],
    ['Snowflake owner', asset.SNOWFLAKE_TABLE_OWNER || asset.DATABASE_OWNER, sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER')],
    ['Snowflake data status', normalizedSnowflakeDataStatus_(asset.SNOWFLAKE_DATA_STATUS), normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS'))],
    ['DPM team', asset.DPM_TEAM, sourceValue_(row, headerMap, 'SF_DPM_TEAM')],
    ['BDS team', asset.BDS_TEAM, sourceValue_(row, headerMap, 'SF_BDS_TEAM')],
    ['Business steward', asset.BUSINESS_STEWARD, sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD')],
    ['Technical steward', asset.TECHNICAL_STEWARD, sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD')],
    ['Ownership status', asset.OWNERSHIP_STATUS, sourceValue_(row, headerMap, 'OWNERSHIP_STATUS')],
    ['Ownership source', asset.OWNERSHIP_SOURCE, sourceValue_(row, headerMap, 'OWNERSHIP_SOURCE')],
    ['Domain', asset.DOMAIN, sourceValue_(row, headerMap, 'SF_DOMAIN')],
    ['Sub-domain', asset.SUB_DOMAIN, sourceValue_(row, headerMap, 'SF_SUB_DOMAIN')],
    ['Last activity', asset.LAST_ACTIVITY_TS || asset.ESTIMATED_LAST_ACTIVITY_DATE, sourceValue_(row, headerMap, 'LAST_ACTIVITY_TS')],
    ['Last read', asset.LAST_READ, sourceValue_(row, headerMap, 'LAST_READ')],
    ['Last write', asset.LAST_WRITE, sourceValue_(row, headerMap, 'LAST_WRITE')],
    ['Last load', asset.LAST_LOAD, sourceValue_(row, headerMap, 'LAST_LOAD')],
    ['Last altered', asset.LAST_ALTERED, sourceValue_(row, headerMap, 'LAST_ALTERED')],
    ['Stale 365', asset.IS_STALE_365, sourceValue_(row, headerMap, 'IS_STALE_365')],
    ['Rows', asset.ROW_COUNT, sourceValue_(row, headerMap, 'ROW_COUNT')],
    ['Bytes', asset.BYTES, sourceValue_(row, headerMap, 'BYTES')]
  ];
  return comparisons.filter(function (item) {
    return normalizedComparisonValue_(item[1]) !== normalizedComparisonValue_(item[2]);
  }).map(function (item) {
    return { field: item[0], before: cleanText_(item[1]) || '—', after: cleanText_(item[2]) || '—' };
  });
}

function normalizedComparisonValue_(value) {
  return cleanText_(value).replace(/,/g, '').toUpperCase();
}

function writeIntakeUploadSheet_(headers, rows, environment) {
  const spreadsheet = getFoundationSpreadsheet_();
  const sheetName = resolveSheetName_(APP.sheets.intakeUpload, environment);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  ensureSheetCapacity_(sheet, rows.length + 1, headers.length);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const chunkSize = 2000;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize).map(function (row) {
      const copy = row.slice(0, headers.length);
      while (copy.length < headers.length) copy.push('');
      return copy;
    });
    sheet.getRange(offset + 2, 1, chunk.length, headers.length).setValues(chunk);
  }
  sheet.hideSheet();
  SpreadsheetApp.flush();
  return sheet;
}

function discardSnowflakeIntake(reviewToken) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  if (getAnyImportState_()) throw new Error('The intake is already publishing and cannot be discarded.');
  const review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(reviewToken)) throw new Error('This intake review is no longer current.');
  const sheet = getFoundationSpreadsheet_().getSheetByName(review.sourceSheetName);
  if (sheet) sheet.clearContents();
  clearPendingIntakeReview_(profile.key);
  return { discarded: true };
}

function reviewSnowflakeIntake() {
  assertAdmin_();
  const review = getPendingIntakeReview_();
  if (!review) throw new Error('Upload a CSV with Import & Refresh Data to begin intake review.');
  return review;
}

function confirmSnowflakeIntake(reviewInput) {
  const actor = assertAdmin_();
  const payload = reviewInput && typeof reviewInput === 'object' ? reviewInput : { token: reviewInput };
  const profile = assertEnvironmentWritable_();
  let review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(payload.token)) throw new Error('This intake review is no longer current. Upload the CSV again.');
  review = applyIntakeReviewDecisions_(review, payload.dismissedAssetIds || []);
  return startSnowflakeImportInternal_(actor, review.token);
}

function startSnowflakeImport(reviewToken) {
  return confirmSnowflakeIntake(reviewToken);
}

function applyIntakeReviewDecisions_(review, dismissedAssetIds) {
  const ids = Array.from(new Set((dismissedAssetIds || []).map(cleanText_).filter(Boolean)));
  if (ids.length > 5000) throw new Error('A single intake review can dismiss at most 5,000 candidates.');
  const selected = {};
  ids.forEach(function (assetId) { selected[assetId] = true; });
  const source = SpreadsheetApp.openById(review.sourceSpreadsheetId).getSheetByName(review.sourceSheetName);
  if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
  const originalWidth = source.getLastColumn();
  const headers = source.getRange(1, 1, 1, originalWidth).getDisplayValues()[0].map(function (value) {
    return cleanText_(value).toUpperCase();
  });
  const headerMap = validateSnowflakeV2Headers_(headers);
  let decisionIndex = headers.indexOf('EDG_REVIEW_DECISION');
  if (decisionIndex === -1 && !ids.length) return review;
  if (decisionIndex === -1) {
    decisionIndex = headers.length;
    headers.push('EDG_REVIEW_DECISION');
    ensureSheetCapacity_(source, Math.max(2, source.getMaxRows()), headers.length);
    source.getRange(1, decisionIndex + 1).setValue('EDG_REVIEW_DECISION');
  }
  const rowCount = Math.max(0, source.getLastRow() - 1);
  const rows = rowCount ? source.getRange(2, 1, rowCount, headers.length).getDisplayValues() : [];
  const cases = loadCaseMap_();
  const accepted = {};
  const decisionValues = rows.map(function (row) {
    const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(row, headerMap, 'TABLE_NAME');
    const fqn = (sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
    const assetId = fqn ? 'SNOWFLAKE|' + fqn : '';
    if (!selected[assetId]) return [''];
    const snapshot = sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT') || review.sourceSnapshotAt || nowIso_();
    const activity = deriveSourceActivity_(row, headerMap, snapshot, configNumber_('STALE_THRESHOLD_DAYS', 180));
    const restricted = normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')) === APP.lifecycle.restricted;
    const currentState = canonicalLifecycleState_(cases[assetId] && cases[assetId].STATE);
    if (!activity.isStale || restricted || !isIntakeDismissibleState_(currentState)) return [''];
    accepted[assetId] = true;
    return [APP.lifecycle.dismissed];
  });
  const rejected = ids.filter(function (assetId) { return !accepted[assetId]; });
  if (rejected.length) throw new Error(rejected.length + ' selected record' + (rejected.length === 1 ? ' is' : 's are') + ' no longer eligible for dismissal. Refresh the intake review and try again.');
  if (decisionValues.length) source.getRange(2, decisionIndex + 1, decisionValues.length, 1).setValues(decisionValues);
  SpreadsheetApp.flush();
  review.sourceColumns = headers.length;
  review.headerSignature = headers.join('|');
  review.dismissedCandidates = ids.length;
  setPendingIntakeReview_(review);
  return review;
}

function startSnowflakeImportInternal_(actor, reviewToken) {
  const profile = assertEnvironmentWritable_();
  if (!profile.importEnabled) throw new Error(profile.label + ' imports are disabled.');
  const review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(reviewToken)) throw new Error('This intake review is no longer current. Upload the CSV again.');
  if (review.environment !== profile.key) throw new Error('The reviewed intake belongs to a different environment.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (getAnyImportState_()) throw new Error('An import is already running.');
    ensureDataModelV2_();
    const source = SpreadsheetApp.openById(review.sourceSpreadsheetId).getSheetByName(review.sourceSheetName);
    if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
    const sourceRows = Math.max(0, source.getLastRow() - 1);
    const width = source.getLastColumn();
    const headers = source.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (value) {
      return cleanText_(value).toUpperCase();
    });
    validateSnowflakeV2Headers_(headers);
    if (sourceRows !== review.sourceRows || headers.join('|') !== review.headerSignature) {
      throw new Error('The source changed after review. Review the intake again before publishing.');
    }
    const runId = uuid_();
    clearDataRows_(APP.sheets.assetsStaging);
    appendRawRows_(APP.sheets.jobs, [[
      runId, 'SNOWFLAKE_SHEET_IMPORT_V2', 'RUNNING', nowIso_(), '', 2,
      sourceRows, 0, 0, 0, 'Intake approved by ' + actor.email
    ]]);
    const state = {
      environment: profile.key,
      runId: runId,
      reviewToken: review.token,
      sourceSpreadsheetId: review.sourceSpreadsheetId,
      sourceSheetName: review.sourceSheetName,
      sourceFileName: review.fileName,
      phase: 'IMPORT',
      cursorRow: 2,
      sourceRows: sourceRows,
      sourceColumnCount: width,
      sourceHeaders: headers,
      processedRows: 0,
      writtenRows: 0,
      errors: 0,
      startedAt: nowIso_(),
      intakeApprovedAt: nowIso_(),
      snapshotAt: review.sourceSnapshotAt || nowIso_(),
      counts: { state: {}, evaluation: {}, environment: {}, ownership: {}, domain: {} },
      message: 'Publishing reviewed ' + profile.label + ' Snowflake intake'
    };
    setImportState_(state);
    const chunkSize = Math.max(100, configNumber_('IMPORT_CHUNK_SIZE', APP.defaultImportChunkSize));
    const configuredInlineLimit = Math.max(0, configNumber_('INLINE_IMPORT_MAX_ROWS', APP.defaultInlineImportMaxRows));
    const inlineLimit = Math.min(chunkSize, configuredInlineLimit);
    if (sourceRows <= inlineLimit) {
      try {
        importSourceChunk_(state, true);
        return getImportStatus();
      } catch (error) {
        failSnowflakeImport_(state, error);
        throw error;
      }
    }
    scheduleImportContinuation_();
    return getImportStatus();
  } finally {
    lock.releaseLock();
  }
}

function continueSnowflakeImport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    deleteImportContinuationTriggers_();
    const state = getAnyImportState_();
    if (!state) return;
    setExecutionEnvironment_(state.environment, false);
    if (state.phase === 'IMPORT') importSourceChunk_(state);
    else if (state.phase === 'FINALIZE') finalizeImport_(state);
  } catch (error) {
    const state = getAnyImportState_();
    if (state) failSnowflakeImport_(state, error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function failSnowflakeImport_(state, error) {
  setExecutionEnvironment_(state.environment, false);
  updateJobRun_(state.runId, {
    STATUS: 'FAILED', COMPLETED_AT: nowIso_(), ERROR_COUNT: Number(state.errors || 0) + 1,
    MESSAGE: String(error && error.message ? error.message : error)
  });
  clearImportState_(state.environment);
}

function importSourceChunk_(state, inlineExecution) {
  setExecutionEnvironment_(state.environment, false);
  const source = SpreadsheetApp.openById(state.sourceSpreadsheetId).getSheetByName(state.sourceSheetName);
  if (!source) throw new Error('The staged intake source is no longer available.');
  const headerMap = validateSnowflakeV2Headers_(state.sourceHeaders);
  const chunkSize = Math.max(100, configNumber_('IMPORT_CHUNK_SIZE', APP.defaultImportChunkSize));
  const finalSourceRow = state.sourceRows + 1;
  const count = Math.min(chunkSize, finalSourceRow - state.cursorRow + 1);
  if (count <= 0) {
    beginImportFinalization_(state, inlineExecution);
    return;
  }

  const rows = source.getRange(state.cursorRow, 1, count, state.sourceColumnCount).getDisplayValues();
  const policy = {
    staleThresholdDays: configNumber_('STALE_THRESHOLD_DAYS', 180),
    contestWindowDays: configNumber_('CONTEST_WINDOW_DAYS', 9),
    signalCoverage: 'LAST_READ,LAST_WRITE,LAST_LOAD,LAST_ALTERED'
  };
  const cases = loadCaseMap_();
  const assetRows = [];
  const snapshots = [];
  const newCases = [];
  const updatedCases = [];
  const newEvents = [];

  rows.forEach(function (row, offset) {
    try {
      const result = normalizeSnowflakeRowV2_(row, headerMap, state.cursorRow + offset, state.snapshotAt, state.runId, cases, policy);
      if (!result) return;
      assetRows.push(result.asset);
      snapshots.push(result.snapshot);
      incrementCount_(state.counts.state, result.asset.LIFECYCLE_STATE);
      incrementCount_(state.counts.evaluation, result.asset.EVALUATION_STATUS);
      incrementCount_(state.counts.environment, result.asset.ENVIRONMENT);
      incrementCount_(state.counts.ownership, result.asset.OWNERSHIP_STATUS);
      incrementCount_(state.counts.domain, result.asset.DOMAIN || 'UNASSIGNED');
      if (result.newCase) {
        newCases.push(result.newCase);
        cases[result.newCase.ASSET_ID] = result.newCase;
      }
      if (result.updatedCase) {
        updatedCases.push(result.updatedCase);
        cases[result.updatedCase.ASSET_ID] = result.updatedCase;
      }
      if (result.event) newEvents.push(result.event);
    } catch (error) {
      state.errors += 1;
    }
  });

  appendObjectRows_(APP.sheets.assetsStaging, ASSET_HEADERS, assetRows);
  appendRawRows_(APP.sheets.snapshots, snapshots);
  appendObjectRows_(APP.sheets.cases, CASE_HEADERS, newCases);
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', updatedCases);
  appendRawRows_(APP.sheets.events, newEvents);
  state.cursorRow += count;
  state.processedRows += count;
  state.writtenRows += assetRows.length;
  state.message = 'Evaluated ' + state.processedRows + ' of ' + state.sourceRows + ' source rows; published ' + state.writtenRows + ' candidates or managed cases';
  updateJobRun_(state.runId, {
    CURSOR_ROW: state.cursorRow, PROCESSED_ROWS: state.processedRows,
    WRITTEN_ROWS: state.writtenRows, ERROR_COUNT: state.errors, MESSAGE: state.message
  });
  if (state.cursorRow > finalSourceRow) {
    beginImportFinalization_(state, inlineExecution);
  } else {
    setImportState_(state);
    scheduleImportContinuation_();
  }
}

function beginImportFinalization_(state, inlineExecution) {
  swapAssetBuffers_();
  state.phase = 'FINALIZE';
  state.message = 'Reconciling lifecycle cases and sending initial notifications';
  setImportState_(state);
  if (inlineExecution) finalizeImport_(state);
  else scheduleImportContinuation_();
}

function normalizeSnowflakeRowV2_(row, headerMap, sourceRow, snapshotAt, runId, cases, policy) {
  const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
  const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
  const objectName = sourceValue_(row, headerMap, 'TABLE_NAME');
  if (!database && !schema && !objectName) return null;
  const providedFqn = sourceValue_(row, headerMap, 'TABLE_FQN');
  const objectFqn = (providedFqn || [database, schema, objectName].filter(Boolean).join('.')).toUpperCase();
  if (!objectFqn) return null;
  const assetId = 'SNOWFLAKE|' + objectFqn;
  const sourceSnapshot = sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT') || snapshotAt;
  const activity = deriveSourceActivity_(row, headerMap, sourceSnapshot, policy.staleThresholdDays);
  const isStale180 = activity.isStale;
  const snowflakeDataStatus = normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS'));
  const isRestricted = snowflakeDataStatus === APP.lifecycle.restricted;
  const reviewDecision = sourceValue_(row, headerMap, 'EDG_REVIEW_DECISION').toUpperCase();
  const existing = cases[assetId] || null;
  const existingState = canonicalLifecycleState_(existing && existing.STATE);
  const managedStates = [
    APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested,
    APP.lifecycle.accepted, APP.lifecycle.exempt, APP.lifecycle.quarantined,
    APP.lifecycle.purgeEligible, APP.lifecycle.purged, APP.lifecycle.restored,
    APP.lifecycle.active, APP.lifecycle.dismissed, APP.lifecycle.selfPurgePending
  ];
  if (!isStale180 && !isRestricted && (!existing || managedStates.indexOf(existingState) === -1)) return null;

  const daysActivity = activity.daysInactive;
  const assetType = sourceValue_(row, headerMap, 'TABLE_TYPE').toUpperCase() || 'UNKNOWN';
  const bytes = parseNumber_(sourceValue_(row, headerMap, 'BYTES'));
  const businessSteward = sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD');
  const technicalSteward = sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD');
  const contactEmail = firstEmail_([businessSteward, technicalSteward]);
  const ownershipStatus = sourceValue_(row, headerMap, 'OWNERSHIP_STATUS').toUpperCase() || (contactEmail ? 'PARTIALLY_OWNED' : 'ORPHANED');
  let lifecycleState = existingState || APP.lifecycle.detected;
  let caseValue = existing;
  let newCase = null;
  let updatedCase = null;
  let event = null;

  const opensNewCase = !existing || [APP.lifecycle.dismissed, APP.lifecycle.restored, APP.lifecycle.active].indexOf(existingState) !== -1;
  if (reviewDecision === APP.lifecycle.dismissed && isStale180 && !isRestricted && isIntakeDismissibleState_(existingState)) {
    const fromState = existingState || '';
    caseValue = existing ? Object.assign({}, existing) : buildDetectedCase_(assetId, ownershipStatus, sourceSnapshot, runId);
    caseValue.STATE = APP.lifecycle.dismissed;
    caseValue.LAST_TRANSITION_AT = sourceSnapshot;
    caseValue.LAST_EVALUATION_RUN_ID = runId;
    caseValue.NOTES = 'Candidate dismissed by EDG during reviewed Snowflake intake.';
    lifecycleState = APP.lifecycle.dismissed;
    if (!existing) newCase = caseValue;
    else if (existingState !== APP.lifecycle.dismissed) updatedCase = caseValue;
    if (existingState !== APP.lifecycle.dismissed) {
      event = lifecycleEventRow_(caseValue.CASE_ID, assetId, 'INTAKE_CANDIDATE_DISMISSED', fromState, APP.lifecycle.dismissed, sourceSnapshot, 'EDG_REVIEW', runId, {
        reviewDecision: APP.lifecycle.dismissed
      });
    }
  } else if (existingState === APP.lifecycle.purged) {
    caseValue = Object.assign({}, existing, {
      STATE: APP.lifecycle.restored,
      LAST_TRANSITION_AT: sourceSnapshot,
      LAST_EVALUATION_RUN_ID: runId,
      NOTES: 'A previously purged asset reappeared in the complete Snowflake extract.'
    });
    lifecycleState = APP.lifecycle.restored;
    updatedCase = caseValue;
    event = lifecycleEventRow_(existing.CASE_ID, assetId, 'PURGED_ASSET_REAPPEARED', APP.lifecycle.purged, APP.lifecycle.restored, sourceSnapshot, 'SYSTEM', runId, {
      assetStatus: isRestricted ? APP.assetStatus.quarantined : (isStale180 ? APP.assetStatus.stale : APP.assetStatus.active),
      snowflakeDataStatus: snowflakeDataStatus
    });
  } else if (isRestricted) {
    const fromState = opensNewCase ? '' : existingState;
    caseValue = opensNewCase
      ? buildDetectedCase_(assetId, ownershipStatus, sourceSnapshot, runId)
      : Object.assign({}, existing);
    if (!caseValue.T0) caseValue.T0 = sourceSnapshot;
    caseValue.LAST_EVALUATION_RUN_ID = runId;
    applyQuarantineState_(caseValue, sourceSnapshot,
      'Reviewed Snowflake intake confirmed data status RESTRICTED; the quarantine clock starts at the first verified source snapshot.');
    if (existingState === APP.lifecycle.purgeEligible) caseValue.STATE = APP.lifecycle.purgeEligible;
    if (existingState === APP.lifecycle.selfPurgePending) caseValue.STATE = APP.lifecycle.selfPurgePending;
    lifecycleState = caseValue.STATE;
    if (opensNewCase) newCase = caseValue;
    else if ([APP.lifecycle.quarantined, APP.lifecycle.purgeEligible, APP.lifecycle.selfPurgePending].indexOf(existingState) === -1) updatedCase = caseValue;
    if ([APP.lifecycle.quarantined, APP.lifecycle.purgeEligible, APP.lifecycle.selfPurgePending].indexOf(existingState) === -1) {
      const restrictionEventType = existing ? 'SNOWFLAKE_RESTRICTION_CONFIRMED' : 'SNOWFLAKE_INITIAL_RESTRICTION';
      event = lifecycleEventRow_(caseValue.CASE_ID, assetId, restrictionEventType, fromState, lifecycleState, sourceSnapshot, 'SYSTEM', runId, {
        snowflakeDataStatus: snowflakeDataStatus,
        firstVerifiedRestrictedAt: sourceSnapshot,
        priorState: fromState || 'NO_CASE',
        initialObservation: !existing
      });
    }
  } else if (isStale180 && opensNewCase) {
    caseValue = buildDetectedCase_(assetId, ownershipStatus, sourceSnapshot, runId);
    newCase = caseValue;
    lifecycleState = APP.lifecycle.detected;
    event = lifecycleEventRow_(caseValue.CASE_ID, assetId, 'STALE_DETECTED', '', APP.lifecycle.detected, sourceSnapshot, 'SYSTEM', runId, {
      policyRule: 'APPLICATION_STALE_THRESHOLD', daysInactive: daysActivity, activitySource: activity.source
    });
  } else if (!isStale180 && existing && [APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted, APP.lifecycle.exempt].indexOf(existingState) !== -1) {
    lifecycleState = APP.lifecycle.active;
    updatedCase = Object.assign({}, existing, {
      STATE: APP.lifecycle.active,
      LAST_TRANSITION_AT: sourceSnapshot,
      LAST_EVALUATION_RUN_ID: runId,
      NOTES: 'Latest complete extract shows qualifying activity inside the stale threshold.'
    });
    caseValue = updatedCase;
    event = lifecycleEventRow_(existing.CASE_ID, assetId, 'STALE_ASSET_BECAME_ACTIVE', existingState, APP.lifecycle.active, sourceSnapshot, 'SYSTEM', runId, {
      daysInactive: daysActivity
    });
  }

  const asset = {
    ASSET_ID: assetId,
    PLATFORM: 'SNOWFLAKE',
    ENVIRONMENT: inferEnvironment_(database, schema),
    DATABASE_NAME: database,
    SCHEMA_NAME: schema,
    OBJECT_NAME: objectName,
    OBJECT_FQN: objectFqn,
    ASSET_TYPE: assetType,
    SIZE_GB: bytes === null ? '' : Math.round(bytes / 1073741824 * 1000) / 1000,
    DAYS_SINCE_LAST_DDL: '',
    DAYS_SINCE_ANY_ACTIVITY: daysActivity,
    ESTIMATED_LAST_ACTIVITY_DATE: activity.lastActivityTs,
    SOURCE_ACTIVITY_STATUS: isRestricted ? 'SNOWFLAKE_DATA_STATUS=RESTRICTED' : (isStale180 ? 'APP_CALCULATED_STALE' : 'APP_CALCULATED_ACTIVE'),
    POLICY_RULE: isRestricted ? 'SNOWFLAKE_DATA_STATUS_RESTRICTED' : 'APPLICATION_STALE_THRESHOLD',
    EVALUATION_STATUS: isStale180 ? 'STALE' : 'MANAGED_CASE',
    STALE_THRESHOLD_DAYS: policy.staleThresholdDays,
    OWNERSHIP_STATUS: ownershipStatus,
    DATABASE_OWNER: sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER'),
    SCHEMA_OWNER: '',
    RECORD_OWNER: contactEmail,
    TECHNICAL_STEWARD: technicalSteward,
    BUSINESS_STEWARD: businessSteward,
    BDS_TEAM: sourceValue_(row, headerMap, 'SF_BDS_TEAM'),
    DPM_TEAM: sourceValue_(row, headerMap, 'SF_DPM_TEAM'),
    EMP_L5: '',
    EMP_L6: '',
    LIFECYCLE_STATE: lifecycleState,
    STALE_DESIGNATION_DATE: caseValue ? caseValue.T0 : '',
    CONTEST_DEADLINE: caseValue ? caseValue.CONTEST_DEADLINE : '',
    QUARANTINE_START_DATE: caseValue ? caseValue.QUARANTINE_START_DATE : '',
    QUARANTINE_EXPIRY_DATE: caseValue ? caseValue.PURGE_ELIGIBLE_DATE : '',
    PURGE_ELIGIBLE_DATE: caseValue ? caseValue.PURGE_ELIGIBLE_DATE : '',
    EXCEPTION_ID: caseValue ? caseValue.EXCEPTION_ID : '',
    EXCEPTION_STATUS: caseValue ? caseValue.EXCEPTION_STATUS : '',
    SOURCE_ROW: sourceRow,
    SNAPSHOT_AT: sourceSnapshot,
    SNOWFLAKE_TABLE_OWNER: sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER'),
    OWNERSHIP_SOURCE: sourceValue_(row, headerMap, 'OWNERSHIP_SOURCE'),
    DOMAIN: sourceValue_(row, headerMap, 'SF_DOMAIN'),
    SUB_DOMAIN: sourceValue_(row, headerMap, 'SF_SUB_DOMAIN'),
    ROW_COUNT: parseNumber_(sourceValue_(row, headerMap, 'ROW_COUNT')),
    BYTES: bytes,
    LAST_READ: sourceValue_(row, headerMap, 'LAST_READ'),
    LAST_WRITE: sourceValue_(row, headerMap, 'LAST_WRITE'),
    LAST_LOAD: sourceValue_(row, headerMap, 'LAST_LOAD'),
    LAST_ALTERED: sourceValue_(row, headerMap, 'LAST_ALTERED'),
    LAST_ACTIVITY_TS: activity.lastActivityTs,
    IS_STALE_90: activity.daysInactive !== null && activity.daysInactive >= 90,
    IS_STALE_180: isStale180,
    IS_STALE_365: activity.daysInactive !== null && activity.daysInactive >= 365,
    SOURCE_SNAPSHOT_AT: sourceSnapshot,
    CONTACT_COVERAGE_STATUS: contactEmail ? 'CONTACTABLE' : 'NO_SLACK_EMAIL',
    SNOWFLAKE_DATA_STATUS: snowflakeDataStatus,
    ASSET_STATUS: deriveAssetStatus_({
      LIFECYCLE_STATE: lifecycleState,
      EVALUATION_STATUS: isStale180 ? 'STALE' : 'MANAGED_CASE',
      IS_STALE_180: isStale180,
      SNOWFLAKE_DATA_STATUS: snowflakeDataStatus
    }),
    CONTEST_REFERENCE: caseValue ? caseValue.CONTEST_REFERENCE : ''
  };
  const snapshot = [
    runId, sourceSnapshot, assetId, 'SNOWFLAKE', asset.EVALUATION_STATUS,
    asset.POLICY_RULE, daysActivity === null ? '' : daysActivity, lifecycleState,
    ownershipStatus, asset.SIZE_GB === '' ? '' : asset.SIZE_GB,
    policy.signalCoverage, sourceRow
  ];
  return { asset: asset, snapshot: snapshot, newCase: newCase, updatedCase: updatedCase, event: event };
}

function validateSnowflakeV2Headers_(headers) {
  const map = {};
  (headers || []).forEach(function (header, index) {
    const key = cleanText_(header).toUpperCase();
    if (key) map[key] = index;
  });
  const missing = SNOWFLAKE_V2_REQUIRED_HEADERS.filter(function (header) { return map[header] === undefined; });
  if (missing.length) throw new Error('The Snowflake intake does not match data model v2. Missing columns: ' + missing.join(', ') + '.');
  return map;
}

function sourceValue_(row, headerMap, header) {
  const index = headerMap[header];
  return index === undefined ? '' : cleanText_(row[index]);
}

function sourceBoolean_(row, headerMap, header) {
  return ['TRUE', '1', 'YES', 'Y'].indexOf(sourceValue_(row, headerMap, header).toUpperCase()) !== -1;
}

function deriveSourceActivity_(row, headerMap, snapshotAt, thresholdDays) {
  const candidates = ['LAST_READ', 'LAST_WRITE', 'LAST_LOAD', 'LAST_ALTERED', 'LAST_ACTIVITY_TS']
    .map(function (header) { return sourceValue_(row, headerMap, header); })
    .filter(Boolean)
    .map(function (value) { return { raw: value, date: new Date(value) }; })
    .filter(function (item) { return !isNaN(item.date.getTime()); })
    .sort(function (left, right) { return right.date.getTime() - left.date.getTime(); });
  const snapshot = new Date(snapshotAt || nowIso_());
  const snapshotDate = isNaN(snapshot.getTime()) ? new Date() : snapshot;
  let lastActivity = candidates.length ? candidates[0].date : null;
  let daysInactive = null;
  let source = candidates.length ? 'APPLICATION_MAX_ACTIVITY_SIGNAL' : 'NO_VALID_ACTIVITY_TIMESTAMP';
  if (lastActivity) {
    daysInactive = Math.max(0, Math.floor((snapshotDate.getTime() - lastActivity.getTime()) / 86400000));
  } else {
    const suppliedDays = parseNumber_(sourceValue_(row, headerMap, 'DAYS_SINCE_ACTIVITY'));
    if (suppliedDays !== null) {
      daysInactive = Math.max(0, Math.floor(suppliedDays));
      lastActivity = new Date(snapshotDate.getTime() - daysInactive * 86400000);
      source = 'SOURCE_DAYS_SINCE_ACTIVITY_FALLBACK';
    }
  }
  return {
    lastActivityTs: lastActivity ? lastActivity.toISOString() : '',
    daysInactive: daysInactive,
    isStale: daysInactive !== null && daysInactive >= Number(thresholdDays || 180),
    assessable: daysInactive !== null,
    source: source
  };
}

function normalizedSnowflakeDataStatus_(value) {
  const status = cleanText_(value).toUpperCase();
  if (!status) return APP.lifecycle.active;
  if (status.split(/[,;|]+/).map(cleanText_).indexOf(APP.lifecycle.restricted) !== -1) return APP.lifecycle.restricted;
  return status;
}

function firstEmail_(values) {
  const candidates = [];
  (values || []).forEach(function (value) {
    cleanText_(value).split(/[;,\s]+/).forEach(function (part) {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(part)) candidates.push(part.toLowerCase());
    });
  });
  return candidates.length ? candidates[0] : '';
}

function canonicalLifecycleState_(state) {
  const value = cleanText_(state).toUpperCase();
  if (value === APP.lifecycle.exempted) return APP.lifecycle.exempt;
  if (value === 'VALIDATED') return APP.lifecycle.detected;
  if (value === 'EXCEPTION_PENDING') return APP.lifecycle.contested;
  if (value === APP.lifecycle.restricted) return APP.lifecycle.quarantined;
  return value;
}

function deriveAssetStatus_(asset, lifecycleOverride) {
  const value = asset || {};
  const lifecycleState = canonicalLifecycleState_(lifecycleOverride || value.LIFECYCLE_STATE);
  const snowflakeStatus = normalizedSnowflakeDataStatus_(value.SNOWFLAKE_DATA_STATUS);
  if (lifecycleState === APP.lifecycle.purged || cleanText_(value.EVALUATION_STATUS).toUpperCase() === 'REMOVED') {
    return APP.assetStatus.purged;
  }
  if (snowflakeStatus === APP.lifecycle.restricted ||
      [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(lifecycleState) !== -1) {
    return APP.assetStatus.quarantined;
  }
  if (lifecycleState === APP.lifecycle.active) {
    return APP.assetStatus.active;
  }
  const staleValue = value.IS_STALE_180 === true || cleanText_(value.IS_STALE_180).toUpperCase() === 'TRUE' ||
    cleanText_(value.EVALUATION_STATUS).toUpperCase() === 'STALE';
  return staleValue ? APP.assetStatus.stale : APP.assetStatus.active;
}

function inferEnvironment_(database, schema) {
  const value = (database + ' ' + schema).toUpperCase();
  if (/SANDBOX|(^|[_-])SBX([_-]|$)/.test(value)) return 'SANDBOX';
  if (/DEV|DEVELOPMENT/.test(value)) return 'DEVELOPMENT';
  if (/TEST|QA|UAT/.test(value)) return 'NON_PRODUCTION';
  return 'PRODUCTION';
}

function buildDetectedCase_(assetId, ownerStatus, detectedAt, runId) {
  return {
    CASE_ID: uuid_(),
    ASSET_ID: assetId,
    PLATFORM: 'SNOWFLAKE',
    STATE: APP.lifecycle.detected,
    T0: '',
    NOTIFIED_AT: '',
    CONTEST_DEADLINE: '',
    RESTRICT_AT: '',
    QUARANTINE_START_DATE: '',
    PURGE_NOTICE_AT: '',
    PURGE_ELIGIBLE_DATE: '',
    EXCEPTION_ID: '',
    EXCEPTION_STATUS: '',
    OWNER_STATUS: ownerStatus,
    LAST_TRANSITION_AT: detectedAt,
    LAST_EVALUATION_RUN_ID: runId,
    NOTES: 'Detected by the reviewed Snowflake stale-data intake.'
  };
}

function lifecycleEventRow_(caseId, assetId, eventType, fromState, toState, eventAt, actor, runId, details) {
  return [uuid_(), caseId || '', assetId, eventType, fromState || '', toState || '', eventAt || nowIso_(), actor || 'SYSTEM', runId || '', JSON.stringify(details || {})];
}

function loadCaseMap_() {
  return readObjects_(APP.sheets.cases).reduce(function (map, item) {
    item.STATE = canonicalLifecycleState_(item.STATE);
    map[item.ASSET_ID] = item;
    return map;
  }, {});
}

function incrementCount_(map, key) {
  const label = key || 'UNKNOWN';
  map[label] = Number(map[label] || 0) + 1;
}

function ensureDataModelV2_() {
  [APP.sheets.assetsCurrent, APP.sheets.assetsStaging].forEach(function (sheetName) {
    const sheet = getSheet_(sheetName);
    appendMissingHeaders_(sheet, ASSET_HEADERS);
  });
  appendMissingHeaders_(getSheet_(APP.sheets.cases), CASE_HEADERS);
}

function appendMissingHeaders_(sheet, requiredHeaders) {
  const existing = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(cleanText_)
    : [];
  if (!existing.length) {
    ensureSheetCapacity_(sheet, Math.max(2, sheet.getMaxRows()), requiredHeaders.length);
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }
  const missing = requiredHeaders.filter(function (header) { return existing.indexOf(header) === -1; });
  if (!missing.length) return;
  const startColumn = existing.length + 1;
  ensureSheetCapacity_(sheet, Math.max(2, sheet.getMaxRows()), existing.length + missing.length);
  sheet.getRange(1, startColumn, 1, missing.length).setValues([missing]);
}

function swapAssetBuffers_() {
  const current = getSheet_(APP.sheets.assetsCurrent);
  const staging = getSheet_(APP.sheets.assetsStaging);
  const currentName = resolveSheetName_(APP.sheets.assetsCurrent);
  const stagingName = resolveSheetName_(APP.sheets.assetsStaging);
  const previousName = APP.environments[getActiveEnvironment_()].sheetPrefix + 'Assets_Previous';
  current.setName(previousName);
  staging.setName(currentName);
  current.setName(stagingName);
  staging.showSheet();
  current.hideSheet();
}

function finalizeImport_(state) {
  const approval = approveImportedCandidates_(state.runId, state.intakeApprovedAt);
  let orphanQuarantineActions = 0;
  (approval.orphanAssetIds || []).forEach(function (assetId) {
    try {
      queuePlatformActionInternal_(assetId, 'QUARANTINE', { email: getCurrentUserEmail_() || 'SYSTEM', role: 'SYSTEM' });
      orphanQuarantineActions += 1;
    } catch (error) {}
  });
  const reconciliation = carryForwardAndReconcile_(state);
  const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
  const restrictionSeen = {};
  const restrictionAssetIds = (lifecycleAssets.SNOWFLAKE_RESTRICTION_CONFIRMED || [])
    .concat(lifecycleAssets.SNOWFLAKE_INITIAL_RESTRICTION || [])
    .filter(function (assetId) {
      if (restrictionSeen[assetId]) return false;
      restrictionSeen[assetId] = true;
      return true;
    });
  const activeRecoveryAssetIds = lifecycleAssets.STALE_ASSET_BECAME_ACTIVE || [];
  const restoredReappearanceAssetIds = lifecycleAssets.PURGED_ASSET_REAPPEARED || [];
  const dismissedAssetIds = lifecycleAssets.INTAKE_CANDIDATE_DISMISSED || [];
  let cancelledRecoveryActions = 0;
  activeRecoveryAssetIds.forEach(function (assetId) {
    cancelledRecoveryActions += cancelPendingPlatformActionsForAsset_(assetId, 'Latest complete extract shows the asset is active.');
  });
  let cancelledDismissalActions = 0;
  dismissedAssetIds.forEach(function (assetId) {
    cancelledDismissalActions += cancelPendingPlatformActionsForAsset_(assetId, 'Candidate dismissed by EDG during reviewed intake.');
  });
  const caseMapForRestrictions = loadCaseMap_();
  const orphanRestrictionAssetIds = restrictionAssetIds.filter(function (assetId) {
    const ownerStatus = cleanText_(caseMapForRestrictions[assetId] && caseMapForRestrictions[assetId].OWNER_STATUS).toUpperCase();
    return ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
  });
  const standardRestrictionAssetIds = restrictionAssetIds.filter(function (assetId) {
    return orphanRestrictionAssetIds.indexOf(assetId) === -1;
  });
  const completedQuarantineActions = completeQuarantineActionsFromImport_(restrictionAssetIds, state.snapshotAt, state.runId);
  refreshDashboardIndex_();
  clearDataRows_(APP.sheets.dashboardSummary);
  const summaryRows = [];
  ['state', 'evaluation', 'environment', 'ownership', 'domain'].forEach(function (dimension) {
    const values = state.counts[dimension] || {};
    Object.keys(values).sort().forEach(function (key, index) {
      summaryRows.push([state.snapshotAt, dimension.toUpperCase(), key, 'ASSET_COUNT', values[key], index + 1, state.runId]);
    });
  });
  appendRawRows_(APP.sheets.dashboardSummary, summaryRows);

  let notificationMessage = '';
  if (approval.assetIds.length) {
    try {
      const delivery = createAndSendNotificationGroups_(approval.assetIds, 'STALE_ASSET_NOTICE', true);
      notificationMessage = ' Initial Slack: ' + delivery.assetCount + ' assets in ' + delivery.groupCount + ' consolidated messages.';
    } catch (error) {
      notificationMessage = ' Initial Slack needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  }
  if (standardRestrictionAssetIds.length) {
    try {
      const delivery = createAndSendNotificationGroups_(standardRestrictionAssetIds, 'QUARANTINE_NOTICE', true);
      notificationMessage += ' Quarantine Slack: ' + delivery.assetCount + ' assets in ' + delivery.groupCount + ' consolidated messages.';
    } catch (error) {
      notificationMessage += ' Quarantine Slack needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  }
  if (orphanRestrictionAssetIds.length) {
    try {
      const delivery = createAndSendNotificationGroups_(orphanRestrictionAssetIds, 'ORPHAN_QUARANTINE_NOTICE', true);
      notificationMessage += ' Orphan quarantine Slack: ' + delivery.assetCount + ' assets in ' + delivery.groupCount + ' consolidated messages.';
    } catch (error) {
      notificationMessage += ' Orphan quarantine Slack needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  }
  if (reconciliation.purgedAssetIds.length) {
    try { createAndSendNotificationGroups_(reconciliation.purgedAssetIds, 'PURGE_COMPLETED', true); } catch (error) {}
  }
  if (restoredReappearanceAssetIds.length) {
    try {
      const delivery = createAndSendNotificationGroups_(restoredReappearanceAssetIds, 'RESTORATION_CONFIRMED', true);
      notificationMessage += ' Restoration Slack: ' + delivery.assetCount + ' assets in ' + delivery.groupCount + ' consolidated messages.';
    } catch (error) {
      notificationMessage += ' Restoration Slack needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  }
  try { ensureLifecycleAutomationTrigger_(); } catch (error) {}

  updateJobRun_(state.runId, {
    STATUS: 'SUCCEEDED',
    COMPLETED_AT: nowIso_(),
    CURSOR_ROW: state.cursorRow,
    PROCESSED_ROWS: state.processedRows,
    WRITTEN_ROWS: state.writtenRows + reconciliation.carriedForward,
    ERROR_COUNT: state.errors,
    MESSAGE: 'Reviewed ' + state.sourceRows + ' source rows; published ' + state.writtenRows + ' stale candidates and ' + reconciliation.carriedForward + ' managed cases; recorded ' + dismissedAssetIds.length + ' intake dismissals and cancelled ' + cancelledDismissalActions + ' related handoffs; marked ' + activeRecoveryAssetIds.length + ' tracked assets ACTIVE and cancelled ' + cancelledRecoveryActions + ' pending handoffs; prepared ' + orphanQuarantineActions + ' orphan quarantine handoffs; confirmed ' + restrictionAssetIds.length + ' Snowflake restrictions and completed ' + completedQuarantineActions + ' quarantine work items.' + notificationMessage
  });
  clearImportState_(state.environment);
  clearPendingIntakeReview_(state.environment);
}

function lifecycleEventAssetGroupsForRun_(runId) {
  const groups = {};
  const seen = {};
  readObjects_(APP.sheets.events).forEach(function (event) {
    if (event.RUN_ID !== runId) return;
    const eventType = cleanText_(event.EVENT_TYPE).toUpperCase();
    const assetId = cleanText_(event.ASSET_ID);
    if (!eventType || !assetId) return;
    const key = eventType + '|' + assetId;
    if (seen[key]) return;
    seen[key] = true;
    if (!groups[eventType]) groups[eventType] = [];
    groups[eventType].push(assetId);
  });
  return groups;
}

function restrictionTransitionsForRun_(runId) {
  const seen = {};
  return ['SNOWFLAKE_RESTRICTION_CONFIRMED', 'SNOWFLAKE_INITIAL_RESTRICTION'].reduce(function (assetIds, eventType) {
    lifecycleEventAssetsForRun_(runId, eventType).forEach(function (assetId) {
      if (!seen[assetId]) {
        seen[assetId] = true;
        assetIds.push(assetId);
      }
    });
    return assetIds;
  }, []);
}

function lifecycleEventAssetsForRun_(runId, eventType) {
  const seen = {};
  return readObjects_(APP.sheets.events).filter(function (event) {
    return event.RUN_ID === runId && cleanText_(event.EVENT_TYPE).toUpperCase() === cleanText_(eventType).toUpperCase();
  }).map(function (event) {
    return cleanText_(event.ASSET_ID);
  }).filter(function (assetId) {
    if (!assetId || seen[assetId]) return false;
    seen[assetId] = true;
    return true;
  });
}

function completeQuarantineActionsFromImport_(assetIds, completedAt, runId) {
  const targets = {};
  (assetIds || []).forEach(function (assetId) { targets[assetId] = true; });
  if (!Object.keys(targets).length) return 0;
  const updates = readObjects_(APP.sheets.platformActions).filter(function (action) {
    return targets[action.ASSET_ID] && cleanText_(action.ACTION).toUpperCase() === 'QUARANTINE' &&
      ['READY', 'EXPORTED', 'ACCEPTED'].indexOf(cleanText_(action.STATUS).toUpperCase()) !== -1;
  }).map(function (action) {
    action.STATUS = 'COMPLETED';
    action.COMPLETED_AT = completedAt;
    action.PARTNER_REFERENCE = action.PARTNER_REFERENCE || 'SNOWFLAKE_INTAKE_' + runId;
    action.RESPONSE_JSON = JSON.stringify({
      confirmedBy: 'REVIEWED_SNOWFLAKE_INTAKE',
      snowflakeDataStatus: APP.lifecycle.restricted,
      sourceSnapshotAt: completedAt,
      runId: runId
    });
    action.ERROR = '';
    return action;
  });
  updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
  return updates.length;
}

function approveImportedCandidates_(runId, approvedAt) {
  const cases = readObjects_(APP.sheets.cases).filter(function (item) {
    return item.LAST_EVALUATION_RUN_ID === runId && canonicalLifecycleState_(item.STATE) === APP.lifecycle.detected;
  });
  if (!cases.length) return { assetIds: [], orphanAssetIds: [] };
  const contestWindowDays = configNumber_('CONTEST_WINDOW_DAYS', 9);
  const events = [];
  const notificationAssetIds = [];
  const orphanAssetIds = [];
  cases.forEach(function (item) {
    const ownerStatus = cleanText_(item.OWNER_STATUS).toUpperCase();
    const isOrphan = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
    item.STATE = isOrphan ? APP.lifecycle.accepted : APP.lifecycle.detected;
    item.T0 = approvedAt;
    item.CONTEST_DEADLINE = isOrphan ? '' : addDaysIso_(approvedAt, contestWindowDays);
    item.LAST_TRANSITION_AT = approvedAt;
    item.NOTES = isOrphan
      ? 'EDG confirmed an orphaned stale asset; the PRD requires immediate quarantine handoff and a 365-day quarantine.'
      : 'EDG confirmed the reviewed intake; initial notification is automatic.';
    events.push(lifecycleEventRow_(item.CASE_ID, item.ASSET_ID,
      isOrphan ? 'ORPHAN_POLICY_ACCEPTED' : 'INTAKE_REVIEW_CONFIRMED',
      APP.lifecycle.detected, item.STATE, approvedAt, getCurrentUserEmail_() || 'SYSTEM', runId, {
      t0: approvedAt, contestWindowDays: isOrphan ? 0 : contestWindowDays, orphan: isOrphan
    }));
    if (isOrphan) orphanAssetIds.push(item.ASSET_ID);
    else notificationAssetIds.push(item.ASSET_ID);
  });
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', cases);
  cases.forEach(function (item) { updateAssetState_(item.ASSET_ID, item.STATE, item); });
  appendRawRows_(APP.sheets.events, events);
  return { assetIds: notificationAssetIds, orphanAssetIds: orphanAssetIds };
}

function carryForwardAndReconcile_(state) {
  const current = indexObjectsBy_(readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const previous = indexObjectsBy_(readObjects_(APP.sheets.assetsStaging), 'ASSET_ID');
  const cases = loadCaseMap_();
  const source = SpreadsheetApp.openById(state.sourceSpreadsheetId).getSheetByName(state.sourceSheetName);
  if (!source) throw new Error('The staged intake source is no longer available for reconciliation.');
  const headerMap = validateSnowflakeV2Headers_(state.sourceHeaders);
  const fqnColumn = headerMap.TABLE_FQN + 1;
  const sourceFqns = {};
  if (state.sourceRows) {
    source.getRange(2, fqnColumn, state.sourceRows, 1).getDisplayValues().forEach(function (row) {
      const fqn = cleanText_(row[0]).toUpperCase();
      if (fqn) sourceFqns[fqn] = true;
    });
  }
  const completedPurge = {};
  readObjects_(APP.sheets.platformActions).forEach(function (action) {
    if (cleanText_(action.ACTION).toUpperCase() === 'PURGE' && cleanText_(action.STATUS).toUpperCase() === 'COMPLETED') completedPurge[action.ASSET_ID] = true;
  });
  const carry = [];
  const caseUpdates = [];
  const events = [];
  const purgedAssetIds = [];
  const selfPurgedAssetIds = [];
  const now = new Date();
  Object.keys(cases).forEach(function (assetId) {
    if (current[assetId]) return;
    const caseRecord = cases[assetId];
    const stateName = canonicalLifecycleState_(caseRecord.STATE);
    if ([APP.lifecycle.dismissed, APP.lifecycle.active, APP.lifecycle.restored].indexOf(stateName) !== -1) return;
    const oldAsset = previous[assetId];
    if (!oldAsset) return;
    const sourcePresent = Boolean(sourceFqns[cleanText_(oldAsset.OBJECT_FQN).toUpperCase()]);
    const purgeDue = caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= now;
    const verifiedPlatformPurge = [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(stateName) !== -1 && purgeDue && completedPurge[assetId] && !sourcePresent;
    const verifiedSelfPurge = stateName === APP.lifecycle.selfPurgePending && !sourcePresent;
    if (verifiedPlatformPurge || verifiedSelfPurge) {
      const fromState = caseRecord.STATE;
      caseRecord.STATE = APP.lifecycle.purged;
      caseRecord.LAST_TRANSITION_AT = state.snapshotAt;
      caseRecord.LAST_EVALUATION_RUN_ID = state.runId;
      caseRecord.NOTES = verifiedSelfPurge
        ? 'Verified absent from the complete Snowflake extract after owner self-purge intent.'
        : 'Verified absent from the complete Snowflake extract after completed purge action.';
      oldAsset.LIFECYCLE_STATE = APP.lifecycle.purged;
      oldAsset.EVALUATION_STATUS = 'REMOVED';
      oldAsset.SOURCE_ACTIVITY_STATUS = 'NOT_PRESENT_AFTER_PURGE';
      oldAsset.ASSET_STATUS = APP.assetStatus.purged;
      if (verifiedSelfPurge) selfPurgedAssetIds.push(assetId);
      else purgedAssetIds.push(assetId);
      caseUpdates.push(caseRecord);
      events.push(lifecycleEventRow_(caseRecord.CASE_ID, assetId, verifiedSelfPurge ? 'SELF_PURGE_VERIFIED' : 'PURGE_VERIFIED', fromState, APP.lifecycle.purged, state.snapshotAt, 'SYSTEM', state.runId, {
        sourcePresent: false, purgeActionCompleted: verifiedPlatformPurge, ownerSelfPurgeIntent: verifiedSelfPurge
      }));
    } else {
      oldAsset.LIFECYCLE_STATE = stateName;
      oldAsset.SOURCE_ACTIVITY_STATUS = sourcePresent ? 'MANAGED_CASE_BELOW_THRESHOLD' : 'NOT_PRESENT_IN_LATEST_SOURCE';
      oldAsset.ASSET_STATUS = deriveAssetStatus_(oldAsset, stateName);
    }
    oldAsset.SNAPSHOT_AT = state.snapshotAt;
    carry.push(oldAsset);
  });
  appendObjectRows_(APP.sheets.assetsCurrent, ASSET_HEADERS, carry);
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', caseUpdates);
  appendRawRows_(APP.sheets.events, events);
  return { carriedForward: carry.length, purgedAssetIds: purgedAssetIds, selfPurgedAssetIds: selfPurgedAssetIds };
}

function refreshDashboardIndex_() {
  const sheet = getSheet_(APP.sheets.assetsIndex);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
}

function scheduleImportContinuation_() {
  deleteImportContinuationTriggers_();
  ScriptApp.newTrigger('continueSnowflakeImport').timeBased().after(10000).create();
}

function deleteImportContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueSnowflakeImport') ScriptApp.deleteTrigger(trigger);
  });
}

function cancelSnowflakeImport() {
  assertAdmin_();
  assertEnvironmentWritable_();
  const state = getImportState_();
  deleteImportContinuationTriggers_();
  if (state) updateJobRun_(state.runId, { STATUS: 'CANCELLED', COMPLETED_AT: nowIso_(), MESSAGE: 'Cancelled by user.' });
  clearImportState_(getActiveEnvironment_());
  return getImportStatus();
}
