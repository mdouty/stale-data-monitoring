function headerMap_(sheet) {
  const width = sheet.getLastColumn();
  if (!width) return {};
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  return headers.reduce(function (map, header, index) {
    if (header) map[header] = index;
    return map;
  }, {});
}

function rowToObject_(headers, row) {
  const value = {};
  headers.forEach(function (header, index) {
    value[header] = row[index] === undefined ? '' : row[index];
  });
  return value;
}

function objectToRow_(headers, value) {
  return headers.map(function (header) {
    const cell = value[header];
    return cell === null || cell === undefined ? '' : cell;
  });
}

// --- Execution-scoped key-index cache --------------------------------------
// Apps Script clears module globals between executions, so this cache lives for
// exactly one execution and cannot leak stale state across runs. During import
// finalization the same large sheets (Assets_Current ~62k rows, Cases, and a
// growing Notifications) are scanned several times per batch by
// readObjectsByKeys_ and updateObjectsByKey_, each rebuilding the key->rowNumber
// map from a full key-column read. That repeated scan is the quadratic hot spot
// (O(batches x sheetRows)). We memoize {headers, keyIndex, rowsByKey, lastRow,
// lastColumn} per (resolvedSheetName, keyHeader) so repeated lookups within one
// execution scan the key column once.
//
// Correctness: the cache stores ONLY the key->rowNumber map and headers, never
// cell data — callers always re-read matched rows fresh, so in-place cell
// edits are never served stale. The entry is keyed to (lastRow, lastColumn) and
// rebuilt whenever either changes, so any append/delete auto-invalidates even if
// it bypasses the helpers below. Explicit invalidation on the mutators covers
// the one residual case the size guard cannot see: an in-place edit to a key
// cell that leaves the row count unchanged.
var SHEET_KEY_INDEX_CACHE_ = {};

function resolvedSheetCacheName_(sheetName) {
  return typeof resolveSheetName_ === 'function' ? resolveSheetName_(sheetName) : String(sheetName);
}

function invalidateSheetKeyIndexCache_(sheetName) {
  if (sheetName === undefined || sheetName === null) {
    SHEET_KEY_INDEX_CACHE_ = {};
    return;
  }
  const prefix = resolvedSheetCacheName_(sheetName) + ' ';
  Object.keys(SHEET_KEY_INDEX_CACHE_).forEach(function (cacheKey) {
    if (cacheKey.indexOf(prefix) === 0) delete SHEET_KEY_INDEX_CACHE_[cacheKey];
  });
}

function getSheetKeyIndex_(sheet, sheetName, keyHeader) {
  const cacheKey = resolvedSheetCacheName_(sheetName) + ' ' + keyHeader;
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const cached = SHEET_KEY_INDEX_CACHE_[cacheKey];
  if (cached && cached.lastRow === lastRow && cached.lastColumn === lastColumn) return cached;
  const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  const keyIndex = headers.indexOf(keyHeader);
  const rowsByKey = {};
  if (keyIndex !== -1 && lastRow > 1) {
    sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues().forEach(function (row, index) {
      const key = cleanText_(row[0]);
      if (!key) return;
      (rowsByKey[key] || (rowsByKey[key] = [])).push(index + 2);
    });
  }
  const entry = {
    headers: headers, keyIndex: keyIndex, rowsByKey: rowsByKey,
    lastRow: lastRow, lastColumn: lastColumn
  };
  SHEET_KEY_INDEX_CACHE_[cacheKey] = entry;
  return entry;
}

// Keeps cached key indexes valid across a durable write instead of forcing a full
// key-column rescan on the next read. Appends that land directly after the indexed
// range extend the index; any write that does not fit that shape drops the entry,
// so the next read rebuilds it from the sheet.
function noteSheetWrite_(sheet, sheetName, write) {
  const prefix = resolvedSheetCacheName_(sheetName) + ' ';
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  Object.keys(SHEET_KEY_INDEX_CACHE_).forEach(function (cacheKey) {
    if (cacheKey.indexOf(prefix) !== 0) return;
    const entry = SHEET_KEY_INDEX_CACHE_[cacheKey];
    const endRow = write.row + write.rows.length - 1;
    if (entry.keyIndex < 0 || entry.lastColumn !== lastColumn) { delete SHEET_KEY_INDEX_CACHE_[cacheKey]; return; }
    if (write.append && entry.lastRow === write.row - 1 && lastRow === endRow) {
      write.rows.forEach(function (row, offset) {
        const key = cleanText_(row[entry.keyIndex]);
        if (key) (entry.rowsByKey[key] || (entry.rowsByKey[key] = [])).push(write.row + offset);
      });
      entry.lastRow = lastRow;
      return;
    }
    if (!write.append && lastRow === entry.lastRow) {
      // In-place update: valid only if every written row keeps its indexed key.
      const intact = write.rows.every(function (row, offset) {
        const key = cleanText_(row[entry.keyIndex]);
        return key ? (entry.rowsByKey[key] || []).indexOf(write.row + offset) !== -1 : true;
      });
      if (intact) return;
    }
    delete SHEET_KEY_INDEX_CACHE_[cacheKey];
  });
}

function readObjects_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  const headers = values.shift();
  return values.filter(function (row) {
    return row.some(function (cell) { return cell !== ''; });
  }).map(function (row) { return rowToObject_(headers, row); });
}

// Like readObjects_ but fetches only the named columns, so wide sheets with many
// rows do not pay for columns the caller never reads.
function readObjectColumns_(sheetName, headers) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const allHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const wanted = (headers || []).filter(function (header) { return allHeaders.indexOf(header) !== -1; });
  const columnValues = wanted.map(function (header) {
    return sheet.getRange(2, allHeaders.indexOf(header) + 1, lastRow - 1, 1).getDisplayValues();
  });
  const objects = [];
  for (let i = 0; i < lastRow - 1; i += 1) {
    const value = {};
    let hasValue = false;
    wanted.forEach(function (header, index) {
      const cell = columnValues[index][i][0];
      value[header] = cell;
      if (cell !== '') hasValue = true;
    });
    if (hasValue) objects.push(value);
  }
  return objects;
}

function sheetHeaderIndex_(sheet, header) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return -1;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return headers.indexOf(header);
}

function readColumnValues_(sheetName, header) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const column = sheetHeaderIndex_(sheet, header) + 1;
  if (lastRow < 2 || column < 1) return [];
  return sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues();
}

function forEachMatchingSheetRows_(sheetName, matchHeader, matchValue, headers, visitor) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return 0;
  const allHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const matchIndex = allHeaders.indexOf(matchHeader);
  if (matchIndex === -1) return 0;
  const wanted = {};
  (headers || []).forEach(function (header) {
    const index = allHeaders.indexOf(header);
    if (index !== -1) wanted[header] = index;
  });
  const target = cleanText_(matchValue);
  const matchValues = sheet.getRange(2, matchIndex + 1, lastRow - 1, 1).getDisplayValues();
  const columns = Object.keys(wanted);
  const columnValues = {};
  columns.forEach(function (header) {
    columnValues[header] = sheet.getRange(2, wanted[header] + 1, lastRow - 1, 1).getDisplayValues();
  });
  let count = 0;
  for (let i = 0; i < matchValues.length; i += 1) {
    if (cleanText_(matchValues[i][0]) !== target) continue;
    const row = {};
    columns.forEach(function (header) { row[header] = columnValues[header][i][0]; });
    visitor(row, i + 2);
    count += 1;
  }
  return count;
}

function loadKeyedObjectMap_(sheetName, keyHeader) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const keyIndex = headers.indexOf(keyHeader);
  if (keyIndex === -1) return {};
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues();
  const map = {};
  values.forEach(function (row) {
    const key = cleanText_(row[keyIndex]);
    if (!key) return;
    map[key] = rowToObject_(headers, row);
  });
  return map;
}

function readObjectsByField_(sheetName, keyHeader, keyValue, limit) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];

  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const keyIndex = headers.indexOf(keyHeader);
  if (keyIndex === -1) return [];

  let rowNumbers = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1)
    .createTextFinder(String(keyValue)).matchEntireCell(true).findAll()
    .map(function(range) { return range.getRow(); })
    .sort(function(a, b) { return a - b; });

  const maxRows = Number(limit || 0);
  if (maxRows > 0 && rowNumbers.length > maxRows) {
    rowNumbers = rowNumbers.slice(rowNumbers.length - maxRows);
  }
  if (!rowNumbers.length) return [];

  const groups = [];
  rowNumbers.forEach(function(rowNumber) {
    const current = groups.length ? groups[groups.length - 1] : null;
    if (current && rowNumber === current.end + 1) {
      current.end = rowNumber;
    } else {
      groups.push({ start: rowNumber, end: rowNumber });
    }
  });

  const objects = [];
  groups.forEach(function(group) {
    const values = sheet.getRange(group.start, 1, group.end - group.start + 1, lastColumn).getDisplayValues();
    values.forEach(function(row) { objects.push(rowToObject_(headers, row)); });
  });
  return objects;
}

// sparse: the caller expects a few rows scattered across a large sheet (see groupSheetRowsForSparseIo_).
function readObjectsByKeys_(sheetName, keyHeader, keyValues, sparse) {
  const keys = {};
  (keyValues || []).forEach(function (value) {
    const key = cleanText_(value);
    if (key) keys[key] = true;
  });
  if (!Object.keys(keys).length) return [];
  const sheet = getSheet_(sheetName);
  const index = getSheetKeyIndex_(sheet, sheetName, keyHeader);
  if (index.keyIndex === -1 || index.lastRow < 2 || index.lastColumn < 1) return [];
  const rowNumbers = [];
  Object.keys(keys).forEach(function (key) {
    const rows = index.rowsByKey[key];
    if (rows) rows.forEach(function (rowNumber) { rowNumbers.push(rowNumber); });
  });
  if (!rowNumbers.length) return [];
  const groups = sparse ? groupSheetRowsForSparseIo_(rowNumbers, 100, 1000, 200) : groupSheetRowsForBulkIo_(rowNumbers);
  const objects = [];
  groups.forEach(function (group) {
    const rowCount = Math.min(group.end, index.lastRow) - group.start + 1;
    sheet.getRange(group.start, 1, rowCount, index.lastColumn).getDisplayValues().forEach(function (row, offset) {
      const rowNumber = group.start + offset;
      if (group.selectedRows[rowNumber]) objects.push(rowToObject_(index.headers, row));
    });
  });
  return objects;
}

// Which of keyValues exist in the sheet, answered from the cached key index with no cell reads.
// Use instead of readObjectsByKeys_ when the caller only needs presence: matched rows scattered
// across a large sheet are otherwise fetched as full-width windows.
function existingSheetKeys_(sheetName, keyHeader, keyValues) {
  const present = {};
  const keys = (keyValues || []).map(cleanText_).filter(Boolean);
  if (!keys.length) return present;
  const index = getSheetKeyIndex_(getSheet_(sheetName), sheetName, keyHeader);
  if (index.keyIndex === -1 || index.lastRow < 2 || index.lastColumn < 1) return present;
  keys.forEach(function (key) { if (index.rowsByKey[key]) present[key] = true; });
  return present;
}

// A few rows scattered across a large sheet: fixed 500-row windows read hundreds of times more rows
// than they return (53 rows cost about 20,500). A call costs roughly the same for 1 row as for ~100,
// so merge only rows that sit within maxGap unselected rows of each other (and keep each call under
// maxRows). More than maxGroups calls means the lookup is not sparse; use the windows then.
function groupSheetRowsForSparseIo_(rowNumbers, maxGap, maxRows, maxGroups) {
  const rows = Array.from(new Set(rowNumbers || [])).sort(function (left, right) { return left - right; });
  const groups = [];
  rows.forEach(function (rowNumber) {
    const current = groups.length ? groups[groups.length - 1] : null;
    if (current && rowNumber - current.end - 1 <= maxGap && rowNumber - current.start < maxRows) {
      current.end = rowNumber;
      current.selectedRows[rowNumber] = true;
    } else {
      const selectedRows = {};
      selectedRows[rowNumber] = true;
      groups.push({ start: rowNumber, end: rowNumber, selectedRows: selectedRows });
    }
  });
  return groups.length > maxGroups ? groupSheetRowsForBulkIo_(rows) : groups;
}

function repositoryBulkWindowSize_() {
  const configured = typeof configNumber_ === 'function' ? configNumber_('SHEET_BULK_IO_WINDOW_ROWS', 500) : 500;
  return Math.max(100, Math.min(1000, Number(configured || 500)));
}

function groupSheetRowsForBulkIo_(rowNumbers) {
  const rows = Array.from(new Set(rowNumbers || [])).sort(function (left, right) { return left - right; });
  if (!rows.length) return [];
  const contiguous = [];
  rows.forEach(function (rowNumber) {
    const current = contiguous.length ? contiguous[contiguous.length - 1] : null;
    if (current && rowNumber === current.end + 1) {
      current.end = rowNumber;
      current.selectedRows[rowNumber] = true;
    } else {
      const selectedRows = {};
      selectedRows[rowNumber] = true;
      contiguous.push({ start: rowNumber, end: rowNumber, selectedRows: selectedRows });
    }
  });
  if (contiguous.length <= 25) return contiguous;

  const windowSize = repositoryBulkWindowSize_();
  const windows = {};
  rows.forEach(function (rowNumber) {
    const start = 2 + Math.floor((rowNumber - 2) / windowSize) * windowSize;
    const key = String(start);
    if (!windows[key]) windows[key] = { start: start, end: start + windowSize - 1, selectedRows: {} };
    windows[key].selectedRows[rowNumber] = true;
  });
  return Object.keys(windows).map(function (key) { return windows[key]; }).sort(function (left, right) {
    return left.start - right.start;
  });
}

function indexObjectsBy_(objects, keyHeader) {
  return (objects || []).reduce(function (index, value) {
    const key = cleanText_(value[keyHeader]);
    if (key) index[key] = value;
    return index;
  }, {});
}

function updateObjectsByKey_(sheetName, keyHeader, objects) {
  const values = (objects || []).filter(function (value) { return cleanText_(value && value[keyHeader]); });
  if (!values.length) return 0;
  const sheet = getSheet_(sheetName);
  const index = getSheetKeyIndex_(sheet, sheetName, keyHeader);
  if (index.keyIndex === -1) throw new Error('Missing key column ' + keyHeader + ' in ' + resolveSheetName_(sheetName) + '.');
  const headers = index.headers;
  const updates = [];
  const additions = [];
  values.forEach(function (value) {
    // Preserve the prior last-occurrence-wins behavior for duplicate keys.
    const rows = index.rowsByKey[cleanText_(value[keyHeader])];
    const rowNumber = rows && rows.length ? rows[rows.length - 1] : 0;
    if (rowNumber) updates.push({ rowNumber: rowNumber, row: objectToRow_(headers, value) });
    else additions.push(objectToRow_(headers, value));
  });
  updates.sort(function (left, right) { return left.rowNumber - right.rowNumber; });
  const updatesByRow = updates.reduce(function (index, update) {
    index[update.rowNumber] = update.row;
    return index;
  }, {});
  const groups = groupSheetRowsForBulkIo_(updates.map(function (update) { return update.rowNumber; }));
  groups.forEach(function (group) {
    const rowCount = Math.min(group.end, sheet.getLastRow()) - group.start + 1;
    const range = sheet.getRange(group.start, 1, rowCount, headers.length);
    // Fully selected ranges need no read before writing. Sparse windows retain their gaps.
    const rows = Object.keys(group.selectedRows).length === rowCount
      ? Array.from({ length: rowCount }, function (_, index) { return updatesByRow[group.start + index]; })
      : range.getDisplayValues();
    Object.keys(group.selectedRows).forEach(function (rowNumberText) {
      const rowNumber = Number(rowNumberText);
      if (updatesByRow[rowNumber]) rows[rowNumber - group.start] = updatesByRow[rowNumber];
    });
    range.setValues(rows);
  });
  if (additions.length) appendRawRows_(sheetName, additions);
  return values.length;
}

function ensureSheetCapacity_(sheet, requiredRows, requiredColumns) {
  if (requiredRows > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (requiredColumns > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
}

/**
 * Google Sheets enforces a workbook-wide 10 million cell limit. Keep only a
 * modest empty-row buffer on operational sheets so iterative appends cannot be
 * blocked by historical grid capacity that contains no data.
 */
function reclaimOperationalGridCapacity_() {
  const targets = [
    APP.sheets.assetsCurrent, APP.sheets.assetsStaging, APP.sheets.assetsIndex,
    APP.sheets.intakeUpload, APP.sheets.snapshots, APP.sheets.cases, APP.sheets.events,
    APP.sheets.notifications, APP.sheets.platformActions, APP.sheets.jobs,
    APP.sheets.dashboardSummary
  ];
  const results = [];
  const prefixes = [APP.environments.DEV.sheetPrefix, APP.environments.PRD.sheetPrefix];
  prefixes.forEach(function (prefix) {
    const previous = getFoundationSpreadsheet_().getSheetByName(prefix + 'Assets_Previous');
    if (previous) {
      previous.clearContents();
      const maxRows = previous.getMaxRows();
      if (maxRows > 2) previous.deleteRows(3, maxRows - 2);
    }
  });
  targets.forEach(function (sheetName) {
    const sheet = getSheet_(sheetName);
    const usedRows = Math.max(1, sheet.getLastRow());
    const targetRows = Math.max(1000, usedRows + 1000);
    const maxRows = sheet.getMaxRows();
    if (maxRows > targetRows) sheet.deleteRows(targetRows + 1, maxRows - targetRows);
    results.push({ sheet: sheet.getName(), rows: sheet.getMaxRows(), usedRows: usedRows });
  });
  return results;
}

function pruneEvaluationSnapshots_(keepLatestRuns) {
  const sheet = getSheet_(APP.sheets.snapshots);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return 0;
  const keep = Math.max(1, Number(keepLatestRuns || configNumber_('SNAPSHOT_RETENTION_RUNS', 1)));
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const runIndex = headers.indexOf('RUN_ID');
  if (runIndex === -1) return 0;
  const runValues = sheet.getRange(2, runIndex + 1, lastRow - 1, 1).getDisplayValues();
  const uniqueRuns = [];
  const keepRuns = {};
  for (let i = runValues.length - 1; i >= 0; i -= 1) {
    const runId = cleanText_(runValues[i][0]);
    if (!runId || keepRuns[runId]) continue;
    uniqueRuns.push(runId);
    if (uniqueRuns.length <= keep) keepRuns[runId] = true;
  }
  if (!uniqueRuns.length || uniqueRuns.length <= keep) return 0;
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const retained = [headers];
  values.forEach(function (row, index) {
    if (keepRuns[cleanText_(runValues[index][0])]) retained.push(row);
  });
  if (retained.length === lastRow) return 0;
  sheet.clearContents();
  sheet.getRange(1, 1, retained.length, lastColumn).setValues(retained);
  const targetRows = Math.max(1000, retained.length + 1000);
  if (sheet.getMaxRows() > targetRows) sheet.deleteRows(targetRows + 1, sheet.getMaxRows() - targetRows);
  invalidateSheetKeyIndexCache_(APP.sheets.snapshots);
  return lastRow - retained.length;
}

function appendObjectRows_(sheetName, headers, objects) {
  if (!objects || !objects.length) return 0;
  const sheet = getSheet_(sheetName);
  const sheetWidth = sheet.getLastColumn();
  const sheetHeaders = sheetWidth
    ? sheet.getRange(1, 1, 1, sheetWidth).getDisplayValues()[0].map(cleanText_)
    : [];
  const writeHeaders = sheetHeaders.some(Boolean) ? sheetHeaders : headers;
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + objects.length - 1, writeHeaders.length);
  const rows = objects.map(function (value) { return objectToRow_(writeHeaders, value); });
  sheet.getRange(startRow, 1, rows.length, writeHeaders.length).setValues(rows);
  invalidateSheetKeyIndexCache_(sheetName);
  return rows.length;
}

function appendRawRows_(sheetName, rows) {
  if (!rows || !rows.length) return 0;
  const sheet = getSheet_(sheetName);
  const width = rows[0].length;
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + rows.length - 1, width);
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
  invalidateSheetKeyIndexCache_(sheetName);
  return rows.length;
}

function findObjectRow_(sheetName, keyHeader, keyValue) {
  const sheet = getSheet_(sheetName);
  const indexes = headerMap_(sheet);
  const keyIndex = indexes[keyHeader];
  if (keyIndex === undefined || sheet.getLastRow() < 2) return null;
  const finder = sheet.getRange(2, keyIndex + 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(keyValue)).matchEntireCell(true).findNext();
  if (!finder) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const row = sheet.getRange(finder.getRow(), 1, 1, headers.length).getDisplayValues()[0];
  return { rowNumber: finder.getRow(), value: rowToObject_(headers, row), headers: headers };
}

function upsertObject_(sheetName, keyHeader, value) {
  const sheet = getSheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const existing = findObjectRow_(sheetName, keyHeader, value[keyHeader]);
  const row = objectToRow_(headers, value);
  if (existing) {
    sheet.getRange(existing.rowNumber, 1, 1, headers.length).setValues([row]);
    return existing.rowNumber;
  }
  return appendRawRows_(sheetName, [row]) && sheet.getLastRow();
}

function clearDataRows_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  invalidateSheetKeyIndexCache_(sheetName);
}

function updateConfigValue_(key, value) {
  const sheet = getSheet_(APP.sheets.config);
  const lastRow = sheet.getLastRow();
  const keys = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues() : [];
  let rowNumber = 0;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i][0] === key) {
      rowNumber = i + 2;
      break;
    }
  }
  if (rowNumber) sheet.getRange(rowNumber, 2).setValue(value);
  else sheet.appendRow([key, value, 'Added by application']);
  invalidateConfigCache_();
}

function updateEnvironmentConfigValue_(key, value, environment) {
  const selected = normalizeEnvironment_(environment || getActiveEnvironment_());
  updateConfigValue_(selected + '_' + key, value);
}

function updateJobRun_(runId, patch) {
  const existing = findObjectRow_(APP.sheets.jobs, 'RUN_ID', runId);
  if (!existing) throw new Error('Job run not found: ' + runId);
  const merged = Object.assign({}, existing.value, patch);
  getSheet_(APP.sheets.jobs).getRange(existing.rowNumber, 1, 1, existing.headers.length)
    .setValues([objectToRow_(existing.headers, merged)]);
}

function logEvent_(caseId, assetId, eventType, fromState, toState, runId, details) {
  appendRawRows_(APP.sheets.events, [[
    uuid_(), caseId || '', assetId, eventType, fromState || '', toState || '',
    nowIso_(), getCurrentUserEmail_() || 'SYSTEM', runId || '', JSON.stringify(details || {})
  ]]);
}
