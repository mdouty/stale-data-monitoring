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

const context = vm.createContext({
  cleanText_: function (value) { return value === null || value === undefined ? '' : String(value).trim(); },
  Utilities: { formatDate: function () { return '20261028_120000'; } },
  Session: { getScriptTimeZone: function () { return 'UTC'; } },
  Date
});
vm.runInContext(extractFunction('SnowflakeAdapter.js', 'filterIntakeReviewExportRows_'), context);
vm.runInContext(extractFunction('SnowflakeAdapter.js', 'intakeReviewExportFileName_'), context);
vm.runInContext(extractFunction('SnowflakeAdapter.js', 'prioritizeMissingReviewSamples_'), context);

const headers = ['TABLE_FQN', 'REVIEW_STAGE', 'REVIEW_TYPE'];
const rows = [
  ['a', 'LIFECYCLE', 'RECOVERED'],
  ['b', 'LIFECYCLE', 'REAPPEARED'],
  ['c', 'NEW_STALE', 'NEW'],
  ['d', 'LIFECYCLE', 'RECOVERED'],
  ['e', 'INVENTORY', 'ACTIVE']
];
const names = function (result) { return result.rows.map(function (row) { return row[0]; }); };

assert.deepStrictEqual(names(context.filterIntakeReviewExportRows_(headers, rows, '', '')), ['a', 'b', 'c', 'd', 'e'], 'no scope keeps the full review export');
assert.deepStrictEqual(names(context.filterIntakeReviewExportRows_(headers, rows, 'LIFECYCLE', '')), ['a', 'b', 'd']);
const scoped = context.filterIntakeReviewExportRows_(headers, rows, 'LIFECYCLE', 'RECOVERED');
assert.deepStrictEqual(names(scoped), ['a', 'd']);
assert.strictEqual(scoped.suffix, 'lifecycle_recovered');
assert.strictEqual(context.intakeReviewExportFileName_('file.csv', scoped.suffix), 'file_review_details_lifecycle_recovered_20261028_120000.csv');
assert.strictEqual(context.intakeReviewExportFileName_('file.csv'), 'file_review_details_20261028_120000.csv');

// Quarantine & purge: retained-only missing rows are excluded, purge verifications are kept.
const qHeaders = ['TABLE_FQN', 'REVIEW_STAGE', 'REVIEW_TYPE', 'PROPOSED_LIFECYCLE_STATE'];
const qRows = [
  ['p1', 'QUARANTINE_PURGE', 'MISSING_FROM_EXTRACT', 'PURGED'],
  ['r1', 'QUARANTINE_PURGE', 'MISSING_FROM_EXTRACT', 'QUARANTINED'],
  ['q1', 'QUARANTINE_PURGE', 'QUARANTINE', 'QUARANTINED']
];
assert.deepStrictEqual(names(context.filterIntakeReviewExportRows_(qHeaders, qRows, 'QUARANTINE_PURGE', '')), ['p1', 'q1']);
assert.deepStrictEqual(names(context.filterIntakeReviewExportRows_(qHeaders, qRows, 'QUARANTINE_PURGE', 'MISSING_FROM_EXTRACT')), ['p1']);

// Sample cap must not crowd out purge verifications.
const missing = [];
for (let i = 0; i < 1000; i += 1) missing.push({ assetId: 'r' + i, purgeVerification: false });
[400, 700, 999].forEach(function (i) { missing[i] = { assetId: 'p' + i, purgeVerification: true }; });
const sample = context.prioritizeMissingReviewSamples_(missing, 250);
assert.strictEqual(sample.length, 250);
assert.deepStrictEqual(sample.slice(0, 3).map(function (item) { return item.assetId; }), ['p400', 'p700', 'p999']);
// Re-applying across batches keeps them first.
assert.strictEqual(context.prioritizeMissingReviewSamples_(sample.concat(missing.slice(0, 5)), 250)[0].assetId, 'p400');

console.log('intake-review-export-scope.test.js passed');
