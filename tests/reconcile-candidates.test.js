const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const noop = () => {};

// Candidate-mode reconcile (scan Cases once, then apply only the missing assets) must leave the
// sheets exactly as the cursor walk does, and recover from the failures it is meant to survive:
// edits between scan and apply, moved rows, a lost candidate list, lost checkpoints, transient
// write failures.

const HEADERS = {
  assets: ['ASSET_ID', 'LIFECYCLE_STATE', 'EVALUATION_STATUS', 'SOURCE_ACTIVITY_STATUS', 'ASSET_STATUS', 'SNAPSHOT_AT'],
  staging: ['ASSET_ID', 'LIFECYCLE_STATE', 'EVALUATION_STATUS', 'SOURCE_ACTIVITY_STATUS', 'ASSET_STATUS', 'SNAPSHOT_AT'],
  cases: ['CASE_ID', 'ASSET_ID', 'STATE', 'PURGE_ELIGIBLE_DATE', 'LAST_TRANSITION_AT', 'LAST_EVALUATION_RUN_ID', 'NOTES'],
  actions: ['ASSET_ID', 'ACTION', 'STATUS'],
  events: ['EVENT_ID', 'CASE_ID', 'ASSET_ID', 'EVENT_TYPE', 'FROM_STATE', 'TO_STATE', 'EVENT_AT', 'ACTOR', 'RUN_ID', 'DETAILS']
};
const STATES = ['DETECTED', 'NOTIFIED', 'DISMISSED', 'ACTIVE', 'RESTORED', 'QUARANTINED', 'PURGE_ELIGIBLE', 'SELF_PURGE_PENDING', 'PURGED'];
const SOURCES = ['Repository.js', 'ReliabilityService.js', 'SnowflakeAdapter.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const STATE = { runId: 'run-1', snapshotAt: '2026-11-13T12:00:00Z' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSheet(sheets, name, headers, rows) {
  const sheet = {
    name, data: [headers.slice()].concat(rows.map(r => r.slice())), maxRows: 1000, maxColumns: 26,
    getLastRow: () => sheet.data.length,
    getLastColumn: () => headers.length,
    getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxColumns,
    insertRowsAfter: (row, count) => { sheet.maxRows += count; },
    insertColumnsAfter: (col, count) => { sheet.maxColumns += count; },
    getRange: (row, col, count = 1, width = 1) => {
      const values = () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => sheet.data[row - 1 + i]?.[col - 1 + j] ?? ''));
      return {
        getValues: values, getDisplayValues: () => values().map(r => r.map(String)),
        setValues: rows => rows.forEach((r, i) => {
          if (!sheet.data[row - 1 + i]) sheet.data[row - 1 + i] = [];
          r.forEach((value, j) => { sheet.data[row - 1 + i][col - 1 + j] = value; });
        })
      };
    }
  };
  sheets[name] = sheet;
  return sheet;
}

function buildWorld(fixture) {
  const sheets = {};
  makeSheet(sheets, 'assets', HEADERS.assets, fixture.assets);
  makeSheet(sheets, 'staging', HEADERS.staging, fixture.staging);
  makeSheet(sheets, 'cases', HEADERS.cases, fixture.cases);
  makeSheet(sheets, 'actions', HEADERS.actions, fixture.actions);
  makeSheet(sheets, 'events', HEADERS.events, []);
  const lifecycle = {
    dismissed: 'DISMISSED', active: 'ACTIVE', restored: 'RESTORED', quarantined: 'QUARANTINED', purgeEligible: 'PURGE_ELIGIBLE',
    selfPurgePending: 'SELF_PURGE_PENDING', purged: 'PURGED', exempted: 'EXEMPTED', exempt: 'EXEMPT', detected: 'DETECTED',
    contested: 'CONTESTED', restricted: 'RESTRICTED'
  };
  const sandbox = vm.createContext({ console, Date, Set, Map, JSON, Math,
    APP: { sheets: { assetsCurrent: 'assets', assetsStaging: 'staging', cases: 'cases', platformActions: 'actions', events: 'events' },
      lifecycle, assetStatus: { purged: 'PURGED_STATUS' } },
    getSheet_: name => { if (!sheets[name]) throw new Error('Missing sheet ' + name); return sheets[name]; },
    resolveSheetName_: name => name,
    cleanText_: value => String(value ?? '').trim(),
    SpreadsheetApp: { flush: noop },
    Utilities: { sleep: noop },
    uuid_: () => 'event-id', nowIso_: () => '2026-11-13T00:00:00Z',
    configNumber_: (key, fallback) => fallback
  });
  SOURCES.forEach(source => vm.runInContext(source, sandbox));
  // Durable payloads behave like the real store: one slot per name, read back only for the same key.
  const slots = {};
  sandbox.saveDurablePayload_ = (name, key, value) => { slots[name] = { key, value: JSON.stringify(value) }; };
  sandbox.readDurablePayload_ = (name, key) => (slots[name] && slots[name].key === key ? JSON.parse(slots[name].value) : null);
  sandbox.deriveAssetStatus_ = (asset, state) => 'STATUS_' + state;
  sandbox.setFinalizationProgress_ = noop;
  sandbox.checkpointImportFinalization_ = noop;
  return { sandbox, sheets, slots };
}

// A new Apps Script execution starts with an empty key-index cache.
function newExecution(world) {
  vm.runInContext('SHEET_KEY_INDEX_CACHE_ = {};', world.sandbox);
}

function copyFixture(fixture) {
  return JSON.parse(JSON.stringify(fixture));
}

function randomFixture(seed) {
  const rand = mulberry32(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const caseCount = 20 + Math.floor(rand() * 260);
  const fixture = { assets: [], staging: [], cases: [], actions: [] };
  for (let i = 0; i < caseCount; i++) {
    const id = 'AST' + i;
    if (rand() < 0.55) fixture.assets.push([id, 'DETECTED', '', '', 'ACTIVE', 'old']);
    if (rand() < 0.2) fixture.staging.push(['NOISE' + i, 'DETECTED', '', '', 'ACTIVE', 'noise']);
    if (rand() < 0.8) {
      fixture.staging.push([id, pick(STATES), 'EVALUATED', '', 'ACTIVE', 'staged-' + i]);
      // A second staged row for the same asset: the later row must win on both paths.
      // EVALUATION_STATUS differs because it survives carry-forward; the other columns are overwritten.
      if (rand() < 0.1) fixture.staging.push([id, 'NOTIFIED', 'RE_EVALUATED', '', 'ACTIVE', 'restaged-' + i]);
    }
    fixture.cases.push(['C' + i, id, pick(STATES), pick(['2020-01-01', '2099-01-01', '']), '', '', '']);
    if (rand() < 0.5) fixture.actions.push([id, pick(['PURGE', 'RESTRICT']), pick(['COMPLETED', 'QUEUED'])]);
    if (rand() < 0.2) fixture.actions.push(['NOISE' + i, 'PURGE', 'COMPLETED']);
  }
  return fixture;
}

function sheetsOf(world) {
  return JSON.parse(JSON.stringify({ assets: world.sheets.assets.data, cases: world.sheets.cases.data, events: world.sheets.events.data }));
}

function runLegacy(fixture, batchSize, prepare) {
  const world = buildWorld(fixture);
  if (prepare) prepare(world);
  const totals = { carriedForward: 0, purgedAssets: 0, selfPurgedAssets: 0 };
  let cursor = 2;
  for (let step = 0; step < 100000; step++) {
    if (step % 3 === 0) newExecution(world);
    const result = world.sandbox.carryForwardAndReconcileChunk_(STATE, cursor, batchSize);
    Object.keys(totals).forEach(name => { totals[name] += result[name]; });
    cursor = result.nextRow;
    if (result.done) break;
  }
  return { world, totals };
}

function newCheckpoint() {
  return { stage: 'RECONCILE', reconcileMode: 'CANDIDATES', reconcileScanDone: false, reconcileScanRow: 2,
    carriedForward: 0, purgedAssets: 0, selfPurgedAssets: 0 };
}

// Drives reconcileCandidatesStep_ the way continueSnowflakeImport does, starting a new execution
// every few steps. hooks.afterScan runs once, between the scan and the first apply batch;
// hooks.beforeStep may replace the step (crash simulations).
function runCandidates(world, scanRows, applyRows, hooks = {}) {
  world.sandbox.configNumber_ = (key, fallback) =>
    key === 'FINALIZATION_SCAN_BATCH_ROWS' ? scanRows : key === 'FINALIZATION_BATCH_SIZE' ? applyRows : fallback;
  const checkpoint = hooks.checkpoint || newCheckpoint();
  const state = Object.assign({}, STATE, { finalization: checkpoint });
  let scanned = checkpoint.reconcileScanDone;
  for (let step = 0; checkpoint.stage === 'RECONCILE'; step++) {
    assert(step < 100000, 'reconcile did not finish');
    if (step % 3 === 0) newExecution(world);
    if (hooks.beforeStep) hooks.beforeStep(step, checkpoint);
    world.sandbox.reconcileCandidatesStep_(state, checkpoint, true);
    if (!scanned && checkpoint.reconcileScanDone) {
      scanned = true;
      if (hooks.afterScan) hooks.afterScan(world, checkpoint);
    }
  }
  assert.strictEqual(checkpoint.stage, 'APPLY_LIFECYCLE');
  return { world, checkpoint, totals: { carriedForward: checkpoint.carriedForward, purgedAssets: checkpoint.purgedAssets, selfPurgedAssets: checkpoint.selfPurgedAssets } };
}

// 1. Differential: the same final sheets and totals as the cursor walk, over random fixtures and batch sizes.
{
  const seeds = Number(process.env.RECONCILE_SEEDS || 200);
  let carriedSeen = 0;
  let purgesSeen = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const fixture = randomFixture(seed);
    const rand = mulberry32(seed * 7919);
    const legacy = runLegacy(copyFixture(fixture), 25 + Math.floor(rand() * 176));
    const candidate = runCandidates(buildWorld(copyFixture(fixture)), 1 + Math.floor(rand() * 120), 25 + Math.floor(rand() * 176));
    assert.deepStrictEqual(candidate.totals, legacy.totals, 'totals differ for seed ' + seed);
    assert.deepStrictEqual(sheetsOf(candidate.world), sheetsOf(legacy.world), 'sheets differ for seed ' + seed);
    carriedSeen += legacy.totals.carriedForward;
    purgesSeen += legacy.totals.purgedAssets + legacy.totals.selfPurgedAssets;
  }
  assert(carriedSeen > seeds * 5 && purgesSeen > seeds, 'fixtures exercise carry-forward and purge verification');
}

// Seed 4: 75 carried (three apply batches of 25), a platform purge and 16 self-purges.
const baseFixture = randomFixture(4);
const baseline = runLegacy(copyFixture(baseFixture), 100);
assert(baseline.totals.carriedForward > 50 && baseline.totals.purgedAssets > 0 && baseline.totals.selfPurgedAssets > 0,
  'baseline fixture has several apply batches and both purge kinds');
const candidateAssetIds = world => world.slots.ReconciliationCandidates
  ? JSON.parse(world.slots.ReconciliationCandidates.value).candidates.map(candidate => candidate.assetId) : [];

// 2. A case dismissed between scan and apply is not carried: same result as if it had been dismissed first.
{
  let target;
  const run = runCandidates(buildWorld(copyFixture(baseFixture)), 50, 25, { afterScan(world) {
    target = candidateAssetIds(world)[0];
    world.sheets.cases.data.find(row => row[1] === target)[2] = 'DISMISSED';
  } });
  const expectedFixture = copyFixture(baseFixture);
  expectedFixture.cases.find(row => row[1] === target)[2] = 'DISMISSED';
  const expected = runLegacy(expectedFixture, 100);
  assert.deepStrictEqual(run.totals, expected.totals);
  assert.deepStrictEqual(sheetsOf(run.world), sheetsOf(expected.world));
}

// 3. An asset that reappears in Assets_Current between scan and apply is not appended twice.
{
  let target;
  const run = runCandidates(buildWorld(copyFixture(baseFixture)), 50, 25, { afterScan(world) {
    target = candidateAssetIds(world)[1];
    world.sheets.assets.data.push([target, 'DETECTED', '', '', 'ACTIVE', 'back']);
  } });
  const expectedFixture = copyFixture(baseFixture);
  expectedFixture.assets.push([target, 'DETECTED', '', '', 'ACTIVE', 'back']);
  const expected = runLegacy(expectedFixture, 100);
  assert.strictEqual(run.world.sheets.assets.data.filter(row => row[0] === target).length, 1);
  assert.deepStrictEqual(sheetsOf(run.world), sheetsOf(expected.world));
}

// 4. Rows shifted in Assets_Staging and Cases after the scan: saved row numbers are stale, the
// key fallback finds the right rows, and the outcome is unchanged.
{
  const run = runCandidates(buildWorld(copyFixture(baseFixture)), 50, 25, { afterScan(world) {
    world.sheets.staging.data.splice(1, 0, ...Array.from({ length: 5 }, (_, i) => ['SHIFT' + i, 'DETECTED', '', '', 'ACTIVE', 'x']));
    world.sheets.cases.data.splice(1, 0, ...Array.from({ length: 3 }, (_, i) => ['XC' + i, 'XA' + i, 'DISMISSED', '', '', '', '']));
  } });
  const expected = sheetsOf(baseline.world);
  const actual = sheetsOf(run.world);
  assert.deepStrictEqual(run.totals, baseline.totals);
  assert.deepStrictEqual(actual.assets, expected.assets);
  assert.deepStrictEqual(actual.events, expected.events);
  assert.deepStrictEqual(actual.cases.slice(4), expected.cases.slice(1), 'case updates land on the moved rows');
}

// 5. The candidate list disappears before apply: the step rescans instead of failing, and the outcome is unchanged.
{
  let rescanned = false;
  const run = runCandidates(buildWorld(copyFixture(baseFixture)), 50, 25, { afterScan(world) { delete world.slots.ReconciliationCandidates; },
    beforeStep(step, checkpoint) { if (checkpoint.reconcileScanDone === false && checkpoint.reconcileScanRow > 2 && checkpoint.candidateCount) rescanned = true; } });
  assert(rescanned, 'scan ran again after the list was lost');
  assert.deepStrictEqual(run.totals, baseline.totals);
  assert.deepStrictEqual(sheetsOf(run.world), sheetsOf(baseline.world));
}

// 6. Lost checkpoints. During the scan, the saved list wins (no duplicate candidates); during apply,
// the saved batch replays (no duplicate rows, totals counted once).
{
  const clean = runCandidates(buildWorld(copyFixture(baseFixture)), 40, 25);
  const world = buildWorld(copyFixture(baseFixture));
  let snapshot = null;
  let scanRestores = 0;
  let applyRestores = 0;
  const run = runCandidates(world, 40, 25, { beforeStep(step, checkpoint) {
    if (snapshot) {
      Object.keys(checkpoint).forEach(name => delete checkpoint[name]);
      Object.assign(checkpoint, snapshot);
      snapshot = null;
      return;
    }
    // Run the step, then throw its checkpoint away: once mid-scan, then for the first and a middle apply batch.
    const midScan = !checkpoint.reconcileScanDone && checkpoint.reconcileScanRow > 2 && scanRestores === 0;
    const applyBatch = checkpoint.reconcileScanDone && applyRestores < 2 && [0, 25].indexOf(checkpoint.reconcileApplyIndex) !== -1;
    if (midScan || applyBatch) {
      snapshot = JSON.parse(JSON.stringify(checkpoint));
      if (midScan) scanRestores += 1; else applyRestores += 1;
    }
  } });
  assert(scanRestores > 0 && applyRestores > 0, 'both stages lost a checkpoint');
  assert.deepStrictEqual(candidateAssetIds(world), candidateAssetIds(clean.world));
  assert.deepStrictEqual(run.totals, baseline.totals);
  assert.deepStrictEqual(sheetsOf(run.world), sheetsOf(baseline.world));
}

// 7. A transient failure after a partial write is retried in the same step without duplicating rows.
{
  const world = buildWorld(copyFixture(baseFixture));
  const realApply = world.sandbox.applyDurableWrites_;
  let calls = 0;
  world.sandbox.applyDurableWrites_ = writes => {
    calls += 1;
    if (calls === 2) { realApply(writes); throw new Error('Service Spreadsheets timed out while accessing document'); }
    return realApply(writes);
  };
  const run = runCandidates(world, 50, 25);
  assert(calls > 2, 'the failed batch was applied again');
  assert.deepStrictEqual(run.totals, baseline.totals);
  assert.deepStrictEqual(sheetsOf(run.world), sheetsOf(baseline.world));
}

// 8. A conflict that persists is not retried as a transient failure: the batch is rebased once,
// and if it still conflicts the error surfaces for the publish retry/pause logic.
{
  const world = buildWorld(copyFixture(baseFixture));
  let calls = 0;
  world.sandbox.applyDurableWrites_ = () => {
    calls += 1;
    throw new Error('Recovery found a conflicting row in assets. No existing data was overwritten.');
  };
  assert.throws(() => runCandidates(world, 50, 25), /conflicting row/);
  assert.strictEqual(calls, 2);
}

// 8b. Another writer takes a reserved Lifecycle_Events row between planning and applying: the batch's
// own appends relocate to the sheet end, the foreign row is kept, and nothing is written twice.
const foreignEventRow = () => ['FOREIGN', '', '', '', '', '', '', '', '', ''];
const firstEventsAppend = writes => writes.find(write => write.append && write.sheet === 'events' && write.rows.length);
function assertRebased(actualWorld) {
  const actual = sheetsOf(actualWorld);
  const expected = sheetsOf(baseline.world);
  assert.deepStrictEqual(actual.assets, expected.assets);
  assert.deepStrictEqual(actual.cases, expected.cases);
  assert.strictEqual(actual.events.filter(row => row[0] === 'FOREIGN').length, 1, 'foreign row kept once');
  assert.deepStrictEqual(actual.events.filter(row => row[0] !== 'FOREIGN'), expected.events, 'our events land once');
}
{
  const world = buildWorld(copyFixture(baseFixture));
  const realApply = world.sandbox.applyDurableWrites_;
  let injected = false;
  world.sandbox.applyDurableWrites_ = writes => {
    const append = injected ? null : firstEventsAppend(writes);
    if (append) { injected = true; world.sheets.events.data[append.row - 1] = foreignEventRow(); }
    return realApply(writes);
  };
  const run = runCandidates(world, 50, 25);
  assert(injected, 'a foreign row was injected');
  assert.deepStrictEqual(run.totals, baseline.totals);
  assertRebased(run.world);
}

// 8c. The same conflict found on replay: the batch was saved, the execution died before it applied,
// and the reserved row was taken meanwhile. The saved plan is rebased and finishes.
{
  const world = buildWorld(copyFixture(baseFixture));
  const realApply = world.sandbox.applyDurableWrites_;
  let failuresLeft = 3;
  let reserved = null;
  world.sandbox.applyDurableWrites_ = writes => {
    const append = firstEventsAppend(writes);
    if (failuresLeft > 0 && append) { failuresLeft -= 1; reserved = append.row; throw new Error('Service unavailable'); }
    return realApply(writes);
  };
  const checkpoint = newCheckpoint();
  assert.throws(() => runCandidates(world, 50, 25, { checkpoint }), /Service unavailable/);
  world.sheets.events.data[reserved - 1] = foreignEventRow();
  const run = runCandidates(world, 50, 25, { checkpoint });
  assert.deepStrictEqual(run.totals, baseline.totals);
  assertRebased(run.world);
}

// 8d. The cursor-walk path rebases too, so a publish already in flight is not wedged by the same conflict.
{
  let injected = false;
  const legacy = runLegacy(copyFixture(baseFixture), 100, world => {
    const realApply = world.sandbox.applyDurableWrites_;
    world.sandbox.applyDurableWrites_ = writes => {
      const append = injected ? null : firstEventsAppend(writes);
      if (append) { injected = true; world.sheets.events.data[append.row - 1] = foreignEventRow(); }
      return realApply(writes);
    };
  });
  assert(injected, 'a foreign row was injected');
  assert.deepStrictEqual(legacy.totals, baseline.totals);
  assertRebased(legacy.world);
}

// 9. Transient failures that persist stop after three attempts.
{
  const world = buildWorld(copyFixture(baseFixture));
  let calls = 0;
  world.sandbox.applyDurableWrites_ = () => { calls += 1; throw new Error('Service unavailable'); };
  assert.throws(() => runCandidates(world, 50, 25), /Service unavailable/);
  assert.strictEqual(calls, 3);
}

// 10. Duplicate Cases rows for one asset: carried once and counted.
{
  const fixture = {
    assets: [],
    staging: [['A1', 'DETECTED', '', '', 'ACTIVE', 'old']],
    cases: [['C1', 'A1', 'DETECTED', '', '', '', ''], ['C2', 'A1', 'NOTIFIED', '', '', '', '']],
    actions: []
  };
  // Same scan window, and separate windows.
  [10, 1].forEach(scanRows => {
    const run = runCandidates(buildWorld(copyFixture(fixture)), scanRows, 25);
    assert.strictEqual(run.world.sheets.assets.data.filter(row => row[0] === 'A1').length, 1, 'scan rows ' + scanRows);
    assert.strictEqual(run.checkpoint.duplicateCaseRows, 1, 'scan rows ' + scanRows);
  });
}

// 11. Empty and nothing-missing extracts finish without apply writes.
{
  const empty = runCandidates(buildWorld({ assets: [], staging: [], cases: [], actions: [] }), 10, 25);
  assert.deepStrictEqual(empty.totals, { carriedForward: 0, purgedAssets: 0, selfPurgedAssets: 0 });
  const allPresent = runCandidates(buildWorld({ assets: [['A1', 'DETECTED', '', '', 'ACTIVE', 's']],
    staging: [['A1', 'DETECTED', '', '', 'ACTIVE', 's']], cases: [['C1', 'A1', 'DETECTED', '', '', '', '']], actions: [] }), 10, 25);
  assert.strictEqual(allPresent.checkpoint.candidateCount, 0);
  assert.strictEqual(allPresent.world.sheets.assets.data.length, 2);
}

// 12. finalizeImport_ routing: only checkpoints that carry reconcileMode use candidate mode, so a
// publish already reconciling on the cursor walk finishes on it.
{
  const source = SOURCES[2];
  assert(/checkpoint\.stage === 'RECONCILE' && checkpoint\.reconcileMode === 'CANDIDATES'/.test(source));
  assert(/checkpoint\.stage = 'RECONCILE';\s*checkpoint\.reconcileMode = 'CANDIDATES';/.test(source));
}

console.log('reconcile-candidates ok');
