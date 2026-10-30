function previewExemption() {
  const result = previewSchemaExemption('SSE_DM_FIN_PRD', [
    'FIDO_TABNETSUITE', 'FIDO_TABNETSUITE_FINANCIALMASTER', 'FIVETRAN_LOG'
  ], true);
  Logger.log('matched ' + result.matchedAssets + ' ' + JSON.stringify(result.byState) + ' existing ' + JSON.stringify(result.existingExceptions));
  Logger.log(['OBJECT_FQN', 'STATE', 'EXCEPTION_ID', 'ASSET_ID'].join('\t'));
  result.objects.sort(function (a, b) { return String(a.objectFqn).localeCompare(String(b.objectFqn)); }).forEach(function (o) {
    Logger.log([o.objectFqn, o.lifecycleState, o.exceptionId, o.assetId].join('\t'));
  });
}

// Step 1: set EXPIRY to the expiry date (YYYY-MM-DD) and run with dryRun = true.
// Step 2: when the dry run is right and no import is running, set dryRun = false and run again.
function exemptSchemas() {
  const EXPIRY = 'YYYY-MM-DD';
  const dryRun = true;
  const result = exemptSchemaObjects('SSE_DM_FIN_PRD', [
    'FIDO_TABNETSUITE', 'FIDO_TABNETSUITE_FINANCIALMASTER', 'FIVETRAN_LOG'
  ], 'EDG-EXC-2026-002', EXPIRY, dryRun);
  Logger.log(JSON.stringify(result, null, 2));
}

// Read-only: logs the first few recovered assets the "Export recovered assets" button would download.
function previewRecoveredAssets() {
  const chunk = exportRecoveredAssetsChunk({ offset: 0 });
  Logger.log('total recovered: ' + chunk.total + ' (showing first ' + Math.min(5, chunk.rows.length) + ')');
  Logger.log(chunk.headers.slice(-4).join(' | '));
  chunk.rows.slice(0, 5).forEach(function (row) {
    const record = {};
    chunk.headers.forEach(function (header, index) { record[header] = row[index]; });
    Logger.log(JSON.stringify({
      ASSET_ID: record.ASSET_ID, OBJECT_FQN: record.OBJECT_FQN, LIFECYCLE_STATE: record.LIFECYCLE_STATE,
      PREVIOUS_LIFECYCLE_STATE: record.PREVIOUS_LIFECYCLE_STATE, RECOVERY_EVENT_TYPE: record.RECOVERY_EVENT_TYPE,
      RECOVERED_AT: record.RECOVERED_AT, RECOVERY_RUN_ID: record.RECOVERY_RUN_ID
    }));
  });
}
