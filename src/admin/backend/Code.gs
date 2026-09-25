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

const REFERRAL_UPLOAD_FOLDER_ID_PROPERTY = 'REFERRAL_UPLOAD_FOLDER_ID';
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
const REFERENCE_REQUIRED_REFEREES = 3;
const REFERENCE_CANDIDATE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/reference_candidate_intake.html';
const REFERENCE_RESPONSE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/reference_check_intake.html';
const INTERVIEW_AVAILABILITY_LINK_TTL_DAYS = 10;
const INTERVIEW_AVAILABILITY_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/interview_availability.html';
const REFEREE_VERIFY_ATTEMPT_LIMIT = 5;
const REFEREE_VERIFY_LOCK_SECONDS = 10 * 60;

const SHEET_SCHEMAS = {
  Candidates: ['id','name','pos','email','etype','role','dept','career','source','headhunterId','headhunterName','headhunterManager','headhunterEmail','headhunterPhone','stage','ref','refD','refT','receivedAt','docPassedAt','memo','rejectedAt','rejectReason','rejectMemo','finalAt','joinDate','decision','notified','mailPending','mailPendingLabel','posId','intDate','held','lastCompletedStage','lastStageChangedAt','updatedAt'],
  Interviews: ['id','candId','candName','type','date','loc','panel','memo','notified','candidateNotified','panelNotified','mailPending','status','slots','availabilityOptions','availabilityToken','availabilityExpiresAt','availabilityLink','availabilitySelections','availabilityStatus','availabilityRespondedAt','availabilityNote','result','note','evaluatedAt','updatedAt'],
  PanelAvailability: ['id','positionId','positionTitle','round','panelistName','panelistEmail','availabilityOptions','token','tokenExpiresAt','link','selections','status','respondedAt','note','createdAt','updatedAt'],
  Positions: ['id','title','etype','role','headcount','hireReason','dept','location','team','jobType','panel1','panel2','panel1AvailabilityOptions','panel1AvailabilityRequestedAt','panel1AvailabilityConfirmedAt','panel2AvailabilityOptions','panel2AvailabilityRequestedAt','panel2AvailabilityConfirmedAt','loc','owner','targetDate','memo','createdAt','status','closedAt','parentPosId','closeReason','closeMemo','updatedAt'],
  RecruitPlans: ['id','year','location','empType','team','jobType','planned','manualDone','manualItv','manualOffer','sortOrder','updatedAt','deletedAt'],
  Referrals: ['id','refEmail','refName','refEmpNo','refDept','posText','posId','candName','candPhone','candPhoneNormalized','candEmail','candEmailNormalized','candCompany','resumeUrl','relation','refItems','consentAt','submittedAt','status','dupFlag','reviewedBy','reviewedAt','rejectReason','validUntil','candId','hireDate','hireCL','updatedAt','updatedBy','deletedAt'],
  Rewards: ['id','referralId','candId','refEmail','hireDate','hireCL','milestone','dueDate','payMonth','payCutoff','amount','status','retentionCheckedBy','retentionCheckedAt','requestedAt','paidAt','cancelReason','updatedAt','updatedBy','deletedAt'],
  RefRules: ['id','recordType','key','value','clFrom','clTo','amount3M','amount6M','effectiveFrom','effectiveTo','isActive','updatedAt'],
  Interviewers: ['email','name','empNo','dept','rank','status','updatedAt'],
  Employees: ['email','name','empNo','dept','status','updatedAt'],
  Settings: ['id','value'],
  MailLog: ['id','to','subject','status','error','sentAt'],
  ReferenceCandidates: ['id','pipelineCandId','candName','candEmail','positionText','token','tokenExpiresAt','link','refereesSubmittedAt','status','createdAt','updatedAt'],
  ReferenceResponses: ['id','referenceCandidateId','pipelineCandId','candName','refereeName','refereeEmail','refereePhone','refereeRelation','refereeCompany','token','tokenExpiresAt','link','verifiedAt','submittedAt','status',
    'q1_periodStart','q1_periodEnd','q1_relation','q1_frequency',
    'q1_2_mainTask','q1_2_projectScale','q1_2_soloVsShared',
    'q2_startStyle',
    'q3_judgeStyle','q3_initiative',
    'q4_successNarrative','q4_failureNarrative',
    'q5_feedbackResponse',
    'q6_conflictStyle','q6_example',
    'q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas',
    'q9_word','q9_reason',
    'q10_firstAction','q10_sharedTiming',
    'q11_juniorSupportStyle','q11_example',
    'q12_exitReasonSource','q12_exitReasonDetail',
    'respondentName','respondentAffiliation','respondentContact','respondentConsentObserved','respondentConsentDataUse',
    'updatedAt'],
};

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || '';

    if (!action && !isPublicDeployment_()) {
      return HtmlService.createTemplateFromFile('Dashboard')
        .evaluate()
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
  if (action === 'sendMail' && isAdminRequest_(payload)) return handleSendMail_(payload);
  if (action === 'sendGeneralMail' && isAdminRequest_(payload)) return handleSendGeneralMail_(payload);
  if (action === 'getCursor') return json_({ cursor: getChangeCursor_(), serverTime: nowIso_() });
  if (action === 'getChanges') return getChanges_(query);
  if (action === 'purgeCandidatePii') return purgeCandidatePii_(payload);

  assertKnownSheet_(sheetName);
  ensureSheet_(sheetName);

  if (action === 'getAll') return getAll_(sheetName, query);
  if (action === 'upsert') return upsert_(sheetName, data, isAdmin);
  if (action === 'batchUpsert') return batchUpsert_(sheetName, data, isAdmin);
  if (action === 'replaceAll') return replaceAll_(sheetName, data, isAdmin);
  if (action === 'deleteRow') return deleteRow_(sheetName, data.id);

  return json_({ error: 'unknown_action' });
}

function sendMailViaGmail_(to, subject, body, htmlBody) {
  const recipients = String(to || '').split(/[;,]/).map(function(addr) { return addr.trim(); }).filter(Boolean);
  const cleanSubject = String(subject || '');
  try {
    if (!recipients.length) return { ok: false, error: 'no_recipient' };
    const hasHtml = String(htmlBody || '').trim();
    const options = {
      to: recipients.join(','),
      subject: cleanSubject,
      body: String(body || ''),
      name: '피플팀'
    };
    if (hasHtml) options.htmlBody = String(htmlBody);

    MailApp.sendEmail(options);
    logMailSend_(recipients.join(','), cleanSubject, 'sent', '');
    return { ok: true, to: recipients.join(',') };
  } catch (err) {
    const errorText = String(err && err.message || err);
    logMailSend_(recipients.join(','), cleanSubject, 'failed', errorText);
    return { ok: false, error: errorText };
  }
}

function handleSendMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const result = sendMailViaGmail_(body.toEmail || body.to || body.email, body.subject, body.body || body.message, body.htmlBody);
  return json_(result);
}

function logMailSend_(to, subject, status, error) {
  try {
    const sheet = ensureSheet_('MailLog');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.MailLog);
    const row = {
      id: 'ML-' + Utilities.getUuid(),
      to: String(to || ''),
      subject: String(subject || ''),
      status: String(status || ''),
      error: String(error || '').slice(0, 5000),
      sentAt: nowIso_()
    };
    sheet.appendRow(headers.map(function(h) { return row[h] == null ? '' : row[h]; }));
  } catch (err) {
    console.warn('logMailSend_ failed: ' + String(err && err.message || err));
  }
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

// 쓰기 계열 함수(upsert_/batchUpsert_/replaceAll_/deleteRow_)는 모두 같은 스크립트 락을 사용한다.
// batchUpsert_는 각 행마다 다시 락을 거는 대신, 하나의 락 범위 안에서 upsertUnlocked_를 반복 호출한다
// (Apps Script의 LockService는 같은 실행 안에서 재진입을 지원하지 않으므로 중첩 획득을 피해야 한다).
function upsert_(sheetName, row, isAdmin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return upsertUnlocked_(sheetName, row, isAdmin);
  } finally {
    lock.releaseLock();
  }
}

function upsertUnlocked_(sheetName, row, isAdmin) {
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let count = 0;
    source.forEach(row => {
      const result = JSON.parse(upsertUnlocked_(sheetName, row, isAdmin).getContent());
      if (!result.error) count++;
    });
    return json_({ status: 'ok', count, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

function replaceAll_(sheetName, rows, isAdmin) {
  if (!isAdmin) throw new Error('admin_auth_required');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
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
  } finally {
    lock.releaseLock();
  }
}

function deleteRow_(sheetName, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const cleanId = String(id || '').trim();
    if (!cleanId) return json_({ error: 'missing_id' });

    const rowIndex = findRowIndex_(sheet, key, cleanId, headers);
    if (rowIndex > 0) sheet.deleteRow(rowIndex);
    appendChange_(sheetName, 'delete', cleanId, {});
    return json_({ status: 'deleted', id: cleanId, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

// 조건에 맞는 행을 모두 삭제한다. 뒤에서부터 지워야 앞쪽 삭제로 인한 행 번호 밀림을 피할 수 있다.
function deleteRowsWhere_(sheetName, predicate) {
  const sheet = ensureSheet_(sheetName);
  const rows = readRows_(sheetName);
  const key = primaryKey_(sheetName);
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!predicate(rows[i])) continue;
    sheet.deleteRow(i + 2);
    appendChange_(sheetName, 'delete', String(rows[i][key] || ''), {});
    removed++;
  }
  return removed;
}

// 보존기한이 지난 지원자의 개인정보를 연결된 시트 전체에서 삭제한다(Candidates/Interviews 외
// ReferenceCandidates/ReferenceResponses/MailLog). purgeExpiredPii()가 예전에는 Candidates·Interviews만
// 지우고 나머지는 그대로 남겨 "파기 완료" 표시와 실제 데이터 상태가 어긋나던 문제를 해결한다.
// _Changes 보존·압축 정책은 별도 설계가 필요해 이번 범위에서는 다루지 않는다.
function purgeCandidatePii_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(v => String(v).trim()).filter(Boolean) : [];
  if (!ids.length) return json_({ error: 'missing_candidate_ids' });
  const idSet = new Set(ids);
  const emails = Array.isArray(body.candidateEmails)
    ? body.candidateEmails.map(v => normalizeEmail_(v)).filter(Boolean)
    : [];

  const removed = {
    candidates: deleteRowsWhere_('Candidates', row => idSet.has(String(row.id))),
    interviews: deleteRowsWhere_('Interviews', row => idSet.has(String(row.candId))),
    referenceCandidates: deleteRowsWhere_('ReferenceCandidates', row => idSet.has(String(row.pipelineCandId))),
    referenceResponses: deleteRowsWhere_('ReferenceResponses', row => idSet.has(String(row.pipelineCandId))),
    mailLog: emails.length ? deleteRowsWhere_('MailLog', row =>
      String(row.to || '').split(/[;,]/).some(addr => emails.includes(normalizeEmail_(addr)))
    ) : 0
  };

  return json_({ ok: true, removed, cursor: getChangeCursor_(), serverTime: nowIso_() });
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
  if (payload.action === 'issueInterviewAvailabilityLink') return issueInterviewAvailabilityLink_(payload);
  if (payload.action === 'verifyInterviewAvailabilityToken') return verifyInterviewAvailabilityToken_(payload);
  if (payload.action === 'submitInterviewAvailability') return submitInterviewAvailability_(payload);
  if (payload.action === 'issuePanelAvailabilityLink') return issuePanelAvailabilityLink_(payload);
  if (payload.action === 'getPanelAvailabilityResponses') return getPanelAvailabilityResponses_(payload);
  if (payload.action === 'verifyPanelAvailabilityToken') return verifyPanelAvailabilityToken_(payload);
  if (payload.action === 'submitPanelAvailability') return submitPanelAvailability_(payload);
  if (payload.action === 'verifyReferenceCandidateToken') return verifyReferenceCandidateToken_(payload);
  if (payload.action === 'submitReferenceCandidateReferees') return submitReferenceCandidateReferees_(payload);
  if (payload.action === 'verifyReferenceRefereeToken') return verifyReferenceRefereeToken_(payload);
  if (payload.action === 'verifyRefereeIdentity') return verifyRefereeIdentity_(payload);
  if (payload.action === 'submitReferenceResponse') return submitReferenceResponse_(payload);
  if (payload.action === 'resendReferenceRefereeLink') return resendReferenceRefereeLink_(payload);
  if (payload.action === 'sendReferenceEmail') return sendReferenceEmail_(payload);
  if (payload.action === 'sendGeneralMail') return handleSendGeneralMail_(payload);
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
    const message = [
      '사내추천 접수를 위한 인증번호입니다.',
      '',
      '인증번호: ' + code,
      '',
      '인증번호는 10분 동안 유효합니다.',
      '본인이 요청하지 않았다면 이 메일을 무시해주세요.',
      '',
      '우미건설 피플팀'
    ].join('\n');
    const result = sendMailViaGmail_(employee.email, '[우미건설] 사내추천 인증번호', message);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
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
  const uploadFolderId = getScriptProperty_(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY);
  if (!uploadFolderId) {
    return json_({ error: 'missing_upload_folder_id' });
  }

  const folder = DriveApp.getFolderById(uploadFolderId);
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
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_CANDIDATE_PAGE_URL') || REFERENCE_CANDIDATE_PAGE_URL, { token });
}

function buildReferenceResponseLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_RESPONSE_PAGE_URL') || REFERENCE_RESPONSE_PAGE_URL, { token });
}

function buildInterviewAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, { token });
}

function normalizeInterviewAvailabilityOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, 7).map(item => {
    const date = String(item && item.date || '').trim();
    const periods = Array.isArray(item && item.periods)
      ? item.periods.map(v => String(v || '').toUpperCase()).filter(v => v === 'AM' || v === 'PM')
      : [];
    return { date, periods: periods.filter((v, i, arr) => arr.indexOf(v) === i) };
  }).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.periods.length);
}

function interviewAvailabilityExpired_(row) {
  return !!(row.availabilityExpiresAt && new Date(row.availabilityExpiresAt).getTime() < Date.now());
}

function issueInterviewAvailabilityLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const interviewId = String(body.interviewId || body.id || '').trim();
  const candId = String(body.candId || '').trim();
  const candName = String(body.candName || '').trim();
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!interviewId || !candId || !candName || !options.length) return json_({ error: 'missing_interview_availability_fields' });

  const sheet = ensureSheet_('Interviews');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
  const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
  const existing = readRows_('Interviews').find(row => String(row.id) === interviewId) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const link = buildInterviewAvailabilityLinkUrl_(token);
  const row = Object.assign({}, existing, {
    id: interviewId,
    candId,
    candName,
    type: String(body.type || existing.type || ''),
    loc: String(body.loc || existing.loc || ''),
    status: existing.status || 'pending',
    availabilityOptions: JSON.stringify(options),
    availabilityToken: token,
    availabilityExpiresAt: expiresAt,
    availabilityLink: link,
    availabilitySelections: '',
    availabilityStatus: 'SENT',
    availabilityRespondedAt: '',
    availabilityNote: '',
    updatedAt: nowIso_()
  });
  const normalized = schemaRow_('Interviews', row);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);
  appendChange_('Interviews', 'upsert', interviewId, normalized);
  return json_({ ok: true, interviewId, link, tokenExpiresAt: expiresAt });
}

function verifyInterviewAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  let selections = [];
  try { selections = JSON.parse(row.availabilitySelections || '[]'); } catch (err) {}
  const candidate = readRows_('Candidates').find(item => String(item.id) === String(row.candId)) || {};
  return json_({
    ok: true,
    candName: row.candName || '',
    positionText: candidate.pos || '',
    interviewType: row.type || '',
    location: row.loc || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE',
    unavailable: row.availabilityStatus === 'UNAVAILABLE',
    selections,
    note: row.availabilityNote || ''
  });
}

function submitInterviewAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(v => String(v || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'availabilityToken', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, arr) => allowed[value] && arr.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const next = Object.assign({}, row, {
      availabilitySelections: JSON.stringify(unavailable ? [] : selections),
      availabilityStatus: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      availabilityRespondedAt: nowIso_(),
      availabilityNote: note,
      updatedAt: nowIso_()
    });
    const normalized = schemaRow_('Interviews', next);
    sheet.getRange(rowIndex, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('Interviews', 'upsert', row.id, normalized);
    return json_({ ok: true, status: normalized.availabilityStatus, respondedAt: normalized.availabilityRespondedAt });
  } finally {
    lock.releaseLock();
  }
}

function referenceLinkExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

function invalidatePriorReferenceCandidateLinks_(sheet, headers, pipelineCandId, candEmail) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const idIndex = headers.indexOf('pipelineCandId');
  const emailIndex = headers.indexOf('candEmail');
  const tokenIndex = headers.indexOf('token');
  const expiresIndex = headers.indexOf('tokenExpiresAt');
  const linkIndex = headers.indexOf('link');
  const submittedIndex = headers.indexOf('refereesSubmittedAt');
  const statusIndex = headers.indexOf('status');
  const updatedIndex = headers.indexOf('updatedAt');
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const invalidated = [];
  const updatedAt = nowIso_();

  rows.forEach(function(values) {
    const matches = pipelineCandId
      ? String(values[idIndex] || '') === pipelineCandId
      : normalizeEmail_(values[emailIndex]) === candEmail;
    if (!matches || !String(values[tokenIndex] || '').trim()) return;
    values[tokenIndex] = '';
    values[expiresIndex] = '';
    values[linkIndex] = '';
    if (!values[submittedIndex]) values[statusIndex] = 'REPLACED';
    values[updatedIndex] = updatedAt;
    invalidated.push(values);
  });

  if (!invalidated.length) return 0;
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  invalidated.forEach(function(values) {
    const row = {};
    headers.forEach(function(header, index) { row[header] = values[index]; });
    appendChange_('ReferenceCandidates', 'upsert', row.id, row);
  });
  return invalidated.length;
}

// 대시보드에서 후보자가 "레퍼런스" 단계로 이동할 때(또는 관리자가 재발급할 때) 관리자 권한으로 호출.
// 후보자용 추천인 등록 링크를 발급만 하고 반환한다 — 메일은 서버가 자동 발송하지 않는다.
// 후보자에게 추천인 등록 링크를 발급한다. 실제 안내 메일은 대시보드에서
// 관리자가 미리보기 후 Gmail/MailApp 발송 버튼을 눌러 처리한다.
// google.script.run(adminApi)로 호출되면 후보자 필드가 payload.data에 담겨 오고,
// 외부 fetch(POST)로 호출되면 payload 최상위에 바로 담겨 온다 — 둘 다 지원한다.
function issueReferenceCandidateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const candName = String(body.candName || '').trim();
  const candEmail = normalizeEmail_(body.candEmail);
  const positionText = String(body.positionText || '').trim();
  const pipelineCandId = String(body.candId || '').trim();
  if (!candName || !candEmail) return json_({ error: 'missing_candidate_fields' });

  const token = Utilities.getUuid();
  const link = buildReferenceCandidateLinkUrl_(token);
  const row = {
    id: 'RC-' + Utilities.getUuid(),
    pipelineCandId, candName, candEmail, positionText, token,
    tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    link,
    refereesSubmittedAt: '',
    status: 'SENT',
    createdAt: nowIso_(),
    updatedAt: nowIso_()
  };
  const sheet = ensureSheet_('ReferenceCandidates');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceCandidates);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidatePriorReferenceCandidateLinks_(sheet, headers, pipelineCandId, candEmail);
    sheet.appendRow(headers.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceCandidates', 'upsert', row.id, row);
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true, id: row.id, link, candName, candEmail, tokenExpiresAt: row.tokenExpiresAt });
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
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return submitReferenceCandidateRefereesUnlocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

function submitReferenceCandidateRefereesUnlocked_(payload) {
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const referees = Array.isArray(body.referees) ? body.referees : [];
  if (!token) return json_({ error: 'token_required' });
  if (referees.length !== REFERENCE_REQUIRED_REFEREES) return json_({ error: 'exactly_three_referees_required' });

  const candSheet = ensureSheet_('ReferenceCandidates');
  const candHeaders = ensureHeaders_(candSheet, SHEET_SCHEMAS.ReferenceCandidates);
  const rowIndex = findRowIndex_(candSheet, 'token', token, candHeaders);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const candRow = readRows_('ReferenceCandidates').find(row => String(row.token || '') === token);
  if (!candRow) return json_({ error: 'invalid_token' });
  if (referenceLinkExpired_(candRow)) return json_({ error: 'token_expired' });
  if (candRow.refereesSubmittedAt) return json_({ error: 'already_submitted' });

  // 일부만 유효하고 일부가 빠진 상태로 시트에 쓰거나 메일을 보내기 시작하면 안 되므로,
  // 쓰기/발송을 시작하기 전에 3명 전원의 필수값(이름·이메일·전화번호)을 먼저 검증한다.
  const normalizedReferees = referees.map(ref => ({
    name: String(ref && ref.name || '').trim(),
    email: normalizeEmail_(ref && ref.email),
    phone: normalizePhone_(ref && ref.phone),
    relation: String(ref && ref.relation || '').trim(),
    company: String(ref && ref.company || '').trim(),
  }));
  if (normalizedReferees.some(r => !r.name || !r.email || !r.phone)) {
    return json_({ error: 'referee_fields_incomplete' });
  }
  const emailSet = {};
  if (normalizedReferees.some(r => emailSet[r.email] ? true : (emailSet[r.email] = true, false))) {
    return json_({ error: 'duplicate_referee_email' });
  }

  const responseSheet = ensureSheet_('ReferenceResponses');
  const responseHeaders = ensureHeaders_(responseSheet, SHEET_SCHEMAS.ReferenceResponses);
  let issuedCount = 0;

  normalizedReferees.forEach(ref => {
    const refereeName = ref.name;
    const refereeEmail = ref.email;
    const refereePhone = ref.phone;
    const refereeRelation = ref.relation;
    const refereeCompany = ref.company;
    const refToken = Utilities.getUuid();
    const refLink = buildReferenceResponseLinkUrl_(refToken);
    const row = {
      id: 'RR-' + Utilities.getUuid(),
      referenceCandidateId: candRow.id,
      pipelineCandId: candRow.pipelineCandId || '',
      candName: candRow.candName,
      refereeName, refereeEmail, refereePhone, refereeRelation, refereeCompany,
      token: refToken,
      tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      link: refLink,
      verifiedAt: '',
      submittedAt: '',
      status: 'SENT',
      updatedAt: nowIso_()
    };
    responseSheet.appendRow(responseHeaders.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceResponses', 'upsert', row.id, row);
    issuedCount++;

    // 이 단계는 후보자 본인이 공개 페이지에서 직접 트리거하는 액션이라 관리자 검토 발송을 거칠 수 없다.
    // 그래서 서버가 Gmail/MailApp로 추천인에게 안내 메일을 자동 발송한다.
    try {
      const message = [
        refereeName + '님, 안녕하세요.',
        '',
        candRow.candName + '님께서 우미건설 채용 과정에서 ' + refereeName + '님을 추천인으로 등록해 주셨습니다.',
        '',
        '아래 버튼을 통해 레퍼런스 체크 설문에 참여해 주시기 바랍니다.',
        '',
        '설문 참여 링크',
        refLink,
        '',
        '설문 응답에는 약 10분 정도 소요됩니다.',
        '응답해 주신 내용은 채용 검토 목적으로만 활용됩니다.',
        `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
        '',
        '감사합니다.',
        '우미건설 피플팀 드림'
      ].join('\n');
      const result = sendMailViaGmail_(
        refereeEmail,
        '[우미건설] ' + candRow.candName + '님 레퍼런스 체크 요청',
        message,
        referenceMailHtml_(message, {
          templateType: 'referee_request',
          candidateName: candRow.candName,
          refereeName,
          positionText: candRow.positionText || '',
          link: refLink,
          deadline: row.tokenExpiresAt
        })
      );
      if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    } catch (err) {
      console.warn('submitReferenceCandidateReferees_ mail failed: ' + String(err && err.message || err));
    }
  });

  if (issuedCount !== REFERENCE_REQUIRED_REFEREES) return json_({ error: 'exactly_three_referees_required' });

  const updatedAtCol = candHeaders.indexOf('updatedAt') + 1;
  const submittedAtCol = candHeaders.indexOf('refereesSubmittedAt') + 1;
  const statusCol = candHeaders.indexOf('status') + 1;
  candSheet.getRange(rowIndex, submittedAtCol).setValue(nowIso_());
  candSheet.getRange(rowIndex, statusCol).setValue('REFEREES_REGISTERED');
  candSheet.getRange(rowIndex, updatedAtCol).setValue(nowIso_());
  appendChange_('ReferenceCandidates', 'upsert', candRow.id, { status: 'REFEREES_REGISTERED' });

  return json_({ ok: true, count: issuedCount });
}

// 추천인이 응답 링크를 열었을 때의 1차 확인 — 링크 자체가 살아있는지만 본다.
// 아직 본인 확인(이메일·전화번호) 전이라 후보자명은 여기서 보여주지 않는다(신원 미확인 상태에서 노출 방지).
function verifyReferenceRefereeToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceResponses').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });
  return json_({ ok: true });
}

// 링크 확인 다음 단계 — 등록 시 후보자가 입력한 이메일·전화번호와 일치하는지 확인한 뒤에만
// 후보자명을 공개하고 12문항 응답 폼을 열어준다. 링크만 유출돼도 아무나 응답할 수 없게 하는
// 최소한의 신원 확인 장치(강력한 인증은 아니지만, 링크를 잘못 전달받은 제3자를 걸러낸다).
function refereeVerifyFailKey_(token) {
  return 'referee_verify_fail:' + String(token || '');
}

function refereeVerifyLockKey_(token) {
  return 'referee_verify_lock:' + String(token || '');
}

function isRefereeVerifyLocked_(token) {
  if (!token) return true;
  return !!CacheService.getScriptCache().get(refereeVerifyLockKey_(token));
}

function recordRefereeVerifyFailure_(token) {
  if (!token) return;
  const cache = CacheService.getScriptCache();
  const key = refereeVerifyFailKey_(token);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFEREE_VERIFY_ATTEMPT_LIMIT) {
    cache.put(refereeVerifyLockKey_(token), '1', REFEREE_VERIFY_LOCK_SECONDS);
    cache.remove(key);
    return;
  }
  cache.put(key, String(count), REFEREE_VERIFY_LOCK_SECONDS);
}

function clearRefereeVerifyFailures_(token) {
  const cache = CacheService.getScriptCache();
  cache.remove(refereeVerifyFailKey_(token));
  cache.remove(refereeVerifyLockKey_(token));
}

function verifyRefereeIdentity_(payload) {
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const email = normalizeEmail_(body.email);
  const phone = normalizePhone_(body.phone);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!email || !phone) return json_({ ok: false, error: 'identity_fields_required' });
  if (isRefereeVerifyLocked_(token)) return json_({ ok: false, error: 'too_many_attempts' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
  const row = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });

  // 이메일·전화번호 중 하나만 일치해도 통과(둘 다 일치해야 하는 건 너무 엄격함).
  if (normalizeEmail_(row.refereeEmail) !== email && normalizePhone_(row.refereePhone) !== phone) {
    recordRefereeVerifyFailure_(token);
    return json_({ ok: false, error: 'identity_mismatch' });
  }
  clearRefereeVerifyFailures_(token);

  const verifiedAtCol = headers.indexOf('verifiedAt') + 1;
  if (verifiedAtCol > 0) sheet.getRange(rowIndex, verifiedAtCol).setValue(nowIso_());

  return json_({ ok: true, candName: row.candName, refereeName: row.refereeName });
}

// 추천인의 12문항 응답을 저장한다. 토큰 1개당 1회만 제출 가능.
function submitReferenceResponse_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return submitReferenceResponseUnlocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

function submitReferenceResponseUnlocked_(payload) {
  const token = String(payload.token || '').trim();
  const answers = payload.answers || {};
  if (!token) return json_({ error: 'token_required' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const existing = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!existing) return json_({ error: 'invalid_token' });
  if (existing.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(existing)) return json_({ error: 'token_expired' });
  if (!existing.verifiedAt) return json_({ error: 'identity_not_verified' });

  const ANSWER_KEYS = ['q1_periodStart','q1_periodEnd','q1_relation','q1_frequency',
    'q1_2_mainTask','q1_2_projectScale','q1_2_soloVsShared',
    'q2_startStyle',
    'q3_judgeStyle','q3_initiative',
    'q4_successNarrative','q4_failureNarrative',
    'q5_feedbackResponse',
    'q6_conflictStyle','q6_example',
    'q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas',
    'q9_word','q9_reason',
    'q10_firstAction','q10_sharedTiming',
    'q11_juniorSupportStyle','q11_example',
    'q12_exitReasonSource','q12_exitReasonDetail',
    'respondentName','respondentAffiliation','respondentContact','respondentConsentObserved','respondentConsentDataUse'];
  const merged = Object.assign({}, existing);
  ANSWER_KEYS.forEach(key => { merged[key] = String(answers[key] == null ? '' : answers[key]).trim(); });
  merged.submittedAt = nowIso_();
  merged.status = 'SUBMITTED';
  merged.updatedAt = nowIso_();

  const values = headers.map(h => merged[h] == null ? '' : merged[h]);
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  try {
    const message = [
      existing.refereeName + '님, 안녕하세요.',
      '',
      existing.candName + '님에 대한 레퍼런스 설문 응답이 정상적으로 접수되었습니다.',
      '',
      '바쁘신 중에도 시간을 내어 주셔서 진심으로 감사드립니다.',
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    const result = sendMailViaGmail_(
      existing.refereeEmail,
      '[우미건설] ' + existing.candName + '님 레퍼런스 체크 응답 접수 완료',
      message,
      referenceMailHtml_(message, {
        templateType: 'referee_complete',
        candidateName: existing.candName,
        refereeName: existing.refereeName,
        positionText: '',
        submittedAt: merged.submittedAt
      })
    );
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('submitReferenceResponse_ completion mail failed: ' + String(err && err.message || err));
  }

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
    const message = [
      row.refereeName + '님, 안녕하세요.',
      '',
      row.candName + '님께서 우미건설 채용 과정에서 ' + row.refereeName + '님을 추천인으로 등록해 주셨습니다.',
      '',
      '아래 버튼을 통해 레퍼런스 체크 설문에 참여해 주시기 바랍니다.',
      '',
      '설문 참여 링크',
      buildReferenceResponseLinkUrl_(row.token),
      '',
      '설문 응답에는 약 10분 정도 소요됩니다.',
      '응답해 주신 내용은 채용 검토 목적으로만 활용됩니다.',
      `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    const result = sendMailViaGmail_(
      row.refereeEmail,
      '[우미건설] ' + row.candName + '님 레퍼런스 체크 응답 재안내',
      message,
      referenceMailHtml_(message, {
        templateType: 'referee_reminder',
        candidateName: row.candName,
        refereeName: row.refereeName,
        positionText: '',
        link: buildReferenceResponseLinkUrl_(row.token),
        deadline: row.tokenExpiresAt
      })
    );
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('resendReferenceRefereeLink_ mail failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
  return json_({ ok: true });
}

function sendReferenceEmail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const to = normalizeEmail_(body.toEmail || body.to || body.email);
  const subject = String(body.subject || '').trim();
  const message = String(body.body || body.message || '').trim();
  if (!to || !subject || !message) return json_({ error: 'missing_mail_fields' });
  try {
    const result = sendMailViaGmail_(to, subject, message, referenceMailHtml_(message, body));
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('sendReferenceEmail_ failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
  return json_({ ok: true, to: to });
}

function escapeMailHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REFERENCE_MAIL_TEMPLATE_FILES = {
  candidate_request: 'mail_01_reference_candidate_request',
  candidate_reminder: 'mail_02_reference_candidate_reminder',
  referee_request: 'mail_03_reference_referee_request',
  referee_reminder: 'mail_04_reference_referee_reminder',
  referee_complete: 'mail_05_reference_referee_complete'
};

function referenceMailHtml_(message, context) {
  const raw = String(message || '');
  const data = Object.assign({}, context || {});
  const key = resolveReferenceMailTemplateKey_(raw, data);
  try {
    const fileName = REFERENCE_MAIL_TEMPLATE_FILES[key];
    const templateHtml = HtmlService.createHtmlOutputFromFile(fileName).getContent();
    return renderReferenceMailTemplate_(templateHtml, raw, data);
  } catch (err) {
    console.warn('referenceMailHtml_ template failed: ' + String(err && err.message || err));
    return referenceMailHtmlFallback_(raw, data);
  }
}

function resolveReferenceMailTemplateKey_(raw, data) {
  const explicit = String(data.templateType || data.templateKey || data.mailType || '').trim();
  if (REFERENCE_MAIL_TEMPLATE_FILES[explicit]) return explicit;
  if (raw.indexOf('정상적으로 접수') >= 0 || raw.indexOf('응답 접수') >= 0) return 'referee_complete';
  if (raw.indexOf('아직 완료되지 않아') >= 0 && raw.indexOf('추천인 3인') >= 0) return 'candidate_reminder';
  if (raw.indexOf('다시') >= 0 && raw.indexOf('설문') >= 0) return 'referee_reminder';
  if (raw.indexOf('추천인 등록 링크') >= 0 || raw.indexOf('추천인 3인') >= 0 || raw.indexOf('추천인 3분') >= 0) return 'candidate_request';
  return 'referee_request';
}

function renderReferenceMailTemplate_(html, raw, data) {
  const link = String(data.link || data.actionUrl || ((raw.match(/https?:\/\/[^\s]+/) || [''])[0])).trim();
  const candidateName = referenceNameWithoutHonorific_(data.candidateName || data.candName || data.supporterName || extractReferenceCandidateName_(raw) || '지원자');
  const refereeName = referenceNameWithoutHonorific_(data.refereeName || data.recipientName || data.targetName || extractReferenceRefereeName_(raw) || 'OOO');
  const positionText = referencePositionText_(data.positionText || data.position || extractReferencePosition_(raw) || '홍보 포지션');
  const deadlineText = formatReferenceDateTime_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS), true);
  const submittedText = formatReferenceDateTime_(data.submittedAt || new Date(), false);
  const shortDeadlineText = shortReferenceDeadline_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS));

  let rendered = String(html || '');
  if (link) rendered = rendered.replace(/href="#"/, 'href="' + escapeMailHtml_(link) + '"');
  rendered = rendered
    .replace(/이예슬/g, escapeMailHtml_(candidateName))
    .replace(/김재영/g, escapeMailHtml_(refereeName))
    .replace(/OOO/g, escapeMailHtml_(refereeName))
    .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
    .replace(/2026년 9월 14일 월요일 18:00까지/g, escapeMailHtml_(deadlineText))
    .replace(/2026년 9월 18일 금요일 18:00까지/g, escapeMailHtml_(deadlineText))
    .replace(/2026년 9월 16일 수요일 14:32/g, escapeMailHtml_(submittedText))
    .replace(/9월 18일\(금\) 18:00까지/g, escapeMailHtml_(shortDeadlineText));
  return rendered;
}

function referenceNameWithoutHonorific_(value) {
  return String(value || '').trim().replace(/님$/g, '');
}

function referencePositionText_(value) {
  const text = String(value || '').trim();
  if (!text) return '홍보 포지션';
  return /포지션$/.test(text) ? text : text + ' 포지션';
}

function extractReferenceCandidateName_(raw) {
  const match = String(raw || '').match(/([가-힣A-Za-z]+)님께서|([가-힣A-Za-z]+)님에 대한|안녕하세요,\s*([가-힣A-Za-z]+)님/);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function extractReferenceRefereeName_(raw) {
  const match = String(raw || '').match(/^([가-힣A-Za-z]+)님,\s*안녕하세요|안녕하세요,\s*([가-힣A-Za-z]+)님/);
  return match ? (match[1] || match[2] || '') : '';
}

function extractReferencePosition_(raw) {
  const match = String(raw || '').match(/우미건설\s+(.+?)\s+포지션/);
  return match ? match[1] + ' 포지션' : '';
}

function addReferenceDays_(date, days) {
  return new Date(new Date(date).getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function formatReferenceDateTime_(value, includeUntil) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = isNaN(date.getTime()) ? new Date() : date;
  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  const ymd = Utilities.formatDate(safeDate, 'Asia/Seoul', 'yyyy년 M월 d일');
  const hm = Utilities.formatDate(safeDate, 'Asia/Seoul', 'HH:mm');
  return ymd + ' ' + days[safeDate.getDay()] + ' ' + hm + (includeUntil ? '까지' : '');
}

function shortReferenceDeadline_(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = isNaN(date.getTime()) ? new Date() : date;
  const days = ['일','월','화','수','목','금','토'];
  return Utilities.formatDate(safeDate, 'Asia/Seoul', 'M월 d일') + '(' + days[safeDate.getDay()] + ') ' +
    Utilities.formatDate(safeDate, 'Asia/Seoul', 'HH:mm') + '까지';
}

function referenceMailHtmlFallback_(raw, data) {
  const firstLink = String(data.link || ((raw.match(/https?:\/\/[^\s]+/) || [''])[0]) || '').trim();
  const bodyHtml = String(raw || '').split('\n').map(line => {
    const text = line.trim();
    if (!text || text === '추천인 등록 링크' || text === '설문 참여 링크' || /^https?:\/\//.test(text)) return '';
    return '<div style="margin:0 0 10px;">' + escapeMailHtml_(text) + '</div>';
  }).join('');
  const cta = firstLink
    ? '<div style="text-align:center;margin:28px 0;"><a href="' + escapeMailHtml_(firstLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:8px;">바로가기</a></div>'
    : '';
  return '<div style="margin:0;padding:24px;background:#f7fbff;font-family:Arial,sans-serif;color:#1b2027;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dde7f1;padding:32px;">' +
    bodyHtml + cta +
    '<div style="border-top:1px solid #dde7f1;margin-top:28px;padding-top:16px;color:#5c6875;font-size:12px;">우미건설 피플팀</div>' +
    '</div></div>';
}

// ══════════════════════════════════════════════════════════════
// 일반 안내 메일(면접·입사·불합격 등) — 디자인 있는 HTML 메일
// 레퍼런스체크 5종(referenceMailHtml_)은 최종 HTML 파일을 유지한다.
// 일반 메일용 공유 조각/본문은 Apps Script 파일 추가 부담을 줄이기 위해 아래 인라인 맵에 내장한다.
// ══════════════════════════════════════════════════════════════
const GENERAL_MAIL_TEMPLATE_FILES = {
  interview_first: 'mail_body_interview_first',
  interview_second: 'mail_body_interview_second',
  panel_schedule: 'mail_body_panel_schedule',
  onboarding: 'mail_body_onboarding',
  onboarding_internal: 'mail_body_onboarding_internal',
  rejection: 'mail_body_rejection',
  interview_slot_request: 'mail_body_interview_slot_request',
  headhunter_forward: 'mail_body_headhunter_forward',
  general_notice: 'mail_body_general_notice'
};

const GENERAL_MAIL_PREHEADER = {
  interview_first: data => `1차 면접 일정을 안내드립니다. ${data.interviewDateTime || ''}`,
  interview_second: data => `2차 면접 일정을 안내드립니다. ${data.interviewDateTime || ''}`,
  panel_schedule: () => '면접 일정 및 대상자를 안내드립니다.',
  onboarding: data => `입사를 진심으로 축하드립니다. 입사일 ${data.joinDate || ''}`,
  onboarding_internal: data => `신규입사자 안내 — ${data.joinDate || ''} 입사 예정`,
  rejection: () => '채용 결과를 안내드립니다.',
  interview_slot_request: () => '가능한 면접 날짜와 오전·오후 시간대를 선택해 주세요.',
  headhunter_forward: data => `헤드헌팅 후보자 ${data.candidateName || ''}님의 ${data.purpose || '채용 진행'} 안내입니다.`,
  general_notice: () => '채용 진행 관련 안내드립니다.'
};

const GENERAL_MAIL_HEADER_TITLES = {
  interview_first: '1차 면접 안내',
  interview_second: '2차 면접 안내',
  panel_schedule: '면접 일정 안내',
  onboarding: '입사 안내',
  onboarding_internal: '신규입사자 안내',
  rejection: '채용 결과 안내',
  interview_slot_request: '면접 후보 일정 요청',
  headhunter_forward: '헤드헌팅 후보자 안내',
  general_notice: '채용 진행 안내'
};


var _mailFragmentCache_ = {};
function loadMailFragment_(fileName) {
  if (!Object.prototype.hasOwnProperty.call(_mailFragmentCache_, fileName)) {
    _mailFragmentCache_[fileName] = HtmlService.createHtmlOutputFromFile(fileName).getContent();
  }
  return _mailFragmentCache_[fileName];
}

function panelAvailabilityId_(positionId, round, email) {
  return [String(positionId || '').trim(), String(round || '').trim(), normalizeEmail_(email)].join(':');
}

function parseJsonArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function buildPanelAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, {
    audience: 'panel',
    token: token
  });
}

function panelAvailabilityExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

function issuePanelAvailabilityLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || '').trim();
  const positionTitle = String(body.positionTitle || '').trim();
  const round = String(body.round || '').trim();
  const panelistName = String(body.panelistName || '').trim();
  const panelistEmail = normalizeEmail_(body.panelistEmail);
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!positionId || !positionTitle || !round || !panelistEmail || !options.length) {
    return json_({ error: 'missing_panel_availability_fields' });
  }

  const sheet = ensureSheet_('PanelAvailability');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
  const id = panelAvailabilityId_(positionId, round, panelistEmail);
  const rowIndex = findRowIndex_(sheet, 'id', id, headers);
  const existing = readRows_('PanelAvailability').find(row => String(row.id) === id) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const link = buildPanelAvailabilityLinkUrl_(token);
  const normalized = schemaRow_('PanelAvailability', Object.assign({}, existing, {
    id,
    positionId,
    positionTitle,
    round,
    panelistName,
    panelistEmail,
    availabilityOptions: JSON.stringify(options),
    token,
    tokenExpiresAt: expiresAt,
    link,
    selections: '',
    status: 'SENT',
    respondedAt: '',
    note: '',
    createdAt: existing.createdAt || nowIso_(),
    updatedAt: nowIso_()
  }));
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);
  appendChange_('PanelAvailability', 'upsert', id, normalized);
  return json_({ ok: true, id, link, tokenExpiresAt: expiresAt, response: normalized });
}

function getPanelAvailabilityResponses_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || body.query && body.query.positionId || '').trim();
  const round = String(body.round || body.query && body.query.round || '').trim();
  if (!positionId || !round) return json_({ error: 'missing_panel_availability_query' });
  const responses = readRows_('PanelAvailability')
    .filter(row => String(row.positionId) === positionId && String(row.round) === round)
    .map(row => Object.assign({}, row, {
      availabilityOptions: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
      selections: parseJsonArray_(row.selections)
    }));
  return json_({ ok: true, responses });
}

function verifyPanelAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    participantRole: 'panel',
    participantName: row.panelistName || '',
    positionText: row.positionTitle || '',
    interviewType: row.round || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE',
    selections: parseJsonArray_(row.selections),
    note: row.note || ''
  });
}

function submitPanelAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(value => String(value || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('PanelAvailability');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, array) => allowed[value] && array.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const normalized = schemaRow_('PanelAvailability', Object.assign({}, row, {
      selections: JSON.stringify(unavailable ? [] : selections),
      status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      respondedAt: nowIso_(),
      note,
      updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('PanelAvailability', 'upsert', row.id, normalized);
    return json_({ ok: true, status: normalized.status, respondedAt: normalized.respondedAt });
  } finally {
    lock.releaseLock();
  }
}

function loadMailAsset_(fileName) {
  return loadMailFragment_(fileName).trim();
}

function nlToBr_(value) {
  return escapeMailHtml_(value).replace(/\n/g, '<br>');
}

function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return loadMailFragment_('mail_shared_header_bottom')
    .replace(/{{ciSrc}}/g, loadMailAsset_('mail_asset_ci_src'))
    .replace(/{{headerArtSrc}}/g, loadMailAsset_('mail_asset_header_art_src'))
    .replace(/{{headerTitle}}/g, title)
    .replace(/{{headerSubtitle}}/g, subtitle);
}

function generalMailHtml_(templateKey, data) {
  try {
    const fileName = GENERAL_MAIL_TEMPLATE_FILES[templateKey];
    if (!fileName) return '';
    const ctx = data || {};
    const preheaderFn = GENERAL_MAIL_PREHEADER[templateKey] || (() => '');
    const preheader = escapeMailHtml_(preheaderFn(ctx));

    const headerTop = loadMailFragment_('mail_shared_header_top');
    const headerBottom = renderGeneralMailHeader_(templateKey, ctx);
    const bodyOpen = loadMailFragment_('mail_shared_body_open');
    const bodyClose = loadMailFragment_('mail_shared_body_close');
    const contactHtml = generalMailContactHtml_(templateKey, ctx);
    const footer = loadMailFragment_('mail_shared_footer');
    const rawBody = loadMailFragment_(fileName);
    const filledBody = renderGeneralMailTemplate_(rawBody, templateKey, ctx);

    const preheaderDiv = '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">' + preheader + '</div>';

    return headerTop + preheaderDiv + headerBottom + bodyOpen + filledBody + contactHtml + bodyClose + footer;
  } catch (err) {
    console.warn('generalMailHtml_ failed: ' + String(err && err.message || err));
    return '';
  }
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function isInternalGeneralMail_(templateKey) {
  return templateKey === 'panel_schedule' || templateKey === 'onboarding_internal';
}

function generalMailContactHtml_(templateKey, data) {
  if (isInternalGeneralMail_(templateKey)) return '';
  const message = String((data && data.contactMessage) || '채용 절차와 관련해 궁금한 점이 있으시면 본 메일에 회신해 주세요.');
  return '        <tr>\n' +
    '          <td style="padding-top:24px;border-top:1px solid #dde7f1;">\n' +
    '            <div style="font-size:15px;line-height:1.4;font-weight:700;color:#1b2027;padding-bottom:6px;word-break:keep-all;overflow-wrap:break-word;">문의사항</div>\n' +
    '            <div style="font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">' + nlToBr_(message) + '</div>\n' +
    '          </td>\n' +
    '        </tr>\n';
}

function renderGeneralMailTemplate_(html, templateKey, data) {
  let rendered = String(html || '');
  const candidateName = String(data.candidateName || '이하늘');
  const positionText = String(data.positionText || '홍보 포지션');

  // 메모(안내 추가문구) 행 — 값이 있으면 채우고, 없으면 행 자체를 제거한다.
  const memoText = String(data.memo || '').trim();
  if (templateKey === 'interview_first' || templateKey === 'interview_second') {
    if (memoText) {
      rendered = rendered.replace(/<tr id="mailMemoRow">[\s\S]*?<\/tr>/,
        '<tr><td style="padding-top:18px;font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">' + nlToBr_(memoText) + '</td></tr>');
    } else {
      rendered = rendered.replace(/<tr id="mailMemoRow">[\s\S]*?<\/tr>/, '');
    }
  }

  if (templateKey === 'interview_first') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 9월 22일 화요일 14:00/g, escapeMailHtml_(data.interviewDateTime || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''));
  } else if (templateKey === 'interview_second') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 9월 29일 화요일 10:00/g, escapeMailHtml_(data.interviewDateTime || ''))
      .replace(/본사 5층 임원회의실/g, escapeMailHtml_(data.location || ''));
  } else if (templateKey === 'panel_schedule') {
    rendered = rendered
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/1차 실무면접/g, escapeMailHtml_(data.interviewType || ''))
      .replace(/2026년 9월 22일 화요일 14:00~17:00/g, escapeMailHtml_(data.scheduleText || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''))
      .replace(/총 4명/g, '총 ' + escapeMailHtml_(String(data.targetCount || '')) + '명')
      .replace(/김민준 팀장, 박서연 과장/g, escapeMailHtml_(data.panelNames || ''))
      .replace(/이하늘 \(홍보 포지션\)<br>최지우 \(홍보 포지션\)/, nlToBr_(data.targetList || ''));
  } else if (templateKey === 'onboarding') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 10월 5일/g, escapeMailHtml_(data.joinDate || ''))
      .replace(/09:00/g, escapeMailHtml_(data.joinTime || '09:00'))
      .replace(/본사 3층 피플팀/g, escapeMailHtml_(data.reportLocation || '본사 3층 피플팀'))
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/주임/g, escapeMailHtml_(data.rank || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/본사/g, escapeMailHtml_(data.location || ''))
      .replace(/- 신분증 지참<br>- 계좌사본 제출/, nlToBr_(data.prepNotes || ''));
  } else if (templateKey === 'onboarding_internal') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/2026년 10월 5일/g, escapeMailHtml_(data.joinDate || ''))
      .replace(/주임/g, escapeMailHtml_(data.rank || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/본사/g, escapeMailHtml_(data.location || ''))
      .replace(/010-1234-5678/g, escapeMailHtml_(data.phone || ''))
      .replace(/2026년 9월 30일까지/g, escapeMailHtml_(data.replyDeadline || ''))
      .replace(/09:00 피플팀 방문 → 10:00 부서 배치/g, escapeMailHtml_(data.joinDaySchedule || ''))
      .replace(/- 좌석 배정<br>- 사원증 발급 요청/, nlToBr_(data.deptCooperation || ''));
    const workLocation = String(data.location || data.workplace || data.site || '');
    if (!/현장|공사|사업소|프로젝트|PJ/i.test(workLocation)) {
      rendered = rendered.replace(/<tr id="siteOnboardingRequestRow">[\s\S]*?<\/tr>/, '');
    }
  } else if (templateKey === 'rejection') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText));
  } else if (templateKey === 'interview_slot_request') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/1차 실무면접/g, escapeMailHtml_(data.interviewType || ''))
      .replace(/1\. 9월 22일\(화\) 오전·오후<br>2\. 9월 23일\(수\) 오전<br>3\. 9월 24일\(목\) 오후/, nlToBr_(data.slotOptions || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''))
      .replace(/2026년 9월 20일/g, escapeMailHtml_(data.responseDeadline || ''))
      .replace(/INTERVIEW_AVAILABILITY_URL/g, escapeMailHtml_(data.availabilityLink || '#'));
  } else if (templateKey === 'headhunter_forward') {
    rendered = rendered
      .replace(/헤드헌팅 담당자/g, escapeMailHtml_(data.recipientName || '헤드헌팅 담당자'))
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/채용 진행/g, escapeMailHtml_(data.purpose || '채용 진행'))
      .replace(/후보자에게 전달할 내용이 표시됩니다\./, nlToBr_(data.forwardBody || data.body || ''));
  } else if (templateKey === 'general_notice') {
    const actionLink = String(data.actionLink || '').trim();
    const actionLabel = String(data.actionLabel || '바로가기').trim();
    const noticeHtml = nlToBr_(data.noticeBody || data.body || '') + (actionLink
      ? '<div style="text-align:center;margin:24px 0 2px;"><a href="' + escapeMailHtml_(actionLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:7px;">' + escapeMailHtml_(actionLabel) + '</a></div>'
      : '');
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/채용 진행 안내 내용이 표시됩니다\./, noticeHtml);
  }

  return rendered;
}

function handleSendGeneralMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const to = normalizeEmail_(body.toEmail || body.to || body.email);
  const subject = String(body.subject || '').trim();
  const message = String(body.body || body.message || '').trim();
  if (!to || !subject || !message) return json_({ error: 'missing_mail_fields' });
  try {
    const html = generalMailHtml_(body.templateType, body);
    const result = sendMailViaGmail_(to, subject, message, html);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    return json_({ ok: true, to: to });
  } catch (err) {
    const errorText = String(err && err.message || err);
    console.warn('handleSendGeneralMail_ failed: ' + errorText);
    return json_({ error: errorText || 'mail_send_failed' });
  }
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
      max_tokens: 1400,
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
  if (!isAdminRequest_(payload)) return json_({ success: false, error: 'admin_auth_required', interviewers: [] });
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

function normalizePhone_(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function normalizeCell_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
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
    PASSED: '합격',
    FAILED: '불합격',
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
    const message = [
      '사내추천 접수가 완료되었습니다.',
      '',
      '접수번호: ' + row.id,
      '접수일: ' + String(row.submittedAt || '').slice(0, 10),
      '유효기간: ' + String(row.validUntil || '').slice(0, 10),
      '',
      '접수 현황은 추천 접수 화면에서 동일한 사번 인증 후 확인할 수 있습니다.',
      '',
      '우미건설 피플팀'
    ].join('\n');
    const result = sendMailViaGmail_(row.refEmail, '[우미건설] 사내추천 접수 완료', message);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
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


