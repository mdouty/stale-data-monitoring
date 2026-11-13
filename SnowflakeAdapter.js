const SNOWFLAKE_V2_REQUIRED_HEADERS = Object.freeze([
  'TABLE_FQN', 'DATABASE_NAME', 'SCHEMA_NAME', 'TABLE_NAME', 'TABLE_TYPE',
  'SNOWFLAKE_TABLE_OWNER', 'SF_DPM_TEAM', 'SF_BDS_TEAM',
  'SF_BUSINESS_STEWARD', 'SF_TECHNICAL_STEWARD', 'OWNERSHIP_STATUS',
  'OWNERSHIP_SOURCE', 'SF_DOMAIN', 'SF_SUB_DOMAIN', 'ROW_COUNT', 'BYTES',
  'OBJECT_CREATED_DATE', 'LAST_READ', 'LAST_WRITE', 'LAST_LOAD', 'LAST_ALTERED',
  'SOURCE_SNAPSHOT_AT', 'SNOWFLAKE_DATA_STATUS'
]);

const SCHEMA_OWNER_REQUIRED_HEADERS = Object.freeze([
  'DB_NAME', 'SCHEMA_NAME', 'DELEGATE_NAMES', 'DS_DELEGATES', 'STATUS', 'DOMAIN'
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
    const domainRaw = sourceValue_(row, headerMap, 'DOMAIN');
    const domainParts = domainRaw ? domainRaw.split('.') : [];
    owners[key] = {
      email: email,
      name: sourceValue_(row, headerMap, 'DELEGATE_NAMES'),
      username: username,
      status: sourceValue_(row, headerMap, 'STATUS'),
      domain: domainParts[0] || '',
      subDomain: domainParts[1] || ''
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
    lastError: state.lastError || '',
    // A paused campaign that reached the delivery phase can be advanced without a Slack
    // send: any pending durable finalization is replayed and, if no owner group still
    // needs a message, the campaign is completed. Resumable while Slack is disabled.
    deliveryResumable: Boolean(!running && state.phase === 'DELIVERING')
  };
}

function getSelfHealingImportNotificationCampaignStatus_(environment) {
  const status = getImportNotificationCampaignStatus_(environment || getActiveEnvironment_());
  if (!status.stalled) return status;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1)) return status;
  try { return healImportNotificationCampaignStatus_(environment); }
  finally { lock.releaseLock(); }
}

function healImportNotificationCampaignStatus_(environment) {
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
    const cellLimitFailure = failedJob && /number of cells[\s\S]*limit of (10000000|20000000) cells/i.test(cleanText_(failedJob.MESSAGE));
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
    const paused = /_PAUSED$/.test(state.progressStage || '');
    return {
      running: !paused,
      recoverable: paused,
      stalled: stalled,
      environment: state.environment,
      runId: state.runId,
      phase: paused ? 'FAILED' : state.phase,
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

// Read-only diagnostic: run from the editor to print the current import notification
// campaign status (owner-message delivery progress) to the execution log. The editor
// never displays a function's return value, so this Logger.log wrapper exists purely to
// make getImportStatus().notificationCampaign visible while a campaign is draining.
function logImportStatus() {
  const status = getImportStatus();
  Logger.log(JSON.stringify(status.notificationCampaign, null, 2));
  return status.notificationCampaign;
}

// Manual accelerator: drain the running import notification campaign within a single editor
// execution instead of waiting on the ~60s trigger cadence (each trigger run delivers only
// one owner message + 1-2 record batches). Run from the editor (SnowflakeAdapter.gs) AFTER
// restricting web-app access to "Only myself" so poll traffic can't compete for the script
// lock. Loops continueImportNotificationCampaign until the campaign reaches a terminal status,
// stops making progress across 3 consecutive runs, or the execution nears the Apps Script
// 6-minute limit (the pending self-scheduled trigger then continues where this left off).
// Re-run it as many times as needed until logImportStatus shows SUCCEEDED.
function drainImportNotificationCampaign() {
  const deadline = Date.now() + 5 * 60 * 1000; // leave headroom under the 6-min execution cap
  const terminal = { SUCCEEDED: true, COMPLETED_WITH_ERRORS: true, PAUSED: true, NOT_QUEUED: true };
  let status = getImportNotificationCampaignStatus_();
  let iterations = 0;
  let lastSignature = '';
  let stalls = 0;
  while (Date.now() < deadline && iterations < 500) {
    if (terminal[cleanText_(status.status).toUpperCase()]) break;
    status = continueImportNotificationCampaign() || getImportNotificationCampaignStatus_();
    iterations += 1;
    const signature = [status.status, status.phase, status.ownerMessagesDelivered,
      status.ownerMessagesFailed, status.delivered, status.failed].join('|');
    if (signature === lastSignature) {
      stalls += 1;
      if (stalls >= 3) break; // no forward progress across 3 consecutive runs — stop and report
    } else {
      stalls = 0;
      lastSignature = signature;
    }
  }
  Logger.log('drainImportNotificationCampaign stopped after ' + iterations + ' run(s):\n'
    + JSON.stringify(status, null, 2));
  return status;
}

// One-time throughput tuning for the import notification campaign's delivery/finalization.
// Now that the DELIVERING loop reads the Notifications sheet ONCE per execution (execution-scoped
// snapshot) instead of once per batch, the old 2-batch cap — tuned for the read-per-batch cost —
// is the limiter, not the read. This raises: batch size to 1000 (finalizing a STALE_ASSET_NOTICE
// record writes 4 sheets + 2 flushes per batch, so a bigger batch amortizes the per-batch flush
// overhead — ceiling in continueImportNotificationCampaignLocked_/resumePaused is 2000); the
// per-execution DELIVERING batch cap to 40 (bounded by the execution budget); and the execution
// budget to 170s. It leaves the DRAFTING cap (IMPORT_NOTIFICATION_BATCHES_PER_EXECUTION) at 2 since
// drafting is not the bottleneck. Config-only; batchSize is kept so one batch stays well under the
// GAS ~360s hard limit (a batch that starts before the deadline runs to completion past it).
// Targets the running campaign's environment. Run once from the editor (SnowflakeAdapter.gs),
// then continue drainImportNotificationCampaign (or click Resume for resumePausedImportNotificationDelivery).
function tuneImportNotificationCampaignThroughput() {
  const running = getAnyRunningImportNotificationCampaign_();
  const environment = running ? normalizeEnvironment_(running.environment) : getActiveEnvironment_();
  updateEnvironmentConfigValue_('IMPORT_NOTIFICATION_CAMPAIGN_BATCH_SIZE', 500, environment);
  updateEnvironmentConfigValue_('IMPORT_NOTIFICATION_BATCHES_PER_EXECUTION', 2, environment);
  updateEnvironmentConfigValue_('IMPORT_NOTIFICATION_DELIVERING_BATCHES_PER_EXECUTION', 40, environment);
  updateEnvironmentConfigValue_('IMPORT_NOTIFICATION_EXECUTION_BUDGET_MS', 170000, environment);
  const applied = {
    environment: environment,
    batchSize: 500,
    draftingBatchesPerExecution: 2,
    deliveringBatchesPerExecution: 40,
    executionBudgetMs: 170000,
    note: 'batchSize reverted 1000->500: a 1000-row batch triggered "Service Spreadsheets timed out" (single Sheets op too large on this big/contended doc). 500 is the proven-safe value. Re-run tuneImportNotificationCampaignThroughput then drainImportNotificationCampaign.'
  };
  Logger.log('tuneImportNotificationCampaignThroughput applied:\n' + JSON.stringify(applied, null, 2));
  return applied;
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
    if (/_PAUSED$/.test(importState.progressStage || '')) return getImportStatus();
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
  PropertiesService.getScriptProperties().deleteProperty('RELIABILITY_' + normalizeEnvironment_(environment || getActiveEnvironment_()) + '_ReviewCache');
  const sheet = intakeReviewCacheSheet_(environment, false);
  if (!sheet) return;
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['TOKEN', 'JSON_CHUNK']]);
  sheet.hideSheet();
}

function writeIntakeReviewCache_(review) {
  saveDurablePayload_('ReviewCache', review.token, review);
}

function readIntakeReviewCache_(environment, token) {
  const durable = readDurablePayload_('ReviewCache', token);
  if (durable) return durable;
  // Compatibility with reviews staged before durable cache storage was introduced.
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
    rows.push([token + '|PARTIAL|' + partIndex + '|' + chunkIndex + '|J', 'J' + serialized.substring(offset, offset + chunkSize)]);
  }
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + rows.length - 1, 2);
  if (rows.length) sheet.getRange(startRow, 1, rows.length, 2).setValues(rows);
  sheet.hideSheet();
  SpreadsheetApp.flush();
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
    grouped[partIndex][chunkIndex] = parts[2] === 'J' ? (row[1] || '').substring(1) : (row[1] || '');
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
  // Duplicate FQNs across review partials are now handled during import (deduplicated by keeping first).
  merged.duplicateFqns = Object.keys(duplicates).length; // Track for diagnostics
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
  review.samples.missingFromExtract = prioritizeMissingReviewSamples_(review.samples.missingFromExtract.concat(missing), 250);
  mergeReviewPayloadPreviews_(review, buildIntakeSlackPayloadPreviews_(missing, review.sourceSnapshotAt));
  const nextRow = startRow + count;
  return { nextRow: nextRow, done: nextRow > lastRow };
}

// Mirrors the SNOWFLAKE|UPPER(FQN) identity used by calculateIntakeReview_ so
// the up-front upload check flags exactly the duplicates the merge stage would.
// Returns groups of the original-case FQN variants that collapse to one key.
function duplicateIntakeFqnGroups_(headerMap, rows) {
  const firstByKey = {};
  const collisions = {};
  (rows || []).forEach(function (row) {
    const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
    const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
    const table = sourceValue_(row, headerMap, 'TABLE_NAME');
    const rawFqn = sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.');
    if (!rawFqn) return;
    const key = 'SNOWFLAKE|' + rawFqn.toUpperCase();
    if (firstByKey[key] === undefined) {
      firstByKey[key] = rawFqn;
      return;
    }
    const variants = collisions[key] || (collisions[key] = {});
    variants[firstByKey[key]] = true;
    variants[rawFqn] = true;
  });
  return Object.keys(collisions).map(function (key) { return Object.keys(collisions[key]).sort(); });
}

function assertNoDuplicateIntakeFqns_(headerMap, rows) {
  const groups = duplicateIntakeFqnGroups_(headerMap, rows);
  if (!groups.length) return;
  const examples = groups.slice(0, 5).map(function (variants) { return variants.join(' / '); });
  throw new Error('The intake contains ' + groups.length + ' duplicate FQN value' +
    (groups.length === 1 ? '' : 's') + ' (matched case-insensitively). Correct the file before uploading. ' +
    'Example' + (examples.length === 1 ? '' : 's') + ': ' + examples.join('; ') +
    (groups.length > examples.length ? '; …' : '') + '.');
}

function stageSnowflakeCsvUpload(formObject) {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return stageSnowflakeCsvUploadLocked_(formObject); }
  finally { lock.releaseLock(); }
}

function stageSnowflakeCsvUploadLocked_(formObject) {
  const actor = assertAdmin_();
  const profile = assertEnvironmentWritable_();
  clearBlankProductionWorkflowState_();
  if (!profile.importEnabled) throw new Error(profile.label + ' imports are disabled.');
  if (getAnyImportState_()) throw new Error('An import is already running. Wait for it to finish before uploading another file.');
  if (getAnyRunningImportNotificationCampaign_()) throw new Error('A post-import Slack campaign is still running. Wait for it to finish before uploading another file.');
  const requestId = cleanText_(formObject && formObject.uploadRequestId);
  const existing = getPendingIntakeReview_(profile.key);
  if (requestId && existing && existing.uploadRequestId === requestId) return existing;
  const blob = formObject && formObject.intakeFile;
  if (!blob || typeof blob.getBytes !== 'function') throw new Error('Choose a CSV file to import.');
  const fileName = cleanText_(blob.getName && blob.getName()) || 'Snowflake intake.csv';
  if (!/\.csv$/i.test(fileName)) throw new Error('The intake must be a .csv file.');
  const bytes = blob.getBytes();
  const maximumMb = Math.max(30, configNumber_('MAX_INTAKE_FILE_SIZE_MB', 100));
  const maximumBytes = maximumMb * 1024 * 1024;
  if (!bytes.length) throw new Error('The selected CSV file is empty.');
  if (bytes.length > maximumBytes) throw new Error('The CSV is larger than the ' + maximumMb + ' MB intake limit.');
  const csvText = blob.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
  const parsed = Utilities.parseCsv(csvText);
  if (parsed.length < 2) throw new Error('The CSV must contain a header row and at least one data row.');
  const headers = parsed.shift().map(function (value) { return cleanText_(value).toUpperCase(); });
  const headerMap = validateSnowflakeV2Headers_(headers);
  const rows = [];
  parsed.forEach(function (row) {
    if (row.some(function (value) { return cleanText_(value); })) rows.push(row);
  });
  // Duplicate FQNs are now handled during import (deduplicated by keeping first occurrence).
  // Files with duplicate FQNs are allowed to proceed through intake/review.
  const sheet = writeIntakeUploadSheet_(headers, rows, profile.key);
  clearIntakeReviewCache_(profile.key);
  const staged = {
    token: uuid_(),
    environment: profile.key,
    preparationStatus: 'QUEUED',
    uploadRequestId: requestId,
    preparationStartedAt: nowIso_(),
    sourceSpreadsheetId: intakeStagingSpreadsheetId_(),
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
  // Best-effort watchdog trigger; client polling (continueSnowflakeIntakeReview)
  // drains the review synchronously, so a trigger-service outage or a missing
  // script.scriptapp grant must not fail the staging call. Matches the guarded
  // call sites in prepareSnowflakeIntakeReview/resumeSnowflakeIntakeReview.
  try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
  return staged;
}

function recoverSnowflakeIntake(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const pending = getPendingIntakeReview_(profile.key);
  const requestId = cleanText_(input && input.uploadRequestId);
  if (!pending || (requestId && pending.uploadRequestId !== requestId)) return null;
  if (getImportState_(profile.key)) return null;
  if (pending.preparationStatus === 'STAGED') return prepareSnowflakeIntakeReview({ token: pending.token });
  return getIntakeReviewPreparationStatus({ token: pending.token });
}

function resumeSnowflakeIntakeReview(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let token;
  try {
    const pending = getPendingIntakeReview_(profile.key);
    if (!pending || pending.token !== cleanText_(input && input.token)) throw new Error('The staged review is no longer current.');
    // A user-initiated resume clears backoff so the next checkpoint runs immediately,
    // and restores the phase a failed run was in so it continues from its saved cursor.
    if (pending.preparationStatus === 'FAILED') pending.preparationStatus = pending.failedPreparationStatus || 'QUEUED';
    pending.lastError = '';
    pending.retryCount = 0;
    pending.retryAfter = 0;
    setPendingIntakeReview_(pending);
    token = pending.token;
    // Best-effort watchdog; ignored when triggers are unavailable (trigger-service outage
    // or a missing script.scriptapp grant). The synchronous drain below still progresses.
    try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
  } finally { lock.releaseLock(); }
  // Advance checkpoints synchronously so a paused review still completes without depending
  // on the trigger service. continueSnowflakeIntakeReview takes its own lock per call and
  // processes one bounded chunk; loop until it is no longer running or the budget elapses.
  const deadline = Date.now() + 240000;
  let status = getIntakeReviewPreparationStatus({ token: token });
  while (status.running && Date.now() < deadline) {
    const progressBefore = cleanText_(status.status) + '|' + Number(status.processedRows || 0);
    status = continueSnowflakeIntakeReview({ token: token }) || getIntakeReviewPreparationStatus({ token: token });
    // Stop if a checkpoint made no progress (e.g. it hit an error and set a retry delay),
    // rather than spinning; the persisted lastError is surfaced to the caller.
    if (cleanText_(status.status) + '|' + Number(status.processedRows || 0) === progressBefore) break;
  }
  return status;
}

function prepareSnowflakeIntakeReview(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const token = cleanText_(input && input.token || input);
  const staged = getPendingIntakeReview_(profile.key);
  if (!staged || staged.token !== token) throw new Error('This staged upload is no longer current. Upload the CSV again.');
  if (getAnyImportState_()) throw new Error('An import is already running. Wait for it to finish before preparing another review.');
  if (staged.preparationStatus !== 'STAGED') return getIntakeReviewPreparationStatus({ token: token });
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
    const requestedToken = cleanText_(input && input.token);
    staged = ['PRD', 'DEV'].map(function (environment) { return getPendingIntakeReview_(environment); })
      .filter(function (review) {
        return review && ['QUEUED', 'CALCULATING_REVIEW', 'MERGING_REVIEW', 'RECONCILING_REVIEW'].indexOf(review.preparationStatus) !== -1 &&
          (!requestedToken || review.token === requestedToken);
      })[0];
    // A background trigger may have finished between browser requests.
    if (!staged) return requestedToken ? getIntakeReviewPreparationStatus(input) : null;
    setExecutionEnvironment_(staged.environment, false);
    if (Number(staged.retryAfter || 0) > Date.now()) return getIntakeReviewPreparationStatus({ token: staged.token });
    // Best-effort watchdog. A trigger-service outage or a missing script.scriptapp grant
    // must not abort the checkpoint before it does useful work; a synchronous resume can
    // still drain the review without it.
    try { scheduleIntakeReviewPreparation_(7 * 60 * 1000); } catch (watchdogError) {}
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
      const batchStartedAt = Date.now();
      let completedBatches = 0;
      do {
        const count = Math.min(batchSize, finalRow - Number(staged.reviewCursorRow || 2) + 1);
        if (count > 0) {
          const rows = source.getRange(staged.reviewCursorRow, 1, count, width).getDisplayValues();
          const partialKey = staged.token + '|' + staged.reviewPartCount;
          let partial = readDurablePayload_('ReviewPartial', partialKey);
          if (!partial) {
            partial = calculateIntakeReview_(headers, rows, {
              fileName: staged.fileName, fileSizeBytes: staged.fileSizeBytes, uploadedBy: staged.uploadedBy,
              environment: staged.environment, sourceSnapshotAt: staged.sourceSnapshotAt,
              reviewSampleLimit: 20, incremental: true
            });
            saveDurablePayload_('ReviewPartial', partialKey, partial);
          }
          appendIntakeReviewPartial_(staged.environment, staged.token, Number(staged.reviewPartCount || 0), partial);
          staged.reviewCursorRow += count;
          staged.reviewProcessedRows += count;
          staged.reviewPartCount += 1;
          staged.lastCheckpointAt = nowIso_();
          staged.retryCount = 0;
          staged.retryAfter = 0;
          if (staged.reviewCursorRow > finalRow) staged.preparationStatus = 'MERGING_REVIEW';
          setPendingIntakeReview_(staged);
          completedBatches += 1;
        } else {
          staged.preparationStatus = 'MERGING_REVIEW';
        }
        // Keep the original batch boundaries and save each checkpoint before doing more work.
      } while (staged.preparationStatus === 'CALCULATING_REVIEW' && completedBatches < 3 &&
        Date.now() - batchStartedAt < 30000);
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
      mergedReview.uploadRequestId = staged.uploadRequestId || '';
      mergedReview.reviewedAt = nowIso_();
      writeIntakeReviewCache_(mergedReview);
      staged.preparationStatus = 'RECONCILING_REVIEW';
      staged.reconciliationCursorRow = 2;
      staged.retryCount = 0;
      staged.retryAfter = 0;
      setPendingIntakeReview_(staged);
      try { scheduleIntakeReviewPreparation_(); } catch (scheduleError) {}
      return getIntakeReviewPreparationStatus({ token: staged.token });
    }

    const review = readIntakeReviewCache_(staged.environment, staged.token);
    if (!review) throw new Error('The merged intake review could not be loaded. Upload the CSV again.');
    const reconciliation = reconcileIntakeReviewChunk_(review, Math.max(Number(staged.reconciliationCursorRow || 2), Number(review._reconciliationCursorRow || 2)),
      Math.max(50, Math.min(250, configNumber_('INTAKE_REVIEW_BATCH_SIZE', 150))));
    staged.reconciliationCursorRow = reconciliation.nextRow;
    review._reconciliationCursorRow = reconciliation.nextRow;
    if (!reconciliation.done) {
      writeIntakeReviewCache_(review);
      staged.retryCount = 0;
      staged.retryAfter = 0;
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
    // The review is READY and persisted above; a trigger-cleanup failure (e.g. missing
    // scriptapp grant) must not flip a completed review back into an error state.
    try { deleteIntakeReviewPreparationTriggers_(); } catch (cleanupError) {}
    return getIntakeReviewPreparationStatus({ token: staged.token });
  } catch (error) {
    if (staged) {
      // Resume from the persisted cursor, never from an in-memory cursor whose cache write failed.
      const checkpoint = getPendingIntakeReview_(staged.environment);
      if (checkpoint && checkpoint.token === staged.token) staged = checkpoint;
      staged.failedPreparationStatus = staged.preparationStatus;
      staged.retryCount = Number(staged.retryCount || 0) + 1;
      staged.retryAfter = Date.now() + 60000 * staged.retryCount;
      if (staged.retryCount >= 3) staged.preparationStatus = 'FAILED';
      staged.lastError = String(error && error.message ? error.message : error).substring(0, 1000);
      staged.failedAt = nowIso_();
      setPendingIntakeReview_(staged);
      if (staged.preparationStatus !== 'FAILED') {
        try { scheduleIntakeReviewPreparation_(60000 * staged.retryCount); } catch (scheduleError) {}
      }
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
  review.uploadRequestId = staged.uploadRequestId || '';
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
    // Reading status must never destroy a resumable checkpoint.
    try { scheduleIntakeReviewPreparation_(); } catch (error) { console.error(String(error.message || error)); }
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

function scheduleIntakeReviewPreparation_(delayMs) {
  replaceWorkflowTrigger_('continueSnowflakeIntakeReview', Math.max(10000, Number(delayMs || 10000)));
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
    uploadRequestId: review.uploadRequestId || '',
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
      missingFromExtract: prioritizeMissingReviewSamples_(missing, reviewSampleLimit)
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
    ['Schema owner domain', asset.SCHEMA_OWNER_DOMAIN, schemaOwner && schemaOwner.domain || ''],
    ['Schema owner sub-domain', asset.SCHEMA_OWNER_SUBDOMAIN, schemaOwner && schemaOwner.subDomain || ''],
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

// The staged CSV can live in a separate workbook so a full copy of the upload does not
// count against the foundation workbook's cell limit. Empty setting = foundation workbook.
function intakeStagingSpreadsheetId_() {
  return cleanText_(getConfig_().INTAKE_STAGING_SPREADSHEET_ID) || APP.foundationSpreadsheetId;
}

function getIntakeStagingSpreadsheet_() {
  const spreadsheetId = intakeStagingSpreadsheetId_();
  return spreadsheetId === APP.foundationSpreadsheetId ? getFoundationSpreadsheet_() : SpreadsheetApp.openById(spreadsheetId);
}

function writeIntakeUploadSheet_(headers, rows, environment) {
  const spreadsheet = getIntakeStagingSpreadsheet_();
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
  const sheet = SpreadsheetApp.openById(review.sourceSpreadsheetId).getSheetByName(review.sourceSheetName);
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
  const scoped = filterIntakeReviewExportRows_(exported.headers, exported.rows, payload.reviewStage, payload.reviewType);
  return {
    fileName: intakeReviewExportFileName_(pending.fileName, scoped.suffix),
    headers: exported.headers,
    rows: scoped.rows
  };
}

// Narrows a full review export to one review step (and optionally one review type) so the
// table's "Export all" covers the whole category, not just the loaded samples.
function filterIntakeReviewExportRows_(headers, rows, reviewStage, reviewType) {
  const stage = cleanText_(reviewStage).toUpperCase();
  const type = cleanText_(reviewType).toUpperCase();
  if (!stage && !type) return { rows: rows, suffix: '' };
  const stageIndex = headers.indexOf('REVIEW_STAGE');
  const typeIndex = headers.indexOf('REVIEW_TYPE');
  const proposedIndex = headers.indexOf('PROPOSED_LIFECYCLE_STATE');
  const filtered = rows.filter(function (row) {
    if (stage && cleanText_(row[stageIndex]).toUpperCase() !== stage) return false;
    // Retained-only missing rows are not part of the Quarantine & purge step; only purge verifications are.
    if (cleanText_(row[typeIndex]).toUpperCase() === 'MISSING_FROM_EXTRACT' && cleanText_(row[proposedIndex]).toUpperCase() !== 'PURGED') return false;
    if (type && cleanText_(row[typeIndex]).toUpperCase() !== type) return false;
    return true;
  });
  return { rows: filtered, suffix: [stage, type].filter(Boolean).join('_').toLowerCase() };
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
    'SCHEMA_OWNER_NAME', 'SCHEMA_OWNER_USERNAME', 'SCHEMA_OWNER_ASSIGNMENT_STATUS', 'SCHEMA_OWNER_DOMAIN', 'SCHEMA_OWNER_SUBDOMAIN',
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
      status: asset.SCHEMA_OWNER_ASSIGNMENT_STATUS,
      domain: asset.SCHEMA_OWNER_DOMAIN,
      subDomain: asset.SCHEMA_OWNER_SUBDOMAIN
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

// The review table only lists purge verifications from the missing-from-extract population, while the
// retained-for-reconciliation items can number in the thousands. Keep the verifications first so the
// sample cap cannot crowd them out.
function prioritizeMissingReviewSamples_(items, limit) {
  const verifications = items.filter(function (item) { return item.purgeVerification; });
  const retained = items.filter(function (item) { return !item.purgeVerification; });
  return verifications.concat(retained).slice(0, limit);
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
    schemaOwner && schemaOwner.domain || '', schemaOwner && schemaOwner.subDomain || '',
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

function intakeReviewExportFileName_(sourceFileName, scopeSuffix) {
  const base = cleanText_(sourceFileName).replace(/\.csv$/i, '').replace(/[^a-z0-9._-]+/gi, '_') || 'snowflake_intake';
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyyMMdd_HHmmss');
  return base + '_review_details_' + (scopeSuffix ? scopeSuffix + '_' : '') + stamp + '.csv';
}

function confirmSnowflakeIntake(reviewInput) {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return confirmSnowflakeIntakeLocked_(reviewInput); }
  finally { lock.releaseLock(); }
}

function confirmSnowflakeIntakeLocked_(reviewInput) {
  const actor = assertAdmin_();
  const payload = reviewInput && typeof reviewInput === 'object' ? reviewInput : { token: reviewInput };
  const profile = assertEnvironmentWritable_();
  const existing = getImportState_(profile.key);
  if (existing && existing.reviewToken === cleanText_(payload.token)) return getImportStatus();
  if (getAnyImportState_()) throw new Error('An import is already running.');
  const approved = PropertiesService.getScriptProperties().getProperty(reliabilityProperty_('ApprovedReview'));
  if (approved && JSON.parse(approved).token === cleanText_(payload.token)) return getImportStatus();
  let review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(payload.token)) throw new Error('This intake review is no longer current. Upload the CSV again.');
  if (review.preparationStatus !== 'READY') throw new Error('The intake review is not ready to publish.');
  review = applyIntakeReviewDecisions_(review, payload.dismissedAssetIds || []);
  return startSnowflakeImportInternal_(actor, review.token, true);
}

function getSnowflakePublicationStatus(input) {
  assertAdmin_();
  assertEnvironmentWritable_();
  const token = cleanText_(input && input.token);
  const current = getImportState_();
  if (current && current.reviewToken === token) return getImportStatus();
  const raw = PropertiesService.getScriptProperties().getProperty(reliabilityProperty_('ApprovedReview'));
  if (raw && JSON.parse(raw).token === token) return getImportStatus();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1)) return { pending: true };
  lock.releaseLock();
  return null;
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
  const cases = loadCaseMap_();
  const accepted = {};
  const decisionValues = [];
  const writeChunk = Math.max(200, Math.min(2000, configNumber_('INTAKE_DECISION_WRITE_CHUNK', 1000)));
  for (let offset = 0; offset < rowCount; offset += writeChunk) {
    const count = Math.min(writeChunk, rowCount - offset);
    const rows = source.getRange(offset + 2, 1, count, headers.length).getDisplayValues();
    rows.forEach(function (row) {
      const database = sourceValue_(row, headerMap, 'DATABASE_NAME');
      const schema = sourceValue_(row, headerMap, 'SCHEMA_NAME');
      const table = sourceValue_(row, headerMap, 'TABLE_NAME');
      const fqn = (sourceValue_(row, headerMap, 'TABLE_FQN') || [database, schema, table].filter(Boolean).join('.')).toUpperCase();
      const assetId = fqn ? 'SNOWFLAKE|' + fqn : '';
      if (!selected[assetId]) {
        decisionValues.push(['']);
        return;
      }
      const snapshot = sourceValue_(row, headerMap, 'SOURCE_SNAPSHOT_AT') || review.sourceSnapshotAt || nowIso_();
      const activity = deriveSourceActivity_(row, headerMap, snapshot, configNumber_('STALE_THRESHOLD_DAYS', 180));
      const restricted = normalizedSnowflakeDataStatus_(sourceValue_(row, headerMap, 'SNOWFLAKE_DATA_STATUS')) === APP.lifecycle.restricted;
      const currentState = canonicalLifecycleState_(cases[assetId] && cases[assetId].STATE);
      if (!activity.isStale || restricted || !isIntakeDismissibleState_(currentState)) {
        decisionValues.push(['']);
        return;
      }
      accepted[assetId] = true;
      decisionValues.push([APP.lifecycle.dismissed]);
    });
  }
  const rejected = ids.filter(function (assetId) { return !accepted[assetId]; });
  if (rejected.length) throw new Error(rejected.length + ' selected record' + (rejected.length === 1 ? ' is' : 's are') + ' no longer eligible for dismissal. Refresh the intake review and try again.');
  if (decisionValues.length) {
    for (let offset = 0; offset < decisionValues.length; offset += writeChunk) {
      const chunk = decisionValues.slice(offset, offset + writeChunk);
      source.getRange(offset + 2, decisionIndex + 1, chunk.length, 1).setValues(chunk);
    }
  }
  SpreadsheetApp.flush();
  review.sourceColumns = headers.length;
  review.headerSignature = headers.join('|');
  review.dismissedCandidates = ids.length;
  setPendingIntakeReview_(review);
  return review;
}

function startSnowflakeImportInternal_(actor, reviewToken, lockHeld) {
  const profile = assertEnvironmentWritable_();
  if (!profile.importEnabled) throw new Error(profile.label + ' imports are disabled.');
  const review = getPendingIntakeReview_(profile.key);
  if (!review || review.token !== cleanText_(reviewToken)) throw new Error('This intake review is no longer current. Upload the CSV again.');
  if (review.preparationStatus !== 'READY') throw new Error('The intake review is not ready to publish.');
  if (review.environment !== profile.key) throw new Error('The reviewed intake belongs to a different environment.');
  const lock = lockHeld ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(20000);
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
    // Append-only mode is captured once per run so a config change mid-import cannot
    // leave a run half staged (swap + reconcile) and half appended.
    const appendMode = configBoolean_('IMPORT_APPEND_ONLY', false);
    if (!appendMode) clearDataRows_(APP.sheets.assetsStaging);
    appendRawRows_(APP.sheets.jobs, [[
      runId, 'SNOWFLAKE_SHEET_IMPORT_V2', 'RUNNING', nowIso_(), '', 2,
      sourceRows, 0, 0, 0, 'Intake approved by ' + actor.email
    ]]);
    const state = {
      environment: profile.key,
      runId: runId,
      appendMode: appendMode,
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
      message: 'Publishing reviewed ' + profile.label + ' Snowflake intake' +
        (appendMode ? ' (append-only: existing assets are not compared, carried forward, or owner-change detected)' : '')
    };
    setImportState_(state);
    // Best-effort watchdog. When triggers are unavailable (missing script.scriptapp grant
    // or a trigger-service outage) the open browser drives continuation via the status poll,
    // so a failed schedule must not abort the import before it starts.
    try { scheduleImportContinuation_(7 * 60 * 1000); } catch (watchdogError) {}
    PropertiesService.getScriptProperties().setProperty(reliabilityProperty_('ApprovedReview'), JSON.stringify({ token: review.token, runId: runId }));
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
    if (lock) lock.releaseLock();
  }
}

function continueSnowflakeImport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return getImportStatus();
  try {
    let state = getAnyImportState_();
    if (state && normalizeEnvironment_(state.environment) === 'PRD') {
      setExecutionEnvironment_('PRD', false);
      clearBlankProductionWorkflowState_();
      state = getAnyImportState_();
    }
    if (!state) return getImportStatus();
    setExecutionEnvironment_(state.environment, false);
    if (/_PAUSED$/.test(state.progressStage || '') || Number(state.retryAfter || 0) > Date.now()) return getImportStatus();
    // Best-effort watchdog. This call previously threw here when the trigger scope was
    // missing, driving the job into FINALIZATION_PAUSED and blocking the browser-driven
    // finalization below. Guard it so a paused review still finalizes with the tab open.
    try { scheduleImportContinuation_(7 * 60 * 1000); } catch (watchdogError) {}
    if (state.phase === 'IMPORT') {
      const batchStartedAt = Date.now();
      let completedBatches = 0;
      do {
        importSourceChunk_(state, false, true);
        completedBatches += 1;
      } while (state.phase === 'IMPORT' && completedBatches < 3 && Date.now() - batchStartedAt < 30000);
      const current = getImportState_(state.environment);
      if (current && ['IMPORT', 'PREPARE_FINALIZE'].indexOf(current.phase) !== -1) {
        try { scheduleImportContinuation_(); } catch (scheduleError) {}
      }
    } else if (state.phase === 'PREPARE_FINALIZE' || (state.phase === 'FINALIZE' && !state.assetBuffersPublished && state.assetBufferIds)) beginImportFinalization_(state, false);
    else if (state.phase === 'FINALIZE') {
      // Loop multiple batches per execution: approvals and reconcile each advance one batch per call.
      if (state.finalization && ['APPROVE_CANDIDATES', 'RECONCILE'].indexOf(state.finalization.stage) !== -1) {
        const batchStartedAt = Date.now();
        let completedBatches = 0;
        const batchCap = Math.max(1, Math.min(60, configNumber_('FINALIZATION_BATCHES_PER_EXECUTION', 20)));
        const executionBudgetMs = Math.max(30000, configNumber_('FINALIZATION_EXECUTION_BUDGET_MS', 200000));
        do {
          finalizeImport_(state, true);
          completedBatches += 1;
        } while (state.finalization && ['APPROVE_CANDIDATES', 'RECONCILE'].indexOf(state.finalization.stage) !== -1 && completedBatches < batchCap && Date.now() - batchStartedAt < executionBudgetMs);
        // Schedule the next execution once, outside the loop.
        const current = getImportState_(state.environment);
        if (current && ['FINALIZE'].indexOf(current.phase) !== -1) {
          try { scheduleImportContinuation_(); } catch (scheduleError) {}
        }
      } else {
        finalizeImport_(state, false);
      }
    }
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
  state.retryCount = Number(state.retryCount || 0) + 1;
  if (state.retryCount < 3) {
    state.progressStage = 'RETRY_PENDING';
    state.retryAfter = Date.now() + 60000 * state.retryCount;
    state.lastError = String(error.message || error).substring(0, 500);
    state.message = 'Retrying the saved checkpoint after a service failure (' + state.retryCount + ' of 3): ' + state.lastError;
    setImportState_(state);
    try { scheduleImportContinuation_(60000 * state.retryCount); } catch (scheduleError) {}
    return;
  }
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
    try { deleteImportContinuationTriggers_(); } catch (cleanupError) {}
  } else {
    state.progressStage = 'IMPORT_PAUSED';
    state.message = 'Source import paused; saved batch writes can be resumed safely: ' + String(error.message || error).substring(0, 500);
    state.lastError = String(error.message || error).substring(0, 500);
    setImportState_(state);
    try { deleteImportContinuationTriggers_(); } catch (cleanupError) {}
  }
}

function importSourceChunk_(state, inlineExecution, deferScheduling) {
  setExecutionEnvironment_(state.environment, false);
  const batchKey = state.runId + '|' + state.cursorRow;
  const savedBatch = readDurablePayload_('SourceBatch', batchKey);
  if (savedBatch) return completeSourceBatch_(state, savedBatch, inlineExecution, deferScheduling, batchKey);
  const source = SpreadsheetApp.openById(state.sourceSpreadsheetId).getSheetByName(state.sourceSheetName);
  if (!source) throw new Error('The staged intake source is no longer available.');
  const headerMap = validateSnowflakeV2Headers_(state.sourceHeaders);
  const configuredChunkSize = Math.max(50, configNumber_('IMPORT_CHUNK_SIZE', APP.defaultImportChunkSize));
  const safeBatchSize = Math.max(50, Math.min(400,
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

  // Read existing NOTIFIED assets for ownership change detection (normal mode only).
  const existingAssets = state.appendMode ? {} : indexObjectsBy_(
    readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID',
      batchAssetIds.filter(function (id) {
        return cases[id] && canonicalLifecycleState_(cases[id].STATE) === APP.lifecycle.notified;
      })),
    'ASSET_ID');

  const schemaOwnerLookup = loadSchemaOwnerLookup_();
  const assetRows = [];
  const snapshots = [];
  const newCases = [];
  const updatedCases = [];
  const newEvents = [];
  const seenAssetIds = {}; // Deduplicate by ASSET_ID (FQN)

  rows.forEach(function (row, offset) {
    try {
      const result = normalizeSnowflakeRowV2_(row, headerMap, state.cursorRow + offset, state.snapshotAt, state.runId, cases, policy, schemaOwnerLookup);
      if (!result) return;

      // Skip duplicate FQNs (keep first occurrence, discard subsequent ones)
      if (seenAssetIds[result.asset.ASSET_ID]) {
        return; // Skip this duplicate
      }
      seenAssetIds[result.asset.ASSET_ID] = true;

      // Detect ownership changes for NOTIFIED assets (wrapped to never increment errors).
      try {
        const ownerEvent = buildOwnershipChangeEvent_(existingAssets[result.asset.ASSET_ID], result.asset, cases[result.asset.ASSET_ID], state.snapshotAt, state.runId);
        if (ownerEvent) newEvents.push(ownerEvent);
      } catch (ownerDetectError) {
        // Ownership detection failure must not block the import.
      }

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

  const plan = newDurableWritePlan_();
  // Append-only runs write straight to the live sheet; otherwise rows build up in the
  // staging buffer that is swapped in at finalization.
  planAppendObjects_(plan, state.appendMode ? APP.sheets.assetsCurrent : APP.sheets.assetsStaging, assetRows);
  planAppendRows_(plan, APP.sheets.snapshots, snapshots);
  planAppendObjects_(plan, APP.sheets.cases, newCases);
  planUpdateObjects_(plan, APP.sheets.cases, 'CASE_ID', updatedCases);
  planAppendRows_(plan, APP.sheets.events, newEvents);
  state.cursorRow += count;
  state.processedRows += count;
  state.writtenRows += assetRows.length;
  state.message = 'Evaluated and retained ' + state.processedRows + ' of ' + state.sourceRows + ' source rows';
  const payload = { writes: plan.writes, nextState: state };
  saveDurablePayload_('SourceBatch', batchKey, payload);
  completeSourceBatch_(state, payload, inlineExecution, deferScheduling, batchKey);
}

function completeSourceBatch_(state, payload, inlineExecution, deferScheduling, batchKey) {
  try {
    applyDurableWrites_(payload.writes);
  } catch (conflictError) {
    if (!/conflicting row/.test(String((conflictError && conflictError.message) || conflictError))) throw conflictError;
    // Another writer claimed a reserved append row (e.g. a manual status change or the
    // reminder sweep wrote to Lifecycle_Events) between planning and replay. Relocate only
    // our own appends to the sheet's current end and persist the rebased batch before
    // applying it, mirroring the notification path. Without this the saved batch replays
    // the same occupied position on every resume and the publish stays stuck.
    payload = { writes: rebaseDurableAppendWrites_(payload.writes), nextState: payload.nextState };
    saveDurablePayload_('SourceBatch', batchKey, payload);
    applyDurableWrites_(payload.writes);
  }
  Object.assign(state, payload.nextState);
  state.retryCount = 0;
  state.retryAfter = 0;
  const finalSourceRow = state.sourceRows + 1;
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
  state.phase = 'PREPARE_FINALIZE';
  state.progressStage = 'PUBLISHING_ASSET_BUFFER';
  state.message = 'Publishing the evaluated asset dataset';
  setImportState_(state);
  if (state.appendMode) {
    // Rows were already appended to Assets_Current; there is no staging buffer to publish.
    state.message = 'Appended assets are already published; skipping the buffer swap';
  } else {
    if (!state.assetBufferIds) {
      state.assetBufferIds = { current: getSheet_(APP.sheets.assetsCurrent).getSheetId(), staging: getSheet_(APP.sheets.assetsStaging).getSheetId() };
      setImportState_(state);
    }
    swapAssetBuffers_(state.assetBufferIds);
  }
  state.assetBuffersPublished = true;
  state.phase = 'FINALIZE';
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
    SCHEMA_OWNER_DOMAIN: schemaOwner && schemaOwner.domain || '',
    SCHEMA_OWNER_SUBDOMAIN: schemaOwner && schemaOwner.subDomain || '',
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

function buildOwnershipChangeEvent_(previousAsset, nextAsset, caseRecord, snapshotAt, runId) {
  // Detect if the primary recipient changed between a NOTIFIED case's previous and new asset.
  // Returns a lifecycle event row if so, null otherwise. Wrapped in try/catch by caller.
  if (!previousAsset || !nextAsset || !caseRecord) return null;

  // Case must be NOTIFIED before and after.
  const priorState = canonicalLifecycleState_(caseRecord.STATE);
  const nextState = canonicalLifecycleState_(nextAsset.LIFECYCLE_STATE || 'DETECTED');
  if (priorState !== APP.lifecycle.notified || nextState !== APP.lifecycle.notified) return null;

  // Check if Technical Steward or Schema Owner changed (normalized comparison).
  const changedFields = [];
  const prevTech = normalizedComparisonValue_(previousAsset.TECHNICAL_STEWARD || '');
  const nextTech = normalizedComparisonValue_(nextAsset.TECHNICAL_STEWARD || '');
  if (prevTech !== nextTech) changedFields.push({field: 'TECHNICAL_STEWARD', before: previousAsset.TECHNICAL_STEWARD, after: nextAsset.TECHNICAL_STEWARD});

  const prevSchema = normalizedComparisonValue_(previousAsset.SCHEMA_OWNER || '');
  const nextSchema = normalizedComparisonValue_(nextAsset.SCHEMA_OWNER || '');
  if (prevSchema !== nextSchema) changedFields.push({field: 'SCHEMA_OWNER', before: previousAsset.SCHEMA_OWNER, after: nextAsset.SCHEMA_OWNER});

  if (!changedFields.length) return null;

  // Resolve the primary recipients (ignoring the DEV lock to see the true owner change).
  const prevRecipient = resolvePrimaryRecipient_({asset: previousAsset}, 'STALE_ASSET_NOTICE', {ignoreRecipientLock: true});
  const nextRecipient = resolvePrimaryRecipient_({asset: nextAsset}, 'STALE_ASSET_NOTICE', {ignoreRecipientLock: true});

  // Only emit an event if the recipient actually changed and is non-empty.
  if (prevRecipient.primaryRecipient === nextRecipient.primaryRecipient || !nextRecipient.primaryRecipient) return null;

  const details = {
    field: changedFields[0].field,
    before: changedFields[0].before,
    after: changedFields[0].after,
    previousRecipient: prevRecipient.primaryRecipient,
    newRecipient: nextRecipient.primaryRecipient,
    previousSource: prevRecipient.primaryRecipientSource,
    newSource: nextRecipient.primaryRecipientSource,
    changes: changedFields
  };

  return lifecycleEventRow_(caseRecord.CASE_ID, nextAsset.ASSET_ID, 'OWNERSHIP_CHANGED', APP.lifecycle.notified, APP.lifecycle.notified, snapshotAt, 'SYSTEM', runId, details);
}

function loadCaseMap_() {
  const map = loadKeyedObjectMap_(APP.sheets.cases, 'ASSET_ID');
  Object.keys(map).forEach(function (assetId) {
    map[assetId].STATE = canonicalLifecycleState_(map[assetId].STATE);
  });
  return map;
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

function swapAssetBuffers_(ids) {
  const book = getFoundationSpreadsheet_();
  const current = ids ? book.getSheetById(ids.current) : getSheet_(APP.sheets.assetsCurrent);
  const staging = ids ? book.getSheetById(ids.staging) : getSheet_(APP.sheets.assetsStaging);
  if (!current || !staging) throw new Error('Asset publication buffers are missing.');
  const currentName = resolveSheetName_(APP.sheets.assetsCurrent);
  const stagingName = resolveSheetName_(APP.sheets.assetsStaging);
  const previousName = APP.environments[getActiveEnvironment_()].sheetPrefix + 'Assets_Previous';
  if (staging.getName() !== currentName) {
    if (current.getName() === currentName) current.setName(previousName);
    staging.setName(currentName);
  }
  if (current.getName() !== stagingName) current.setName(stagingName);
  staging.showSheet();
  current.hideSheet();
  const usedRows = Math.max(1, current.getLastRow());
  const leftoverRows = current.getMaxRows();
  if (leftoverRows > usedRows + 1000) current.deleteRows(usedRows + 1001, leftoverRows - usedRows - 1000);
  invalidateSheetKeyIndexCache_(APP.sheets.assetsCurrent);
  invalidateSheetKeyIndexCache_(APP.sheets.assetsStaging);
}

function finalizeImport_(state, deferScheduling) {
  // Browser-driven checkpoints are primary; the trigger is only a background backup.
  // When deferScheduling is true (batch loop), skip scheduling until the loop completes.
  if (!deferScheduling) {
    try { scheduleImportContinuation_(7 * 60 * 1000); } catch (watchdogError) {}
  }
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
      : 'Approved and staged notifications for ' + checkpoint.approvalCursorRow + ' lifecycle rows', deferScheduling);
    return;
  }

  if (checkpoint.stage === 'PREPARE_ORPHAN_HANDOFFS') {
    const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
    checkpoint.orphanQuarantineActions = queueImportOrphanQuarantineActions_(lifecycleAssets.ORPHAN_POLICY_ACCEPTED || [], state.runId);
    checkpoint.stage = 'RECONCILE';
    checkpointImportFinalization_(state, 'RECONCILING_LIFECYCLE', 'Orphan handoffs checkpointed; reconciling retained lifecycle records', deferScheduling);
    return;
  }

  if (checkpoint.stage === 'RECONCILE' && state.appendMode) {
    // Append-only: nothing was swapped out, so there are no missing assets to carry
    // forward or purge-verify. Skip the full lifecycle-case scan entirely.
    checkpoint.stage = 'APPLY_LIFECYCLE';
    checkpointImportFinalization_(state, 'APPLYING_LIFECYCLE_CHANGES',
      'Append-only import: skipped carry-forward reconciliation; applying lifecycle changes', deferScheduling);
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
        'Reconciled lifecycle rows through ' + checkpoint.reconcileCursorRow, deferScheduling);
    return;
  }

  if (checkpoint.stage === 'APPLY_LIFECYCLE') {
    setFinalizationProgress_(state, 'APPLYING_LIFECYCLE_CHANGES', 'Applying restriction, recovery, restoration, and dismissal changes');
    let saved = readDurablePayload_('LifecycleChanges', state.runId);
    if (!saved) {
      const plan = newDurableWritePlan_();
      const result = {};
      const lifecycleAssets = lifecycleEventAssetGroupsForRun_(state.runId);
      const restrictionAssetIds = uniqueAssetIds_((lifecycleAssets.SNOWFLAKE_RESTRICTION_CONFIRMED || [])
        .concat(lifecycleAssets.SNOWFLAKE_INITIAL_RESTRICTION || []));
      const activeRecoveryAssetIds = lifecycleAssets.STALE_ASSET_BECAME_ACTIVE || [];
      const dismissedAssetIds = lifecycleAssets.INTAKE_CANDIDATE_DISMISSED || [];
      const cancelledActions = cancelImportPlatformActions_(activeRecoveryAssetIds, dismissedAssetIds, plan);
      result.cancelledRecoveryActions = cancelledActions.recovery;
      result.cancelledDismissalActions = cancelledActions.dismissal;
      result.completedQuarantineActions = completeQuarantineActionsFromImport_(restrictionAssetIds, state.snapshotAt, state.runId, plan);
      result.restrictionAssets = restrictionAssetIds.length;
      result.activeRecoveryAssets = activeRecoveryAssetIds.length;
      result.dismissedAssets = dismissedAssetIds.length;
      result.stage = 'REFRESH_DASHBOARD';
      saved = { writes: plan.writes, result: result };
      saveDurablePayload_('LifecycleChanges', state.runId, saved);
    }
    applyDurableWrites_(saved.writes);
    Object.assign(checkpoint, saved.result);
    checkpointImportFinalization_(state, 'REFRESHING_DASHBOARD', 'Lifecycle changes checkpointed; refreshing dashboard summaries', deferScheduling);
    return;
  }

  if (checkpoint.stage === 'REFRESH_DASHBOARD') {
    setFinalizationProgress_(state, 'REFRESHING_DASHBOARD', 'Refreshing the published asset index and dashboard summaries');
    refreshDashboardIndex_();
    clearDataRows_(APP.sheets.dashboardSummary);
    const summaryRows = [];
    // Append-only runs only counted the appended rows, so recount the whole live sheet.
    // A recount (unlike adding to existing summary rows) is safe to repeat on retry.
    const summaryCounts = state.appendMode ? countCurrentAssetDimensions_() : state.counts;
    ['state', 'evaluation', 'environment', 'ownership', 'domain'].forEach(function (dimension) {
      const values = summaryCounts[dimension] || {};
      Object.keys(values).sort().forEach(function (key, index) {
        summaryRows.push([state.snapshotAt, dimension.toUpperCase(), key, 'ASSET_COUNT', values[key], index + 1, state.runId]);
      });
    });
    appendRawRows_(APP.sheets.dashboardSummary, summaryRows);
    try { pruneEvaluationSnapshots_(configNumber_('SNAPSHOT_RETENTION_RUNS', APP.defaultSnapshotRetentionRuns)); } catch (pruneError) {}
    checkpoint.stage = 'NOTIFICATIONS';
    checkpointImportFinalization_(state, 'QUEUING_NOTIFICATIONS', 'Dashboard checkpointed; preparing retryable notification delivery', deferScheduling);
    return;
  }

  if (checkpoint.stage === 'NOTIFICATIONS') {
    checkpoint.notificationMessage = finalizeImportNotifications_(state);
    checkpoint.stage = 'COMPLETE';
    checkpointImportFinalization_(state, 'COMPLETING_PUBLICATION', 'Notification handoff checkpointed; completing publication', deferScheduling);
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
  clearIntakeReviewCache_(state.environment);
  clearPendingIntakeReview_(state.environment);
  clearImportState_(state.environment);
  // Publication already succeeded; a missing trigger scope must not turn completion into a failure.
  try { deleteImportContinuationTriggers_(); } catch (cleanupError) {}
}

function countCurrentAssetDimensions_() {
  const counts = { state: {}, evaluation: {}, environment: {}, ownership: {}, domain: {} };
  const columns = {
    state: 'LIFECYCLE_STATE', evaluation: 'EVALUATION_STATUS', environment: 'ENVIRONMENT',
    ownership: 'OWNERSHIP_STATUS', domain: 'DOMAIN'
  };
  Object.keys(columns).forEach(function (dimension) {
    readColumnValues_(APP.sheets.assetsCurrent, columns[dimension]).forEach(function (row) {
      const value = cleanText_(row[0]);
      if (dimension !== 'domain' && !value) return;
      incrementCount_(counts[dimension], value || 'UNASSIGNED');
    });
  });
  return counts;
}

function checkpointImportFinalization_(state, progressStage, message, deferScheduling) {
  state.retryCount = 0;
  state.retryAfter = 0;
  state.finalization.updatedAt = nowIso_();
  setFinalizationProgress_(state, progressStage, message);
  // When deferScheduling is true (batch loop), save state but skip scheduling; the loop schedules once at the end.
  if (!deferScheduling) {
    try { scheduleImportContinuation_(10000); } catch (scheduleError) {}
  }
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
  const caseMap = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', restrictionAssetIds), 'ASSET_ID');
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
  let needsRecovery = false;
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
      needsRecovery = needsRecovery || Boolean(delivery.failedAssetCount);
      message += importNotificationDeliveryMessage_(item[0], delivery);
    } catch (error) {
      needsRecovery = true;
      message += ' ' + item[0] + ' needs attention: ' + String(error.message || error).substring(0, 300) + '.';
    }
  });
  if (needsRecovery && profile.isProduction) {
    queueImportNotificationCampaign_(state.runId, state.environment);
    message += ' Unfinished deliveries are retained in the background recovery campaign.';
  }
  return message;
}

function importNotificationCampaignCaseGroups_(runId) {
  // Read only the four columns we need as single-column ranges and keep just the
  // matching ASSET_ID strings. A full-extract run tags every Cases row with the
  // same LAST_EVALUATION_RUN_ID, so materializing whole row objects for all of
  // them (the previous readObjectsByField_ path) exhausted memory at 62k scale.
  const sheet = getSheet_(APP.sheets.cases);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const seen = {};
  const staleAssetIds = [];
  const orphanAssetIds = [];
  if (lastRow < 2 || lastColumn < 1) return [];
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const runIdCol = headers.indexOf('LAST_EVALUATION_RUN_ID');
  const assetIdCol = headers.indexOf('ASSET_ID');
  const stateCol = headers.indexOf('STATE');
  const ownerCol = headers.indexOf('OWNER_STATUS');
  if ([runIdCol, assetIdCol, stateCol, ownerCol].indexOf(-1) !== -1) return [];
  const rowCount = lastRow - 1;
  const targetRunId = cleanText_(runId);
  const runIds = sheet.getRange(2, runIdCol + 1, rowCount, 1).getDisplayValues();
  const assetIds = sheet.getRange(2, assetIdCol + 1, rowCount, 1).getDisplayValues();
  const states = sheet.getRange(2, stateCol + 1, rowCount, 1).getDisplayValues();
  const owners = sheet.getRange(2, ownerCol + 1, rowCount, 1).getDisplayValues();
  for (let i = 0; i < rowCount; i += 1) {
    if (cleanText_(runIds[i][0]) !== targetRunId) continue;
    const assetId = cleanText_(assetIds[i][0]);
    if (!assetId || seen[assetId]) continue;
    const state = canonicalLifecycleState_(states[i][0]);
    const ownerStatus = cleanText_(owners[i][0]).toUpperCase();
    const orphan = ['ORPHANED', 'UNKNOWN'].indexOf(ownerStatus) !== -1;
    if (orphan && [APP.lifecycle.accepted, APP.lifecycle.quarantined].indexOf(state) !== -1) {
      orphanAssetIds.push(assetId);
      seen[assetId] = true;
      continue;
    }
    if (!orphan && [APP.lifecycle.detected, APP.lifecycle.notified].indexOf(state) !== -1) {
      staleAssetIds.push(assetId);
      seen[assetId] = true;
    }
  }
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
  const cases = restrictionIds.length && typeof readObjectsByKeys_ === 'function'
    ? indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', restrictionIds), 'ASSET_ID')
    : loadCaseMap_();
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
        // The browser poll drives the campaign forward while a tab is open; a missing
        // trigger scope must not throw and block the caller from getting the queued state.
        try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return null;
  try { return continueImportNotificationCampaignLocked_(environment); }
  finally { lock.releaseLock(); }
}

function continueImportNotificationCampaignLocked_(environment) {
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
    try { deleteImportNotificationCampaignTriggers_(); } catch (cleanupError) {}
    return getImportNotificationCampaignStatus_();
  }
  setExecutionEnvironment_(state.environment, false);
  try {
    const profile = assertEnvironmentWritable_();
    recoverPendingSynchronousDelivery_();
    if (!configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false)) {
      state.status = 'PAUSED';
      state.lastError = profile.label + ' Slack notifications are disabled.';
      setImportNotificationCampaignState_(state);
      // Report the true reason (Slack disabled). A missing trigger scope here must not
      // mask it by throwing into the outer catch as a confusing getProjectTriggers error.
      try { deleteImportNotificationCampaignTriggers_(); } catch (cleanupError) {}
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
    // Ceiling raised 500 -> 2000 (2026-09-30): finalizing a STALE_ASSET_NOTICE record writes to
    // 4 sheets + 2 flushes per batch, so bigger batches amortize the per-batch flush/overhead.
    // Keep the applied value (set by tuneImportNotificationCampaignThroughput) such that one batch
    // stays well under the GAS ~360s hard limit — a batch that starts before the execution deadline
    // runs to completion past it, so very large batches risk timing out mid-write.
    const batchSize = Math.max(25, Math.min(2000, configNumber_('IMPORT_NOTIFICATION_CAMPAIGN_BATCH_SIZE', 250)));
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
      // With the execution-scoped Notifications snapshot, the per-batch owner re-derivation no
      // longer re-reads the whole sheet, so one execution can safely finalize many batches for a
      // record-heavy owner instead of the 2-batch cap tuned for the read-per-batch cost. Governed
      // by the execution deadline and a separate (tunable) cap.
      const deliveringMaxBatches = Math.max(1, Math.min(60,
        configNumber_('IMPORT_NOTIFICATION_DELIVERING_BATCHES_PER_EXECUTION', maxBatchesPerExecution)));
      let batchesProcessed = 0;
      importNotificationCampaignBeginRecordsSnapshot_();
      try {
      while (state.currentOwnerDelivery && batchesProcessed < deliveringMaxBatches && Date.now() < executionDeadline) {
        const receipt = state.currentOwnerDelivery;
        const key = state.runId + '|' + receipt.batchId + '|' + Number(state.delivered || 0);
        let saved = readDurablePayload_('NotificationBatch', key);
        const replayed = Boolean(saved);
        if (!saved) {
          const remaining = importNotificationCampaignOwnerRecords_(groups, receipt.messageType, receipt.recipient);
          const plan = newDurableWritePlan_();
          const finalized = finalizeNotificationOwnerGroupChunk_(remaining.slice(0, batchSize), receipt, plan);
          const nextState = JSON.parse(JSON.stringify(state));
          nextState.delivered += finalized;
          if (remaining.length <= batchSize) {
            nextState.currentOwnerDelivery = null;
            nextState.ownerMessagesDelivered += 1;
          }
          saved = { writes: plan.writes, nextState: nextState };
          saveDurablePayload_('NotificationBatch', key, saved);
        }
        try {
          applyDurableWrites_(saved.writes);
        } catch (conflictError) {
          if (!/conflicting row/.test(String((conflictError && conflictError.message) || conflictError))) throw conflictError;
          // Another writer claimed our reserved append rows between planning and replay.
          // Relocate our own appends to the current sheet end (never overwriting the
          // foreign row) and persist the rebased plan before applying, so the exact same
          // rows — including audit events — are written once. Without this the delivery
          // replays the same occupied position on every retry and the campaign wedges.
          saved = { writes: rebaseDurableAppendWrites_(saved.writes), nextState: saved.nextState };
          saveDurablePayload_('NotificationBatch', key, saved);
          applyDurableWrites_(saved.writes);
        }
        state = saved.nextState;
        setImportNotificationCampaignState_(state);
        // A durable-payload replay applied SENT rows without the in-place record mutation the
        // snapshot relies on; refresh it so the next owner re-derivation reflects the sheet.
        if (replayed) importNotificationCampaignInvalidateRecordsSnapshot_();
        batchesProcessed += 1;
      }
      } finally {
        importNotificationCampaignEndRecordsSnapshot_();
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
      // The campaign already reached a terminal state; a missing trigger scope must not
      // turn successful completion into a failure.
      try { deleteImportNotificationCampaignTriggers_(); } catch (cleanupError) {}
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

// Execution-scoped snapshot of the Notifications sheet for the delivery finalize loop.
// The finalize path re-derives an owner's remaining DRAFT/FAILED records before EVERY batch;
// reading all ~41k rows from the sheet each time is the O(n^2) drag that stalls a record-heavy
// owner (each batch peels off only batchSize rows but pays a full-sheet read). Because
// prepareNotificationBatchItems_/finalizeNotificationOwnerGroupChunk_ mutate the very record
// objects this snapshot holds in place (STATUS -> SENT/SKIPPED), re-filtering the cached array
// yields exactly what re-reading the sheet would — so one read per execution replaces one per
// batch. Enabled ONLY inside the lock-held delivery loops (begin/end bracket them, cleared in a
// finally); a durable-payload REPLAY applies SENT rows WITHOUT that in-place mutation, so those
// paths invalidate the snapshot to force a fresh read on the next re-derivation.
var IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_ = null;

function importNotificationCampaignBeginRecordsSnapshot_() {
  IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_ = { active: true, records: null };
}

function importNotificationCampaignEndRecordsSnapshot_() {
  IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_ = null;
}

function importNotificationCampaignInvalidateRecordsSnapshot_() {
  if (IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_) IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_.records = null;
}

function importNotificationCampaignReadRecords_() {
  const snapshot = IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_;
  if (!snapshot || !snapshot.active) return readObjects_(APP.sheets.notifications);
  if (!snapshot.records) snapshot.records = readObjects_(APP.sheets.notifications);
  return snapshot.records;
}

function importNotificationCampaignRecipientGroups_(groups, excludedKeys) {
  const eligible = importNotificationCampaignEligibility_(groups);
  const excluded = (excludedKeys || []).reduce(function (index, key) {
    index[cleanText_(key)] = true;
    return index;
  }, {});
  const recipientGroups = {};
  importNotificationCampaignReadRecords_().forEach(function (record) {
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
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return retryImportNotificationCampaignLocked_(); }
  finally { lock.releaseLock(); }
}

function retryImportNotificationCampaignLocked_() {
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
  // The browser poll re-runs the worker while a tab is open; a missing trigger scope
  // must not throw and abort the resume the admin just requested.
  try { scheduleImportNotificationCampaign_(60000); } catch (scheduleError) {}
  return getImportNotificationCampaignStatus_(profile.key);
}

function resumeStalledImportNotificationCampaign() {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return resumeStalledImportNotificationCampaignLocked_(); }
  finally { lock.releaseLock(); }
}

function resumeStalledImportNotificationCampaignLocked_() {
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
  return continueImportNotificationCampaignLocked_(profile.key);
}

function resumePausedImportNotificationDelivery() {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return resumePausedImportNotificationDeliveryLocked_(); }
  finally { lock.releaseLock(); }
}

// Drains only the pending durable finalization for an already-delivered owner group:
// it applies the saved Notifications->SENT updates and Lifecycle_Events audit appends
// (rebasing any append whose reserved row was taken by another writer) and performs no
// Slack send, so it clears an append-conflict pause while Slack notifications are
// disabled. If other owner groups still need a real send it stops and reports that,
// rather than sending. Runs synchronously and touches no triggers, so it does not
// depend on the trigger service that can itself fail during a paused campaign.
function resumePausedImportNotificationDeliveryLocked_() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  let state = getImportNotificationCampaignState_(profile.key);
  if (!state) throw new Error('No import notification campaign is available to resume.');
  const status = cleanText_(state.status).toUpperCase();
  if (['RUNNING', 'QUEUED', 'RETRYING'].indexOf(status) !== -1) throw new Error('Slack delivery is already running.');
  if (state.phase !== 'DELIVERING') {
    throw new Error('This campaign still needs Slack drafting or sending. Enable Slack notifications and retry to continue.');
  }
  setExecutionEnvironment_(state.environment, false);
  const groups = importNotificationCampaignGroups_(state.runId, state.total);
  const batchSize = Math.max(25, Math.min(2000, configNumber_('IMPORT_NOTIFICATION_CAMPAIGN_BATCH_SIZE', 250)));
  const executionDeadline = Date.now() + Math.max(30000, Math.min(180000,
    configNumber_('IMPORT_NOTIFICATION_EXECUTION_BUDGET_MS', 150000)));
  state.status = 'RUNNING';
  setImportNotificationCampaignState_(state);
  importNotificationCampaignBeginRecordsSnapshot_();
  try {
    while (state.currentOwnerDelivery && Date.now() < executionDeadline) {
      const receipt = state.currentOwnerDelivery;
      const key = state.runId + '|' + receipt.batchId + '|' + Number(state.delivered || 0);
      let saved = readDurablePayload_('NotificationBatch', key);
      const replayed = Boolean(saved);
      if (!saved) {
        const remaining = importNotificationCampaignOwnerRecords_(groups, receipt.messageType, receipt.recipient);
        const plan = newDurableWritePlan_();
        const finalized = finalizeNotificationOwnerGroupChunk_(remaining.slice(0, batchSize), receipt, plan);
        const nextState = JSON.parse(JSON.stringify(state));
        nextState.delivered += finalized;
        if (remaining.length <= batchSize) {
          nextState.currentOwnerDelivery = null;
          nextState.ownerMessagesDelivered += 1;
        }
        saved = { writes: plan.writes, nextState: nextState };
        saveDurablePayload_('NotificationBatch', key, saved);
      }
      try {
        applyDurableWrites_(saved.writes);
      } catch (conflictError) {
        if (!/conflicting row/.test(String((conflictError && conflictError.message) || conflictError))) throw conflictError;
        saved = { writes: rebaseDurableAppendWrites_(saved.writes), nextState: saved.nextState };
        saveDurablePayload_('NotificationBatch', key, saved);
        applyDurableWrites_(saved.writes);
      }
      state = saved.nextState;
      setImportNotificationCampaignState_(state);
      // A durable-payload replay applied SENT rows without the in-place record mutation the
      // snapshot relies on; refresh it so the next owner re-derivation reflects the sheet.
      if (replayed) importNotificationCampaignInvalidateRecordsSnapshot_();
    }
  } catch (error) {
    state.status = 'PAUSED';
    state.lastError = 'Finalization resume failed: ' + String(error.message || error).substring(0, 400);
    setImportNotificationCampaignState_(state);
    throw error;
  } finally {
    importNotificationCampaignEndRecordsSnapshot_();
  }

  if (state.currentOwnerDelivery) {
    // Execution budget elapsed before the current group finished finalizing; leave it
    // paused so another resume click continues from the same saved checkpoint.
    state.status = 'PAUSED';
    state.lastError = 'Delivery finalization is partially applied. Run resume again to finish.';
    setImportNotificationCampaignState_(state);
    return getImportNotificationCampaignStatus_(state.environment);
  }

  const attemptedKeys = state.attemptedOwnerGroupKeys || [];
  const remainingOwnerGroups = importNotificationCampaignRecipientGroups_(groups, attemptedKeys);
  if (!remainingOwnerGroups.length) {
    state.status = state.failed ? 'COMPLETED_WITH_ERRORS' : 'SUCCEEDED';
    state.phase = 'COMPLETE';
    state.completedAt = nowIso_();
    state.messageType = '';
    state.lastError = '';
    setImportNotificationCampaignState_(state);
    // Campaign reached a terminal SUCCEEDED/COMPLETED_WITH_ERRORS state; a missing trigger
    // scope during cleanup must not turn completion into a failure.
    try { deleteImportNotificationCampaignTriggers_(); } catch (cleanupError) {}
  } else {
    // The wedged batch is finalized, but undelivered owner groups remain. Those require
    // an actual Slack send, which we will not perform here.
    state.status = 'PAUSED';
    state.messageType = '';
    state.lastError = 'Delivery finalization complete. ' + remainingOwnerGroups.length +
      ' owner message(s) still need sending — enable Slack notifications and retry to deliver them.';
    setImportNotificationCampaignState_(state);
  }
  return getImportNotificationCampaignStatus_(state.environment);
}

// One-time diagnostic: run this from the Apps Script editor AS THE DEPLOYING ACCOUNT to
// force the OAuth consent screen for the script.scriptapp (trigger) scope. It only reads
// the project trigger list — it creates nothing and changes no data. A clean numeric
// return means the scope is now granted for the account that runs the web app.
function grantTriggerScope() {
  const triggers = ScriptApp.getProjectTriggers();
  return { grantedFor: Session.getEffectiveUser().getEmail(), existingTriggers: triggers.length };
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
  const caseUpdates = readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', Object.keys(targets)).filter(function (caseRecord) {
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

function cancelImportPlatformActions_(activeRecoveryAssetIds, dismissedAssetIds, plan) {
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
  if (plan) planUpdateObjects_(plan, APP.sheets.platformActions, 'ACTION_ID', updates);
  else updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
  return result;
}

function queueImportOrphanQuarantineActions_(assetIds, runId) {
  const saved = readDurablePayload_('OrphanHandoffs', runId);
  if (saved) { applyDurableWrites_(saved.writes); return saved.prepared; }
  const ids = Array.from(new Set((assetIds || []).map(cleanText_).filter(Boolean)));
  if (!ids.length) return 0;
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', ids), 'ASSET_ID');
  const cases = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'ASSET_ID', ids), 'ASSET_ID');
  Object.keys(cases).forEach(function (assetId) {
    cases[assetId].STATE = canonicalLifecycleState_(cases[assetId].STATE);
  });
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
  const plan = newDurableWritePlan_();
  planAppendObjects_(plan, APP.sheets.platformActions, additions);
  planAppendRows_(plan, APP.sheets.events, events);
  const payload = { writes: plan.writes, prepared: prepared };
  saveDurablePayload_('OrphanHandoffs', runId, payload);
  applyDurableWrites_(payload.writes);
  return prepared;
}

function lifecycleEventAssetGroupsForRun_(runId) {
  const groups = {};
  const seen = {};
  forEachMatchingSheetRows_(APP.sheets.events, 'RUN_ID', runId, ['EVENT_TYPE', 'ASSET_ID'], function (event) {
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
  const targetType = cleanText_(eventType).toUpperCase();
  const assetIds = [];
  forEachMatchingSheetRows_(APP.sheets.events, 'RUN_ID', runId, ['EVENT_TYPE', 'ASSET_ID'], function (event) {
    if (cleanText_(event.EVENT_TYPE).toUpperCase() !== targetType) return;
    const assetId = cleanText_(event.ASSET_ID);
    if (!assetId || seen[assetId]) return;
    seen[assetId] = true;
    assetIds.push(assetId);
  });
  return assetIds;
}

function completeQuarantineActionsFromImport_(assetIds, completedAt, runId, plan) {
  const targets = {};
  (assetIds || []).forEach(function (assetId) { targets[assetId] = true; });
  if (!Object.keys(targets).length) return 0;
  const updates = objectsWithPlannedWrites_(readObjects_(APP.sheets.platformActions), plan, APP.sheets.platformActions, 'ACTION_ID').filter(function (action) {
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
  if (plan) planUpdateObjects_(plan, APP.sheets.platformActions, 'ACTION_ID', updates);
  else updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
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
  const key = runId + '|' + cursorRow;
  const saved = readDurablePayload_('ApprovalBatch', key);
  if (saved) return applyApprovalBatch_(saved);
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
  const plan = newDurableWritePlan_();
  planUpdateObjects_(plan, APP.sheets.cases, 'CASE_ID', updates);
  updateImportedCandidateAssetStates_(updates, plan);
  planAppendRows_(plan, APP.sheets.events, events);
  const nextRow = startRow + count;
  const payload = { writes: plan.writes, notificationAssetIds: notificationAssetIds, orphanAssetIds: orphanAssetIds,
    result: { nextRow: nextRow, done: nextRow > lastRow, approvedAssets: notificationAssetIds.length, orphanAssets: orphanAssetIds.length } };
  saveDurablePayload_('ApprovalBatch', key, payload);
  return applyApprovalBatch_(payload);
}

function applyApprovalBatch_(payload) {
  applyDurableWrites_(payload.writes);
  let notificationDrafts = 0;
  if (payload.notificationAssetIds.length) notificationDrafts += createNotificationDraftBatch_(payload.notificationAssetIds, 'STALE_ASSET_NOTICE').records.length;
  if (payload.orphanAssetIds.length) notificationDrafts += createNotificationDraftBatch_(payload.orphanAssetIds, 'ORPHAN_QUARANTINE_NOTICE').records.length;
  SpreadsheetApp.flush();
  return Object.assign({}, payload.result, { notificationDrafts: notificationDrafts });
}

function updateImportedCandidateAssetStates_(caseRecords, plan) {
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
  if (plan) { planUpdateObjects_(plan, APP.sheets.assetsCurrent, 'ASSET_ID', updates); return updates.length; }
  return updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', updates);
}

function carryForwardAndReconcileChunk_(state, cursorRow, batchSize) {
  const key = state.runId + '|' + cursorRow;
  const saved = readDurablePayload_('ReconciliationBatch', key);
  if (saved) { applyDurableWrites_(saved.writes); return saved.result; }
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
  // Most Cases rows still have an Assets_Current row. Only presence matters for those, so
  // answer it from the key index and fetch full rows (Assets_Staging, Platform_Actions) only
  // for the few assets the loop below can actually carry forward or purge.
  const current = existingSheetKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', assetIds);
  const skippedStates = [APP.lifecycle.dismissed, APP.lifecycle.active, APP.lifecycle.restored];
  const missing = cases.filter(function (caseRecord) {
    const assetId = cleanText_(caseRecord.ASSET_ID);
    return assetId && !current[assetId] && skippedStates.indexOf(canonicalLifecycleState_(caseRecord.STATE)) === -1;
  });
  const missingIds = missing.map(function (caseRecord) { return cleanText_(caseRecord.ASSET_ID); });
  const purgeCandidateIds = missing.filter(function (caseRecord) {
    return [APP.lifecycle.quarantined, APP.lifecycle.purgeEligible].indexOf(canonicalLifecycleState_(caseRecord.STATE)) !== -1;
  }).map(function (caseRecord) { return cleanText_(caseRecord.ASSET_ID); });
  const previous = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsStaging, 'ASSET_ID', missingIds), 'ASSET_ID');
  const completedPurge = {};
  readObjectsByKeys_(APP.sheets.platformActions, 'ASSET_ID', purgeCandidateIds).forEach(function (action) {
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
  const plan = newDurableWritePlan_();
  planAppendObjects_(plan, APP.sheets.assetsCurrent, carry);
  planUpdateObjects_(plan, APP.sheets.cases, 'CASE_ID', caseUpdates);
  planAppendRows_(plan, APP.sheets.events, events);
  const nextRow = startRow + count;
  const payload = { writes: plan.writes, result: {
    nextRow: nextRow, done: nextRow > lastRow, carriedForward: carry.length,
    purgedAssets: purgedAssets, selfPurgedAssets: selfPurgedAssets
  } };
  saveDurablePayload_('ReconciliationBatch', key, payload);
  applyDurableWrites_(payload.writes);
  return payload.result;
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
  replaceWorkflowTrigger_('continueSnowflakeImport', Math.max(10000, Number(delayMs || 10000)));
}

function deleteImportContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueSnowflakeImport') ScriptApp.deleteTrigger(trigger);
  });
}

function cancelSnowflakeImport() {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return cancelSnowflakeImportLocked_(); }
  finally { lock.releaseLock(); }
}

function cancelSnowflakeImportLocked_() {
  assertAdmin_();
  assertEnvironmentWritable_();
  const state = getImportState_();
  try { deleteImportContinuationTriggers_(); } catch (cleanupError) {}
  if (state) updateJobRun_(state.runId, { STATUS: 'CANCELLED', COMPLETED_AT: nowIso_(), MESSAGE: 'Cancelled by user.' });
  clearImportState_(getActiveEnvironment_());
  return getImportStatus();
}

function resumeSnowflakeImport() {
  assertAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return resumeSnowflakeImportLocked_(); }
  finally { lock.releaseLock(); }
}

function resumeSnowflakeImportLocked_() {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  reclaimOperationalGridCapacity_();
  let state = getImportState_(profile.key);
  if (!state) state = recoverFailedFinalizationState_(profile.key);
  state.message = 'A recovery continuation was requested; resuming from the latest saved checkpoint';
  state.recoveryRequestedAt = nowIso_();
  state.retryCount = 0;
  state.retryAfter = 0;
  state.progressStage = state.phase === 'IMPORT' ? 'QUEUED_FOR_NEXT_SOURCE_BATCH' : 'RECONCILING_LIFECYCLE';
  state.lastError = '';
  setImportState_(state);
  updateJobRun_(state.runId, {
    STATUS: 'RUNNING', COMPLETED_AT: '', ERROR_COUNT: Number(state.errors || 0), MESSAGE: state.message
  });
  // State is already cleared of the pause above, so the browser status poll can drive
  // continuation even if the trigger cannot be scheduled. Never let a missing scope make
  // the resume itself throw and leave the job looking stuck.
  try { scheduleImportContinuation_(10000); } catch (scheduleError) {}
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
