function getIntegrationStatus() {
  const properties = PropertiesService.getScriptProperties();
  const profile = getEnvironmentProfile_();
  const snowflakeEnabled = platformHandoffEnabled_('SNOWFLAKE');
  const data360Enabled = platformHandoffEnabled_('DATA360');
  return {
    slack: {
      enabled: configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false),
      configured: Boolean(properties.getProperty(APP.slackWorkflowProperty)),
      blocked: profile.readOnly
    },
    snowflakeActions: {
      enabled: snowflakeEnabled,
      configured: Boolean(properties.getProperty(APP.snowflakeActionEndpointProperty)),
      blocked: profile.readOnly || !snowflakeEnabled
    },
    data360Actions: {
      enabled: data360Enabled,
      configured: Boolean(properties.getProperty(APP.data360ActionEndpointProperty)),
      blocked: profile.readOnly || !data360Enabled
    },
    purgeSafetyGate: {
      enabled: configBoolean_('PURGE_ACTIONS_ENABLED', false),
      configured: true,
      blocked: profile.readOnly || !configBoolean_('PURGE_ACTIONS_ENABLED', false),
      reason: configBoolean_('PURGE_ACTIONS_ENABLED', false) ? 'Enabled after partner control approval.' : 'Independent purge dispatch gate is off; eligible work items remain READY.'
    },
    environment: profile.key,
    recipientLock: profile.recipientLock,
    recipientAllowlist: profile.recipientAllowlist
  };
}

function setPlatformHandoffEnabled(input) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const platform = cleanText_((input || {}).platform).toUpperCase();
  if (['SNOWFLAKE', 'DATA360'].indexOf(platform) === -1) throw new Error('Unknown platform handoff.');
  const enabled = Boolean((input || {}).enabled);
  const propertyKey = platform === 'DATA360' ? APP.data360ActionEndpointProperty : APP.snowflakeActionEndpointProperty;
  if (enabled && !PropertiesService.getScriptProperties().getProperty(propertyKey)) {
    throw new Error('Configure the ' + (platform === 'DATA360' ? 'Data 360' : 'Snowflake') + ' HTTPS endpoint in Settings before enabling this handoff.');
  }
  updateEnvironmentConfigValue_(platform === 'DATA360' ? 'DATA360_ACTIONS_ENABLED' : 'SNOWFLAKE_ACTIONS_ENABLED', enabled, profile.key);
  return getIntegrationStatus();
}

function saveIntegrationSettings(settings) {
  assertAdmin_();
  assertEnvironmentWritable_();
  const input = settings || {};
  const properties = PropertiesService.getScriptProperties();
  if (cleanText_(input.slackWorkflowWebhook)) {
    assertHttpsUrl_(input.slackWorkflowWebhook, 'Slack workflow webhook');
    properties.setProperty(APP.slackWorkflowProperty, cleanText_(input.slackWorkflowWebhook));
  }
  if (cleanText_(input.slackWebhook)) {
    assertHttpsUrl_(input.slackWebhook, 'Slack webhook');
    properties.setProperty(APP.slackWebhookProperty, cleanText_(input.slackWebhook));
  }
  if (cleanText_(input.snowflakeActionEndpoint)) {
    assertHttpsUrl_(input.snowflakeActionEndpoint, 'Snowflake endpoint');
    properties.setProperty(APP.snowflakeActionEndpointProperty, cleanText_(input.snowflakeActionEndpoint));
  }
  if (cleanText_(input.data360ActionEndpoint)) {
    assertHttpsUrl_(input.data360ActionEndpoint, 'Data 360 endpoint');
    properties.setProperty(APP.data360ActionEndpointProperty, cleanText_(input.data360ActionEndpoint));
  }
  return getIntegrationStatus();
}

function getAdminSettings() {
  assertAdmin_();
  return {
    environment: getActiveEnvironment_(),
    readOnly: getEnvironmentProfile_().readOnly,
    configuration: getAdminConfiguration_(),
    integrations: getIntegrationStatus(),
    admins: listAdmins_()
  };
}

function getAdminConfiguration_() {
  const config = getConfig_();
  const profile = getEnvironmentProfile_();
  return {
    staleThresholdDays: configNumber_('STALE_THRESHOLD_DAYS', 180),
    contestWindowDays: configNumber_('CONTEST_WINDOW_DAYS', 9),
    quarantineDays: configNumber_('QUARANTINE_DAYS', 181),
    purgeNoticeDays: configNumber_('PURGE_NOTICE_DAYS', 30),
    includeViews: configBoolean_('INCLUDE_VIEWS', true),
    importEnabled: profile.importEnabled,
    slackEnabled: configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false),
    purgeActionsEnabled: configBoolean_('PURGE_ACTIONS_ENABLED', false),
    recipientLock: profile.recipientLock,
    allowedRecipients: profile.recipientAllowlist.join(', '),
    exceptionAppUrl: cleanText_(config.EXCEPTION_APP_URL),
    exceptionDatabaseSpreadsheetId: cleanText_(config.EXCEPTION_DATABASE_SPREADSHEET_ID),
    exceptionDatabaseSheetName: cleanText_(config.EXCEPTION_DATABASE_SHEET_NAME) || 'Exception Log'
  };
}

function saveAdminConfiguration(settings) {
  assertAdmin_();
  const profile = assertEnvironmentWritable_();
  const input = settings || {};
  const numeric = [
    ['STALE_THRESHOLD_DAYS', input.staleThresholdDays, 1, 3650],
    ['CONTEST_WINDOW_DAYS', input.contestWindowDays, 1, 365],
    ['QUARANTINE_DAYS', input.quarantineDays, 1, 3650],
    ['PURGE_NOTICE_DAYS', input.purgeNoticeDays, 0, 365]
  ];
  numeric.forEach(function (item) {
    const value = Number(item[1]);
    if (!Number.isInteger(value) || value < item[2] || value > item[3]) throw new Error(item[0] + ' is outside the allowed range.');
    updateEnvironmentConfigValue_(item[0], value, profile.key);
  });
  const recipientLock = cleanText_(input.recipientLock).toLowerCase();
  const allowedRecipients = cleanText_(input.allowedRecipients).split(',').map(function (value) {
    return cleanText_(value).toLowerCase();
  }).filter(Boolean);
  if (recipientLock) assertEmailAddress_(recipientLock);
  allowedRecipients.forEach(assertEmailAddress_);
  const exceptionAppUrl = cleanText_(input.exceptionAppUrl);
  if (exceptionAppUrl) assertHttpsUrl_(exceptionAppUrl, 'Exception application URL');
  const exceptionDatabaseSpreadsheetId = normalizeSpreadsheetId_(input.exceptionDatabaseSpreadsheetId);
  const exceptionDatabaseSheetName = cleanText_(input.exceptionDatabaseSheetName) || 'Exception Log';
  if (exceptionDatabaseSpreadsheetId) {
    validateExceptionDatabaseConfiguration_(exceptionDatabaseSpreadsheetId, exceptionDatabaseSheetName);
  }
  updateEnvironmentConfigValue_('INCLUDE_VIEWS', Boolean(input.includeViews), profile.key);
  updateEnvironmentConfigValue_('IMPORT_ENABLED', Boolean(input.importEnabled), profile.key);
  updateEnvironmentConfigValue_('SLACK_NOTIFICATIONS_ENABLED', Boolean(input.slackEnabled), profile.key);
  updateEnvironmentConfigValue_('PURGE_ACTIONS_ENABLED', Boolean(input.purgeActionsEnabled), profile.key);
  updateEnvironmentConfigValue_('PRIMARY_RECIPIENT_LOCK', recipientLock, profile.key);
  updateEnvironmentConfigValue_('ALLOWED_RECIPIENTS', allowedRecipients.join(','), profile.key);
  updateEnvironmentConfigValue_('EXCEPTION_APP_URL', exceptionAppUrl, profile.key);
  updateEnvironmentConfigValue_('EXCEPTION_DATABASE_SPREADSHEET_ID', exceptionDatabaseSpreadsheetId, profile.key);
  updateEnvironmentConfigValue_('EXCEPTION_DATABASE_SHEET_NAME', exceptionDatabaseSheetName, profile.key);
  return getAdminSettings();
}

function addAdminByEmail(email) {
  assertAdmin_();
  const target = cleanText_(email).toLowerCase();
  assertEmailAddress_(target);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getFoundationSpreadsheet_().getSheetByName(APP.sheets.admins);
    if (!sheet) throw new Error('Missing required ADMINS sheet.');
    const width = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (value) {
      return cleanText_(value).toUpperCase();
    });
    const emailIndex = headers.indexOf('EMAILS');
    if (emailIndex === -1) throw new Error('ADMINS must contain an EMAILS column.');
    const existing = listAdmins_();
    if (existing.indexOf(target) === -1) {
      const row = new Array(width).fill('');
      row[emailIndex] = target;
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, width).setValues([row]);
    }
    CacheService.getScriptCache().remove('ADMIN_EMAIL_' + target);
    return { admins: listAdmins_() };
  } finally {
    lock.releaseLock();
  }
}

function listAdmins_() {
  const sheet = getFoundationSpreadsheet_().getSheetByName(APP.sheets.admins);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (value) {
    return cleanText_(value).toUpperCase();
  });
  const emailIndex = headers.indexOf('EMAILS');
  if (emailIndex === -1) return [];
  return Array.from(new Set(sheet.getRange(2, emailIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().map(function (row) {
    return cleanText_(row[0]).toLowerCase();
  }).filter(Boolean))).sort();
}

function assertEmailAddress_(email) {
  const value = cleanText_(email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address.');
  return value;
}

function clearIntegrationSecret(secretName) {
  assertAdmin_();
  assertEnvironmentWritable_();
  const allowed = {
    slackWorkflowWebhook: APP.slackWorkflowProperty,
    slackWebhook: APP.slackWebhookProperty,
    snowflakeActionEndpoint: APP.snowflakeActionEndpointProperty,
    data360ActionEndpoint: APP.data360ActionEndpointProperty
  };
  if (!allowed[secretName]) throw new Error('Unknown integration secret.');
  PropertiesService.getScriptProperties().deleteProperty(allowed[secretName]);
  return getIntegrationStatus();
}

function assertHttpsUrl_(value, label) {
  if (cleanText_(value).indexOf('https://') !== 0) throw new Error(label + ' must use HTTPS.');
}

function installDailyImportTrigger() {
  throw new Error('Scheduled imports are disabled because every weekly extract requires explicit EDG intake review and approval.');
}

function scheduledSnowflakeImport() {
  return { skipped: true, reason: 'Explicit EDG intake approval is required.' };
}

/**
 * Clears operational UAT records from DEV while preserving headers, shared
 * configuration, administrators, user roles, integration secrets, and PRD.
 * This function is intentionally not exposed in the application UI.
 */
function resetDevUatData() {
  const actor = assertAdmin_();
  const environment = setExecutionEnvironment_('DEV', false);
  if (environment !== 'DEV') throw new Error('DEV reset refused outside the DEV environment.');

  const operationalSheets = [
    APP.sheets.assetsCurrent,
    APP.sheets.assetsStaging,
    APP.sheets.assetsIndex,
    APP.sheets.intakeUpload,
    APP.sheets.snapshots,
    APP.sheets.cases,
    APP.sheets.events,
    APP.sheets.notifications,
    APP.sheets.exceptions,
    APP.sheets.platformActions,
    APP.sheets.jobs,
    APP.sheets.dashboardSummary
  ];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const cleared = operationalSheets.map(function (sheetName) {
      const resolvedName = resolveSheetName_(sheetName, 'DEV');
      const rows = readObjects_(sheetName).length;
      clearDataRows_(sheetName);
      return { sheet: resolvedName, clearedRows: rows };
    });
    clearImportState_('DEV');
    clearPendingIntakeReview_('DEV');
    const result = {
      environment: environment,
      resetAt: nowIso_(),
      resetBy: actor.email,
      cleared: cleared,
      remainingRows: inspectDevUatData_()
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function verifyDevUatDataReset() {
  assertAdmin_();
  setExecutionEnvironment_('DEV', false);
  const remainingRows = inspectDevUatData_();
  const nonEmpty = remainingRows.filter(function (item) { return item.rows !== 0; });
  const result = { environment: 'DEV', blank: nonEmpty.length === 0, sheets: remainingRows };
  console.log(JSON.stringify(result));
  return result;
}

function inspectDevUatData_() {
  return [
    APP.sheets.assetsCurrent,
    APP.sheets.assetsStaging,
    APP.sheets.assetsIndex,
    APP.sheets.intakeUpload,
    APP.sheets.snapshots,
    APP.sheets.cases,
    APP.sheets.events,
    APP.sheets.notifications,
    APP.sheets.exceptions,
    APP.sheets.platformActions,
    APP.sheets.jobs,
    APP.sheets.dashboardSummary
  ].map(function (sheetName) {
    return { sheet: resolveSheetName_(sheetName, 'DEV'), rows: readObjects_(sheetName).length };
  });
}

function getAdminOperations() {
  assertAdmin_();
  const actions = readObjects_(APP.sheets.platformActions);
  const assets = indexObjectsBy_(readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const now = new Date();
  const existingPurgeCases = {};
  actions.forEach(function (action) {
    const actionType = cleanText_(action.ACTION).toUpperCase();
    const actionStatus = cleanText_(action.STATUS).toUpperCase();
    if ((actionType === 'PURGE' && actionStatus !== 'CANCELLED') || (actionType === 'RESTORE' && actionStatus !== 'CANCELLED')) existingPurgeCases[action.CASE_ID] = true;
  });
  const eligiblePurgeAssets = readObjects_(APP.sheets.cases).filter(function (caseRecord) {
    return canonicalLifecycleState_(caseRecord.STATE) === APP.lifecycle.purgeEligible &&
      caseRecord.PURGE_ELIGIBLE_DATE && new Date(caseRecord.PURGE_ELIGIBLE_DATE) <= now &&
      !existingPurgeCases[caseRecord.CASE_ID];
  });
  const counts = {};
  const readyActions = actions.filter(function (action) {
    return cleanText_(action.STATUS).toUpperCase() === 'READY';
  });
  const purgeHolds = actions.filter(function (action) {
    return cleanText_(action.ACTION).toUpperCase() === 'PURGE' && cleanText_(action.STATUS).toUpperCase() === 'ON_HOLD';
  });
  readyActions.forEach(function (action) {
    incrementCount_(counts, cleanText_(action.ACTION).toUpperCase() + '_' + cleanText_(action.STATUS).toUpperCase());
  });
  return {
    environment: getActiveEnvironment_(),
    integrations: getIntegrationStatus(),
    counts: countMapToArray_(counts),
    eligiblePurgeCount: eligiblePurgeAssets.length,
    eligiblePurgeAssets: eligiblePurgeAssets.map(function (caseRecord) {
      const asset = assets[caseRecord.ASSET_ID] || {};
      return {
        assetId: caseRecord.ASSET_ID,
        platform: asset.PLATFORM || caseRecord.PLATFORM || 'SNOWFLAKE',
        objectFqn: asset.OBJECT_FQN || caseRecord.ASSET_ID,
        domain: asset.DOMAIN || 'Unassigned',
        assetStatus: deriveAssetStatus_(asset),
        lifecycleState: canonicalLifecycleState_(caseRecord.STATE),
        purgeEligibleDate: caseRecord.PURGE_ELIGIBLE_DATE
      };
    }),
    purgeHolds: purgeHolds.slice().reverse().map(function (action) {
      const asset = assets[action.ASSET_ID] || {};
      return {
        actionId: action.ACTION_ID,
        platform: action.PLATFORM,
        objectFqn: asset.OBJECT_FQN || action.ASSET_ID,
        assetStatus: deriveAssetStatus_(asset),
        lifecycleState: canonicalLifecycleState_(asset.LIFECYCLE_STATE),
        heldAt: action.REQUESTED_AT,
        heldBy: action.PARTNER_REFERENCE
      };
    }),
    actions: readyActions.slice().reverse().slice(0, 200).map(function (action) {
      const asset = assets[action.ASSET_ID] || {};
      return {
        actionId: action.ACTION_ID,
        platform: action.PLATFORM,
        action: action.ACTION,
        status: action.STATUS,
        objectFqn: asset.OBJECT_FQN || action.ASSET_ID,
        assetStatus: deriveAssetStatus_(asset),
        lifecycleState: canonicalLifecycleState_(asset.LIFECYCLE_STATE),
        requestedAt: action.REQUESTED_AT,
        completedAt: action.COMPLETED_AT,
        partnerReference: action.PARTNER_REFERENCE,
        error: action.ERROR
      };
    })
  };
}

function preparePlatformExport(actionName) {
  assertAdmin_();
  assertEnvironmentWritable_();
  const actionType = cleanText_(actionName).toUpperCase();
  if (['QUARANTINE', 'RESTORE', 'PURGE'].indexOf(actionType) === -1) throw new Error('Only quarantine, restoration, and purge exports are supported.');
  const assets = indexObjectsBy_(readObjects_(APP.sheets.assetsCurrent), 'ASSET_ID');
  const cases = indexObjectsBy_(readObjects_(APP.sheets.cases), 'CASE_ID');
  const ready = readObjects_(APP.sheets.platformActions).filter(function (action) {
    return cleanText_(action.ACTION).toUpperCase() === actionType && cleanText_(action.STATUS).toUpperCase() === 'READY';
  });
  const headers = [
    'ACTION_ID', 'ACTION', 'PLATFORM', 'ASSET_ID', 'OBJECT_FQN', 'CASE_ID',
    'ASSET_STATUS', 'LIFECYCLE_STATE', 'REQUESTED_AT', 'DESIRED_SNOWFLAKE_STATUS'
  ];
  const rows = ready.map(function (action) {
    const asset = assets[action.ASSET_ID] || {};
    const caseRecord = cases[action.CASE_ID] || {};
    return [
      action.ACTION_ID, actionType, action.PLATFORM, action.ASSET_ID,
      asset.OBJECT_FQN || '', action.CASE_ID, deriveAssetStatus_(asset),
      canonicalLifecycleState_(caseRecord.STATE || asset.LIFECYCLE_STATE), action.REQUESTED_AT,
      actionType === 'QUARANTINE' ? 'RESTRICTED' : actionType === 'RESTORE' ? 'ACTIVE' : 'NOT_PRESENT'
    ];
  });
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyyMMdd-HHmm');
  return {
    fileName: getActiveEnvironment_() + '_' + actionType + '_HANDOFF_' + date + '.csv',
    headers: headers,
    rows: rows,
    actionIds: ready.map(function (action) { return action.ACTION_ID; })
  };
}

function markPlatformActionsExported(input) {
  const actor = assertAdmin_();
  assertEnvironmentWritable_();
  const actionIds = Array.from(new Set(((input || {}).actionIds || []).map(cleanText_).filter(Boolean)));
  if (!actionIds.length) return getAdminOperations();
  const targets = {};
  actionIds.forEach(function (actionId) { targets[actionId] = true; });
  const updates = readObjects_(APP.sheets.platformActions).filter(function (action) {
    return targets[action.ACTION_ID] && cleanText_(action.STATUS).toUpperCase() === 'READY';
  }).map(function (action) {
    action.STATUS = 'EXPORTED';
    action.ACCEPTED_AT = nowIso_();
    action.PARTNER_REFERENCE = action.PARTNER_REFERENCE || 'MANUAL_EXPORT';
    logEvent_(action.CASE_ID, action.ASSET_ID, 'PLATFORM_ACTION_PENDING_PLATFORM_HANDOFF', '', '', '', {
      actionId: action.ACTION_ID, action: action.ACTION, actor: actor.email
    });
    return action;
  });
  updateObjectsByKey_(APP.sheets.platformActions, 'ACTION_ID', updates);
  return getAdminOperations();
}
