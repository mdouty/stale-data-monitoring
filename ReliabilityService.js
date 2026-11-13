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
  // Reuse the shared key index (the last occurrence of a key wins) rather than
  // rescanning the key column on every call; rows appended by this plan overlay it.
  const indexed = getSheetKeyIndex_(sheet, sheetName, keyHeader).rowsByKey;
  const appendedRowByKey = {};
  meta.appended.forEach(function (item) { appendedRowByKey[cleanText_(item.values[keyIndex])] = item.row; });
  const rowFor = function (key) {
    if (appendedRowByKey[key]) return appendedRowByKey[key];
    const rows = indexed[key];
    return rows ? rows[rows.length - 1] : 0;
  };
  const updates = {};
  objects.forEach(function (object) {
    const key = cleanText_(object[keyHeader]);
    if (!key) return;
    const row = objectToRow_(meta.headers, object);
    const existingRow = rowFor(key);
    if (existingRow) updates[existingRow] = row;
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

// Replay compares what the sheet returns against the saved plan. Sheets turns a planned
// 'TRUE' / 'FALSE' string into a real boolean, which stringifies lowercase, so a row this
// plan already wrote would read back as a conflict. Compare booleans case-insensitively.
function durableCellMatches_(cell, expected) {
  const want = String(expected === undefined ? '' : expected);
  if (String(cell) === want) return true;
  return typeof cell === 'boolean' && String(cell).toUpperCase() === want.toUpperCase();
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
          return row.every(function (cell, column) { return durableCellMatches_(cell, expected[column]); });
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
    noteSheetWrite_(sheet, write.sheet, write);
  });
  SpreadsheetApp.flush();
}

// Recovery for a durable append whose reserved rows were claimed by another writer
// between planning and replay. Relocates only the plan's own append writes to each
// sheet's current end, mirroring applyDurableWrites_'s conflict test so it moves
// exactly the writes that would otherwise throw. It never overwrites the foreign row
// (it writes to empty space) and preserves every planned row and ID, so replaying the
// rebased plan stays idempotent and loses no audit history. Non-append writes
// (fixed-row updates) are returned unchanged.
function rebaseDurableAppendWrites_(writes) {
  const list = writes || [];
  const ends = {};
  return list.map(function (write) {
    if (!write.append || !write.rows.length) return write;
    const sheet = getSheet_(write.sheet);
    if (ends[write.sheet] === undefined) ends[write.sheet] = Math.max(2, sheet.getLastRow() + 1);
    let conflict = false;
    if (sheet.getLastRow() >= write.row) {
      sheet.getRange(write.row, 1, write.rows.length, write.rows[0].length).getValues().forEach(function (row, index) {
        const rowNumber = write.row + index;
        const matchesPlanned = list.some(function (other) {
          return other.sheet === write.sheet && rowNumber >= other.row && rowNumber < other.row + other.rows.length &&
            row.every(function (cell, column) {
              const expected = other.rows[rowNumber - other.row];
              return durableCellMatches_(cell, expected[column]);
            });
        });
        if (row.some(function (cell) { return cell !== ''; }) && !matchesPlanned) conflict = true;
      });
    }
    if (!conflict) {
      ends[write.sheet] = Math.max(ends[write.sheet], write.row + write.rows.length);
      return write;
    }
    const rebased = { sheet: write.sheet, row: ends[write.sheet], rows: write.rows, append: true };
    ends[write.sheet] += write.rows.length;
    return rebased;
  });
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

/**
 * DIAGNOSTIC (run from the Apps Script editor Run menu). Probes the configured
 * Slack workflow webhook the same way deliverSlackPayloadOnce_ does, but WITHOUT
 * writing anything to the delivery ledger. It answers the one question the
 * ledger cannot: what does the endpoint actually return today?
 *
 *   FETCH_THREW  -> timeout / DNS / connection failure  (leaves real rows ATTEMPTING)
 *   REDIRECT_3xx -> webhook URL moved                    (leaves real rows ATTEMPTING)
 *   SERVER_ERROR -> workflow errored on Slack's side     (leaves real rows ATTEMPTING)
 *   CLIENT_ERROR -> 4xx; real sends would be REJECTED, not ATTEMPTING
 *   ACCEPTED_2xx -> reachable and healthy
 *
 * Safety: if the webhook + workflow are healthy this sends exactly ONE real Slack
 * message. It is addressed to the account running the function
 * (Session.getEffectiveUser) — never a data steward — and the body is clearly
 * marked as a connectivity test. Read the result in View > Executions (it is
 * both Logger.log'd and returned).
 */
function probeSlackWebhook() {
  const url = PropertiesService.getScriptProperties().getProperty(APP.slackWorkflowProperty);
  const self = Session.getEffectiveUser().getEmail();
  const result = { runBy: self, ranAt: new Date().toISOString(), urlHost: '' };
  if (!url) {
    result.outcome = 'NOT_CONFIGURED';
    result.diagnosis = APP.slackWorkflowProperty + ' is empty. Set the webhook in Admin > Settings before enabling delivery.';
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  }
  result.urlHost = url.replace(/^https?:\/\//, '').split('/')[0];

  // The Slack workflow trigger types edgContact as a Channel ID and primaryRecipient
  // as a user email. A real send fills edgContact from config.EDG_CONTACT (and throws
  // locally unless it is a valid channel ID). Mirror that here so the probe is faithful —
  // otherwise an empty edgContact makes Slack reject with invalid_workflow_input even
  // though real sends would succeed.
  const edgContact = cleanText_(getConfig_().EDG_CONTACT);
  if (!isSlackChannelId_(edgContact)) {
    result.outcome = 'NOT_CONFIGURED';
    result.diagnosis = 'EDG_CONTACT is not a valid Slack channel ID (expected e.g. C065MLQ2HLL). ' +
      'Set it in Admin > Settings. Real sends throw locally on this before ever reaching Slack, ' +
      'and the workflow trigger rejects an empty channel with invalid_workflow_input.';
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Mirror the exact shape a real send posts, but self-addressed and marked test.
  const payload = normalizeSlackWorkflowPayload_({
    messageType: 'STALE_ASSET_NOTICE',
    primaryRecipient: self,
    edgContact: edgContact,
    environment: getActiveEnvironment_(),
    assetCount: 0,
    assetSummary: '[Connectivity test from probeSlackWebhook — safe to ignore]'
  });

  const started = Date.now();
  let response;
  try {
    response = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (error) {
    result.outcome = 'FETCH_THREW';
    result.elapsedMs = Date.now() - started;
    result.error = String(error && error.message ? error.message : error).substring(0, 500);
    result.diagnosis = result.elapsedMs > 25000
      ? 'The endpoint did not respond in time (timeout). This is what leaves real rows ATTEMPTING.'
      : 'The request failed before any response (DNS / connection / TLS). This leaves real rows ATTEMPTING.';
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  }

  const code = response.getResponseCode();
  const headers = response.getAllHeaders() || {};
  result.responseCode = code;
  result.elapsedMs = Date.now() - started;
  result.location = headers.Location || headers.location || '';
  result.bodyPreview = String(response.getContentText() || '').substring(0, 500);
  if (code >= 200 && code < 300) {
    result.outcome = 'ACCEPTED_2xx';
    result.diagnosis = 'Webhook reachable and accepted. A test message should reach ' + self + '. If real sends still go ATTEMPTING, the failure is intermittent (timeout under load) or specific to a larger payload.';
  } else if (code >= 300 && code < 400) {
    result.outcome = 'REDIRECT_3xx';
    result.diagnosis = 'Endpoint redirected (see location). The webhook URL likely moved — re-copy it from Workflow Builder into Admin > Settings.';
  } else if ([400, 401, 403, 404, 405, 410, 413, 415, 422, 429].indexOf(code) !== -1) {
    result.outcome = 'CLIENT_ERROR_' + code;
    result.diagnosis = code === 404
      ? 'Webhook not found — the workflow was deleted or its trigger regenerated. Re-copy the webhook URL into Admin > Settings. NOTE: a 4xx marks real sends REJECTED, not ATTEMPTING, so this is probably not your current failure.'
      : 'Slack rejected the request (' + code + '). A 4xx marks real sends REJECTED, not ATTEMPTING.';
  } else {
    result.outcome = 'SERVER_ERROR_' + code;
    result.diagnosis = 'Slack returned a server error. The workflow errored on its side (e.g., it was unpublished, or a step references a variable the payload no longer supplies). This leaves real rows ATTEMPTING. Fix the workflow in Workflow Builder.';
  }
  Logger.log(JSON.stringify(result, null, 2));
  return result;
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
