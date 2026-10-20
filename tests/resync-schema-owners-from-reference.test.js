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
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '#N/A' || text === '#REF!' || text === '#VALUE!' ? '' : text;
}

function normalizeDatabaseSchemaKey_(database, schema) {
  function normalizePart(value) {
    return cleanText_(value).replace(/^"|"$/g, '').toUpperCase();
  }
  const databaseName = normalizePart(database);
  const schemaName = normalizePart(schema);
  return databaseName && schemaName ? databaseName + '.' + schemaName : '';
}

function context(values) {
  return vm.createContext(Object.assign({ console, Set, Array, Object, Number, String, Boolean, Date, JSON, Math }, values));
}

// Test 1: overwrites every schema-owner field for matched rows, even when already populated;
// leaves unmatched rows untouched.
{
  const assets = [
    // Fully populated with stale values -> every schema-owner field gets replaced.
    {
      ASSET_ID: 'a1', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1',
      SCHEMA_OWNER: 'stale@salesforce.com', SCHEMA_OWNER_NAME: 'Stale Name', SCHEMA_OWNER_USERNAME: 'stale',
      SCHEMA_OWNER_ASSIGNMENT_STATUS: 'ASSIGNED - FINAL', SCHEMA_OWNER_DOMAIN: 'StaleDomain', SCHEMA_OWNER_SUBDOMAIN: 'StaleSub'
    },
    // Blank fields -> filled in, same as backfill would do.
    {
      ASSET_ID: 'a2', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1',
      SCHEMA_OWNER: '', SCHEMA_OWNER_NAME: '', SCHEMA_OWNER_USERNAME: '',
      SCHEMA_OWNER_ASSIGNMENT_STATUS: '', SCHEMA_OWNER_DOMAIN: '', SCHEMA_OWNER_SUBDOMAIN: ''
    },
    // No match in lookup -> counted as noMatch, left completely alone.
    {
      ASSET_ID: 'a3', DATABASE_NAME: 'DBX', SCHEMA_NAME: 'SCHEMAX',
      SCHEMA_OWNER: 'keepme@salesforce.com', SCHEMA_OWNER_NAME: 'Keep Me', SCHEMA_OWNER_USERNAME: 'keepme',
      SCHEMA_OWNER_ASSIGNMENT_STATUS: 'CONFIRMED', SCHEMA_OWNER_DOMAIN: 'KeepDomain', SCHEMA_OWNER_SUBDOMAIN: 'KeepSub'
    },
    // Row with no ASSET_ID should be skipped from scanning entirely.
    { ASSET_ID: '', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1' }
  ];
  const lookup = {
    owners: {
      'DB1.SCHEMA1': {
        email: 'owner@salesforce.com', name: 'Owner', username: 'owner',
        status: 'CONFIRMED', domain: 'Customer', subDomain: 'Onboarding & Performance'
      }
    }
  };
  let updateCallArgs = null;
  const sandbox = context({
    cleanText_: cleanText_,
    normalizeDatabaseSchemaKey_: normalizeDatabaseSchemaKey_,
    nowIso_: () => '2026-10-20T00:00:00.000Z',
    assertAdmin_: () => ({ email: 'admin@salesforce.com', role: 'ADMIN' }),
    assertEnvironmentWritable_: () => ({ key: 'DEV', readOnly: false }),
    ensureDataModelV2_: () => {},
    readObjects_: () => assets,
    loadSchemaOwnerLookup_: () => lookup,
    updateObjectsByKey_: (sheetName, keyHeader, objects) => { updateCallArgs = { sheetName, keyHeader, objects }; return objects.length; },
    APP: { sheets: { assetsCurrent: 'Assets_Current' } }
  });
  vm.runInContext(extractFunction('AdminService.js', 'resyncSchemaOwnersFromReference'), sandbox);
  const result = sandbox.resyncSchemaOwnersFromReference();

  assert.strictEqual(result.scanned, 3, 'should scan only rows with an ASSET_ID');
  assert.strictEqual(result.updated, 2, 'a1 and a2 should be updated');
  assert.strictEqual(result.noMatch, 1, 'a3 has no lookup match');

  // a1: already-populated fields are overwritten with the reference sheet's current values.
  assert.strictEqual(assets[0].SCHEMA_OWNER, 'owner@salesforce.com');
  assert.strictEqual(assets[0].SCHEMA_OWNER_NAME, 'Owner');
  assert.strictEqual(assets[0].SCHEMA_OWNER_USERNAME, 'owner');
  assert.strictEqual(assets[0].SCHEMA_OWNER_ASSIGNMENT_STATUS, 'CONFIRMED');
  assert.strictEqual(assets[0].SCHEMA_OWNER_DOMAIN, 'Customer');
  assert.strictEqual(assets[0].SCHEMA_OWNER_SUBDOMAIN, 'Onboarding & Performance');

  // a2: blank fields are filled in.
  assert.strictEqual(assets[1].SCHEMA_OWNER, 'owner@salesforce.com');
  assert.strictEqual(assets[1].SCHEMA_OWNER_DOMAIN, 'Customer');
  assert.strictEqual(assets[1].SCHEMA_OWNER_SUBDOMAIN, 'Onboarding & Performance');

  // a3: no match -> every field left exactly as-is.
  assert.strictEqual(assets[2].SCHEMA_OWNER, 'keepme@salesforce.com');
  assert.strictEqual(assets[2].SCHEMA_OWNER_NAME, 'Keep Me');
  assert.strictEqual(assets[2].SCHEMA_OWNER_DOMAIN, 'KeepDomain');
  assert.strictEqual(assets[2].SCHEMA_OWNER_SUBDOMAIN, 'KeepSub');

  assert(updateCallArgs, 'updateObjectsByKey_ should be called since there were updates');
  assert.strictEqual(updateCallArgs.sheetName, 'Assets_Current');
  assert.strictEqual(updateCallArgs.keyHeader, 'ASSET_ID');
  assert.strictEqual(updateCallArgs.objects.length, 2);
  assert.deepStrictEqual(Array.prototype.map.call(updateCallArgs.objects, (o) => o.ASSET_ID).sort(), ['a1', 'a2']);
}

// Test 2: when nothing matches, updateObjectsByKey_ is never called.
{
  const assets = [
    { ASSET_ID: 'b1', DATABASE_NAME: 'DBX', SCHEMA_NAME: 'SCHEMAX', SCHEMA_OWNER: 'keep@salesforce.com' }
  ];
  let updateCalled = false;
  const sandbox = context({
    cleanText_: cleanText_,
    normalizeDatabaseSchemaKey_: normalizeDatabaseSchemaKey_,
    nowIso_: () => '2026-10-20T00:00:00.000Z',
    assertAdmin_: () => ({ email: 'admin@salesforce.com', role: 'ADMIN' }),
    assertEnvironmentWritable_: () => ({ key: 'PRD', readOnly: false }),
    ensureDataModelV2_: () => {},
    readObjects_: () => assets,
    loadSchemaOwnerLookup_: () => ({ owners: {} }),
    updateObjectsByKey_: () => { updateCalled = true; },
    APP: { sheets: { assetsCurrent: 'Assets_Current' } }
  });
  vm.runInContext(extractFunction('AdminService.js', 'resyncSchemaOwnersFromReference'), sandbox);
  const result = sandbox.resyncSchemaOwnersFromReference();
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.noMatch, 1);
  assert.strictEqual(updateCalled, false, 'updateObjectsByKey_ must not be invoked when there is nothing to update');
  assert.strictEqual(assets[0].SCHEMA_OWNER, 'keep@salesforce.com', 'unmatched row must be left untouched');
}

console.log('resync-schema-owners-from-reference.test.js passed');
