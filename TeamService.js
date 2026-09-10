const TEAM_HEADERS = Object.freeze([
  'TEAM_ID', 'TEAM_NAME', 'OWNER_EMAIL', 'MEMBER_EMAILS',
  'CREATED_AT', 'UPDATED_AT', 'UPDATED_BY', 'ACTIVE'
]);

function ensureTeamsSheet_() {
  const spreadsheet = getFoundationSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(APP.sheets.teams);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(APP.sheets.teams);
    sheet.getRange(1, 1, 1, TEAM_HEADERS.length).setValues([TEAM_HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    appendMissingHeaders_(sheet, TEAM_HEADERS);
  }
  return sheet;
}

function readTeamRecords_(includeInactive) {
  const sheet = ensureTeamsSheet_();
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  const headers = values.shift();
  return values.filter(function (row) { return row.some(function (cell) { return cleanText_(cell); }); })
    .map(function (row) { return rowToObject_(headers, row); })
    .filter(function (team) { return includeInactive || cleanText_(team.ACTIVE).toUpperCase() === 'TRUE'; });
}

function teamMemberEmails_(team) {
  const owner = assertSalesforceEmail_(team.OWNER_EMAIL);
  const members = cleanText_(team.MEMBER_EMAILS).split(/[;,\s]+/).map(function (email) {
    return cleanText_(email).toLowerCase();
  }).filter(Boolean);
  const seen = {};
  return [owner].concat(members).filter(function (email) {
    if (!/@salesforce\.com$/i.test(email) || seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

function teamToClient_(team, viewerEmail, isAdmin) {
  const members = teamMemberEmails_(team);
  const owner = cleanText_(team.OWNER_EMAIL).toLowerCase();
  const active = cleanText_(team.ACTIVE).toUpperCase() === 'TRUE';
  return {
    teamId: team.TEAM_ID,
    name: team.TEAM_NAME,
    ownerEmail: owner,
    members: members.map(function (email) { return { email: email, role: email === owner ? 'OWNER' : 'MEMBER' }; }),
    active: active,
    createdAt: team.CREATED_AT,
    updatedAt: team.UPDATED_AT,
    updatedBy: team.UPDATED_BY,
    canManage: active && (Boolean(isAdmin) || members.indexOf(cleanText_(viewerEmail).toLowerCase()) !== -1)
  };
}

function getTeamForEmail_(email) {
  const target = cleanText_(email).toLowerCase();
  if (!target) return null;
  return readTeamRecords_(false).find(function (team) {
    return teamMemberEmails_(team).indexOf(target) !== -1;
  }) || null;
}

function getUserAccessEmails_(email, role) {
  const target = cleanText_(email || getCurrentUserEmail_()).toLowerCase();
  if (!target) return [];
  if (role === 'ADMIN' || isAdminEmail_(target)) return null;
  const team = getTeamForEmail_(target);
  return team ? teamMemberEmails_(team) : [target];
}

function getAssetRoleEmails_(asset) {
  return extractAssetAccessIdentities_([
    asset.RECORD_OWNER, asset.BUSINESS_STEWARD, asset.TECHNICAL_STEWARD,
    asset.DPM_TEAM, asset.BDS_TEAM, asset.DATABASE_OWNER, asset.SCHEMA_OWNER,
    asset.SNOWFLAKE_TABLE_OWNER, asset.EMP_L5, asset.EMP_L6
  ]);
}

function extractAssetAccessIdentities_(values) {
  const seen = {};
  (values || []).forEach(function (value) {
    cleanText_(value).split(/[;,\s]+/).forEach(function (part) {
      const identity = normalizeAssetAccessIdentity_(part);
      if (identity) seen[identity] = true;
    });
  });
  return Object.keys(seen);
}

function normalizeAssetAccessIdentity_(value) {
  const identity = cleanText_(value).toLowerCase();
  const salesforceEmail = identity.match(/^([^@\s]+)@salesforce\.com$/);
  if (salesforceEmail) return salesforceEmail[1];
  return /^[a-z0-9][a-z0-9._-]*$/.test(identity) ? identity : '';
}

function canUserViewAsset_(asset, email, role) {
  const accessEmails = getUserAccessEmails_(email, role);
  return canAccessAssetWithEmails_(asset, accessEmails);
}

function canAccessAssetWithEmails_(asset, accessEmails) {
  if (accessEmails === null) return true;
  const recordIdentities = getAssetRoleEmails_(asset);
  return accessEmails.some(function (allowedEmail) {
    return recordIdentities.indexOf(normalizeAssetAccessIdentity_(allowedEmail)) !== -1;
  });
}

function assertAssetViewAuthorization_(asset, email, role) {
  if (!asset || !canUserViewAsset_(asset, email, role)) {
    throw new Error('This asset was not found or you do not have access to it.');
  }
  return true;
}

function getMyTeam() {
  const email = assertSalesforceEmail_(getCurrentUserEmail_());
  const team = getTeamForEmail_(email);
  return { userEmail: email, team: team ? teamToClient_(team, email, isAdminEmail_(email)) : null };
}

function listTeamsForAdmin() {
  const actor = assertAdmin_();
  return {
    userEmail: actor.email,
    teams: readTeamRecords_(true).map(function (team) { return teamToClient_(team, actor.email, true); })
      .sort(function (left, right) { return left.name.localeCompare(right.name); })
  };
}

function createTeam(input) {
  const actorEmail = assertSalesforceEmail_(getCurrentUserEmail_());
  const payload = input || {};
  const requestedOwner = cleanText_(payload.ownerEmail).toLowerCase();
  let ownerEmail = actorEmail;
  if (requestedOwner && requestedOwner !== actorEmail) {
    assertAdmin_();
    ownerEmail = assertSalesforceEmail_(requestedOwner);
  }
  const teamName = normalizeTeamName_(payload.name);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (getTeamForEmail_(ownerEmail)) throw new Error(ownerEmail + ' already belongs to an active team.');
    const now = nowIso_();
    const team = {
      TEAM_ID: Utilities.getUuid(), TEAM_NAME: teamName, OWNER_EMAIL: ownerEmail,
      MEMBER_EMAILS: '', CREATED_AT: now, UPDATED_AT: now, UPDATED_BY: actorEmail, ACTIVE: 'TRUE'
    };
    ensureTeamsSheet_();
    upsertObject_(APP.sheets.teams, 'TEAM_ID', team);
    return teamToClient_(team, actorEmail, isAdminEmail_(actorEmail));
  } finally {
    lock.releaseLock();
  }
}

function renameTeam(input) {
  return mutateTeam_(input, function (team, payload) {
    team.TEAM_NAME = normalizeTeamName_(payload.name);
  });
}

function addTeamMember(input) {
  return mutateTeam_(input, function (team, payload) {
    const email = assertSalesforceEmail_(payload.email);
    const existingTeam = getTeamForEmail_(email);
    if (existingTeam && existingTeam.TEAM_ID !== team.TEAM_ID) throw new Error(email + ' already belongs to another active team.');
    const members = teamMemberEmails_(team);
    if (members.indexOf(email) !== -1) throw new Error(email + ' is already on this team.');
    const owner = cleanText_(team.OWNER_EMAIL).toLowerCase();
    team.MEMBER_EMAILS = members.filter(function (member) { return member !== owner; }).concat([email]).sort().join(',');
  });
}

function updateTeamMember(input) {
  return mutateTeam_(input, function (team, payload) {
    const originalEmail = assertSalesforceEmail_(payload.originalEmail);
    const replacementEmail = assertSalesforceEmail_(payload.email);
    const owner = cleanText_(team.OWNER_EMAIL).toLowerCase();
    if (originalEmail === owner) throw new Error('The team owner email cannot be changed here.');
    const members = teamMemberEmails_(team);
    if (members.indexOf(originalEmail) === -1) throw new Error('The team member is no longer present. Refresh and try again.');
    if (replacementEmail !== originalEmail && members.indexOf(replacementEmail) !== -1) throw new Error(replacementEmail + ' is already on this team.');
    const existingTeam = getTeamForEmail_(replacementEmail);
    if (existingTeam && existingTeam.TEAM_ID !== team.TEAM_ID) throw new Error(replacementEmail + ' already belongs to another active team.');
    const updated = members.filter(function (member) { return member !== owner && member !== originalEmail && member !== replacementEmail; });
    updated.push(replacementEmail);
    team.MEMBER_EMAILS = updated.sort().join(',');
  });
}

function removeTeamMember(input) {
  return mutateTeam_(input, function (team, payload) {
    const email = assertSalesforceEmail_(payload.email);
    const owner = cleanText_(team.OWNER_EMAIL).toLowerCase();
    if (email === owner) throw new Error('The team owner cannot be removed.');
    const members = teamMemberEmails_(team);
    if (members.indexOf(email) === -1) throw new Error('The team member is no longer present. Refresh and try again.');
    team.MEMBER_EMAILS = members.filter(function (member) { return member !== owner && member !== email; }).sort().join(',');
  });
}

function setTeamActive(input) {
  const actor = assertAdmin_();
  const payload = input || {};
  const active = Boolean(payload.active);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const team = findTeamById_(payload.teamId, true);
    if (active) {
      teamMemberEmails_(team).forEach(function (email) {
        const existing = getTeamForEmail_(email);
        if (existing && existing.TEAM_ID !== team.TEAM_ID) throw new Error(email + ' already belongs to another active team.');
      });
    }
    team.ACTIVE = active ? 'TRUE' : 'FALSE';
    team.UPDATED_AT = nowIso_();
    team.UPDATED_BY = actor.email;
    upsertObject_(APP.sheets.teams, 'TEAM_ID', team);
    return teamToClient_(team, actor.email, true);
  } finally {
    lock.releaseLock();
  }
}

function mutateTeam_(input, mutator) {
  const payload = input || {};
  const actorEmail = assertSalesforceEmail_(getCurrentUserEmail_());
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const team = findTeamById_(payload.teamId, false);
    const members = teamMemberEmails_(team);
    if (!isAdminEmail_(actorEmail) && members.indexOf(actorEmail) === -1) throw new Error('You do not have permission to manage this team.');
    mutator(team, payload);
    team.UPDATED_AT = nowIso_();
    team.UPDATED_BY = actorEmail;
    upsertObject_(APP.sheets.teams, 'TEAM_ID', team);
    return teamToClient_(team, actorEmail, isAdminEmail_(actorEmail));
  } finally {
    lock.releaseLock();
  }
}

function findTeamById_(teamId, includeInactive) {
  const id = cleanText_(teamId);
  const team = readTeamRecords_(Boolean(includeInactive)).find(function (item) { return item.TEAM_ID === id; });
  if (!team) throw new Error('Team not found. Refresh and try again.');
  return team;
}

function normalizeTeamName_(value) {
  const name = cleanText_(value);
  if (name.length < 2 || name.length > 80) throw new Error('Team name must contain 2 to 80 characters.');
  return name;
}

function assertSalesforceEmail_(value) {
  const email = cleanText_(value).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@salesforce\.com$/.test(email)) {
    throw new Error('Enter a valid @salesforce.com email address.');
  }
  return email;
}
