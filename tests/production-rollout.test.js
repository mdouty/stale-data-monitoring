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
    getSheet_: () => ({
      getLastRow: () => 4,
      getLastColumn: () => 4,
      getRange: (row, col, count, width) => ({
        getDisplayValues: () => {
          const headers = ['LAST_EVALUATION_RUN_ID', 'ASSET_ID', 'STATE', 'OWNER_STATUS'];
          const rows = [
            ['run-1', 'asset-b', 'DETECTED', 'KNOWN'],
            ['run-1', 'asset-a', 'NOTIFIED', 'KNOWN'],
            ['run-1', 'asset-c', 'ACCEPTED', 'ORPHANED']
          ];
          if (row === 1) return [headers.slice(col - 1, col - 1 + (width || 1))];
          return rows.slice(row - 2, row - 2 + count).map(item => item.slice(col - 1, col - 1 + (width || 1)));
        }
      })
    }),
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
  assert(reclaim.includes('Assets_Previous'));
  assert(reclaim.includes('intakeUpload'));
  const events = extractFunction('SnowflakeAdapter.js', 'lifecycleEventAssetGroupsForRun_');
  assert(events.includes('forEachMatchingSheetRows_'));
  assert(!events.includes('readObjects_(APP.sheets.events)'));
  const prune = extractFunction('Repository.js', 'pruneEvaluationSnapshots_');
  assert(prune.includes('SNAPSHOT_RETENTION_RUNS'));
  const swap = extractFunction('SnowflakeAdapter.js', 'swapAssetBuffers_');
  assert(swap.includes('deleteRows(usedRows + 1001'));
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
    IMPORT_NOTIFICATION_RECORDS_SNAPSHOT_: null,
    readObjects_: () => [
      { ASSET_ID: 'a1', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'owner@salesforce.com', STATUS: 'DRAFT' },
      { ASSET_ID: 'a2', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'owner@salesforce.com', STATUS: 'FAILED' },
      { ASSET_ID: 'a3', TYPE: 'STALE_ASSET_NOTICE', RECIPIENTS: 'other@salesforce.com', STATUS: 'DRAFT' }
    ]
  });
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignEligibility_'), sandbox);
  vm.runInContext(extractFunction('SnowflakeAdapter.js', 'importNotificationCampaignReadRecords_'), sandbox);
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

{
  const source = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  assert(source.includes('id="sendOwnerChangeButton"'), 'Index.html missing sendOwnerChangeButton');
  assert(source.includes('onclick="openOwnerChangeResend()"'), 'Index.html missing onclick handler');
  assert(client.includes('function openOwnerChangeResend()'), 'Client.html missing openOwnerChangeResend function');
  assert(client.includes('function previewOwnerChangeResend_()'), 'Client.html missing previewOwnerChangeResend_ function');
  assert(client.includes('function runOwnerChangeResend_()'), 'Client.html missing runOwnerChangeResend_ function');
  assert(client.includes("document.getElementById('sendOwnerChangeButton').classList.toggle('hidden', !canImport)"));
  assert(client.includes('.previewOwnerChangeNotifications()'));
  assert(client.includes('.sendOwnerChangeNotificationBatch({ sweepId: sweepId'));
}

{
  const source = fs.readFileSync(path.join(root, 'SnowflakeAdapter.js'), 'utf8');
  const buildOwnership = extractFunction('SnowflakeAdapter.js', 'lifecycleEventRow_');
  assert(source.includes('function buildOwnershipChangeEvent_'), 'SnowflakeAdapter missing buildOwnershipChangeEvent_ function');
  assert(source.includes('OWNERSHIP_CHANGED'), 'buildOwnershipChangeEvent_ should reference OWNERSHIP_CHANGED');
  assert(source.includes('previousRecipient'), 'buildOwnershipChangeEvent_ should track previousRecipient');
  assert(source.includes('newRecipient'), 'buildOwnershipChangeEvent_ should track newRecipient');
  assert(source.includes('ignoreRecipientLock'), 'buildOwnershipChangeEvent_ should call resolvePrimaryRecipient_ with ignoreRecipientLock');
  assert(source.includes('changedFields'), 'buildOwnershipChangeEvent_ should track changed fields');
}

{
  const source = fs.readFileSync(path.join(root, 'NotificationService.js'), 'utf8');
  // Verify createNotificationDraftBatch_ accepts options parameter with ownerChange
  const draftFunc = extractFunction('NotificationService.js', 'createNotificationDraftBatch_');
  assert(draftFunc.includes('options'), 'createNotificationDraftBatch_ should accept options parameter');
  assert(draftFunc.includes('ownerChange'), 'createNotificationDraftBatch_ should handle ownerChange option');
  assert(draftFunc.includes('OWNER_CHANGE'), 'createNotificationDraftBatch_ should construct OWNER_CHANGE idempotency key');
  assert(draftFunc.includes('existingByCaseType'), 'createNotificationDraftBatch_ should have fallback logic');
}

{
  const source = fs.readFileSync(path.join(root, 'PlatformActionService.js'), 'utf8');
  // Verify collectOwnerChangeTargets_ exists and has the right structure
  assert(source.includes('function collectOwnerChangeTargets_(limit, excludeAssetIds)'), 'collectOwnerChangeTargets_ function missing');
  assert(source.includes('OWNERSHIP_CHANGED'), 'collectOwnerChangeTargets_ should scan for OWNERSHIP_CHANGED events');
  assert(source.includes('targets'), 'collectOwnerChangeTargets_ should return targets');
  assert(source.includes('skipped'), 'collectOwnerChangeTargets_ should track skipped counts');
  assert(source.includes('remaining'), 'collectOwnerChangeTargets_ should return remaining count');
  assert(source.includes('total'), 'collectOwnerChangeTargets_ should return total count');
}

{
  const source = fs.readFileSync(path.join(root, 'PlatformActionService.js'), 'utf8');
  assert(source.includes('function previewOwnerChangeNotifications()'), 'Missing previewOwnerChangeNotifications');
  assert(source.includes('function sendOwnerChangeNotificationBatch(input)'), 'Missing sendOwnerChangeNotificationBatch');
  assert(source.includes('function collectOwnerChangeTargets_(limit, excludeAssetIds)'), 'Missing collectOwnerChangeTargets_');
  assert(source.includes('OWNERSHIP_CHANGED'), 'Should reference OWNERSHIP_CHANGED events');
  assert(source.includes('assertAdmin_()'), 'Should check admin authorization');
  assert(source.includes('assertEnvironmentWritable_()'), 'Should check environment writability');
  assert(source.includes('createAndSendNotificationGroups_'), 'Should call createAndSendNotificationGroups_');
  assert(source.includes('ownerChange:'), 'Should pass ownerChange option to notification creator');
}

{
  const source = fs.readFileSync(path.join(root, 'NotificationService.js'), 'utf8');
  // Verify resolvePrimaryRecipient_ supports ignoreRecipientLock parameter
  const resolveFunc = extractFunction('NotificationService.js', 'resolvePrimaryRecipient_');
  assert(resolveFunc.includes('options'), 'resolvePrimaryRecipient_ should accept options parameter');
  assert(resolveFunc.includes('ignoreRecipientLock'), 'resolvePrimaryRecipient_ should support ignoreRecipientLock');

  // Verify createNotificationDraftBatch_ supports ownerChange option
  const draftFunc = extractFunction('NotificationService.js', 'createNotificationDraftBatch_');
  assert(draftFunc.includes('options'), 'createNotificationDraftBatch_ should accept options parameter');
  assert(draftFunc.includes('ownerChange'), 'createNotificationDraftBatch_ should support ownerChange option');
  assert(draftFunc.includes('OWNER_CHANGE'), 'createNotificationDraftBatch_ should use OWNER_CHANGE marker in key');
}

{
  const source = fs.readFileSync(path.join(root, 'SnowflakeAdapter.js'), 'utf8');
  // Verify import detection of ownership changes
  const importChunk = extractFunction('SnowflakeAdapter.js', 'importSourceChunk_');
  assert(importChunk.includes('buildOwnershipChangeEvent_'), 'importSourceChunk_ should call buildOwnershipChangeEvent_');
  assert(importChunk.includes('existingAssets'), 'importSourceChunk_ should read existing NOTIFIED assets');
  assert(importChunk.includes('state.appendMode'), 'importSourceChunk_ should check append-only mode');
}

{
  const source = fs.readFileSync(path.join(root, 'docs/DESIGN.md'), 'utf8');
  assert(source.includes('OWNERSHIP_CHANGED'), 'DESIGN.md should document OWNERSHIP_CHANGED event type');
  assert(source.includes('owner-change'), 'DESIGN.md should document owner-change feature');
  assert(source.includes('previewOwnerChangeNotifications'), 'DESIGN.md should document preview function');
  assert(source.includes('sendOwnerChangeNotificationBatch'), 'DESIGN.md should document send function');
}

{
  const source = fs.readFileSync(path.join(root, 'docs/SlackMessageCatalog.md'), 'utf8');
  assert(source.includes('Owner-Change Resend'), 'SlackMessageCatalog should document owner-change resend');
  assert(source.includes('STALE_ASSET_NOTICE'), 'SlackMessageCatalog should mention STALE_ASSET_NOTICE is reused');
  assert(source.includes('OWNERSHIP_CHANGED'), 'SlackMessageCatalog should reference OWNERSHIP_CHANGED events');
}

// ---- Delegate assignment ----
{
  const platform = fs.readFileSync(path.join(root, 'PlatformActionService.js'), 'utf8');
  const notif = fs.readFileSync(path.join(root, 'NotificationService.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'Client.html'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');

  // Behavioral: owner normalization.
  const sandbox = {
    cleanText_: function (v) { return v === null || v === undefined ? '' : String(v).trim(); },
    isSlackEmail_: function (v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim()); },
    isSalesforceUserId_: function (v) { return /^[a-z][a-z0-9.-]*$/i.test(v) && !/^(sysadmin|accountadmin|securityadmin|useradmin|orgadmin|public)$/i.test(v); }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('PlatformActionService.js', 'normalizeDelegateOwner_'), sandbox);
  assert.strictEqual(sandbox.normalizeDelegateOwner_('New.Owner@Salesforce.com'), 'new.owner@salesforce.com');
  assert.strictEqual(sandbox.normalizeDelegateOwner_('jdoe'), 'jdoe@salesforce.com');
  ['', 'a@b.com, c@d.com', 'two words', 'sysadmin', 'a@b'].forEach(function (bad) {
    assert.throws(function () { sandbox.normalizeDelegateOwner_(bad); }, bad + ' should be rejected');
  });

  // Server entry points are admin-only; send also needs a writable environment.
  const preview = extractFunction('PlatformActionService.js', 'previewDelegateAssignment');
  const send = extractFunction('PlatformActionService.js', 'sendDelegatedAssignmentNotifications');
  assert(preview.includes('assertAdmin_()'));
  assert(send.includes('assertAdmin_()') && send.includes('assertEnvironmentWritable_()'));
  assert(send.includes("'STALE_ASSET_NOTICE'") && send.includes('delegate:'));
  const collect = extractFunction('PlatformActionService.js', 'collectDelegationTargets_');
  assert(collect.includes('APP.lifecycle.notified'), 'delegation must be limited to NOTIFIED');
  assert(collect.includes('ignoreRecipientLock'), 'already-owner check must use the true recipient');

  // Draft batch: distinct DELEGATED key with sweepId; lock bypass at draft and send time.
  const draft = extractFunction('NotificationService.js', 'createNotificationDraftBatch_');
  assert(draft.includes('options.delegate') && draft.includes("'|DELEGATED|'") && draft.includes('delegation.sweepId'));
  assert(draft.includes('!isSpecialSend'), 'delegated keys must skip the case/type fallback');
  assert(draft.includes('if (delegation)') && draft.includes("'DELEGATED_OWNER'"), 'delegated recipient must replace resolvePrimaryRecipient_');
  const batchSend = extractFunction('NotificationService.js', 'sendNotificationBatchInternal_');
  assert(batchSend.includes('isDelegatedNotificationRecord_') && batchSend.includes('!delegatedGroup'));
  assert(notif.includes("'OWNER_DELEGATION'"), 'audit reason missing');

  // UI wiring, and no reference to a non-existent client-side uuid_.
  assert(index.includes('bulkDelegateButton') && index.includes('requestDelegateAssignment_()'));
  ['requestDelegateAssignment_', 'previewDelegateAssignment_', 'runDelegateAssignment_', 'clientUuid_'].forEach(function (fn) {
    assert(client.includes('function ' + fn + '('), 'Missing client function ' + fn);
  });
  assert(client.includes('.previewDelegateAssignment({') && client.includes('.sendDelegatedAssignmentNotifications({'));
  assert(!/[^a-zA-Z]uuid_\(/.test(client), 'Client.html must not call server-only uuid_()');

  const design = fs.readFileSync(path.join(root, 'docs/DESIGN.md'), 'utf8');
  assert(design.includes('Delegate assignment') && design.includes('OWNER_DELEGATION'));
}

console.log('Production rollout safeguards passed.');
