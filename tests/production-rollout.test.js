const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');

function extractFunction(fileName, functionName) {
  const source = fs.readFileSync(path.join(root, fileName), 'utf8');
  const start = source.indexOf('function ' + functionName + '(');
  assert(start >= 0, 'Missing function ' + functionName);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unterminated function ' + functionName);
}

function context(values) {
  return vm.createContext(Object.assign({ console, Set, Array, Object, Number, String, Boolean, Date, JSON, Math }, values));
}

{
  const sandbox = context({
    normalizeEnvironment_: value => String(value).toUpperCase(),
    getRawConfig_: () => ({ PRD_READ_ONLY: 'FALSE', DEV_READ_ONLY: 'TRUE' })
  });
  vm.runInContext(extractFunction('Config.js', 'environmentReadOnly_'), sandbox);
  assert.strictEqual(sandbox.environmentReadOnly_('PRD'), false);
  assert.strictEqual(sandbox.environmentReadOnly_('DEV'), true);
  sandbox.getRawConfig_ = () => ({});
  assert.strictEqual(sandbox.environmentReadOnly_('PRD'), true);
  assert.strictEqual(sandbox.environmentReadOnly_('DEV'), false);
}

{
  let persistedEnvironment = 'DEV';
  const sandbox = context({
    APP: { activeEnvironmentProperty: 'ACTIVE_APP_ENVIRONMENT', defaultEnvironment: 'DEV' },
    ACTIVE_ENVIRONMENT_: undefined,
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: () => persistedEnvironment,
        setProperty: (key, value) => { persistedEnvironment = value; }
      })
    },
    normalizeEnvironment_: value => String(value).toUpperCase(),
    isAdminEmail_: () => false
  });
  vm.runInContext(extractFunction('Config.js', 'getActiveEnvironment_'), sandbox);
  assert.strictEqual(sandbox.getActiveEnvironment_(), 'PRD');
  assert.strictEqual(persistedEnvironment, 'PRD');
}

{
  const selections = [];
  const sandbox = context({
    normalizeEnvironment_: value => String(value).toUpperCase(),
    isAdminEmail_: () => false,
    setExecutionEnvironment_: (environment, persist) => selections.push([environment, persist]),
    getClientConfig: () => ({ environment: { key: selections[0][0] } })
  });
  vm.runInContext(extractFunction('Config.js', 'setActiveEnvironment'), sandbox);
  assert.strictEqual(sandbox.setActiveEnvironment('DEV').environment.key, 'PRD');
  assert.deepStrictEqual(selections, [['PRD', true]]);
}

{
  const source = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
  assert(source.includes('renderEnvironment(config.environment, config.environments)'));
  assert(source.includes("tab.classList.toggle('hidden', !available[key])"));
  assert(index.includes('id="environmentTabDEV" class="environment-tab hidden"'));
}

{
  const sandbox = context({ cleanText_: value => String(value == null ? '' : value).trim() });
  vm.runInContext(extractFunction('TeamService.js', 'normalizeAssetAccessIdentity_'), sandbox);
  vm.runInContext(extractFunction('TeamService.js', 'extractAssetAccessIdentities_'), sandbox);
  vm.runInContext(extractFunction('TeamService.js', 'getAssetRoleEmails_'), sandbox);
  vm.runInContext(extractFunction('TeamService.js', 'canAccessAssetWithEmails_'), sandbox);
  assert.strictEqual(sandbox.canAccessAssetWithEmails_(
    { TECHNICAL_STEWARD: 'mdouty' }, ['mdouty@salesforce.com']
  ), true);
  assert.strictEqual(sandbox.canAccessAssetWithEmails_(
    { BUSINESS_STEWARD: 'MDOUTY@SALESFORCE.COM' }, ['mdouty@salesforce.com']
  ), true);
  assert.strictEqual(sandbox.canAccessAssetWithEmails_(
    { TECHNICAL_STEWARD: 'anotheruser' }, ['mdouty@salesforce.com']
  ), false);
}

{
  const sandbox = context({
    lifecycleEventAssetGroupsForRun_: () => ({
      INTAKE_REVIEW_CONFIRMED: ['stale-b', 'stale-a', 'stale-a'],
      ORPHAN_POLICY_ACCEPTED: ['orphan-a'],
      SNOWFLAKE_RESTRICTION_CONFIRMED: ['restricted-a', 'restricted-orphan'],
      SNOWFLAKE_INITIAL_RESTRICTION: ['restricted-a'],
      PURGE_VERIFIED: ['purged-a'],
      SELF_PURGE_VERIFIED: ['purged-b'],
      PURGED_ASSET_REAPPEARED: ['restored-a']
    }),
    loadCaseMap_: () => ({
      'restricted-a': { OWNER_STATUS: 'KNOWN' },
      'restricted-orphan': { OWNER_STATUS: 'ORPHANED' }
    }),
    cleanText_: value => String(value == null ? '' : value).trim()
  });
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignGroups_'), sandbox);
  const groups = JSON.parse(JSON.stringify(sandbox.importNotificationCampaignGroups_('run-1')));
  assert.deepStrictEqual(groups.map(group => [group.messageType, group.assetIds]), [
    ['STALE_ASSET_NOTICE', ['stale-a', 'stale-b']],
    ['ORPHAN_QUARANTINE_NOTICE', ['orphan-a']],
    ['QUARANTINE_NOTICE', ['restricted-a']],
    ['PURGE_COMPLETED', ['purged-a', 'purged-b']],
    ['RESTORATION_CONFIRMED', ['restored-a']]
  ]);
}

{
  const sandbox = context({
    APP: {
      lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED', accepted: 'ACCEPTED', quarantined: 'QUARANTINED' },
      sheets: { cases: 'cases', notifications: 'notifications' }
    },
    readObjectsByField_: () => [
      { ASSET_ID: 'asset-b', STATE: 'DETECTED', OWNER_STATUS: 'KNOWN' },
      { ASSET_ID: 'asset-a', STATE: 'NOTIFIED', OWNER_STATUS: 'KNOWN' },
      { ASSET_ID: 'asset-c', STATE: 'ACCEPTED', OWNER_STATUS: 'ORPHANED' }
    ],
    readObjects_: () => [
      { ASSET_ID: 'asset-a', TYPE: 'STALE_ASSET_NOTICE', STATUS: 'DRAFT' }
    ],
    canonicalLifecycleState_: value => value,
    cleanText_: value => String(value == null ? '' : value).trim(),
    normalizeSlackMessageType_: value => value
  });
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignCaseGroups_'), sandbox);
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'alignImportNotificationDraftCursor_'), sandbox);
  const groups = JSON.parse(JSON.stringify(sandbox.importNotificationCampaignCaseGroups_('run-1')));
  assert.deepStrictEqual(groups.map(group => [group.messageType, group.assetIds]), [
    ['STALE_ASSET_NOTICE', ['asset-a', 'asset-b']],
    ['ORPHAN_QUARANTINE_NOTICE', ['asset-c']]
  ]);
  const state = JSON.parse(JSON.stringify(sandbox.alignImportNotificationDraftCursor_({ completed: 0 }, groups)));
  assert.strictEqual(state.groupIndex, 0);
  assert.strictEqual(state.cursor, 1);
  assert.strictEqual(state.completed, 1);
}

{
  const writes = { cases: [], assets: [], events: [] };
  const sandbox = context({
    APP: { lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED' }, sheets: { cases: 'cases', assetsCurrent: 'assets', events: 'events' } },
    nowIso_: () => '2026-08-31T16:00:00.000Z',
    addDaysIso_: (value, days) => new Date(Date.parse(value) + days * 86400000).toISOString(),
    configNumber_: () => 9,
    canonicalLifecycleState_: value => value,
    updateObjectsByKey_: (sheet, key, rows) => { if (sheet === 'cases') writes.cases = rows; else writes.assets = rows; },
    appendRawRows_: (sheet, rows) => { writes.events = rows; },
    notificationEventRow_: () => ['event']
  });
  vm.runInContext(extractFunction('NotificationService.js', 'markInitialNotificationBatchNotified_'), sandbox);
  sandbox.markInitialNotificationBatchNotified_([{
    record: { NOTIFICATION_ID: 'n1' },
    detail: {
      caseRecord: { CASE_ID: 'c1', STATE: 'DETECTED', EXCEPTION_ID: '', EXCEPTION_STATUS: '' },
      asset: { ASSET_ID: 'a1' }
    }
  }], 'batch-1', 'system');
  assert.strictEqual(writes.cases[0].STATE, 'NOTIFIED');
  assert.strictEqual(writes.cases[0].CONTEST_DEADLINE, '2026-09-09T16:00:00.000Z');
  assert.strictEqual(writes.assets[0].CONTEST_DEADLINE, '2026-09-09T16:00:00.000Z');
}

{
  const source = extractFunction('SnowflakeAdapter.js', 'finalizeImport_');
  const notifications = extractFunction('SnowflakeAdapter.js', 'finalizeImportNotifications_');
  const checkpoint = extractFunction('SnowflakeAdapter.js', 'checkpointImportFinalization_');
  assert(source.includes("scheduleImportContinuation_(7 * 60 * 1000)"));
  assert(source.includes("stage: 'APPROVE_CANDIDATES'"));
  assert(source.includes("checkpoint.stage = 'RECONCILE'"));
  assert(source.includes("result.stage = 'REFRESH_DASHBOARD'"));
  assert(source.includes('Object.assign(checkpoint, saved.result)'));
  assert(source.includes("checkpoint.stage = 'NOTIFICATIONS'"));
  assert(source.includes("checkpoint.stage = 'COMPLETE'"));
  assert(source.includes("clearImportState_(state.environment)"));
  assert(checkpoint.includes('scheduleImportContinuation_(10000)'));
  assert(notifications.includes("profile.isProduction && preparedTotal > syncLimit"));
  assert(notifications.includes("queuePreparedImportNotificationDelivery_(state.runId, state.environment)"));
  assert(source.includes('approveImportedCandidatesChunk_('));
  assert(source.includes('carryForwardAndReconcileChunk_('));
}

{
  const readMany = extractFunction('Repository.js', 'readObjectsByKeys_');
  const updateMany = extractFunction('Repository.js', 'updateObjectsByKey_');
  const grouping = extractFunction('Repository.js', 'groupSheetRowsForBulkIo_');
  const reclaim = extractFunction('Repository.js', 'reclaimOperationalGridCapacity_');
  assert(readMany.includes('groupSheetRowsForBulkIo_(rowNumbers)'));
  assert(updateMany.includes('groupSheetRowsForBulkIo_(updates.map'));
  assert(grouping.includes('contiguous.length <= 25'));
  assert(grouping.includes('repositoryBulkWindowSize_()'));
  assert(reclaim.includes('usedRows + 1000'));
  assert(reclaim.includes('sheet.deleteRows('));
}

{
  const resume = extractFunction('SnowflakeAdapter.js', 'resumeSnowflakeImportLocked_');
  const recover = extractFunction('SnowflakeAdapter.js', 'recoverFailedFinalizationState_');
  const fail = extractFunction('SnowflakeAdapter.js', 'failSnowflakeImport_');
  const status = extractFunction('SnowflakeAdapter.js', 'getImportStatus');
  const client = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  assert(resume.includes('reclaimOperationalGridCapacity_()'));
  assert(resume.includes('recoverFailedFinalizationState_'));
  assert(recover.includes("stage: 'APPROVE_CANDIDATES'"));
  assert(recover.includes('notificationDrafts: notificationDrafts'));
  assert(fail.includes("state.progressStage = 'FINALIZATION_PAUSED'"));
  assert(status.includes('cellLimitFailure && isRecoverableFailedFinalization_'));
  assert(status.includes('Recovered the cell-capacity failure'));
  assert(client.includes('Publication finalization needs attention'));
  assert(client.includes('Resume from saved checkpoint'));
}

{
  const sandbox = context({ configNumber_: () => 500 });
  vm.runInContext(extractFunction('Repository.js', 'repositoryBulkWindowSize_'), sandbox);
  vm.runInContext(extractFunction('Repository.js', 'groupSheetRowsForBulkIo_'), sandbox);
  const sparseRows = Array.from({ length: 40 }, (_, index) => 2 + index * 10);
  const groups = JSON.parse(JSON.stringify(sandbox.groupSheetRowsForBulkIo_(sparseRows)));
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].start, 2);
  assert.strictEqual(Object.keys(groups[0].selectedRows).length, 40);
}

{
  const prepare = extractFunction('SnowflakeAdapter.js', 'prepareSnowflakeIntakeReview');
  const continuation = extractFunction('SnowflakeAdapter.js', 'continueSnowflakeIntakeReview');
  const client = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  assert(prepare.includes("staged.preparationStatus = 'QUEUED'"));
  assert(prepare.includes('scheduleIntakeReviewPreparation_()'));
  assert(!prepare.includes('calculateIntakeReview_('));
  assert(continuation.includes("staged.preparationStatus = 'CALCULATING_REVIEW'"));
  assert(continuation.includes('appendIntakeReviewPartial_('));
  assert(continuation.includes("staged.preparationStatus = 'MERGING_REVIEW'"));
  assert(client.includes('continueSnowflakeIntakeReview({ token: pending.token })'));
  assert(client.includes('Each completed batch is saved.'));
  assert(client.includes('advanceActiveImportWorkflow()'));
}

{
  const preview = extractFunction('SnowflakeAdapter.js', 'buildIntakeSlackPayloadPreviews_');
  assert(preview.includes('sortedItems.slice(0, 10)'));
  assert(preview.includes('assetIds: group.items.map'));
}

{
  const source = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  assert(source.includes("const canRunManualAutomation = canImport && config.environment.key !== 'PRD';"));
  assert(source.includes("runAutomationButton').classList.toggle('hidden', !canRunManualAutomation)"));
}

{
  const source = extractFunction('NotificationService.js', 'slackAssetSummaryLine_');
  assert(!source.includes('buildApplicationAssetUrl_'));
  assert(!source.includes('View asset'));
}

{
  const source = fs.readFileSync(path.join(root, 'NotificationService.js'), 'utf8');
  const fieldsMatch = source.match(/const SLACK_WORKFLOW_PAYLOAD_FIELDS = Object\.freeze\((\[[\s\S]*?\])\);/);
  assert(fieldsMatch, 'Missing Slack workflow payload field whitelist');
  const sandbox = context({ cleanText_: value => String(value == null ? '' : value).trim() });
  vm.runInContext('const SLACK_WORKFLOW_PAYLOAD_FIELDS = ' + fieldsMatch[1] + ';', sandbox);
  vm.runInContext(extractFunction('NotificationService.js', 'normalizeSlackWorkflowPayload_'), sandbox);
  const normalized = JSON.parse(JSON.stringify(sandbox.normalizeSlackWorkflowPayload_({
    caseId: 'case-1',
    edgContact: 'C065MLQ2HLL',
    primaryRecipient: 'owner@salesforce.com',
    assetCount: 233,
    unexpected: 'omit me'
  })));
  assert.deepStrictEqual(Object.keys(normalized), [
    'caseId', 'applicationUrl', 'edgContact', 'exceptionAppUrl', 'purgeEligibleDate',
    'daysInactive', 'lastActivityDate', 'platform', 'assetSummary', 'lifecycleState',
    'thresholdDays', 'contestDeadline', 'quarantineAt', 'messageType',
    'primaryRecipient', 'environment', 'objectFqn', 'assetCount', 'restrictAt'
  ]);
  assert.strictEqual(normalized.assetCount, '233');
  assert.strictEqual(normalized.unexpected, undefined);
}

{
  const sandbox = context({ cleanText_: value => String(value == null ? '' : value).trim() });
  ['isSlackEmail_', 'allowsSalesforceUserId_', 'isSalesforceUserId_', 'firstRecipientEmail_', 'isSlackChannelId_']
    .forEach(function (name) {
      vm.runInContext(extractFunction('NotificationService.js', name), sandbox);
    });
  assert.strictEqual(sandbox.firstRecipientEmail_('mdouty', 'TECHNICAL_STEWARD'), 'mdouty@salesforce.com');
  assert.strictEqual(sandbox.firstRecipientEmail_('Owner@Salesforce.com', 'TECHNICAL_STEWARD'), 'owner@salesforce.com');
  assert.strictEqual(sandbox.firstRecipientEmail_('SYSADMIN', 'TECHNICAL_STEWARD'), '');
  assert.strictEqual(sandbox.firstRecipientEmail_('SNF_BT_DATA_ROLE', 'TECHNICAL_STEWARD'), '');
  assert.strictEqual(sandbox.isSlackChannelId_('C065MLQ2HLL'), true);
  assert.strictEqual(sandbox.isSlackChannelId_('rvuppala@salesforce.com'), false);
}

{
  const integration = extractFunction('AdminService.js', 'getIntegrationStatus');
  const save = extractFunction('AdminService.js', 'saveAdminConfiguration');
  assert(integration.includes('slackWebhookConfigured && slackChannelConfigured'));
  assert(save.includes("updateEnvironmentConfigValue_('EDG_CONTACT', edgContact, profile.key)"));
  assert(save.includes('Add the EDG Slack channel ID before enabling Slack delivery.'));
}

{
  const campaign = extractFunction('SnowflakeAdapter.js', 'continueImportNotificationCampaignLocked_');
  const queue = extractFunction('SnowflakeAdapter.js', 'queueImportNotificationCampaign_');
  assert(campaign.includes("state.phase === 'DRAFTING'"));
  assert(campaign.includes("state.phase === 'DELIVERING'"));
  assert(campaign.includes('createNotificationDraftBatch_(batchIds, group.messageType)'));
  assert(campaign.includes('sendPreparedNotificationOwnerGroup_('));
  assert(campaign.includes('IMPORT_NOTIFICATION_BATCHES_PER_EXECUTION'));
  assert(campaign.includes('setImportNotificationCampaignState_(state)'));
  assert(campaign.includes('getImportNotificationCampaignState_(normalizeEnvironment_(selectedEnvironment))'));
  assert(campaign.includes("typeof environment === 'string'"));
  assert(campaign.includes('watchdogError'));
  assert(!campaign.includes('createAndSendNotificationGroups_(batchIds'));
  assert(queue.includes('getImportNotificationCampaignState_(selectedEnvironment)'));
  assert(queue.includes("cleanText_(existing.runId) === cleanText_(runId)"));
}

{
  const source = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  const resume = extractFunction('SnowflakeAdapter.js', 'resumeSnowflakeImportLocked_');
  assert(source.includes('Resume from checkpoint'));
  assert(source.includes('.resumeSnowflakeImport()'));
  assert(resume.includes('scheduleImportContinuation_(10000)'));
  assert(source.includes('Resume Slack preparation'));
  assert(source.includes('.resumeStalledImportNotificationCampaign()'));
  assert(source.includes('Run next Slack checkpoint now'));
  assert(source.includes('Resume from saved checkpoint'));
}

{
  const status = extractFunction('SnowflakeAdapter.js', 'getImportNotificationCampaignStatus_');
  const selfHealing = extractFunction('SnowflakeAdapter.js', 'healImportNotificationCampaignStatus_');
  assert(status.includes("['PAUSED', 'COMPLETED_WITH_ERRORS', 'SUCCEEDED']"));
  assert(status.includes("deleteProperty(importNotificationCampaignProperty_(state.environment))"));
  assert(status.includes('stalledForMs > 5 * 60 * 1000'));
  assert(selfHealing.includes('scheduleImportNotificationCampaign_(10000)'));
  assert(selfHealing.includes("state.status = 'RETRYING'"));
}

{
  const scheduler = extractFunction('SnowflakeAdapter.js', 'scheduleImportNotificationCampaign_');
  const resume = extractFunction('SnowflakeAdapter.js', 'resumeStalledImportNotificationCampaignLocked_');
  assert(scheduler.indexOf('.create()') < scheduler.indexOf('ScriptApp.getProjectTriggers()'));
  assert(scheduler.includes('trigger.getUniqueId() !== replacementId'));
  assert(resume.includes("state.status = 'RETRYING'"));
  assert(resume.includes('return continueImportNotificationCampaignLocked_(profile.key)'));
}

{
  const selector = extractFunction('SnowflakeAdapter.js', 'getAnyRunningImportNotificationCampaign_');
  assert(selector.indexOf("getImportNotificationCampaignState_('PRD')") < selector.indexOf("getImportNotificationCampaignState_('DEV')"));
}

{
  const sandbox = context({
    APP: { sheets: { notifications: 'notifications' } },
    cleanText_: value => String(value == null ? '' : value).trim(),
    normalizeSlackMessageType_: value => String(value).toUpperCase(),
    isSlackEmail_: value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim()),
    readObjects_: () => [
      { ASSET_ID: 'a1', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'owner@salesforce.com', STATUS: 'DRAFT' },
      { ASSET_ID: 'a2', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'owner@salesforce.com', STATUS: 'FAILED' },
      { ASSET_ID: 'a3', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'other@salesforce.com', STATUS: 'DRAFT' }
    ]
  });
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignEligibility_'), sandbox);
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignRecipientGroups_'), sandbox);
  const groups = JSON.parse(JSON.stringify(sandbox.importNotificationCampaignRecipientGroups_([
    { messageType: 'STALE_ASSET_NOTICE', assetIds: ['a1', 'a2', 'a3'] }
  ], [])));
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups.find(group => group.recipient === 'owner@salesforce.com').records.length, 2);
}

{
  const drafts = extractFunction('NotificationService.js', 'createNotificationDraftBatch_');
  const batch = extractFunction('NotificationService.js', 'buildSlackBatchMessage_');
  const summary = extractFunction('NotificationService.js', 'buildSlackAssetSummary_');
  assert(drafts.includes("'NOTIFICATION_DRAFT_REFRESHED'"));
  assert(drafts.includes("record.RECIPIENTS = routing.primaryRecipient"));
  assert(drafts.includes('existingByCaseType'));
  assert(drafts.includes("cleanText_(record.STATUS).toUpperCase() === 'SENT'"));
  assert(batch.includes('Number(totalAssetCount || 0)'));
  assert(summary.includes("This notification contains ' + assetCount + ' assets. '"));
}

{
  const sandbox = context({
    state: {
      dashboardFilters: { assetStatus: ['STALE'], lifecycle: [], assetType: [], environment: [], stewardship: [], domain: [] },
      pendingDashboardFilters: null
    },
    updateDashboardMultiSelectActions_: () => {},
    loadDashboard: () => { throw new Error('Checkbox changes must not load the dashboard'); }
  });
  vm.runInContext(extractFunction('Client.html', 'cloneDashboardFilters_'), sandbox);
  vm.runInContext(extractFunction('Client.html', 'dashboardMultiSelectChanged_'), sandbox);
  sandbox.dashboardMultiSelectChanged_({
    checked: true,
    getAttribute: name => name === 'data-filter-key' ? 'environment' : 'PRODUCTION'
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.state.dashboardFilters.environment)), []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.state.pendingDashboardFilters.environment)), ['PRODUCTION']);
}

{
  const source = extractFunction('Client.html', 'applyDashboardMultiSelect_');
  assert(source.includes('state.dashboardFilters = cloneDashboardFilters_(state.pendingDashboardFilters)'));
  assert(source.includes("loadDashboard(1, { tableOnlyLoading: true })"));
}

console.log('Production rollout safeguards passed.');
