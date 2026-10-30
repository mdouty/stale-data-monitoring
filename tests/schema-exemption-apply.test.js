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

const future = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function run(options) {
  const opts = options || {};
  const calls = { exceptions: [], cases: [], assets: [], cancelled: [], events: [] };
  const cases = {
    a1: { CASE_ID: 'c1', ASSET_ID: 'a1', PLATFORM: 'SNOWFLAKE', STATE: 'NOTIFIED' },
    a2: { CASE_ID: 'c2', ASSET_ID: 'a2', PLATFORM: 'SNOWFLAKE', STATE: 'QUARANTINED' }
  };
  const assets = [
    { ASSET_ID: 'a1', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIVETRAN_LOG', OBJECT_FQN: 'SSE_DM_FIN_PRD.FIVETRAN_LOG.T1', LIFECYCLE_STATE: 'NOTIFIED', EXCEPTION_ID: '' },
    { ASSET_ID: 'a2', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIDO_TABNETSUITE', OBJECT_FQN: 'SSE_DM_FIN_PRD.FIDO_TABNETSUITE.T2', LIFECYCLE_STATE: 'QUARANTINED', EXCEPTION_ID: '' },
    { ASSET_ID: 'a3', DATABASE_NAME: 'SSE_DM_FIN_PRD', SCHEMA_NAME: 'FIVETRAN_LOG', OBJECT_FQN: 'SSE_DM_FIN_PRD.FIVETRAN_LOG.T3', LIFECYCLE_STATE: 'DETECTED', EXCEPTION_ID: '' }
  ];
  const sandbox = {
    console, Array, Object, JSON, String, Date,
    APP: { sheets: { assetsCurrent: 'Assets_Current', cases: 'Lifecycle_Cases' }, lifecycle: { exempt: 'EXEMPT' } },
    assertAdmin_: function () { return { email: 'admin@example.com' }; },
    assertEnvironmentWritable_: function () {},
    getAnyImportState_: function () { return opts.importRunning ? { runId: 'r' } : null; },
    ensureDataModelV2_: function () {},
    cleanText_: cleanText_,
    nowIso_: function () { return '2026-10-27T00:00:00.000Z'; },
    canonicalLifecycleState_: function (value) { return cleanText_(value); },
    readObjects_: function () { return assets; },
    incrementCount_: function (map, key) { const label = key || 'UNKNOWN'; map[label] = (map[label] || 0) + 1; },
    readObjectsByField_: function (sheet, field, value) {
      if (opts.missingCase && value === 'a3') return [];
      return cases[value] ? [Object.assign({}, cases[value])] : [];
    },
    upsertExceptionForAsset_: function (record) { calls.exceptions.push(record); },
    upsertObject_: function (sheet, key, record) { calls.cases.push(record); },
    updateAssetState_: function (assetId) { calls.assets.push(assetId); },
    cancelPendingPlatformActionsForAsset_: function (assetId) { calls.cancelled.push(assetId); },
    logEvent_: function (caseId, assetId, type, from, to, unused, detail) { calls.events.push({ type: type, to: to, detail: detail }); }
  };
  const context = vm.createContext(sandbox);
  ['normalizeApprovedExceptionId_'].forEach(function (name) {
    vm.runInContext(extractFunction('LifecycleService.js', name), context);
  });
  ['previewSchemaExemption', 'exemptSchemaObjects'].forEach(function (name) {
    vm.runInContext(extractFunction('AdminService.js', name), context);
  });
  return { context: context, calls: calls };
}

// Expiry is required and must be in the future.
assert.throws(function () { run().context.exemptSchemaObjects('SSE_DM_FIN_PRD', ['FIVETRAN_LOG'], 'EDG-EXC-2026-002', '2020-01-01', false); }, /future expiry/);
assert.throws(function () { run().context.exemptSchemaObjects('SSE_DM_FIN_PRD', ['FIVETRAN_LOG'], 'EDG-EXC-2026-002', '', false); }, /future expiry/);

// Dry run counts only and writes nothing.
let t = run();
const dry = JSON.parse(JSON.stringify(t.context.exemptSchemaObjects('SSE_DM_FIN_PRD', ['FIVETRAN_LOG', 'FIDO_TABNETSUITE'], 'EDG-EXC-2026-002', future, true)));
assert.strictEqual(dry.dryRun, true);
assert.strictEqual(dry.matchedAssets, 3);
assert.strictEqual(t.calls.exceptions.length + t.calls.cases.length, 0, 'dry run must not write');

// Real run exempts every matched object, including QUARANTINED, and ignores states.
t = run();
const done = JSON.parse(JSON.stringify(t.context.exemptSchemaObjects('SSE_DM_FIN_PRD', ['FIVETRAN_LOG', 'FIDO_TABNETSUITE'], 'EDG-EXC-2026-002', future, false)));
assert.strictEqual(done.processed, 2);
assert.strictEqual(done.failed, 1, 'a3 has no lifecycle case and is reported, not skipped silently');
assert.strictEqual(done.details[0].assetId, 'a3');
assert.deepStrictEqual(t.calls.exceptions.map(function (r) { return r.ASSET_ID; }).sort(), ['a1', 'a2']);
assert(t.calls.exceptions.every(function (r) { return r.EXCEPTION_ID === 'EDG-EXC-2026-002' && r.EXPIRES_AT === future; }));
assert(t.calls.cases.every(function (c) { return c.STATE === 'EXEMPT'; }));
assert.deepStrictEqual(t.calls.cancelled.sort(), ['a1', 'a2']);
assert(t.calls.events.every(function (e) { return e.type === 'EXCEPTION_APPROVED' && e.detail.bulkSchemaExemption === true; }));

// Refused while an import is running.
t = run({ importRunning: true });
assert.throws(function () { t.context.exemptSchemaObjects('SSE_DM_FIN_PRD', ['FIVETRAN_LOG'], 'EDG-EXC-2026-002', future, false); }, /import is running/);
assert.strictEqual(t.calls.exceptions.length, 0);

console.log('schema-exemption-apply.test.js passed');
