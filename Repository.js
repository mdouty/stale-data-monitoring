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

function readObjectsByKeys_(sheetName, keyHeader, keyValues) {
  const keys = {};
  (keyValues || []).forEach(function (value) {
    const key = cleanText_(value);
    if (key) keys[key] = true;
  });
  if (!Object.keys(keys).length) return [];
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const keyIndex = headers.indexOf(keyHeader);
  if (keyIndex === -1) return [];
  const keyColumn = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues();
  const rowNumbers = [];
  keyColumn.forEach(function (row, index) {
    if (keys[cleanText_(row[0])]) rowNumbers.push(index + 2);
  });
  const groups = groupSheetRowsForBulkIo_(rowNumbers);
  const objects = [];
  groups.forEach(function (group) {
    const rowCount = Math.min(group.end, lastRow) - group.start + 1;
    sheet.getRange(group.start, 1, rowCount, lastColumn).getDisplayValues().forEach(function (row, index) {
      const rowNumber = group.start + index;
      if (group.selectedRows[rowNumber]) objects.push(rowToObject_(headers, row));
    });
  });
  return objects;
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
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const keyIndex = headers.indexOf(keyHeader);
  if (keyIndex === -1) throw new Error('Missing key column ' + keyHeader + ' in ' + resolveSheetName_(sheetName) + '.');
  const rowByKey = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, keyIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function (row, index) {
      const key = cleanText_(row[0]);
      if (key) rowByKey[key] = index + 2;
    });
  }
  const updates = [];
  const additions = [];
  values.forEach(function (value) {
    const rowNumber = rowByKey[cleanText_(value[keyHeader])];
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
    APP.sheets.snapshots, APP.sheets.cases, APP.sheets.events,
    APP.sheets.notifications, APP.sheets.platformActions, APP.sheets.jobs,
    APP.sheets.dashboardSummary
  ];
  const results = [];
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
  return rows.length;
}

function appendRawRows_(sheetName, rows) {
  if (!rows || !rows.length) return 0;
  const sheet = getSheet_(sheetName);
  const width = rows[0].length;
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + rows.length - 1, width);
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
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
