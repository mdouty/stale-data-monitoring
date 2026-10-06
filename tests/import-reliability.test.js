const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const noop = () => {};

function harness() {
  const sheets = new Map(), properties = new Map();
  const faults = { writes: 0, failAt: 0, after: false, flush: false, property: false };
  function makeSheet(name, data = []) {
    const sheet = {
      data: clone(data), name, id: sheets.size + 1, maxRows: 1000, maxColumns: 26,
      getName: () => sheet.name, getSheetId: () => sheet.id,
      setName: value => { sheets.delete(sheet.name); sheet.name = value; sheets.set(value, sheet); },
      getLastRow: () => { let n = sheet.data.length; while (n && !sheet.data[n - 1].some(x => x !== '')) n--; return n; },
      getLastColumn: () => Math.max(0, ...sheet.data.map(row => row.length)),
      getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxColumns,
      insertRowsAfter: (row, count) => { sheet.maxRows += count; }, insertColumnsAfter: (col, count) => { sheet.maxColumns += count; },
      deleteRows: (row, count) => { sheet.data.splice(row - 1, count); sheet.maxRows = Math.max(1, sheet.maxRows - count); },
      deleteColumns: (col, count) => { sheet.maxColumns -= count; }, hideSheet: noop, showSheet: noop, clearContents: () => { sheet.data = []; },
      getRange: (row, col, count = 1, width = 1) => {
        const values = () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => sheet.data[row - 1 + i]?.[col - 1 + j] ?? ''));
        return {
          getValues: values, getDisplayValues: () => values().map(r => r.map(String)),
          setValues: rows => {
            faults.writes++;
            const fail = faults.failAt === faults.writes;
            if (fail && !faults.after) throw new Error('Injected write failure');
            rows.forEach((r, i) => { if (!sheet.data[row - 1 + i]) sheet.data[row - 1 + i] = []; r.forEach((value, j) => { sheet.data[row - 1 + i][col - 1 + j] = value; }); });
            if (fail) throw new Error('Injected lost write response');
          },
          createTextFinder: target => ({ matchEntireCell: () => ({ findAll: () => values().flatMap((r, i) => String(r[0]) === target ? [{ getRow: () => row + i }] : []) }) })
        };
      }
    };
    sheets.set(name, sheet); return sheet;
  }
  const book = { getSheetByName: name => sheets.get(name), insertSheet: name => makeSheet(name), getSheetById: id => [...sheets.values()].find(x => x.id === id) };
  const sandbox = vm.createContext({ console, Date, Set, Map, JSON, Math,
    APP: { sheets: { assetsCurrent: 'assets', assetsStaging: 'staging', cases: 'cases', events: 'events', snapshots: 'snapshots', notifications: 'notifications' }, environments: { DEV: { sheetPrefix: '' } } },
    normalizeEnvironment_: x => x, getActiveEnvironment_: () => 'DEV', resolveSheetName_: name => name,
    getFoundationSpreadsheet_: () => book, getSheet_: name => { if (!sheets.has(name)) throw new Error('Missing sheet ' + name); return sheets.get(name); },
    cleanText_: value => String(value ?? '').trim(), configNumber_: (key, value) => value,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => { if (faults.property) { faults.property = false; throw new Error('Injected property failure'); } properties.set(key, value); },
      deleteProperty: key => properties.delete(key)
    }) },
    SpreadsheetApp: { flush: () => { if (faults.flush) { faults.flush = false; throw new Error('Injected flush failure'); } } },
    nowIso_: () => '2026-09-14T12:00:00Z', uuid_: (() => { let id = 0; return () => 'id-' + ++id; })(),
    buildNotificationPreview_: () => 'preview'
  });
  for (const file of ['Repository.js', 'ReliabilityService.js', 'SnowflakeAdapter.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  return { sandbox, sheets, properties, faults, makeSheet, book };
}

// A replacement fails before or after its data write, flush, or pointer update:
// the prior cache remains readable and retrying commits the complete new value.
for (const mode of ['before', 'after', 'flush', 'pointer']) {
  const h = harness(), s = h.sandbox;
  s.saveDurablePayload_('ReviewCache', 'token', { count: 12 });
  if (mode === 'before' || mode === 'after') { h.faults.failAt = h.faults.writes + 1; h.faults.after = mode === 'after'; }
  if (mode === 'flush') h.faults.flush = true;
  if (mode === 'pointer') h.faults.property = true;
  assert.throws(() => s.saveDurablePayload_('ReviewCache', 'token', { count: 99, text: 'x'.repeat(80001) }));
  assert.strictEqual(s.readDurablePayload_('ReviewCache', 'token').count, 12);
  h.faults.failAt = 0;
  s.saveDurablePayload_('ReviewCache', 'token', { count: 99, text: 'x'.repeat(80001) });
  assert.strictEqual(s.readDurablePayload_('ReviewCache', 'token').text.length, 80001);
}

// Crash at every write boundary. Exact append IDs, updates and result counters
// remain identical to a clean run, including append-then-update of a new case.
for (const after of [false, true]) for (let boundary = 1; boundary <= 4; boundary++) {
  const h = harness(), s = h.sandbox;
  h.makeSheet('staging', [['ID', 'VALUE']]); h.makeSheet('cases', [['ID', 'VALUE'], ['existing', 'old']]); h.makeSheet('events', [['ID', 'VALUE']]);
  const plan = s.newDurableWritePlan_();
  s.planAppendObjects_(plan, 'staging', [{ ID: 'asset', VALUE: 5 }]);
  s.planAppendObjects_(plan, 'cases', [{ ID: 'new', VALUE: 'detected' }]);
  s.planUpdateObjects_(plan, 'cases', 'ID', [{ ID: 'new', VALUE: 'updated' }]);
  s.planAppendRows_(plan, 'events', [['event-id', 'created']]);
  s.saveDurablePayload_('SourceBatch', 'run|2', { writes: plan.writes, result: { processedRows: 1, writtenRows: 1 } });
  h.faults.failAt = h.faults.writes + boundary; h.faults.after = after;
  assert.throws(() => s.applyDurableWrites_(plan.writes));
  h.faults.failAt = 0;
  const saved = s.readDurablePayload_('SourceBatch', 'run|2');
  s.applyDurableWrites_(saved.writes); s.applyDurableWrites_(saved.writes);
  assert.deepStrictEqual(h.sheets.get('cases').data, [['ID', 'VALUE'], ['existing', 'old'], ['new', 'updated']]);
  assert.deepStrictEqual(h.sheets.get('staging').data, [['ID', 'VALUE'], ['asset', 5]]);
  assert.strictEqual(h.sheets.get('events').getLastRow(), 2);
  assert.deepStrictEqual(saved.result, { processedRows: 1, writtenRows: 1 });
}

// Recovery does not overwrite another writer that occupied a reserved append row.
{
  const h = harness(), s = h.sandbox;
  const sheet = h.makeSheet('events', [['ID', 'VALUE']]);
  const plan = s.newDurableWritePlan_(); s.planAppendRows_(plan, 'events', [['mine', 'event']]);
  sheet.data.push(['someone-else', 'event']);
  assert.throws(() => s.applyDurableWrites_(plan.writes), /conflicting row/);
  assert.strictEqual(sheet.data[1][0], 'someone-else');
}

// When another writer took a reserved append row, the delivery-replay recovery
// relocates only its own appends to the sheet's current end: the foreign row is
// preserved, fixed-row updates stay put, every planned row lands exactly once, and
// re-running the rebased plan is idempotent (no duplicate audit rows).
{
  const h = harness(), s = h.sandbox;
  const events = h.makeSheet('events', [['ID', 'VALUE']]);
  const notifications = h.makeSheet('notifications', [['NOTIFICATION_ID', 'STATUS'], ['n1', 'DRAFT']]);
  const plan = s.newDurableWritePlan_();
  s.planUpdateObjects_(plan, 'notifications', 'NOTIFICATION_ID', [{ NOTIFICATION_ID: 'n1', STATUS: 'SENT' }]);
  s.planAppendRows_(plan, 'events', [['audit-1', 'NOTIFIED']]); // reserves events row 2
  events.data.push(['someone-else', 'event']);                  // foreign writer takes row 2
  assert.throws(() => s.applyDurableWrites_(plan.writes), /conflicting row/);
  const rebased = s.rebaseDurableAppendWrites_(plan.writes);
  s.applyDurableWrites_(rebased);
  s.applyDurableWrites_(rebased); // idempotent replay must not duplicate
  assert.strictEqual(events.data[1][0], 'someone-else'); // foreign row untouched
  assert.strictEqual(events.data[2][0], 'audit-1');      // planned audit row relocated to the end
  assert.strictEqual(events.getLastRow(), 3);            // written exactly once
  assert.strictEqual(notifications.data[1][1], 'SENT');  // fixed-row update still applied
}

// Slack-free resume drains a delivered owner group's pending finalization writes
// (rebasing an append the reserved row of which was taken) without ever sending, and
// completes the campaign only when no owner groups still require a real Slack send.
// The third case is a paused DELIVERING campaign whose finalization already applied
// (no currentOwnerDelivery) and nothing left to send: resume must complete it so import
// unblocks, without sending.
for (const scenario of [
  { remainingGroups: [], currentOwnerDelivery: { batchId: 'b1', messageType: 'STALE_ASSET_NOTICE', recipient: 'owner@example.com' }, expect: 'SUCCEEDED' },
  { remainingGroups: [{ key: 'other|late@example.com' }], currentOwnerDelivery: { batchId: 'b1', messageType: 'STALE_ASSET_NOTICE', recipient: 'owner@example.com' }, expect: 'PAUSED' },
  { remainingGroups: [], currentOwnerDelivery: null, expect: 'SUCCEEDED' }
]) {
  const remainingGroups = scenario.remainingGroups;
  const h = harness(), s = h.sandbox;
  const events = h.makeSheet('events', [['ID', 'VALUE']]);
  h.makeSheet('notifications', [['NOTIFICATION_ID', 'STATUS'], ['n1', 'SENT']]);
  let campaignState = {
    status: 'PAUSED', phase: 'DELIVERING', environment: 'DEV', runId: 'run',
    delivered: 0, failed: 0, ownerMessagesDelivered: 0, ownerMessagesTotal: 2,
    attemptedOwnerGroupKeys: [], currentOwnerDelivery: scenario.currentOwnerDelivery
  };
  s.assertAdmin_ = () => ({ email: 'admin@example.com' });
  s.assertEnvironmentWritable_ = () => ({ key: 'DEV' });
  s.setExecutionEnvironment_ = noop;
  s.deleteImportNotificationCampaignTriggers_ = noop;
  s.getImportNotificationCampaignState_ = () => campaignState ? clone(campaignState) : null;
  s.setImportNotificationCampaignState_ = value => { campaignState = clone(value); };
  s.importNotificationCampaignProperty_ = () => 'IMPORT_NOTIFICATION_CAMPAIGN_DEV';
  s.importNotificationCampaignGroups_ = () => [];
  s.importNotificationCampaignOwnerRecords_ = () => [{ NOTIFICATION_ID: 'n1' }];
  s.importNotificationCampaignRecipientGroups_ = () => clone(remainingGroups);
  s.sendPreparedNotificationOwnerGroup_ = () => assert.fail('resume must not send a Slack message');
  s.deliverSlackPayloadOnce_ = () => assert.fail('resume must not send a Slack message');
  // Another writer took the reserved append row; recovery must relocate, not overwrite.
  s.finalizeNotificationOwnerGroupChunk_ = (records, receipt, plan) => {
    s.planAppendRows_(plan, 'events', [['audit-' + receipt.batchId, 'NOTIFIED']]);
    return records.length;
  };
  events.data.push(['someone-else', 'event']); // occupies the reserved append row (row 2)
  const status = s.resumePausedImportNotificationDeliveryLocked_();
  assert.strictEqual(events.data[1][0], 'someone-else'); // foreign row never overwritten
  if (scenario.currentOwnerDelivery) {
    assert.strictEqual(events.data.filter(row => row[0] === 'audit-b1').length, 1); // audit row written exactly once
  } else {
    assert.ok(!events.data.some(row => row[0] === 'audit-b1')); // nothing to finalize, no writes
  }
  if (scenario.expect === 'SUCCEEDED') {
    assert.strictEqual(status.status, 'SUCCEEDED');
    assert.strictEqual(campaignState.phase, 'COMPLETE');
  } else {
    assert.strictEqual(status.status, 'PAUSED');
    assert.ok(/still need sending/.test(campaignState.lastError));
  }
}

// A crash after either rename resumes by sheet identity, never swapping back.
for (let renames = 1; renames <= 3; renames++) {
  const h = harness(), s = h.sandbox;
  const current = h.makeSheet('assets', [['OLD']]), staging = h.makeSheet('staging', [['NEW']]);
  let calls = 0;
  for (const sheet of [current, staging]) { const rename = sheet.setName; sheet.setName = name => { rename(name); if (++calls === renames) throw new Error('Lost rename response'); }; }
  const ids = { current: current.id, staging: staging.id };
  assert.throws(() => s.swapAssetBuffers_(ids));
  s.swapAssetBuffers_(ids); s.swapAssetBuffers_(ids);
  assert.strictEqual(h.sheets.get('assets').data[0][0], 'NEW');
  assert.strictEqual(h.sheets.get('staging').data[0][0], 'OLD');
}

// A replacement trigger must exist before deleting the old fallback.
{
  const h = harness(), order = [];
  h.sandbox.ScriptApp = { newTrigger: () => ({ timeBased: () => ({ after: () => ({ create: () => { throw new Error('quota'); } }) }) }), getProjectTriggers: () => [{ getHandlerFunction: () => 'worker', getUniqueId: () => 'old' }], deleteTrigger: () => order.push('delete') };
  assert.throws(() => h.sandbox.replaceWorkflowTrigger_('worker', 10000)); assert.deepStrictEqual(order, []);
  h.sandbox.ScriptApp.newTrigger = () => ({ timeBased: () => ({ after: () => ({ create: () => { order.push('create'); return { getUniqueId: () => 'new' }; } }) }) });
  h.sandbox.replaceWorkflowTrigger_('worker', 10000); assert.deepStrictEqual(order, ['create', 'delete']);
}

// Network ambiguity, hard termination and lost receipt writes never cause an
// automatic second webhook call. Explicit rejection remains retryable.
for (const mode of ['network', 'server', 'receipt-before', 'receipt-after', 'accepted', 'rejected']) {
  const h = harness(), s = h.sandbox; let sends = 0;
  const records = [{ NOTIFICATION_ID: 'notification' }];
  s.UrlFetchApp = { fetch: () => {
    sends++;
    if (mode === 'network') throw new Error('connection lost');
    if (mode.startsWith('receipt')) { h.faults.failAt = h.faults.writes + 1; h.faults.after = mode === 'receipt-after'; }
    return { getResponseCode: () => mode === 'server' ? 503 : mode === 'rejected' && sends === 1 ? 429 : 200, getContentText: () => 'response' };
  } };
  const send = () => s.deliverSlackPayloadOnce_(records, 'NOTICE', 'owner@example.com', {}, 'webhook');
  if (mode === 'accepted') send(); else assert.throws(send);
  h.faults.failAt = 0;
  if (['network', 'server', 'receipt-before'].includes(mode)) assert.throws(send, /DELIVERY_UNCERTAIN/);
  else send();
  assert.strictEqual(sends, mode === 'rejected' ? 2 : 1);
}

// Campaign writers cannot run concurrently; the lock is released on exceptions.
{
  const h = harness(), s = h.sandbox; let work = 0, released = 0, available = false;
  s.LockService = { getScriptLock: () => ({ tryLock: () => available, releaseLock: () => released++ }) };
  s.continueImportNotificationCampaignLocked_ = () => { work++; throw new Error('worker failure'); };
  assert.strictEqual(s.continueImportNotificationCampaign('DEV'), null); assert.strictEqual(work, 0);
  available = true; assert.throws(() => s.continueImportNotificationCampaign('DEV'));
  assert.strictEqual(work, 1); assert.strictEqual(released, 1);
}
// A review-cache failure cannot save an advanced reconciliation cursor.
{
  const h = harness(), s = h.sandbox;
  h.makeSheet('source', [['A'], ['row']]);
  let pending = { token: 'token', environment: 'DEV', sourceSheetName: 'source', sourceRows: 1,
    headerSignature: 'A', preparationStatus: 'RECONCILING_REVIEW', reconciliationCursorRow: 2 };
  let cache = { token: 'token', environment: 'DEV', count: 0 }, fail = true;
  s.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
  s.getPendingIntakeReview_ = env => env === 'DEV' ? clone(pending) : null;
  s.setPendingIntakeReview_ = value => { pending = clone(value); };
  s.SpreadsheetApp.openById = () => h.book;
  s.setExecutionEnvironment_ = noop; s.scheduleIntakeReviewPreparation_ = noop;
  s.readIntakeReviewCache_ = () => clone(cache);
  s.writeIntakeReviewCache_ = value => { if (fail) throw new Error('cache unavailable'); cache = clone(value); };
  s.reconcileIntakeReviewChunk_ = (review, cursor) => { review.count++; return { nextRow: cursor + 1, done: false }; };
  s.getIntakeReviewPreparationStatus = () => clone(pending);
  s.console = { error: noop };
  s.continueSnowflakeIntakeReview({ token: 'token' });
  assert.strictEqual(pending.reconciliationCursorRow, 2);
  assert.strictEqual(cache.count, 0);
  fail = false; pending.retryAfter = 0;
  s.continueSnowflakeIntakeReview({ token: 'token' });
  assert.strictEqual(pending.reconciliationCursorRow, 3);
  assert.strictEqual(cache.count, 1);
}

// Verifying an uncertain receipt never sends a message. Received reuses the
// original receipt; not-received permits exactly one subsequent explicit retry.
for (const decision of ['RECEIVED', 'NOT_RECEIVED']) {
  const h = harness(), s = h.sandbox; let sends = 0;
  s.UrlFetchApp = { fetch: () => { sends++; if (sends === 1) throw new Error('lost response'); return { getResponseCode: () => 200 }; } };
  s.assertAdmin_ = () => ({ email: 'admin@example.com' }); s.assertEnvironmentWritable_ = () => ({});
  s.LockService = { getScriptLock: () => ({ waitLock: noop, releaseLock: noop }) };
  const send = () => s.deliverSlackPayloadOnce_([{ NOTIFICATION_ID: 'n' }], 'NOTICE', 'owner@example.com', {}, 'webhook');
  assert.throws(send);
  const entry = s.readSlackDeliveryEntries_()[0];
  s.resolveUncertainSlackDelivery({ id: entry.id, decision });
  assert.strictEqual(sends, 1);
  send(); send();
  assert.strictEqual(sends, decision === 'RECEIVED' ? 1 : 2);
}

// Planning lifecycle changes preserves read-after-write semantics: a cancelled
// quarantine action cannot be completed by the following operation.
{
  const h = harness(), s = h.sandbox;
  h.makeSheet('actions', [['ACTION_ID', 'STATUS'], ['a', 'READY']]);
  const plan = s.newDurableWritePlan_();
  s.planUpdateObjects_(plan, 'actions', 'ACTION_ID', [{ ACTION_ID: 'a', STATUS: 'CANCELLED' }]);
  const values = s.objectsWithPlannedWrites_([{ ACTION_ID: 'a', STATUS: 'READY' }], plan, 'actions', 'ACTION_ID');
  assert.strictEqual(values[0].STATUS, 'CANCELLED');
  assert.strictEqual(h.sheets.get('actions').data[1][1], 'READY');
}
// Lost upload/publish responses are recovered by their original request token;
// repeating confirmation cannot reapply review decisions or start another run.
{
  const h = harness(), s = h.sandbox;
  s.assertAdmin_ = () => ({ email: 'admin@example.com' }); s.assertEnvironmentWritable_ = () => ({ key: 'DEV' });
  const pending = { token: 'review', uploadRequestId: 'upload', preparationStatus: 'QUEUED' };
  let active = null;
  s.getPendingIntakeReview_ = () => pending; s.getImportState_ = () => active; s.getAnyImportState_ = () => active;
  s.getIntakeReviewPreparationStatus = input => ({ token: input.token, running: true });
  s.getImportStatus = () => ({ running: Boolean(active), runId: 'run' });
  s.applyIntakeReviewDecisions_ = () => assert.fail('Approval must not replay');
  s.startSnowflakeImportInternal_ = () => assert.fail('Import must not restart');
  assert.strictEqual(s.recoverSnowflakeIntake({ uploadRequestId: 'different' }), null);
  assert.strictEqual(s.recoverSnowflakeIntake({ uploadRequestId: 'upload' }).token, 'review');
  active = { reviewToken: 'review' };
  assert.strictEqual(s.confirmSnowflakeIntakeLocked_({ token: 'review' }).runId, 'run');
  assert.strictEqual(s.getSnowflakePublicationStatus({ token: 'review' }).running, true);
  assert.throws(() => s.confirmSnowflakeIntakeLocked_({ token: 'other' }), /already running/);
  active = null;
  h.properties.set(s.reliabilityProperty_('ApprovedReview'), JSON.stringify({ token: 'review', runId: 'run' }));
  assert.strictEqual(s.confirmSnowflakeIntakeLocked_({ token: 'review' }).running, false);
}

// Review/import failures have bounded automatic retries rather than a tight loop.
{
  const h = harness(), s = h.sandbox, delays = [];
  const state = { phase: 'IMPORT', environment: 'DEV', runId: 'run', errors: 0 };
  s.setExecutionEnvironment_ = noop; s.setImportState_ = noop; s.updateJobRun_ = noop;
  s.scheduleImportContinuation_ = delay => delays.push(delay); s.deleteImportContinuationTriggers_ = noop;
  s.failSnowflakeImport_(state, new Error('temporarily offline'));
  assert(state.retryAfter > Date.now());
  s.failSnowflakeImport_(state, new Error('temporarily offline'));
  s.failSnowflakeImport_(state, new Error('temporarily offline'));
  assert.deepStrictEqual(delays, [60000, 120000]);
  assert.strictEqual(state.progressStage, 'IMPORT_PAUSED');
}
console.log('Import reliability fault-injection checks passed.');
