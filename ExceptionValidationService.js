function normalizeSpreadsheetId_(value) {
  const supplied = cleanText_(value);
  if (!supplied) return '';
  const urlMatch = supplied.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const spreadsheetId = urlMatch ? urlMatch[1] : supplied;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error('Enter a valid exception database Google Sheet ID or URL.');
  }
  return spreadsheetId;
}

function validateExceptionDatabaseConfiguration_(spreadsheetId, sheetName) {
  const source = openExceptionDatabase_(spreadsheetId, sheetName);
  const columns = getExceptionDatabaseColumns_(source.sheet);
  return {
    spreadsheetId: spreadsheetId,
    sheetName: source.sheet.getName(),
    exceptionIdColumn: columns.exceptionIdColumn,
    statusColumn: columns.statusColumn
  };
}

function validateActiveException_(exceptionId) {
  const normalizedId = normalizeExceptionRequestId_(exceptionId);
  const config = getConfig_();
  const spreadsheetId = normalizeSpreadsheetId_(config.EXCEPTION_DATABASE_SPREADSHEET_ID);
  const sheetName = cleanText_(config.EXCEPTION_DATABASE_SHEET_NAME) || 'Exception Log';
  if (!spreadsheetId) {
    throw new Error('Exception validation is not configured. An administrator must connect the exception database before contests can be submitted.');
  }

  const source = openExceptionDatabase_(spreadsheetId, sheetName);
  const columns = getExceptionDatabaseColumns_(source.sheet);
  const lastRow = source.sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('Exception ' + normalizedId + ' was not found. Confirm the ID in the exception application and try again.');
  }

  const idRange = source.sheet.getRange(2, columns.exceptionIdColumn, lastRow - 1, 1);
  const match = idRange.createTextFinder(normalizedId)
    .matchEntireCell(true)
    .matchCase(false)
    .useRegularExpression(false)
    .findNext();
  if (!match) {
    throw new Error('Exception ' + normalizedId + ' was not found. Confirm the ID in the exception application and try again.');
  }

  const status = cleanText_(source.sheet.getRange(match.getRow(), columns.statusColumn).getDisplayValue()).toUpperCase();
  if (status !== 'ACTIVE') {
    throw new Error('Exception ' + normalizedId + ' is ' + (status || 'missing a status') + ', not ACTIVE. Wait for approval or resolve the exception status before contesting.');
  }
  return {
    exceptionId: normalizedId,
    status: 'ACTIVE',
    sheetName: source.sheet.getName(),
    rowNumber: match.getRow()
  };
}

function openExceptionDatabase_(spreadsheetId, sheetName) {
  let spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error('The exception database could not be reached. Confirm the spreadsheet ID and sharing permissions; the contest was not submitted.');
  }
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('The exception database does not contain the configured sheet "' + sheetName + '". The contest was not submitted.');
  }
  return { spreadsheet: spreadsheet, sheet: sheet };
}

function getExceptionDatabaseColumns_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('The exception database sheet is empty. The contest was not submitted.');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (value) {
    return cleanText_(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  });
  const exceptionIdIndex = headers.indexOf('EXCEPTION_ID');
  const statusIndex = headers.indexOf('STATUS');
  if (exceptionIdIndex === -1 || statusIndex === -1) {
    throw new Error('The exception database must contain Exception_ID and Status columns. The contest was not submitted.');
  }
  return { exceptionIdColumn: exceptionIdIndex + 1, statusColumn: statusIndex + 1 };
}
