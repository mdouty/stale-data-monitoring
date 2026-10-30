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

function cleanText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// Sheet double: grid[0] is the header row. Counts reads of the data region of a column.
function fakeSheet(headers, rows, stats) {
  const grid = [headers.slice()].concat(rows.map(function (row) { return row.slice(); }));
  return {
    grid: grid,
    getLastRow: function () { return grid.length; },
    getLastColumn: function () { return headers.length; },
    getRange: function (row, column, rowCount, columnCount) {
      return {
        getDisplayValues: function () {
          if (row > 1) stats.dataReads += 1;
          return grid.slice(row - 1, row - 1 + rowCount).map(function (line) {
            return line.slice(column - 1, column - 1 + columnCount).map(String);
          });
        },
        getValues: function () {
          return grid.slice(row - 1, row - 1 + rowCount).map(function (line) {
            return line.slice(column - 1, column - 1 + columnCount);
          });
        },
        setValues: function (values) {
          values.forEach(function (line, i) {
            while (grid.length < row + i) grid.push(new Array(headers.length).fill(''));
            line.forEach(function (cell, j) { grid[row - 1 + i][column - 1 + j] = cell; });
          });
        }
      };
    }
  };
}

function build(planUpdateSource) {
  const stats = { dataReads: 0 };
  const headers = ['CASE_ID', 'ASSET_ID', 'STATE'];
  const sheet = fakeSheet(headers, [['c1', 'a1', 'NEW'], ['c2', 'a2', 'NEW'], ['c1', 'a1', 'OLD-DUP']], stats);
  const sandbox = {
    console, Array, Object, Number, String, Math, JSON,
    cleanText_: cleanText_,
    getSheet_: function () { return sheet; },
    ensureSheetCapacity_: function () {},
    objectToRow_: function (hdrs, object) { return hdrs.map(function (h) { return object[h] === undefined ? '' : object[h]; }); },
    SpreadsheetApp: { flush: function () {} }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext('var SHEET_KEY_INDEX_CACHE_ = {};', context);
  ['resolvedSheetCacheName_', 'getSheetKeyIndex_', 'noteSheetWrite_', 'newDurableWritePlan_', 'durablePlanSheet_',
    'planAppendRows_', 'planAppendObjects_', 'applyDurableWrites_'].forEach(function (name) {
    const file = ['newDurableWritePlan_', 'durablePlanSheet_', 'planAppendRows_', 'planAppendObjects_', 'applyDurableWrites_'].indexOf(name) !== -1
      ? 'ReliabilityService.js' : 'Repository.js';
    vm.runInContext(extractFunction(file, name), context);
  });
  vm.runInContext(planUpdateSource, context);
  return { context: context, sheet: sheet, stats: stats };
}

// Reference implementation: the previous full-column scan.
const legacySource = `function planUpdateObjects_(plan, sheetName, keyHeader, objects) {
  if (!objects.length) return;
  const meta = durablePlanSheet_(plan, sheetName);
  const keyIndex = meta.headers.indexOf(keyHeader);
  const sheet = getSheet_(sheetName);
  const rowByKey = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues().forEach(function (row, index) {
    if (cleanText_(row[0])) rowByKey[cleanText_(row[0])] = index + 2;
  });
  meta.appended.forEach(function (item) { rowByKey[cleanText_(item.values[keyIndex])] = item.row; });
  const updates = {};
  objects.forEach(function (object) {
    const key = cleanText_(object[keyHeader]);
    if (!key) return;
    const row = objectToRow_(meta.headers, object);
    if (rowByKey[key]) updates[rowByKey[key]] = row;
    else planAppendRows_(plan, sheetName, [row]);
  });
  const numbers = Object.keys(updates).map(Number).sort(function (a, b) { return a - b; });
  let group;
  numbers.forEach(function (row) {
    if (group && group.row + group.rows.length === row) group.rows.push(updates[row]);
    else { group = { sheet: sheetName, row: row, rows: [updates[row]] }; plan.writes.push(group); }
  });
}`;
const currentSource = extractFunction('ReliabilityService.js', 'planUpdateObjects_');

// One chunk: append a new case, update an existing one (incl. the duplicated key), update the case just appended.
function chunk(env, n) {
  const ctx = env.context;
  const plan = ctx.newDurableWritePlan_();
  ctx.planAppendObjects_(plan, 'Cases', [{ CASE_ID: 'n' + n, ASSET_ID: 'an' + n, STATE: 'NEW' }]);
  ctx.planUpdateObjects_(plan, 'Cases', 'CASE_ID', [
    { CASE_ID: 'c1', ASSET_ID: 'a1', STATE: 'U' + n },
    { CASE_ID: 'n' + n, ASSET_ID: 'an' + n, STATE: 'UPD' + n },
    { CASE_ID: 'brand' + n, ASSET_ID: 'ab' + n, STATE: 'ADDED' }
  ]);
  // Mirror importSourceChunk_: a lookup by the other key between plan and apply.
  ctx.applyDurableWrites_(JSON.parse(JSON.stringify(plan.writes)));
  return JSON.parse(JSON.stringify(plan.writes));
}

const legacy = build(legacySource);
const indexed = build(currentSource);
for (let n = 1; n <= 5; n += 1) {
  assert.deepStrictEqual(chunk(indexed, n), chunk(legacy, n), 'planned writes match the full-scan path for chunk ' + n);
}
assert.deepStrictEqual(indexed.sheet.grid, legacy.sheet.grid, 'resulting sheet is identical');
// c1 appears twice; the last occurrence (row 4) is the one updated.
assert.strictEqual(indexed.sheet.grid[3][2], 'U5');
assert.strictEqual(indexed.sheet.grid[1][2], 'NEW');

// Cache reuse: the legacy path rescans the key column on every chunk; the indexed path scans once
// (appends extend the cached index, in-place updates keep it).
assert(legacy.stats.dataReads >= 5, 'legacy scans per chunk');
assert.strictEqual(indexed.stats.dataReads, 1, 'indexed path scans the key column once across chunks, got ' + indexed.stats.dataReads);

// An in-place write that changes an indexed key must invalidate the entry.
const ctx = indexed.context;
const plan = ctx.newDurableWritePlan_();
ctx.planUpdateObjects_(plan, 'Cases', 'CASE_ID', [{ CASE_ID: 'c2', ASSET_ID: 'a2', STATE: 'X' }]);
ctx.applyDurableWrites_([{ sheet: 'Cases', row: 3, rows: [['renamed', 'a2', 'X']] }]);
const afterRename = JSON.parse(JSON.stringify(ctx.getSheetKeyIndex_(indexed.sheet, 'Cases', 'CASE_ID').rowsByKey));
assert.deepStrictEqual(afterRename.renamed, [3]);
assert.strictEqual(afterRename.c2, undefined, 'stale key dropped after a key-changing write');

console.log('plan-update-key-index.test.js passed');
