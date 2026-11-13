const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const noop = () => {};

// Reconcile batches walk Cases and ask, per asset, "does Assets_Current still have it?".
// Matched rows are scattered through a large sheet, so fetching them as full rows reads
// most of the sheet every batch. The chunk must answer presence from the key column and
// fetch full rows only for assets it can actually carry forward or purge.

const HEADERS = {
  assets: ['ASSET_ID', 'LIFECYCLE_STATE', 'EVALUATION_STATUS', 'SOURCE_ACTIVITY_STATUS', 'ASSET_STATUS', 'SNAPSHOT_AT'],
  staging: ['ASSET_ID', 'LIFECYCLE_STATE', 'EVALUATION_STATUS', 'SOURCE_ACTIVITY_STATUS', 'ASSET_STATUS', 'SNAPSHOT_AT'],
  cases: ['CASE_ID', 'ASSET_ID', 'STATE', 'PURGE_ELIGIBLE_DATE', 'LAST_TRANSITION_AT', 'LAST_EVALUATION_RUN_ID', 'NOTES'],
  actions: ['ASSET_ID', 'ACTION', 'STATUS'],
  events: ['EVENT_ID', 'CASE_ID', 'ASSET_ID', 'EVENT_TYPE', 'FROM_STATE', 'TO_STATE', 'EVENT_AT', 'ACTOR', 'RUN_ID', 'DETAILS']
};

function build() {
  const reads = [];
  const sheets = {};
  function makeSheet(name, headers, rows) {
    const sheet = {
      name, data: [headers.slice()].concat(rows.map(r => r.slice())), maxRows: 1000, maxColumns: 26,
      getLastRow: () => sheet.data.length,
      getLastColumn: () => headers.length,
      getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxColumns,
      insertRowsAfter: (row, count) => { sheet.maxRows += count; },
      insertColumnsAfter: (col, count) => { sheet.maxColumns += count; },
      getRange: (row, col, count = 1, width = 1) => {
        const values = () => {
          reads.push({ sheet: name, row, rows: count, cols: width });
          return Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => sheet.data[row - 1 + i]?.[col - 1 + j] ?? ''));
        };
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

  const filler = n => Array.from({ length: n }, (_, i) => ['FILL' + i, 'DETECTED', '', '', 'ACTIVE', 's']);
  // Present assets sit far from each other so a naive row fetch would span many windows.
  const assetsRows = filler(300).concat([['A1', 'DETECTED', '', '', 'ACTIVE', 's']]).concat(filler(300))
    .concat([['A2', 'NOTIFIED', '', '', 'ACTIVE', 's']]);
  makeSheet('assets', HEADERS.assets, assetsRows);
  makeSheet('staging', HEADERS.staging, filler(300).concat([
    ['A1', 'DETECTED', '', '', 'ACTIVE', 'old'],
    ['A3', 'DETECTED', '', '', 'ACTIVE', 'old'],
    ['A4', 'DETECTED', '', '', 'ACTIVE', 'old'],
    ['A5', 'QUARANTINED', '', '', 'ACTIVE', 'old']
  ]));
  makeSheet('cases', HEADERS.cases, [
    ['C1', 'A1', 'DETECTED', '', '', '', ''],             // still present in Assets_Current: skip
    ['C2', 'A2', 'NOTIFIED', '', '', '', ''],             // still present: skip
    ['C3', 'A3', 'DETECTED', '', '', '', ''],             // missing, in staging: carried forward
    ['C4', 'A4', 'DISMISSED', '', '', '', ''],            // missing but dismissed: skip
    ['C5', 'A5', 'QUARANTINED', '2020-01-01', '', '', ''], // missing, purge verified: purged
    ['C6', 'A6', 'DETECTED', '', '', '', '']              // missing, never in staging: skip
  ]);
  makeSheet('actions', HEADERS.actions, filler(300).map(r => [r[0], 'NOOP', 'COMPLETED']).concat([['A5', 'PURGE', 'COMPLETED']]));
  makeSheet('events', HEADERS.events, []);

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
    uuid_: () => 'event-id', nowIso_: () => '2026-11-13T00:00:00Z'
  });
  for (const file of ['Repository.js', 'ReliabilityService.js', 'SnowflakeAdapter.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  // Durable payload storage is covered elsewhere; keep the real write planner and applier.
  sandbox.readDurablePayload_ = () => null;
  sandbox.saveDurablePayload_ = noop;
  sandbox.deriveAssetStatus_ = (asset, state) => 'STATUS_' + state;
  return { sandbox, sheets, reads };
}

const { sandbox, sheets, reads } = build();
const state = { runId: 'run-1', snapshotAt: '2026-11-13T12:00:00Z' };
const result = sandbox.carryForwardAndReconcileChunk_(state, 2, 200);

// Same outcome as before: A3 carried forward, A5 purge-verified and carried, the rest skipped.
assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { nextRow: 8, done: true, carriedForward: 2, purgedAssets: 1, selfPurgedAssets: 0 });
const assetsData = sheets.assets.data;
const tail = assetsData.slice(-2);
assert.deepStrictEqual(tail.map(r => r[0]), ['A3', 'A5']);
assert.strictEqual(tail[0][3], 'NOT_PRESENT_IN_LATEST_SOURCE');
assert.strictEqual(tail[0][1], 'DETECTED');
assert.strictEqual(tail[1][1], 'PURGED');
assert.strictEqual(tail[1][2], 'REMOVED');
assert.strictEqual(tail[1][3], 'NOT_PRESENT_AFTER_PURGE');
assert.strictEqual(tail[0][5], state.snapshotAt);
assert.strictEqual(assetsData.filter(r => r[0] === 'A1').length, 1, 'present assets are not duplicated');
const caseRow = sheets.cases.data.find(r => r[1] === 'A5');
assert.strictEqual(caseRow[2], 'PURGED');
assert.strictEqual(caseRow[5], 'run-1');
assert.strictEqual(sheets.cases.data.find(r => r[1] === 'A3')[2], 'DETECTED', 'carried-forward case is not rewritten');
assert.strictEqual(sheets.events.data.length, 2, 'one PURGE_VERIFIED event row (plus header)');

// Row fetches: Assets_Current is read for its key column and header only, never as full rows
// of the assets that are still present. Staging and Platform_Actions fetch full rows only
// for the assets that can be carried or purged.
const wide = name => reads.filter(r => r.sheet === name && r.cols > 1 && r.row > 1);
const startOfFetch = reads.findIndex(r => r.sheet === 'cases' && r.rows > 1);
assert(startOfFetch >= 0, 'Cases batch was read');
const batchReads = reads.slice(startOfFetch);
const wideAssetsBeforeWrite = batchReads.filter(r => r.sheet === 'assets' && r.cols > 1 && r.row > 1 && r.row <= 603);
assert.deepStrictEqual(wideAssetsBeforeWrite, [], 'no full-row fetch of existing Assets_Current rows');
const stagingRowsFetched = new Set();
wide('staging').forEach(r => { for (let i = 0; i < r.rows; i++) stagingRowsFetched.add(r.row + i); });
// staging rows (1-based sheet rows): A3 = 303, A4 = 304, A5 = 305 -> only A3 and A5 are candidates.
assert.deepStrictEqual([...stagingRowsFetched].sort((a, b) => a - b), [303, 305]);
const actionRowsFetched = new Set();
wide('actions').forEach(r => { for (let i = 0; i < r.rows; i++) actionRowsFetched.add(r.row + i); });
assert.deepStrictEqual([...actionRowsFetched], [302], 'only the purge candidate A5 is looked up in Platform_Actions');

// A replay in the same execution reuses the cached key index: no second key-column scan of Assets_Current.
const keyScans = () => reads.filter(r => r.sheet === 'assets' && r.cols === 1 && r.rows > 100).length;
assert.strictEqual(keyScans(), 1, 'Assets_Current key column scanned once for the batch');

// existingSheetKeys_ matches readObjectsByKeys_ presence semantics, including blank and unknown keys.
{
  const h = build();
  const present = h.sandbox.existingSheetKeys_('assets', 'ASSET_ID', ['A1', ' A2 ', 'ZZZ', '', null]);
  assert.deepStrictEqual(Object.keys(present).sort(), ['A1', 'A2']);
  assert.deepStrictEqual(Object.keys(h.sandbox.existingSheetKeys_('assets', 'ASSET_ID', [])), []);
  assert.deepStrictEqual(Object.keys(h.sandbox.existingSheetKeys_('assets', 'NO_SUCH_COLUMN', ['A1'])), []);
  const viaRead = Array.from(h.sandbox.readObjectsByKeys_('assets', 'ASSET_ID', ['A1', 'A2', 'ZZZ']), o => o.ASSET_ID).sort();
  assert.deepStrictEqual(Object.keys(present).sort(), viaRead);
}

console.log('reconcile-chunk-performance ok');
