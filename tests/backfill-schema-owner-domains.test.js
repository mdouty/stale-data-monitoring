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

// Test 1: backfills only empty fields, skips already-populated ones, counts no-match rows.
{
  const assets = [
    // Both fields empty, has a match -> both filled.
    { ASSET_ID: 'a1', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1', SCHEMA_OWNER_DOMAIN: '', SCHEMA_OWNER_SUBDOMAIN: '' },
    // Domain already set, subdomain empty -> only subdomain filled, domain untouched.
    { ASSET_ID: 'a2', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1', SCHEMA_OWNER_DOMAIN: 'PreExisting', SCHEMA_OWNER_SUBDOMAIN: '' },
    // Both already populated -> left alone entirely, not included in update batch.
    { ASSET_ID: 'a3', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1', SCHEMA_OWNER_DOMAIN: 'Existing', SCHEMA_OWNER_SUBDOMAIN: 'ExistingSub' },
    // Both empty, no match in lookup -> counted as noMatch, left empty.
    { ASSET_ID: 'a4', DATABASE_NAME: 'DBX', SCHEMA_NAME: 'SCHEMAX', SCHEMA_OWNER_DOMAIN: '', SCHEMA_OWNER_SUBDOMAIN: '' },
    // Row with no ASSET_ID should be skipped from scanning entirely.
    { ASSET_ID: '', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1', SCHEMA_OWNER_DOMAIN: '', SCHEMA_OWNER_SUBDOMAIN: '' }
  ];
  const lookup = {
    owners: {
      'DB1.SCHEMA1': { email: 'owner@salesforce.com', name: 'Owner', username: 'owner', status: 'CONFIRMED', domain: 'Customer', subDomain: 'Onboarding & Performance' }
    }
  };
  let updateCallArgs = null;
  const sandbox = context({
    cleanText_: cleanText_,
    normalizeDatabaseSchemaKey_: normalizeDatabaseSchemaKey_,
    nowIso_: () => '2026-10-19T00:00:00.000Z',
    assertAdmin_: () => ({ email: 'admin@salesforce.com', role: 'ADMIN' }),
    assertEnvironmentWritable_: () => ({ key: 'DEV', readOnly: false }),
    ensureDataModelV2_: () => {},
    readObjects_: () => assets,
    loadSchemaOwnerLookup_: () => lookup,
    updateObjectsByKey_: (sheetName, keyHeader, objects) => { updateCallArgs = { sheetName, keyHeader, objects }; return objects.length; },
    APP: { sheets: { assetsCurrent: 'Assets_Current' } }
  });
  vm.runInContext(extractFunction('AdminService.js', 'backfillSchemaOwnerDomains'), sandbox);
  const result = sandbox.backfillSchemaOwnerDomains();

  assert.strictEqual(result.scanned, 4, 'should scan only rows with an ASSET_ID');
  assert.strictEqual(result.updated, 2, 'a1 and a2 should be updated');
  assert.strictEqual(result.noMatch, 1, 'a4 has no lookup match');

  assert.strictEqual(assets[0].SCHEMA_OWNER_DOMAIN, 'Customer');
  assert.strictEqual(assets[0].SCHEMA_OWNER_SUBDOMAIN, 'Onboarding & Performance');

  assert.strictEqual(assets[1].SCHEMA_OWNER_DOMAIN, 'PreExisting', 'existing domain must not be clobbered');
  assert.strictEqual(assets[1].SCHEMA_OWNER_SUBDOMAIN, 'Onboarding & Performance');

  assert.strictEqual(assets[2].SCHEMA_OWNER_DOMAIN, 'Existing');
  assert.strictEqual(assets[2].SCHEMA_OWNER_SUBDOMAIN, 'ExistingSub');

  assert.strictEqual(assets[3].SCHEMA_OWNER_DOMAIN, '', 'no-match row stays empty');
  assert.strictEqual(assets[3].SCHEMA_OWNER_SUBDOMAIN, '');

  assert(updateCallArgs, 'updateObjectsByKey_ should be called since there were updates');
  assert.strictEqual(updateCallArgs.sheetName, 'Assets_Current');
  assert.strictEqual(updateCallArgs.keyHeader, 'ASSET_ID');
  assert.strictEqual(updateCallArgs.objects.length, 2);
  assert.deepStrictEqual(Array.prototype.map.call(updateCallArgs.objects, (o) => o.ASSET_ID).sort(), ['a1', 'a2']);
}

// Test 2: when nothing needs updating, updateObjectsByKey_ is never called.
{
  const assets = [
    { ASSET_ID: 'b1', DATABASE_NAME: 'DB1', SCHEMA_NAME: 'SCHEMA1', SCHEMA_OWNER_DOMAIN: 'Already', SCHEMA_OWNER_SUBDOMAIN: 'Set' }
  ];
  let updateCalled = false;
  const sandbox = context({
    cleanText_: cleanText_,
    normalizeDatabaseSchemaKey_: normalizeDatabaseSchemaKey_,
    nowIso_: () => '2026-10-19T00:00:00.000Z',
    assertAdmin_: () => ({ email: 'admin@salesforce.com', role: 'ADMIN' }),
    assertEnvironmentWritable_: () => ({ key: 'PRD', readOnly: false }),
    ensureDataModelV2_: () => {},
    readObjects_: () => assets,
    loadSchemaOwnerLookup_: () => ({ owners: {} }),
    updateObjectsByKey_: () => { updateCalled = true; },
    APP: { sheets: { assetsCurrent: 'Assets_Current' } }
  });
  vm.runInContext(extractFunction('AdminService.js', 'backfillSchemaOwnerDomains'), sandbox);
  const result = sandbox.backfillSchemaOwnerDomains();
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.noMatch, 0);
  assert.strictEqual(updateCalled, false, 'updateObjectsByKey_ must not be invoked when there is nothing to update');
}

console.log('backfill-schema-owner-domains.test.js passed');
