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
  const groups = [];
  rowNumbers.forEach(function (rowNumber) {
    const current = groups.length ? groups[groups.length - 1] : null;
    if (current && rowNumber === current.end + 1) current.end = rowNumber;
    else groups.push({ start: rowNumber, end: rowNumber });
  });
  const objects = [];
  groups.forEach(function (group) {
    sheet.getRange(group.start, 1, group.end - group.start + 1, lastColumn).getDisplayValues().forEach(function (row) {
      objects.push(rowToObject_(headers, row));
    });
  });
  return objects;
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
  const groups = [];
  updates.forEach(function (update) {
    const current = groups.length ? groups[groups.length - 1] : null;
    if (current && update.rowNumber === current.end + 1) {
      current.end = update.rowNumber;
      current.rows.push(update.row);
    } else {
      groups.push({ start: update.rowNumber, end: update.rowNumber, rows: [update.row] });
    }
  });
  groups.forEach(function (group) {
    sheet.getRange(group.start, 1, group.rows.length, headers.length).setValues(group.rows);
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

function appendObjectRows_(sheetName, headers, objects) {
  if (!objects || !objects.length) return 0;
  const sheet = getSheet_(sheetName);
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  ensureSheetCapacity_(sheet, startRow + objects.length - 1, headers.length);
  const rows = objects.map(function (value) { return objectToRow_(headers, value); });
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
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
  upsertObject_(APP.sheets.jobs, 'RUN_ID', merged);
}

function logEvent_(caseId, assetId, eventType, fromState, toState, runId, details) {
  appendRawRows_(APP.sheets.events, [[
    uuid_(), caseId || '', assetId, eventType, fromState || '', toState || '',
    nowIso_(), getCurrentUserEmail_() || 'SYSTEM', runId || '', JSON.stringify(details || {})
  ]]);
}
