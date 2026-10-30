function getIntegrationStatus() {
  const properties = PropertiesService.getScriptProperties();
  const profile = getEnvironmentProfile_();
  const config = getConfig_();
  const slackWebhookConfigured = Boolean(properties.getProperty(APP.slackWorkflowProperty));
  const slackChannelConfigured = isSlackChannelId_(config.EDG_CONTACT);
  const snowflakeEnabled = platformHandoffEnabled_('SNOWFLAKE');
  const data360Enabled = platformHandoffEnabled_('DATA360');
  return {
    slack: {
      enabled: configBoolean_('SLACK_NOTIFICATIONS_ENABLED', false),
      configured: slackWebhookConfigured && slackChannelConfigured,
      blocked: profile.readOnly,
      reason: !slackWebhookConfigured
        ? 'The Slack workflow webhook is not configured.'
        : !slackChannelConfigured
          ? 'Add an environment-specific EDG Slack channel ID before enabling delivery.'
          : 'The workflow webhook and EDG Slack channel are configured.'
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
    lifecycleAutomationEnabled: configBoolean_('LIFECYCLE_AUTOMATION_ENABLED', true),
    purgeActionsEnabled: configBoolean_('PURGE_ACTIONS_ENABLED', false),
    recipientLock: profile.recipientLock,
    allowedRecipients: profile.recipientAllowlist.join(', '),
    edgContact: cleanText_(config.EDG_CONTACT),
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
  const edgContact = cleanText_(input.edgContact).toUpperCase();
  if (edgContact && !isSlackChannelId_(edgContact)) {
    throw new Error('EDG Slack channel ID must begin with C or G and contain only letters and numbers.');
  }
  if (Boolean(input.slackEnabled)) {
    if (!edgContact) throw new Error('Add the EDG Slack channel ID before enabling Slack delivery.');
    if (!PropertiesService.getScriptProperties().getProperty(APP.slackWorkflowProperty)) {
      throw new Error('Configure the Slack workflow webhook before enabling Slack delivery.');
    }
  }
  const exceptionDatabaseSpreadsheetId = normalizeSpreadsheetId_(input.exceptionDatabaseSpreadsheetId);
  const exceptionDatabaseSheetName = cleanText_(input.exceptionDatabaseSheetName) || 'Exception Log';
  if (exceptionDatabaseSpreadsheetId) {
    validateExceptionDatabaseConfiguration_(exceptionDatabaseSpreadsheetId, exceptionDatabaseSheetName);
  }
  updateEnvironmentConfigValue_('INCLUDE_VIEWS', Boolean(input.includeViews), profile.key);
  updateEnvironmentConfigValue_('IMPORT_ENABLED', Boolean(input.importEnabled), profile.key);
  updateEnvironmentConfigValue_('SLACK_NOTIFICATIONS_ENABLED', Boolean(input.slackEnabled), profile.key);
  // Only overwrite the automation switch when the caller actually supplied it, so an
  // older client payload that omits the field cannot silently pause automation.
  if (input.lifecycleAutomationEnabled !== undefined) {
    updateEnvironmentConfigValue_('LIFECYCLE_AUTOMATION_ENABLED', Boolean(input.lifecycleAutomationEnabled), profile.key);
  }
  updateEnvironmentConfigValue_('PURGE_ACTIONS_ENABLED', Boolean(input.purgeActionsEnabled), profile.key);
  updateEnvironmentConfigValue_('PRIMARY_RECIPIENT_LOCK', recipientLock, profile.key);
  updateEnvironmentConfigValue_('ALLOWED_RECIPIENTS', allowedRecipients.join(','), profile.key);
  updateEnvironmentConfigValue_('EDG_CONTACT', edgContact, profile.key);
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
    deleteIntakeReviewPreparationTriggers_();
    clearIntakeReviewCache_('DEV');
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

/**
 * Clears PRD operational and staged records while preserving headers,
 * configuration, administrators, user roles, and integration secrets.
 * This maintenance function is intentionally not exposed in the application UI.
 */
function resetProductionOperationalData() {
  const actor = assertAdmin_();
  const environment = setExecutionEnvironment_('PRD', false);
  if (environment !== 'PRD') throw new Error('Production reset refused outside PRD.');
  const profile = getEnvironmentProfile_();
  if (profile.readOnly) throw new Error('Production reset requires PRD writes to be enabled.');
  const operationalSheets = productionOperationalSheetNames_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    deleteImportContinuationTriggers_();
    deleteIntakeReviewPreparationTriggers_();
    deleteImportNotificationCampaignTriggers_();
    const cleared = operationalSheets.map(function (sheetName) {
      const rows = readObjects_(sheetName).length;
      clearDataRows_(sheetName);
      return { sheet: resolveSheetName_(sheetName, 'PRD'), clearedRows: rows };
    });
    clearImportState_('PRD');
    clearPendingIntakeReview_('PRD');
    clearIntakeReviewCache_('PRD');
    PropertiesService.getScriptProperties().deleteProperty(importNotificationCampaignProperty_('PRD'));
    const result = {
      environment: environment,
      resetAt: nowIso_(),
      resetBy: actor.email,
      cleared: cleared,
      remainingRows: inspectProductionOperationalData_()
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function verifyProductionOperationalDataReset() {
  assertAdmin_();
  setExecutionEnvironment_('PRD', false);
  const remainingRows = inspectProductionOperationalData_();
  return {
    environment: 'PRD',
    blank: remainingRows.every(function (item) { return item.rows === 0; }),
    sheets: remainingRows
  };
}

function productionOperationalSheetNames_() {
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
  ];
}

function inspectProductionOperationalData_() {
  return productionOperationalSheetNames_().map(function (sheetName) {
    return { sheet: resolveSheetName_(sheetName, 'PRD'), rows: readObjects_(sheetName).length };
  });
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

/**
 * One-time backfill: for every Assets_Current row whose SCHEMA_OWNER_DOMAIN
 * and/or SCHEMA_OWNER_SUBDOMAIN is blank, look up DATABASE_NAME+SCHEMA_NAME
 * against the Schema Master List and fill in whichever of the two fields are
 * currently empty. Never overwrites a field that already has a value. This
 * maintenance function is intentionally not exposed in the application UI —
 * trigger it once (e.g. via the Apps Script editor) after deploying the
 * SCHEMA_OWNER_DOMAIN/SCHEMA_OWNER_SUBDOMAIN columns.
 */
function backfillSchemaOwnerDomains() {
  const actor = assertAdmin_();
  const profile = assertEnvironmentWritable_();
  // ensureDataModelV2_ only runs lazily (import start / lifecycle transitions),
  // so a sheet that has not gone through either since SCHEMA_OWNER_DOMAIN and
  // SCHEMA_OWNER_SUBDOMAIN were added to ASSET_HEADERS may still be missing
  // those columns on its header row. Add them here so the writes below land.
  ensureDataModelV2_();
  const assets = readObjects_(APP.sheets.assetsCurrent);
  const lookup = loadSchemaOwnerLookup_();
  let scanned = 0;
  let updated = 0;
  let noMatch = 0;
  const toUpdate = [];
  assets.forEach(function (asset) {
    if (!asset.ASSET_ID) return;
    scanned += 1;
    const domainMissing = !cleanText_(asset.SCHEMA_OWNER_DOMAIN);
    const subDomainMissing = !cleanText_(asset.SCHEMA_OWNER_SUBDOMAIN);
    if (!domainMissing && !subDomainMissing) return;
    const key = normalizeDatabaseSchemaKey_(asset.DATABASE_NAME, asset.SCHEMA_NAME);
    const owner = key && lookup.owners ? lookup.owners[key] : null;
    if (!owner) {
      noMatch += 1;
      return;
    }
    if (domainMissing) asset.SCHEMA_OWNER_DOMAIN = owner.domain || '';
    if (subDomainMissing) asset.SCHEMA_OWNER_SUBDOMAIN = owner.subDomain || '';
    toUpdate.push(asset);
    updated += 1;
  });
  if (toUpdate.length) updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', toUpdate);
  const result = {
    environment: profile.key,
    ranAt: nowIso_(),
    ranBy: actor.email,
    scanned: scanned,
    updated: updated,
    noMatch: noMatch
  };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * One-time full resync: for every Assets_Current row with a DATABASE_NAME+
 * SCHEMA_NAME match in the Schema Master List reference sheet, overwrite
 * SCHEMA_OWNER, SCHEMA_OWNER_NAME, SCHEMA_OWNER_USERNAME,
 * SCHEMA_OWNER_ASSIGNMENT_STATUS, SCHEMA_OWNER_DOMAIN and
 * SCHEMA_OWNER_SUBDOMAIN with the reference sheet's current values —
 * unlike backfillSchemaOwnerDomains above, this replaces existing values
 * too (the reference sheet is treated as the source of truth). Rows with
 * no match in the reference sheet are left untouched. This maintenance
 * function is intentionally not exposed in the application UI — trigger it
 * once (e.g. via the Apps Script editor) to resync all schema-owner fields
 * from the latest reference sheet contents.
 */
function resyncSchemaOwnersFromReference() {
  const actor = assertAdmin_();
  const profile = assertEnvironmentWritable_();
  // ensureDataModelV2_ only runs lazily (import start / lifecycle transitions),
  // so a sheet that has not gone through either since SCHEMA_OWNER_DOMAIN and
  // SCHEMA_OWNER_SUBDOMAIN were added to ASSET_HEADERS may still be missing
  // those columns on its header row. Add them here so the writes below land.
  ensureDataModelV2_();
  const assets = readObjects_(APP.sheets.assetsCurrent);
  const lookup = loadSchemaOwnerLookup_();
  let scanned = 0;
  let updated = 0;
  let noMatch = 0;
  const toUpdate = [];
  assets.forEach(function (asset) {
    if (!asset.ASSET_ID) return;
    scanned += 1;
    const key = normalizeDatabaseSchemaKey_(asset.DATABASE_NAME, asset.SCHEMA_NAME);
    const owner = key && lookup.owners ? lookup.owners[key] : null;
    if (!owner) {
      noMatch += 1;
      return;
    }
    asset.SCHEMA_OWNER = owner.email || '';
    asset.SCHEMA_OWNER_NAME = owner.name || '';
    asset.SCHEMA_OWNER_USERNAME = owner.username || '';
    asset.SCHEMA_OWNER_ASSIGNMENT_STATUS = owner.status || '';
    asset.SCHEMA_OWNER_DOMAIN = owner.domain || '';
    asset.SCHEMA_OWNER_SUBDOMAIN = owner.subDomain || '';
    toUpdate.push(asset);
    updated += 1;
  });
  if (toUpdate.length) updateObjectsByKey_(APP.sheets.assetsCurrent, 'ASSET_ID', toUpdate);
  const result = {
    environment: profile.key,
    ranAt: nowIso_(),
    ranBy: actor.email,
    scanned: scanned,
    updated: updated,
    noMatch: noMatch
  };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Editor-run setup: stage uploaded intake CSVs in a separate spreadsheet so the
 * copy does not count against the foundation workbook's cell limit. Pass an empty
 * value to go back to staging inside the foundation workbook. Only affects new uploads.
 */
function setIntakeStagingSpreadsheet(spreadsheetId) {
  assertAdmin_();
  const id = cleanText_(spreadsheetId);
  if (id) {
    // Throws if the id is wrong or the script owner cannot edit the file.
    const book = SpreadsheetApp.openById(id);
    if (!book.getSheets().length) throw new Error('The intake staging spreadsheet has no sheets.');
  }
  updateConfigValue_('INTAKE_STAGING_SPREADSHEET_ID', id);
  return { intakeStagingSpreadsheetId: id || APP.foundationSpreadsheetId };
}

/**
 * Read-only preview for a schema-wide exception: counts the Assets_Current rows
 * in the given database and schemas, grouped by lifecycle state. When
 * includeObjects is true it also returns one entry per matching object. Writes nothing.
 * Run it from the Apps Script editor before any bulk exemption.
 */
function previewSchemaExemption(databaseName, schemaNames, includeObjects) {
  assertAdmin_();
  const database = cleanText_(databaseName).toUpperCase();
  const schemas = (schemaNames || []).map(function (schema) { return cleanText_(schema).toUpperCase(); }).filter(Boolean);
  if (!database || !schemas.length) throw new Error('Provide a database name and at least one schema name.');
  const byState = {};
  const existingExceptions = {};
  const objects = [];
  let matched = 0;
  readObjects_(APP.sheets.assetsCurrent).forEach(function (asset) {
    if (cleanText_(asset.DATABASE_NAME).toUpperCase() !== database) return;
    if (schemas.indexOf(cleanText_(asset.SCHEMA_NAME).toUpperCase()) === -1) return;
    matched += 1;
    incrementCount_(byState, asset.LIFECYCLE_STATE);
    if (cleanText_(asset.EXCEPTION_ID)) incrementCount_(existingExceptions, cleanText_(asset.EXCEPTION_ID));
    if (includeObjects) {
      objects.push({
        assetId: asset.ASSET_ID, objectFqn: asset.OBJECT_FQN, lifecycleState: asset.LIFECYCLE_STATE || 'UNKNOWN',
        exceptionId: cleanText_(asset.EXCEPTION_ID)
      });
    }
  });
  const result = { database: database, schemas: schemas, matchedAssets: matched, byState: byState, existingExceptions: existingExceptions };
  if (includeObjects) result.objects = objects;
  return result;
}

/**
 * One-time schema-wide exemption. Applies EXEMPT to every object in the given
 * database and schemas regardless of lifecycle state, with an expiry date.
 * dryRun = true only counts matches. Refuses to run while an import is active.
 * Run from the Apps Script editor; see exemptSchemas in Untitled.gs.
 */
function exemptSchemaObjects(databaseName, schemaNames, exceptionId, expiresAt, dryRun) {
  const actor = assertAdmin_();
  const code = normalizeApprovedExceptionId_(exceptionId);
  const expiry = cleanText_(expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || new Date(expiry + 'T23:59:59Z') <= new Date()) {
    throw new Error('Provide a future expiry date as YYYY-MM-DD.');
  }
  const preview = previewSchemaExemption(databaseName, schemaNames, true);
  if (!preview.objects.length) throw new Error('No assets matched those schemas.');
  if (dryRun) return { dryRun: true, matchedAssets: preview.matchedAssets, byState: preview.byState, existingExceptions: preview.existingExceptions };
  assertEnvironmentWritable_();
  if (getAnyImportState_()) throw new Error('An import is running. Run the exemption after it finishes.');
  ensureDataModelV2_();
  const result = { processed: 0, failed: 0, details: [] };
  preview.objects.forEach(function (object) {
    try {
      const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', object.assetId, 1);
      if (!cases.length) throw new Error('Lifecycle case not found.');
      const caseRecord = cases[cases.length - 1];
      const fromState = canonicalLifecycleState_(caseRecord.STATE);
      upsertExceptionForAsset_({
        EXCEPTION_ID: code, ASSET_ID: object.assetId, PLATFORM: caseRecord.PLATFORM, CASE_ID: caseRecord.CASE_ID,
        TYPE: 'BUSINESS', STATUS: 'APPROVED', OWNER: actor.email,
        JUSTIFICATION: 'One-time schema exemption ' + code + ' for ' + preview.database + ' schemas ' + preview.schemas.join(', '),
        REQUESTED_AT: caseRecord.CONTESTED_AT || nowIso_(), APPROVED_AT: nowIso_(), EXPIRES_AT: expiry, LAST_SYNCED_AT: nowIso_()
      });
      caseRecord.STATE = APP.lifecycle.exempt;
      caseRecord.EXCEPTION_ID = code;
      caseRecord.EXCEPTION_STATUS = 'APPROVED';
      caseRecord.LAST_TRANSITION_AT = nowIso_();
      caseRecord.NOTES = 'Schema exemption ' + code + ' applied; deprecation actions are suppressed until ' + expiry + '.';
      upsertObject_(APP.sheets.cases, 'CASE_ID', caseRecord);
      updateAssetState_(object.assetId, caseRecord.STATE, caseRecord);
      cancelPendingPlatformActionsForAsset_(object.assetId, 'Schema exemption ' + code + ' recorded.');
      logEvent_(caseRecord.CASE_ID, object.assetId, 'EXCEPTION_APPROVED', fromState, APP.lifecycle.exempt, '', {
        actor: actor.email, exceptionId: code, expiresAt: expiry, bulkSchemaExemption: true
      });
      result.processed += 1;
    } catch (error) {
      result.failed += 1;
      result.details.push({ assetId: object.assetId, objectFqn: object.objectFqn, reason: error.message || String(error) });
    }
  });
  return result;
}

/**
 * Read-only diagnostic: reports duplicate ASSET_ID values and duplicate
 * OBJECT_FQN values (compared case-insensitively, so case-variant table names
 * that collide under the UPPER(FQN) key are included). Writes nothing. Not
 * exposed in the application UI — run it from the Apps Script editor and read
 * the logged result.
 */
function reportAssetDuplicates() {
  assertAdmin_();
  const environment = getActiveEnvironment_();
  const assets = readObjects_(APP.sheets.assetsCurrent);
  const byAssetId = {};
  const byFqn = {};
  assets.forEach(function (asset) {
    const assetId = cleanText_(asset.ASSET_ID);
    const fqn = cleanText_(asset.OBJECT_FQN).toUpperCase();
    if (assetId) (byAssetId[assetId] || (byAssetId[assetId] = [])).push(asset);
    if (fqn) (byFqn[fqn] || (byFqn[fqn] = [])).push(asset);
  });
  const duplicateGroups = function (index) {
    return Object.keys(index).filter(function (key) { return index[key].length > 1; });
  };
  const assetIdGroups = duplicateGroups(byAssetId);
  const fqnGroups = duplicateGroups(byFqn);
  const result = {
    environment: environment,
    scanned: assets.length,
    duplicateAssetIdValues: assetIdGroups.length,
    rowsWithDuplicateAssetId: assetIdGroups.reduce(function (total, key) { return total + byAssetId[key].length; }, 0),
    duplicateFqnValues: fqnGroups.length,
    rowsWithDuplicateFqn: fqnGroups.reduce(function (total, key) { return total + byFqn[key].length; }, 0),
    sampleDuplicateAssetIds: assetIdGroups.slice(0, 20),
    sampleDuplicateFqns: fqnGroups.slice(0, 20).map(function (key) {
      return { objectFqn: key, variants: Array.from(new Set(byFqn[key].map(function (asset) { return cleanText_(asset.OBJECT_FQN); }))) };
    })
  };
  console.log(JSON.stringify(result));
  return result;
}

function getAdminOperations() {
  assertAdmin_();
  const actions = readObjects_(APP.sheets.platformActions);
  const now = new Date();
  const existingPurgeCases = {};
  actions.forEach(function (action) {
    const actionType = cleanText_(action.ACTION).toUpperCase();
    const actionStatus = cleanText_(action.STATUS).toUpperCase();
    if ((actionType === 'PURGE' && actionStatus !== 'CANCELLED') || (actionType === 'RESTORE' && actionStatus !== 'CANCELLED')) existingPurgeCases[action.CASE_ID] = true;
  });
  // Only these Cases columns are used below; reading the full wide sheet is the
  // dominant cost of opening the Operations tab.
  const eligiblePurgeAssets = readObjectColumns_(APP.sheets.cases, ['CASE_ID', 'ASSET_ID', 'PLATFORM', 'STATE', 'PURGE_ELIGIBLE_DATE']).filter(function (caseRecord) {
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
  const visibleActions = readyActions.slice().reverse().slice(0, 200);
  // Fetch only the Assets_Current rows this response actually renders instead of
  // loading the whole (60k+ row) sheet to look up a few hundred assets.
  const neededAssetIds = [];
  eligiblePurgeAssets.concat(purgeHolds, visibleActions).forEach(function (record) {
    neededAssetIds.push(record.ASSET_ID);
  });
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', neededAssetIds), 'ASSET_ID');
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
    actions: visibleActions.map(function (action) {
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
  const ready = readObjects_(APP.sheets.platformActions).filter(function (action) {
    return cleanText_(action.ACTION).toUpperCase() === actionType && cleanText_(action.STATUS).toUpperCase() === 'READY';
  });
  // Only the assets and cases behind the READY batch are needed for the export rows.
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', ready.map(function (action) { return action.ASSET_ID; })), 'ASSET_ID');
  const cases = indexObjectsBy_(readObjectsByKeys_(APP.sheets.cases, 'CASE_ID', ready.map(function (action) { return action.CASE_ID; })), 'CASE_ID');
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
  const updates = readObjectsByKeys_(APP.sheets.platformActions, 'ACTION_ID', actionIds).filter(function (action) {
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

// Assets that are ACTIVE now but were in the stale workflow before. The most recent event that
// moved the asset into ACTIVE from a stale-workflow state is reported as its recovery.
function latestRecoveryEvents_(activeAssetIds, events) {
  const staleWorkflowStates = ['DETECTED', 'NOTIFIED', 'CONTESTED', 'ACCEPTED', 'EXEMPT', 'QUARANTINED', 'PURGE_ELIGIBLE', 'SELF_PURGE_PENDING'];
  const latest = {};
  events.forEach(function (event) {
    const assetId = cleanText_(event.ASSET_ID);
    if (!activeAssetIds[assetId]) return;
    if (canonicalLifecycleState_(event.TO_STATE) !== APP.lifecycle.active) return;
    const fromState = canonicalLifecycleState_(event.FROM_STATE);
    const eventType = cleanText_(event.EVENT_TYPE).toUpperCase();
    if (eventType !== 'STALE_ASSET_BECAME_ACTIVE' && staleWorkflowStates.indexOf(fromState) === -1) return;
    const previous = latest[assetId];
    if (previous && cleanText_(previous.EVENT_AT) > cleanText_(event.EVENT_AT)) return;
    latest[assetId] = event;
  });
  return latest;
}

function exportRecoveredAssetsChunk(input) {
  assertAdmin_();
  const offset = Math.max(0, Number(input && input.offset || 0));
  const CHUNK_SIZE = 2000;
  const activeAssetIds = {};
  readObjectColumns_(APP.sheets.assetsCurrent, ['ASSET_ID', 'LIFECYCLE_STATE']).forEach(function (asset) {
    if (canonicalLifecycleState_(asset.LIFECYCLE_STATE) === APP.lifecycle.active) activeAssetIds[cleanText_(asset.ASSET_ID)] = true;
  });
  const events = readObjectColumns_(APP.sheets.events, ['ASSET_ID', 'EVENT_TYPE', 'FROM_STATE', 'TO_STATE', 'EVENT_AT', 'RUN_ID']);
  const recovered = latestRecoveryEvents_(activeAssetIds, events);
  const assetIds = Object.keys(recovered).sort();
  const sheet = getSheet_(APP.sheets.assetsCurrent);
  const assetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const headers = assetHeaders.concat(['RECOVERED_AT', 'PREVIOUS_LIFECYCLE_STATE', 'RECOVERY_EVENT_TYPE', 'RECOVERY_RUN_ID']);
  const slice = assetIds.slice(offset, offset + CHUNK_SIZE);
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', slice), 'ASSET_ID');
  const rows = slice.filter(function (assetId) { return Boolean(assets[assetId]); }).map(function (assetId) {
    const asset = assets[assetId];
    const event = recovered[assetId];
    asset.LIFECYCLE_STATE = canonicalLifecycleState_(asset.LIFECYCLE_STATE);
    asset.ASSET_STATUS = deriveAssetStatus_(asset, asset.LIFECYCLE_STATE);
    return assetHeaders.map(function (header) { return asset[header] === undefined ? '' : asset[header]; })
      .concat([event.EVENT_AT, canonicalLifecycleState_(event.FROM_STATE), event.EVENT_TYPE, event.RUN_ID]);
  });
  const nextOffset = offset + slice.length;
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyyMMdd-HHmm');
  return {
    headers: headers,
    rows: rows,
    nextOffset: nextOffset,
    total: assetIds.length,
    done: nextOffset >= assetIds.length,
    fileName: getActiveEnvironment_() + '_RECOVERED_ACTIVE_ASSETS_' + date + '.csv'
  };
}
