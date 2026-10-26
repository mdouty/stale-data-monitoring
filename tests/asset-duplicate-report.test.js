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

const assets = [
  { ASSET_ID: 'a1', OBJECT_FQN: 'DB.S.ORDERS' },
  { ASSET_ID: 'a1', OBJECT_FQN: 'DB.S.ORDERS' },     // duplicate ASSET_ID
  { ASSET_ID: 'a2', OBJECT_FQN: 'DB.S.Orders' },     // case-variant FQN of a3
  { ASSET_ID: 'a3', OBJECT_FQN: 'DB.S.ORDERS' },
  { ASSET_ID: 'a4', OBJECT_FQN: 'DB.S.CUSTOMERS' },
  { ASSET_ID: '', OBJECT_FQN: '' }                    // blank rows are ignored
];

let writes = 0;
const sandbox = {
  console: { log: function () {} }, Array, Object, Set, JSON, String,
  APP: { sheets: { assetsCurrent: 'Assets_Current' } },
  assertAdmin_: function () {},
  getActiveEnvironment_: function () { return 'DEV'; },
  readObjects_: function (sheet) { assert.strictEqual(sheet, 'Assets_Current'); return assets; },
  cleanText_: cleanText_,
  updateObjectsByKey_: function () { writes += 1; }
};
const context = vm.createContext(sandbox);
vm.runInContext(extractFunction('AdminService.js', 'reportAssetDuplicates'), context);
const result = context.reportAssetDuplicates();

assert.strictEqual(result.environment, 'DEV');
assert.strictEqual(result.scanned, 6);
assert.strictEqual(result.duplicateAssetIdValues, 1);
assert.strictEqual(result.rowsWithDuplicateAssetId, 2);
assert.strictEqual(result.duplicateFqnValues, 1);
assert.strictEqual(result.rowsWithDuplicateFqn, 4);
// JSON round-trip: arrays built inside the vm context have a different prototype.
const plain = JSON.parse(JSON.stringify(result));
assert.deepStrictEqual(plain.sampleDuplicateAssetIds, ['a1']);
assert.deepStrictEqual(plain.sampleDuplicateFqns, [
  { objectFqn: 'DB.S.ORDERS', variants: ['DB.S.ORDERS', 'DB.S.Orders'] }
]);
assert.strictEqual(writes, 0, 'diagnostic must be read-only');

console.log('asset-duplicate-report.test.js passed');
