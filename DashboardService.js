function getDashboard(request) {
  const query = request || {};
  const email = getCurrentUserEmail_();
  const role = getUserRole_(email) || 'VIEWER';
  const accessEmails = getUserAccessEmails_(email, role);
  const assets = readObjects_(APP.sheets.assetsCurrent).filter(function (asset) {
    return canAccessAssetWithEmails_(asset, accessEmails);
  });
  if (!assets.length) return emptyDashboard_();
  const search = cleanText_(query.search).toLowerCase();
  const lifecycleFilters = dashboardFilterValues_(query.lifecycleStatuses || query.lifecycleStatus || query.state);
  const assetStatusFilters = dashboardFilterValues_(query.assetStatuses || query.assetStatus);
  const evaluationFilter = cleanText_(query.evaluation).toUpperCase();
  const environmentFilters = dashboardFilterValues_(query.environments || query.environment);
  const stewardFilters = dashboardFilterValues_(query.stewards || query.stewardship);
  const domainFilters = dashboardFilterValues_(query.domains || query.domain);
  const typeFilter = cleanText_(query.assetType).toUpperCase();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(10, Number(query.pageSize || 50)));
  const matching = [];
  const stateCounts = {};
  const assetStatusCounts = {};
  const environmentCounts = {};
  const evaluationCounts = {};
  const domainCounts = {};
  const domains = {};
  const types = {};
  const stewards = {};
  let staleCount = 0;
  let staleSizeGb = 0;
  let needsContact = 0;
  let acceptedCount = 0;
  let quarantinedCount = 0;
  let purgeWithin30Count = 0;
  let purgedCount = 0;
  let snapshotAt = '';
  const now = new Date();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  assets.forEach(function (asset) {
    if (!asset.ASSET_ID) return;
    const lifecycleState = canonicalLifecycleState_(asset.LIFECYCLE_STATE);
    const assetStatus = deriveAssetStatus_(asset, lifecycleState);
    asset.ASSET_STATUS = assetStatus;
    const evaluationStatus = cleanText_(asset.EVALUATION_STATUS).toUpperCase();
    const technicalSteward = cleanText_(asset.TECHNICAL_STEWARD);
    const businessSteward = cleanText_(asset.BUSINESS_STEWARD);
    const environment = cleanText_(asset.ENVIRONMENT).toUpperCase();
    const domain = cleanText_(asset.DOMAIN) || 'UNASSIGNED';
    const assetType = cleanText_(asset.ASSET_TYPE).toUpperCase() || 'UNKNOWN';
    const sizeGb = Number(asset.SIZE_GB || 0);
    if (asset.SNAPSHOT_AT > snapshotAt) snapshotAt = asset.SNAPSHOT_AT;
    incrementCount_(stateCounts, lifecycleState || 'UNKNOWN');
    incrementCount_(assetStatusCounts, assetStatus || 'UNKNOWN');
    incrementCount_(environmentCounts, environment || 'UNKNOWN');
    incrementCount_(evaluationCounts, evaluationStatus || 'UNKNOWN');
    incrementCount_(domainCounts, domain);
    domains[domain] = true;
    types[assetType] = true;
    [technicalSteward, businessSteward].forEach(function (person) {
      if (person) stewards[person.toUpperCase()] = person;
    });
    if (assetStatus === APP.assetStatus.stale) {
      staleCount += 1;
      staleSizeGb += sizeGb;
    }
    if (cleanText_(asset.CONTACT_COVERAGE_STATUS).toUpperCase() === 'NO_SLACK_EMAIL') needsContact += 1;
    if (lifecycleState === APP.lifecycle.accepted) acceptedCount += 1;
    if (assetStatus === APP.assetStatus.quarantined) {
      quarantinedCount += 1;
      const purgeAt = asset.PURGE_ELIGIBLE_DATE ? new Date(asset.PURGE_ELIGIBLE_DATE) : null;
      if (purgeAt && !isNaN(purgeAt.getTime()) && purgeAt >= now && purgeAt - now <= thirtyDays) purgeWithin30Count += 1;
    }
    if (lifecycleState === APP.lifecycle.purged) purgedCount += 1;

    if (lifecycleFilters.length && lifecycleFilters.indexOf(lifecycleState) === -1) return;
    if (assetStatusFilters.length && assetStatusFilters.indexOf(assetStatus) === -1) return;
    if (evaluationFilter && evaluationStatus !== evaluationFilter) return;
    if (environmentFilters.length && environmentFilters.indexOf(environment) === -1) return;
    if (stewardFilters.length && stewardFilters.indexOf(technicalSteward.toUpperCase()) === -1 && stewardFilters.indexOf(businessSteward.toUpperCase()) === -1) return;
    if (domainFilters.length && domainFilters.indexOf(domain.toUpperCase()) === -1) return;
    if (typeFilter && assetType !== typeFilter) return;
    if (search) {
      const haystack = Object.keys(asset).map(function (key) { return cleanText_(asset[key]); }).join(' ').toLowerCase();
      if (haystack.indexOf(search) === -1) return;
    }
    matching.push(asset);
  });

  matching.sort(function (left, right) {
    const leftDays = parseNumber_(left.DAYS_SINCE_ANY_ACTIVITY);
    const rightDays = parseNumber_(right.DAYS_SINCE_ANY_ACTIVITY);
    if (rightDays !== leftDays) return Number(rightDays === null ? -1 : rightDays) - Number(leftDays === null ? -1 : leftDays);
    return cleanText_(left.OBJECT_FQN).localeCompare(cleanText_(right.OBJECT_FQN));
  });
  const jobs = readObjects_(APP.sheets.jobs);
  const latestJob = jobs.length ? jobs[jobs.length - 1] : null;
  const offset = (page - 1) * pageSize;
  const profile = getEnvironmentProfile_();
  return {
    snapshotAt: snapshotAt,
    metrics: {
      totalAssets: assets.length,
      sourceRows: role === 'ADMIN' && latestJob ? Number(latestJob.SOURCE_ROWS || 0) : assets.length,
      staleAssets: staleCount,
      staleSizeGb: Math.round(staleSizeGb * 100) / 100,
      needsOwner: needsContact,
      quarantineReady: acceptedCount,
      quarantined: quarantinedCount,
      purgeWithin30: purgeWithin30Count,
      purged: purgedCount
    },
    breakdowns: {
      state: countMapToArray_(stateCounts),
      assetStatus: countMapToArray_(assetStatusCounts),
      environment: countMapToArray_(environmentCounts),
      evaluation: countMapToArray_(evaluationCounts),
      domain: countMapToArray_(domainCounts)
    },
    filterOptions: {
      domains: Object.keys(domains).sort(),
      environments: Object.keys(environmentCounts).sort(),
      assetTypes: Object.keys(types).sort(),
      stewards: Object.keys(stewards).map(function (key) { return stewards[key]; }).sort(function (left, right) { return left.localeCompare(right); }),
      assetStatuses: [APP.assetStatus.stale, APP.assetStatus.active, APP.assetStatus.quarantined, APP.assetStatus.purged],
      lifecycleStatuses: dashboardLifecycleStatuses_()
    },
    assets: matching.slice(offset, offset + pageSize).map(function (asset) {
      const item = dashboardAsset_(asset);
      item.permissions = {
        canRespond: !profile.readOnly && canAccessAssetWithEmails_(asset, accessEmails),
        canAdmin: !profile.readOnly && role === 'ADMIN',
        readOnly: profile.readOnly
      };
      return item;
    }),
    pagination: {
      page: page,
      pageSize: pageSize,
      total: matching.length,
      pages: Math.max(1, Math.ceil(matching.length / pageSize))
    }
  };
}

function dashboardFilterValues_(value) {
  const values = Array.isArray(value) ? value : (cleanText_(value) ? [value] : []);
  const seen = {};
  return values.map(function (item) { return cleanText_(item).toUpperCase(); }).filter(function (item) {
    if (!item || seen[item]) return false;
    seen[item] = true;
    return true;
  });
}

function prepareAssetDetailsExport(input) {
  const assetIds = Array.from(new Set(((input || {}).assetIds || []).map(cleanText_).filter(Boolean)));
  if (!assetIds.length) throw new Error('Select at least one asset to export.');
  if (assetIds.length > 200) throw new Error('Asset exports are limited to 200 records at a time.');
  const sheet = getSheet_(APP.sheets.assetsCurrent);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const assets = indexObjectsBy_(readObjectsByKeys_(APP.sheets.assetsCurrent, 'ASSET_ID', assetIds), 'ASSET_ID');
  const email = getCurrentUserEmail_();
  const role = getUserRole_(email) || 'VIEWER';
  const accessEmails = getUserAccessEmails_(email, role);
  const rows = assetIds.filter(function (assetId) { return Boolean(assets[assetId]); }).map(function (assetId) {
    const asset = assets[assetId];
    if (!canAccessAssetWithEmails_(asset, accessEmails)) throw new Error('This asset was not found or you do not have access to it.');
    asset.LIFECYCLE_STATE = canonicalLifecycleState_(asset.LIFECYCLE_STATE);
    asset.ASSET_STATUS = deriveAssetStatus_(asset, asset.LIFECYCLE_STATE);
    return headers.map(function (header) { return asset[header] === undefined ? '' : asset[header]; });
  });
  if (!rows.length) throw new Error('None of the selected assets are available to export. Refresh the dashboard and try again.');
  if (rows.length !== assetIds.length) throw new Error('One or more selected assets are no longer available. Refresh the dashboard and select the records again.');
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyyMMdd-HHmm');
  return {
    fileName: getActiveEnvironment_() + '_ASSET_DETAILS_' + date + '.csv',
    headers: headers,
    rows: rows
  };
}

function dashboardLifecycleStatuses_() {
  const seen = {};
  return Object.keys(APP.lifecycle).map(function (key) { return APP.lifecycle[key]; }).filter(function (status) {
    if (!status || seen[status]) return false;
    seen[status] = true;
    return true;
  });
}

function dashboardAsset_(asset) {
  const size = parseNumber_(asset.SIZE_GB);
  const inactive = parseNumber_(asset.DAYS_SINCE_ANY_ACTIVITY);
  return {
    assetId: asset.ASSET_ID,
    objectFqn: asset.OBJECT_FQN,
    platform: asset.PLATFORM,
    environment: asset.ENVIRONMENT,
    assetType: asset.ASSET_TYPE,
    sizeGb: size,
    daysInactive: inactive,
    evaluationStatus: asset.EVALUATION_STATUS,
    assetStatus: deriveAssetStatus_(asset),
    lifecycleState: canonicalLifecycleState_(asset.LIFECYCLE_STATE),
    ownershipStatus: asset.OWNERSHIP_STATUS,
    ownershipSource: asset.OWNERSHIP_SOURCE,
    snowflakeOwner: asset.SNOWFLAKE_TABLE_OWNER || asset.DATABASE_OWNER,
    snowflakeDataStatus: asset.SNOWFLAKE_DATA_STATUS || APP.lifecycle.active,
    technicalSteward: asset.TECHNICAL_STEWARD,
    businessSteward: asset.BUSINESS_STEWARD,
    dpmTeam: asset.DPM_TEAM,
    bdsTeam: asset.BDS_TEAM,
    domain: asset.DOMAIN || 'UNASSIGNED',
    subDomain: asset.SUB_DOMAIN || '',
    contactCoverageStatus: asset.CONTACT_COVERAGE_STATUS || '',
    exceptionStatus: asset.EXCEPTION_STATUS,
    contestDeadline: asset.CONTEST_DEADLINE,
    purgeEligibleDate: asset.PURGE_ELIGIBLE_DATE
  };
}

function emptyDashboard_() {
  return {
    snapshotAt: '',
    metrics: { totalAssets: 0, sourceRows: 0, staleAssets: 0, staleSizeGb: 0, needsOwner: 0, quarantineReady: 0, quarantined: 0, purgeWithin30: 0, purged: 0 },
    breakdowns: { state: [], assetStatus: [], environment: [], evaluation: [], domain: [] },
    filterOptions: { domains: [], environments: [], assetTypes: [], stewards: [], assetStatuses: [APP.assetStatus.stale, APP.assetStatus.active, APP.assetStatus.quarantined, APP.assetStatus.purged], lifecycleStatuses: dashboardLifecycleStatuses_() },
    assets: [],
    pagination: { page: 1, pageSize: 50, total: 0, pages: 1 }
  };
}

function countMapToArray_(map) {
  return Object.keys(map).map(function (key) { return { label: key, value: map[key] }; })
    .sort(function (a, b) { return b.value - a.value || a.label.localeCompare(b.label); });
}

function getAssetDetail(assetId) {
  const found = findObjectRow_(APP.sheets.assetsCurrent, 'ASSET_ID', assetId);
  if (!found) throw new Error('This asset was not found or you do not have access to it.');
  const asset = found.value;
  const role = getUserRole_();
  const email = getCurrentUserEmail_();
  const accessEmails = getUserAccessEmails_(email, role);
  if (!canAccessAssetWithEmails_(asset, accessEmails)) throw new Error('This asset was not found or you do not have access to it.');
  asset.LIFECYCLE_STATE = canonicalLifecycleState_(asset.LIFECYCLE_STATE);
  asset.ASSET_STATUS = deriveAssetStatus_(asset, asset.LIFECYCLE_STATE);
  const cases = readObjectsByField_(APP.sheets.cases, 'ASSET_ID', assetId, 1);
  const activeCase = cases.length ? cases[cases.length - 1] : null;
  if (activeCase) activeCase.STATE = canonicalLifecycleState_(activeCase.STATE);
  const caseId = activeCase ? activeCase.CASE_ID : '';
  const events = readObjectsByField_(APP.sheets.events, 'ASSET_ID', assetId, 50).reverse();
  const notifications = readObjectsByField_(APP.sheets.notifications, 'ASSET_ID', assetId, 20).reverse();
  const exceptions = readObjectsByField_(APP.sheets.exceptions, 'ASSET_ID', assetId, 20).reverse();
  const actions = readObjectsByField_(APP.sheets.platformActions, 'ASSET_ID', assetId, 20).reverse();
  const profile = getEnvironmentProfile_();
  return {
    asset: asset,
    caseRecord: activeCase,
    events: events,
    notifications: notifications,
    exceptions: exceptions,
    platformActions: actions,
    exceptionUrl: buildExceptionUrl_(assetId, caseId),
    permissions: {
      canOperate: !profile.readOnly && ['ADMIN', 'OPERATOR'].indexOf(role) !== -1,
      canAdmin: !profile.readOnly && role === 'ADMIN',
      canRespond: !profile.readOnly && canAccessAssetWithEmails_(asset, accessEmails),
      readOnly: profile.readOnly
    },
    adminLifecycleTransitions: !profile.readOnly && role === 'ADMIN' && activeCase
      ? allowedAdminLifecycleTransitions_(activeCase.STATE) : []
  };
}
