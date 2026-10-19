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

function context(values) {
  return vm.createContext(Object.assign({ console, Set, Array, Object, Number, String, Boolean, Date, JSON, Math }, values));
}

{
  // Test 1: Shared filter helper preserves filtering semantics
  const mockAssets = Array.from({ length: 30 }, (_, i) => ({
    ASSET_ID: 'asset-' + i,
    OBJECT_FQN: 'schema' + i + '.table' + i,
    LIFECYCLE_STATE: ['DETECTED', 'NOTIFIED', 'ACCEPTED'][i % 3],
    ASSET_STATUS: ['STALE', 'ACTIVE', 'QUARANTINED'][i % 3],
    ASSET_TYPE: ['TABLE', 'VIEW', 'EXTERNAL'][i % 3],
    ENVIRONMENT: i < 10 ? 'PRODUCTION' : 'SANDBOX',
    DOMAIN: 'domain-' + (i % 5),
    TECHNICAL_STEWARD: i < 15 ? 'steward-a' : 'steward-b',
    BUSINESS_STEWARD: i < 20 ? 'biz-a' : 'biz-b',
    EVALUATION_STATUS: 'NOT_EVALUATED',
    CONTACT_COVERAGE_STATUS: i % 7 === 0 ? 'NO_SLACK_EMAIL' : 'OK',
    DAYS_SINCE_OPERATIONAL_ACTIVITY: '90',
    LAST_READ: '2024-01-01',
    SIZE_GB: '100',
    SNAPSHOT_AT: '2024-10-19'
  }));

  const sandbox = context({
    APP: {
      sheets: { assetsCurrent: 'assets' },
      assetStatus: { stale: 'STALE', active: 'ACTIVE', quarantined: 'QUARANTINED', purged: 'PURGED' },
      lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED', accepted: 'ACCEPTED', quarantined: 'QUARANTINED', purged: 'PURGED' }
    },
    getConfig_: () => ({ EDG_OPERATIONS_RECIPIENT: 'edgops@salesforce.com' }),
    getEnvironmentProfile_: () => ({ key: 'PRD' }),
    getActiveEnvironment_: () => 'PRD',
    getCurrentUserEmail_: () => 'user@salesforce.com',
    getUserRole_: () => 'VIEWER',
    getUserAccessEmails_: () => ['user@salesforce.com'],
    readObjects_: () => mockAssets,
    cleanText_: value => String(value == null ? '' : value).trim(),
    canonicalLifecycleState_: value => value,
    deriveAssetStatus_: (asset, state) => asset.ASSET_STATUS,
    incrementCount_: (map, key) => { map[key] = (map[key] || 0) + 1; },
    assetReadInactivityDays_: (asset) => 90,
    countMapToArray_: map => Object.keys(map).map(key => ({ label: key, value: map[key] })).sort((a, b) => b.value - a.value),
    dashboardFilterValues_: value => {
      const values = Array.isArray(value) ? value : (String(value || '').trim() ? [value] : []);
      const seen = {};
      return values.map(item => String(item || '').trim().toUpperCase()).filter(item => {
        if (!item || seen[item]) return false;
        seen[item] = true;
        return true;
      });
    },
    dashboardLifecycleStatuses_: () => ['DETECTED', 'NOTIFIED', 'ACCEPTED', 'QUARANTINED', 'PURGED'],
    canAccessAssetWithEmails_: () => true
  });

  vm.runInContext(extractFunction('DashboardService.js', 'resolveDashboardMatches_'), sandbox);

  // Test filtering produces consistent results
  const filterQuery = { assetStatuses: ['STALE'], environments: ['PRODUCTION'] };
  const result = sandbox.resolveDashboardMatches_(filterQuery, ['user@salesforce.com'], 'VIEWER');
  assert(result && result.matching, 'resolveDashboardMatches_ should return result with matching array');
  assert(result.matching.length > 0, 'Should find assets matching STALE status and PRODUCTION environment');
  assert(result.matching.every(asset => asset.ASSET_STATUS === 'STALE' && asset.ENVIRONMENT === 'PRODUCTION'),
    'All matching assets should satisfy filter criteria');
  assert(result.matching.length === result.metrics.totalAccessibleAssets || result.matching.length < result.metrics.totalAccessibleAssets,
    'Matching count should be <= total accessible count');
}

{
  // Test 2: Export-all chunking and row cap enforcement
  const mockAssets = Array.from({ length: 1200 }, (_, i) => ({
    ASSET_ID: 'asset-' + i,
    OBJECT_FQN: 'schema' + i + '.table' + i,
    LIFECYCLE_STATE: 'NOTIFIED',
    ASSET_STATUS: 'STALE',
    ENVIRONMENT: 'PRODUCTION',
    DOMAIN: 'domain-1',
    TECHNICAL_STEWARD: 'steward-a',
    BUSINESS_STEWARD: 'biz-a',
    EVALUATION_STATUS: 'NOT_EVALUATED',
    CONTACT_COVERAGE_STATUS: 'OK',
    DAYS_SINCE_OPERATIONAL_ACTIVITY: '90',
    LAST_READ: '2024-01-01',
    SIZE_GB: '100',
    SNAPSHOT_AT: '2024-10-19'
  }));

  const sandbox = context({
    APP: {
      sheets: { assetsCurrent: 'assets' },
      assetStatus: { stale: 'STALE', active: 'ACTIVE', quarantined: 'QUARANTINED', purged: 'PURGED' },
      lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED', accepted: 'ACCEPTED', quarantined: 'QUARANTINED', purged: 'PURGED' }
    },
    getConfig_: () => ({ EDG_OPERATIONS_RECIPIENT: 'edgops@salesforce.com' }),
    getEnvironmentProfile_: () => ({ key: 'PRD' }),
    getActiveEnvironment_: () => 'PRD',
    getCurrentUserEmail_: () => 'user@salesforce.com',
    getUserRole_: () => 'VIEWER',
    getUserAccessEmails_: () => ['user@salesforce.com'],
    readObjects_: () => mockAssets,
    getSheet_: () => ({
      getLastColumn: () => 12,
      getRange: () => ({ getDisplayValues: () => [['ASSET_ID', 'OBJECT_FQN', 'LIFECYCLE_STATE', 'ASSET_STATUS', 'ENVIRONMENT', 'DOMAIN', 'TECHNICAL_STEWARD', 'BUSINESS_STEWARD', 'EVALUATION_STATUS', 'CONTACT_COVERAGE_STATUS', 'LAST_READ', 'SIZE_GB']] })
    }),
    cleanText_: value => String(value == null ? '' : value).trim(),
    canonicalLifecycleState_: value => value,
    deriveAssetStatus_: (asset, state) => asset.ASSET_STATUS,
    incrementCount_: (map, key) => { map[key] = (map[key] || 0) + 1; },
    assetReadInactivityDays_: (asset) => 90,
    dashboardFilterValues_: value => {
      const values = Array.isArray(value) ? value : (String(value || '').trim() ? [value] : []);
      const seen = {};
      return values.map(item => String(item || '').trim().toUpperCase()).filter(item => {
        if (!item || seen[item]) return false;
        seen[item] = true;
        return true;
      });
    },
    canAccessAssetWithEmails_: () => true,
    Utilities: {
      formatDate: () => '20241019-1000'
    },
    Session: {
      getScriptTimeZone: () => 'America/New_York'
    }
  });

  vm.runInContext(extractFunction('DashboardService.js', 'resolveDashboardMatches_'), sandbox);
  vm.runInContext(extractFunction('DashboardService.js', 'exportDashboardAssetsChunk'), sandbox);

  // Test chunk 1: should return 500 rows, not done
  const chunk1 = sandbox.exportDashboardAssetsChunk({ query: {}, offset: 0 });
  assert.strictEqual(chunk1.rows.length, 500, 'First chunk should have 500 rows');
  assert.strictEqual(chunk1.done, false, 'First chunk should not be done');
  assert.strictEqual(chunk1.nextOffset, 500, 'First chunk nextOffset should be 500');
  assert.strictEqual(chunk1.total, 1200, 'Total should be 1200');

  // Test chunk 2: should return 500 rows
  const chunk2 = sandbox.exportDashboardAssetsChunk({ query: {}, offset: 500 });
  assert.strictEqual(chunk2.rows.length, 500, 'Second chunk should have 500 rows');
  assert.strictEqual(chunk2.done, false, 'Second chunk should not be done');
  assert.strictEqual(chunk2.nextOffset, 1000, 'Second chunk nextOffset should be 1000');

  // Test chunk 3: should return final 200 rows and be done
  const chunk3 = sandbox.exportDashboardAssetsChunk({ query: {}, offset: 1000 });
  assert.strictEqual(chunk3.rows.length, 200, 'Final chunk should have 200 rows');
  assert.strictEqual(chunk3.done, true, 'Final chunk should be done');
  assert.strictEqual(chunk3.nextOffset, 1200, 'Final chunk nextOffset should be 1200');
}

{
  // Test 3: Row cap (5000) is enforced
  const mockAssets = Array.from({ length: 5100 }, (_, i) => ({
    ASSET_ID: 'asset-' + i,
    OBJECT_FQN: 'schema.table',
    LIFECYCLE_STATE: 'NOTIFIED',
    ASSET_STATUS: 'STALE',
    ENVIRONMENT: 'PRODUCTION',
    DOMAIN: 'domain-1',
    TECHNICAL_STEWARD: 'steward-a',
    BUSINESS_STEWARD: 'biz-a',
    EVALUATION_STATUS: 'NOT_EVALUATED',
    CONTACT_COVERAGE_STATUS: 'OK',
    DAYS_SINCE_OPERATIONAL_ACTIVITY: '90',
    LAST_READ: '2024-01-01',
    SIZE_GB: '100',
    SNAPSHOT_AT: '2024-10-19'
  }));

  const sandbox = context({
    APP: {
      sheets: { assetsCurrent: 'assets' },
      assetStatus: { stale: 'STALE', active: 'ACTIVE', quarantined: 'QUARANTINED', purged: 'PURGED' },
      lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED', accepted: 'ACCEPTED', quarantined: 'QUARANTINED', purged: 'PURGED' }
    },
    getCurrentUserEmail_: () => 'user@salesforce.com',
    getUserRole_: () => 'VIEWER',
    getUserAccessEmails_: () => ['user@salesforce.com'],
    readObjects_: () => mockAssets,
    getSheet_: () => ({
      getLastColumn: () => 12,
      getRange: () => ({ getDisplayValues: () => [['ASSET_ID', 'OBJECT_FQN', 'LIFECYCLE_STATE', 'ASSET_STATUS', 'ENVIRONMENT', 'DOMAIN', 'TECHNICAL_STEWARD', 'BUSINESS_STEWARD', 'EVALUATION_STATUS', 'CONTACT_COVERAGE_STATUS', 'LAST_READ', 'SIZE_GB']] })
    }),
    cleanText_: value => String(value == null ? '' : value).trim(),
    canonicalLifecycleState_: value => value,
    deriveAssetStatus_: (asset, state) => asset.ASSET_STATUS,
    incrementCount_: (map, key) => { map[key] = (map[key] || 0) + 1; },
    assetReadInactivityDays_: (asset) => 90,
    dashboardFilterValues_: value => [],
    canAccessAssetWithEmails_: () => true,
    Utilities: { formatDate: () => '20241019-1000' },
    Session: { getScriptTimeZone: () => 'America/New_York' }
  });

  vm.runInContext(extractFunction('DashboardService.js', 'resolveDashboardMatches_'), sandbox);
  vm.runInContext(extractFunction('DashboardService.js', 'exportDashboardAssetsChunk'), sandbox);

  let errorThrown = false;
  let errorMessage = '';
  try {
    sandbox.exportDashboardAssetsChunk({ query: {}, offset: 0 });
  } catch (e) {
    errorThrown = true;
    errorMessage = e.message;
  }
  assert(errorThrown, 'Should throw error when matching rows exceed 5000');
  assert(errorMessage.indexOf('5000') !== -1 || errorMessage.indexOf('5,000') !== -1, 'Error should mention the 5000 limit');
  assert(errorMessage.indexOf('Narrow your search or filters') !== -1, 'Error should suggest narrowing search/filters');
}

{
  // Test 4: Empty result set handled correctly
  const mockAssets = Array.from({ length: 10 }, (_, i) => ({
    ASSET_ID: 'asset-' + i,
    OBJECT_FQN: 'schema.table',
    LIFECYCLE_STATE: 'NOTIFIED',
    ASSET_STATUS: 'ACTIVE',  // Not STALE
    ENVIRONMENT: 'PRODUCTION',
    DOMAIN: 'domain-1',
    TECHNICAL_STEWARD: 'steward-a',
    BUSINESS_STEWARD: 'biz-a',
    EVALUATION_STATUS: 'NOT_EVALUATED',
    CONTACT_COVERAGE_STATUS: 'OK',
    DAYS_SINCE_OPERATIONAL_ACTIVITY: '90',
    LAST_READ: '2024-01-01',
    SIZE_GB: '100',
    SNAPSHOT_AT: '2024-10-19'
  }));

  const sandbox = context({
    APP: {
      sheets: { assetsCurrent: 'assets' },
      assetStatus: { stale: 'STALE', active: 'ACTIVE', quarantined: 'QUARANTINED', purged: 'PURGED' },
      lifecycle: { detected: 'DETECTED', notified: 'NOTIFIED', accepted: 'ACCEPTED', quarantined: 'QUARANTINED', purged: 'PURGED' }
    },
    getActiveEnvironment_: () => 'PRD',
    getCurrentUserEmail_: () => 'user@salesforce.com',
    getUserRole_: () => 'VIEWER',
    getUserAccessEmails_: () => ['user@salesforce.com'],
    readObjects_: () => mockAssets,
    getSheet_: () => ({
      getLastColumn: () => 12,
      getRange: () => ({ getDisplayValues: () => [['ASSET_ID', 'OBJECT_FQN', 'LIFECYCLE_STATE', 'ASSET_STATUS', 'ENVIRONMENT', 'DOMAIN', 'TECHNICAL_STEWARD', 'BUSINESS_STEWARD', 'EVALUATION_STATUS', 'CONTACT_COVERAGE_STATUS', 'LAST_READ', 'SIZE_GB']] })
    }),
    cleanText_: value => String(value == null ? '' : value).trim(),
    canonicalLifecycleState_: value => value,
    deriveAssetStatus_: (asset, state) => asset.ASSET_STATUS,
    incrementCount_: (map, key) => { map[key] = (map[key] || 0) + 1; },
    assetReadInactivityDays_: (asset) => 90,
    dashboardFilterValues_: value => Array.isArray(value) ? value : (String(value || '').trim() ? [value] : []),
    canAccessAssetWithEmails_: () => true,
    Utilities: { formatDate: () => '20241019-1000' },
    Session: { getScriptTimeZone: () => 'America/New_York' }
  });

  vm.runInContext(extractFunction('DashboardService.js', 'resolveDashboardMatches_'), sandbox);
  vm.runInContext(extractFunction('DashboardService.js', 'exportDashboardAssetsChunk'), sandbox);

  // Query for STALE assets (but all are ACTIVE, so empty result)
  const chunk = sandbox.exportDashboardAssetsChunk({ query: { assetStatuses: ['STALE'] }, offset: 0 });
  assert.strictEqual(chunk.rows.length, 0, 'Empty result should return 0 rows');
  assert.strictEqual(chunk.done, true, 'Empty result should be done on first call');
  assert.strictEqual(chunk.total, 0, 'Empty result total should be 0');
}

console.log('Dashboard export tests passed.');
