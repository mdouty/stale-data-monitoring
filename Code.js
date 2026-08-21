function doGet(event) {
  const template = HtmlService.createTemplateFromFile('Index');
  const parameters = event && event.parameter ? event.parameter : {};
  const requestedEnvironment = cleanText_(parameters.app_env).toUpperCase();
  const requestedAssetId = cleanText_(parameters.asset_id);
  template.deepLinkConfig = JSON.stringify({
    assetId: requestedAssetId && requestedAssetId.length <= 500 && !/[\u0000-\u001F]/.test(requestedAssetId) ? requestedAssetId : '',
    environment: APP.environments[requestedEnvironment] ? requestedEnvironment : ''
  }).replace(/</g, '\\u003c');
  return template.evaluate()
    .setTitle(getConfig_().APP_NAME || 'EDG Stale Data Monitoring')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Stale Data Monitor')
    .addItem('Open application', 'showAppLink')
    .addSeparator()
    .addItem('Open reviewed intake workflow', 'showAppLink')
    .addItem('Continue import now', 'continueSnowflakeImport')
    .addItem('Cancel import', 'cancelSnowflakeImport')
    .addToUi();
}

function showAppLink() {
  const url = cleanText_(getConfig_().WEB_APP_URL);
  const html = url ? '<p><a href="' + url + '" target="_blank">Open Stale Data Monitoring</a></p>' :
    '<p>The web app has not been deployed yet. Add its URL to Config → WEB_APP_URL after deployment.</p>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(420).setHeight(140), 'Stale Data Monitor');
}
