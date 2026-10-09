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

// 공개 배포는 누구나 호출하므로 예상치 못한 오류의 원문(시트·드라이브 오류 내용 등)을 돌려주지 않는다.
// 'not_available', 'unknown_sheet'처럼 코드로 던진 오류는 코드만(':' 뒤 상세는 빼고), 그 밖에는 server_error.
// 상세 내용은 실행 로그에 남긴다.
function publicErrorCode_(err) {
  const message = String(err && err.message || err || '');
  console.error('public request failed: ' + logErrorText_(message));
  const match = /^([a-z][a-z0-9_]*)(?::|$)/.exec(message);
  return match ? match[1] : 'server_error';
}

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
    return json_({ error: publicErrorCode_(err) });
  }
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const payload = JSON.parse(body || '{}');
    return routeRequest_(payload);
  } catch (err) {
    return json_({ error: publicErrorCode_(err) });
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
    console.warn('sendReferralVerificationCode_ failed: ' + logErrorText_(err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true });
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

// 담당자 알림을 받을 주소 — 설정(Settings 시트) 'notifyEmail' 값을 사용한다.
// ── 최종합격 통보 · 입사 가능일 회신 ─────────────────────────────
// 피플팀이 제안한 입사 가능 날짜 중 하나를 지원자가 공개 페이지(join_date.html)에서 고른다.
// 지원자 한 명당 한 줄(JoinDateRequests, id = 지원자 id)이며 다시 보내면 새 토큰으로 덮어쓴다.
const JOIN_DATE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/join_date.html';
const JOIN_DATE_LINK_TTL_DAYS = 21;

function sendCohortCompleteNotice_(subject, message) {
  const to = getNotifyEmail_();
  if (!to) return;
  try {
    sendLoggedMail_({ to: to, subject: subject, body: message, name: '피플팀' });
  } catch (err) {
    console.warn('sendCohortCompleteNotice_ failed: ' + logErrorText_(err));
  }
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

function referenceDeadlineText_(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy년 M월 d일 HH:mm') + '까지';
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
    console.warn('issueReferenceCandidateLink_ mail failed: ' + logErrorText_(err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true, id: row.id, link, candName, candEmail, tokenExpiresAt: row.tokenExpiresAt, deadlineAt: row.deadlineAt });
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
  const writeRow = confirmRowIndex_(candSheet, candHeaders, 'token', token, rowIndex);
  if (writeRow < 0) return { error: 'invalid_token' };
  candSheet.getRange(writeRow, submittedAtCol).setValue(nowIso_());
  candSheet.getRange(writeRow, statusCol).setValue('REFEREES_REGISTERED');
  candSheet.getRange(writeRow, updatedAtCol).setValue(nowIso_());
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
    console.warn('submitReferenceCandidateReferees_ mail failed: ' + logErrorText_(err));
    return false;
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


// ── 종료된 채용 프로세스 차단 ──────────────────────────────────
// 충원완료·부분충원 마감·미채용·채용중단 포지션, 불합격·보류 지원자의 공개 링크(면접 가능일, 면접관 일정,
// 추천인 등록, 레퍼런스 설문)는 더 이상 받지 않는다. 특히 추천인 등록은 제출 즉시 외부 추천인에게
// 설문 메일이 자동 발송되므로 반드시 막아야 한다.
const CLOSED_POSITION_STATUSES_ = ['filled', 'done', 'partial', 'nohire', 'stopped'];

function readRowsIfSheetExists_(sheetName) {
  const ss = getSpreadsheetForSheet_(sheetName);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  return readRows_(sheetName);
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

