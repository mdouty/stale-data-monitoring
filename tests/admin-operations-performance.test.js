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

// Minimal sheet double that records which columns and how many rows are read.
function fakeSheet(headers, rows, reads) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getLastColumn: function () { return headers.length; },
    getRange: function (row, column, rowCount, columnCount) {
      return {
        getDisplayValues: function () {
          reads.push({ row: row, column: column, rowCount: rowCount, columnCount: columnCount });
          const all = [headers].concat(rows);
          return all.slice(row - 1, row - 1 + rowCount).map(function (line) {
            return line.slice(column - 1, column - 1 + columnCount);
          });
        }
      };
    }
  };
}

function run(sheets, reads) {
  const sandbox = {
    console, Set, Array, Object, Number, String, Boolean, Date, JSON, Math,
    cleanText_: cleanText_,
    APP: { sheets: { cases: 'Lifecycle_Cases', assetsCurrent: 'Assets_Current', platformActions: 'Platform_Actions' }, lifecycle: { purgeEligible: 'PURGE_ELIGIBLE' } },
    getSheet_: function (name) { return sheets[name]; },
    resolveSheetName_: function (name) { return name; },
    assertAdmin_: function () {},
    canonicalLifecycleState_: function (value) { return cleanText_(value); },
    deriveAssetStatus_: function (asset) { return asset.LIFECYCLE_STATE || 'UNKNOWN'; },
    incrementCount_: function (map, key) { map[key] = (map[key] || 0) + 1; },
    countMapToArray_: function (map) { return Object.keys(map).map(function (key) { return { key: key, count: map[key] }; }); },
    getActiveEnvironment_: function () { return 'DEV'; },
    getIntegrationStatus: function () { return {}; },
    readObjects_: null
  };
  const context = vm.createContext(sandbox);
  ['readObjects_', 'readObjectColumns_', 'readObjectsByKeys_', 'getSheetKeyIndex_', 'groupSheetRowsForBulkIo_',
    'repositoryBulkWindowSize_', 'indexObjectsBy_', 'rowToObject_'].forEach(function (name) {
    vm.runInContext(extractFunction('Repository.js', name), context);
  });
  vm.runInContext('var SHEET_KEY_INDEX_CACHE_ = {}; function resolvedSheetCacheName_(n) { return String(n); }', context);
  vm.runInContext(extractFunction('AdminService.js', 'getAdminOperations'), context);
  return context.getAdminOperations();
}

const past = '2020-01-01';
const caseHeaders = ['CASE_ID', 'ASSET_ID', 'PLATFORM', 'STATE', 'NOTES', 'CONTEST_REASON', 'PURGE_ELIGIBLE_DATE'];
const caseRows = [
  ['c1', 'a1', 'SNOWFLAKE', 'PURGE_ELIGIBLE', 'long note', 'long reason', past],
  ['c2', 'a2', 'SNOWFLAKE', 'ACTIVE', '', '', ''],
  ['c3', 'a3', 'SNOWFLAKE', 'PURGE_ELIGIBLE', '', '', past] // already has a PURGE action -> excluded
];
const assetHeaders = ['ASSET_ID', 'OBJECT_FQN', 'DOMAIN', 'PLATFORM', 'LIFECYCLE_STATE'];
const assetRows = [];
for (let i = 1; i <= 300; i += 1) assetRows.push(['a' + i, 'DB.S.T' + i, 'Dom' + i, 'SNOWFLAKE', 'QUARANTINED']);
const actionHeaders = ['ACTION_ID', 'CASE_ID', 'ASSET_ID', 'PLATFORM', 'ACTION', 'STATUS'];
const actionRows = [
  ['x1', 'c3', 'a3', 'SNOWFLAKE', 'PURGE', 'READY'],
  ['x2', 'c9', 'a9', 'SNOWFLAKE', 'QUARANTINE', 'READY'],
  ['x3', 'c8', 'zz8', 'SNOWFLAKE', 'PURGE', 'ON_HOLD']
];

const reads = [];
const result = run({
  Lifecycle_Cases: fakeSheet(caseHeaders, caseRows, reads),
  Assets_Current: fakeSheet(assetHeaders, assetRows, reads),
  Platform_Actions: fakeSheet(actionHeaders, actionRows, reads)
}, reads);

// Behaviour is unchanged: only the unclaimed, past-due purge-eligible case is offered.
assert.strictEqual(result.eligiblePurgeCount, 1);
assert.strictEqual(result.eligiblePurgeAssets[0].assetId, 'a1');
assert.strictEqual(result.eligiblePurgeAssets[0].objectFqn, 'DB.S.T1');
assert.strictEqual(result.eligiblePurgeAssets[0].domain, 'Dom1');
assert.strictEqual(result.eligiblePurgeAssets[0].lifecycleState, 'PURGE_ELIGIBLE');
assert.strictEqual(result.actions.length, 2);
assert.strictEqual(result.purgeHolds.length, 1);
assert.strictEqual(result.purgeHolds[0].objectFqn, 'zz8', 'assets missing from Assets_Current fall back to the id');

// Performance: Assets_Current is never read as a whole, and unused Cases columns are skipped.
const wholeAssetRead = reads.some(function (read) {
  return read.row === 1 && read.columnCount === assetHeaders.length && read.rowCount === assetRows.length + 1;
});
assert(!wholeAssetRead, 'Assets_Current must not be read in full');
const casesWideRead = reads.some(function (read) {
  return read.row === 1 && read.columnCount === caseHeaders.length && read.rowCount === caseRows.length + 1;
});
assert(!casesWideRead, 'Lifecycle_Cases must be read by column, not in full');

console.log('admin-operations-performance.test.js passed');
