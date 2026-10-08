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
 * email | name | empNo | dept | division(본부) | status | updatedAt
 */

const REFERRAL_UPLOAD_FOLDER_ID_PROPERTY = 'REFERRAL_UPLOAD_FOLDER_ID';
const ADMIN_TOKEN_PROPERTY = 'RECRUITMENT_ADMIN_TOKEN';
const ADMIN_ALLOWLIST_PROPERTY = 'RECRUITMENT_ADMIN_ALLOWLIST';
const DEPLOYMENT_ROLE_PROPERTY = 'RECRUITMENT_DEPLOYMENT_ROLE';
const RECRUITMENT_SPREADSHEET_URL_PROPERTY = 'RECRUITMENT_SPREADSHEET_URL';
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
const CHANGE_CURSOR_PROPERTY = 'RECRUITMENT_CHANGE_CURSOR_V1';
const REVISIONED_SHEETS = ['Candidates', 'Interviews', 'Positions'];
const REFERRAL_EMPLOYEE_DIRECTORY_SHEETS = ['Interviewers', 'Employees'];
const REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS = ['referralEmployeeDirectoryUrl', 'interviewerUrl'];
const REFERRAL_DATA_SHEETS = ['Referrals', 'Rewards', 'RefRules'];
const RECRUITMENT_DATA_SHEETS = ['Candidates', 'Interviews', 'Positions', 'RecruitPlans', 'ReferenceCandidates', 'ReferenceResponses'];
const REFERRAL_DATA_URL_SETTING_KEYS = ['referralDataUrl', 'referralStorageUrl'];
const EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS = 5 * 60;
const EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX = 'empDirChunk_';
const EMPLOYEE_DIRECTORY_CACHE_CHUNK_SIZE = 50000;
// 레퍼런스체크 후보자/추천인 링크는 최소 며칠~몇 주 동안 유효해야 하는데
// CacheService는 최대 보관 시간이 6시간으로 제한돼 있어 쓸 수 없다(referralToken류와의 핵심 차이).
// 그래서 토큰을 캐시가 아니라 시트의 컬럼 값으로 저장하고, 매 요청마다 시트에서 대조한다.
// 링크 유효기간과 안내하는 기한은 분리한다(관리자 Code.gs와 같은 값을 유지해야 한다).
// 기한 초과 리마인드는 관리자 프로젝트의 dailyOps가 deadlineAt을 기준으로 보낸다.
const REFERENCE_LINK_TTL_DAYS = 14;
const REFERENCE_CANDIDATE_DEADLINE_DAYS = 3; // 지원자 추천인 등록 기한
const REFERENCE_RESPONSE_DEADLINE_DAYS = 7;  // 추천인 설문 응답 기한
const REFERENCE_REQUIRED_REFEREES = 3;
const REFERENCE_CANDIDATE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/reference_candidate_intake.html';
const REFERENCE_RESPONSE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/reference_check_intake.html';
const INTERVIEW_AVAILABILITY_LINK_TTL_DAYS = 10;
const INTERVIEW_AVAILABILITY_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/interview_availability.html';
const REFEREE_VERIFY_ATTEMPT_LIMIT = 5;
const REFEREE_VERIFY_LOCK_SECONDS = 10 * 60;
const PUBLIC_BLOCKED_ADMIN_ACTIONS = Object.freeze({
  issueReferenceCandidateLink: true,
  issueInterviewAvailabilityLink: true,
  setInterviewAvailabilityDeliveryStatus: true,
  issueJoinDateLink: true,
  issuePanelAvailabilityLink: true,
  getPanelAvailabilityResponses: true,
  getPanelAvailabilityResponsesBatch: true,
  generateReferenceSummary: true
});

const SHEET_SCHEMAS = {
  Candidates: ['id','name','pos','email','etype','role','dept','career','source','headhunterId','headhunterName','headhunterManager','headhunterEmail','headhunterPhone','stage','ref','refD','refT','receivedAt','docPassedAt','memo','rejectedAt','rejectReason','rejectMemo','finalAt','joinDate','decision','notified','mailPending','mailPendingLabel','posId','intDate','held','lastCompletedStage','lastStageChangedAt','rev','updatedAt'],
  Interviews: ['id','candId','candName','type','date','loc','candidateLoc','panelLoc','panel','memo','notified','candidateNotified','panelNotified','mailPending','status','slots','availabilityOptions','availabilityToken','availabilityExpiresAt','availabilityLink','availabilitySelections','availabilityStatus','availabilityRespondedAt','availabilityNote','availabilityResponseBy','availabilityResponderName','availabilityResponderEmail','availabilityResponderOrg','availabilityProxyConfirmedAt','result','note','evaluatedAt','rev','updatedAt'],
  PanelAvailability: ['id','positionId','positionTitle','round','panelistName','panelistEmail','loc','availabilityOptions','token','tokenExpiresAt','link','selections','status','respondedAt','note','createdAt','updatedAt'],
  JoinDateRequests: ['id','candId','candName','positionText','options','token','tokenExpiresAt','link','deadline','selection','status','note','respondedAt','responseBy','createdAt','updatedAt'],
  Positions: ['id','title','etype','role','headcount','hireReason','dept','location','team','jobType','panel1','panel2','panel1AvailabilityOptions','panel1AvailabilityRequestedAt','panel1AvailabilityConfirmedAt','panel2AvailabilityOptions','panel2AvailabilityRequestedAt','panel2AvailabilityConfirmedAt','loc','owner','targetDate','memo','createdAt','status','closedAt','parentPosId','closeReason','closeMemo','rev','updatedAt'],
  RecruitPlans: ['id','year','location','empType','team','jobType','planned','manualDone','manualItv','manualOffer','sortOrder','updatedAt','deletedAt'],
  Referrals: ['id','refEmail','refName','refEmpNo','refDept','posText','posId','candName','candPhone','candPhoneNormalized','candEmail','candEmailNormalized','candCompany','resumeUrl','relation','refItems','consentAt','submittedAt','status','dupFlag','reviewedBy','reviewedAt','rejectReason','validUntil','candId','hireDate','hireCL','updatedAt','updatedBy','deletedAt'],
  Rewards: ['id','referralId','candId','refEmail','hireDate','hireCL','milestone','dueDate','payMonth','payCutoff','amount','status','retentionCheckedBy','retentionCheckedAt','requestedAt','paidAt','cancelReason','updatedAt','updatedBy','deletedAt'],
  RefRules: ['id','recordType','key','value','clFrom','clTo','amount3M','amount6M','effectiveFrom','effectiveTo','isActive','updatedAt'],
  Interviewers: ['email','name','empNo','dept','division','rank','status','updatedAt'],
  Employees: ['email','name','empNo','dept','status','updatedAt'],
  Settings: ['id','value'],
  MailLog: ['id','eventKey','to','subject','status','error','sentAt'],
  ReferenceCandidates: ['id','pipelineCandId','candName','candEmail','positionText','token','tokenExpiresAt','deadlineAt','link','refereesSubmittedAt','status','createdAt','updatedAt'],
  ReferenceResponses: ['id','referenceCandidateId','pipelineCandId','candName','refereeName','refereeEmail','refereePhone','refereeRelation','refereeCompany','token','tokenExpiresAt','deadlineAt','link','verifiedAt','submittedAt','status',
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
    const action = params.action || 'getAll';
    const sheet = params.sheet || '';
    let data = {};
    if (params.data) data = JSON.parse(params.data);
    if (params.id) data.id = params.id;
    return routeRequest_({ action, sheet, data, query: params });
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
  const action = payload.action || '';
  if (isPublicDeployment_() && PUBLIC_BLOCKED_ADMIN_ACTIONS[action]) {
    throw new Error('not_available');
  }

  const securityResult = handleReferralSecurityAction_(payload);
  if (securityResult) return securityResult;

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
  const existingValues = rowIndex > 0
    ? sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]
    : null;
  const revision = revisionState_(sheetName, headers, existingValues, source);
  if (revision.conflict) {
    return json_({
      error: 'revision_conflict',
      id,
      expectedRev: revision.expected,
      currentRev: revision.current,
      data: rowObjectFromValues_(headers, existingValues)
    });
  }
  if (sheetName === 'Referrals') {
    source = secureReferralRowForUpsert_(source, rowIndex > 0, isAdmin);
  }

  if (revision.enabled) {
    source.rev = revision.current + 1;
    source.updatedAt = nowIso_();
  } else {
    source.updatedAt = source.updatedAt || nowIso_();
  }
  const normalized = schemaRow_(sheetName, source);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);

  appendChange_(sheetName, 'upsert', id, normalized);
  return json_({ status: 'ok', id, data: normalized, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function batchUpsert_(sheetName, rows, isAdmin) {
  const source = Array.isArray(rows) ? rows : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result;
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const ids = source.map(function(row) { return String((row || {})[key] || '').trim(); }).filter(Boolean);
    const loaded = readSheetRowsByIds_(sheet, headers, key, ids);
    const pendingRows = {};
    const newIds = [];

    const changes = [];
    const conflicts = [];
    let count = 0;
    source.forEach(function(row) {
      let next = Object.assign({}, row || {});
      const id = String(next[key] || '').trim();
      if (!id) return;
      const existing = pendingRows[id] || loaded.rows[id] || null;
      const existingValues = existing ? existing.values : null;
      const revision = revisionState_(sheetName, headers, existingValues, next);
      if (revision.conflict) {
        conflicts.push({
          id,
          expectedRev: revision.expected,
          currentRev: revision.current,
          data: rowObjectFromValues_(headers, existingValues)
        });
        return;
      }
      if (sheetName === 'Referrals') {
        next = secureReferralRowForUpsert_(next, !!existing, isAdmin);
      }
      if (revision.enabled) {
        next.rev = revision.current + 1;
        next.updatedAt = nowIso_();
      } else {
        next.updatedAt = next.updatedAt || nowIso_();
      }
      const normalized = schemaRow_(sheetName, next);
      const rowValues = headers.map(function(header) {
        return normalized[header] == null ? '' : normalized[header];
      });
      if (!existing) newIds.push(id);
      pendingRows[id] = { rowNumber: existing ? existing.rowNumber : 0, values: rowValues };
      changes.push({ sheetName, action: 'upsert', id, data: normalized });
      count++;
    });

    if (conflicts.length) {
      result = {
        error: 'revision_conflict',
        count: 0,
        conflicts,
        cursor: getChangeCursor_(),
        serverTime: nowIso_()
      };
    } else if (count) {
      writeBatchRows_(sheet, headers.length, pendingRows, newIds, loaded.lastRow);
      appendChanges_(changes);
      result = { status: 'ok', count, cursor: getChangeCursor_(), serverTime: nowIso_() };
    } else {
      result = { status: 'ok', count: 0, cursor: getChangeCursor_(), serverTime: nowIso_() };
    }
  } finally {
    lock.releaseLock();
  }
  return json_(result);
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
    const revisioned = REVISIONED_SHEETS.includes(sheetName);
    const priorRevisions = {};
    if (revisioned && lastRow > 1) {
      const keyIndex = headers.indexOf(primaryKey_(sheetName));
      const revIndex = headers.indexOf('rev');
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function(values) {
        const id = String(values[keyIndex] || '').trim();
        if (id) priorRevisions[id] = Number(values[revIndex]) || 0;
      });
    }
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
    }
    const normalizedRows = source.map(row => {
      const next = Object.assign({}, row || {});
      if (revisioned) {
        const id = String(next[primaryKey_(sheetName)] || '').trim();
        next.rev = (priorRevisions[id] || 0) + 1;
        next.updatedAt = nowIso_();
      } else {
        next.updatedAt = next.updatedAt || nowIso_();
      }
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

function getChanges_(query) {
  const cursor = Number(query && query.cursor) || 0;
  const limit = Math.min(Number(query && query.limit) || 500, 1000);
  const page = readChangePageAfter_(cursor, limit);
  const changes = hydrateChangesForClient_(page.changes);
  const latestCursor = page.latestCursor;
  const nextCursor = changes.length ? Number(changes[changes.length - 1].cursor) : Math.max(cursor, latestCursor);
  return json_({
    changes,
    cursor: nextCursor,
    latestCursor,
    serverTime: nowIso_(),
    resyncRequired: false,
    hasMore: page.hasMore
  });
}

function handleReferralSecurityAction_(payload) {
  if (!payload) return null;
  if (payload.action === 'sendReferralVerificationCode') return sendReferralVerificationCode_(payload);
  if (payload.action === 'verifyReferralCode') return verifyReferralCode_(payload);
  if (payload.action === 'uploadReferralFile') return uploadReferralFile_(payload);
  if (payload.action === 'getMyReferrals') return getMyReferrals_(payload);
  if (payload.action === 'issueReferenceCandidateLink') return issueReferenceCandidateLink_(payload);
  if (payload.action === 'issueInterviewAvailabilityLink') return issueInterviewAvailabilityLink_(payload);
  if (payload.action === 'setInterviewAvailabilityDeliveryStatus') return setInterviewAvailabilityDeliveryStatus_(payload);
  if (payload.action === 'verifyInterviewAvailabilityToken') return verifyInterviewAvailabilityToken_(payload);
  if (payload.action === 'submitInterviewAvailability') return submitInterviewAvailability_(payload);
  if (payload.action === 'issueJoinDateLink') return issueJoinDateLink_(payload);
  if (payload.action === 'verifyJoinDateToken') return verifyJoinDateToken_(payload);
  if (payload.action === 'submitJoinDate') return submitJoinDate_(payload);
  if (payload.action === 'issuePanelAvailabilityLink') return issuePanelAvailabilityLink_(payload);
  if (payload.action === 'getPanelAvailabilityResponses') return getPanelAvailabilityResponses_(payload);
  if (payload.action === 'verifyPanelAvailabilityToken') return verifyPanelAvailabilityToken_(payload);
  if (payload.action === 'submitPanelAvailability') return submitPanelAvailability_(payload);
  if (payload.action === 'verifyReferenceCandidateToken') return verifyReferenceCandidateToken_(payload);
  if (payload.action === 'submitReferenceCandidateReferees') return submitReferenceCandidateReferees_(payload);
  if (payload.action === 'verifyReferenceRefereeToken') return verifyReferenceRefereeToken_(payload);
  if (payload.action === 'verifyRefereeIdentity') return verifyRefereeIdentity_(payload);
  if (payload.action === 'submitReferenceResponse') return submitReferenceResponse_(payload);
  return null;
}

function sendLoggedMail_(options) {
  const mail = Object.assign({}, options || {});
  const to = String(mail.to || '');
  const subject = String(mail.subject || '');
  try {
    MailApp.sendEmail(mail);
    logMailSend_(to, subject, 'sent', '');
  } catch (err) {
    const errorText = String(err && err.message || err);
    logMailSend_(to, subject, 'failed', errorText);
    throw err;
  }
}

function logMailSend_(to, subject, status, error, eventKey) {
  try {
    const sheet = ensureSheet_('MailLog');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.MailLog);
    const row = {
      id: 'ML-' + Utilities.getUuid(),
      eventKey: String(eventKey || ''),
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
    sendLoggedMail_({
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
  const responseBy = body.responseBy === 'headhunter' ? 'headhunter' : 'candidate';
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!interviewId || !candId || !candName || !options.length) return json_({ error: 'missing_interview_availability_fields' });
  const sheet = ensureSheet_('Interviews');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
  const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
  const existing = readRows_('Interviews').find(row => String(row.id) === interviewId) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 86400000).toISOString();
  const link = buildInterviewAvailabilityLinkUrl_(token);
  const row = Object.assign({}, existing, {
    id:interviewId, candId, candName, type:String(body.type || existing.type || ''), loc:String(body.loc || existing.loc || ''),
    status:existing.status || 'pending', availabilityOptions:JSON.stringify(options), availabilityToken:token,
    availabilityExpiresAt:expiresAt, availabilityLink:link, availabilitySelections:'', availabilityStatus:'READY',
    availabilityRespondedAt:'', availabilityNote:'', availabilityResponseBy:responseBy,
    availabilityResponderName:String(body.responderName || '').trim(), availabilityResponderEmail:normalizeEmail_(body.responderEmail || ''),
    availabilityResponderOrg:String(body.responderOrg || '').trim(), availabilityProxyConfirmedAt:'', updatedAt:nowIso_()
  });
  const normalized = schemaRow_('Interviews', row);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]); else sheet.appendRow(values);
  appendChange_('Interviews', 'upsert', interviewId, normalized);
  return json_({ ok:true, interviewId, link, tokenExpiresAt:expiresAt });
}

function setInterviewAvailabilityDeliveryStatus_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error:'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const interviewId = String(body.interviewId || body.id || '').trim();
  const status = String(body.status || '').trim().toUpperCase();
  if (!interviewId || !['SENT','SEND_FAILED'].includes(status)) return json_({ error:'invalid_interview_availability_delivery_status' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
    if (rowIndex < 1) return json_({ error:'interview_not_found' });
    const existing = readRows_('Interviews').find(row => String(row.id) === interviewId);
    if (!existing) return json_({ error:'interview_not_found' });
    const normalized = schemaRow_('Interviews', Object.assign({}, existing, { availabilityStatus:status, updatedAt:nowIso_() }));
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('Interviews', 'upsert', interviewId, normalized);
    return json_({ ok:true, interviewId, status });
  } finally {
    lock.releaseLock();
  }
}

function verifyInterviewAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok:false, error:'token_required' });
  const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
  if (!row) return json_({ ok:false, error:'invalid_token' });
  if (candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (interviewAvailabilityExpired_(row)) return json_({ ok:false, error:'token_expired' });
  let selections = [];
  try { selections = JSON.parse(row.availabilitySelections || '[]'); } catch (err) {}
  const candidate = readRows_('Candidates').find(item => String(item.id) === String(row.candId)) || {};
  return json_({ ok:true, candName:row.candName || '', positionText:candidate.pos || '', interviewType:row.type || '', location:row.loc || '',
    options:normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted:row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE',
    unavailable:row.availabilityStatus === 'UNAVAILABLE', selections, note:row.availabilityNote || '',
    responseBy:row.availabilityResponseBy || 'candidate', responderName:row.availabilityResponderName || '',
    responderEmail:row.availabilityResponderEmail || '', responderOrg:row.availabilityResponderOrg || '',
    proxyConfirmed:!!row.availabilityProxyConfirmedAt });
}

function submitInterviewAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(v => String(v || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  const proxyConfirmed = body.proxyConfirmed === true || String(body.proxyConfirmed || '').toLowerCase() === 'true';
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
    if (row && candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    // 제출한 일정은 수정할 수 없다(변경은 담당자 문의 → 담당자가 다시 요청하면 새로 받는다).
    if (row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE') return json_({ ok: false, error: 'already_submitted' });
    if (row.availabilityResponseBy === 'headhunter' && !proxyConfirmed) return json_({ ok: false, error: 'proxy_confirmation_required' });

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
      availabilityProxyConfirmedAt: row.availabilityResponseBy === 'headhunter' ? nowIso_() : '',
      // 관리자 화면이 이 회신을 받기 전 예전 내용으로 저장해도 덮어쓰지 않도록 버전을 올린다
      // (그 저장은 버전 충돌이 되고, 화면의 자동 병합이 회신 칸을 서버 값으로 유지한다).
      rev: (Number(row.rev) || 0) + 1,
      updatedAt: nowIso_()
    });
    const normalized = schemaRow_('Interviews', next);
    sheet.getRange(rowIndex, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('Interviews', 'upsert', row.id, normalized);
    notifyIfInterviewAvailabilityCohortComplete_(normalized);
    return json_({ ok: true, status: normalized.availabilityStatus, respondedAt: normalized.availabilityRespondedAt });
  } finally {
    lock.releaseLock();
  }
}

// 담당자 알림을 받을 주소 — 설정(Settings 시트) 'notifyEmail' 값을 사용한다.
// ── 최종합격 통보 · 입사 가능일 회신 ─────────────────────────────
// 피플팀이 제안한 입사 가능 날짜 중 하나를 지원자가 공개 페이지(join_date.html)에서 고른다.
// 지원자 한 명당 한 줄(JoinDateRequests, id = 지원자 id)이며 다시 보내면 새 토큰으로 덮어쓴다.
const JOIN_DATE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/join_date.html';
const JOIN_DATE_LINK_TTL_DAYS = 21;

function normalizeJoinDateOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.map(v => String(v || '').trim().slice(0, 10))
    .filter((v, i, arr) => /^\d{4}-\d{2}-\d{2}$/.test(v) && arr.indexOf(v) === i)
    .sort()
    .slice(0, 31);
}

function joinDateRequestExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

function joinDateReplyDeadlinePassed_(row) {
  const deadline = String(row && row.deadline || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false;
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd') > deadline;
}

// 최종합격(5) 단계인 지원자만 회신할 수 있다(불합격·보류·입사 처리 후에는 받지 않는다).
function joinDateProcessClosed_(candId) {
  const cand = readRows_('Candidates').find(row => String(row.id) === String(candId));
  if (!cand) return true;
  if (String(cand.held || '') === 'Y') return true;
  return !['5', '최종합격'].includes(String(cand.stage == null ? '' : cand.stage).trim());
}

function issueJoinDateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const candId = String(body.candId || '').trim();
  const candName = String(body.candName || '').trim();
  const options = normalizeJoinDateOptions_(body.options);
  if (!candId || !candName || !options.length) return json_({ error: 'missing_join_date_fields' });
  if (joinDateProcessClosed_(candId)) return json_({ error: 'process_closed' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'id', candId, headers);
    const existing = readRows_('JoinDateRequests').find(row => String(row.id) === candId) || {};
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + JOIN_DATE_LINK_TTL_DAYS * 86400000).toISOString();
    const link = buildUrlWithParams_(JOIN_DATE_PAGE_URL, { token });
    const row = schemaRow_('JoinDateRequests', Object.assign({}, existing, {
      id: candId, candId, candName, positionText: String(body.positionText || '').trim(),
      options: JSON.stringify(options), token, tokenExpiresAt: expiresAt, link,
      deadline: String(body.deadline || '').trim().slice(0, 10),
      selection: '', status: 'SENT', note: '', respondedAt: '',
      responseBy: body.responseBy === 'headhunter' ? 'headhunter' : 'candidate',
      createdAt: existing.createdAt || nowIso_(), updatedAt: nowIso_()
    }));
    const values = headers.map(header => row[header] == null ? '' : row[header]);
    if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]); else sheet.appendRow(values);
    appendChange_('JoinDateRequests', 'upsert', candId, row);
    return json_({ ok: true, id: candId, link, tokenExpiresAt: expiresAt });
  } finally {
    lock.releaseLock();
  }
}

function verifyJoinDateToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.status !== 'RESPONDED' && row.status !== 'UNAVAILABLE' && joinDateReplyDeadlinePassed_(row)) return json_({ ok: false, error: 'deadline_expired' });
  return json_({
    ok: true, candName: row.candName || '', positionText: row.positionText || '',
    options: normalizeJoinDateOptions_(row.options), deadline: row.deadline || '',
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE', selection: row.selection || '', note: row.note || '',
    responseBy: row.responseBy || 'candidate'
  });
}

function submitJoinDate_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const selection = String(body.selection || '').trim().slice(0, 10);
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !selection) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
    if (rowIndex < 0 || !row) return json_({ ok: false, error: 'invalid_token' });
    if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (joinDateReplyDeadlinePassed_(row)) return json_({ ok: false, error: 'deadline_expired' });
    if (!unavailable && normalizeJoinDateOptions_(row.options).indexOf(selection) < 0) return json_({ ok: false, error: 'invalid_selection' });
    const next = schemaRow_('JoinDateRequests', Object.assign({}, row, {
      selection: unavailable ? '' : selection, status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      note, respondedAt: nowIso_(), updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([headers.map(header => next[header] == null ? '' : next[header])]);
    appendChange_('JoinDateRequests', 'upsert', row.id, next);
    // 담당자 알림(설정의 '일정 응답 완료 알림 받을 이메일')
    const choice = unavailable ? '제안 날짜 모두 어려움 · 희망: ' + note : '입사 가능일 ' + selection + (note ? ' · 메모: ' + note : '');
    sendCohortCompleteNotice_('[입사일 회신] ' + (row.candName || '') + '님 ' + (unavailable ? '날짜 조정 요청' : selection),
      (row.candName || '') + '님이 입사일을 회신했습니다.\n\n' + choice + '\n\n채용 관리 화면의 입사 안내에서 확인해 주세요.');
    return json_({ ok: true, status: next.status, respondedAt: next.respondedAt });
  } finally {
    lock.releaseLock();
  }
}

function getNotifyEmail_() {
  return getFirstSettingValue_(['notifyEmail']);
}

function sendCohortCompleteNotice_(subject, message) {
  const to = getNotifyEmail_();
  if (!to) return;
  try {
    sendLoggedMail_({ to: to, subject: subject, body: message, name: '피플팀' });
  } catch (err) {
    console.warn('sendCohortCompleteNotice_ failed: ' + (err && err.message || err));
  }
}

// 지원자 전원(해당 포지션·회차 발송 대상)이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfInterviewAvailabilityCohortComplete_(justUpdatedRow) {
  const cand = readRows_('Candidates').find(c => String(c.id) === String(justUpdatedRow.candId));
  if (!cand || !cand.posId) return;
  const cohortCandIds = readRows_('Candidates')
    .filter(c => String(c.posId) === String(cand.posId))
    .map(c => String(c.id));
  const cohort = readRows_('Interviews').filter(i =>
    i.type === justUpdatedRow.type &&
    cohortCandIds.includes(String(i.candId)) &&
    ['SENT','RESPONDED','UNAVAILABLE'].includes(i.availabilityStatus)
  );
  if (!cohort.length || !cohort.every(i => i.availabilityStatus === 'RESPONDED' || i.availabilityStatus === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${cand.pos || '포지션'} ${justUpdatedRow.type} 지원자 전원 일정 응답 완료`,
    `${cand.pos || '포지션'} ${justUpdatedRow.type} 대상 지원자 ${cohort.length}명 전원이 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
}

// 면접관 전원이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfPanelAvailabilityCohortComplete_(justUpdatedRow) {
  const cohort = readRows_('PanelAvailability').filter(r =>
    String(r.positionId) === String(justUpdatedRow.positionId) &&
    String(r.round) === String(justUpdatedRow.round)
  );
  if (!cohort.length || !cohort.every(r => r.status === 'RESPONDED' || r.status === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 전원 일정 응답 완료`,
    `${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 ${cohort.length}명 전원이 참석 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
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
  const loc = String(body.loc || '').trim();
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!positionId || !positionTitle || !round || !panelistEmail || !options.length) return json_({ error: 'missing_panel_availability_fields' });
  const sheet = ensureSheet_('PanelAvailability');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
  const id = panelAvailabilityId_(positionId, round, panelistEmail);
  const rowIndex = findRowIndex_(sheet, 'id', id, headers);
  const existing = readRows_('PanelAvailability').find(row => String(row.id) === id) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 86400000).toISOString();
  const link = buildPanelAvailabilityLinkUrl_(token);
  const normalized = schemaRow_('PanelAvailability', Object.assign({}, existing, {
    id, positionId, positionTitle, round, panelistName, panelistEmail, loc: loc || existing.loc || '',
    availabilityOptions:JSON.stringify(options), token, tokenExpiresAt:expiresAt, link,
    selections:'', status:'SENT', respondedAt:'', note:'',
    createdAt:existing.createdAt || nowIso_(), updatedAt:nowIso_()
  }));
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]); else sheet.appendRow(values);
  appendChange_('PanelAvailability', 'upsert', id, normalized);
  return json_({ ok:true, id, link, tokenExpiresAt:expiresAt, response:normalized });
}

function getPanelAvailabilityResponses_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || body.query && body.query.positionId || '').trim();
  const round = String(body.round || body.query && body.query.round || '').trim();
  if (!positionId || !round) return json_({ error: 'missing_panel_availability_query' });
  const responses = readRows_('PanelAvailability').filter(row => String(row.positionId) === positionId && String(row.round) === round).map(row => Object.assign({}, row, {
    availabilityOptions:normalizeInterviewAvailabilityOptions_(row.availabilityOptions), selections:parseJsonArray_(row.selections)
  }));
  return json_({ ok:true, responses });
}

function verifyPanelAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok:false, error:'token_required' });
  const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok:false, error:'invalid_token' });
  if (positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
  if (panelAvailabilityExpired_(row)) return json_({ ok:false, error:'token_expired' });
  return json_({ ok:true, participantRole:'panel', participantName:row.panelistName || '', positionText:row.positionTitle || '', interviewType:row.round || '', location:row.loc || '',
    options:normalizeInterviewAvailabilityOptions_(row.availabilityOptions), alreadySubmitted:row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable:row.status === 'UNAVAILABLE', selections:parseJsonArray_(row.selections), note:row.note || '' });
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
    if (row && positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (row.status === 'RESPONDED' || row.status === 'UNAVAILABLE') return json_({ ok: false, error: 'already_submitted' });

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
    notifyIfPanelAvailabilityCohortComplete_(normalized);
    return json_({ ok: true, status: normalized.status, respondedAt: normalized.respondedAt });
  } finally {
    lock.releaseLock();
  }
}

function referenceDeadlineText_(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy년 M월 d일 HH:mm') + '까지';
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

// 대시보드에서 후보자가 "레퍼런스" 단계로 이동할 때 관리자 권한으로 호출.
// 후보자에게 추천인 등록 링크를 발급하고 메일로 보낸다.
function issueReferenceCandidateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
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
    deadlineAt: new Date(Date.now() + REFERENCE_CANDIDATE_DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
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

  try {
    const message = [
      '안녕하세요, ' + candName + '님.',
      '',
      '우미건설 ' + positionText + ' 포지션 채용 절차와 관련하여 레퍼런스 체크를 진행하고자 합니다.',
      '',
      '아래 버튼을 통해 추천인 3인의 정보를 등록해 주시기 바랍니다.',
      '',
      '추천인 등록 링크',
      link,
      '',
      '등록 정보',
      '- 성함',
      '- 이메일',
      '- 휴대폰 번호',
      '- 지원자와의 관계',
      '',
      '등록해 주신 추천인께는 레퍼런스 체크를 위한 설문 메일이 별도로 발송될 예정입니다.',
      '추천인 등록 전, 추천인께 연락처 제공 및 설문 메일 발송 예정임을 미리 안내해 주시기 바랍니다.',
      '',
      '등록 기한: ' + referenceDeadlineText_(row.deadlineAt),
      `링크는 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    sendLoggedMail_({
      to: candEmail,
      subject: '[우미건설] 레퍼런스 체크 - 추천인 등록 안내',
      name: '우미건설 피플팀',
      body: message,
      htmlBody: referenceMailHtml_(message)
    });
  } catch (err) {
    console.warn('issueReferenceCandidateLink_ mail failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true, id: row.id, link, candName, candEmail, tokenExpiresAt: row.tokenExpiresAt, deadlineAt: row.deadlineAt });
}

// 후보자가 등록 링크를 열었을 때 화면에 본인 이름을 띄우기 위한 토큰 검증.
function verifyReferenceCandidateToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceCandidates').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
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
  const outbox = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let result;
  try {
    result = submitReferenceCandidateRefereesUnlocked_(payload, outbox);
  } finally {
    lock.releaseLock();
  }
  if (!result || !result.ok) return json_(result || { error: 'unknown_error' });
  // 시트 기록이 끝난 뒤 잠금을 풀고 메일을 보낸다. 메일 발송이 느려도 다른 저장이 잠금 대기로 실패하지 않게 하고,
  // 추천인별 발송 결과를 돌려준다(실패 내역은 MailLog에도 남고, 관리자 화면에서 링크를 다시 보낼 수 있다).
  const mailResults = outbox.map(job => ({ refereeName: job.refereeName, ok: sendReferenceRefereeRequestMail_(job) }));
  const mailFailed = mailResults.filter(r => !r.ok).length;
  return json_(Object.assign({}, result, { mailSent: mailResults.length - mailFailed, mailFailed: mailFailed }));
}

function submitReferenceCandidateRefereesUnlocked_(payload, outbox) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const referees = Array.isArray(body.referees) ? body.referees : [];
  if (!token) return { error: 'token_required' };
  if (referees.length !== REFERENCE_REQUIRED_REFEREES) return { error: 'exactly_three_referees_required' };

  const candSheet = ensureSheet_('ReferenceCandidates');
  const candHeaders = ensureHeaders_(candSheet, SHEET_SCHEMAS.ReferenceCandidates);
  const rowIndex = findRowIndex_(candSheet, 'token', token, candHeaders);
  if (rowIndex < 0) return { error: 'invalid_token' };
  const candRow = readRows_('ReferenceCandidates').find(row => String(row.token || '') === token);
  if (!candRow) return { error: 'invalid_token' };
  if (candidateProcessClosed_(candRow.pipelineCandId)) return { error: 'process_closed' };
  if (referenceLinkExpired_(candRow)) return { error: 'token_expired' };
  if (candRow.refereesSubmittedAt) return { error: 'already_submitted' };

  const normalizedReferees = referees.map(ref => ({
    name: String(ref && ref.name || '').trim(),
    email: normalizeEmail_(ref && ref.email),
    phone: normalizePhone_(ref && ref.phone),
    relation: String(ref && ref.relation || '').trim(),
    company: String(ref && ref.company || '').trim()
  }));
  // 추천인 3명 모두 이름·이메일·전화번호·소속 회사가 있어야 접수한다.
  if (normalizedReferees.some(ref => !ref.name || !ref.email || !ref.phone || !ref.company)) {
    return { error: 'referee_fields_incomplete' };
  }
  const emailSet = {};
  if (normalizedReferees.some(ref => emailSet[ref.email] ? true : (emailSet[ref.email] = true, false))) {
    return { error: 'duplicate_referee_email' };
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
      deadlineAt: new Date(Date.now() + REFERENCE_RESPONSE_DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      link: refLink,
      verifiedAt: '',
      submittedAt: '',
      status: 'SENT',
      updatedAt: nowIso_()
    };
    responseSheet.appendRow(responseHeaders.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceResponses', 'upsert', row.id, row);
    issuedCount++;

    // 메일은 잠금을 푼 뒤 submitReferenceCandidateReferees_에서 보낸다.
    if (outbox) outbox.push({ refereeName, refereeEmail, refLink, deadlineAt: row.deadlineAt, candName: candRow.candName, positionText: candRow.positionText || '' });
  });

  if (issuedCount !== REFERENCE_REQUIRED_REFEREES) return { error: 'exactly_three_referees_required' };

  const updatedAtCol = candHeaders.indexOf('updatedAt') + 1;
  const submittedAtCol = candHeaders.indexOf('refereesSubmittedAt') + 1;
  const statusCol = candHeaders.indexOf('status') + 1;
  candSheet.getRange(rowIndex, submittedAtCol).setValue(nowIso_());
  candSheet.getRange(rowIndex, statusCol).setValue('REFEREES_REGISTERED');
  candSheet.getRange(rowIndex, updatedAtCol).setValue(nowIso_());
  appendChange_('ReferenceCandidates', 'upsert', candRow.id, { status: 'REFEREES_REGISTERED' });

  return { ok: true, count: issuedCount };
}

// 후보자가 공개 페이지에서 직접 제출하는 단계라 서버가 추천인에게 안내 메일을 자동 발송한다. 성공하면 true.
function sendReferenceRefereeRequestMail_(job) {
  try {
    const message = [
      job.refereeName + '님, 안녕하세요.',
      '',
      job.candName + '님께서 우미건설 채용 과정에서 ' + job.refereeName + '님을 추천인으로 등록해 주셨습니다.',
      '',
      '아래 버튼을 통해 레퍼런스 체크 설문에 참여해 주시기 바랍니다.',
      '',
      '설문 참여 링크',
      job.refLink,
      '',
      '설문 응답에는 약 10분 정도 소요됩니다.',
      '응답해 주신 내용은 채용 검토 목적으로만 활용됩니다.',
      '응답 기한: ' + referenceDeadlineText_(job.deadlineAt),
      `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    sendLoggedMail_({
      to: job.refereeEmail,
      subject: '[우미건설] ' + job.candName + '님 레퍼런스 체크 요청',
      name: '우미건설 피플팀',
      body: message,
      htmlBody: referenceMailHtml_(message)
    });
    return true;
  } catch (err) {
    console.warn('submitReferenceCandidateReferees_ mail failed: ' + String(err && err.message || err));
    return false;
  }
}

// 링크 유효성만 확인한다. 본인 확인 전에는 후보자 정보를 노출하지 않는다.
function verifyReferenceRefereeToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceResponses').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });
  return json_({ ok: true });
}

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
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
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
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const answers = body.answers || {};
  if (!token) return json_({ error: 'token_required' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const existing = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!existing) return json_({ error: 'invalid_token' });
  if (candidateProcessClosed_(existing.pipelineCandId)) return json_({ error: 'process_closed' });
  if (existing.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(existing)) return json_({ error: 'token_expired' });
  if (!existing.verifiedAt) return json_({ error: 'identity_not_verified' });

  const ANSWER_KEYS = ['q1_periodStart','q1_periodEnd','q1_relation','q1_frequency',
    'q1_2_mainTask','q1_2_projectScale','q1_2_soloVsShared',
    'q2_startStyle','q3_judgeStyle','q3_initiative',
    'q4_successNarrative','q4_failureNarrative','q5_feedbackResponse',
    'q6_conflictStyle','q6_example','q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas','q9_word','q9_reason',
    'q10_firstAction','q10_sharedTiming','q11_juniorSupportStyle','q11_example',
    'q12_exitReasonSource','q12_exitReasonDetail','respondentName','respondentAffiliation',
    'respondentContact','respondentConsentObserved','respondentConsentDataUse'];
  const merged = Object.assign({}, existing);
  ANSWER_KEYS.forEach(key => { merged[key] = String(answers[key] == null ? '' : answers[key]).trim(); });
  merged.submittedAt = nowIso_();
  merged.status = 'SUBMITTED';
  merged.updatedAt = nowIso_();

  const values = headers.map(h => merged[h] == null ? '' : merged[h]);
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  // 제출 완료 안내는 응답 화면에서 한다(추천인에게 별도 완료 메일은 보내지 않는다).
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


// ── 종료된 채용 프로세스 차단 ──────────────────────────────────
// 충원완료·부분충원 마감·미채용·채용중단 포지션, 불합격·보류 지원자의 공개 링크(면접 가능일, 면접관 일정,
// 추천인 등록, 레퍼런스 설문)는 더 이상 받지 않는다. 특히 추천인 등록은 제출 즉시 외부 추천인에게
// 설문 메일이 자동 발송되므로 반드시 막아야 한다.
const CLOSED_POSITION_STATUSES_ = ['filled', 'done', 'partial', 'nohire', 'stopped'];

function positionProcessClosed_(positionId) {
  if (positionId === '' || positionId == null) return false;
  const pos = readRowsIfSheetExists_('Positions').find(row => String(row.id) === String(positionId));
  return !!pos && CLOSED_POSITION_STATUSES_.includes(String(pos.status || '').trim());
}

function candidateStageClosed_(value) {
  const stage = String(value == null ? '' : value).trim();
  return ['5', '6', '7', '최종합격', '불합격', '입사'].includes(stage);
}

function candidateProcessClosed_(candId) {
  if (candId === '' || candId == null) return false;
  const cand = readRowsIfSheetExists_('Candidates').find(row => String(row.id) === String(candId));
  if (!cand) return false;
  if (candidateStageClosed_(cand.stage) || String(cand.held || '') === 'Y') return true;
  return positionProcessClosed_(cand.posId);
}

function readRowsIfSheetExists_(sheetName) {
  const ss = getSpreadsheetForSheet_(sheetName);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  return readRows_(sheetName);
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
  if (EXEC_CACHE_.sheets[sheetName]) return EXEC_CACHE_.sheets[sheetName];
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  EXEC_CACHE_.sheets[sheetName] = sheet;
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (RECRUITMENT_DATA_SHEETS.includes(sheetName)) {
    const recruitmentUrl = getScriptProperty_(RECRUITMENT_SPREADSHEET_URL_PROPERTY);
    if (recruitmentUrl) {
      try {
        return openSpreadsheetCached_(recruitmentUrl);
      } catch (err) {
        throw new Error('recruitment_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return openSpreadsheetCached_(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return openSpreadsheetCached_('');
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

function isAdminRequest_(payload) {
  if (isPublicDeployment_()) return false;
  const token = String(payload.adminToken || payload.query && payload.query.adminToken || payload.data && payload.data.adminToken || '').trim();
  const configuredToken = getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  if (configuredToken && token === configuredToken) return true;
  const email = getActiveUserEmail_();
  return !!email && getAdminAllowlist_().includes(email);
}

function getAdminAllowlist_() {
  return getScriptProperty_(ADMIN_ALLOWLIST_PROPERTY)
    .split(/[,\n;]/)
    .map(email => String(email || '').trim().toLowerCase())
    .filter(Boolean);
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
    WITHDRAWN: '종료',
    EXPIRED: '만료',
    CANCELLED: '종료'
  };
  return map[String(status || '').toUpperCase()] || '접수';
}

function escapeMailHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function referenceMailHtml_(message) {
  const raw = String(message || '');
  const firstLink = (raw.match(/https?:\/\/[^\s]+/) || [''])[0];
  const logoUrl = getScriptProperty_('WOOMI_CI_URL');
  const kakaoChannelUrl = getScriptProperty_('KAKAO_CHANNEL_URL');
  const kakaoQrUrl = getScriptProperty_('KAKAO_QR_URL');
  const isCandidateRequest = raw.indexOf('추천인 등록 링크') >= 0 || raw.indexOf('추천인 3분') >= 0;
  const mailSubtitle = isCandidateRequest ? '추천인 등록 안내' : '설문 참여 안내';
  const ctaLabel = isCandidateRequest ? '추천인 정보 등록하기' : '레퍼런스 체크 시작하기';
  const lines = raw.split('\n').filter(line => {
    const text = line.trim();
    return text !== '추천인 등록 링크' && text !== '설문 참여 링크' && !/^https?:\/\//.test(text);
  });
  const bodyHtml = lines.map(line => {
    const text = line.trim();
    if (!text) return '<div style="height:12px;line-height:12px;">&nbsp;</div>';
    if (/^- /.test(text)) {
      return '<span style="display:inline-block;margin:4px 10px 2px 0;color:#353d44;">&#8226; ' + escapeMailHtml_(text.replace(/^- /, '')) + '</span>';
    }
    if (text === '등록 정보') {
      return '<div style="margin:4px 0 2px;font-weight:700;color:#353d44;">등록하실 정보</div>';
    }
    return '<div>' + escapeMailHtml_(text) + '</div>';
  }).join('');
  const ctaHtml = firstLink ? '<tr><td align="center" style="padding:8px 40px 28px;">' +
    '<a href="' + escapeMailHtml_(firstLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:13px 26px;border-radius:7px;">' + ctaLabel + ' &#8594;</a>' +
    '</td></tr>' : '';
  const brandHtml = logoUrl
    ? '<img src="' + escapeMailHtml_(logoUrl) + '" alt="우미건설" style="display:block;width:86px;max-width:86px;height:auto;margin-bottom:24px;">'
    : '<div style="font-size:13px;font-weight:700;color:#353d44;letter-spacing:.02em;margin-bottom:24px;">WOOMI CONSTRUCTION</div>';
  const kakaoButtonHtml = kakaoChannelUrl
    ? '<div style="margin-top:8px;"><a href="' + escapeMailHtml_(kakaoChannelUrl) + '" style="color:#003087;text-decoration:none;font-weight:700;font-size:12px;">카카오톡 채널 문의하기 &#8594;</a></div>'
    : '';
  const kakaoQrHtml = kakaoQrUrl
    ? '<td width="58" style="width:58px;padding-left:14px;text-align:right;vertical-align:top;"><img src="' + escapeMailHtml_(kakaoQrUrl) + '" alt="카카오톡 채널 QR" style="display:block;width:52px;height:52px;border:1px solid #e5e7eb;border-radius:4px;"></td>'
    : '';
  const inquiryHtml = (kakaoChannelUrl || kakaoQrUrl)
    ? '<tr><td style="padding:0 40px 24px;">' +
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e5e9ef;padding-top:18px;">' +
      '<tr><td style="vertical-align:top;font-size:12px;line-height:1.65;color:#667085;">' +
      '<div style="font-weight:700;color:#353d44;margin-bottom:3px;">문의사항</div>' +
      '<div>채용 관련 문의는 카카오톡 채널을 이용해 주세요.</div>' +
      kakaoButtonHtml +
      '</td>' + kakaoQrHtml + '</tr></table>' +
      '</td></tr>'
    : '';
  return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f9fa;padding:28px 0;font-family:Arial,sans-serif;color:#20242a;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e9ef;border-radius:12px;overflow:hidden;">' +
    '<tr><td style="padding:36px 40px 16px;background:#ffffff;">' +
    brandHtml +
    '<div style="font-size:22px;line-height:1.3;font-weight:700;color:#20242a;">레퍼런스 체크</div>' +
    '<div style="font-size:15px;line-height:1.45;font-weight:600;color:#003087;margin-top:2px;">' + mailSubtitle + '</div>' +
    '<div style="height:2px;line-height:2px;background:#003087;width:64px;margin-top:18px;">&nbsp;</div>' +
    '</td></tr>' +
    '<tr><td style="padding:18px 40px 8px;font-size:15px;line-height:1.78;color:#20242a;">' + bodyHtml + '</td></tr>' +
    ctaHtml +
    inquiryHtml +
    '<tr><td style="border-top:1px solid #e5e9ef;padding:15px 40px 18px;font-size:12px;line-height:1.6;color:#66717f;">본 메일은 우미건설 채용 절차 진행을 위해 발송되었습니다.</td></tr>' +
    '</table>' +
    '</td></tr>' +
    '</table>';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
