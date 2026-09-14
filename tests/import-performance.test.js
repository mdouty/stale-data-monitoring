const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const noop = () => {};
function load(file, names, mocks) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const sandbox = vm.createContext({ console, ...mocks });
  names.forEach(name => {
    const start = source.indexOf('function ' + name + '(');
    assert(start >= 0);
    const tail = source.slice(start);
    const next = /\n(?:  )?function /.exec(tail);
    vm.runInContext(next ? tail.slice(0, next.index) : tail.replace(/<\/script>\s*$/, ''), sandbox);
  });
  return sandbox;
}

// A continuation retains the original batch boundaries, saves each batch, and
// stops at the batch cap, the time budget, or the phase transition.
for (const scenario of [{ duration: 1, limit: 99, expected: 3 }, { duration: 31000, limit: 99, expected: 1 }, { duration: 1, limit: 2, expected: 2 }]) {
  let clock = 0, batches = 0, scheduled = 0, released = 0;
  const state = { environment: 'DEV', phase: 'IMPORT' };
  const sandbox = load('SnowflakeAdapter.js', ['continueSnowflakeImport'], {
    Date: { now: () => clock }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) },
    deleteImportContinuationTriggers_: noop, getAnyImportState_: () => state,
    normalizeEnvironment_: x => x, setExecutionEnvironment_: noop,
    importSourceChunk_: (value, inline, deferred) => {
      assert.strictEqual(inline, false); assert.strictEqual(deferred, true);
      batches++; clock += scenario.duration;
      if (batches === scenario.limit) value.phase = 'PREPARE_FINALIZE';
    }, getImportState_: () => state, scheduleImportContinuation_: () => scheduled++, getImportStatus: () => state,
    failSnowflakeImport_: () => assert.fail('Unexpected import failure')
  });
  sandbox.continueSnowflakeImport();
  assert.strictEqual(batches, scenario.expected);
  assert.strictEqual(scheduled, 2);
  assert.strictEqual(released, 1);
}

// Review calculations still receive the same rows and metadata in each partial;
// every partial is saved before another calculation starts.
for (const duration of [1, 31000]) {
  let clock = 0, persisted = 0;
  const staged = { token: 'review', environment: 'DEV', preparationStatus: 'CALCULATING_REVIEW',
    sourceRows: 400, headerSignature: 'A', reviewCursorRow: 2, reviewProcessedRows: 0, reviewPartCount: 0 };
  const batches = [];
  const sandbox = load('SnowflakeAdapter.js', ['continueSnowflakeIntakeReview'], {
    Date: { now: () => clock }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    deleteIntakeReviewPreparationTriggers_: noop, cleanText_: x => String(x || '').trim(),
    getPendingIntakeReview_: env => env === 'DEV' ? staged : null, setExecutionEnvironment_: noop,
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => ({ getLastColumn: () => 1, getLastRow: () => 401,
      getRange: (row, col, count) => ({ getDisplayValues: () => row === 1 ? [['A']] : Array.from({ length: count }, (_, i) => [String(row + i)]) }) }) }) },
    configNumber_: () => 150, nowIso_: () => '2026-09-14', readDurablePayload_: () => null, saveDurablePayload_: noop,
    calculateIntakeReview_: (headers, rows, metadata) => {
      assert.strictEqual(persisted, batches.length); assert.strictEqual(metadata.incremental, true);
      batches.push(rows.map(x => x[0])); clock += duration; return { count: rows.length };
    }, appendIntakeReviewPartial_: (env, token, index) => assert.strictEqual(index, batches.length - 1),
    setPendingIntakeReview_: value => { persisted = value.reviewPartCount; },
    scheduleIntakeReviewPreparation_: noop, getIntakeReviewPreparationStatus: () => staged
  });
  sandbox.continueSnowflakeIntakeReview({ token: 'review' });
  assert.strictEqual(batches.length, duration === 1 ? 3 : 1);
  assert.strictEqual(staged.reviewProcessedRows, duration === 1 ? 400 : 150);
  assert.strictEqual(staged.preparationStatus, duration === 1 ? 'MERGING_REVIEW' : 'CALCULATING_REVIEW');
  assert.strictEqual(batches.flat().join(','), Array.from({ length: staged.reviewProcessedRows }, (_, i) => String(i + 2)).join(','));
}

// Bulk updates preserve duplicate-key last-write behavior and untouched rows,
// including the sparse-window path, while eliminating fully-selected reads.
for (const sparse of [false, true]) {
  const data = [['ID', 'VALUE'], ...Array.from({ length: 100 }, (_, i) => [String(i), 'old-' + i])];
  let dataReads = 0;
  const sheet = { getLastRow: () => data.length, getLastColumn: () => 2,
    getRange: (row, col, count, width) => ({
      getDisplayValues: () => { if (row > 1 && width === 2) dataReads++; return data.slice(row - 1, row - 1 + count).map(x => x.slice(col - 1, col - 1 + width)); },
      setValues: rows => rows.forEach((value, i) => { data[row - 1 + i] = Array.from(value); })
    }) };
  const sandbox = load('Repository.js', ['objectToRow_', 'repositoryBulkWindowSize_', 'groupSheetRowsForBulkIo_', 'updateObjectsByKey_'], {
    cleanText_: x => String(x || '').trim(), getSheet_: () => sheet, configNumber_: () => 100
  });
  const updates = Array.from({ length: sparse ? 30 : 3 }, (_, i) => ({ ID: String(sparse ? i * 3 : i), VALUE: 'new-' + i }));
  updates.push({ ID: '0', VALUE: 'last' });
  const expected = data.map(row => row.slice());
  updates.forEach(value => { expected[Number(value.ID) + 1] = [value.ID, value.VALUE]; });
  sandbox.updateObjectsByKey_('cases', 'ID', updates);
  assert.deepStrictEqual(data, expected);
  assert.strictEqual(dataReads, sparse ? 1 : 0);
}

// Status checks continue while a worker is busy, and network errors retain the
// staged review instead of telling the user to upload again.
{
  const calls = [], timers = [], handled = [];
  function runner(success, failure) {
    return { withSuccessHandler: fn => runner(fn, failure), withFailureHandler: fn => runner(success, fn),
      continueSnowflakeIntakeReview: input => calls.push({ type: 'advance', input, success, failure }),
      getIntakeReviewPreparationStatus: input => calls.push({ type: 'status', input, success, failure }) };
  }
  const state = { intakePreparation: { token: 'review' } };
  const sandbox = load('Client.html', ['pollIntakeReviewPreparation_'], {
    state, google: { script: { run: runner() } }, setTimeout: fn => { timers.push(fn); return timers.length; },
    handleIntakeReviewPreparationStatus_: value => handled.push(value), renderWorkflowLoading_: noop
  });
  sandbox.pollIntakeReviewPreparation_();
  calls[1].failure(new Error('offline'));
  assert.strictEqual(state.intakePreparation.token, 'review');
  timers.shift()();
  assert.strictEqual(calls.filter(x => x.type === 'advance').length, 1);
  calls[2].success({ status: 'CALCULATING_REVIEW', processedRows: 150 });
  assert.strictEqual(handled[0].processedRows, 150);
  calls[0].success();
  sandbox.pollIntakeReviewPreparation_();
  assert.strictEqual(calls.filter(x => x.type === 'advance').length, 2);
  state.intakePreparation = { token: 'new-review' };
  calls[calls.length - 1].success({ status: 'READY' });
  assert.strictEqual(handled.length, 1);
}
// A paused finalization reports a recoverable failure, and resume re-enables it.
{
  const state = { environment: 'DEV', phase: 'FINALIZE', progressStage: 'FINALIZATION_PAUSED', sourceRows: 100, processedRows: 100 };
  const sandbox = load('SnowflakeAdapter.js', ['getImportStatus', 'advanceActiveImportWorkflow', 'resumeSnowflakeImportLocked_'], {
    clearBlankProductionWorkflowState_: noop, getImportState_: () => state,
    getSelfHealingImportNotificationCampaignStatus_: () => ({}), assertAdmin_: noop,
    assertEnvironmentWritable_: () => ({ key: 'DEV' }), reclaimOperationalGridCapacity_: noop,
    nowIso_: () => '2026-09-14', setImportState_: noop, updateJobRun_: noop, scheduleImportContinuation_: noop,
    setExecutionEnvironment_: noop, continueSnowflakeImport: () => { throw new Error('Paused work must not auto-advance'); }
  });
  const paused = sandbox.advanceActiveImportWorkflow();
  assert.strictEqual(paused.running, false);
  assert.strictEqual(paused.phase, 'FAILED');
  assert.strictEqual(paused.recoverable, true);
  assert.strictEqual(sandbox.resumeSnowflakeImportLocked_().running, true);
}

// Publication polls do not wait for the processing response, survive a network
// error, and ignore responses belonging to a superseded polling session.
{
  const calls = [], timers = [], rendered = [];
  function runner(success, failure) {
    return { withSuccessHandler: fn => runner(fn, failure), withFailureHandler: fn => runner(success, fn),
      advanceActiveImportWorkflow: () => calls.push({ type: 'advance', success, failure }),
      getImportStatus: () => calls.push({ type: 'status', success, failure }) };
  }
  const state = {};
  const sandbox = load('Client.html', ['startPolling'], {
    state, google: { script: { run: runner() } }, clearTimeout: noop,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    renderImportStatus: value => rendered.push(value), showPublishingLoading_: noop, showWorkflowLoading_: noop
  });
  sandbox.startPolling(true); timers.shift()();
  calls[1].success({ running: true, completed: 150 });
  timers.shift()();
  assert.strictEqual(calls.filter(x => x.type === 'advance').length, 1);
  calls[2].failure(new Error('offline'));
  assert.strictEqual(timers.length, 1);
  timers.shift()();
  const staleResponse = calls[calls.length - 1];
  sandbox.startPolling(true);
  staleResponse.success({ running: true, completed: 0 });
  assert.strictEqual(rendered.length, 1);
}

// Unknown-duration stages never invent an overall completion percentage.
{
  const views = [];
  const sandbox = load('Client.html', ['showPublishingLoading_', 'startUploadProgress_'], {
    state: {}, cleanClientText_: x => String(x || '').trim(), formatNumber: String,
    formatElapsedTime_: String, formatFileSize: String, stopUploadProgress_: noop, setInterval: noop,
    showWorkflowLoading_: (title, message, config) => views.push(config)
  });
  sandbox.showPublishingLoading_({ phase: 'IMPORT', percent: 50, completed: 50, total: 100 });
  assert.strictEqual(views[0].percent, 50);
  assert(views[0].stage.includes('% of source rows evaluated'));
  sandbox.showPublishingLoading_({ phase: 'FINALIZE', progressStage: 'REFRESHING_DASHBOARD' });
  assert.strictEqual(views[1].indeterminate, true);
  sandbox.startUploadProgress_({ name: 'assets.csv', size: 100 });
  assert.strictEqual(views[2].indeterminate, true);
}
console.log('Import performance and progress regressions passed.');
