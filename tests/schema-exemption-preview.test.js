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
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
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
  { ASSET_ID: 'a1', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIDO_TABNETSUITE', LIFECYCLE_STATE: 'NOTIFIED', EXCEPTION_ID: '' },
  { ASSET_ID: 'a2', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIDO_TABNETSUITE_FINANCIALMASTER', LIFECYCLE_STATE: 'QUARANTINED', EXCEPTION_ID: '' },
  { ASSET_ID: 'a3', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIVETRAN_LOG', LIFECYCLE_STATE: 'DETECTED', EXCEPTION_ID: 'EDG-EXC-2026-001' },
  { ASSET_ID: 'a4', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIDO_TABNETSUITE_OTHER', LIFECYCLE_STATE: 'DETECTED', EXCEPTION_ID: '' },
  { ASSET_ID: 'a5', DATABASE_NAME: 'OTHER_DB', SCHEMA_NAME: 'FIVETRAN_LOG', LIFECYCLE_STATE: 'DETECTED', EXCEPTION_ID: '' },
  { ASSET_ID: 'a6', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'fivetran_log', LIFECYCLE_STATE: '', EXCEPTION_ID: '' }
];

let writes = 0;
const sandbox = {
  console, Array, Object, JSON, String,
  assertAdmin_: function () {},
  cleanText_: cleanText_,
  APP: { sheets: { assetsCurrent: 'Assets_Current' } },
  readObjects_: function (sheet) { assert.strictEqual(sheet, 'Assets_Current'); return assets; },
  incrementCount_: function (map, key) { const label = key || 'UNKNOWN'; map[label] = (map[label] || 0) + 1; },
  upsertObject_: function () { writes += 1; },
  updateObjectsByKey_: function () { writes += 1; }
};
const context = vm.createContext(sandbox);
vm.runInContext(extractFunction('AdminService.js', 'previewSchemaExemption'), context);

const result = JSON.parse(JSON.stringify(context.previewSchemaExemption('sse_dm_fin_prd', ['FIDO_TABNETSUITE', 'FIDO_TABNETSUITE_FINANCIALMASTER', 'FIVETRAN_LOG'])));

// Exact schema match only: FIDO_TABNETSUITE_OTHER is not covered by FIDO_TABNETSUITE.
// Other databases are excluded. Schema and database names compare case-insensitively.
assert.strictEqual(result.database, 'SSE_DM_FIN_PRD');
assert.strictEqual(result.matchedAssets, 4);
assert.deepStrictEqual(result.byState, { NOTIFIED: 1, QUARANTINED: 1, DETECTED: 1, UNKNOWN: 1 });
assert.deepStrictEqual(result.existingExceptions, { 'EDG-EXC-2026-001': 1 });
assert.strictEqual(writes, 0, 'preview must be read-only');

// Object list is opt-in and read-only.
const listed = JSON.parse(JSON.stringify(context.previewSchemaExemption('SSE_DM_FIN_PRD', ['FIVETRAN_LOG'], true)));
assert.strictEqual(listed.objects.length, 2);
assert.deepStrictEqual(listed.objects.map(function (o) { return o.assetId; }), ['a3', 'a6']);
assert.strictEqual(listed.objects[0].exceptionId, 'EDG-EXC-2026-001');
assert.strictEqual(listed.objects[1].lifecycleState, 'UNKNOWN');
assert.strictEqual(result.objects, undefined, 'list is omitted unless requested');
assert.strictEqual(writes, 0, 'preview must be read-only');

assert.throws(function () { context.previewSchemaExemption('', ['FIVETRAN_LOG']); }, /database name/);

console.log('schema-exemption-preview.test.js passed');
