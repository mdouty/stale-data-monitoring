const SNOWFLAKE_V2_REQUIRED_HEADERS = Object.freeze([
  'TABLE_FQN', 'DATABASE_NAME', 'SCHEMA_NAME', 'TABLE_NAME', 'TABLE_TYPE',
  'SNOWFLAKE_TABLE_OWNER', 'SF_DPM_TEAM', 'SF_BDS_TEAM',
  'SF_BUSINESS_STEWARD', 'SF_TECHNICAL_STEWARD', 'OWNERSHIP_STATUS',
  'OWNERSHIP_SOURCE', 'SF_DOMAIN', 'SF_SUB_DOMAIN', 'ROW_COUNT', 'BYTES',
  'OBJECT_CREATED_DATE', 'LAST_READ', 'LAST_WRITE', 'LAST_LOAD', 'LAST_ALTERED',
  'SOURCE_SNAPSHOT_AT', 'SNOWFLAKE_DATA_STATUS'
]);

const SCHEMA_OWNER_REQUIRED_HEADERS = Object.freeze([
  'DB_NAME', 'SCHEMA_NAME', 'DELEGATE_NAMES', 'DS_DELEGATES', 'STATUS'
]);
const SCHEMA_OWNER_ELIGIBLE_STATUSES = Object.freeze(['CONFIRMED', 'ASSIGNED - FINAL']);

function normalizeDatabaseSchemaKey_(database, schema) {
  function normalizePart(value) {
    return cleanText_(value).replace(/^"|"$/g, '').toUpperCase();
  }
  const databaseName = normalizePart(database);
  const schemaName = normalizePart(schema);
  return databaseName && schemaName ? databaseName + '.' + schemaName : '';
}

function schemaOwnerEmails_(usernames) {
  const seen = {};
  return cleanText_(usernames).split(/[,;\n]+/).map(function (value) {
    const username = cleanText_(value).toLowerCase();
    if (!username) return '';
    const email = username.indexOf('@') !== -1
      ? username
      : (/^[a-z0-9._-]+$/.test(username) ? username + '@salesforce.com' : '');
    if (!email || !/^[^@\s]+@salesforce\.com$/i.test(email) || seen[email]) return '';
    seen[email] = true;
    return email;
  }).filter(Boolean).join(',');
}

function loadSchemaOwnerLookup_() {
  const config = getConfig_();
  const spreadsheetId = cleanText_(config.SCHEMA_OWNER_SPREADSHEET_ID || APP.schemaOwnerSpreadsheetId);
  const sheetName = cleanText_(config.SCHEMA_OWNER_SHEET_NAME || APP.schemaOwnerSheetName);
  if (!spreadsheetId || !sheetName) throw new Error('Schema-owner enrichment is not configured.');
  const cache = CacheService.getScriptCache();
  const cacheKey = 'SCHEMA_OWNER_LOOKUP_' + spreadsheetId + '_' + sheetName;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  let sheet;
  try {
    sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  } catch (error) {
    throw new Error('Unable to read the schema-owner registry. Confirm that the deploying account can access it. ' + String(error.message || error));
  }
  if (!sheet) throw new Error('Schema-owner registry tab not found: ' + sheetName + '.');
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) throw new Error('Schema-owner registry is empty.');
  const headers = values.shift().map(function (value) { return cleanText_(value).toUpperCase(); });
  const headerMap = {};
  headers.forEach(function (header, index) { if (header) headerMap[header] = index; });
  const missing = SCHEMA_OWNER_REQUIRED_HEADERS.filter(function (header) { return headerMap[header] === undefined; });
  if (missing.length) throw new Error('Schema-owner registry is missing columns: ' + missing.join(', ') + '.');

  const owners = {};
  let eligibleRows = 0;
  let eligibleWithoutOwner = 0;
  values.forEach(function (row) {
    const status = sourceValue_(row, headerMap, 'STATUS').toUpperCase();
    if (SCHEMA_OWNER_ELIGIBLE_STATUSES.indexOf(status) === -1) return;
    eligibleRows += 1;
    const key = normalizeDatabaseSchemaKey_(sourceValue_(row, headerMap, 'DB_NAME'), sourceValue_(row, headerMap, 'SCHEMA_NAME'));
    const username = sourceValue_(row, headerMap, 'DS_DELEGATES');
    const email = schemaOwnerEmails_(username);
    if (!key || !email) eligibleWithoutOwner += 1;
    if (!key || owners[key]) return;
    owners[key] = {
      email: email,
      name: sourceValue_(row, headerMap, 'DELEGATE_NAMES'),
      username: username,
      status: sourceValue_(row, headerMap, 'STATUS')
    };
  });
  const result = {
    owners: owners,
    spreadsheetId: spreadsheetId,
    sheetName: sheetName,
    eligibleRows: eligibleRows,
    eligibleWithoutOwner: eligibleWithoutOwner
  };
  const serialized = JSON.stringify(result);
  if (serialized.length < 95000) cache.put(cacheKey, serialized, 300);
  return result;
}

function schemaOwnerForRow_(row, headerMap, lookup) {
  const key = normalizeDatabaseSchemaKey_(
    sourceValue_(row, headerMap, 'DATABASE_NAME'),
    sourceValue_(row, headerMap, 'SCHEMA_NAME')
  );
  return lookup && lookup.owners && lookup.owners[key] ? lookup.owners[key] : null;
}

function importStateProperty_(environment) {
  return APP.importStateProperty + '_' + normalizeEnvironment_(environment || getActiveEnvironment_());
}

function getImportState_(environment) {
  const raw = PropertiesService.getScriptProperties().getProperty(importStateProperty_(environment));
  return raw ? JSON.parse(raw) : null;
}

function setImportState_(state) {
  state.updatedAt = nowIso_();
  PropertiesService.getScriptProperties().setProperty(importStateProperty_(state.environment), JSON.stringify(state));
}

function clearImportState_(environment) {
  PropertiesService.getScriptProperties().deleteProperty(importStateProperty_(environment));
}

function getAnyImportState_() {
  return getImportState_('DEV') || getImportState_('PRD');
}

function importNotificationCampaignProperty_(environment) {
  return APP.importNotificationCampaignProperty + '_' + normalizeEnvironment_(environment || getActiveEnvironment_());
}

function getImportNotificationCampaignState_(environment) {
  const raw = PropertiesService.getScriptProperties().getProperty(importNotificationCampaignProperty_(environment));
  return raw ? JSON.parse(raw) : null;
}

function getAnyRunningImportNotificationCampaign_() {
  // Production delivery has priority when both environments have recoverable work.
  const states = [getImportNotificationCampaignState_('PRD'), getImportNotificationCampaignState_('DEV')];
  return states.filter(function (item) { return item && ['QUEUED', 'RUNNING', 'RETRYING'].indexOf(item.status) !== -1; })[0] || null;
}

function setImportNotificationCampaignState_(state) {
  state.updatedAt = nowIso_();
  PropertiesService.getScriptProperties().setProperty(importNotificationCampaignProperty_(state.environment), JSON.stringify(state));
  if (state.deliveryJobId) {
    const terminal = ['SUCCEEDED', 'COMPLETED_WITH_ERRORS', 'PAUSED'].indexOf(cleanText_(state.status).toUpperCase()) !== -1;
    updateJobRun_(state.deliveryJobId, {
      STATUS: terminal ? state.status : 'RUNNING',
      COMPLETED_AT: ['SUCCEEDED', 'COMPLETED_WITH_ERRORS'].indexOf(cleanText_(state.status).toUpperCase()) !== -1 ? (state.completedAt || nowIso_()) : '',
      CURSOR_ROW: Number(state.cursor || 0), SOURCE_ROWS: Number(state.total || 0),
      PROCESSED_ROWS: Number(state.completed || 0), WRITTEN_ROWS: Number(state.delivered || 0),
      ERROR_COUNT: Number(state.failed || 0),
      MESSAGE: 'Slack ' + cleanText_(state.phase || 'QUEUED').toLowerCase() + ': ' + Number(state.completed || 0) +
        ' of ' + Number(state.total || 0) + ' assets prepared; ' + Number(state.ownerMessagesDelivered || 0) +
        ' of ' + Number(state.ownerMessagesTotal || 0) + ' owner messages delivered.' +
        (state.lastError ? ' ' + cleanText_(state.lastError) : '')
    });
  }
}

function getImportNotificationCampaignStatus_(environment) {
  const state = getImportNotificationCampaignState_(environment || getActiveEnvironment_());
  if (!state) return { running: false, status: 'NOT_QUEUED', total: 0, completed: 0, delivered: 0, failed: 0 };
  const terminalStatus = ['PAUSED', 'COMPLETED_WITH_ERRORS', 'SUCCEEDED'].indexOf(cleanText_(state.status).toUpperCase()) !== -1;
  if (terminalStatus && !readObjects_(APP.sheets.notifications).length) {
    PropertiesService.getScriptProperties().deleteProperty(importNotificationCampaignProperty_(state.environment));
    return { running: false, status: 'NOT_QUEUED', total: 0, completed: 0, delivered: 0, failed: 0 };
  }
  const running = ['QUEUED', 'RUNNING', 'RETRYING'].indexOf(state.status) !== -1;
  const updatedAt = state.updatedAt || state.startedAt || '';
  const updatedDate = updatedAt ? new Date(updatedAt) : null;
  const stalledForMs = running && updatedDate && !isNaN(updatedDate.getTime()) ? Math.max(0, Date.now() - updatedDate.getTime()) : 0;
  return {
    running: running,
    stalled: Boolean(running && stalledForMs > 5 * 60 * 1000),
    stalledForSeconds: Math.floor(stalledForMs / 1000),
    status: state.status,
    runId: state.runId || '',
    environment: state.environment,
    phase: state.phase || '',
    messageType: state.messageType || '',
    total: Number(state.total || 0),
    completed: Number(state.completed || 0),
    delivered: Number(state.delivered || 0),
    failed: Number(state.failed || 0),
    ownerMessagesTotal: Number(state.ownerMessagesTotal || 0),
    ownerMessagesDelivered: Number(state.ownerMessagesDelivered || 0),
    ownerMessagesFailed: Number(state.ownerMessagesFailed || 0),
    startedAt: state.startedAt || '',
    updatedAt: updatedAt,
    completedAt: state.completedAt || '',
    lastError: state.lastError || ''
  };
}

function getSelfHealingImportNotificationCampaignStatus_(environment) {
  const selectedEnvironment = normalizeEnvironment_(environment || getActiveEnvironment_());
  let status = getImportNotificationCampaignStatus_(selectedEnvironment);
  if (!status.stalled || !isAdminEmail_(getCurrentUserEmail_())) return status;
  const state = getImportNotificationCampaignState_(selectedEnvironment);
  if (!state) return status;
  const lastRecovery = state.recoveryRequestedAt ? new Date(state.recoveryRequestedAt) : null;
  if (lastRecovery && !isNaN(lastRecovery.getTime()) && Date.now() - lastRecovery.getTime() < 5 * 60 * 1000) return status;
  try {
    state.status = 'RETRYING';
    state.recoveryRequestedAt = nowIso_();
    state.recoveryCount = Number(state.recoveryCount || 0) + 1;
    state.lastError = '';
    setImportNotificationCampaignState_(state);
    scheduleImportNotificationCampaign_(10000);
  } catch (error) {
    state.status = 'PAUSED';
    state.lastError = 'Automatic recovery could not schedule a continuation: ' + String(error.message || error).substring(0, 400);
    setImportNotificationCampaignState_(state);
  }
  return getImportNotificationCampaignStatus_(selectedEnvironment);
}

function getImportStatus() {
  clearBlankProductionWorkflowState_();
  let state = getImportState_();
  if (!state) {
    const recoveryJobs = readObjects_(APP.sheets.jobs);
    const failedJob = recoveryJobs.length ? recoveryJobs[recoveryJobs.length - 1] : null;
    const cellLimitFailure = failedJob && /number of cells[\s\S]*limit of 10000000 cells/i.test(cleanText_(failedJob.MESSAGE));
    if (cellLimitFailure && isRecoverableFailedFinalization_(failedJob)) {
      try {
        reclaimOperationalGridCapacity_();
        state = recoverFailedFinalizationState_(getActiveEnvironment_());
        state.message = 'Recovered the cell-capacity failure; resuming from durable finalization checkpoints';
        state.recoveryRequestedAt = nowIso_();
        setImportState_(state);
        updateJobRun_(state.runId, {
          STATUS: 'RUNNING', COMPLETED_AT: '', ERROR_COUNT: 0, MESSAGE: state.message
        });
        try { scheduleImportContinuation_(10000); } catch (scheduleError) {}
      } catch (recoveryError) {
        console.error('Automatic finalization recovery failed: ' + String(recoveryError.message || recoveryError));
      }
    }
  }
  if (state) {
    const completed = state.phase === 'IMPORT' ? Number(state.processedRows || Math.max(0, state.cursorRow - 2)) : state.sourceRows;
    const updatedAt = state.updatedAt || state.startedAt || '';
    const updatedDate = updatedAt ? new Date(updatedAt) : null;
    const stalled = Boolean(updatedDate && !isNaN(updatedDate.getTime()) && Date.now() - updatedDate.getTime() > 12 * 60 * 1000);
    return {
      running: true,
      stalled: stalled,
      environment: state.environment,
      runId: state.runId,
      phase: state.phase,
      progressStage: state.progressStage || '',
      completed: completed,
      processedRows: Number(state.processedRows || completed || 0),
      total: state.sourceRows,
      percent: state.sourceRows ? Math.min(100, Math.round(completed * 100 / state.sourceRows)) : 0,
      candidates: Number(state.writtenRows || 0),
      writtenRows: Number(state.writtenRows || 0),
      errors: Number(state.errors || 0),
      fileName: state.sourceFileName || '',
      startedAt: state.startedAt || '',
      updatedAt: updatedAt,
      message: state.message || '',
      notificationCampaign: getSelfHealingImportNotificationCampaignStatus_(state.environment)
    };
  }
  const jobs = readObjects_(APP.sheets.jobs);
  const latest = jobs.length ? jobs[jobs.length - 1] : null;
  const recoverable = isRecoverableFailedFinalization_(latest);
  return {
    running: false,
    stalled: false,
    environment: getActiveEnvironment_(),
    runId: latest ? latest.RUN_ID : '',
    phase: latest ? latest.STATUS : 'NOT_RUN',
    progressStage: '',
    completed: latest ? Number(latest.PROCESSED_ROWS || 0) : 0,
    processedRows: latest ? Number(latest.PROCESSED_ROWS || 0) : 0,
    total: latest ? Number(latest.SOURCE_ROWS || 0) : 0,
    candidates: latest ? Number(latest.WRITTEN_ROWS || 0) : 0,
    writtenRows: latest ? Number(latest.WRITTEN_ROWS || 0) : 0,
    errors: latest ? Number(latest.ERROR_COUNT || 0) : 0,
    fileName: '',
    startedAt: latest ? latest.STARTED_AT : '',
    percent: latest && Number(latest.SOURCE_ROWS) ? Math.round(Number(latest.PROCESSED_ROWS) * 100 / Number(latest.SOURCE_ROWS)) : 0,
    message: latest ? latest.MESSAGE : 'No import has run.',
    recoverable: recoverable,
    notificationCampaign: getSelfHealingImportNotificationCampaignStatus_()
  };
}

function isRecoverableFailedFinalization_(job) {
  if (!job || cleanText_(job.STATUS).toUpperCase() !== 'FAILED') return false;
  const sourceRows = Number(job.SOURCE_ROWS || 0);
  const processedRows = Number(job.PROCESSED_ROWS || 0);
  if (!sourceRows || processedRows < sourceRows) return false;
  return getSheet_(APP.sheets.assetsCurrent).getLastRow() > 1 &&
    getSheet_(APP.sheets.cases).getLastRow() > 1;
}

function clearBlankProductionWorkflowState_() {
  if (getActiveEnvironment_() !== 'PRD') return;
  const sentinelSheets = [
    APP.sheets.assetsCurrent, APP.sheets.cases, APP.sheets.notifications,
    APP.sheets.jobs, APP.sheets.intakeUpload
  ];
  const blank = sentinelSheets.every(function (sheetName) { return getSheet_(sheetName).getLastRow() <= 1; });
  if (!blank) return;
  clearImportState_('PRD');
  clearPendingIntakeReview_('PRD');
  PropertiesService.getScriptProperties().deleteProperty(importNotificationCampaignProperty_('PRD'));
  try { deleteImportContinuationTriggers_(); } catch (error) {}
  try { deleteIntakeReviewPreparationTriggers_(); } catch (error) {}
  try { deleteImportNotificationCampaignTriggers_(); } catch (error) {}
}

function advanceActiveImportWorkflow() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const importState = getImportState_(profile.key);
  if (importState) {
    setExecutionEnvironment_(profile.key, false);
    return continueSnowflakeImport() || getImportStatus();
  }
  const campaign = getImportNotificationCampaignState_(profile.key);
  if (campaign && ['QUEUED', 'RUNNING', 'RETRYING'].indexOf(cleanText_(campaign.status).toUpperCase()) !== -1) {
    continueImportNotificationCampaign(profile.key);
  }
  return getImportStatus();
}

function intakeReviewProperty_(environment) {
  return APP.intakeReviewProperty + '_' + normalizeEnvironment_(environment || getActiveEnvironment_());
}

function getPendingIntakeReview_(environment) {
  const raw = PropertiesService.getScriptProperties().getProperty(intakeReviewProperty_(environment));
  return raw ? JSON.parse(raw) : null;
}

function setPendingIntakeReview_(review) {
  review.updatedAt = nowIso_();
  PropertiesService.getScriptProperties().setProperty(intakeReviewProperty_(review.environment), JSON.stringify(review));
}

function clearPendingIntakeReview_(environment) {
  PropertiesService.getScriptProperties().deleteProperty(intakeReviewProperty_(environment));
}

function intakeReviewCacheSheet_(environment, createIfMissing) {
  const spreadsheet = getFoundationSpreadsheet_();
  const sheetName = resolveSheetName_(APP.sheets.intakeReviewCache, environment);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet && createIfMissing) sheet = spreadsheet.insertSheet(sheetName);
  return sheet;
}

function clearIntakeReviewCache_(environment) {
  const sheet = intakeReviewCacheSheet_(environment, false);
  if (!sheet) return;
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['TOKEN', 'JSON_CHUNK']]);
  sheet.hideSheet();
}

function writeIntakeReviewCache_(review) {
  const sheet = intakeReviewCacheSheet_(review.environment, true);
  const serialized = JSON.stringify(review);
  const chunkSize = 40000;
  const rows = [];
  for (let offset = 0; offset < serialized.length; offset += chunkSize) {
    rows.push([offset === 0 ? review.token : '', serialized.substring(offset, offset + chunkSize)]);
  }
  ensureSheetCapacity_(sheet, rows.length + 1, 2);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['TOKEN', 'JSON_CHUNK']]);
  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  sheet.hideSheet();
  SpreadsheetApp.flush();
}

function readIntakeReviewCache_(environment, token) {
  const sheet = intakeReviewCacheSheet_(environment, false);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  if (!rows.length || cleanText_(rows[0][0]) !== cleanText_(token)) return null;
  const serialized = rows.map(function (row) { return row[1] || ''; }).join('');
  return serialized ? JSON.parse(serialized) : null;
}

function appendIntakeReviewPartial_(environment, token, partIndex, partial) {
  const sheet = intakeReviewCacheSheet_(environment, true);
  const serialized = JSON.stringify(partial);
  const rows = [];
  const chunkSize = 40000;
  for (let offset = 0, chunkIndex = 0; offset < serialized.length; offset += chunkSize, chunkIndex += 1) {
    rows.push([token + '|PARTIAL|' + partIndex + '|' + chunkIndex, serialized.substring(offset, offset + chunkSize)]);
  }
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + rows.length - 1, 2);
  if (rows.length) sheet.getRange(startRow, 1, rows.length, 2).setValues(rows);
  sheet.hideSheet();
}

function readIntakeReviewPartials_(environment, token) {
  const sheet = intakeReviewCacheSheet_(environment, false);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const prefix = cleanText_(token) + '|PARTIAL|';
  const grouped = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach(function (row) {
    const key = cleanText_(row[0]);
    if (key.indexOf(prefix) !== 0) return;
    const parts = key.substring(prefix.length).split('|');
    const partIndex = Number(parts[0]);
    const chunkIndex = Number(parts[1]);
    if (!grouped[partIndex]) grouped[partIndex] = [];
    grouped[partIndex][chunkIndex] = row[1] || '';
  });
  return Object.keys(grouped).map(Number).sort(function (left, right) { return left - right; }).map(function (partIndex) {
    return JSON.parse(grouped[partIndex].join(''));
  });
}

function mergeCountArrays_(target, values) {
  (values || []).forEach(function (item) {
    const key = cleanText_(item.key || item.label || item.name);
    if (!key) return;
    target[key] = Number(target[key] || 0) + Number(item.count || item.value || 0);
  });
}

function countMapArray_(counts) {
  return Object.keys(counts || {}).map(function (key) { return { label: key, value: Number(counts[key] || 0) }; })
    .sort(function (left, right) { return right.value - left.value || left.label.localeCompare(right.label); });
}

function mergeIntakeReviewPartials_(partials, staged) {
  const numericFields = [
    'sourceRows', 'candidates', 'belowThreshold', 'unassessable', 'restrictedAssets', 'initialRestrictedAssets',
    'restrictionTransitions', 'restrictionCleared', 'newCandidates', 'changedCandidates', 'unchangedCandidates',
    'noLongerCandidates', 'missingFromExtract', 'expectedPurges', 'expectedSelfPurges', 'newlyStaleRecords',
    'existingLifecycleChanges', 'quarantinePurgeChanges', 'notificationAssets', 'orphanStaleAssets',
    'quarantineNotificationAssets', 'restorationNotificationAssets', 'invalidIdentifiers', 'missingContact',
    'missingDomain', 'schemaOwnerMatchedAssets', 'schemaOwnerUnmatchedAssets'
  ];
  const sampleKeys = [
    'initialRestrictions', 'newCandidates', 'changedCandidates', 'restrictionTransitions', 'restrictionCleared',
    'reappearances', 'unassessable', 'noLongerCandidates', 'missingFromExtract'
  ];
  const merged = {
    environment: staged.environment, fileName: staged.fileName, fileSizeBytes: staged.fileSizeBytes,
    uploadedBy: staged.uploadedBy, sourceRows: 0, sourceColumns: staged.sourceColumns,
    sourceSnapshotAt: '', tableTypes: [], domains: [], notificationPayloadPreviews: [], samples: {}
  };
  numericFields.forEach(function (field) { merged[field] = 0; });
  sampleKeys.forEach(function (key) { merged.samples[key] = []; });
  const tableTypes = {};
  const domains = {};
  const payloads = {};
  const sourceSeen = {};
  const duplicates = {};
  const managedSeen = {};
  (partials || []).forEach(function (partial) {
    numericFields.forEach(function (field) { merged[field] += Number(partial[field] || 0); });
    if (cleanText_(partial.sourceSnapshotAt) > cleanText_(merged.sourceSnapshotAt)) merged.sourceSnapshotAt = partial.sourceSnapshotAt;
    merged.schemaOwnerRegistryEligible = Number(partial.schemaOwnerRegistryEligible || merged.schemaOwnerRegistryEligible || 0);
    merged.schemaOwnerRegistryWithoutOwner = Number(partial.schemaOwnerRegistryWithoutOwner || merged.schemaOwnerRegistryWithoutOwner || 0);
    merged.schemaOwnerRegistryUrl = partial.schemaOwnerRegistryUrl || merged.schemaOwnerRegistryUrl || '';
    mergeCountArrays_(tableTypes, partial.tableTypes);
    mergeCountArrays_(domains, partial.domains);
    sampleKeys.forEach(function (key) {
      merged.samples[key] = merged.samples[key].concat((partial.samples && partial.samples[key]) || []).slice(0, 250);
    });
    (partial.sourceAssetIds || []).forEach(function (assetId) {
      if (sourceSeen[assetId]) duplicates[assetId] = true;
      sourceSeen[assetId] = true;
    });
    (partial.managedAssetIds || []).forEach(function (assetId) { managedSeen[assetId] = true; });
    (partial.notificationPayloadPreviews || []).forEach(function (payload) {
      const key = cleanText_(payload.messageType) + '|' + cleanText_(payload.recipient).toLowerCase();
      if (!payloads[key]) payloads[key] = Object.assign({}, payload, { assetCount: 0, assetIds: [], assets: [] });
      payloads[key].assetCount += Number(payload.assetCount || 0);
      payloads[key].assetIds = payloads[key].assetIds.concat(payload.assetIds || []);
      payloads[key].assets = payloads[key].assets.concat(payload.assets || []).slice(0, 10);
    });
  });
  if (Object.keys(duplicates).length) {
    throw new Error('The intake contains ' + Object.keys(duplicates).length + ' duplicate FQN values. Correct the file before EDG review.');
  }
  merged.tableTypes = countMapArray_(tableTypes);
  merged.domains = countMapArray_(domains);
  merged.notificationPayloadPreviews = Object.keys(payloads).sort().map(function (key) { return payloads[key]; });
  merged.notificationGroups = merged.notificationPayloadPreviews.filter(function (item) { return item.messageType === 'STALE_ASSET_NOTICE'; }).length;
  merged.quarantineNotificationGroups = merged.notificationPayloadPreviews.filter(function (item) {
    return ['ORPHAN_QUARANTINE_NOTICE', 'QUARANTINE_NOTICE'].indexOf(item.messageType) !== -1;
  }).length;
  merged.restorationNotificationGroups = merged.notificationPayloadPreviews.filter(function (item) { return item.messageType === 'RESTORATION_CONFIRMED'; }).length;
  merged.duplicateFqns = 0;
  merged._sourceAssetIds = Object.keys(sourceSeen);
  merged._managedAssetIds = Object.keys(managedSeen);
  return merged;
}

function mergeReviewPayloadPreviews_(review, additions) {
  const index = {};
  (review.notificationPayloadPreviews || []).forEach(function (payload) {
    index[cleanText_(payload.messageType) + '|' + cleanText_(payload.recipient).toLowerCase()] = payload;
  });
  (additions || []).forEach(function (payload) {
    const key = cleanText_(payload.messageType) + '|' + cleanText_(payload.recipient).toLowerCase();
    if (!index[key]) {
      index[key] = Object.assign({}, payload, { assetCount: 0, assetIds: [], assets: [] });
      review.notificationPayloadPreviews.push(index[key]);
    }
    index[key].assetCount += Number(payload.assetCount || 0);
    index[key].assetIds = index[key].assetIds.concat(payload.assetIds || []);
    index[key].assets = index[key].assets.concat(payload.assets || []).slice(0, 10);
  });
}

function reconcileIntakeReviewChunk_(review, cursorRow, batchSize) {
  const sheet = getSheet_(APP.sheets.assetsCurrent);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const startRow = Math.max(2, Number(cursorRow || 2));
  if (startRow > lastRow || lastColumn < 1) return { nextRow: startRow, done: true };
  const count = Math.min(Math.max(1, Number(batchSize || 150)), lastRow - startRow + 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const assets = sheet.getRange(startRow, 1, count, lastColumn).getDisplayValues().map(function (row) {
    return rowToObject_(headers, row);
  });
  const assetIds = assets.map(function (asset) { return cleanText_(asset.ASSET_ID); }).filter(Boolean);
  const cases = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', assetIds), 'ASSET_ID');
  const completedPurge = {};
  readObjectsByKeys_(APP.sheets.platformActions, 'ASSET_ID', assetIds).forEach(function (action) {
    if (cleanText_(action.ACTION).toUpperCase() === 'PURGE' && cleanText_(action.STATUS).toUpperCase() === 'COMPLETED') {
      completedPurge[action.ASSET_ID] = true;
    }
  });
  const sourceSeen = (review._sourceAssetIds || []).reduce(function (index, assetId) { index[assetId] = true; return index; }, {});
  const managedSeen = (review._managedAssetIds || []).reduce(function (index, assetId) { index[assetId] = true; return index; }, {});
  const noLonger = [];
  const missing = [];
  assets.forEach(function (asset) {
    const assetId = cleanText_(asset.ASSET_ID);
    if (!assetId || managedSeen[assetId]) return;
    const caseRecord = cases[assetId] || {};
    const currentState = canonicalLifecycleState_(caseRecord.STATE || asset.LIFECYCLE_STATE);
    const currentAssetStatus = deriveAssetStatus_(asset);
    if ([APP.assetStatus.stale, APP.assetStatus.quarantined].indexOf(currentAssetStatus) === -1 &&
        currentState !== APP.lifecycle.selfPurgePending) return;
    const item = {
      assetId: assetId, fqn: asset.OBJECT_FQN, type: asset.ASSET_TYPE, domain: asset.DOMAIN || 'UNASSIGNED',
      lifecycleState: currentState, assetStatus: currentAssetStatus, messageType: '', primaryRecipient: ''
    };
    if (sourceSeen[assetId]) {
      if (currentAssetStatus === APP.assetStatus.stale) {
        item.changeSummary = 'Application activity analysis changed from STALE to ACTIVE';
        noLonger.push(item);
      }
      return;
    }
    const purgeDue = caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= new Date();
    const willVerifyPurge = [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(currentState) !== -1 &&
      completedPurge[assetId] && purgeDue;
    const willVerifySelfPurge = currentState === APP.lifecycle.selfPurgePending;
    item.purgeVerification = Boolean(willVerifyPurge || willVerifySelfPurge);
    if (willVerifySelfPurge) {
      review.expectedSelfPurges += 1;
      item.changeSummary = 'Absent after owner self-purge intent; publication will verify PURGED';
      item.messageType = 'None — owner self-service';
      item.primaryRecipient = 'No notification';
    } else if (willVerifyPurge) {
      review.expectedPurges += 1;
      item.changeSummary = 'Absent after completed purge handoff; publication will verify PURGED';
      item.messageType = 'PURGE_COMPLETED';
      const routing = resolvePrimaryRecipient_({ asset: asset, events: [] }, 'PURGE_COMPLETED');
      item.primaryRecipient = routing.primaryRecipient || 'No Slack recipient';
      item.primaryRecipientRole = routing.primaryRecipientSource || '';
    } else {
      item.changeSummary = 'Not present in the uploaded complete extract; lifecycle will be retained for reconciliation';
    }
    missing.push(item);
  });
  review.noLongerCandidates += noLonger.length;
  review.missingFromExtract += missing.length;
  review.existingLifecycleChanges += noLonger.length;
  review.quarantinePurgeChanges += missing.filter(function (item) { return item.purgeVerification; }).length;
  review.samples.noLongerCandidates = review.samples.noLongerCandidates.concat(noLonger).slice(0, 250);
  review.samples.missingFromExtract = review.samples.missingFromExtract.concat(missing).slice(0, 250);
  mergeReviewPayloadPreviews_(review, buildIntakeSlackPayloadPreviews_(missing, review.sourceSnapshotAt));
  const nextRow = startRow + count;
  return { nextRow: nextRow, done: nextRow > lastRow };
}

function stageSnowflakeCsvUpload(formObject) {
  const actor = assertAdmin_();
  const profile = assertEnvironmentWritable_();
  clearBlankProductionWorkflowState_();
  if (!profile.importEnabled) throw new Error(profile.label + ' imports are disabled.');
  if (getAnyImportState_()) throw new Error('An import is already running. Wait for it to finish before uploading another file.');
  if (getAnyRunningImportNotificationCampaign_()) throw new Error('A post-import Slack campaign is still running. Wait for it to finish before uploading another file.');
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
  const sheet = writeIntakeUploadSheet_(headers, rows, profile.key);
  clearIntakeReviewCache_(profile.key);
  const staged = {
    token: uuid_(),
    environment: profile.key,
    preparationStatus: 'STAGED',
    sourceSpreadsheetId: APP.foundationSpreadsheetId,
    sourceSheetName: sheet.getName(),
    sourceRows: rows.length,
    sourceColumns: headers.length,
    headerSignature: headers.join('|'),
    sourceSnapshotAt: '',
    fileName: fileName,
    fileSizeBytes: bytes.length,
    uploadedBy: actor.email,
    uploadedAt: nowIso_()
  };
  setPendingIntakeReview_(staged);
  return staged;
}

function prepareSnowflakeIntakeReview(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const token = cleanText_(input && input.token || input);
  const staged = getPendingIntakeReview_(profile.key);
  if (!staged || staged.token !== token) throw new Error('This staged upload is no longer current. Upload the CSV again.');
  if (getAnyImportState_()) throw new Error('An import is already running. Wait for it to finish before preparing another review.');
  const source = SpreadsheetApp.openById(staged.sourceSpreadsheetId).getSheetByName(staged.sourceSheetName);
  if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
  staged.preparationStatus = 'QUEUED';
  staged.preparationStartedAt = nowIso_();
  staged.lastError = '';
  setPendingIntakeReview_(staged);
  try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
  return getIntakeReviewPreparationStatus({ token: token });
}

function continueSnowflakeIntakeReview(input) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return input && input.token ? getIntakeReviewPreparationStatus(input) : null;
  let staged;
  try {
    deleteIntakeReviewPreparationTriggers_();
    const requestedToken = cleanText_(input && input.token);
    staged = ['PRD', 'DEV'].map(function (environment) { return getPendingIntakeReview_(environment); })
      .filter(function (review) {
        return review && ['QUEUED', 'CALCULATING_REVIEW', 'MERGING_REVIEW', 'RECONCILING_REVIEW'].indexOf(review.preparationStatus) !== -1 &&
          (!requestedToken || review.token === requestedToken);
      })[0];
    if (!staged) return;
    setExecutionEnvironment_(staged.environment, false);
    const source = SpreadsheetApp.openById(staged.sourceSpreadsheetId).getSheetByName(staged.sourceSheetName);
    if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
    const width = source.getLastColumn();
    const headers = source.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (value) {
      return cleanText_(value).toUpperCase();
    });
    if (source.getLastRow() - 1 !== staged.sourceRows || headers.join('|') !== staged.headerSignature) {
      throw new Error('The staged source changed after upload. Upload the CSV again.');
    }

    if (staged.preparationStatus === 'QUEUED') {
      clearIntakeReviewCache_(staged.environment);
      staged.preparationStatus = 'CALCULATING_REVIEW';
      staged.calculationStartedAt = nowIso_();
      staged.reviewCursorRow = 2;
      staged.reviewProcessedRows = 0;
      staged.reviewPartCount = 0;
      setPendingIntakeReview_(staged);
    }

    if (staged.preparationStatus === 'CALCULATING_REVIEW') {
      const batchSize = Math.max(50, Math.min(250, configNumber_('INTAKE_REVIEW_BATCH_SIZE', 150)));
      const finalRow = staged.sourceRows + 1;
      const count = Math.min(batchSize, finalRow - Number(staged.reviewCursorRow || 2) + 1);
      if (count > 0) {
        const rows = source.getRange(staged.reviewCursorRow, 1, count, width).getDisplayValues();
        const partial = calculateIntakeReview_(headers, rows, {
          fileName: staged.fileName, fileSizeBytes: staged.fileSizeBytes, uploadedBy: staged.uploadedBy,
          environment: staged.environment, sourceSnapshotAt: staged.sourceSnapshotAt,
          reviewSampleLimit: 20, incremental: true
        });
        appendIntakeReviewPartial_(staged.environment, staged.token, Number(staged.reviewPartCount || 0), partial);
        staged.reviewCursorRow += count;
        staged.reviewProcessedRows += count;
        staged.reviewPartCount += 1;
        staged.lastCheckpointAt = nowIso_();
        if (staged.reviewCursorRow > finalRow) staged.preparationStatus = 'MERGING_REVIEW';
        setPendingIntakeReview_(staged);
        try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
        return getIntakeReviewPreparationStatus({ token: staged.token });
      }
      staged.preparationStatus = 'MERGING_REVIEW';
      setPendingIntakeReview_(staged);
      try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
      return getIntakeReviewPreparationStatus({ token: staged.token });
    }

    if (staged.preparationStatus === 'MERGING_REVIEW') {
      const partials = readIntakeReviewPartials_(staged.environment, staged.token);
      if (partials.length !== Number(staged.reviewPartCount || 0)) {
        throw new Error('One or more intake-review checkpoints could not be loaded. Upload the CSV again.');
      }
      const mergedReview = mergeIntakeReviewPartials_(partials, staged);
      mergedReview.token = staged.token;
      mergedReview.sourceSpreadsheetId = staged.sourceSpreadsheetId;
      mergedReview.sourceSheetName = staged.sourceSheetName;
      mergedReview.headerSignature = staged.headerSignature;
      mergedReview.uploadedAt = staged.uploadedAt;
      mergedReview.reviewedAt = nowIso_();
      writeIntakeReviewCache_(mergedReview);
      staged.preparationStatus = 'RECONCILING_REVIEW';
      staged.reconciliationCursorRow = 2;
      setPendingIntakeReview_(staged);
      try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
      return getIntakeReviewPreparationStatus({ token: staged.token });
    }

    const review = readIntakeReviewCache_(staged.environment, staged.token);
    if (!review) throw new Error('The merged intake review could not be loaded. Upload the CSV again.');
    const reconciliation = reconcileIntakeReviewChunk_(review, Number(staged.reconciliationCursorRow || 2),
      Math.max(50, Math.min(250, configNumber_('INTAKE_REVIEW_BATCH_SIZE', 150))));
    staged.reconciliationCursorRow = reconciliation.nextRow;
    if (!reconciliation.done) {
      writeIntakeReviewCache_(review);
      setPendingIntakeReview_(staged);
      try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
      return getIntakeReviewPreparationStatus({ token: staged.token });
    }
    delete review._sourceAssetIds;
    delete review._managedAssetIds;
    writeIntakeReviewCache_(review);
    const summary = pendingIntakeReviewSummary_(review);
    summary.preparationCompletedAt = nowIso_();
    setPendingIntakeReview_(summary);
    deleteIntakeReviewPreparationTriggers_();
    return getIntakeReviewPreparationStatus({ token: staged.token });
  } catch (error) {
    if (staged) {
      staged.preparationStatus = 'FAILED';
      staged.lastError = String(error && error.message ? error.message : error).substring(0, 1000);
      staged.failedAt = nowIso_();
      setPendingIntakeReview_(staged);
    }
    console.error(error && error.stack ? error.stack : error);
  } finally {
    lock.releaseLock();
  }
}

function calculateAndStoreIntakeReview_(staged) {
  const source = SpreadsheetApp.openById(staged.sourceSpreadsheetId).getSheetByName(staged.sourceSheetName);
  if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
  const width = source.getLastColumn();
  const rowCount = Math.max(0, source.getLastRow() - 1);
  const headers = source.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (value) {
    return cleanText_(value).toUpperCase();
  });
  if (rowCount !== staged.sourceRows || headers.join('|') !== staged.headerSignature) {
    throw new Error('The staged source changed after upload. Upload the CSV again.');
  }
  const rows = rowCount ? source.getRange(2, 1, rowCount, width).getDisplayValues() : [];
  const review = calculateIntakeReview_(headers, rows, {
    fileName: staged.fileName,
    fileSizeBytes: staged.fileSizeBytes,
    uploadedBy: staged.uploadedBy,
    environment: staged.environment
  });
  review.token = staged.token;
  review.sourceSpreadsheetId = staged.sourceSpreadsheetId;
  review.sourceSheetName = staged.sourceSheetName;
  review.headerSignature = staged.headerSignature;
  review.uploadedAt = staged.uploadedAt;
  review.reviewedAt = nowIso_();
  writeIntakeReviewCache_(review);
  const summary = pendingIntakeReviewSummary_(review);
  summary.preparationCompletedAt = nowIso_();
  setPendingIntakeReview_(summary);
}

function getIntakeReviewPreparationStatus(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const token = cleanText_(input && input.token || input);
  const pending = getPendingIntakeReview_(profile.key);
  if (!pending || pending.token !== token) throw new Error('This staged upload is no longer current. Upload the CSV again.');
  const updated = pending.updatedAt ? new Date(pending.updatedAt) : null;
  const stalled = ['QUEUED', 'CALCULATING_REVIEW', 'MERGING_REVIEW', 'RECONCILING_REVIEW'].indexOf(pending.preparationStatus) !== -1 &&
    updated && !isNaN(updated.getTime()) && Date.now() - updated.getTime() > 8 * 60 * 1000;
  if (stalled) {
    pending.preparationStatus = 'FAILED';
    pending.lastError = 'Review preparation stopped responding before it completed. The staged data was not published.';
    pending.failedAt = nowIso_();
    setPendingIntakeReview_(pending);
    deleteIntakeReviewPreparationTriggers_();
  }
  const status = {
    token: pending.token,
    environment: pending.environment,
    status: pending.preparationStatus,
    running: ['QUEUED', 'CALCULATING_REVIEW', 'MERGING_REVIEW', 'RECONCILING_REVIEW'].indexOf(pending.preparationStatus) !== -1,
    stalled: stalled,
    sourceRows: Number(pending.sourceRows || 0),
    sourceColumns: Number(pending.sourceColumns || 0),
    fileName: pending.fileName || '',
    fileSizeBytes: Number(pending.fileSizeBytes || 0),
    processedRows: Number(pending.reviewProcessedRows || 0),
    totalRows: Number(pending.sourceRows || 0),
    percent: Number(pending.sourceRows || 0) ? Math.min(99, Math.round(Number(pending.reviewProcessedRows || 0) * 100 / Number(pending.sourceRows))) : 0,
    startedAt: pending.preparationStartedAt || pending.uploadedAt || '',
    updatedAt: pending.updatedAt || '',
    lastError: pending.lastError || ''
  };
  if (pending.preparationStatus === 'READY') {
    status.review = readIntakeReviewCache_(profile.key, pending.token);
    if (!status.review) {
      status.status = 'FAILED';
      status.running = false;
      status.lastError = 'The prepared review result could not be loaded. Upload the CSV again.';
    }
  }
  return status;
}

function scheduleIntakeReviewPreparation_() {
  deleteIntakeReviewPreparationTriggers_();
  ScriptApp.newTrigger('continueSnowflakeIntakeReview').timeBased().after(10000).create();
}

function deleteIntakeReviewPreparationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueSnowflakeIntakeReview') ScriptApp.deleteTrigger(trigger);
  });
}

function pendingIntakeReviewSummary_(review) {
  return {
    token: review.token,
    environment: review.environment,
    preparationStatus: 'READY',
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
    orphanStaleAssets: review.orphanStaleAssets,
    restorationNotificationAssets: review.restorationNotificationAssets,
    restorationNotificationGroups: review.restorationNotificationGroups,
    schemaOwnerRegistryEligible: review.schemaOwnerRegistryEligible,
    schemaOwnerRegistryWithoutOwner: review.schemaOwnerRegistryWithoutOwner,
    schemaOwnerMatchedAssets: review.schemaOwnerMatchedAssets,
    schemaOwnerUnmatchedAssets: review.schemaOwnerUnmatchedAssets,
    schemaOwnerRegistryUrl: review.schemaOwnerRegistryUrl
  };
}

function calculateIntakeReview_(headers, rows, metadata) {
  const headerMap = validateSnowflakeV2Headers_(headers);
  const schemaOwnerLookup = loadSchemaOwnerLookup_();
  const reviewSampleLimit = Math.max(20, Number(metadata && metadata.reviewSampleLimit) || 250);
  const incremental = Boolean(metadata && metadata.incremental);
  const sourceAssetIds = rows.map(function (row) {
    const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(row, headerMap, 'TABLE_NAME');
    const fqn = (sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
    return fqn ? 'SNOWFLAKE|' + fqn : '';
  }).filter(Boolean);
  const currentAssets = indexObjectsBy_(incremental
    ? readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', sourceAssetIds)
    : readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const cases = indexObjectsBy_(incremental
    ? readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', sourceAssetIds)
    : readObjects_(APP.sheets.cases), 'ASSET_ID');
  const completedPurgeActions = {};
  (incremental ? [] : readObjects_(APP.sheets.platformActions)).forEach(function (action) {
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
  let orphanStaleAssets = 0;
  let unassessable = 0;
  let expectedPurges = 0;
  let expectedSelfPurges = 0;
  let sourceSnapshotAt = '';
  let schemaOwnerMatchedAssets = 0;
  let schemaOwnerUnmatchedAssets = 0;

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
    const schemaOwner = schemaOwnerForRow_(row, headerMap, schemaOwnerLookup);
    if (schemaOwner && schemaOwner.email) schemaOwnerMatchedAssets += 1;
    else schemaOwnerUnmatchedAssets += 1;
    const contact = firstEmail_([
      sourceValue_(row, headerMap, 'SF_DPM_TEAM'),
      sourceValue_(row, headerMap, 'SF_BDS_TEAM'),
      technicalSteward,
      businessSteward,
      sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER'),
      schemaOwner && schemaOwner.email,
      sourceValue_(row, headerMap, 'DATABASE_OWNER')
    ]);
    const rawSourceDataStatus = sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS');
    const sourceDataStatus = normalizedSnowflakeDataStatus_(rawSourceDataStatus);
    const hasExplicitSourceDataStatus = Boolean(rawSourceDataStatus);
    const isRestricted = sourceDataStatus === APP.lifecycle.restricted;
    const wasRestricted = normalizedSnowflakeDataStatus_(existing && existing.SNOWFLAKE_DATA_STATUS) === APP.lifecycle.restricted;
    const hasExistingBaseline = Boolean(existing || caseRecord);
    const isInitialRestriction = isRestricted && !hasExistingBaseline;
    const activity = deriveSourceActivity_(row, headerMap, snapshot || metadata.sourceSnapshotAt || nowIso_(),
      configNumber_('STALE_THRESHOLD_DAYS', 180));
    const summary = intakeAssetSummary_(row, headerMap, assetId, fqn, activity, schemaOwner);
    const routingDetail = intakeRoutingDetail_(row, headerMap, schemaOwner);
    summary.lifecycleState = currentState;
    summary.dismissible = activity.isStale && !isRestricted && isIntakeDismissibleState_(currentState);
    const isReappearance = currentState === APP.lifecycle.purged;
    if (isReappearance) {
      const restorationRouting = resolvePrimaryRecipient_(routingDetail, 'RESTORATION_CONFIRMED');
      const restorationRecipient = restorationRouting.primaryRecipient;
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'Previously purged asset reappeared → Restored';
      summary.messageType = 'RESTORATION_CONFIRMED';
      summary.primaryRecipient = restorationRecipient || 'No Slack recipient';
      summary.primaryRecipientRole = restorationRouting.primaryRecipientSource || '';
      summary.dismissible = false;
      reappearanceItems.push(summary);
      if (restorationRecipient) restorationNotificationRecipients[restorationRecipient] = true;
    }
    if (!activity.assessable) {
      unassessable += 1;
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'Read staleness cannot be evaluated from the supplied timestamps; any existing lifecycle will be retained.';
      unassessableItems.push(summary);
    }
    if (isRestricted || activity.isStale || (!activity.assessable && hasExistingBaseline) || currentState === APP.lifecycle.selfPurgePending) {
      managedImportIds[assetId] = true;
    }
    if (isRestricted && !isReappearance) {
      restrictedAssets += 1;
      if ([APP.lifecycle.quarantined, APP.lifecycle.purgeEligible, APP.lifecycle.selfPurgePending].indexOf(currentState) === -1) {
        summary.messageType = ['ORPHANED', 'UNKNOWN'].indexOf(cleanText_(summary.ownershipStatus).toUpperCase()) !== -1
          ? 'ORPHAN_QUARANTINE_NOTICE' : 'QUARANTINE_NOTICE';
        const restrictionRouting = resolvePrimaryRecipient_(routingDetail, summary.messageType);
        const restrictionRecipient = restrictionRouting.primaryRecipient;
        summary.primaryRecipient = restrictionRecipient || 'No Slack recipient';
        summary.primaryRecipientRole = restrictionRouting.primaryRecipientSource || '';
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
    } else if (wasRestricted && hasExplicitSourceDataStatus && !isReappearance) {
      restrictionCleared += 1;
      summary.reviewGroup = 'LIFECYCLE';
      summary.changeSummary = 'Snowflake data status: RESTRICTED → ' + sourceDataStatus + '; lifecycle is not restored automatically';
      restrictionClearedItems.push(summary);
    }
    if (!activity.assessable) return;
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
      const changes = materialIntakeChanges_(existing, row, headerMap, schemaOwner);
      summary.changes = changes;
      if (changes.length) changedItems.push(summary);
      else unchangedItems.push(summary);
    }
    if (opensNewCase && !isRestricted) {
      const isOrphan = ['ORPHANED', 'UNKNOWN'].indexOf(cleanText_(summary.ownershipStatus).toUpperCase()) !== -1;
      const messageType = isOrphan ? 'ORPHAN_QUARANTINE_NOTICE' : 'STALE_ASSET_NOTICE';
      const routing = resolvePrimaryRecipient_(routingDetail, messageType);
      const recipient = routing.primaryRecipient;
      if (isOrphan) {
        orphanStaleAssets += 1;
        summary.orphanQuarantine = true;
        summary.messageType = messageType;
        summary.primaryRecipient = recipient || 'EDG recipient not configured';
        summary.primaryRecipientRole = routing.primaryRecipientSource || '';
      } else {
        notificationAssets += 1;
        summary.messageType = 'STALE_ASSET_NOTICE';
        summary.primaryRecipient = recipient || 'No Slack recipient';
        summary.primaryRecipientRole = routing.primaryRecipientSource || '';
        if (recipient) notificationRecipients[recipient] = true;
      }
    }
  });
  if (Object.keys(duplicateCandidates).length) {
    throw new Error('The intake contains ' + Object.keys(duplicateCandidates).length + ' duplicate stale-candidate FQN values. Correct the file before EDG review.');
  }

  const noLonger = [];
  const missing = [];
  if (!incremental) Object.keys(currentAssets).forEach(function (assetId) {
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
        const purgeRouting = willVerifySelfPurge ? null : resolvePrimaryRecipient_({ asset: asset, events: [] }, 'PURGE_COMPLETED');
        item.primaryRecipient = willVerifySelfPurge ? 'No notification' :
          (purgeRouting.primaryRecipient || 'No Slack recipient');
        item.primaryRecipientRole = purgeRouting ? (purgeRouting.primaryRecipientSource || '') : '';
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
  const notificationPayloadPreviews = buildIntakeSlackPayloadPreviews_(
    newItems.concat(changedItems, initialRestrictionItems, restrictionItems, reappearanceItems, missing),
    sourceSnapshotAt
  );

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
    orphanStaleAssets: orphanStaleAssets,
    notificationGroups: Object.keys(notificationRecipients).length,
    quarantineNotificationAssets: initialRestrictedAssets + restrictionTransitions,
    quarantineNotificationGroups: Object.keys(quarantineNotificationRecipients).length,
    restorationNotificationAssets: reappearanceItems.length,
    restorationNotificationGroups: Object.keys(restorationNotificationRecipients).length,
    notificationPayloadPreviews: notificationPayloadPreviews,
    invalidIdentifiers: invalidIdentifiers,
    duplicateFqns: 0,
    missingContact: missingContact,
    missingDomain: missingDomain,
    schemaOwnerRegistryEligible: schemaOwnerLookup.eligibleRows,
    schemaOwnerRegistryWithoutOwner: schemaOwnerLookup.eligibleWithoutOwner,
    schemaOwnerMatchedAssets: schemaOwnerMatchedAssets,
    schemaOwnerUnmatchedAssets: schemaOwnerUnmatchedAssets,
    schemaOwnerRegistryUrl: 'https://docs.google.com/spreadsheets/d/' + schemaOwnerLookup.spreadsheetId + '/edit#gid=275290904',
    tableTypes: countMapToArray_(tableTypes),
    domains: countMapToArray_(domains),
    sourceAssetIds: incremental ? Object.keys(fullFqns).map(function (fqn) { return 'SNOWFLAKE|' + fqn; }) : [],
    managedAssetIds: incremental ? Object.keys(managedImportIds) : [],
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

function intakeAssetSummary_(row, headerMap, assetId, fqn, activity, schemaOwner) {
  const derived = activity || deriveSourceActivity_(row, headerMap,
    sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT') || nowIso_(), configNumber_('STALE_THRESHOLD_DAYS', 180));
  const thresholdDays = configNumber_('STALE_THRESHOLD_DAYS', 180);
  const stalenessSourceField = derived.source === 'LAST_READ' ? 'LAST_READ' :
    (derived.source === 'OBJECT_CREATED_DATE_FALLBACK' ? 'OBJECT_CREATED_DATE' : '');
  return {
    assetId: assetId,
    fqn: fqn,
    type: sourceValue_(row, headerMap, 'TABLE_TYPE') || 'UNKNOWN',
    domain: sourceValue_(row, headerMap, 'SF_DOMAIN') || 'UNASSIGNED',
    subDomain: sourceValue_(row, headerMap, 'SF_SUB_DOMAIN'),
    snowflakeDataStatus: normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')),
    ownershipStatus: deriveOwnershipCoverage_(row, headerMap, schemaOwner),
    schemaOwner: schemaOwner && (schemaOwner.name || schemaOwner.email) || '',
    schemaOwnerStatus: schemaOwner && schemaOwner.status || '',
    primarySteward: firstEmail_([
      sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD'),
      sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD')
    ]) || 'No Slack email',
    daysInactive: derived.daysInactive === null ? 'Signal gap' : derived.daysInactive,
    stalenessAnchor: derived.stalenessAnchorTs || '',
    stalenessSignal: derived.source || '',
    stalenessSourceField: stalenessSourceField,
    stalenessSourceValue: stalenessSourceField ? sourceValue_(row, headerMap, stalenessSourceField) : '',
    stalenessStatus: derived.status || '',
    staleThresholdDays: thresholdDays,
    assetStatus: normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')) === APP.lifecycle.restricted
      ? APP.assetStatus.quarantined : (derived.isStale ? APP.assetStatus.stale : APP.assetStatus.active),
    activitySource: derived.source,
    messageType: '',
    primaryRecipient: '',
    primaryRecipientRole: ''
  };
}

function buildIntakeSlackPayloadPreviews_(items, sourceSnapshotAt) {
  const groups = {};
  const seen = {};
  (items || []).forEach(function (item) {
    const messageType = cleanText_(item.messageType);
    const recipient = cleanText_(item.primaryRecipient).toLowerCase();
    if (!messageType || !recipient || /no slack|not configured|no notification/i.test(recipient)) return;
    const uniqueKey = messageType + '|' + cleanText_(item.assetId);
    if (seen[uniqueKey]) return;
    seen[uniqueKey] = true;
    const groupKey = messageType + '|' + recipient;
    if (!groups[groupKey]) groups[groupKey] = { messageType: messageType, recipient: recipient, roles: {}, items: [] };
    if (item.primaryRecipientRole) groups[groupKey].roles[item.primaryRecipientRole] = true;
    const previewT0 = sourceSnapshotAt || nowIso_();
    const contestDeadline = new Date(previewT0);
    if (!isNaN(contestDeadline.getTime())) contestDeadline.setUTCDate(contestDeadline.getUTCDate() + configNumber_('CONTEST_WINDOW_DAYS', 9));
    const caseRecord = {
      CASE_ID: 'PREVIEW|' + cleanText_(item.assetId),
      STATE: messageType === 'STALE_ASSET_NOTICE' ? APP.lifecycle.detected : (item.lifecycleState || item.assetStatus || ''),
      CONTEST_DEADLINE: messageType === 'STALE_ASSET_NOTICE' && !isNaN(contestDeadline.getTime()) ? contestDeadline.toISOString() : '',
      RESTRICT_AT: '',
      QUARANTINE_START_DATE: '',
      PURGE_ELIGIBLE_DATE: ''
    };
    groups[groupKey].items.push({
      detail: {
        asset: {
          ASSET_ID: item.assetId,
          OBJECT_FQN: item.fqn,
          PLATFORM: 'SNOWFLAKE',
          ENVIRONMENT: getEnvironmentProfile_().key,
          ESTIMATED_LAST_ACTIVITY_DATE: item.stalenessAnchor || '',
          DAYS_SINCE_READ: typeof item.daysInactive === 'number' ? item.daysInactive : '',
          STALE_THRESHOLD_DAYS: item.staleThresholdDays || configNumber_('STALE_THRESHOLD_DAYS', 180)
        },
        caseRecord: caseRecord,
        events: [],
        exceptionUrl: ''
      },
      record: {},
      primaryRecipientRole: item.primaryRecipientRole || ''
    });
  });
  return Object.keys(groups).sort().map(function (key) {
    const group = groups[key];
    const sortedItems = group.items.slice().sort(function (left, right) {
      return cleanText_(left.detail.asset.OBJECT_FQN).localeCompare(cleanText_(right.detail.asset.OBJECT_FQN));
    });
    return {
      messageType: group.messageType,
      recipient: group.recipient,
      recipientRole: Object.keys(group.roles).sort().join(', ') || 'UNRESOLVED',
      assetCount: group.items.length,
      assetIds: group.items.map(function (item) { return item.detail.asset.ASSET_ID; }),
      assets: sortedItems.slice(0, 10).map(function (item) {
        return {
          assetId: item.detail.asset.ASSET_ID,
          fqn: item.detail.asset.OBJECT_FQN,
          daysInactive: item.detail.asset.DAYS_SINCE_READ,
          stalenessAnchor: item.detail.asset.ESTIMATED_LAST_ACTIVITY_DATE,
          recipientRole: item.primaryRecipientRole || ''
        };
      })
    };
  });
}

function intakeRoutingDetail_(row, headerMap, schemaOwner) {
  const snowflakeOwner = sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER');
  return {
    asset: {
      PLATFORM: 'SNOWFLAKE',
      DPM_TEAM: sourceValue_(row, headerMap, 'SF_DPM_TEAM'),
      BDS_TEAM: sourceValue_(row, headerMap, 'SF_BDS_TEAM'),
      BUSINESS_STEWARD: sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD'),
      TECHNICAL_STEWARD: sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD'),
      SNOWFLAKE_TABLE_OWNER: snowflakeOwner,
      SCHEMA_OWNER: schemaOwner && schemaOwner.email || '',
      DATABASE_OWNER: sourceValue_(row, headerMap, 'DATABASE_OWNER')
    },
    events: []
  };
}

function materialIntakeChanges_(asset, row, headerMap, schemaOwner) {
  const comparisons = [
    ['Asset type', asset.ASSET_TYPE, sourceValue_(row, headerMap, 'TABLE_TYPE')],
    cleanText_(asset.SNOWFLAKE_TABLE_ID)
      ? ['Snowflake table ID', asset.SNOWFLAKE_TABLE_ID, sourceValue_(row, headerMap, 'TABLE_ID')]
      : null,
    ['Snowflake owner', asset.SNOWFLAKE_TABLE_OWNER || asset.DATABASE_OWNER, sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER')],
    ['Schema owner', asset.SCHEMA_OWNER, schemaOwner && schemaOwner.email || ''],
    ['Schema owner assignment', asset.SCHEMA_OWNER_ASSIGNMENT_STATUS, schemaOwner && schemaOwner.status || ''],
    ['Database owner', asset.DATABASE_OWNER, sourceValue_(row, headerMap, 'DATABASE_OWNER')],
    ['Snowflake data status', normalizedSnowflakeDataStatus_(asset.SNOWFLAKE_DATA_STATUS), normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS'))],
    ['DPM team', asset.DPM_TEAM, sourceValue_(row, headerMap, 'SF_DPM_TEAM')],
    ['BDS team', asset.BDS_TEAM, sourceValue_(row, headerMap, 'SF_BDS_TEAM')],
    ['Business steward', asset.BUSINESS_STEWARD, sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD')],
    ['Technical steward', asset.TECHNICAL_STEWARD, sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD')],
    ['Ownership status', asset.OWNERSHIP_STATUS, deriveOwnershipCoverage_(row, headerMap)],
    ['Ownership source', asset.OWNERSHIP_SOURCE, sourceValue_(row, headerMap, 'OWNERSHIP_SOURCE')],
    ['Domain', asset.DOMAIN, sourceValue_(row, headerMap, 'SF_DOMAIN')],
    ['Sub-domain', asset.SUB_DOMAIN, sourceValue_(row, headerMap, 'SF_SUB_DOMAIN')],
    ['Object created', asset.OBJECT_CREATED_DATE, sourceValue_(row, headerMap, 'OBJECT_CREATED_DATE')],
    ['Last read', asset.LAST_READ, sourceValue_(row, headerMap, 'LAST_READ')],
    ['Last write', asset.LAST_WRITE, sourceValue_(row, headerMap, 'LAST_WRITE')],
    ['Last load', asset.LAST_LOAD, sourceValue_(row, headerMap, 'LAST_LOAD')],
    ['Last altered', asset.LAST_ALTERED, sourceValue_(row, headerMap, 'LAST_ALTERED')],
    ['Rows', asset.ROW_COUNT, sourceValue_(row, headerMap, 'ROW_COUNT')],
    ['Bytes', asset.BYTES, sourceValue_(row, headerMap, 'BYTES')]
  ];
  return comparisons.filter(Boolean).filter(function (item) {
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
  deleteIntakeReviewPreparationTriggers_();
  clearIntakeReviewCache_(profile.key);
  clearPendingIntakeReview_(profile.key);
  return { discarded: true };
}

function reviewSnowflakeIntake() {
  assertAdmin_();
  const review = getPendingIntakeReview_();
  if (!review) throw new Error('Upload a CSV with Import & Refresh Data to begin intake review.');
  if (review.preparationStatus !== 'READY') throw new Error('The staged CSV review is not ready. Upload the file again to restart review preparation.');
  return readIntakeReviewCache_(review.environment, review.token) || review;
}

function exportSnowflakeIntakeReview(reviewInput) {
  assertAdmin_();
  const payload = reviewInput && typeof reviewInput === 'object' ? reviewInput : { token: reviewInput };
  const profile = assertEnvironmentWritable_();
  const pending = getPendingIntakeReview_(profile.key);
  if (!pending || pending.token !== cleanText_(payload.token)) {
    throw new Error('This intake review is no longer current. Upload the CSV again.');
  }
  if (pending.preparationStatus !== 'READY') throw new Error('The intake review is not ready for export.');
  const source = SpreadsheetApp.openById(pending.sourceSpreadsheetId).getSheetByName(pending.sourceSheetName);
  if (!source) throw new Error('The staged intake data was not found. Upload the CSV again.');
  const width = source.getLastColumn();
  const sourceRowCount = Math.max(0, source.getLastRow() - 1);
  const headers = source.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (value) {
    return cleanText_(value).toUpperCase();
  });
  validateSnowflakeV2Headers_(headers);
  if (sourceRowCount !== pending.sourceRows || headers.join('|') !== pending.headerSignature) {
    throw new Error('The staged source changed after review. Upload the CSV again before exporting.');
  }
  const rows = sourceRowCount ? source.getRange(2, 1, sourceRowCount, width).getDisplayValues() : [];
  const currentAssets = indexObjectsBy_(readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const review = calculateIntakeReview_(headers, rows, {
    fileName: pending.fileName,
    fileSizeBytes: pending.fileSizeBytes,
    uploadedBy: pending.uploadedBy,
    environment: pending.environment,
    sourceSnapshotAt: pending.sourceSnapshotAt,
    reviewSampleLimit: rows.length + Object.keys(currentAssets).length + 10
  });
  const exported = buildSnowflakeIntakeReviewExport_(
    headers, rows, review, payload.dismissedAssetIds || [], currentAssets, loadCaseMap_(), loadSchemaOwnerLookup_()
  );
  return {
    fileName: intakeReviewExportFileName_(pending.fileName),
    headers: exported.headers,
    rows: exported.rows
  };
}

function buildSnowflakeIntakeReviewExport_(headers, rows, review, dismissedAssetIds, currentAssets, cases, schemaOwnerLookup) {
  const headerMap = validateSnowflakeV2Headers_(headers);
  const dismissed = {};
  (dismissedAssetIds || []).map(cleanText_).filter(Boolean).forEach(function (assetId) { dismissed[assetId] = true; });
  const reviewItems = intakeReviewExportItemMap_(review);
  const sourceAssetIds = {};
  const appendedHeaders = [
    'EXPORT_RECORD_ORIGIN', 'SOURCE_ROW_NUMBER', 'APP_ASSET_ID', 'APP_IS_STALE',
    'APP_STALENESS_SOURCE_FIELD', 'APP_STALENESS_SOURCE_VALUE', 'APP_DAYS_INACTIVE',
    'APP_STALENESS_STATUS', 'APP_STALE_THRESHOLD_DAYS', 'APP_ASSET_STATUS',
    'CURRENT_LIFECYCLE_STATE', 'REVIEW_STAGE', 'REVIEW_TYPE', 'REVIEW_LABEL', 'REVIEW_CHANGE',
    'DISMISSED_IN_REVIEW', 'PROPOSED_LIFECYCLE_STATE', 'RECONCILED_OWNERSHIP_STATUS',
    'RECONCILED_CONTACT_COVERAGE_STATUS', 'SCHEMA_OWNER_MATCHED', 'SCHEMA_OWNER_EMAIL',
    'SCHEMA_OWNER_NAME', 'SCHEMA_OWNER_USERNAME', 'SCHEMA_OWNER_ASSIGNMENT_STATUS',
    'NOTIFICATION_MESSAGE_TYPE', 'NOTIFICATION_RECIPIENT', 'NOTIFICATION_RECIPIENT_ROLE',
    'NOTIFICATION_WILL_SEND'
  ];
  const exportRows = [];
  rows.forEach(function (sourceRow, index) {
    const rawRow = sourceRow.slice(0, headers.length);
    while (rawRow.length < headers.length) rawRow.push('');
    const database = sourceValue_(rawRow, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(rawRow, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(rawRow, headerMap, 'TABLE_NAME');
    const fqn = (sourceValue_(rawRow, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
    const assetId = fqn ? 'SNOWFLAKE|' + fqn : '';
    if (assetId) sourceAssetIds[assetId] = true;
    const schemaOwner = schemaOwnerForRow_(rawRow, headerMap, schemaOwnerLookup);
    const snapshot = sourceValue_(rawRow, headerMap, 'SOURCE_SNAPSHOT_AT') || review.sourceSnapshotAt || nowIso_();
    const activity = deriveSourceActivity_(rawRow, headerMap, snapshot, configNumber_('STALE_THRESHOLD_DAYS', 180));
    const existing = currentAssets[assetId] || {};
    const currentState = canonicalLifecycleState_((cases[assetId] && cases[assetId].STATE) || existing.LIFECYCLE_STATE);
    const item = reviewItems[assetId] || intakeReviewExportFallbackItem_(assetId, fqn, activity, existing);
    item.sourceRowNumber = index + 2;
    exportRows.push(rawRow.concat(intakeReviewExportDetails_(
      item, assetId, activity, currentState, Boolean(dismissed[assetId]),
      deriveOwnershipCoverage_(rawRow, headerMap, schemaOwner),
      deriveContactCoverage_(rawRow, headerMap, schemaOwner), schemaOwner
    )));
  });
  Object.keys(reviewItems).forEach(function (assetId) {
    const item = reviewItems[assetId];
    if (sourceAssetIds[assetId] || item.reviewType !== 'MISSING_FROM_EXTRACT') return;
    const asset = currentAssets[assetId] || {};
    const rawRow = intakeReviewRawRowFromAsset_(headers, asset);
    const currentState = canonicalLifecycleState_((cases[assetId] && cases[assetId].STATE) || asset.LIFECYCLE_STATE);
    const schemaOwner = asset.SCHEMA_OWNER ? {
      email: asset.SCHEMA_OWNER,
      name: asset.SCHEMA_OWNER_NAME,
      username: asset.SCHEMA_OWNER_USERNAME,
      status: asset.SCHEMA_OWNER_ASSIGNMENT_STATUS
    } : null;
    const activity = {
      isStale: deriveAssetStatus_(asset, currentState) === APP.assetStatus.stale,
      assessable: cleanText_(asset.EVALUATION_STATUS).toUpperCase() !== 'SIGNAL_GAP',
      source: asset.LAST_READ ? 'LAST_READ' : (asset.OBJECT_CREATED_DATE ? 'OBJECT_CREATED_DATE_FALLBACK' : ''),
      stalenessAnchorTs: asset.LAST_READ || asset.OBJECT_CREATED_DATE || '',
      daysInactive: asset.DAYS_SINCE_READ === '' ? asset.DAYS_SINCE_ANY_ACTIVITY : asset.DAYS_SINCE_READ,
      status: asset.EVALUATION_STATUS || ''
    };
    exportRows.push(rawRow.concat(intakeReviewExportDetails_(
      item, assetId, activity, currentState, false,
      asset.OWNERSHIP_STATUS || '', asset.CONTACT_COVERAGE_STATUS || '', schemaOwner, 'RECONCILIATION_ONLY'
    )));
  });
  return { headers: headers.concat(appendedHeaders), rows: exportRows };
}

function intakeReviewExportItemMap_(review) {
  const samples = review.samples || {};
  const map = {};
  const definitions = [
    ['initialRestrictions', 'QUARANTINE_PURGE', 'INITIAL_RESTRICTED', 'Initial restricted asset'],
    ['reappearances', 'LIFECYCLE', 'REAPPEARED', 'Purged asset reappeared'],
    ['restrictionTransitions', 'QUARANTINE_PURGE', 'QUARANTINE', 'Quarantine confirmation'],
    ['restrictionCleared', 'LIFECYCLE', 'RESTRICTION_CLEARED', 'Restriction cleared'],
    ['noLongerCandidates', 'LIFECYCLE', 'RECOVERED', 'No longer stale'],
    ['missingFromExtract', 'QUARANTINE_PURGE', 'MISSING_FROM_EXTRACT', 'Missing from complete extract'],
    ['unassessable', 'LIFECYCLE', 'SIGNAL_GAP', 'Staleness signal gap'],
    ['newCandidates', 'NEW_STALE', 'NEW', 'New stale record'],
    ['changedCandidates', 'NEW_STALE', 'CHANGED', 'Changed stale record']
  ];
  definitions.forEach(function (definition) {
    (samples[definition[0]] || []).forEach(function (item) {
      if (!item.assetId || map[item.assetId]) return;
      const copy = Object.assign({}, item);
      copy.reviewStage = definition[1];
      copy.reviewType = definition[2];
      copy.reviewLabel = definition[3];
      map[item.assetId] = copy;
    });
  });
  return map;
}

function intakeReviewExportFallbackItem_(assetId, fqn, activity, existing) {
  if (!assetId) return {
    assetId: '', fqn: fqn, reviewStage: 'DATA_QUALITY', reviewType: 'INVALID_IDENTIFIER',
    reviewLabel: 'Invalid identifier', changeSummary: 'No Snowflake asset ID could be derived from this row.'
  };
  if (!activity.assessable) return {
    assetId: assetId, fqn: fqn, reviewStage: 'LIFECYCLE', reviewType: 'SIGNAL_GAP',
    reviewLabel: 'Staleness signal gap', changeSummary: 'Staleness cannot be evaluated from the supplied timestamps.'
  };
  if (!activity.isStale) return {
    assetId: assetId, fqn: fqn, reviewStage: 'INVENTORY', reviewType: 'ACTIVE',
    reviewLabel: 'Active inventory', changeSummary: existing && existing.ASSET_ID ? 'No stale lifecycle change.' : 'New active inventory record.'
  };
  return {
    assetId: assetId, fqn: fqn, reviewStage: 'INVENTORY', reviewType: 'UNCHANGED_STALE',
    reviewLabel: 'Unchanged stale inventory', changeSummary: 'Existing stale lifecycle state is retained.'
  };
}

function intakeReviewExportDetails_(item, assetId, activity, currentState, isDismissed, ownershipStatus, contactCoverage, schemaOwner, origin) {
  const sourceField = activity.source === 'LAST_READ' ? 'LAST_READ' :
    (activity.source === 'OBJECT_CREATED_DATE_FALLBACK' ? 'OBJECT_CREATED_DATE' : '');
  const messageType = cleanText_(item.messageType);
  const recipient = cleanText_(item.primaryRecipient);
  const willSend = Boolean(messageType && recipient && !isDismissed && !/no slack|not configured|no notification/i.test(recipient));
  return [
    origin || 'UPLOADED_SOURCE_ROW', item.sourceRowNumber || '', assetId,
    activity.assessable ? (activity.isStale ? 'TRUE' : 'FALSE') : '', sourceField,
    activity.stalenessAnchorTs || item.stalenessAnchor || '',
    activity.daysInactive === null || activity.daysInactive === undefined ? '' : activity.daysInactive,
    activity.status || item.stalenessStatus || '', configNumber_('STALE_THRESHOLD_DAYS', 180),
    item.assetStatus || (activity.isStale ? APP.assetStatus.stale : APP.assetStatus.active),
    currentState, item.reviewStage || '', item.reviewType || '', item.reviewLabel || '',
    item.changeSummary || intakeReviewExportChangeSummary_(item), isDismissed ? 'TRUE' : 'FALSE',
    intakeReviewExportProposedState_(item, currentState, isDismissed), ownershipStatus, contactCoverage,
    schemaOwner && schemaOwner.email ? 'TRUE' : 'FALSE', schemaOwner && schemaOwner.email || '',
    schemaOwner && schemaOwner.name || '', schemaOwner && schemaOwner.username || '', schemaOwner && schemaOwner.status || '',
    messageType, recipient, item.primaryRecipientRole || '', willSend ? 'TRUE' : 'FALSE'
  ];
}

function intakeReviewExportChangeSummary_(item) {
  if (!(item.changes || []).length) return '';
  return item.changes.map(function (change) {
    return change.field + ': ' + change.before + ' → ' + change.after;
  }).join('; ');
}

function intakeReviewExportProposedState_(item, currentState, isDismissed) {
  if (isDismissed) return APP.lifecycle.dismissed;
  if (item.reviewType === 'INITIAL_RESTRICTED' || item.reviewType === 'QUARANTINE') return APP.lifecycle.quarantined;
  if (item.reviewType === 'REAPPEARED') return APP.lifecycle.restored;
  if (item.reviewType === 'RECOVERED') return APP.lifecycle.active;
  if (item.reviewType === 'MISSING_FROM_EXTRACT') return item.purgeVerification ? APP.lifecycle.purged : (currentState || 'RETAINED');
  if ((item.reviewType === 'NEW' || item.reviewType === 'CHANGED') && item.opensNewCase) {
    return item.orphanQuarantine ? APP.lifecycle.accepted : APP.lifecycle.detected;
  }
  return currentState || (item.assetStatus === APP.assetStatus.active ? APP.lifecycle.active : 'NO_CHANGE');
}

function intakeReviewRawRowFromAsset_(headers, asset) {
  const values = {
    TABLE_ID: asset.SNOWFLAKE_TABLE_ID, DATABASE_NAME: asset.DATABASE_NAME, SCHEMA_NAME: asset.SCHEMA_NAME,
    TABLE_NAME: asset.OBJECT_NAME, TABLE_FQN: asset.OBJECT_FQN, TABLE_TYPE: asset.ASSET_TYPE,
    ROW_COUNT: asset.ROW_COUNT, BYTES: asset.BYTES, OBJECT_CREATED_DATE: asset.OBJECT_CREATED_DATE,
    LAST_READ: asset.LAST_READ, LAST_WRITE: asset.LAST_WRITE, LAST_LOAD: asset.LAST_LOAD,
    LAST_ALTERED: asset.LAST_ALTERED, SOURCE_SNAPSHOT_AT: asset.SOURCE_SNAPSHOT_AT || asset.SNAPSHOT_AT,
    SF_DOMAIN: asset.DOMAIN, SF_SUB_DOMAIN: asset.SUB_DOMAIN, SF_TECHNICAL_STEWARD: asset.TECHNICAL_STEWARD,
    SF_BUSINESS_STEWARD: asset.BUSINESS_STEWARD, SF_DPM_TEAM: asset.DPM_TEAM, SF_BDS_TEAM: asset.BDS_TEAM,
    SNOWFLAKE_TABLE_OWNER: asset.SNOWFLAKE_TABLE_OWNER, DATABASE_OWNER: asset.DATABASE_OWNER,
    OWNERSHIP_STATUS: asset.OWNERSHIP_STATUS, OWNERSHIP_SOURCE: asset.OWNERSHIP_SOURCE,
    SNOWFLAKE_DATA_STATUS: asset.SNOWFLAKE_DATA_STATUS
  };
  return headers.map(function (header) { return values[header] === undefined ? '' : values[header]; });
}

function intakeReviewExportFileName_(sourceFileName) {
  const base = cleanText_(sourceFileName).replace(/\.csv$/i, '').replace(/[^a-z0-9._-]+/gi, '_') || 'snowflake_intake';
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyyMMdd_HHmmss');
  return base + '_review_details_' + stamp + '.csv';
}

function confirmSnowflakeIntake(reviewInput) {
  const actor = assertAdmin_();
  const payload = reviewInput && typeof reviewInput === 'object' ? reviewInput : { token: reviewInput };
  const profile = assertEnvironmentWritable_();
  let review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(payload.token)) throw new Error('This intake review is no longer current. Upload the CSV again.');
  if (review.preparationStatus !== 'READY') throw new Error('The intake review is not ready to publish.');
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
  if (review.preparationStatus !== 'READY') throw new Error('The intake review is not ready to publish.');
  if (review.environment !== profile.key) throw new Error('The reviewed intake belongs to a different environment.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (getAnyImportState_()) throw new Error('An import is already running.');
    ensureDataModelV2_();
    reclaimOperationalGridCapacity_();
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
      progressStage: 'QUEUED_FOR_SOURCE_EVALUATION',
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
    try { scheduleImportContinuation_(); } catch (scheduleError) {}
    return getImportStatus();
  } finally {
    lock.releaseLock();
  }
}

function continueSnowflakeImport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return getImportStatus();
  try {
    deleteImportContinuationTriggers_();
    let state = getAnyImportState_();
    if (state && normalizeEnvironment_(state.environment) === 'PRD') {
      setExecutionEnvironment_('PRD', false);
      clearBlankProductionWorkflowState_();
      state = getAnyImportState_();
    }
    if (!state) return getImportStatus();
    setExecutionEnvironment_(state.environment, false);
    if (state.phase === 'IMPORT') {
      importSourceChunk_(state, false, true);
      const current = getImportState_(state.environment);
      if (current && ['IMPORT', 'PREPARE_FINALIZE'].indexOf(current.phase) !== -1) {
        try { scheduleImportContinuation_(); } catch (scheduleError) {}
      }
    } else if (state.phase === 'PREPARE_FINALIZE') beginImportFinalization_(state, false);
    else if (state.phase === 'FINALIZE') finalizeImport_(state);
    return getImportStatus();
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
  const finalizationFailure = state.phase === 'FINALIZE' || state.phase === 'PREPARE_FINALIZE';
  updateJobRun_(state.runId, {
    STATUS: 'FAILED', COMPLETED_AT: nowIso_(), ERROR_COUNT: Number(state.errors || 0) + 1,
    MESSAGE: String(error && error.message ? error.message : error)
  });
  if (finalizationFailure) {
    state.progressStage = 'FINALIZATION_PAUSED';
    state.message = 'Finalization paused at the latest durable checkpoint: ' +
      String(error && error.message ? error.message : error).substring(0, 500);
    state.lastError = String(error && error.message ? error.message : error).substring(0, 500);
    setImportState_(state);
    deleteImportContinuationTriggers_();
  } else {
    clearImportState_(state.environment);
  }
}

function importSourceChunk_(state, inlineExecution, deferScheduling) {
  setExecutionEnvironment_(state.environment, false);
  const source = SpreadsheetApp.openById(state.sourceSpreadsheetId).getSheetByName(state.sourceSheetName);
  if (!source) throw new Error('The staged intake source is no longer available.');
  const headerMap = validateSnowflakeV2Headers_(state.sourceHeaders);
  const configuredChunkSize = Math.max(50, configNumber_('IMPORT_CHUNK_SIZE', APP.defaultImportChunkSize));
  const safeBatchSize = Math.max(50, Math.min(250,
    configNumber_('SAFE_IMPORT_BATCH_SIZE', APP.defaultSafeImportBatchSize)));
  const chunkSize = Math.min(configuredChunkSize, safeBatchSize);
  const finalSourceRow = state.sourceRows + 1;
  const count = Math.min(chunkSize, finalSourceRow - state.cursorRow + 1);
  if (count <= 0) {
    queueImportFinalization_(state, inlineExecution, deferScheduling);
    return;
  }

  state.progressStage = 'PROCESSING_SOURCE_BATCH';
  state.message = 'Processing source rows ' + (state.processedRows + 1) + ' through ' + (state.processedRows + count) + ' of ' + state.sourceRows;
  setImportState_(state);

  const rows = source.getRange(state.cursorRow, 1, count, state.sourceColumnCount).getDisplayValues();
  const policy = {
    staleThresholdDays: configNumber_('STALE_THRESHOLD_DAYS', 180),
    contestWindowDays: configNumber_('CONTEST_WINDOW_DAYS', 9),
    signalCoverage: 'LAST_READ,OBJECT_CREATED_DATE_FALLBACK'
  };
  const batchAssetIds = rows.map(function (row) {
    const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(row, headerMap, 'TABLE_NAME');
    const fqn = (sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
    return fqn ? 'SNOWFLAKE|' + fqn : '';
  }).filter(Boolean);
  const cases = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', batchAssetIds), 'ASSET_ID');
  const schemaOwnerLookup = loadSchemaOwnerLookup_();
  const assetRows = [];
  const snapshots = [];
  const newCases = [];
  const updatedCases = [];
  const newEvents = [];

  rows.forEach(function (row, offset) {
    try {
      const result = normalizeSnowflakeRowV2_(row, headerMap, state.cursorRow + offset, state.snapshotAt, state.runId, cases, policy, schemaOwnerLookup);
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
  state.message = 'Evaluated and retained ' + state.processedRows + ' of ' + state.sourceRows + ' source rows';
  updateJobRun_(state.runId, {
    CURSOR_ROW: state.cursorRow, PROCESSED_ROWS: state.processedRows,
    WRITTEN_ROWS: state.writtenRows, ERROR_COUNT: state.errors, MESSAGE: state.message
  });
  if (state.cursorRow > finalSourceRow) {
    queueImportFinalization_(state, inlineExecution, deferScheduling);
  } else {
    state.progressStage = 'QUEUED_FOR_NEXT_SOURCE_BATCH';
    setImportState_(state);
    if (!deferScheduling) try { scheduleImportContinuation_(); } catch (scheduleError) {}
  }
}

function queueImportFinalization_(state, inlineExecution, deferScheduling) {
  if (inlineExecution) {
    beginImportFinalization_(state, true);
    return;
  }
  state.phase = 'PREPARE_FINALIZE';
  state.progressStage = 'SOURCE_EVALUATION_COMPLETE';
  state.message = 'All source rows are evaluated; preparing the published asset dataset';
  setImportState_(state);
  if (!deferScheduling) try { scheduleImportContinuation_(); } catch (scheduleError) {}
}

function beginImportFinalization_(state, inlineExecution) {
  state.phase = 'FINALIZE';
  state.progressStage = 'PUBLISHING_ASSET_BUFFER';
  state.message = 'Publishing the evaluated asset dataset';
  setImportState_(state);
  swapAssetBuffers_();
  state.progressStage = 'RECONCILING_LIFECYCLE';
  state.message = 'Reconciling lifecycle cases and sending immediate consolidated stale-asset outreach';
  setImportState_(state);
  if (inlineExecution) finalizeImport_(state);
  else try { scheduleImportContinuation_(); } catch (scheduleError) {}
}

function normalizeSnowflakeRowV2_(row, headerMap, sourceRow, snapshotAt, runId, cases, policy, schemaOwnerLookup) {
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
  const rawSnowflakeDataStatus = sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS');
  const snowflakeDataStatus = normalizedSnowflakeDataStatus_(rawSnowflakeDataStatus);
  const isRestricted = snowflakeDataStatus === APP.lifecycle.restricted;
  const reviewDecision = sourceValue_(row, headerMap, 'EDG_REVIEW_DECISION').toUpperCase();
  const existing = cases[assetId] || null;
  const existingState = canonicalLifecycleState_(existing && existing.STATE);
  const retainedStaleStates = [
    APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested,
    APP.lifecycle.accepted, APP.lifecycle.exempt, APP.lifecycle.dismissed,
    APP.lifecycle.selfPurgePending
  ];
  const retainStaleDesignation = !activity.assessable && existing && retainedStaleStates.indexOf(existingState) !== -1;
  const effectiveStale180 = isStale180 || retainStaleDesignation;
  const daysActivity = activity.daysInactive;
  const assetType = sourceValue_(row, headerMap, 'TABLE_TYPE').toUpperCase() || 'UNKNOWN';
  const bytes = parseNumber_(sourceValue_(row, headerMap, 'BYTES'));
  const businessSteward = sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD');
  const technicalSteward = sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD');
  const schemaOwner = schemaOwnerForRow_(row, headerMap, schemaOwnerLookup);
  const contactEmail = firstEmail_([
    sourceValue_(row, headerMap, 'SF_DPM_TEAM'),
    sourceValue_(row, headerMap, 'SF_BDS_TEAM'),
    technicalSteward,
    businessSteward,
    sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER'),
    schemaOwner && schemaOwner.email,
    sourceValue_(row, headerMap, 'DATABASE_OWNER')
  ]);
  const ownershipStatus = deriveOwnershipCoverage_(row, headerMap, schemaOwner);
  let lifecycleState = existingState || (isStale180 || isRestricted ? APP.lifecycle.detected : APP.lifecycle.active);
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
      policyRule: 'APPLICATION_LAST_READ_THRESHOLD', daysInactive: daysActivity, activitySource: activity.source
    });
  } else if (isStale180 && existingState === APP.lifecycle.detected && !cleanText_(existing.NOTIFIED_AT)) {
    // Keep an unnotified detection eligible for approval on the current reviewed import.
    // This also repairs notification-critical fields written under an older sheet-column order.
    caseValue = Object.assign({}, existing, {
      OWNER_STATUS: ownershipStatus,
      LAST_EVALUATION_RUN_ID: runId,
      LAST_TRANSITION_AT: existing.LAST_TRANSITION_AT || sourceSnapshot,
      NOTES: 'Stale candidate remains unnotified and was reconfirmed by the reviewed Snowflake intake.'
    });
    updatedCase = caseValue;
    lifecycleState = APP.lifecycle.detected;
  } else if (activity.assessable && !isStale180 && existing && [APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted, APP.lifecycle.exempt].indexOf(existingState) !== -1) {
    lifecycleState = APP.lifecycle.active;
    updatedCase = Object.assign({}, existing, {
      STATE: APP.lifecycle.active,
      LAST_TRANSITION_AT: sourceSnapshot,
      LAST_EVALUATION_RUN_ID: runId,
      NOTES: 'Latest complete extract shows qualifying read activity inside the stale threshold.'
    });
    caseValue = updatedCase;
    event = lifecycleEventRow_(existing.CASE_ID, assetId, 'STALE_ASSET_BECAME_ACTIVE', existingState, APP.lifecycle.active, sourceSnapshot, 'SYSTEM', runId, {
      daysInactive: daysActivity
    });
  }

  const effectiveSnowflakeDataStatus = rawSnowflakeDataStatus
    ? snowflakeDataStatus
    : ([APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(lifecycleState) !== -1
      ? APP.lifecycle.restricted : APP.lifecycle.active);

  const asset = {
    ASSET_ID: assetId,
    PLATFORM: 'SNOWFLAKE',
    ENVIRONMENT: inferEnvironment_(database, schema),
    DATABASE_NAME: database,
    SCHEMA_NAME: schema,
    OBJECT_NAME: objectName,
    OBJECT_FQN: objectFqn,
    SNOWFLAKE_TABLE_ID: sourceValue_(row, headerMap, 'TABLE_ID'),
    ASSET_TYPE: assetType,
    SIZE_GB: bytes === null ? '' : Math.round(bytes / 1073741824 * 1000) / 1000,
    DAYS_SINCE_LAST_DDL: '',
    DAYS_SINCE_READ: daysActivity,
    DAYS_SINCE_ANY_ACTIVITY: daysActivity,
    DAYS_SINCE_OPERATIONAL_ACTIVITY: activity.daysSinceOperationalActivity,
    ESTIMATED_LAST_ACTIVITY_DATE: activity.stalenessAnchorTs,
    SOURCE_ACTIVITY_STATUS: isRestricted ? 'SNOWFLAKE_DATA_STATUS=RESTRICTED' : activity.status,
    POLICY_RULE: isRestricted ? 'SNOWFLAKE_DATA_STATUS_RESTRICTED' : 'APPLICATION_LAST_READ_THRESHOLD',
    EVALUATION_STATUS: !activity.assessable ? 'SIGNAL_GAP' : (isStale180 ? 'STALE' : 'ACTIVE'),
    STALE_THRESHOLD_DAYS: policy.staleThresholdDays,
    OWNERSHIP_STATUS: ownershipStatus,
    DATABASE_OWNER: sourceValue_(row, headerMap, 'DATABASE_OWNER'),
    SCHEMA_OWNER: schemaOwner && schemaOwner.email || '',
    SCHEMA_OWNER_NAME: schemaOwner && schemaOwner.name || '',
    SCHEMA_OWNER_USERNAME: schemaOwner && schemaOwner.username || '',
    SCHEMA_OWNER_ASSIGNMENT_STATUS: schemaOwner && schemaOwner.status || '',
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
    OBJECT_CREATED_DATE: sourceValue_(row, headerMap, 'OBJECT_CREATED_DATE'),
    LAST_READ: sourceValue_(row, headerMap, 'LAST_READ'),
    LAST_WRITE: sourceValue_(row, headerMap, 'LAST_WRITE'),
    LAST_LOAD: sourceValue_(row, headerMap, 'LAST_LOAD'),
    LAST_ALTERED: sourceValue_(row, headerMap, 'LAST_ALTERED'),
    LAST_ACTIVITY_TS: activity.lastOperationalActivityTs,
    IS_STALE_180: effectiveStale180,
    SOURCE_SNAPSHOT_AT: sourceSnapshot,
    CONTACT_COVERAGE_STATUS: deriveContactCoverage_(row, headerMap, schemaOwner),
    SNOWFLAKE_DATA_STATUS: effectiveSnowflakeDataStatus,
    ASSET_STATUS: deriveAssetStatus_({
      LIFECYCLE_STATE: lifecycleState,
      EVALUATION_STATUS: !activity.assessable ? 'SIGNAL_GAP' : (isStale180 ? 'STALE' : 'ACTIVE'),
      IS_STALE_180: effectiveStale180,
      SNOWFLAKE_DATA_STATUS: effectiveSnowflakeDataStatus
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
  const rawLastRead = sourceValue_(row, headerMap, 'LAST_READ');
  const rawCreated = sourceValue_(row, headerMap, 'OBJECT_CREATED_DATE');
  const snapshotDate = validSourceDate_(snapshotAt);
  const lastRead = validSourceDate_(rawLastRead);
  const objectCreated = validSourceDate_(rawCreated);
  const operationalActivity = latestSourceDate_([
    sourceValue_(row, headerMap, 'LAST_WRITE'),
    sourceValue_(row, headerMap, 'LAST_LOAD'),
    sourceValue_(row, headerMap, 'LAST_ALTERED'),
    rawCreated
  ]);
  const operationalDays = snapshotDate && operationalActivity
    ? elapsedWholeDays_(operationalActivity, snapshotDate) : null;
  const threshold = Math.max(1, Number(thresholdDays || 180));

  if (!snapshotDate) {
    return sourceActivityResult_('', null, false, false, 'INVALID_SOURCE_SNAPSHOT_AT', Boolean(!rawLastRead),
      operationalActivity, operationalDays);
  }
  if (rawLastRead && !lastRead) {
    return sourceActivityResult_('', null, false, false, 'INVALID_LAST_READ_TIMESTAMP', false,
      operationalActivity, operationalDays);
  }

  const anchor = lastRead || objectCreated;
  if (!anchor) {
    const reason = rawCreated ? 'INVALID_OBJECT_CREATED_DATE' : 'MISSING_OBJECT_CREATED_DATE';
    return sourceActivityResult_('', null, false, false, reason, true, operationalActivity, operationalDays);
  }

  const daysInactive = elapsedWholeDays_(anchor, snapshotDate);
  const isStale = daysInactive >= threshold;
  const status = lastRead
    ? (isStale ? 'STALE_LAST_READ' : 'RECENT_READ')
    : (isStale ? 'STALE_NO_READ_IN_AVAILABLE_HISTORY' : 'NEW_UNREAD');
  return {
    stalenessAnchorTs: anchor.toISOString(),
    lastOperationalActivityTs: operationalActivity ? operationalActivity.toISOString() : '',
    daysInactive: daysInactive,
    daysSinceOperationalActivity: operationalDays,
    isStale: isStale,
    assessable: true,
    source: lastRead ? 'LAST_READ' : 'OBJECT_CREATED_DATE_FALLBACK',
    status: status,
    noRead: !lastRead
  };
}

function sourceActivityResult_(anchorTs, daysInactive, isStale, assessable, status, noRead, operationalActivity, operationalDays) {
  return {
    stalenessAnchorTs: anchorTs,
    lastOperationalActivityTs: operationalActivity ? operationalActivity.toISOString() : '',
    daysInactive: daysInactive,
    daysSinceOperationalActivity: operationalDays,
    isStale: isStale,
    assessable: assessable,
    source: status,
    status: status,
    noRead: noRead
  };
}

function validSourceDate_(value) {
  const text = cleanText_(value);
  if (!text) return null;
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function latestSourceDate_(values) {
  return (values || []).map(validSourceDate_).filter(Boolean).sort(function (left, right) {
    return right.getTime() - left.getTime();
  })[0] || null;
}

function elapsedWholeDays_(earlier, later) {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86400000));
}

function assetReadInactivityDays_(asset) {
  const value = asset || {};
  if (Object.prototype.hasOwnProperty.call(value, 'DAYS_SINCE_READ')) return parseNumber_(value.DAYS_SINCE_READ);
  return parseNumber_(value.DAYS_SINCE_ANY_ACTIVITY);
}

function normalizedSnowflakeDataStatus_(value) {
  const status = cleanText_(value).toUpperCase();
  if (!status) return APP.lifecycle.active;
  if (status.split(/[,;|]+/).map(cleanText_).indexOf(APP.lifecycle.restricted) !== -1) return APP.lifecycle.restricted;
  return status;
}

function deriveOwnershipCoverage_(row, headerMap, schemaOwner) {
  const dpmTeam = sourceValue_(row, headerMap, 'SF_DPM_TEAM');
  const bdsTeam = sourceValue_(row, headerMap, 'SF_BDS_TEAM');
  const technicalSteward = sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD');
  const businessSteward = sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD');
  const tableOwner = sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER');
  const databaseOwner = sourceValue_(row, headerMap, 'DATABASE_OWNER');
  const sourceStatus = sourceValue_(row, headerMap, 'OWNERSHIP_STATUS').toUpperCase();
  const ownershipSource = sourceValue_(row, headerMap, 'OWNERSHIP_SOURCE').toUpperCase();
  const sourceSignalsAccountableOwner = [
    'DPM_TEAM + BDS_TEAM', 'DPM_TEAM_ONLY', 'BDS_TEAM_ONLY',
    'BUSINESS_STEWARD_ONLY', 'TECHNICAL_STEWARD_ONLY', 'SNOWFLAKE_TABLE_OWNER_ONLY'
  ].indexOf(ownershipSource) !== -1;

  if (sourceStatus === 'DISPUTED') return 'DISPUTED';
  if (dpmTeam || bdsTeam || technicalSteward || businessSteward || tableOwner ||
      (schemaOwner && schemaOwner.email) || databaseOwner || sourceSignalsAccountableOwner) return 'KNOWN';
  return 'ORPHANED';
}

function deriveContactCoverage_(row, headerMap, schemaOwner) {
  const contacts = [
    sourceValue_(row, headerMap, 'SF_DPM_TEAM'),
    sourceValue_(row, headerMap, 'SF_BDS_TEAM'),
    sourceValue_(row, headerMap, 'SF_TECHNICAL_STEWARD'),
    sourceValue_(row, headerMap, 'SF_BUSINESS_STEWARD'),
    sourceValue_(row, headerMap, 'SNOWFLAKE_TABLE_OWNER'),
    schemaOwner && schemaOwner.email,
    sourceValue_(row, headerMap, 'DATABASE_OWNER')
  ];
  if (firstEmail_(contacts)) return 'CONTACTABLE';
  const ownershipSource = sourceValue_(row, headerMap, 'OWNERSHIP_SOURCE').toUpperCase();
  const sourceSignalsContact = [
    'DPM_TEAM + BDS_TEAM', 'DPM_TEAM_ONLY', 'BDS_TEAM_ONLY',
    'BUSINESS_STEWARD_ONLY', 'TECHNICAL_STEWARD_ONLY', 'SNOWFLAKE_TABLE_OWNER_ONLY'
  ].indexOf(ownershipSource) !== -1;
  return contacts.some(Boolean) || sourceSignalsContact ? 'NAMED_CONTACT_NO_EMAIL' : 'NO_CONTACT';
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
    NOTICE_DUE_AT: '',
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
  // Browser-driven checkpoints are primary; the trigger is only a background backup.
  try { scheduleImportContinuation_(7 * 60 * 1000); } catch (watchdogError) {}
  const checkpoint = state.finalization || {
    stage: 'APPROVE_CANDIDATES', carriedForward: 0, orphanQuarantineActions: 0,
    cancelledRecoveryActions: 0, cancelledDismissalActions: 0,
    completedQuarantineActions: 0, notificationMessage: ''
  };
  state.finalization = checkpoint;

  if (checkpoint.stage === 'APPROVE_CANDIDATES') {
    setFinalizationProgress_(state, 'APPROVING_CANDIDATES', 'Applying reviewed stale-asset decisions and lifecycle approvals');
    const approval = approveImportedCandidatesChunk_(state.runId, state.intakeApprovedAt,
      Number(checkpoint.approvalCursorRow || 2), Math.max(25, Math.min(150, configNumber_('FINALIZATION_BATCH_SIZE', 100))));
    checkpoint.approvalCursorRow = approval.nextRow;
    checkpoint.approvedAssets = Number(checkpoint.approvedAssets || 0) + approval.approvedAssets;
    checkpoint.orphanAssets = Number(checkpoint.orphanAssets || 0) + approval.orphanAssets;
    checkpoint.notificationDrafts = Number(checkpoint.notificationDrafts || 0) + approval.notificationDrafts;
    if (approval.done) checkpoint.stage = 'PREPARE_ORPHAN_HANDOFFS';
    checkpointImportFinalization_(state, 'APPLYING_LIFECYCLE_CHANGES', approval.done
      ? 'Candidate approvals and notification drafts checkpointed; preparing orphan handoffs'
      : 'Approved and staged notifications for ' + checkpoint.approvalCursorRow + ' lifecycle rows');
    return;
  }

  if (checkpoint.stage === 'PREPARE_ORPHAN_HANDOFFS') {
    const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
    checkpoint.orphanQuarantineActions = queueImportOrphanQuarantineActions_(lifecycleAssets.ORPHAN_POLICY_ACCEPTED || [], state.runId);
    checkpoint.stage = 'RECONCILE';
    checkpointImportFinalization_(state, 'RECONCILING_LIFECYCLE', 'Orphan handoffs checkpointed; reconciling retained lifecycle records');
    return;
  }

  if (checkpoint.stage === 'RECONCILE') {
    setFinalizationProgress_(state, 'RECONCILING_LIFECYCLE', 'Reconciling assets missing from the complete extract and retained lifecycle cases');
    const reconciliation = carryForwardAndReconcileChunk_(state, Number(checkpoint.reconcileCursorRow || 2),
      Math.max(25, Math.min(200, configNumber_('FINALIZATION_BATCH_SIZE', 100))));
    checkpoint.reconcileCursorRow = reconciliation.nextRow;
    checkpoint.carriedForward = Number(checkpoint.carriedForward || 0) + reconciliation.carriedForward;
    checkpoint.purgedAssets = Number(checkpoint.purgedAssets || 0) + reconciliation.purgedAssets;
    checkpoint.selfPurgedAssets = Number(checkpoint.selfPurgedAssets || 0) + reconciliation.selfPurgedAssets;
    if (reconciliation.done) checkpoint.stage = 'APPLY_LIFECYCLE';
    checkpointImportFinalization_(state, reconciliation.done ? 'APPLYING_LIFECYCLE_CHANGES' : 'RECONCILING_LIFECYCLE',
      reconciliation.done ? 'Lifecycle reconciliation checkpointed; applying lifecycle changes' :
        'Reconciled lifecycle rows through ' + checkpoint.reconcileCursorRow);
    return;
  }

  if (checkpoint.stage === 'APPLY_LIFECYCLE') {
    setFinalizationProgress_(state, 'APPLYING_LIFECYCLE_CHANGES', 'Applying restriction, recovery, restoration, and dismissal changes');
    const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
    const restrictionAssetIds = uniqueAssetIds_((lifecycleAssets.SNOWFLAKE_RESTRICTION_CONFIRMED || [])
      .concat(lifecycleAssets.SNOWFLAKE_INITIAL_RESTRICTION || []));
    const activeRecoveryAssetIds = lifecycleAssets.STALE_ASSET_BECAME_ACTIVE || [];
    const dismissedAssetIds = lifecycleAssets.INTAKE_CANDIDATE_DISMISSED || [];
    const cancelledActions = cancelImportPlatformActions_(activeRecoveryAssetIds, dismissedAssetIds);
    checkpoint.cancelledRecoveryActions = cancelledActions.recovery;
    checkpoint.cancelledDismissalActions = cancelledActions.dismissal;
    checkpoint.completedQuarantineActions = completeQuarantineActionsFromImport_(restrictionAssetIds, state.snapshotAt, state.runId);
    checkpoint.restrictionAssets = restrictionAssetIds.length;
    checkpoint.activeRecoveryAssets = activeRecoveryAssetIds.length;
    checkpoint.dismissedAssets = dismissedAssetIds.length;
    checkpoint.stage = 'REFRESH_DASHBOARD';
    checkpointImportFinalization_(state, 'REFRESHING_DASHBOARD', 'Lifecycle changes checkpointed; refreshing dashboard summaries');
    return;
  }

  if (checkpoint.stage === 'REFRESH_DASHBOARD') {
    setFinalizationProgress_(state, 'REFRESHING_DASHBOARD', 'Refreshing the published asset index and dashboard summaries');
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
    checkpoint.stage = 'NOTIFICATIONS';
    checkpointImportFinalization_(state, 'QUEUING_NOTIFICATIONS', 'Dashboard checkpointed; preparing retryable notification delivery');
    return;
  }

  if (checkpoint.stage === 'NOTIFICATIONS') {
    checkpoint.notificationMessage = finalizeImportNotifications_(state);
    checkpoint.stage = 'COMPLETE';
    checkpointImportFinalization_(state, 'COMPLETING_PUBLICATION', 'Notification handoff checkpointed; completing publication');
    return;
  }

  const profile = getEnvironmentProfile_();
  setFinalizationProgress_(state, 'COMPLETING_PUBLICATION', 'Recording publication results and completing the reviewed import');
  if (!profile.isProduction) {
    try { ensureLifecycleAutomationTrigger_(); } catch (error) {}
  }
  updateJobRun_(state.runId, {
    STATUS: 'SUCCEEDED', COMPLETED_AT: nowIso_(), CURSOR_ROW: state.cursorRow,
    PROCESSED_ROWS: state.processedRows, WRITTEN_ROWS: state.writtenRows + Number(checkpoint.carriedForward || 0),
    ERROR_COUNT: state.errors,
    MESSAGE: 'Reviewed and published ' + state.writtenRows + ' of ' + state.sourceRows + ' source assets plus ' + Number(checkpoint.carriedForward || 0) +
      ' retained lifecycle cases; recorded ' + Number(checkpoint.dismissedAssets || 0) + ' intake dismissals and cancelled ' +
      Number(checkpoint.cancelledDismissalActions || 0) + ' related handoffs; marked ' + Number(checkpoint.activeRecoveryAssets || 0) +
      ' tracked assets ACTIVE and cancelled ' + Number(checkpoint.cancelledRecoveryActions || 0) + ' pending handoffs; prepared ' +
      Number(checkpoint.orphanQuarantineActions || 0) + ' orphan quarantine handoffs; confirmed ' + Number(checkpoint.restrictionAssets || 0) +
      ' Snowflake restrictions and completed ' + Number(checkpoint.completedQuarantineActions || 0) + ' quarantine work items.' +
      (checkpoint.notificationMessage ? ' ' + cleanText_(checkpoint.notificationMessage) : '')
  });
  clearImportState_(state.environment);
  clearIntakeReviewCache_(state.environment);
  clearPendingIntakeReview_(state.environment);
  deleteImportContinuationTriggers_();
}

function checkpointImportFinalization_(state, progressStage, message) {
  state.finalization.updatedAt = nowIso_();
  setFinalizationProgress_(state, progressStage, message);
  try { scheduleImportContinuation_(10000); } catch (scheduleError) {}
}

function uniqueAssetIds_(assetIds) {
  const seen = {};
  return (assetIds || []).map(cleanText_).filter(function (assetId) {
    if (!assetId || seen[assetId]) return false;
    seen[assetId] = true;
    return true;
  });
}

function finalizeImportNotifications_(state) {
  const profile = getEnvironmentProfile_();
  const slackEnabled = configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false);
  const syncLimit = Math.max(1, configNumber_('IMPORT_SYNC_NOTIFICATION_MAX_ASSETS', 250));
  if (!slackEnabled) return ' Slack delivery is disabled; no notification drafts were created and publication was not blocked.';
  const preparedGroups = importNotificationCampaignCaseGroups_(state.runId);
  const preparedTotal = preparedGroups.reduce(function (sum, group) { return sum + group.assetIds.length; }, 0);
  if (profile.isProduction && preparedTotal > syncLimit) {
    setFinalizationProgress_(state, 'QUEUING_NOTIFICATIONS', 'Queueing prepared owner groups for retryable Slack delivery');
    const preparedCampaign = queuePreparedImportNotificationDelivery_(state.runId, state.environment);
    return ' Prepared ' + preparedCampaign.total + ' notification records and queued ' + preparedCampaign.ownerMessagesTotal +
      ' consolidated owner messages for retryable delivery after publication.';
  }

  const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
  const approvalAssetIds = lifecycleAssets.INTAKE_REVIEW_CONFIRMED || [];
  const orphanAssetIds = lifecycleAssets.ORPHAN_POLICY_ACCEPTED || [];
  const restrictionAssetIds = uniqueAssetIds_((lifecycleAssets.SNOWFLAKE_RESTRICTION_CONFIRMED || [])
    .concat(lifecycleAssets.SNOWFLAKE_INITIAL_RESTRICTION || []));
  const caseMap = loadCaseMap_();
  const standardRestrictionAssetIds = restrictionAssetIds.filter(function (assetId) {
    const ownerStatus = cleanText_(caseMap[assetId] && caseMap[assetId].OWNER_STATUS).toUpperCase();
    return ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) === -1;
  });
  const purgedAssetIds = uniqueAssetIds_((lifecycleAssets.PURGE_VERIFIED || []).concat(lifecycleAssets.SELF_PURGE_VERIFIED || []));
  const restoredAssetIds = lifecycleAssets.PURGED_ASSET_REAPPEARED || [];
  const immediateNotificationCount = approvalAssetIds.length + orphanAssetIds.length + standardRestrictionAssetIds.length +
    purgedAssetIds.length + restoredAssetIds.length;
  const deferNotifications = profile.isProduction && slackEnabled && immediateNotificationCount > syncLimit;
  setFinalizationProgress_(state, deferNotifications ? 'QUEUING_NOTIFICATIONS' : 'SENDING_NOTIFICATIONS',
    deferNotifications ? 'Queueing background Slack delivery after publication' : 'Consolidating and sending immediate Slack notifications');
  if (deferNotifications) {
    const campaign = queuePreparedImportNotificationDelivery_(state.runId, state.environment);
    return ' Prepared ' + campaign.total + ' notification records and queued ' + campaign.ownerMessagesTotal +
      ' consolidated owner messages for retryable delivery after publication.';
  }

  let message = '';
  [
    ['Immediate owner Slack', approvalAssetIds, 'STALE_ASSET_NOTICE'],
    ['Orphan outreach at T0', orphanAssetIds, 'ORPHAN_QUARANTINE_NOTICE'],
    ['Quarantine Slack', standardRestrictionAssetIds, 'QUARANTINE_NOTICE'],
    ['Purge completion Slack', purgedAssetIds, 'PURGE_COMPLETED'],
    ['Restoration Slack', restoredAssetIds, 'RESTORATION_CONFIRMED']
  ].forEach(function (item) {
    if (!item[1].length) return;
    try {
      const delivery = createAndSendImportNotificationGroups_(item[1], item[2], state.runId);
      message += importNotificationDeliveryMessage_(item[0], delivery);
    } catch (error) {
      message += ' ' + item[0] + ' needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  });
  return message;
}

function importNotificationCampaignCaseGroups_(runId) {
  const seen = {};
  const staleAssetIds = [];
  const orphanAssetIds = [];
  readObjectsByField_(APP.sheets.cases, 'LAST_EVALUATION_RUN_ID', runId).forEach(function (caseRecord) {
    const assetId = cleanText_(caseRecord.ASSET_ID);
    if (!assetId || seen[assetId]) return;
    const state = canonicalLifecycleState_(caseRecord.STATE);
    const ownerStatus = cleanText_(caseRecord.OWNER_STATUS).toUpperCase();
    const orphan = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
    if (orphan && [APP.lifecycle.accepted, APP.lifecycle.quarantined].indexOf(state) !== -1) {
      orphanAssetIds.push(assetId);
      seen[assetId] = true;
      return;
    }
    if (!orphan && [APP.lifecycle.detected, APP.lifecycle.notified].indexOf(state) !== -1) {
      staleAssetIds.push(assetId);
      seen[assetId] = true;
    }
  });
  return [
    { messageType: 'STALE_ASSET_NOTICE', assetIds: staleAssetIds.sort() },
    { messageType: 'ORPHAN_QUARANTINE_NOTICE', assetIds: orphanAssetIds.sort() }
  ].filter(function (group) { return group.assetIds.length; });
}

function importNotificationCampaignGroups_(runId, expectedTotal) {
  // Active large imports use lifecycle cases from the current run as the canonical
  // queue. Older and non-import callers retain the event-log compatibility path.
  if (Number(expectedTotal || 0) > 0) {
    const caseGroups = importNotificationCampaignCaseGroups_(runId);
    const caseTotal = caseGroups.reduce(function (sum, group) { return sum + group.assetIds.length; }, 0);
    if (caseTotal === Number(expectedTotal)) return caseGroups;
  }

  const events = lifecycleEventAssetGroupsForRun_(runId);
  const restrictionSeen = {};
  const restrictionIds = (events.SNOWFLAKE_RESTRICTION_CONFIRMED || [])
    .concat(events.SNOWFLAKE_INITIAL_RESTRICTION || [])
    .filter(function (assetId) {
      if (restrictionSeen[assetId]) return false;
      restrictionSeen[assetId] = true;
      return true;
    });
  const cases = loadCaseMap_();
  const standardRestrictionIds = restrictionIds.filter(function (assetId) {
    const ownerStatus = cleanText_(cases[assetId] && cases[assetId].OWNER_STATUS).toUpperCase();
    return ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) === -1;
  });
  return [
    { messageType: 'STALE_ASSET_NOTICE', assetIds: events.INTAKE_REVIEW_CONFIRMED || [] },
    { messageType: 'ORPHAN_QUARANTINE_NOTICE', assetIds: events.ORPHAN_POLICY_ACCEPTED || [] },
    { messageType: 'QUARANTINE_NOTICE', assetIds: standardRestrictionIds },
    { messageType: 'PURGE_COMPLETED', assetIds: (events.PURGE_VERIFIED || []).concat(events.SELF_PURGE_VERIFIED || []) },
    { messageType: 'RESTORATION_CONFIRMED', assetIds: events.PURGED_ASSET_REAPPEARED || [] }
  ].map(function (group) {
    group.assetIds = Array.from(new Set(group.assetIds.map(cleanText_).filter(Boolean))).sort();
    return group;
  }).filter(function (group) { return group.assetIds.length; });
}

function alignImportNotificationDraftCursor_(state, groups) {
  const staged = {};
  readObjects_(APP.sheets.notifications).forEach(function (record) {
    const status = cleanText_(record.STATUS).toUpperCase();
    if (['DRAFT', 'FAILED', 'SENT'].indexOf(status) === -1) return;
    let messageType = '';
    try { messageType = normalizeSlackMessageType_(record.TYPE); } catch (error) { return; }
    staged[messageType + '|' + cleanText_(record.ASSET_ID)] = true;
  });
  let completed = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    let cursor = 0;
    while (cursor < group.assetIds.length && staged[group.messageType + '|' + group.assetIds[cursor]]) cursor += 1;
    if (cursor < group.assetIds.length) {
      state.groupIndex = groupIndex;
      state.cursor = cursor;
      state.completed = completed + cursor;
      state.messageType = group.messageType;
      return state;
    }
    completed += group.assetIds.length;
  }
  state.groupIndex = groups.length;
  state.cursor = 0;
  state.completed = completed;
  state.messageType = '';
  return state;
}

function queuePreparedImportNotificationDelivery_(runId, environment) {
  const selectedEnvironment = normalizeEnvironment_(environment);
  const groups = importNotificationCampaignCaseGroups_(runId);
  const total = groups.reduce(function (sum, group) { return sum + group.assetIds.length; }, 0);
  const ownerGroups = importNotificationCampaignRecipientGroups_(groups, []);
  const deliveryJobId = cleanText_(runId) + '|SLACK';
  const existing = getImportNotificationCampaignState_(selectedEnvironment);
  if (existing && cleanText_(existing.runId) === cleanText_(runId) &&
      ['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED'].indexOf(cleanText_(existing.status).toUpperCase()) !== -1) {
    return getImportNotificationCampaignStatus_(selectedEnvironment);
  }
  const state = {
    environment: selectedEnvironment, runId: runId,
    status: ownerGroups.length ? 'QUEUED' : 'SUCCEEDED',
    phase: ownerGroups.length ? 'DELIVERING' : 'COMPLETE',
    groupIndex: groups.length, cursor: 0, messageType: '',
    total: total, completed: total, delivered: 0, failed: 0,
    ownerMessagesTotal: ownerGroups.length, ownerMessagesDelivered: 0, ownerMessagesFailed: 0,
    attemptedOwnerGroupKeys: [], currentOwnerDelivery: null,
    deliveryJobId: deliveryJobId,
    startedAt: nowIso_(), completedAt: ownerGroups.length ? '' : nowIso_(), lastError: ''
  };
  if (!findObjectRow_(APP.sheets.jobs, 'RUN_ID', deliveryJobId)) {
    appendRawRows_(APP.sheets.jobs, [[
      deliveryJobId, 'IMPORT_SLACK_DELIVERY', ownerGroups.length ? 'RUNNING' : 'SUCCEEDED',
      state.startedAt, state.completedAt, 0, total, total, 0, 0,
      'Prepared ' + total + ' notification records for ' + ownerGroups.length + ' consolidated owner messages.'
    ]]);
  }
  setImportNotificationCampaignState_(state);
  if (ownerGroups.length) try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
  return getImportNotificationCampaignStatus_(selectedEnvironment);
}

function queueImportNotificationCampaign_(runId, environment) {
  const selectedEnvironment = normalizeEnvironment_(environment);
  const existing = getImportNotificationCampaignState_(selectedEnvironment);
  if (existing && cleanText_(existing.runId) === cleanText_(runId)) {
    if (['QUEUED', 'RUNNING', 'RETRYING', 'PAUSED', 'COMPLETED_WITH_ERRORS', 'SUCCEEDED'].indexOf(cleanText_(existing.status).toUpperCase()) !== -1) {
      if (['QUEUED', 'RUNNING', 'RETRYING'].indexOf(cleanText_(existing.status).toUpperCase()) !== -1) {
        scheduleImportNotificationCampaign_(60000);
      }
      return existing;
    }
  }
  const groups = importNotificationCampaignGroups_(runId);
  const total = groups.reduce(function (sum, group) { return sum + group.assetIds.length; }, 0);
  const state = {
    environment: selectedEnvironment,
    runId: runId,
    status: total ? 'QUEUED' : 'SUCCEEDED',
    phase: total ? 'DRAFTING' : 'COMPLETE',
    groupIndex: 0,
    cursor: 0,
    messageType: groups.length ? groups[0].messageType : '',
    total: total,
    completed: 0,
    delivered: 0,
    failed: 0,
    ownerMessagesTotal: 0,
    ownerMessagesDelivered: 0,
    ownerMessagesFailed: 0,
    attemptedOwnerGroupKeys: [],
    currentOwnerDelivery: null,
    startedAt: nowIso_(),
    completedAt: total ? '' : nowIso_(),
    lastError: ''
  };
  setImportNotificationCampaignState_(state);
  if (total) try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
  return state;
}

function continueImportNotificationCampaign(environment) {
  // Time-driven triggers pass an event object; only internal/manual calls pass an environment string.
  const selectedEnvironment = typeof environment === 'string' ? cleanText_(environment) : '';
  let state = selectedEnvironment
    ? getImportNotificationCampaignState_(normalizeEnvironment_(selectedEnvironment))
    : getAnyRunningImportNotificationCampaign_();
  if (state && normalizeEnvironment_(state.environment) === 'PRD') {
    setExecutionEnvironment_('PRD', false);
    clearBlankProductionWorkflowState_();
    state = selectedEnvironment
      ? getImportNotificationCampaignState_(normalizeEnvironment_(selectedEnvironment))
      : getAnyRunningImportNotificationCampaign_();
  }
  if (!state) {
    deleteImportNotificationCampaignTriggers_();
    return getImportNotificationCampaignStatus_();
  }
  setExecutionEnvironment_(state.environment, false);
  try {
    const profile = assertEnvironmentWritable_();
    if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
      state.status = 'PAUSED';
      state.lastError = profile.label + ' Slack notifications are disabled.';
      setImportNotificationCampaignState_(state);
      deleteImportNotificationCampaignTriggers_();
      return getImportNotificationCampaignStatus_(state.environment);
    }

    // Install a watchdog before the potentially expensive delivery call. If Apps Script
    // terminates this execution, the campaign safely retries the same idempotent chunk.
    try {
      scheduleImportNotificationCampaign_(7 * 60 * 1000);
    } catch (watchdogError) {
      // A trigger-capacity problem must not block a manual checkpoint from doing useful work.
      state.lastError = 'Watchdog scheduling needs attention: ' + String(watchdogError.message || watchdogError).substring(0, 300);
      setImportNotificationCampaignState_(state);
    }
  const groups = importNotificationCampaignGroups_(state.runId, state.total);
    const batchSize = Math.max(25, Math.min(500, configNumber_('IMPORT_NOTIFICATION_CAMPAIGN_BATCH_SIZE', 250)));
    const maxBatchesPerExecution = Math.max(1, Math.min(2, configNumber_('IMPORT_NOTIFICATION_BATCHES_PER_EXECUTION', 1)));
    const executionDeadline = Date.now() + Math.max(30000, Math.min(180000,
      configNumber_('IMPORT_NOTIFICATION_EXECUTION_BUDGET_MS', 150000)));
    state.status = 'RUNNING';
    state.phase = state.phase || 'DRAFTING';

    if (state.phase === 'DRAFTING') {
      // The persisted notification rows are the durable queue. Reconcile the cursor
      // before every checkpoint so retries skip completed work instead of replaying it.
      alignImportNotificationDraftCursor_(state, groups);
      setImportNotificationCampaignState_(state);
      let batchesProcessed = 0;
      while (state.groupIndex < groups.length && batchesProcessed < maxBatchesPerExecution && Date.now() < executionDeadline) {
        const group = groups[state.groupIndex];
        const batchIds = group.assetIds.slice(state.cursor, state.cursor + batchSize);
        state.messageType = group.messageType;
        if (batchIds.length) {
          const drafted = createNotificationDraftBatch_(batchIds, group.messageType);
          state.cursor += batchIds.length;
          state.completed += batchIds.length;
          state.failed += Number((drafted.errors || []).length);
          state.lastError = (drafted.errors || []).slice(0, 3).map(function (item) {
            return cleanText_(item.assetId || group.messageType) + ': ' + cleanText_(item.error);
          }).join(' | ');
          batchesProcessed += 1;
        }
        if (state.cursor >= group.assetIds.length) {
          state.groupIndex += 1;
          state.cursor = 0;
        }
        // Persist after every batch so a hard timeout retries at most one idempotent batch.
        setImportNotificationCampaignState_(state);
      }
      if (state.groupIndex >= groups.length) {
        const ownerGroups = importNotificationCampaignRecipientGroups_(groups, []);
        state.phase = 'DELIVERING';
        state.messageType = '';
        state.ownerMessagesTotal = ownerGroups.length;
        state.groupIndex = groups.length;
        state.cursor = 0;
      }
      setImportNotificationCampaignState_(state);
      try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
      return getImportNotificationCampaignStatus_(state.environment);
    }

    if (state.phase === 'DELIVERING' && state.currentOwnerDelivery) {
      const receipt = state.currentOwnerDelivery;
      let batchesProcessed = 0;
      while (state.currentOwnerDelivery && batchesProcessed < maxBatchesPerExecution && Date.now() < executionDeadline) {
        const remaining = importNotificationCampaignOwnerRecords_(groups, receipt.messageType, receipt.recipient);
        const finalized = finalizeNotificationOwnerGroupChunk_(remaining.slice(0, batchSize), receipt);
        state.delivered += finalized;
        batchesProcessed += 1;
        if (remaining.length <= batchSize) {
          state.currentOwnerDelivery = null;
          state.ownerMessagesDelivered += 1;
        }
        setImportNotificationCampaignState_(state);
      }
      try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
      return getImportNotificationCampaignStatus_(state.environment);
    }

    const attemptedKeys = state.attemptedOwnerGroupKeys || [];
    const ownerGroups = importNotificationCampaignRecipientGroups_(groups, attemptedKeys);
    state.ownerMessagesTotal = Math.max(Number(state.ownerMessagesTotal || 0),
      Number(state.ownerMessagesDelivered || 0) + Number(state.ownerMessagesFailed || 0) + ownerGroups.length);
    if (!ownerGroups.length) {
      state.status = state.failed ? 'COMPLETED_WITH_ERRORS' : 'SUCCEEDED';
      state.phase = 'COMPLETE';
      state.completedAt = nowIso_();
      state.messageType = '';
      setImportNotificationCampaignState_(state);
      deleteImportNotificationCampaignTriggers_();
      return getImportNotificationCampaignStatus_(state.environment);
    }

    const ownerGroup = ownerGroups[0];
    state.messageType = ownerGroup.messageType;
    try {
      state.currentOwnerDelivery = sendPreparedNotificationOwnerGroup_(
        ownerGroup.records, ownerGroup.messageType, ownerGroup.recipient
      );
      state.lastError = '';
    } catch (error) {
      state.attemptedOwnerGroupKeys = attemptedKeys.concat([ownerGroup.key]);
      state.ownerMessagesFailed += 1;
      state.failed += ownerGroup.records.length;
      state.lastError = ownerGroup.recipient + ': ' + String(error.message || error).substring(0, 400);
    }
    setImportNotificationCampaignState_(state);
    try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
  } catch (error) {
    state.status = 'RETRYING';
    state.lastError = String(error.message || error).substring(0, 500);
    setImportNotificationCampaignState_(state);
    try {
      scheduleImportNotificationCampaign_(60000);
    } catch (scheduleError) {
      state.status = 'PAUSED';
      state.lastError += ' | Retry scheduling failed: ' + String(scheduleError.message || scheduleError).substring(0, 300);
      setImportNotificationCampaignState_(state);
    }
  }
  return getImportNotificationCampaignStatus_(state.environment);
}

function importNotificationCampaignEligibility_(groups) {
  const eligible = {};
  (groups || []).forEach(function (group) {
    const messageType = normalizeSlackMessageType_(group.messageType);
    (group.assetIds || []).forEach(function (assetId) {
      eligible[messageType + '|' + cleanText_(assetId)] = true;
    });
  });
  return eligible;
}

function importNotificationCampaignRecipientGroups_(groups, excludedKeys) {
  const eligible = importNotificationCampaignEligibility_(groups);
  const excluded = (excludedKeys || []).reduce(function (index, key) {
    index[cleanText_(key)] = true;
    return index;
  }, {});
  const recipientGroups = {};
  readObjects_(APP.sheets.notifications).forEach(function (record) {
    const status = cleanText_(record.STATUS).toUpperCase();
    if (['DRAFT', 'FAILED'].indexOf(status) === -1) return;
    let messageType = '';
    try { messageType = normalizeSlackMessageType_(record.TYPE); } catch (error) { return; }
    if (!eligible[messageType + '|' + cleanText_(record.ASSET_ID)]) return;
    const recipient = cleanText_(record.RECIPIENTS).toLowerCase();
    if (!isSlackEmail_(recipient)) return;
    const key = messageType + '|' + recipient;
    if (excluded[key]) return;
    if (!recipientGroups[key]) {
      recipientGroups[key] = { key: key, messageType: messageType, recipient: recipient, records: [] };
    }
    recipientGroups[key].records.push(record);
  });
  return Object.keys(recipientGroups).sort().map(function (key) {
    const group = recipientGroups[key];
    group.records.sort(function (left, right) {
      return cleanText_(left.ASSET_ID).localeCompare(cleanText_(right.ASSET_ID));
    });
    return group;
  });
}

function importNotificationCampaignOwnerRecords_(groups, messageType, recipient) {
  const targetType = normalizeSlackMessageType_(messageType);
  const targetRecipient = cleanText_(recipient).toLowerCase();
  const ownerGroup = importNotificationCampaignRecipientGroups_(groups, []).filter(function (group) {
    return group.messageType === targetType && group.recipient === targetRecipient;
  })[0];
  return ownerGroup ? ownerGroup.records : [];
}

function retryImportNotificationCampaign() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
    throw new Error('Enable Slack notifications before retrying the paused delivery campaign.');
  }
  const state = getImportNotificationCampaignState_(profile.key);
  if (!state) throw new Error('No import notification campaign is available to retry.');
  if (['RUNNING', 'QUEUED', 'RETRYING'].indexOf(state.status) !== -1) {
    throw new Error('Slack delivery is already running.');
  }
  const resumeFinalization = Boolean(state.currentOwnerDelivery && state.currentOwnerDelivery.batchId);
  state.status = 'QUEUED';
  state.phase = resumeFinalization ? 'DELIVERING' : 'DRAFTING';
  state.groupIndex = resumeFinalization ? Number(state.groupIndex || 0) : 0;
  state.cursor = 0;
  state.messageType = resumeFinalization ? state.currentOwnerDelivery.messageType : '';
  if (!resumeFinalization) {
    state.completed = 0;
    state.delivered = 0;
    state.failed = 0;
    state.ownerMessagesTotal = 0;
    state.ownerMessagesDelivered = 0;
    state.ownerMessagesFailed = 0;
    state.attemptedOwnerGroupKeys = [];
    state.currentOwnerDelivery = null;
  }
  state.completedAt = '';
  state.lastError = '';
  state.retryStartedAt = nowIso_();
  setImportNotificationCampaignState_(state);
  scheduleImportNotificationCampaign_(60000);
  return getImportNotificationCampaignStatus_(profile.key);
}

function resumeStalledImportNotificationCampaign() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
    throw new Error('Enable Slack notifications before resuming delivery.');
  }
  const state = getImportNotificationCampaignState_(profile.key);
  if (!state) throw new Error('No Slack campaign is available to resume.');
  if (['SUCCEEDED', 'COMPLETE'].indexOf(cleanText_(state.status).toUpperCase()) !== -1) {
    return getImportNotificationCampaignStatus_(profile.key);
  }
  state.status = 'RETRYING';
  state.recoveryRequestedAt = nowIso_();
  state.recoveryCount = Number(state.recoveryCount || 0) + 1;
  state.lastError = '';
  setImportNotificationCampaignState_(state);
  // Execute the first resumed checkpoint immediately so recovery does not depend on
  // Apps Script deciding when to service the replacement time trigger.
  return continueImportNotificationCampaign(profile.key);
}

function scheduleImportNotificationCampaign_(delayMs) {
  const replacement = ScriptApp.newTrigger('continueImportNotificationCampaign').timeBased()
    .after(Math.max(10000, Number(delayMs || 60000))).create();
  const replacementId = replacement.getUniqueId();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueImportNotificationCampaign' && trigger.getUniqueId() !== replacementId) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function deleteImportNotificationCampaignTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueImportNotificationCampaign') ScriptApp.deleteTrigger(trigger);
  });
}

function createAndSendImportNotificationGroups_(assetIds, notificationType, runId) {
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  const profile = getEnvironmentProfile_();
  let deliveryIds = ids;
  let simulatedIds = [];
  if (profile.key === 'DEV' && profile.recipientLock && ids.length) {
    const sampleSize = Math.max(1, Math.min(25, configNumber_('DEV_IMPORT_NOTIFICATION_SAMPLE_SIZE', 10)));
    deliveryIds = ids.slice(0, sampleSize);
    simulatedIds = ids.slice(sampleSize);
  }
  const delivery = createAndSendNotificationGroups_(deliveryIds, notificationType, true);
  delivery.requestedAssetCount = ids.length;
  delivery.deliveredSampleCount = deliveryIds.length;
  delivery.simulatedAssetCount = notificationType === 'STALE_ASSET_NOTICE' ? simulatedIds.length : 0;
  delivery.skippedDevAssetCount = notificationType === 'STALE_ASSET_NOTICE' ? 0 : simulatedIds.length;
  delivery.devSampled = simulatedIds.length > 0;
  if (notificationType === 'STALE_ASSET_NOTICE' && simulatedIds.length) {
    simulateDevInitialNotifications_(simulatedIds, runId, profile.recipientLock);
  }
  return delivery;
}

function importNotificationDeliveryMessage_(label, delivery) {
  if (delivery.devSampled) {
    const remainder = delivery.simulatedAssetCount
      ? ' simulated ' + delivery.simulatedAssetCount + ' remaining initial deliveries to prevent repeat automation.'
      : ' did not send the remaining ' + delivery.skippedDevAssetCount + ' DEV test deliveries.';
    return ' ' + label + ': sent a DEV-locked sample for ' + delivery.deliveredSampleCount + ' of ' +
      delivery.requestedAssetCount + ' assets;' + remainder;
  }
  return ' ' + label + ': ' + delivery.assetCount + ' assets in ' + delivery.groupCount + ' consolidated messages.';
}

function simulateDevInitialNotifications_(assetIds, runId, lockedRecipient) {
  const targets = {};
  (assetIds || []).forEach(function (assetId) { targets[assetId] = true; });
  if (!Object.keys(targets).length) return 0;
  const simulatedAt = nowIso_();
  const caseUpdates = readObjects_(APP.sheets.cases).filter(function (caseRecord) {
    return targets[caseRecord.ASSET_ID] && canonicalLifecycleState_(caseRecord.STATE) === APP.lifecycle.detected;
  }).map(function (caseRecord) {
    caseRecord.STATE = APP.lifecycle.notified;
    caseRecord.NOTIFIED_AT = simulatedAt;
    caseRecord.LAST_TRANSITION_AT = simulatedAt;
    caseRecord.NOTES = 'DEV recipient lock: initial Slack delivery was simulated after a bounded test sample.';
    return caseRecord;
  });
  const casesByAsset = indexObjectsBy_(caseUpdates, 'ASSET_ID');
  const assetUpdates = readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', Object.keys(casesByAsset)).map(function (asset) {
    asset.LIFECYCLE_STATE = APP.lifecycle.notified;
    asset.ASSET_STATUS = deriveAssetStatus_(asset, APP.lifecycle.notified);
    return asset;
  });
  const events = caseUpdates.map(function (caseRecord) {
    return lifecycleEventRow_(caseRecord.CASE_ID, caseRecord.ASSET_ID, 'DEV_NOTIFICATION_SIMULATED',
      APP.lifecycle.detected, APP.lifecycle.notified, simulatedAt, 'SYSTEM', runId, {
        messageType: 'STALE_ASSET_NOTICE', lockedRecipient: lockedRecipient,
        reason: 'DEV_IMPORT_NOTIFICATION_SAMPLE_LIMIT'
      });
  });
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', caseUpdates);
  updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', assetUpdates);
  appendRawRows_(APP.sheets.events, events);
  return caseUpdates.length;
}

function setFinalizationProgress_(state, progressStage, message) {
  state.phase = 'FINALIZE';
  state.progressStage = progressStage;
  state.message = message;
  setImportState_(state);
  updateJobRun_(state.runId, {
    STATUS: 'RUNNING', CURSOR_ROW: state.cursorRow,
    SOURCE_ROWS: state.sourceRows, PROCESSED_ROWS: state.processedRows,
    WRITTEN_ROWS: state.writtenRows, ERROR_COUNT: state.errors,
    MESSAGE: message
  });
}

function cancelImportPlatformActions_(activeRecoveryAssetIds, dismissedAssetIds) {
  const targets = {};
  (activeRecoveryAssetIds || []).forEach(function (assetId) {
    targets[assetId] = { bucket: 'recovery', reason: 'Latest complete extract shows the asset is active.' };
  });
  (dismissedAssetIds || []).forEach(function (assetId) {
    targets[assetId] = { bucket: 'dismissal', reason: 'Candidate dismissed by EDG during reviewed intake.' };
  });
  const result = { recovery: 0, dismissal: 0 };
  if (!Object.keys(targets).length) return result;
  const updates = readObjects_(APP.sheets.platformActions).filter(function (action) {
    return targets[action.ASSET_ID] &&
      ['QUARANTINE', 'PURGE', 'RESTORE'].indexOf(cleanText_(action.ACTION).toUpperCase()) !== -1 &&
      ['READY', 'EXPORTED', 'ACCEPTED', 'FAILED'].indexOf(cleanText_(action.STATUS).toUpperCase()) !== -1;
  }).map(function (action) {
    const target = targets[action.ASSET_ID];
    action.STATUS = 'CANCELLED';
    action.ERROR = target.reason;
    result[target.bucket] += 1;
    return action;
  });
  updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
  return result;
}

function queueImportOrphanQuarantineActions_(assetIds, runId) {
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  if (!ids.length) return 0;
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', ids), 'ASSET_ID');
  const cases = loadCaseMap_();
  const existingByKey = {};
  readObjects_(APP.sheets.platformActions).forEach(function (action) {
    const key = cleanText_(action.IDEMPOTENCY_KEY);
    if (key) existingByKey[key] = action;
  });
  const additions = [];
  const events = [];
  let prepared = 0;
  ids.forEach(function (assetId) {
    const asset = assets[assetId];
    const caseRecord = cases[assetId];
    if (!asset || !caseRecord || canonicalLifecycleState_(caseRecord.STATE) !== APP.lifecycle.accepted) return;
    const baseKey = caseRecord.CASE_ID + '|QUARANTINE';
    const existing = existingByKey[baseKey];
    if (existing && cleanText_(existing.STATUS).toUpperCase() !== 'CANCELLED') {
      prepared += 1;
      return;
    }
    const idempotencyKey = existing ? baseKey + '|RETRY|' + uuid_() : baseKey;
    const requestedAt = nowIso_();
    const actionId = uuid_();
    const request = {
      action_id: actionId,
      idempotency_key: idempotencyKey,
      platform: asset.PLATFORM,
      action: 'QUARANTINE',
      asset_id: assetId,
      object_fqn: asset.OBJECT_FQN,
      case_id: caseRecord.CASE_ID,
      requested_at: requestedAt,
      policy_rule: asset.POLICY_RULE,
      desired_tag: 'RESTRICTED',
      verify_object_absence_on_next_snapshot: false
    };
    additions.push({
      ACTION_ID: actionId, IDEMPOTENCY_KEY: idempotencyKey, CASE_ID: caseRecord.CASE_ID,
      ASSET_ID: assetId, PLATFORM: asset.PLATFORM, ACTION: 'QUARANTINE', STATUS: 'READY',
      REQUESTED_AT: requestedAt, ACCEPTED_AT: '', COMPLETED_AT: '', PARTNER_REFERENCE: '',
      REQUEST_JSON: JSON.stringify(request), RESPONSE_JSON: '', ERROR: ''
    });
    events.push(lifecycleEventRow_(caseRecord.CASE_ID, assetId, 'PLATFORM_ACTION_READY',
      caseRecord.STATE, caseRecord.STATE, requestedAt, getCurrentUserEmail_() || 'SYSTEM', runId, {
        actionId: actionId, action: 'QUARANTINE', desiredTag: 'RESTRICTED'
      }));
    prepared += 1;
  });
  appendObjectRows_(APP.sheets.platformActions, [], additions);
  appendRawRows_(APP.sheets.events, events);
  return prepared;
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
  const existingGroups = lifecycleEventAssetGroupsForRun_(runId);
  const existingApprovedAssetIds = uniqueAssetIds_((existingGroups.INTAKE_REVIEW_CONFIRMED || [])
    .concat(existingGroups.ORPHAN_POLICY_ACCEPTED || []));
  const alreadyApproved = existingApprovedAssetIds.reduce(function (index, assetId) {
    index[assetId] = true;
    return index;
  }, {});
  const cases = readObjects_(APP.sheets.cases).filter(function (item) {
    return item.LAST_EVALUATION_RUN_ID === runId && canonicalLifecycleState_(item.STATE) === APP.lifecycle.detected &&
      !alreadyApproved[cleanText_(item.ASSET_ID)];
  });
  if (!cases.length) {
    return {
      assetIds: existingGroups.INTAKE_REVIEW_CONFIRMED || [],
      orphanAssetIds: existingGroups.ORPHAN_POLICY_ACCEPTED || []
    };
  }
  const contestWindowDays = configNumber_('CONTEST_WINDOW_DAYS', 9);
  const events = [];
  const notificationAssetIds = [];
  const orphanAssetIds = [];
  cases.forEach(function (item) {
    const ownerStatus = cleanText_(item.OWNER_STATUS).toUpperCase();
    const isOrphan = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
    const existingT0 = cleanText_(item.T0);
    const t0 = existingT0 && !isNaN(new Date(existingT0).getTime()) ? existingT0 : approvedAt;
    const existingContestDeadline = cleanText_(item.CONTEST_DEADLINE);
    item.STATE = isOrphan ? APP.lifecycle.accepted : APP.lifecycle.detected;
    item.T0 = t0;
    item.NOTICE_DUE_AT = isOrphan ? '' : t0;
    item.CONTEST_DEADLINE = isOrphan ? '' : (existingContestDeadline && !isNaN(new Date(existingContestDeadline).getTime())
      ? existingContestDeadline : addDaysIso_(t0, contestWindowDays));
    item.LAST_TRANSITION_AT = approvedAt;
    item.NOTES = isOrphan
      ? 'EDG confirmed an orphaned stale asset; the PRD requires immediate quarantine handoff and a 365-day quarantine.'
      : 'EDG confirmed the reviewed intake; initial owner notification is sent immediately.';
    events.push(lifecycleEventRow_(item.CASE_ID, item.ASSET_ID,
      isOrphan ? 'ORPHAN_POLICY_ACCEPTED' : 'INTAKE_REVIEW_CONFIRMED',
      APP.lifecycle.detected, item.STATE, approvedAt, getCurrentUserEmail_() || 'SYSTEM', runId, {
      t0: t0, noticeDueAt: item.NOTICE_DUE_AT,
      contestWindowDays: isOrphan ? 0 : contestWindowDays, orphan: isOrphan
    }));
    if (isOrphan) orphanAssetIds.push(item.ASSET_ID);
    else notificationAssetIds.push(item.ASSET_ID);
  });
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', cases);
  updateImportedCandidateAssetStates_(cases);
  appendRawRows_(APP.sheets.events, events);
  return {
    assetIds: uniqueAssetIds_((existingGroups.INTAKE_REVIEW_CONFIRMED || []).concat(notificationAssetIds)),
    orphanAssetIds: uniqueAssetIds_((existingGroups.ORPHAN_POLICY_ACCEPTED || []).concat(orphanAssetIds))
  };
}

function approveImportedCandidatesChunk_(runId, approvedAt, cursorRow, batchSize) {
  const sheet = getSheet_(APP.sheets.cases);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const startRow = Math.max(2, Number(cursorRow || 2));
  if (startRow > lastRow || lastColumn < 1) {
    return { nextRow: startRow, done: true, approvedAssets: 0, orphanAssets: 0, notificationDrafts: 0 };
  }
  const count = Math.min(Math.max(1, Number(batchSize || 100)), lastRow - startRow + 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const cases = sheet.getRange(startRow, 1, count, lastColumn).getDisplayValues().map(function (row) {
    return rowToObject_(headers, row);
  });
  const contestWindowDays = configNumber_('CONTEST_WINDOW_DAYS', 9);
  const updates = [];
  const events = [];
  const notificationAssetIds = [];
  const orphanAssetIds = [];
  cases.forEach(function (item) {
    if (cleanText_(item.LAST_EVALUATION_RUN_ID) !== cleanText_(runId)) return;
    if (canonicalLifecycleState_(item.STATE) !== APP.lifecycle.detected) return;
    // T0 is the durable approval checkpoint for non-orphan DETECTED cases.
    if (cleanText_(item.T0)) return;
    const ownerStatus = cleanText_(item.OWNER_STATUS).toUpperCase();
    const isOrphan = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
    const t0 = approvedAt;
    item.STATE = isOrphan ? APP.lifecycle.accepted : APP.lifecycle.detected;
    item.T0 = t0;
    item.NOTICE_DUE_AT = isOrphan ? '' : t0;
    item.CONTEST_DEADLINE = isOrphan ? '' : addDaysIso_(t0, contestWindowDays);
    item.LAST_TRANSITION_AT = approvedAt;
    item.NOTES = isOrphan
      ? 'EDG confirmed an orphaned stale asset; immediate quarantine handoff is required.'
      : 'EDG confirmed the reviewed intake; the consolidated owner notification is staged.';
    updates.push(item);
    events.push(lifecycleEventRow_(item.CASE_ID, item.ASSET_ID,
      isOrphan ? 'ORPHAN_POLICY_ACCEPTED' : 'INTAKE_REVIEW_CONFIRMED',
      APP.lifecycle.detected, item.STATE, approvedAt, getCurrentUserEmail_() || 'SYSTEM', runId, {
        t0: t0, noticeDueAt: item.NOTICE_DUE_AT, contestWindowDays: isOrphan ? 0 : contestWindowDays, orphan: isOrphan
      }));
    if (isOrphan) orphanAssetIds.push(item.ASSET_ID);
    else notificationAssetIds.push(item.ASSET_ID);
  });
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', updates);
  updateImportedCandidateAssetStates_(updates);
  appendRawRows_(APP.sheets.events, events);
  let notificationDrafts = 0;
  if (notificationAssetIds.length) {
    notificationDrafts += createNotificationDraftBatch_(notificationAssetIds, 'STALE_ASSET_NOTICE').records.length;
  }
  if (orphanAssetIds.length) {
    notificationDrafts += createNotificationDraftBatch_(orphanAssetIds, 'ORPHAN_QUARANTINE_NOTICE').records.length;
  }
  const nextRow = startRow + count;
  return {
    nextRow: nextRow, done: nextRow > lastRow,
    approvedAssets: notificationAssetIds.length, orphanAssets: orphanAssetIds.length,
    notificationDrafts: notificationDrafts
  };
}

function updateImportedCandidateAssetStates_(caseRecords) {
  const records = caseRecords || [];
  if (!records.length) return 0;
  const casesByAsset = indexObjectsBy_(records, 'ASSET_ID');
  const assets = readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', Object.keys(casesByAsset));
  const updates = assets.map(function (asset) {
    const caseRecord = casesByAsset[asset.ASSET_ID];
    asset.LIFECYCLE_STATE = caseRecord.STATE;
    asset.STALE_DESIGNATION_DATE = caseRecord.T0 || asset.STALE_DESIGNATION_DATE || '';
    asset.CONTEST_DEADLINE = caseRecord.CONTEST_DEADLINE || '';
    asset.QUARANTINE_START_DATE = caseRecord.QUARANTINE_START_DATE || '';
    asset.QUARANTINE_EXPIRY_DATE = caseRecord.PURGE_ELIGIBLE_DATE || '';
    asset.PURGE_ELIGIBLE_DATE = caseRecord.PURGE_ELIGIBLE_DATE || '';
    asset.EXCEPTION_ID = caseRecord.EXCEPTION_ID || '';
    asset.EXCEPTION_STATUS = caseRecord.EXCEPTION_STATUS || '';
    asset.CONTEST_REFERENCE = caseRecord.CONTEST_REFERENCE || '';
    asset.ASSET_STATUS = deriveAssetStatus_(asset, caseRecord.STATE);
    return asset;
  });
  return updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', updates);
}

function carryForwardAndReconcileChunk_(state, cursorRow, batchSize) {
  const caseSheet = getSheet_(APP.sheets.cases);
  const lastRow = caseSheet.getLastRow();
  const lastColumn = caseSheet.getLastColumn();
  const startRow = Math.max(2, Number(cursorRow || 2));
  if (startRow > lastRow || lastColumn < 1) {
    return { nextRow: startRow, done: true, carriedForward: 0, purgedAssets: 0, selfPurgedAssets: 0 };
  }
  const count = Math.min(Math.max(1, Number(batchSize || 100)), lastRow - startRow + 1);
  const headers = caseSheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const cases = caseSheet.getRange(startRow, 1, count, lastColumn).getDisplayValues().map(function (row) {
    return rowToObject_(headers, row);
  });
  const assetIds = cases.map(function (caseRecord) { return cleanText_(caseRecord.ASSET_ID); }).filter(Boolean);
  const current = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', assetIds), 'ASSET_ID');
  const previous = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsStaging, 'ASSET_ID', assetIds), 'ASSET_ID');
  const completedPurge = {};
  readObjectsByKeys_(APP.sheets.platformActions, 'ASSET_ID', assetIds).forEach(function (action) {
    if (cleanText_(action.ACTION).toUpperCase() === 'PURGE' && cleanText_(action.STATUS).toUpperCase() === 'COMPLETED') {
      completedPurge[action.ASSET_ID] = true;
    }
  });
  const carry = [];
  const caseUpdates = [];
  const events = [];
  let purgedAssets = 0;
  let selfPurgedAssets = 0;
  const now = new Date();
  cases.forEach(function (caseRecord) {
    const assetId = cleanText_(caseRecord.ASSET_ID);
    if (!assetId || current[assetId]) return;
    const stateName = canonicalLifecycleState_(caseRecord.STATE);
    if ([APP.lifecycle.dismissed, APP.lifecycle.active, APP.lifecycle.restored].indexOf(stateName) !== -1) return;
    const oldAsset = previous[assetId];
    if (!oldAsset) return;
    const purgeDue = caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= now;
    const verifiedPlatformPurge = [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(stateName) !== -1 &&
      purgeDue && completedPurge[assetId];
    const verifiedSelfPurge = stateName === APP.lifecycle.selfPurgePending;
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
      if (verifiedSelfPurge) selfPurgedAssets += 1;
      else purgedAssets += 1;
      caseUpdates.push(caseRecord);
      events.push(lifecycleEventRow_(caseRecord.CASE_ID, assetId,
        verifiedSelfPurge ? 'SELF_PURGE_VERIFIED' : 'PURGE_VERIFIED', fromState, APP.lifecycle.purged,
        state.snapshotAt, 'SYSTEM', state.runId, {
          sourcePresent: false, purgeActionCompleted: verifiedPlatformPurge, ownerSelfPurgeIntent: verifiedSelfPurge
        }));
    } else {
      oldAsset.LIFECYCLE_STATE = stateName;
      oldAsset.SOURCE_ACTIVITY_STATUS = 'NOT_PRESENT_IN_LATEST_SOURCE';
      oldAsset.ASSET_STATUS = deriveAssetStatus_(oldAsset, stateName);
    }
    oldAsset.SNAPSHOT_AT = state.snapshotAt;
    carry.push(oldAsset);
  });
  appendObjectRows_(APP.sheets.assetsCurrent, ASSET_HEADERS, carry);
  updateObjectsByKey_(APP.sheets.cases, 'CASE_ID', caseUpdates);
  appendRawRows_(APP.sheets.events, events);
  const nextRow = startRow + count;
  return {
    nextRow: nextRow, done: nextRow > lastRow, carriedForward: carry.length,
    purgedAssets: purgedAssets, selfPurgedAssets: selfPurgedAssets
  };
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

function scheduleImportContinuation_(delayMs) {
  deleteImportContinuationTriggers_();
  ScriptApp.newTrigger('continueSnowflakeImport').timeBased().after(Math.max(10000, Number(delayMs || 10000))).create();
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

function resumeSnowflakeImport() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  reclaimOperationalGridCapacity_();
  let state = getImportState_(profile.key);
  if (!state) state = recoverFailedFinalizationState_(profile.key);
  state.message = 'A recovery continuation was requested; resuming from the latest saved checkpoint';
  state.recoveryRequestedAt = nowIso_();
  state.lastError = '';
  setImportState_(state);
  updateJobRun_(state.runId, {
    STATUS: 'RUNNING', COMPLETED_AT: '', ERROR_COUNT: Number(state.errors || 0), MESSAGE: state.message
  });
  scheduleImportContinuation_(10000);
  return getImportStatus();
}

function recoverFailedFinalizationState_(environment) {
  setExecutionEnvironment_(environment, false);
  const jobs = readObjects_(APP.sheets.jobs);
  const latest = jobs.length ? jobs[jobs.length - 1] : null;
  if (!isRecoverableFailedFinalization_(latest)) {
    throw new Error('No recoverable publication finalization is available.');
  }
  const review = getPendingIntakeReview_(environment) || {};
  const assets = readObjects_(APP.sheets.assetsCurrent);
  const counts = { state: {}, evaluation: {}, environment: {}, ownership: {}, domain: {} };
  assets.forEach(function (asset) {
    incrementCount_(counts.state, asset.LIFECYCLE_STATE || 'UNKNOWN');
    incrementCount_(counts.evaluation, asset.EVALUATION_STATUS || 'UNKNOWN');
    incrementCount_(counts.environment, asset.ENVIRONMENT || 'UNKNOWN');
    incrementCount_(counts.ownership, asset.OWNERSHIP_STATUS || 'UNKNOWN');
    incrementCount_(counts.domain, asset.DOMAIN || 'UNASSIGNED');
  });
  const notificationDrafts = readObjects_(APP.sheets.notifications).filter(function (record) {
    return ['DRAFT', 'FAILED'].indexOf(cleanText_(record.STATUS).toUpperCase()) !== -1;
  }).length;
  return {
    environment: normalizeEnvironment_(environment),
    runId: cleanText_(latest.RUN_ID),
    reviewToken: cleanText_(review.token),
    sourceSpreadsheetId: cleanText_(review.sourceSpreadsheetId),
    sourceSheetName: cleanText_(review.sourceSheetName),
    sourceFileName: cleanText_(review.fileName),
    phase: 'FINALIZE',
    progressStage: 'FINALIZATION_RECOVERED',
    cursorRow: Number(latest.CURSOR_ROW || Number(latest.SOURCE_ROWS || 0) + 2),
    sourceRows: Number(latest.SOURCE_ROWS || assets.length),
    sourceColumnCount: Number(review.sourceColumns || 0),
    sourceHeaders: [],
    processedRows: Number(latest.PROCESSED_ROWS || assets.length),
    writtenRows: Number(latest.WRITTEN_ROWS || assets.length),
    errors: 0,
    startedAt: cleanText_(latest.STARTED_AT) || nowIso_(),
    intakeApprovedAt: cleanText_(latest.STARTED_AT) || nowIso_(),
    snapshotAt: cleanText_(assets[0] && (assets[0].SNAPSHOT_AT || assets[0].SOURCE_SNAPSHOT_AT)) || nowIso_(),
    counts: counts,
    finalization: {
      stage: 'APPROVE_CANDIDATES', approvalCursorRow: 2, approvedAssets: notificationDrafts,
      notificationDrafts: notificationDrafts, carriedForward: 0, orphanQuarantineActions: 0,
      cancelledRecoveryActions: 0, cancelledDismissalActions: 0,
      completedQuarantineActions: 0, notificationMessage: '', recoveredAt: nowIso_()
    },
    message: 'Recovered failed finalization from published assets and durable notification drafts'
  };
}
