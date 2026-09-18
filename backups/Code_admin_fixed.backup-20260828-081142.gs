/**
 * Woomi recruitment ATS - Google Apps Script backend.
 *
 * Deploy this file as a Web App and use the /exec URL in the ATS.
 * It supports the existing ATS Google Sheets API plus employee-email
 * verification and referral file uploads.
 *
 * Required sheets:
 * Candidates, Interviews, Positions, RecruitPlans, Referrals, Rewards,
 * RefRules, Interviewers, Employees, Settings
 *
 * Optional Settings:
 * referralDataUrl: Google Sheets file URL for Referrals/Rewards/RefRules.
 *                 If empty, referral sheets stay in this script's bound file.
 *
 * Interviewers/Employees header:
 * email | name | empNo | dept | status | updatedAt
 */

const REFERRAL_UPLOAD_FOLDER_ID = 'PUT_GOOGLE_DRIVE_FOLDER_ID_HERE';
const ADMIN_TOKEN_PROPERTY = 'RECRUITMENT_ADMIN_TOKEN';
const ADMIN_ALLOWLIST_PROPERTY = 'RECRUITMENT_ADMIN_ALLOWLIST';
const LOCAL_ADMIN_USERS_PROPERTY = 'RECRUITMENT_LOCAL_ADMIN_USERS';
const ADMIN_SESSION_SECONDS_PROPERTY = 'RECRUITMENT_ADMIN_SESSION_SECONDS';
const DEPLOYMENT_ROLE_PROPERTY = 'RECRUITMENT_DEPLOYMENT_ROLE';
const OPENAI_API_KEY_PROPERTY = 'OPENAI_API_KEY';
const EMPLOYEE_DIRECTORY_LOOKUP_TOKEN_PROPERTY = 'INTERVIEWER_DB_LOOKUP_TOKEN';
const EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY = 'INTERVIEWER_DB_ADMIN_TOKEN';
const REFERRAL_CODE_TTL_SECONDS = 10 * 60;
const REFERRAL_TOKEN_TTL_SECONDS = 60 * 60;
const REFERRAL_CODE_SEND_LIMIT = 3;
const REFERRAL_CODE_VERIFY_LIMIT = 5;
const REFERRAL_CODE_LOCK_SECONDS = 10 * 60;
const REFERRAL_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REFERRAL_ALLOWED_EXTENSIONS = ['pdf','doc','docx','ppt','pptx','hwp','hwpx','zip'];
const CHANGE_LOG_SHEET = '_Changes';
const REFERRAL_EMPLOYEE_DIRECTORY_SHEETS = ['Interviewers', 'Employees'];
const REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS = ['referralEmployeeDirectoryUrl', 'interviewerUrl'];
const REFERRAL_DATA_SHEETS = ['Referrals', 'Rewards', 'RefRules'];
const REFERRAL_DATA_URL_PROPERTY = 'REFERRAL_DATA_SPREADSHEET_URL';
const REFERRAL_DATA_URL_SETTING_KEYS = ['referralDataUrl', 'referralStorageUrl'];
const EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS = 5 * 60;
const EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX = 'empDirChunk_';
const EMPLOYEE_DIRECTORY_CACHE_CHUNK_SIZE = 50000;
// 레퍼런스체크 후보자/추천인 링크는 최소 며칠~몇 주 동안 유효해야 하는데
// CacheService는 최대 보관 시간이 6시간으로 제한돼 있어 쓸 수 없다(referralToken류와의 핵심 차이).
// 그래서 토큰을 캐시가 아니라 시트의 컬럼 값으로 저장하고, 매 요청마다 시트에서 대조한다.
const REFERENCE_LINK_TTL_DAYS = 21;
const REFERENCE_MAX_REFEREES = 5;
const REFERENCE_CANDIDATE_PAGE_URL = 'PUT_REFERENCE_CANDIDATE_PAGE_URL_HERE'; // 예: https://wmpeopleteam.github.io/reference-check/candidate.html
const REFERENCE_RESPONSE_PAGE_URL = 'PUT_REFERENCE_RESPONSE_PAGE_URL_HERE'; // 예: https://wmpeopleteam.github.io/reference-check/response.html

const SHEET_SCHEMAS = {
  Candidates: ['id','name','pos','email','etype','role','dept','career','stage','ref','refD','refT','receivedAt','docPassedAt','memo','rejectedAt','rejectReason','rejectMemo','finalAt','decision','notified','mailPending','mailPendingLabel','posId','intDate','held','lastCompletedStage','lastStageChangedAt','updatedAt'],
  Interviews: ['id','candId','candName','type','date','loc','panel','memo','notified','candidateNotified','panelNotified','mailPending','status','slots','result','note','evaluatedAt','updatedAt'],
  Positions: ['id','title','etype','role','headcount','dept','location','team','jobType','panel1','panel2','loc','owner','targetDate','memo','createdAt','status','closedAt','parentPosId','closeReason','closeMemo','updatedAt'],
  RecruitPlans: ['id','year','location','empType','team','jobType','planned','manualDone','manualItv','manualOffer','sortOrder','updatedAt','deletedAt'],
  Referrals: ['id','refEmail','refName','refEmpNo','refDept','posText','posId','candName','candPhone','candPhoneNormalized','candEmail','candEmailNormalized','candCompany','resumeUrl','relation','refItems','consentAt','submittedAt','status','dupFlag','reviewedBy','reviewedAt','rejectReason','validUntil','candId','hireDate','hireCL','updatedAt','updatedBy','deletedAt'],
  Rewards: ['id','referralId','candId','refEmail','hireDate','hireCL','milestone','dueDate','payMonth','payCutoff','amount','status','retentionCheckedBy','retentionCheckedAt','requestedAt','paidAt','cancelReason','updatedAt','updatedBy','deletedAt'],
  RefRules: ['id','recordType','key','value','clFrom','clTo','amount3M','amount6M','effectiveFrom','effectiveTo','isActive','updatedAt'],
  Interviewers: ['email','name','empNo','dept','rank','status','updatedAt'],
  Employees: ['email','name','empNo','dept','status','updatedAt'],
  Settings: ['id','value'],
  ReferenceCandidates: ['id','pipelineCandId','candName','candEmail','positionText','token','tokenExpiresAt','refereesSubmittedAt','status','createdAt','updatedAt'],
  ReferenceResponses: ['id','referenceCandidateId','pipelineCandId','candName','refereeName','refereeEmail','refereeRelation','refereeCompany','token','tokenExpiresAt','submittedAt','status',
    'q1_periodStart','q1_periodEnd','q1_relation','q1_role',
    'q2_startStyle',
    'q3_selfDriven','q3_confirmedWithOthers',
    'q4_successStyle','q4_failureStyle',
    'q5_feedbackResponse',
    'q6_conflictResolution',
    'q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas',
    'q9_word','q9_reason',
    'updatedAt'],
};

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || '';

    if (!action && !isPublicDeployment_()) {
      return HtmlService.createHtmlOutputFromFile('Dashboard')
        .setTitle('채용관리 대시보드')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const sheet = params.sheet || '';
    let data = {};
    if (params.data) data = JSON.parse(params.data);
    if (params.id) data.id = params.id;
    return routeRequest_({ action: action || 'getAll', sheet, data, query: params });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const payload = JSON.parse(body || '{}');
    return routeRequest_(payload);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function routeRequest_(payload) {
  const securityResult = handleReferralSecurityAction_(payload);
  if (securityResult) return securityResult;

  const action = payload.action || '';
  const sheetName = payload.sheet || '';
  const data = payload.data || {};
  const query = payload.query || payload || {};
  const isPublicReferralSubmit = action === 'upsert' && sheetName === 'Referrals' && data && data.verificationToken;
  const isAdmin = !isPublicDeployment_() && isAdminRequest_(payload);

  if (!isAdmin && !isPublicReferralSubmit) throw new Error('admin_auth_required');

  if (action === 'generateReferenceSummary') return generateReferenceSummary_(data);
  if (action === 'getCursor') return json_({ cursor: getChangeCursor_(), serverTime: nowIso_() });
  if (action === 'getChanges') return getChanges_(query);

  assertKnownSheet_(sheetName);
  ensureSheet_(sheetName);

  if (action === 'getAll') return getAll_(sheetName, query);
  if (action === 'upsert') return upsert_(sheetName, data, isAdmin);
  if (action === 'batchUpsert') return batchUpsert_(sheetName, data, isAdmin);
  if (action === 'replaceAll') return replaceAll_(sheetName, data, isAdmin);
  if (action === 'deleteRow') return deleteRow_(sheetName, data.id);

  return json_({ error: 'unknown_action' });
}

function getAll_(sheetName, query) {
  const rows = readRows_(sheetName);
  const since = query && query.since ? String(query.since) : '';
  if (!since) {
    return json_({ data: rows, cursor: getChangeCursor_(), serverTime: nowIso_() });
  }

  const changedIds = {};
  const changes = readChangesAfter_(Number(since) || 0, 5000)
    .filter(change => change.sheet === sheetName);
  changes.forEach(change => { changedIds[String(change.id)] = true; });

  const key = primaryKey_(sheetName);
  const data = rows.filter(row => changedIds[String(row[key])] || String(row.updatedAt || '') >= since);
  return json_({ data, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function upsert_(sheetName, row, isAdmin) {
  let source = Object.assign({}, row || {});

  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const id = String(source[key] || '').trim();
  if (!id) return json_({ error: 'missing_id' });

  const rowIndex = findRowIndex_(sheet, key, id, headers);
  if (sheetName === 'Referrals') {
    source = secureReferralRowForUpsert_(source, rowIndex > 0, isAdmin);
  }

  source.updatedAt = source.updatedAt || nowIso_();
  const normalized = schemaRow_(sheetName, source);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);

  appendChange_(sheetName, 'upsert', id, normalized);
  if (sheetName === 'Referrals' && !isAdmin && rowIndex < 0) sendReferralReceipt_(normalized);
  return json_({ status: 'ok', id, data: normalized, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function batchUpsert_(sheetName, rows, isAdmin) {
  const source = Array.isArray(rows) ? rows : [];
  let count = 0;
  source.forEach(row => {
    const result = JSON.parse(upsertRaw_(sheetName, row, isAdmin).getContent());
    if (!result.error) count++;
  });
  return json_({ status: 'ok', count, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function upsertRaw_(sheetName, row, isAdmin) {
  return upsert_(sheetName, row, isAdmin);
}

function replaceAll_(sheetName, rows, isAdmin) {
  if (!isAdmin) throw new Error('admin_auth_required');
  const source = Array.isArray(rows) ? rows : [];
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
  }
  const normalizedRows = source.map(row => {
    const next = Object.assign({}, row || {});
    next.updatedAt = next.updatedAt || nowIso_();
    return schemaRow_(sheetName, next);
  });
  if (normalizedRows.length) {
    const values = normalizedRows.map(row => headers.map(header => row[header] == null ? '' : row[header]));
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }
  appendChange_(sheetName, 'replaceAll', 'all', { count: normalizedRows.length });
  return json_({ status: 'ok', count: normalizedRows.length, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function deleteRow_(sheetName, id) {
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const cleanId = String(id || '').trim();
  if (!cleanId) return json_({ error: 'missing_id' });

  const rowIndex = findRowIndex_(sheet, key, cleanId, headers);
  if (rowIndex > 0) sheet.deleteRow(rowIndex);
  appendChange_(sheetName, 'delete', cleanId, {});
  return json_({ status: 'deleted', id: cleanId, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function getChanges_(query) {
  const cursor = Number(query && query.cursor) || 0;
  const limit = Math.min(Number(query && query.limit) || 500, 1000);
  const latestCursor = getChangeCursor_();
  const changes = readChangesAfter_(cursor, limit);
  const nextCursor = changes.length ? Number(changes[changes.length - 1].cursor) : latestCursor;
  return json_({
    changes,
    cursor: nextCursor,
    latestCursor,
    serverTime: nowIso_(),
    resyncRequired: false,
    hasMore: nextCursor < latestCursor
  });
}

function handleReferralSecurityAction_(payload) {
  if (!payload) return null;
  if (payload.action === 'sendReferralVerificationCode') return sendReferralVerificationCode_(payload);
  if (payload.action === 'verifyReferralCode') return verifyReferralCode_(payload);
  if (payload.action === 'uploadReferralFile') return uploadReferralFile_(payload);
  if (payload.action === 'getMyReferrals') return getMyReferrals_(payload);
  if (payload.action === 'getInterviewersFromDirectory') return getInterviewersFromDirectory_(payload);
  if (payload.action === 'issueReferenceCandidateLink') return issueReferenceCandidateLink_(payload);
  if (payload.action === 'verifyReferenceCandidateToken') return verifyReferenceCandidateToken_(payload);
  if (payload.action === 'submitReferenceCandidateReferees') return submitReferenceCandidateReferees_(payload);
  if (payload.action === 'verifyReferenceRefereeToken') return verifyReferenceRefereeToken_(payload);
  if (payload.action === 'submitReferenceResponse') return submitReferenceResponse_(payload);
  if (payload.action === 'resendReferenceRefereeLink') return resendReferenceRefereeLink_(payload);
  return null;
}

function sendReferralVerificationCode_(payload) {
  const empNo = normalizeEmpNo_(payload.empNo);
  if (isReferralCodeLocked_(empNo)) return json_({ ok: true });
  if (!allowReferralCodeSend_(empNo)) return json_({ ok: true });
  const employee = findActiveEmployeeByEmpNo_(empNo);

  // Do not reveal whether the employee number exists in the employee directory.
  if (!employee) return json_({ ok: true });
  if (!employee.email || !employee.email.includes('@')) return json_({ error: 'employee_email_missing' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put(referralCodeKey_(empNo), JSON.stringify({
    code,
    empNo,
    email: employee.email,
    issuedAt: nowIso_()
  }), REFERRAL_CODE_TTL_SECONDS);

  try {
    MailApp.sendEmail({
      to: employee.email,
      subject: '[우미건설] 사내추천 인증번호',
      body: [
        '사내추천 접수를 위한 인증번호입니다.',
        '',
        '인증번호: ' + code,
        '',
        '인증번호는 10분 동안 유효합니다.',
        '본인이 요청하지 않았다면 이 메일을 무시해주세요.',
        '',
        '우미건설 피플팀'
      ].join('\n')
    });
  } catch (err) {
    console.warn('sendReferralVerificationCode_ failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true });
}

function verifyReferralCode_(payload) {
  const empNo = normalizeEmpNo_(payload.empNo);
  const code = String(payload.code || '').trim();
  if (isReferralCodeLocked_(empNo)) {
    return json_({ ok: false, error: 'too_many_attempts' });
  }
  const cache = CacheService.getScriptCache();
  const saved = JSON.parse(cache.get(referralCodeKey_(empNo)) || 'null');
  const employee = findActiveEmployeeByEmpNo_(empNo);

  if (!employee || !saved || saved.code !== code) {
    recordReferralCodeFailure_(empNo);
    return json_({ ok: false, error: 'invalid_or_expired_code' });
  }

  const token = Utilities.getUuid();
  cache.remove(referralCodeKey_(empNo));
  clearReferralCodeFailures_(empNo);
  cache.put(referralTokenKey_(token), JSON.stringify({
    email: employee.email,
    empNo: employee.empNo,
    issuedAt: nowIso_()
  }), REFERRAL_TOKEN_TTL_SECONDS);

  return json_({
    ok: true,
    token,
    employee: {
      email: employee.email,
      name: employee.name,
      empNo: employee.empNo,
      dept: employee.dept
    }
  });
}

function uploadReferralFile_(payload) {
  const employee = validateReferralToken_(payload.verificationToken, payload.refEmail);
  if (!employee) return json_({ error: 'verification_required' });
  if (!payload.referralId || !payload.fileName || !payload.data) {
    return json_({ error: 'missing_upload_fields' });
  }
  const safeName = String(payload.fileName).replace(/[\\/:*?"<>|]/g, '_');
  const ext = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : '';
  if (!REFERRAL_ALLOWED_EXTENSIONS.includes(ext)) return json_({ error: 'unsupported_file_type' });
  const estimatedBytes = Math.floor(String(payload.data || '').length * 3 / 4);
  if (estimatedBytes > REFERRAL_MAX_UPLOAD_BYTES) return json_({ error: 'file_too_large' });
  if (REFERRAL_UPLOAD_FOLDER_ID === 'PUT_GOOGLE_DRIVE_FOLDER_ID_HERE') {
    return json_({ error: 'missing_upload_folder_id' });
  }

  const folder = DriveApp.getFolderById(REFERRAL_UPLOAD_FOLDER_ID);
  const bytes = Utilities.base64Decode(payload.data);
  if (bytes.length > REFERRAL_MAX_UPLOAD_BYTES) return json_({ error: 'file_too_large' });
  const prefix = [payload.referralId, employee.empNo || employee.email, payload.candName || 'candidate']
    .join('_')
    .replace(/[\\/:*?"<>|]/g, '_');
  const blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', prefix + '_' + safeName);
  const file = folder.createFile(blob);
  hardenUploadedFileSharing_(file);

  return json_({
    ok: true,
    fileId: file.getId(),
    url: file.getUrl(),
    fileName: file.getName()
  });
}

function hardenUploadedFileSharing_(file) {
  try {
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (err) {
    console.warn('hardenUploadedFileSharing_ failed: ' + String(err && err.message || err));
  }
}

function getMyReferrals_(payload) {
  const employee = validateReferralToken_(payload.verificationToken, payload.refEmail || payload.email);
  if (!employee) return json_({ error: 'verification_required' });
  const email = employee.email;
  const referralRows = readRows_('Referrals')
    .filter(row => normalizeEmail_(row.refEmail) === email && !row.deletedAt)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  const rewardRows = readRows_('Rewards').filter(row => !row.deletedAt);
  const data = referralRows.map(row => {
    const refItems = parseRefItems_(row.refItems);
    return {
      id: row.id,
      submittedAt: row.submittedAt,
      validUntil: row.validUntil,
      status: compactReferralStatus_(row.status),
      candidateLabel: maskName_(row.candName),
      posText: row.posText || '',
      referralTrack: refItems.referralTrack || '',
      actionRequirementStatus: refItems.actionRequirementStatus || '',
      rewardEligibilityStatus: refItems.rewardEligibilityStatus || '',
      rewards: rewardRows
        .filter(reward => String(reward.referralId) === String(row.id))
        .map(reward => ({
          milestone: reward.milestone,
          dueDate: reward.dueDate,
          payMonth: reward.payMonth,
          amount: reward.amount,
          status: compactRewardStatus_(reward.status)
        }))
    };
  });
  return json_({ ok: true, data });
}

function buildReferenceCandidateLinkUrl_(token) {
  return buildUrlWithParams_(REFERENCE_CANDIDATE_PAGE_URL, { token });
}

function buildReferenceResponseLinkUrl_(token) {
  return buildUrlWithParams_(REFERENCE_RESPONSE_PAGE_URL, { token });
}

function referenceLinkExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

// 대시보드에서 후보자가 "레퍼런스" 단계로 이동할 때 관리자 권한으로 호출.
// 후보자에게 추천인 등록 링크를 발급하고 메일로 보낸다.
function issueReferenceCandidateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const candName = String(payload.candName || '').trim();
  const candEmail = normalizeEmail_(payload.candEmail);
  const positionText = String(payload.positionText || '').trim();
  const pipelineCandId = String(payload.candId || '').trim();
  if (!candName || !candEmail) return json_({ error: 'missing_candidate_fields' });

  const token = Utilities.getUuid();
  const row = {
    id: 'RC-' + Utilities.getUuid(),
    pipelineCandId, candName, candEmail, positionText, token,
    tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    refereesSubmittedAt: '',
    status: 'SENT',
    createdAt: nowIso_(),
    updatedAt: nowIso_()
  };
  const sheet = ensureSheet_('ReferenceCandidates');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceCandidates);
  sheet.appendRow(headers.map(h => row[h] == null ? '' : row[h]));
  appendChange_('ReferenceCandidates', 'upsert', row.id, row);

  try {
    MailApp.sendEmail({
      to: candEmail,
      subject: '[우미건설] 레퍼런스 체크 - 추천인 등록 안내',
      body: [
        candName + '님, 안녕하세요.',
        '',
        '채용 절차의 일환으로 레퍼런스 체크를 진행합니다.',
        '아래 링크에서 함께 일했던 분들의 연락처를 등록해 주세요.',
        '',
        buildReferenceCandidateLinkUrl_(token),
        '',
        `링크는 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
        '',
        '우미건설 피플팀'
      ].join('\n')
    });
  } catch (err) {
    console.warn('issueReferenceCandidateLink_ mail failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true, id: row.id });
}

// 후보자가 등록 링크를 열었을 때 화면에 본인 이름을 띄우기 위한 토큰 검증.
function verifyReferenceCandidateToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceCandidates').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    candName: row.candName,
    positionText: row.positionText,
    alreadySubmitted: !!row.refereesSubmittedAt
  });
}

// 후보자가 추천인 목록(이름/이메일/관계/소속)을 제출하면, 추천인별로 별도 토큰을 발급해
// ReferenceResponses에 한 줄씩 만들고 각 추천인에게 응답 링크를 메일로 보낸다.
function submitReferenceCandidateReferees_(payload) {
  const token = String(payload.token || '').trim();
  const referees = Array.isArray(payload.referees) ? payload.referees : [];
  if (!token) return json_({ error: 'token_required' });
  if (!referees.length) return json_({ error: 'at_least_one_referee_required' });
  if (referees.length > REFERENCE_MAX_REFEREES) return json_({ error: 'too_many_referees' });

  const candSheet = ensureSheet_('ReferenceCandidates');
  const candHeaders = ensureHeaders_(candSheet, SHEET_SCHEMAS.ReferenceCandidates);
  const rowIndex = findRowIndex_(candSheet, 'token', token, candHeaders);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const candRow = readRows_('ReferenceCandidates')[rowIndex - 2];
  if (referenceLinkExpired_(candRow)) return json_({ error: 'token_expired' });

  const responseSheet = ensureSheet_('ReferenceResponses');
  const responseHeaders = ensureHeaders_(responseSheet, SHEET_SCHEMAS.ReferenceResponses);
  let issuedCount = 0;

  referees.forEach(ref => {
    const refereeName = String(ref && ref.name || '').trim();
    const refereeEmail = normalizeEmail_(ref && ref.email);
    if (!refereeName || !refereeEmail) return;
    const refereeRelation = String(ref && ref.relation || '').trim();
    const refereeCompany = String(ref && ref.company || '').trim();
    const refToken = Utilities.getUuid();
    const row = {
      id: 'RR-' + Utilities.getUuid(),
      referenceCandidateId: candRow.id,
      pipelineCandId: candRow.pipelineCandId || '',
      candName: candRow.candName,
      refereeName, refereeEmail, refereeRelation, refereeCompany,
      token: refToken,
      tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      submittedAt: '',
      status: 'SENT',
      updatedAt: nowIso_()
    };
    responseSheet.appendRow(responseHeaders.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceResponses', 'upsert', row.id, row);
    issuedCount++;

    try {
      MailApp.sendEmail({
        to: refereeEmail,
        subject: '[우미건설] 레퍼런스 체크 요청 - ' + candRow.candName + '님',
        body: [
          refereeName + '님, 안녕하세요.',
          '',
          candRow.candName + '님의 채용 절차와 관련해 레퍼런스 체크를 요청드립니다.',
          '아래 링크에서 설문에 응답해 주시면 됩니다. 소요 시간은 10분 내외입니다.',
          '',
          buildReferenceResponseLinkUrl_(refToken),
          '',
          `링크는 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
          '',
          '우미건설 피플팀'
        ].join('\n')
      });
    } catch (err) {
      console.warn('submitReferenceCandidateReferees_ mail failed: ' + String(err && err.message || err));
    }
  });

  if (!issuedCount) return json_({ error: 'no_valid_referees' });

  const updatedAtCol = candHeaders.indexOf('updatedAt') + 1;
  const submittedAtCol = candHeaders.indexOf('refereesSubmittedAt') + 1;
  const statusCol = candHeaders.indexOf('status') + 1;
  candSheet.getRange(rowIndex, submittedAtCol).setValue(nowIso_());
  candSheet.getRange(rowIndex, statusCol).setValue('REFEREES_REGISTERED');
  candSheet.getRange(rowIndex, updatedAtCol).setValue(nowIso_());
  appendChange_('ReferenceCandidates', 'upsert', candRow.id, { status: 'REFEREES_REGISTERED' });

  return json_({ ok: true, count: issuedCount });
}

// 추천인이 응답 링크를 열었을 때 화면에 후보자 이름을 띄우기 위한 토큰 검증.
function verifyReferenceRefereeToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceResponses').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });
  return json_({ ok: true, candName: row.candName, refereeName: row.refereeName });
}

// 추천인의 9문항 응답을 저장한다. 토큰 1개당 1회만 제출 가능.
function submitReferenceResponse_(payload) {
  const token = String(payload.token || '').trim();
  const answers = payload.answers || {};
  if (!token) return json_({ error: 'token_required' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const existing = readRows_('ReferenceResponses')[rowIndex - 2];
  if (existing.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(existing)) return json_({ error: 'token_expired' });

  const ANSWER_KEYS = ['q1_periodStart','q1_periodEnd','q1_relation','q1_role','q2_startStyle','q3_selfDriven','q3_confirmedWithOthers','q4_successStyle','q4_failureStyle','q5_feedbackResponse','q6_conflictResolution','q7_entrustedRoles','q8_reliableAreas','q8_supportNeededAreas','q9_word','q9_reason'];
  const merged = Object.assign({}, existing);
  ANSWER_KEYS.forEach(key => { merged[key] = String(answers[key] == null ? '' : answers[key]).trim(); });
  merged.submittedAt = nowIso_();
  merged.status = 'SUBMITTED';
  merged.updatedAt = nowIso_();

  const values = headers.map(h => merged[h] == null ? '' : merged[h]);
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  return json_({ ok: true });
}

// 관리자가 대시보드에서 미응답 추천인에게 리마인드 메일을 다시 보낼 때 사용.
// 새 토큰을 발급하지 않고 기존 링크를 그대로 재발송한다(이미 열어본 링크가 있을 수 있으므로).
function resendReferenceRefereeLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const id = String(payload.id || '').trim();
  if (!id) return json_({ error: 'missing_id' });
  const row = readRows_('ReferenceResponses').find(r => String(r.id) === id);
  if (!row) return json_({ error: 'not_found' });
  if (row.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(row)) return json_({ error: 'token_expired' });

  try {
    MailApp.sendEmail({
      to: row.refereeEmail,
      subject: '[우미건설] 레퍼런스 체크 요청 (재안내) - ' + row.candName + '님',
      body: [
        row.refereeName + '님, 안녕하세요.',
        '',
        row.candName + '님의 채용 절차와 관련해 레퍼런스 체크 응답을 다시 한 번 요청드립니다.',
        '아래 링크에서 설문에 응답해 주시면 됩니다. 소요 시간은 10분 내외입니다.',
        '',
        buildReferenceResponseLinkUrl_(row.token),
        '',
        '우미건설 피플팀'
      ].join('\n')
    });
  } catch (err) {
    console.warn('resendReferenceRefereeLink_ mail failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
  return json_({ ok: true });
}

function generateReferenceSummary_(data) {
  const apiKey = getScriptProperty_(OPENAI_API_KEY_PROPERTY);
  if (!apiKey) return json_({ error: 'openai_key_not_configured' });
  const prompt = String(data && data.prompt || '').trim();
  if (!prompt) return json_({ error: 'prompt_required' });
  if (prompt.length > 20000) return json_({ error: 'prompt_too_large' });

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    payload: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 900,
      messages: [
        { role: 'system', content: '당신은 건설회사 피플팀 채용 담당자를 돕는 전문 어시스턴트입니다.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const text = res.getContentText() || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return json_({ error: 'openai_invalid_response' });
  }
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    return json_({ error: parsed.error && parsed.error.message || 'openai_request_failed' });
  }
  return json_({ ok: true, text: parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || '' });
}

function parseRefItems_(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value)) || {};
  } catch (err) {
    return {};
  }
}

function secureReferralRowForUpsert_(row, isExistingRow, isAdmin) {
  if (isAdmin) {
    const adminRow = Object.assign({}, row || {});
    delete adminRow.verificationToken;
    return adminRow;
  }
  if (!row || !row.verificationToken) {
    throw new Error('verification_required');
  }
  if (isExistingRow) throw new Error('public_referral_update_not_allowed');

  const employee = validateReferralToken_(row.verificationToken, row.refEmail);
  if (!employee) throw new Error('verification_required');

  const cleaned = Object.assign({}, row);
  cleaned.refEmail = employee.email;
  cleaned.refName = employee.name;
  cleaned.refEmpNo = employee.empNo;
  cleaned.refDept = employee.dept;
  cleaned.updatedBy = employee.email;
  delete cleaned.verificationToken;
  return cleaned;
}

function secureReferralRowBeforeSave_(row) {
  return secureReferralRowForUpsert_(row, false, false);
}

function validateReferralToken_(token, email) {
  const normalizedEmail = normalizeEmail_(email);
  const saved = JSON.parse(CacheService.getScriptCache().get(referralTokenKey_(token)) || 'null');
  if (!saved || saved.email !== normalizedEmail) return null;
  const employee = saved.empNo ? findActiveEmployeeByEmpNo_(saved.empNo) : findActiveEmployeeByEmail_(normalizedEmail);
  if (!employee) return null;
  if (saved.empNo && normalizeEmpNo_(employee.empNo) !== normalizeEmpNo_(saved.empNo)) return null;
  return employee;
}

function findActiveEmployeeByEmpNo_(empNo) {
  if (!empNo) return null;
  const remote = lookupEmployeeByEmpNoFromUrl_(empNo);
  if (remote) return remote;
  const rows = readEmployeeDirectoryRows_();
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeEmployeeDirectoryRow_(rows[i]);
    if (normalizeEmpNo_(row.empNo) !== empNo) continue;
    return normalizeActiveEmployee_(row);
  }
  return null;
}

function lookupEmployeeByEmpNoFromUrl_(empNo) {
  const url = getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS);
  if (!url) return null;
  const lookupToken = getScriptProperty_(EMPLOYEE_DIRECTORY_LOOKUP_TOKEN_PROPERTY);
  if (!lookupToken) return null;
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'lookupEmployeeByEmpNo',
      empNo: normalizeEmpNo_(empNo),
      lookupToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return null;
    const payload = JSON.parse(res.getContentText() || '{}');
    if (!payload.success || !payload.employee) return null;
    return normalizeActiveEmployee_(normalizeEmployeeDirectoryRow_(payload.employee));
  } catch (err) {
    console.warn('lookupEmployeeByEmpNoFromUrl_ failed: ' + String(err && err.message || err));
    return null;
  }
}

function findActiveEmployeeByEmail_(email) {
  if (!email) return null;
  const rows = readEmployeeDirectoryRows_();
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeEmployeeDirectoryRow_(rows[i]);
    if (normalizeEmail_(row.email) !== email) continue;
    return normalizeActiveEmployee_(row);
  }
  return null;
}

function readEmployeeDirectoryRows_() {
  const rows = [];
  rows.push.apply(rows, fetchEmployeeDirectoryRowsFromUrl_());
  REFERRAL_EMPLOYEE_DIRECTORY_SHEETS.forEach(sheetName => {
    rows.push.apply(rows, readRowsIfSheetExists_(sheetName));
  });
  return dedupeEmployeeDirectoryRows_(rows);
}

function fetchEmployeeDirectoryRowsFromUrl_() {
  const url = getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS);
  if (!url) return [];
  const adminToken = getScriptProperty_(EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY);
  if (!adminToken) return [];
  const cache = CacheService.getScriptCache();
  const cached = readEmployeeDirectoryCache_(cache);
  if (cached) return cached;
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'getInterviewers',
      adminToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return [];
    const payload = JSON.parse(res.getContentText() || '{}');
    let rows = [];
    if (Array.isArray(payload.interviewers)) rows = payload.interviewers;
    else if (Array.isArray(payload.data)) rows = payload.data;
    else if (Array.isArray(payload.rows)) rows = payload.rows;
    writeEmployeeDirectoryCache_(cache, rows);
    return rows;
  } catch (err) {
    console.warn('fetchEmployeeDirectoryRowsFromUrl_ failed: ' + String(err && err.message || err));
  }
  return [];
}

// 면접관 DB 응답(1700명대, ~400KB)을 매 요청마다 새로 받아오면 느려서(수십 초까지 발생)
// CacheService에 청크 단위로 잘라 5분간 캐시한다. 한 키당 100KB 제한이 있어 5만자 단위로 분할.
function writeEmployeeDirectoryCache_(cache, rows) {
  try {
    const json = JSON.stringify(rows);
    const chunkSize = EMPLOYEE_DIRECTORY_CACHE_CHUNK_SIZE;
    const chunkCount = Math.max(1, Math.ceil(json.length / chunkSize));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = json.slice(i * chunkSize, (i + 1) * chunkSize);
      cache.put(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + i, chunk, EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS);
    }
    cache.put(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + 'count', String(chunkCount), EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn('writeEmployeeDirectoryCache_ failed: ' + String(err && err.message || err));
  }
}

function readEmployeeDirectoryCache_(cache) {
  try {
    const countStr = cache.get(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + 'count');
    if (!countStr) return null;
    const count = Number(countStr);
    if (!Number.isFinite(count) || count <= 0) return null;
    let json = '';
    for (let i = 0; i < count; i++) {
      const chunk = cache.get(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + i);
      if (chunk == null) return null;
      json += chunk;
    }
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

function readRowsIfSheetExists_(sheetName) {
  const ss = getMainSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  return readRows_(sheetName);
}

function getInterviewersFromDirectory_(payload) {
  const data = payload && payload.data || {};
  const url = String(data.url || getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS) || '').trim();
  if (!url) return json_({ success: false, error: 'interviewer_url_missing', interviewers: [] });
  const adminToken = getScriptProperty_(EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY);
  if (!adminToken) return json_({ success: false, error: 'interviewer_admin_token_missing', interviewers: [] });
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'getInterviewers',
      adminToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    const text = res.getContentText() || '{}';
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
      return json_({ success: false, error: 'interviewer_fetch_failed', status: res.getResponseCode(), interviewers: [] });
    }
    const remote = JSON.parse(text);
    if (!remote.success) return json_({ success: false, error: remote.error || 'interviewer_fetch_failed', interviewers: [] });
    return json_({ success: true, interviewers: remote.interviewers || [] });
  } catch (err) {
    return json_({ success: false, error: String(err && err.message || err), interviewers: [] });
  }
}

function dedupeEmployeeDirectoryRows_(rows) {
  const map = {};
  rows.forEach(row => {
    const normalized = normalizeEmployeeDirectoryRow_(row);
    const key = normalized.empNo || normalized.email;
    if (key && !map[key]) map[key] = normalized;
  });
  return Object.keys(map).map(key => map[key]);
}

function normalizeEmployeeDirectoryRow_(row) {
  row = row || {};
  return {
    email: normalizeEmail_(pickFirst_(row, ['email','mail','companyEmail','회사이메일','이메일'])),
    name: String(pickFirst_(row, ['name','displayName','userName','성명','이름']) || '').trim(),
    empNo: normalizeEmpNo_(pickFirst_(row, ['empNo','employeeNo','employeeId','emp_no','staffNo','사번','직번'])),
    dept: String(pickFirst_(row, ['dept','department','division','team','org','소속','부서','팀']) || '').trim(),
    status: String(pickFirst_(row, ['status','activeStatus','employmentStatus','재직상태','상태']) || '').trim(),
    updatedAt: pickFirst_(row, ['updatedAt','updated_at','수정일'])
  };
}

function buildUrlWithParams_(baseUrl, params) {
  const pairs = [];
  Object.keys(params || {}).forEach(key => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
  });
  if (!pairs.length) return String(baseUrl || '');
  return String(baseUrl || '') + (String(baseUrl || '').indexOf('?') >= 0 ? '&' : '?') + pairs.join('&');
}

function normalizeActiveEmployee_(row) {
  const status = String(row.status || '').trim().toLowerCase();
  const active = !status || ['재직', '재직중', 'active'].includes(status);
  if (!active) return null;
  return {
    email: normalizeEmail_(row.email),
    name: String(row.name || '').trim(),
    empNo: normalizeEmpNo_(row.empNo),
    dept: String(row.dept || '').trim(),
    status
  };
}

function ensureSheet_(sheetName) {
  assertKnownSheet_(sheetName);
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getScriptProperty_(REFERRAL_DATA_URL_PROPERTY) || getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return SpreadsheetApp.openByUrl(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return getMainSpreadsheet_();
}

function ensureHeaders_(sheet, schema) {
  if (!schema || !schema.length) throw new Error('missing_schema');
  const lastColumn = Math.max(sheet.getLastColumn(), schema.length);
  let headers = [];
  if (sheet.getLastRow() >= 1 && lastColumn > 0) {
    headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(v => String(v || '').trim());
  }
  if (!headers.filter(Boolean).length) {
    sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
    return schema.slice();
  }
  const next = headers.slice();
  schema.forEach(header => {
    if (!next.includes(header)) next.push(header);
  });
  if (next.length !== headers.length) {
    sheet.getRange(1, 1, 1, next.length).setValues([next]);
  }
  return next;
}

function readRows_(sheetName) {
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = normalizeCell_(row[index]);
    });
    return obj;
  }).filter(row => String(row[primaryKey_(sheetName)] || '').trim());
}

function schemaRow_(sheetName, row) {
  const schema = SHEET_SCHEMAS[sheetName];
  const result = {};
  schema.forEach(key => {
    result[key] = row[key] == null ? '' : row[key];
  });
  return result;
}

function findRowIndex_(sheet, key, id, headers) {
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error('missing_key_column');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  const target = String(id);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
  }
  return -1;
}

function appendChange_(sheetName, action, id, data) {
  const sheet = ensureChangeLogSheet_();
  const cursor = sheet.getLastRow();
  sheet.appendRow([cursor, nowIso_(), sheetName, action, id, getActiveUserEmail_(), 'ok', JSON.stringify(data || {})]);
}

function ensureChangeLogSheet_() {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(CHANGE_LOG_SHEET);
  if (!sheet) sheet = ss.insertSheet(CHANGE_LOG_SHEET);
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['cursor','timestamp','sheet','action','id','actorEmail','result','data']);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 8)).getValues()[0].map(v => String(v || '').trim());
    const expected = ['cursor','timestamp','sheet','action','id','actorEmail','result','data'];
    let changed = false;
    expected.forEach((header, index) => {
      if (current[index] !== header) {
        current[index] = header;
        changed = true;
      }
    });
    if (changed) sheet.getRange(1, 1, 1, expected.length).setValues([current.slice(0, expected.length)]);
  }
  return sheet;
}

function getChangeCursor_() {
  return Math.max(0, ensureChangeLogSheet_().getLastRow() - 1);
}

function readChangesAfter_(cursor, limit) {
  const sheet = ensureChangeLogSheet_();
  const lastRow = sheet.getLastRow();
  const startDataRow = Math.max(2, Number(cursor) + 2);
  if (lastRow < startDataRow) return [];
  const count = Math.min(Number(limit) || 500, lastRow - startDataRow + 1);
  const values = sheet.getRange(startDataRow, 1, count, 8).getValues();
  return values.map(row => ({
    cursor: Number(row[0]),
    timestamp: normalizeCell_(row[1]),
    sheet: String(row[2] || ''),
    action: String(row[3] || ''),
    id: String(row[4] || ''),
    actorEmail: String(row[5] || ''),
    result: String(row[6] || ''),
    data: parseJsonObject_(row[7])
  }));
}

function parseJsonObject_(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function primaryKey_(sheetName) {
  return ['Employees', 'Interviewers'].includes(sheetName) ? 'email' : 'id';
}

function assertKnownSheet_(sheetName) {
  if (!SHEET_SCHEMAS[sheetName]) throw new Error('unknown_sheet: ' + sheetName);
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmpNo_(value) {
  return String(value || '').trim();
}

function normalizeCell_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  return value == null ? '' : value;
}

function pickFirst_(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = row[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function getFirstSettingValue_(keys) {
  const settings = readRowsIfSheetExists_('Settings');
  for (let i = 0; i < keys.length; i++) {
    const target = String(keys[i] || '');
    const row = settings.find(item => String(item.id || '').trim() === target);
    if (row && String(row.value || '').trim()) return String(row.value).trim();
  }
  return '';
}

function referralCodeKey_(email) {
  return 'referral_code:' + email;
}

function referralCodeSendKey_(empNo) {
  return 'referral_code_send:' + normalizeEmpNo_(empNo);
}

function referralCodeFailKey_(empNo) {
  return 'referral_code_fail:' + normalizeEmpNo_(empNo);
}

function referralCodeLockKey_(empNo) {
  return 'referral_code_lock:' + normalizeEmpNo_(empNo);
}

function allowReferralCodeSend_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return false;
  const cache = CacheService.getScriptCache();
  const key = referralCodeSendKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
  return count <= REFERRAL_CODE_SEND_LIMIT;
}

function isReferralCodeLocked_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return true;
  return !!CacheService.getScriptCache().get(referralCodeLockKey_(empNo));
}

function recordReferralCodeFailure_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return;
  const cache = CacheService.getScriptCache();
  const key = referralCodeFailKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFERRAL_CODE_VERIFY_LIMIT) {
    cache.put(referralCodeLockKey_(empNo), '1', REFERRAL_CODE_LOCK_SECONDS);
    cache.remove(key);
    cache.remove(referralCodeKey_(empNo));
    return;
  }
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
}

function clearReferralCodeFailures_(empNo) {
  const cache = CacheService.getScriptCache();
  cache.remove(referralCodeFailKey_(empNo));
  cache.remove(referralCodeLockKey_(empNo));
}

function referralTokenKey_(token) {
  return 'referral_token:' + String(token || '');
}

function nowIso_() {
  return new Date().toISOString();
}

function isAdminRequest_(payload) {
  const token = String(payload.adminToken || payload.query && payload.query.adminToken || payload.data && payload.data.adminToken || '').trim();
  const configuredToken = getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  if (configuredToken && token === configuredToken) return true;
  const email = getActiveUserEmail_();
  return !!email && getAdminAllowlist_().includes(email);
}

function isPublicDeployment_() {
  return getScriptProperty_(DEPLOYMENT_ROLE_PROPERTY).toLowerCase() === 'public';
}

function getScriptProperty_(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getActiveUserEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (err) {
    return '';
  }
}

function getAdminAllowlist_() {
  return getScriptProperty_(ADMIN_ALLOWLIST_PROPERTY)
    .split(/[,\n;]/)
    .map(email => String(email || '').trim().toLowerCase())
    .filter(Boolean);
}

function isGoogleAllowlistedAdmin_() {
  const email = getActiveUserEmail_();
  return !!email && getAdminAllowlist_().includes(email);
}

function compactReferralStatus_(status) {
  const map = {
    SUBMITTED: '접수',
    REVIEWING: '검토중',
    IN_PROCESS: '전형진행',
    HIRED: '입사',
    REJECTED: '종료',
    EXPIRED: '만료',
    CANCELLED: '종료'
  };
  return map[String(status || '').toUpperCase()] || '접수';
}

function compactRewardStatus_(status) {
  const map = {
    SCHEDULED: '예정',
    RETENTION_OK: '재직확인',
    REQUESTED: '지급요청',
    PAID: '지급완료',
    CANCELLED: '취소'
  };
  return map[String(status || '').toUpperCase()] || '예정';
}

function maskName_(value) {
  const text = String(value || '').trim();
  if (!text) return '후보자';
  if (text.length <= 1) return text + '*';
  return text.slice(0, 1) + '*'.repeat(Math.min(2, text.length - 1));
}

function sendReferralReceipt_(row) {
  try {
    if (!row || !row.refEmail) return;
    MailApp.sendEmail({
      to: row.refEmail,
      subject: '[우미건설] 사내추천 접수 완료',
      body: [
        '사내추천 접수가 완료되었습니다.',
        '',
        '접수번호: ' + row.id,
        '접수일: ' + String(row.submittedAt || '').slice(0, 10),
        '유효기간: ' + String(row.validUntil || '').slice(0, 10),
        '',
        '접수 현황은 추천 접수 화면에서 동일한 사번 인증 후 확인할 수 있습니다.',
        '',
        '우미건설 피플팀'
      ].join('\n')
    });
  } catch (err) {
    console.warn('sendReferralReceipt_ failed: ' + String(err && err.message || err));
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function adminLogin_(payload) {
  const data = payload && payload.data || {};
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };
  if (isAdminLoginLocked_(username)) return { ok: false, error: 'login_locked' };

  const users = getLocalAdminUsers_();
  const expectedHash = users[username];
  if (!expectedHash || sha256Hex_(password) !== expectedHash) {
    recordAdminLoginFailure_(username);
    return { ok: false, error: 'invalid_credentials' };
  }

  clearAdminLoginFailures_(username);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const ttl = getAdminSessionSeconds_();
  CacheService.getScriptCache().put(adminSessionKey_(token), JSON.stringify({
    username,
    issuedAt: nowIso_()
  }), ttl);
  return { ok: true, token, username, expiresIn: ttl };
}

function adminLogout_(payload) {
  const token = getAdminSessionTokenFromPayload_(payload);
  if (token) CacheService.getScriptCache().remove(adminSessionKey_(token));
  return { ok: true };
}

function hasValidAdminSession_(token) {
  token = String(token || '').trim();
  if (!token) return false;
  try {
    const raw = CacheService.getScriptCache().get(adminSessionKey_(token));
    if (!raw) return false;
    const session = JSON.parse(raw);
    return !!session && !!session.username;
  } catch (err) {
    return false;
  }
}

function getAdminSessionTokenFromPayload_(payload) {
  return String(payload && (payload.sessionToken || payload.data && payload.data.sessionToken || payload.query && payload.query.sessionToken) || '').trim();
}

function getLocalAdminUsers_() {
  const raw = getScriptProperty_(LOCAL_ADMIN_USERS_PROPERTY);
  const users = {};
  raw.split(/[,\n;]/).forEach(entry => {
    const text = String(entry || '').trim();
    if (!text) return;
    const idx = text.indexOf(':');
    if (idx <= 0) return;
    const username = text.slice(0, idx).trim().toLowerCase();
    const hash = text.slice(idx + 1).trim().toLowerCase();
    if (username && /^[a-f0-9]{64}$/.test(hash)) users[username] = hash;
  });
  return users;
}

function getAdminSessionSeconds_() {
  const configured = Number(getScriptProperty_(ADMIN_SESSION_SECONDS_PROPERTY));
  if (!Number.isFinite(configured) || configured <= 0) return 6 * 60 * 60;
  return Math.max(60, Math.min(configured, 6 * 60 * 60));
}

function adminSessionKey_(token) {
  return 'admin_session:' + token;
}

function adminLoginFailKey_(username) {
  return 'admin_login_fail:' + username;
}

function adminLoginLockKey_(username) {
  return 'admin_login_lock:' + username;
}

function isAdminLoginLocked_(username) {
  return !!CacheService.getScriptCache().get(adminLoginLockKey_(username));
}

function recordAdminLoginFailure_(username) {
  const cache = CacheService.getScriptCache();
  const key = adminLoginFailKey_(username);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= 5) {
    cache.put(adminLoginLockKey_(username), '1', 10 * 60);
    cache.remove(key);
  } else {
    cache.put(key, String(count), 10 * 60);
  }
}

function clearAdminLoginFailures_(username) {
  const cache = CacheService.getScriptCache();
  cache.remove(adminLoginFailKey_(username));
  cache.remove(adminLoginLockKey_(username));
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => {
      const normalized = byte < 0 ? byte + 256 : byte;
      return ('0' + normalized.toString(16)).slice(-2);
    })
    .join('');
}

function makeAdminPasswordHash(password) {
  return sha256Hex_(password || '');
}

function adminApi(payload) {
  try {
    payload = payload || {};
    if (payload.action === 'adminLogin') return adminLogin_(payload);
    if (payload.action === 'adminLogout') return adminLogout_(payload);

    const hasSession = hasValidAdminSession_(getAdminSessionTokenFromPayload_(payload));
    if (!hasSession && !isGoogleAllowlistedAdmin_()) {
      return { error: 'admin_login_required' };
    }

    const nextPayload = Object.assign({}, payload || {});
    nextPayload.adminToken = getScriptProperty_('RECRUITMENT_ADMIN_TOKEN');

    const output = routeRequest_(nextPayload);
    if (output && typeof output.getContent === 'function') {
      const content = output.getContent();
      try {
        return JSON.parse(content);
      } catch (parseErr) {
        return { ok: false, error: 'non_json_response', content: String(content || '') };
      }
    }
    if (typeof output === 'string') {
      try {
        return JSON.parse(output);
      } catch (parseErr) {
        return { ok: false, error: 'non_json_response', content: output };
      }
    }
    if (output && typeof output === 'object') return output;
    return { ok: false, error: 'empty_response' };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}

function getMainSpreadsheet_() {
  const url = getScriptProperty_('RECRUITMENT_SPREADSHEET_URL');
  if (url) return SpreadsheetApp.openByUrl(url);
  return SpreadsheetApp.getActiveSpreadsheet();
}
