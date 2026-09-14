// Durable payloads use alternating sheets. A property points only to a fully
// flushed payload, so an interrupted replacement cannot destroy the last one.
function reliabilityProperty_(name) {
  return 'RELIABILITY_' + normalizeEnvironment_(getActiveEnvironment_()) + '_' + name;
}

function readDurablePayload_(name, key) {
  const raw = PropertiesService.getScriptProperties().getProperty(reliabilityProperty_(name));
  if (!raw) return null;
  const pointer = JSON.parse(raw);
  if (pointer.key !== key) return null;
  const sheet = getFoundationSpreadsheet_().getSheetByName(pointer.sheet);
  if (!sheet) throw new Error('Saved recovery data is missing for ' + name + '.');
  const json = sheet.getRange(1, 1, pointer.rows, 1).getDisplayValues().map(function (row) { return pointer.encoding === 'PREFIXED_JSON' ? row[0].substring(1) : row[0]; }).join('');
  return JSON.parse(json);
}

function saveDurablePayload_(name, key, value) {
  const properties = PropertiesService.getScriptProperties();
  const property = reliabilityProperty_(name);
  const raw = properties.getProperty(property);
  const previous = raw ? JSON.parse(raw) : {};
  const slot = previous.slot === 0 ? 1 : 0;
  const sheetName = resolveSheetName_('Recovery_' + name + '_' + slot);
  const book = getFoundationSpreadsheet_();
  let sheet = book.getSheetByName(sheetName);
  if (!sheet) {
    sheet = book.insertSheet(sheetName);
    if (sheet.getMaxColumns() > 1) sheet.deleteColumns(2, sheet.getMaxColumns() - 1);
  }
  const json = JSON.stringify(value);
  const rows = [];
  for (let offset = 0; offset < json.length; offset += 40000) rows.push(['J' + json.substring(offset, offset + 40000)]);
  ensureSheetCapacity_(sheet, rows.length, 1);
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  sheet.hideSheet();
  SpreadsheetApp.flush();
  properties.setProperty(property, JSON.stringify({ key: key, sheet: sheetName, rows: rows.length, slot: slot, encoding: 'PREFIXED_JSON' }));
}

// Build exact range writes before changing operational data. Replaying these
// ranges reuses the original IDs, values and append positions.
function newDurableWritePlan_() {
  return { writes: [], sheets: {} };
}

function durablePlanSheet_(plan, sheetName) {
  if (!plan.sheets[sheetName]) {
    const sheet = getSheet_(sheetName);
    const width = sheet.getLastColumn();
    plan.sheets[sheetName] = {
      name: sheetName, nextRow: Math.max(2, sheet.getLastRow() + 1),
      headers: sheet.getRange(1, 1, 1, width).getDisplayValues()[0], appended: []
    };
  }
  return plan.sheets[sheetName];
}

function planAppendRows_(plan, sheetName, rows) {
  if (!rows.length) return;
  const meta = durablePlanSheet_(plan, sheetName);
  plan.writes.push({ sheet: sheetName, row: meta.nextRow, rows: rows, append: true });
  rows.forEach(function (row, index) { meta.appended.push({ row: meta.nextRow + index, values: row }); });
  meta.nextRow += rows.length;
}

function planAppendObjects_(plan, sheetName, objects) {
  if (!objects.length) return;
  const meta = durablePlanSheet_(plan, sheetName);
  planAppendRows_(plan, sheetName, objects.map(function (object) { return objectToRow_(meta.headers, object); }));
}

function planUpdateObjects_(plan, sheetName, keyHeader, objects) {
  if (!objects.length) return;
  const meta = durablePlanSheet_(plan, sheetName);
  const keyIndex = meta.headers.indexOf(keyHeader);
  if (keyIndex < 0) throw new Error('Missing recovery key column: ' + keyHeader);
  const sheet = getSheet_(sheetName);
  const rowByKey = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues().forEach(function (row, index) {
    if (cleanText_(row[0])) rowByKey[cleanText_(row[0])] = index + 2;
  });
  meta.appended.forEach(function (item) { rowByKey[cleanText_(item.values[keyIndex])] = item.row; });
  const updates = {};
  objects.forEach(function (object) {
    const key = cleanText_(object[keyHeader]);
    if (!key) return;
    const row = objectToRow_(meta.headers, object);
    if (rowByKey[key]) updates[rowByKey[key]] = row;
    else planAppendRows_(plan, sheetName, [row]);
  });
  // Only write selected rows. No stale snapshot of an unrelated gap is replayed.
  const numbers = Object.keys(updates).map(Number).sort(function (a, b) { return a - b; });
  let group;
  numbers.forEach(function (row) {
    if (group && group.row + group.rows.length === row) group.rows.push(updates[row]);
    else { group = { sheet: sheetName, row: row, rows: [updates[row]] }; plan.writes.push(group); }
  });
}

function applyDurableWrites_(writes) {
  (writes || []).forEach(function (write) {
    if (!write.rows.length) return;
    const sheet = getSheet_(write.sheet);
    ensureSheetCapacity_(sheet, write.row + write.rows.length - 1, write.rows[0].length);
    const range = sheet.getRange(write.row, 1, write.rows.length, write.rows[0].length);
    if (write.append && sheet.getLastRow() >= write.row) {
      const existing = range.getValues();
      existing.forEach(function (row, index) {
        const matches = function (expected) {
          return row.every(function (cell, column) { return String(cell) === String(expected[column] === undefined ? '' : expected[column]); });
        };
        const rowNumber = write.row + index;
        const matchesPlannedUpdate = writes.some(function (other) {
          return other.sheet === write.sheet && rowNumber >= other.row && rowNumber < other.row + other.rows.length &&
            matches(other.rows[rowNumber - other.row]);
        });
        if (row.some(function (cell) { return cell !== ''; }) && !matchesPlannedUpdate) {
          throw new Error('Recovery found a conflicting row in ' + write.sheet + '. No existing data was overwritten.');
        }
      });
    }
    range.setValues(write.rows);
  });
  SpreadsheetApp.flush();
}

function replaceWorkflowTrigger_(handler, delayMs) {
  // Keep the old fallback until its replacement exists.
  const replacement = ScriptApp.newTrigger(handler).timeBased().after(delayMs).create();
  const id = replacement.getUniqueId();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler && trigger.getUniqueId() !== id) ScriptApp.deleteTrigger(trigger);
  });
}

function slackDeliveryLedger_() {
  const name = resolveSheetName_('Slack_Delivery_Receipts');
  const book = getFoundationSpreadsheet_();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    if (sheet.getMaxColumns() > 8) sheet.deleteColumns(9, sheet.getMaxColumns() - 8);
    sheet.getRange(1, 1, 1, 8).setValues([['DELIVERY_ID', 'RECIPIENT', 'TYPE', 'STATUS', 'CREATED_AT', 'RECEIPT', 'CHUNKS', 'NOTIFICATION_IDS']]);
    sheet.hideSheet();
  }
  return sheet;
}

function readSlackDeliveryEntries_(recipient) {
  const sheet = slackDeliveryLedger_();
  if (sheet.getLastRow() < 2) return [];
  const column = recipient ? 2 : 4;
  const value = recipient || 'ATTEMPTING';
  return sheet.getRange(2, column, sheet.getLastRow() - 1, 1).createTextFinder(value).matchEntireCell(true).findAll().map(function (range) {
    const rowNumber = range.getRow();
    const row = sheet.getRange(rowNumber, 1, 1, 8).getDisplayValues()[0];
    const ids = sheet.getRange(rowNumber, 8, Number(row[6]), 1).getDisplayValues().map(function (chunk) { return chunk[0]; }).join('');
    return { row: rowNumber, id: row[0], recipient: row[1], type: row[2], status: row[3], createdAt: row[4], receipt: JSON.parse(row[5]), notificationIds: JSON.parse(ids) };
  });
}

function setSlackDeliveryReceipt_(entry, status) {
  slackDeliveryLedger_().getRange(entry.row, 4, 1, 3).setValues([[status, entry.createdAt, JSON.stringify(entry.receipt)]]);
  SpreadsheetApp.flush();
  entry.status = status;
}

function deliverSlackPayloadOnce_(records, type, recipient, payload, url) {
  const ids = records.map(function (record) { return cleanText_(record.NOTIFICATION_ID); }).sort();
  const selected = ids.reduce(function (map, id) { map[id] = true; return map; }, {});
  const entries = readSlackDeliveryEntries_(recipient).filter(function (entry) {
    return entry.type === type && entry.notificationIds.some(function (id) { return selected[id]; });
  });
  const uncertain = entries.filter(function (entry) { return entry.status === 'ATTEMPTING'; })[0];
  if (uncertain) throw new Error('DELIVERY_UNCERTAIN: Verify Slack delivery ' + uncertain.id + ' to ' + recipient + ' before retrying. No duplicate was sent.');
  const accepted = entries.filter(function (entry) { return entry.status === 'ACCEPTED'; })[0];
  if (accepted) {
    const included = accepted.notificationIds.reduce(function (map, id) { map[id] = true; return map; }, {});
    if (!ids.every(function (id) { return included[id]; })) {
      throw new Error('A previously accepted delivery must finish recording before adding new notifications for ' + recipient + '.');
    }
    return accepted.receipt;
  }
  const receipt = { batchId: uuid_(), sentAt: nowIso_(), responseCode: '', recipient: recipient,
    messageType: type, assetCount: ids.length, messagePreview: buildNotificationPreview_(payload) };
  const sheet = slackDeliveryLedger_();
  const rowNumber = Math.max(2, sheet.getLastRow() + 1);
  const json = JSON.stringify(ids);
  const rows = [];
  for (let offset = 0; offset < json.length; offset += 40000) rows.push(['', '', '', '', '', '', '', json.substring(offset, offset + 40000)]);
  rows[0] = [receipt.batchId, recipient, type, 'ATTEMPTING', receipt.sentAt, JSON.stringify(receipt), rows.length, rows[0][7]];
  ensureSheetCapacity_(sheet, rowNumber + rows.length - 1, 8);
  sheet.getRange(rowNumber, 1, rows.length, 8).setValues(rows);
  // The intent must be durable before the external side effect.
  SpreadsheetApp.flush();
  const entry = { row: rowNumber, id: receipt.batchId, createdAt: receipt.sentAt, receipt: receipt };
  let response;
  try {
    response = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (error) {
    throw new Error('DELIVERY_UNCERTAIN: Slack did not return a confirmed result for ' + receipt.batchId + '. Verify delivery before retrying. ' + String(error.message || error).substring(0, 200));
  }
  receipt.responseCode = response.getResponseCode();
  if (receipt.responseCode >= 200 && receipt.responseCode < 300) {
    setSlackDeliveryReceipt_(entry, 'ACCEPTED');
    return receipt;
  }
  // A server-side error can occur after acceptance. Only explicit client
  // rejections are automatically retryable after correcting the cause.
  if ([400, 401, 403, 404, 405, 410, 413, 415, 422, 429].indexOf(receipt.responseCode) !== -1) setSlackDeliveryReceipt_(entry, 'REJECTED');
  else throw new Error('DELIVERY_UNCERTAIN: Slack returned HTTP ' + receipt.responseCode + ' for ' + receipt.batchId + '. Verify delivery before retrying.');
  throw new Error('Slack webhook returned HTTP ' + receipt.responseCode + ': ' + response.getContentText().substring(0, 500));
}

function getUncertainSlackDeliveries() {
  assertAdmin_();
  assertEnvironmentWritable_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Delivery is still processing. Try again shortly.');
  try {
    return readSlackDeliveryEntries_().map(function (entry) {
      return { id: entry.id, recipient: entry.recipient, type: entry.type, attemptedAt: entry.createdAt, assets: entry.notificationIds.length };
    });
  } finally { lock.releaseLock(); }
}

function resolveUncertainSlackDelivery(input) {
  const actor = assertAdmin_();
  assertEnvironmentWritable_();
  const decision = cleanText_(input && input.decision);
  if (['RECEIVED', 'NOT_RECEIVED'].indexOf(decision) === -1) throw new Error('Confirm whether the message was received in Slack.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const entry = readSlackDeliveryEntries_().filter(function (value) { return value.id === cleanText_(input.id); })[0];
    if (!entry) throw new Error('This delivery was already resolved or is no longer uncertain. Refresh the list.');
    entry.receipt.resolvedBy = actor.email;
    entry.receipt.resolvedAt = nowIso_();
    entry.receipt.resolution = decision;
    if (decision === 'RECEIVED') entry.receipt.responseCode = 'MANUALLY_VERIFIED';
    setSlackDeliveryReceipt_(entry, decision === 'RECEIVED' ? 'ACCEPTED' : 'RETRY_APPROVED');
    return { resolved: true, decision: decision };
  } finally { lock.releaseLock(); }
}

function recoverPendingSynchronousDelivery_() {
  const properties = PropertiesService.getScriptProperties();
  const raw = properties.getProperty(reliabilityProperty_('SynchronousDelivery'));
  if (!raw) return null;
  const pointer = JSON.parse(raw);
  const completedKey = reliabilityProperty_('SynchronousDeliveryCompleted');
  if (properties.getProperty(completedKey) === pointer.key) return null;
  const saved = readDurablePayload_('SynchronousDelivery', pointer.key);
  applyDurableWrites_(saved.writes);
  properties.setProperty(completedKey, pointer.key);
  return saved.result;
}

function objectsWithPlannedWrites_(objects, plan, sheetName, keyHeader) {
  if (!plan || !plan.sheets[sheetName]) return objects;
  const headers = plan.sheets[sheetName].headers;
  const updates = {};
  plan.writes.forEach(function (write) {
    if (write.sheet !== sheetName) return;
    write.rows.forEach(function (row) {
      const value = rowToObject_(headers, row);
      updates[cleanText_(value[keyHeader])] = value;
    });
  });
  return objects.map(function (value) { return updates[cleanText_(value[keyHeader])] || value; });
}
