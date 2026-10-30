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

function run(configuredId) {
  const opened = [];
  const foundation = { id: 'FOUNDATION', sheets: {} };
  const makeBook = function (id) {
    const book = {
      id: id, sheets: {},
      getSheetByName: function (name) { return book.sheets[name]; },
      insertSheet: function (name) {
        const sheet = {
          name: name, rowsWritten: 0,
          getName: function () { return name; }, clearContents: function () {}, hideSheet: function () {},
          getRange: function () { return { setValues: function (values) { sheet.rowsWritten += values.length; } }; }
        };
        book.sheets[name] = sheet;
        return sheet;
      }
    };
    return book;
  };
  const books = { FOUNDATION: makeBook('FOUNDATION'), OTHER: makeBook('OTHER') };
  const sandbox = {
    Math, Array,
    cleanText_: cleanText_,
    APP: { foundationSpreadsheetId: 'FOUNDATION', sheets: { intakeUpload: 'Intake_Upload' } },
    getConfig_: function () { return configuredId === undefined ? {} : { INTAKE_STAGING_SPREADSHEET_ID: configuredId }; },
    getFoundationSpreadsheet_: function () { opened.push('foundation-accessor'); return books.FOUNDATION; },
    SpreadsheetApp: { openById: function (id) { opened.push(id); return books[id]; }, flush: function () {} },
    resolveSheetName_: function (name, environment) { return environment + '_' + name; },
    ensureSheetCapacity_: function () {}
  };
  const context = vm.createContext(sandbox);
  ['intakeStagingSpreadsheetId_', 'getIntakeStagingSpreadsheet_', 'writeIntakeUploadSheet_'].forEach(function (name) {
    vm.runInContext(extractFunction('SnowflakeAdapter.js', name), context);
  });
  const sheet = context.writeIntakeUploadSheet_(['A', 'B'], [['1', '2'], ['3', '4']], 'PRD');
  return { id: context.intakeStagingSpreadsheetId_(), sheet: sheet, books: books, opened: opened };
}

// Default: no setting -> the foundation workbook, exactly as before.
let result = run(undefined);
assert.strictEqual(result.id, 'FOUNDATION');
assert(result.books.FOUNDATION.sheets.PRD_Intake_Upload, 'stages in the foundation workbook by default');
assert.deepStrictEqual(result.opened, ['foundation-accessor']);

// Blank setting behaves like no setting.
result = run('  ');
assert.strictEqual(result.id, 'FOUNDATION');

// Configured: the staged CSV goes to the other workbook and nothing is created in the foundation.
result = run('OTHER');
assert.strictEqual(result.id, 'OTHER');
assert(result.books.OTHER.sheets.PRD_Intake_Upload, 'stages in the configured workbook');
assert.strictEqual(result.books.OTHER.sheets.PRD_Intake_Upload.rowsWritten, 3);
assert(!result.books.FOUNDATION.sheets.PRD_Intake_Upload, 'foundation workbook is untouched');
assert.deepStrictEqual(result.opened, ['OTHER']);

console.log('intake-staging-location.test.js passed');
