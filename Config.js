// DEV uses isolated foundation sheets; PRD remains view-only until explicitly enabled in Config.
let FOUNDATION_SPREADSHEET_;
let ACTIVE_ENVIRONMENT_;
let RAW_CONFIG_RUNTIME_CACHE_;
let MERGED_CONFIG_RUNTIME_CACHE_ = {};

const APP = Object.freeze({
  foundationSpreadsheetId: '16e0gKQtjrnMSLOZk5gG88olvMuUV7yLEctWAjOV975o',
  sourceSpreadsheetId: '1n8OlosBHiC5CBNIcivzl6-nS1N1IpcH6KcWxnjhemOk',
  sourceSheetName: 'Filtered Extract copy',
  schemaOwnerSpreadsheetId: '1EtIMswTPcNQtUYVSb_8Lwoh2muU3U7hJc4g5uqVI_ks',
  schemaOwnerSheetName: 'Schema Master List',
  sourceColumnCount: 27,
  defaultImportChunkSize: 2500,
  defaultSafeImportBatchSize: 500,
  defaultImportExecutionBudgetMs: 210000,
  defaultInlineImportMaxRows: 100,
  importStateProperty: 'SNOWFLAKE_IMPORT_STATE',
  intakeReviewProperty: 'SNOWFLAKE_INTAKE_REVIEW',
  importNotificationCampaignProperty: 'IMPORT_NOTIFICATION_CAMPAIGN',
  activeEnvironmentProperty: 'ACTIVE_APP_ENVIRONMENT',
  userGuideDismissedProperty: 'USER_GUIDE_DISMISSED',
  defaultEnvironment: 'DEV',
  environments: Object.freeze({
    DEV: Object.freeze({ label: 'DEV', sheetPrefix: 'DEV_' }),
    PRD: Object.freeze({ label: 'PRD', sheetPrefix: '' })
  }),
  slackWebhookProperty: 'SLACK_WEBHOOK_URL',
  slackWorkflowProperty: 'SLACK_WORKFLOW_WEBHOOK_URL',
  snowflakeActionEndpointProperty: 'SNOWFLAKE_ACTION_ENDPOINT',
  data360ActionEndpointProperty: 'DATA360_ACTION_ENDPOINT',
  sheets: Object.freeze({
    config: 'Config',
    assetsCurrent: 'Assets_Current',
    assetsStaging: 'Assets_Staging',
    assetsIndex: 'Assets_UI_Index',
    intakeUpload: 'Intake_Upload',
    intakeReviewCache: 'Intake_Review_Cache',
    snapshots: 'Evaluation_Snapshots',
    cases: 'Lifecycle_Cases',
    events: 'Lifecycle_Events',
    notifications: 'Notifications',
    exceptions: 'Exceptions',
    platformActions: 'Platform_Actions',
    jobs: 'Job_Runs',
    dashboardSummary: 'Dashboard_Summary',
    userRoles: 'User_Roles',
    admins: 'ADMINS',
    teams: 'TEAMS'
  }),
  lifecycle: Object.freeze({
    active: 'ACTIVE',
    excluded: 'EXCLUDED',
    detected: 'DETECTED',
    notified: 'NOTIFIED',
    contested: 'CONTESTED',
    accepted: 'ACCEPTED',
    exempt: 'EXEMPT',
    exempted: 'EXEMPTED',
    dismissed: 'DISMISSED',
    restricted: 'RESTRICTED',
    quarantined: 'QUARANTINED',
    purgeEligible: 'PURGE_ELIGIBLE',
    selfPurgePending: 'SELF_PURGE_PENDING',
    restored: 'RESTORED',
    purged: 'PURGED'
  }),
  assetStatus: Object.freeze({
    stale: 'STALE',
    active: 'ACTIVE',
    quarantined: 'QUARANTINED',
    purged: 'PURGED'
  })
});

const ASSET_HEADERS = Object.freeze([
  'ASSET_ID', 'PLATFORM', 'ENVIRONMENT', 'DATABASE_NAME', 'SCHEMA_NAME',
  'OBJECT_NAME', 'OBJECT_FQN', 'SNOWFLAKE_TABLE_ID', 'ASSET_TYPE', 'SIZE_GB', 'DAYS_SINCE_LAST_DDL',
  'DAYS_SINCE_READ', 'DAYS_SINCE_ANY_ACTIVITY', 'DAYS_SINCE_OPERATIONAL_ACTIVITY', 'ESTIMATED_LAST_ACTIVITY_DATE',
  'SOURCE_ACTIVITY_STATUS', 'POLICY_RULE', 'EVALUATION_STATUS',
  'STALE_THRESHOLD_DAYS', 'OWNERSHIP_STATUS', 'DATABASE_OWNER',
  'SCHEMA_OWNER', 'SCHEMA_OWNER_NAME', 'SCHEMA_OWNER_USERNAME', 'SCHEMA_OWNER_ASSIGNMENT_STATUS',
  'RECORD_OWNER', 'TECHNICAL_STEWARD', 'BUSINESS_STEWARD',
  'BDS_TEAM', 'DPM_TEAM', 'EMP_L5', 'EMP_L6', 'LIFECYCLE_STATE',
  'STALE_DESIGNATION_DATE', 'CONTEST_DEADLINE', 'QUARANTINE_START_DATE',
  'QUARANTINE_EXPIRY_DATE', 'PURGE_ELIGIBLE_DATE', 'EXCEPTION_ID',
  'EXCEPTION_STATUS', 'SOURCE_ROW', 'SNAPSHOT_AT',
  'SNOWFLAKE_TABLE_OWNER', 'OWNERSHIP_SOURCE', 'DOMAIN', 'SUB_DOMAIN',
  'ROW_COUNT', 'BYTES', 'OBJECT_CREATED_DATE', 'LAST_READ', 'LAST_WRITE', 'LAST_LOAD', 'LAST_ALTERED',
  'LAST_ACTIVITY_TS', 'IS_STALE_180',
  'SOURCE_SNAPSHOT_AT', 'CONTACT_COVERAGE_STATUS', 'SNOWFLAKE_DATA_STATUS',
  'ASSET_STATUS', 'CONTEST_REFERENCE'
]);

const CASE_HEADERS = Object.freeze([
  'CASE_ID', 'ASSET_ID', 'PLATFORM', 'STATE', 'T0', 'NOTICE_DUE_AT', 'NOTIFIED_AT',
  'CONTEST_DEADLINE', 'RESTRICT_AT', 'QUARANTINE_START_DATE',
  'PURGE_NOTICE_AT', 'PURGE_ELIGIBLE_DATE', 'EXCEPTION_ID',
  'EXCEPTION_STATUS', 'OWNER_STATUS', 'LAST_TRANSITION_AT',
  'LAST_EVALUATION_RUN_ID', 'NOTES', 'CONTEST_REFERENCE',
  'CONTEST_REASON', 'CONTESTED_AT'
]);

function getFoundationSpreadsheet_() {
  if (!FOUNDATION_SPREADSHEET_) {
    FOUNDATION_SPREADSHEET_ = SpreadsheetApp.openById(APP.foundationSpreadsheetId);
  }
  return FOUNDATION_SPREADSHEET_;
}

function getSheet_(name) {
  const resolvedName = resolveSheetName_(name);
  const sheet = getFoundationSpreadsheet_().getSheetByName(resolvedName);
  if (!sheet) throw new Error('Missing required foundation sheet: ' + resolvedName);
  return sheet;
}

function resolveSheetName_(name, environment) {
  const shared = [APP.sheets.config, APP.sheets.userRoles, APP.sheets.admins, APP.sheets.teams];
  if (shared.indexOf(name) !== -1) return name;
  const selected = normalizeEnvironment_(environment || getActiveEnvironment_());
  return APP.environments[selected].sheetPrefix + name;
}

function normalizeEnvironment_(environment) {
  const selected = cleanText_(environment).toUpperCase() || APP.defaultEnvironment;
  if (!APP.environments[selected]) throw new Error('Unsupported application environment: ' + environment);
  return selected;
}

function getActiveEnvironment_() {
  if (ACTIVE_ENVIRONMENT_) return ACTIVE_ENVIRONMENT_;
  const stored = PropertiesService.getUserProperties().getProperty(APP.activeEnvironmentProperty);
  const selected = normalizeEnvironment_(stored || APP.defaultEnvironment);
  ACTIVE_ENVIRONMENT_ = selected === 'DEV' && !isAdminEmail_() ? 'PRD' : selected;
  if (ACTIVE_ENVIRONMENT_ !== selected) {
    PropertiesService.getUserProperties().setProperty(APP.activeEnvironmentProperty, ACTIVE_ENVIRONMENT_);
  }
  return ACTIVE_ENVIRONMENT_;
}

function setExecutionEnvironment_(environment, persistForUser) {
  const selected = normalizeEnvironment_(environment);
  ACTIVE_ENVIRONMENT_ = selected;
  if (persistForUser) PropertiesService.getUserProperties().setProperty(APP.activeEnvironmentProperty, selected);
  return selected;
}

function setActiveEnvironment(environment) {
  const selected = normalizeEnvironment_(environment);
  setExecutionEnvironment_(selected === 'DEV' && !isAdminEmail_() ? 'PRD' : selected, true);
  return getClientConfig();
}

function getRawConfig_() {
  if (RAW_CONFIG_RUNTIME_CACHE_) return RAW_CONFIG_RUNTIME_CACHE_;
  const cache = CacheService.getScriptCache();
  const cached = cache.get('APP_CONFIG');
  if (cached) {
    RAW_CONFIG_RUNTIME_CACHE_ = JSON.parse(cached);
    return RAW_CONFIG_RUNTIME_CACHE_;
  }

  const sheet = getSheet_(APP.sheets.config);
  const lastRow = sheet.getLastRow();
  const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues() : [];
  const config = {};
  values.forEach(function (row) {
    if (row[0]) config[row[0]] = row[1];
  });
  cache.put('APP_CONFIG', JSON.stringify(config), 300);
  RAW_CONFIG_RUNTIME_CACHE_ = config;
  return RAW_CONFIG_RUNTIME_CACHE_;
}

function getConfig_() {
  const environment = getActiveEnvironment_();
  if (MERGED_CONFIG_RUNTIME_CACHE_[environment]) return MERGED_CONFIG_RUNTIME_CACHE_[environment];
  const raw = getRawConfig_();
  const prefix = environment + '_';
  const merged = Object.assign({}, raw);
  Object.keys(raw).forEach(function (key) {
    if (key.indexOf(prefix) === 0) merged[key.substring(prefix.length)] = raw[key];
  });
  MERGED_CONFIG_RUNTIME_CACHE_[environment] = merged;
  return MERGED_CONFIG_RUNTIME_CACHE_[environment];
}

function invalidateConfigCache_() {
  RAW_CONFIG_RUNTIME_CACHE_ = undefined;
  MERGED_CONFIG_RUNTIME_CACHE_ = {};
  CacheService.getScriptCache().remove('APP_CONFIG');
}

function configBoolean_(key, fallback) {
  const raw = getConfig_()[key];
  if (raw === undefined || raw === '') return Boolean(fallback);
  return String(raw).toUpperCase() === 'TRUE';
}

function platformHandoffEnabled_(platform) {
  const normalized = cleanText_(platform).toUpperCase();
  const key = normalized === 'DATA360' ? 'DATA360_ACTIONS_ENABLED' : 'SNOWFLAKE_ACTIONS_ENABLED';
  const config = getConfig_();
  if (config[key] !== undefined && config[key] !== '') return String(config[key]).toUpperCase() === 'TRUE';
  return configBoolean_('PLATFORM_ACTIONS_ENABLED', false);
}

function configNumber_(key, fallback) {
  const parsed = Number(getConfig_()[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getEnvironmentProfile_() {
  const environment = getActiveEnvironment_();
  const config = getConfig_();
  const isProduction = environment === 'PRD';
  const recipientLock = cleanText_(config.PRIMARY_RECIPIENT_LOCK).toLowerCase();
  const recipientAllowlist = cleanText_(config.ALLOWED_RECIPIENTS).split(',').map(function (value) {
    return cleanText_(value).toLowerCase();
  }).filter(Boolean);
  return {
    key: environment,
    label: APP.environments[environment].label,
    isProduction: isProduction,
    readOnly: configBoolean_('READ_ONLY', isProduction),
    importEnabled: configBoolean_('IMPORT_ENABLED', environment === 'DEV'),
    sourceSpreadsheetId: cleanText_(config.SOURCE_SPREADSHEET_ID || APP.sourceSpreadsheetId),
    sourceSheetName: cleanText_(config.SOURCE_SHEET_NAME || APP.sourceSheetName),
    recipientLock: recipientLock,
    recipientAllowlist: recipientAllowlist,
    description: isProduction
      ? (configBoolean_('READ_ONLY', true) ? 'Production dataset · view only' : 'Production dataset · controlled imports and lifecycle operations enabled')
      : 'Reviewed Snowflake intake · isolated lifecycle, data-driven Slack routing, and non-dispatching partner queues'
  };
}

function assertEnvironmentWritable_() {
  const profile = getEnvironmentProfile_();
  if (profile.readOnly) throw new Error(profile.label + ' is view-only. Enable writes for this environment before importing data, changing lifecycle state, creating notifications, or queueing actions.');
  return profile;
}

function environmentReadOnly_(environment) {
  const selected = normalizeEnvironment_(environment);
  const raw = getRawConfig_();
  const scoped = raw[selected + '_READ_ONLY'];
  if (scoped === undefined || scoped === '') return selected === 'PRD';
  return String(scoped).toUpperCase() === 'TRUE';
}

function nowIso_() {
  return new Date().toISOString();
}

function uuid_() {
  return Utilities.getUuid();
}

function cleanText_(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '#N/A' || text === '#REF!' || text === '#VALUE!' ? '' : text;
}

function parseNumber_(value) {
  const cleaned = cleanText_(value).replace(/,/g, '');
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function addDaysIso_(isoOrDate, days) {
  const date = isoOrDate instanceof Date ? new Date(isoOrDate.getTime()) : new Date(isoOrDate);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString();
}

function getCurrentUserEmail_() {
  return cleanText_(Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail()).toLowerCase();
}

function getUserRole_(email) {
  const target = cleanText_(email || getCurrentUserEmail_()).toLowerCase();
  if (isAdminEmail_(target)) return 'ADMIN';
  const cache = CacheService.getUserCache();
  const cacheKey = 'USER_ROLE_' + target;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached === '__NONE__' ? '' : cached;
  const sheet = getSheet_(APP.sheets.userRoles);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    cache.put(cacheKey, '__NONE__', 60);
    return '';
  }
  const rows = sheet.getRange(2, 1, lastRow - 1, 3).getDisplayValues();
  for (let i = 0; i < rows.length; i += 1) {
    if (cleanText_(rows[i][0]).toLowerCase() === target && String(rows[i][2]).toUpperCase() === 'TRUE') {
      const role = cleanText_(rows[i][1]).toUpperCase();
      cache.put(cacheKey, role, 300);
      return role;
    }
  }
  cache.put(cacheKey, '__NONE__', 60);
  return '';
}

function isAdminEmail_(email) {
  const target = cleanText_(email || getCurrentUserEmail_()).toLowerCase();
  if (!target) return false;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ADMIN_EMAIL_' + target;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached === 'TRUE';
  const sheet = getFoundationSpreadsheet_().getSheetByName(APP.sheets.admins);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) {
    cache.put(cacheKey, 'FALSE', 60);
    return false;
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function (value) { return cleanText_(value).toUpperCase(); });
  const emailIndex = headers.indexOf('EMAILS');
  if (emailIndex === -1) {
    cache.put(cacheKey, 'FALSE', 60);
    return false;
  }
  const found = sheet.getRange(2, emailIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().some(function (row) {
    return cleanText_(row[0]).toLowerCase() === target;
  });
  cache.put(cacheKey, found ? 'TRUE' : 'FALSE', 300);
  return found;
}

function assertRole_(allowedRoles) {
  const email = getCurrentUserEmail_();
  const role = getUserRole_(email);
  if (allowedRoles.indexOf(role) === -1) {
    throw new Error('You do not have permission to perform this action.');
  }
  return { email: email, role: role };
}

function assertAdmin_() {
  const email = getCurrentUserEmail_();
  if (!isAdminEmail_(email)) throw new Error('Your email is not listed in ADMINS!EMAILS.');
  return { email: email, role: 'ADMIN' };
}

function getClientConfig(environment) {
  const email = getCurrentUserEmail_();
  const isAdmin = isAdminEmail_(email);
  if (environment) {
    const selected = normalizeEnvironment_(environment);
    setExecutionEnvironment_(selected === 'DEV' && !isAdmin ? 'PRD' : selected, true);
  } else if (getActiveEnvironment_() === 'DEV' && !isAdmin) {
    setExecutionEnvironment_('PRD', true);
  }
  const config = getConfig_();
  const environmentProfile = getEnvironmentProfile_();
  return {
    appName: config.APP_NAME || 'EDG Stale Data Monitoring',
    user: {
      email: email,
      role: getUserRole_(email) || 'VIEWER',
      isAdmin: isAdmin,
      userGuideDismissed: PropertiesService.getUserProperties().getProperty(APP.userGuideDismissedProperty) === 'TRUE'
    },
    environment: environmentProfile,
    environments: (isAdmin ? ['DEV', 'PRD'] : ['PRD']).map(function (key) {
      const item = APP.environments[key];
      return { key: key, label: item.label, readOnly: environmentReadOnly_(key) };
    }),
    exceptionAppUrl: config.EXCEPTION_APP_URL || '',
    policyVersion: config.CURRENT_POLICY_VERSION || '',
    policy: {
      staleThresholdDays: configNumber_('STALE_THRESHOLD_DAYS', 180),
      sandboxThresholdDays: configNumber_('SANDBOX_THRESHOLD_DAYS', 30),
      includeViews: configBoolean_('INCLUDE_VIEWS', true),
      contestWindowDays: configNumber_('CONTEST_WINDOW_DAYS', 9),
      initialNotificationDelayDays: 0,
      contestReminderLeadDays: configNumber_('CONTEST_REMINDER_LEAD_DAYS', 2),
      quarantineDays: configNumber_('QUARANTINE_DAYS', 181),
      purgeNoticeDays: configNumber_('PURGE_NOTICE_DAYS', 30)
    },
    integrations: getIntegrationStatus(),
    importStatus: getImportStatus()
  };
}

function setUserGuidePreference(input) {
  const dontShowAgain = Boolean(input && input.dontShowAgain);
  const properties = PropertiesService.getUserProperties();
  if (dontShowAgain) properties.setProperty(APP.userGuideDismissedProperty, 'TRUE');
  else properties.deleteProperty(APP.userGuideDismissedProperty);
  return { dontShowAgain: dontShowAgain };
}
