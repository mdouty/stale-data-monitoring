// Read-only: finds conflicting rows in Assets_Current (duplicate keys, state vs case/dates/status). Writes nothing. Run findAssetConflicts.
function findAssetConflicts() {
  const assets = readObjectColumns_(APP.sheets.assetsCurrent, [
    'ASSET_ID', 'OBJECT_FQN', 'SNOWFLAKE_TABLE_ID', 'LIFECYCLE_STATE', 'ASSET_STATUS', 'CONTEST_DEADLINE',
    'STALE_DESIGNATION_DATE', 'EXCEPTION_ID', 'EXCEPTION_STATUS', 'SOURCE_ROW'
  ]);
  const caseState = {};
  readObjectColumns_(APP.sheets.cases, ['ASSET_ID', 'STATE']).forEach(function (c) {
    const id = cleanText_(c.ASSET_ID);
    (caseState[id] = caseState[id] || {})[cleanText_(c.STATE).toUpperCase()] = true;
  });

  const open = [APP.lifecycle.detected, APP.lifecycle.notified, APP.lifecycle.contested, APP.lifecycle.accepted, APP.lifecycle.restricted];
  const conflicts = {};
  const csvRows = [['ISSUE', 'OBJECT_FQN', 'ASSET_ID', 'LIFECYCLE_STATE', 'SOURCE_ROW', 'DETAIL']];
  const add = function (type, a, detail) {
    const list = conflicts[type] = conflicts[type] || [];
    list.push([a.OBJECT_FQN, a.ASSET_ID, a.LIFECYCLE_STATE, a.SOURCE_ROW ? 'src row ' + a.SOURCE_ROW : '', detail || ''].join(' | '));
    csvRows.push([type, a.OBJECT_FQN, a.ASSET_ID, a.LIFECYCLE_STATE, a.SOURCE_ROW, detail || '']);
  };
  const group = function (keyOf, type) {
    const seen = {};
    assets.forEach(function (a) { const k = keyOf(a); if (k) (seen[k] = seen[k] || []).push(a); });
    Object.keys(seen).forEach(function (k) {
      if (seen[k].length > 1) seen[k].forEach(function (a) { add(type, a, 'key ' + k + ' x' + seen[k].length); });
    });
  };

  group(function (a) { return cleanText_(a.ASSET_ID); }, 'DUPLICATE_ASSET_ID');
  group(function (a) { return cleanText_(a.OBJECT_FQN).toUpperCase(); }, 'DUPLICATE_FQN_CASE_INSENSITIVE');
  group(function (a) { return cleanText_(a.SNOWFLAKE_TABLE_ID); }, 'DUPLICATE_SNOWFLAKE_TABLE_ID');

  assets.forEach(function (a) {
    const state = cleanText_(a.LIFECYCLE_STATE).toUpperCase();
    const deadline = cleanText_(a.CONTEST_DEADLINE);
    const cases = Object.keys(caseState[cleanText_(a.ASSET_ID)] || {});
    if (open.indexOf(state) !== -1 && !cases.length) add('OPEN_STATE_NO_CASE', a);
    if (cases.length && cases.indexOf(state) === -1) add('STATE_DIFFERS_FROM_CASE', a, 'case ' + cases.join('/'));
    if (cases.length > 1) add('MULTIPLE_CASE_STATES', a, cases.join('/'));
    if ((state === 'ACTIVE' || state === 'EXCLUDED') && deadline) add('ACTIVE_BUT_HAS_CONTEST_DEADLINE', a, deadline);
    if ((state === 'DETECTED' || state === 'NOTIFIED') && !deadline) add('NOTIFIED_NO_CONTEST_DEADLINE', a);
    if (!cleanText_(a.ASSET_ID)) add('BLANK_ASSET_ID', a);
    const exempt = state === 'EXEMPT' || state === 'EXEMPTED';
    if (exempt && !cleanText_(a.EXCEPTION_ID)) add('EXEMPT_NO_EXCEPTION_ID', a);
    if (!exempt && cleanText_(a.EXCEPTION_STATUS).toUpperCase() === 'APPROVED') add('APPROVED_EXCEPTION_BUT_NOT_EXEMPT', a, cleanText_(a.EXCEPTION_ID));
    const status = cleanText_(a.ASSET_STATUS).toUpperCase();
    if (status && status !== deriveAssetStatus_(a, a.LIFECYCLE_STATE)) add('ASSET_STATUS_NOT_DERIVED_FROM_STATE', a, 'status ' + status);
  });

  const report = SpreadsheetApp.create('stale_assets_conflicts_' + getActiveEnvironment_() + '_' + nowIso_().slice(0, 10));
  const reportSheet = report.getSheets()[0];
  reportSheet.getRange(1, 1, csvRows.length, csvRows[0].length).setNumberFormat('@');
  const chunk = 5000;
  for (let i = 0; i < csvRows.length; i += chunk) {
    const part = csvRows.slice(i, i + chunk).map(function (r) { return r.map(function (v) { return cleanText_(v); }); });
    reportSheet.getRange(i + 1, 1, part.length, part[0].length).setValues(part);
  }
  Logger.log('Report: ' + (csvRows.length - 1) + ' conflict rows -> ' + report.getName() + ' | ' + report.getUrl() + ' | id ' + report.getId());

  const types = Object.keys(conflicts).sort(function (x, y) { return conflicts[y].length - conflicts[x].length; });
  Logger.log('Env: ' + getActiveEnvironment_() + ' | rows scanned ' + assets.length + '\n' + (types.length ? types.map(function (t) {
    return t + ': ' + conflicts[t].length + '\n  ' + conflicts[t].slice(0, 10).join('\n  ');
  }).join('\n') : 'No conflicts found'));
}
