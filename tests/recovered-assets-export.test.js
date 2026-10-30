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
  APP: { lifecycle: { active: 'ACTIVE', exempt: 'EXEMPT', exempted: 'EXEMPTED', detected: 'DETECTED', contested: 'CONTESTED', restricted: 'RESTRICTED', quarantined: 'QUARANTINED' } },
  cleanText_: function (value) { return value === null || value === undefined ? '' : String(value).trim(); }
});
vm.runInContext(extractFunction('SnowflakeAdapter.js', 'canonicalLifecycleState_'), context);
vm.runInContext(extractFunction('AdminService.js', 'latestRecoveryEvents_'), context);

const active = { a1: true, a2: true, a3: true, a4: true };
const events = [
  { ASSET_ID: 'a1', EVENT_TYPE: 'STALE_ASSET_BECAME_ACTIVE', FROM_STATE: 'NOTIFIED', TO_STATE: 'ACTIVE', EVENT_AT: '2026-01-01T00:00:00Z', RUN_ID: 'r1' },
  { ASSET_ID: 'a1', EVENT_TYPE: 'STALE_ASSET_BECAME_ACTIVE', FROM_STATE: 'DETECTED', TO_STATE: 'ACTIVE', EVENT_AT: '2026-05-01T00:00:00Z', RUN_ID: 'r2' },
  { ASSET_ID: 'a2', EVENT_TYPE: 'CASE_CREATED', FROM_STATE: '', TO_STATE: 'ACTIVE', EVENT_AT: '2026-02-01T00:00:00Z', RUN_ID: 'r1' },   // born active, never stale
  { ASSET_ID: 'a3', EVENT_TYPE: 'MANUAL_RESTORE', FROM_STATE: 'EXEMPT', TO_STATE: 'ACTIVE', EVENT_AT: '2026-03-01T00:00:00Z', RUN_ID: 'r3' },
  { ASSET_ID: 'a4', EVENT_TYPE: 'RESTORED', FROM_STATE: 'DISMISSED', TO_STATE: 'ACTIVE', EVENT_AT: '2026-03-01T00:00:00Z', RUN_ID: 'r3' },   // not a stale-workflow origin
  { ASSET_ID: 'gone', EVENT_TYPE: 'STALE_ASSET_BECAME_ACTIVE', FROM_STATE: 'NOTIFIED', TO_STATE: 'ACTIVE', EVENT_AT: '2026-03-01T00:00:00Z', RUN_ID: 'r3' } // no longer active
];
const result = context.latestRecoveryEvents_(active, events);
assert.deepStrictEqual(Object.keys(result).sort(), ['a1', 'a3']);
assert.strictEqual(result.a1.RUN_ID, 'r2', 'latest recovery wins');
assert.strictEqual(result.a3.EVENT_TYPE, 'MANUAL_RESTORE');

console.log('recovered-assets-export.test.js passed');
