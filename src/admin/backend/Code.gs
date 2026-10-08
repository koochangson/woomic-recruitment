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
const LOCAL_ADMIN_USERS_PROPERTY = 'RECRUITMENT_LOCAL_ADMIN_USERS';
const ADMIN_SESSION_SECONDS_PROPERTY = 'RECRUITMENT_ADMIN_SESSION_SECONDS';
const DEPLOYMENT_ROLE_PROPERTY = 'RECRUITMENT_DEPLOYMENT_ROLE';
const OPENAI_API_KEY_PROPERTY = 'OPENAI_API_KEY';
const EMPLOYEE_DIRECTORY_LOOKUP_TOKEN_PROPERTY = 'INTERVIEWER_DB_LOOKUP_TOKEN';
const EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY = 'INTERVIEWER_DB_ADMIN_TOKEN';
const RECRUITMENT_SPREADSHEET_URL_PROPERTY = 'RECRUITMENT_SPREADSHEET_URL';
const REFERRAL_CODE_TTL_SECONDS = 10 * 60;
const REFERRAL_TOKEN_TTL_SECONDS = 60 * 60;
const REFERRAL_CODE_SEND_LIMIT = 3;
const REFERRAL_CODE_VERIFY_LIMIT = 5;
const REFERRAL_CODE_LOCK_SECONDS = 10 * 60;
const REFERRAL_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REFERRAL_ALLOWED_EXTENSIONS = ['pdf','doc','docx','ppt','pptx','hwp','hwpx','zip'];
const CHANGE_LOG_SHEET = '_Changes';
const CHANGE_ARCHIVE_SHEET = '_Changes_Archive';
const CHANGE_ARCHIVE_RETENTION_DAYS = 90;
const CHANGE_ARCHIVE_BATCH_SIZE = 1000;
const CHANGE_COMPACT_BATCH_SIZE = 1000;
const CHANGE_CURSOR_PROPERTY = 'RECRUITMENT_CHANGE_CURSOR_V1';
const REVISIONED_SHEETS = ['Candidates', 'Interviews', 'Positions', 'Onboardings', 'Offers', 'RefReports'];
// 처음 만들 때 모든 칸을 텍스트 형식으로 두는 시트(날짜·시각·연락처를 그대로 보관)
const TEXT_FORMAT_SHEETS = ['Onboardings', 'Offers', 'RefReports'];
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
// 링크 유효기간과 안내하는 기한은 분리한다. 기한이 지나도 링크가 살아 있는 동안은 늦은
// 등록·응답을 받을 수 있고, 기한을 넘긴 건은 dailyOps가 리마인드한다(referenceReminderKind_).
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

const SHEET_SCHEMAS = {
  Candidates: ['id','name','pos','email','etype','role','dept','career','source','headhunterId','headhunterName','headhunterManager','headhunterEmail','headhunterPhone','stage','ref','refD','refT','refReportSentAt','refSkipReason','gradeBandOverride','receivedAt','docPassedAt','memo','rejectedAt','rejectReason','rejectMemo','finalAt','joinDate','decision','notified','mailPending','mailPendingLabel','posId','intDate','held','lastCompletedStage','lastStageChangedAt','rev','updatedAt'],
  Interviews: ['id','candId','candName','type','date','loc','candidateLoc','panelLoc','panel','memo','notified','candidateNotified','panelNotified','mailPending','status','slots','availabilityOptions','availabilityToken','availabilityExpiresAt','availabilityLink','availabilitySelections','availabilityStatus','availabilityRespondedAt','availabilityNote','availabilityResponseBy','availabilityResponderName','availabilityResponderEmail','availabilityResponderOrg','availabilityProxyConfirmedAt','result','note','evaluatedAt','rev','updatedAt'],
  PanelAvailability: ['id','positionId','positionTitle','round','panelistName','panelistEmail','loc','availabilityOptions','token','tokenExpiresAt','link','selections','status','respondedAt','note','createdAt','updatedAt'],
  JoinDateRequests: ['id','candId','candName','positionText','options','token','tokenExpiresAt','link','deadline','selection','status','note','respondedAt','responseBy','createdAt','updatedAt'],
  Positions: ['id','title','etype','role','headcount','hireReason','dept','location','team','jobType','site','targetGradeBand','panel1','panel2','panel1AvailabilityOptions','panel1AvailabilityRequestedAt','panel1AvailabilityConfirmedAt','panel2AvailabilityOptions','panel2AvailabilityRequestedAt','panel2AvailabilityConfirmedAt','loc','owner','targetDate','memo','createdAt','status','closedAt','parentPosId','closeReason','closeMemo','rev','updatedAt'],
  RecruitPlans: ['id','year','location','empType','team','jobType','planned','manualDone','manualItv','manualOffer','sortOrder','updatedAt','deletedAt'],
  Referrals: ['id','refEmail','refName','refEmpNo','refDept','posText','posId','candName','candPhone','candPhoneNormalized','candEmail','candEmailNormalized','candCompany','resumeUrl','relation','refItems','consentAt','submittedAt','status','dupFlag','reviewedBy','reviewedAt','rejectReason','validUntil','candId','hireDate','hireCL','updatedAt','updatedBy','deletedAt'],
  Rewards: ['id','referralId','candId','refEmail','hireDate','hireCL','milestone','dueDate','payMonth','payCutoff','amount','status','retentionCheckedBy','retentionCheckedAt','requestedAt','paidAt','cancelReason','updatedAt','updatedBy','deletedAt'],
  RefRules: ['id','recordType','key','value','clFrom','clTo','amount3M','amount6M','effectiveFrom','effectiveTo','isActive','updatedAt'],
  Interviewers: ['email','name','empNo','dept','division','rank','title','status','updatedAt'],
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
  // 입사 등록·처우 기록: 예전에는 설정 시트의 보조 데이터 덩어리에 있었다(한 줄씩 저장해 PC 간 덮어쓰기 방지).
  Onboardings: ['id','candId','candName','pos','etype','dept','deptLead','joinDate','rank','cl','loc','joinTime','reportLocation','notes','nameEn','phone','preDeadline','notified','notifiedAt','deptNotified','deptNotifiedAt','rev','updatedAt'],
  Offers: ['id','candId','candName','org','etypeText','rank','cl','salary','salaryNote','allowances','allowanceItems','allowanceExtra','benefits','probation','healthDeadline','healthStatus','healthResultAt','acceptance','acceptanceAt','sentAt','rev','updatedAt'],
  // 레퍼런스 결과 정리(지원자별 1줄, id = 지원자 id). 예전에는 설정 시트의 보조 데이터 덩어리(auxState)에 있었다.
  RefReports: ['id','candId','candName','pos','overall','expertise','character','leadership','reason','aiApplied','aiAppliedAt','aiAppliedBy','updatedBy','savedAt','rev','updatedAt']
};

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || '';

    if (!action && !isPublicDeployment_()) {
      return HtmlService.createTemplateFromFile('Dashboard')
        .evaluate()
        .setTitle('채용관리 대시보드');
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
  if (action === 'listDbSheets') return listDbSheets_();
  if (action === 'archiveDbSheet') return archiveDbSheet_(data);
  if (action === 'getCommonAttachments') return json_({ ok: true, attachments: getCommonAttachments_() });
  if (action === 'uploadCommonAttachment') return uploadCommonAttachment_(data);
  if (action === 'getCursor') return json_({ cursor: getChangeCursor_(), serverTime: nowIso_() });
  if (action === 'getChanges') return getChanges_(query);
  if (action === 'configStatus') return json_(getDeploymentConfigStatus_());
  if (action === 'legacyReferenceStageMigrationPreview') return json_(getLegacyReferenceStageMigrationPreview_());
  if (action === 'migrateLegacyReferenceStage') {
    if (!data || data.confirm !== true) return json_({ error: 'confirmation_required' });
    return json_(migrateLegacyReferenceStageToSecondInterview_());
  }
  if (action === 'archiveChanges') return json_(archiveOldChanges_());
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

const MAIL_ATTACHMENT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;

function buildMailAttachments_(list) {
  if (!Array.isArray(list) || !list.length) return [];
  let totalBytes = 0;
  const blobs = [];
  list.forEach(function(item) {
    if (!item || !item.base64) return;
    const bytes = Utilities.base64Decode(String(item.base64));
    totalBytes += bytes.length;
    if (totalBytes > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('attachment_too_large');
    blobs.push(Utilities.newBlob(bytes, item.mimeType || 'application/octet-stream', item.name || 'attachment'));
  });
  return blobs;
}

function mailAttachmentTotalBytes_(blobs) {
  return (blobs || []).reduce(function(total, blob) {
    return total + (blob && typeof blob.getBytes === 'function' ? blob.getBytes().length : 0);
  }, 0);
}

function sendMailViaGmail_(to, subject, body, htmlBody, attachments, eventKey) {
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
    if (Array.isArray(attachments) && attachments.length) options.attachments = attachments;

    MailApp.sendEmail(options);
    const logged = logMailSend_(recipients.join(','), cleanSubject, 'sent', '', eventKey);
    return { ok: true, to: recipients.join(','), logged: logged !== false };
  } catch (err) {
    const errorText = String(err && err.message || err);
    logMailSend_(recipients.join(','), cleanSubject, 'failed', errorText, eventKey);
    return { ok: false, error: errorText };
  }
}

// 담당자가 보내는 메일의 중복 발송 방지.
// 응답이 늦어 다시 누르거나 두 번 클릭하면 같은 메일이 두 번 나갈 수 있었다. 수신자·제목·내용이 같은 메일이
// 최근(MAIL_DEDUPE_WINDOW_SECONDS)에 나갔거나 보내는 중이면 보내지 않고 duplicate_recent를 돌려준다.
// 담당자가 확인 후 다시 보내면(allowDuplicate) 그대로 보낸다.
const MAIL_DEDUPE_WINDOW_SECONDS = 10 * 60;

function mailDedupeKey_(kind, body) {
  const skip = { sessionToken: 1, allowDuplicate: 1, attachments: 1 };
  const fields = Object.keys(body || {}).filter(function(k) { return !skip[k]; }).sort().map(function(k) {
    const v = body[k];
    return [k, v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))];
  });
  const files = (Array.isArray(body && body.attachments) ? body.attachments : []).map(function(a) {
    return [String(a && a.name || ''), String(a && a.base64 || '').length];
  });
  return 'maildedupe:' + sha256Hex_(kind + '|' + JSON.stringify(fields) + '|' + JSON.stringify(files));
}

// 보내도 되면 { key }를, 막아야 하면 { duplicate: { error, sentAt } }를 돌려준다.
function beginMailDedupe_(kind, body) {
  if (body && body.allowDuplicate) return { key: '' };
  const key = mailDedupeKey_(kind, body);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { key: '' }; // 잠금을 못 얻으면 막지 않는다(발송 자체는 계속)
  try {
    const prev = cache.get(key);
    if (prev) {
      let info = {};
      try { info = JSON.parse(prev) || {}; } catch (e) {}
      return { duplicate: { error: 'duplicate_recent', state: info.state || 'sent', sentAt: info.at || '' } };
    }
    cache.put(key, JSON.stringify({ state: 'sending', at: nowIso_() }), MAIL_DEDUPE_WINDOW_SECONDS);
    return { key: key };
  } finally {
    lock.releaseLock();
  }
}

function finishMailDedupe_(key, sent) {
  if (!key) return;
  const cache = CacheService.getScriptCache();
  if (sent) cache.put(key, JSON.stringify({ state: 'sent', at: nowIso_() }), MAIL_DEDUPE_WINDOW_SECONDS);
  else cache.remove(key);
}

function handleSendMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const result = sendMailViaGmail_(body.toEmail || body.to || body.email, body.subject, body.body || body.message, body.htmlBody);
  return json_(result);
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
    return true;
  } catch (err) {
    console.warn('logMailSend_ failed: ' + String(err && err.message || err));
    return false;
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
    const revs = {}; // 저장 후 행별 새 rev — 화면이 다음 저장 때 기준으로 쓴다
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
        revs[id] = next.rev;
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
      result = { status: 'ok', count, revs, cursor: getChangeCursor_(), serverTime: nowIso_() };
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

// 보존기한이 지난 지원자의 개인정보를 연결된 시트와 변경 로그 전체에서 삭제한다.
function purgeCandidatePii_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(v => String(v).trim()).filter(Boolean) : [];
  if (!ids.length) return json_({ error: 'missing_candidate_ids' });
  const idSet = new Set(ids);
  const emails = Array.isArray(body.candidateEmails)
    ? body.candidateEmails.map(v => normalizeEmail_(v)).filter(Boolean)
    : [];
  const emailSet = new Set(emails);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const removed = {
      candidates: deleteRowsWhere_('Candidates', row => idSet.has(String(row.id))),
      interviews: deleteRowsWhere_('Interviews', row => idSet.has(String(row.candId))),
      onboardings: deleteRowsWhere_('Onboardings', row => idSet.has(String(row.candId))),
      offers: deleteRowsWhere_('Offers', row => idSet.has(String(row.candId))),
      refReports: deleteRowsWhere_('RefReports', row => idSet.has(String(row.candId))),
      referenceCandidates: deleteRowsWhere_('ReferenceCandidates', row => idSet.has(String(row.pipelineCandId))),
      referenceResponses: deleteRowsWhere_('ReferenceResponses', row => idSet.has(String(row.pipelineCandId))),
      mailLog: emails.length ? deleteRowsWhere_('MailLog', row =>
        String(row.to || '').split(/[;,]/).some(addr => emailSet.has(normalizeEmail_(addr)))
      ) : 0
    };
    removed.changeLog = deleteCandidateChangeRows_(CHANGE_LOG_SHEET, idSet, emailSet);
    removed.changeArchive = deleteCandidateChangeRows_(CHANGE_ARCHIVE_SHEET, idSet, emailSet);

    return json_({ ok: true, removed, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

function deleteCandidateChangeRows_(sheetName, candidateIds, candidateEmails) {
  const sheet = getMainSpreadsheet_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(sheet.getLastColumn(), 8)).getValues();
  const headers = values[0].map(value => String(value || '').trim());
  const sheetIndex = headers.indexOf('sheet');
  const idIndex = headers.indexOf('id');
  const dataIndex = headers.indexOf('data');
  if (sheetIndex < 0 || idIndex < 0 || dataIndex < 0) return 0;

  const kept = [];
  let removed = 0;
  values.slice(1).forEach(row => {
    if (changeRowContainsCandidatePii_(row, sheetIndex, idIndex, dataIndex, candidateIds, candidateEmails)) {
      removed++;
    } else {
      kept.push(row);
    }
  });
  if (!removed) return 0;

  const bodyRange = sheet.getRange(2, 1, values.length - 1, values[0].length);
  bodyRange.clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, values[0].length).setValues(kept);
  return removed;
}

function changeRowContainsCandidatePii_(row, sheetIndex, idIndex, dataIndex, candidateIds, candidateEmails) {
  const changedSheet = String(row[sheetIndex] || '');
  const changedId = String(row[idIndex] || '');
  if (changedSheet === 'Candidates' && candidateIds.has(changedId)) return true;

  let data = {};
  try {
    data = JSON.parse(String(row[dataIndex] || '{}')) || {};
  } catch (err) {
    data = {};
  }
  const idKeys = ['candId', 'candidateId', 'pipelineCandId'];
  if (idKeys.some(key => data[key] != null && candidateIds.has(String(data[key])))) return true;

  const emailKeys = ['email', 'candEmail', 'candidateEmail', 'to'];
  return emailKeys.some(key => {
    if (data[key] == null) return false;
    return String(data[key]).split(/[;,]/).some(value => candidateEmails.has(normalizeEmail_(value)));
  });
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
  if (payload.action === 'getInterviewersFromDirectory') return getInterviewersFromDirectory_(payload);
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
  if (payload.action === 'getPanelAvailabilityResponsesBatch') return getPanelAvailabilityResponsesBatch_(payload);
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
  const responseBy = body.responseBy === 'headhunter' ? 'headhunter' : 'candidate';
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
    availabilityStatus: 'READY',
    availabilityRespondedAt: '',
    availabilityNote: '',
    availabilityResponseBy: responseBy,
    availabilityResponderName: String(body.responderName || '').trim(),
    availabilityResponderEmail: normalizeEmail_(body.responderEmail || ''),
    availabilityResponderOrg: String(body.responderOrg || '').trim(),
    availabilityProxyConfirmedAt: '',
    updatedAt: nowIso_()
  });
  const normalized = schemaRow_('Interviews', row);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);
  appendChange_('Interviews', 'upsert', interviewId, normalized);
  return json_({ ok: true, interviewId, link, tokenExpiresAt: expiresAt });
}

function setInterviewAvailabilityDeliveryStatus_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const interviewId = String(body.interviewId || body.id || '').trim();
  const status = String(body.status || '').trim().toUpperCase();
  if (!interviewId || !['SENT', 'SEND_FAILED'].includes(status)) {
    return json_({ error: 'invalid_interview_availability_delivery_status' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
    if (rowIndex < 1) return json_({ error: 'interview_not_found' });
    const existing = readRows_('Interviews').find(row => String(row.id) === interviewId);
    if (!existing) return json_({ error: 'interview_not_found' });
    const normalized = schemaRow_('Interviews', Object.assign({}, existing, {
      availabilityStatus: status,
      updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([
      headers.map(header => normalized[header] == null ? '' : normalized[header])
    ]);
    appendChange_('Interviews', 'upsert', interviewId, normalized);
    return json_({ ok: true, interviewId, status });
  } finally {
    lock.releaseLock();
  }
}

function verifyInterviewAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
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
    note: row.availabilityNote || '',
    responseBy: row.availabilityResponseBy || 'candidate',
    responderName: row.availabilityResponderName || '',
    responderEmail: row.availabilityResponderEmail || '',
    responderOrg: row.availabilityResponderOrg || '',
    proxyConfirmed: !!row.availabilityProxyConfirmedAt
  });
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
    const writeRow = confirmRowIndex_(sheet, headers, 'availabilityToken', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length)
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
    const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length).setValues([headers.map(header => next[header] == null ? '' : next[header])]);
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
    sendMailViaGmail_(to, subject, message, '');
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
    ['SENT', 'RESPONDED', 'UNAVAILABLE'].includes(i.availabilityStatus)
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
    deadlineAt: addReferenceDays_(new Date(), REFERENCE_CANDIDATE_DEADLINE_DAYS).toISOString(),
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
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
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

  // 일부만 유효하고 일부가 빠진 상태로 시트에 쓰거나 메일을 보내기 시작하면 안 되므로,
  // 쓰기/발송을 시작하기 전에 3명 전원의 필수값(이름·이메일·전화번호·소속 회사)을 먼저 검증한다.
  const normalizedReferees = referees.map(ref => ({
    name: String(ref && ref.name || '').trim(),
    email: normalizeEmail_(ref && ref.email),
    phone: normalizePhone_(ref && ref.phone),
    relation: String(ref && ref.relation || '').trim(),
    company: String(ref && ref.company || '').trim(),
  }));
  if (normalizedReferees.some(r => !r.name || !r.email || !r.phone || !r.company)) {
    return { error: 'referee_fields_incomplete' };
  }
  const emailSet = {};
  if (normalizedReferees.some(r => emailSet[r.email] ? true : (emailSet[r.email] = true, false))) {
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
      deadlineAt: addReferenceDays_(new Date(), REFERENCE_RESPONSE_DEADLINE_DAYS).toISOString(),
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

// 이 단계는 후보자 본인이 공개 페이지에서 직접 트리거하는 액션이라 관리자 검토 발송을 거칠 수 없다.
// 그래서 서버가 Gmail/MailApp로 추천인에게 안내 메일을 자동 발송한다. 성공하면 true.
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
      '응답 기한: ' + formatReferenceDateTime_(job.deadlineAt, true),
      `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    const result = sendMailViaGmail_(
      job.refereeEmail,
      '[우미건설] ' + job.candName + '님 레퍼런스 체크 요청',
      message,
      referenceMailHtml_(message, {
        templateType: 'referee_request',
        candidateName: job.candName,
        refereeName: job.refereeName,
        positionText: job.positionText,
        link: job.refLink,
        deadline: job.deadlineAt
      })
    );
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    return true;
  } catch (err) {
    console.warn('submitReferenceCandidateReferees_ mail failed: ' + String(err && err.message || err));
    return false;
  }
}

// 추천인이 응답 링크를 열었을 때의 1차 확인 — 링크 자체가 살아있는지만 본다.
// 아직 본인 확인(이메일·전화번호) 전이라 후보자명은 여기서 보여주지 않는다(신원 미확인 상태에서 노출 방지).
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
  const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
  if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
  if (verifiedAtCol > 0) sheet.getRange(writeRow, verifiedAtCol).setValue(nowIso_());

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
  const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
  if (writeRow < 0) return json_({ error: 'invalid_token' });
  sheet.getRange(writeRow, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  // 제출 완료 안내는 응답 화면에서 한다(추천인에게 별도 완료 메일은 보내지 않는다).
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
      '응답 기한: ' + formatReferenceDateTime_(referenceDisplayDeadline_(row), true),
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
        deadline: referenceDisplayDeadline_(row)
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
  const templateType = String(body.templateType || body.templateKey || body.mailType || '').trim();
  if (!REFERENCE_MAIL_TEMPLATE_FILES[templateType]) return json_({ error: 'reference_template_type_required' });
  const dedupe = beginMailDedupe_('reference', body);
  if (dedupe.duplicate) return json_(dedupe.duplicate);
  try {
    const html = insertForwardNotice_(referenceMailHtml_(message, body), body);
    const result = sendMailViaGmail_(to, subject, htmlToPlainText_(html) || message, html);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    finishMailDedupe_(dedupe.key, true);
  } catch (err) {
    finishMailDedupe_(dedupe.key, false);
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

// 헤드헌팅 경유 발송: 지원자에게 가는 것과 같은 템플릿을 업체 담당자에게 보내고, 본문 맨 위에
// "후보자에게 전달해 달라"는 안내 상자만 덧붙인다(예전에는 별도 headhunter_forward 템플릿에 텍스트를 넣었다).
// 템플릿의 {{josa:으로/로}}·{{josa:을/를}}·{{josa:이/가}}·{{josa:은/는}}·{{josa:과/와}} 표기를
// 바로 앞 글자(태그·공백 제외)의 받침에 맞춰 고른다. 예: "인테리어{{josa:으로/로}}" → "인테리어로",
// "공무팀{{josa:으로/로}}" → "공무팀으로". 숫자는 읽는 소리로 판단하고, 판단할 수 없는 글자
// (영문 등)는 "(으)로"처럼 두 형태를 함께 쓴다.
function koreanFinalConsonant_(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const jong = (code - 0xAC00) % 28;
    return jong === 0 ? 'none' : (jong === 8 ? 'rieul' : 'other');
  }
  const digit = { '0':'other', '1':'rieul', '2':'none', '3':'other', '4':'none', '5':'none', '6':'other', '7':'rieul', '8':'rieul', '9':'none' };
  return digit[ch] || 'unknown';
}

function applyKoreanJosa_(html) {
  return String(html || '').replace(/\{\{josa:([^/}]+)\/([^}]+)\}\}/g, function(token, withFinal, withoutFinal, offset, whole) {
    const before = whole.slice(0, offset).replace(/<[^>]*>/g, '').replace(/[\s"'”’)\]]+$/, '');
    const last = before.slice(-1);
    const kind = last ? koreanFinalConsonant_(last) : 'unknown';
    if (kind === 'unknown') return withFinal === '으로' ? '(으)로' : withFinal + '(' + withoutFinal + ')';
    if (withFinal === '으로') return kind === 'other' ? '으로' : '로';
    return kind === 'none' ? withoutFinal : withFinal;
  });
}

// HTML 메일 → 텍스트 버전(HTML을 못 여는 메일 앱용). 숨김 프리헤더·스타일은 빼고,
// 링크는 "문구 (주소)"로 남기며 줄바꿈 구조만 살린다.
function htmlToPlainText_(html) {
  let text = String(html || '');
  if (!text) return '';
  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function(_, href, label) {
      const plainLabel = String(label).replace(/<[^>]+>/g, '').trim();
      if (/^mailto:/i.test(href)) return plainLabel || href.replace(/^mailto:/i, '');
      return plainLabel && plainLabel !== href ? plainLabel + ' (' + href + ')' : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return text.split('\n').map(function(line) { return line.replace(/[ \t]+/g, ' ').trim(); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function forwardNoticeData_(data) {
  let notice = data && data.forwardNotice;
  if (typeof notice === 'string') { try { notice = JSON.parse(notice); } catch (err) { notice = null; } }
  return notice && typeof notice === 'object' ? notice : null;
}

function forwardNoticeHtml_(data) {
  const notice = forwardNoticeData_(data);
  if (!notice) return '';
  const recipient = escapeMailHtml_(notice.recipientName || '담당자');
  const firm = notice.firmName ? escapeMailHtml_(notice.firmName) + ' ' : '';
  const candidate = escapeMailHtml_(notice.candidateName || '후보자');
  const position = notice.positionText ? escapeMailHtml_(notice.positionText) + ' 포지션 ' : '';
  const purposeText = String(notice.purpose || '채용 진행').trim();
  const purpose = escapeMailHtml_(/안내$/.test(purposeText) ? purposeText : purposeText + ' 안내');
  const instruction = escapeMailHtml_(notice.instruction || '아래 내용을 후보자분께 전달해 주시고, 회신은 후보자명과 포지션명을 함께 기재해 본 메일로 보내 주세요.');
  return '        <tr>\n' +
    '          <td style="padding:0 0 22px;">\n' +
    '            <div style="padding:14px 16px;border:1px solid #f0d9a8;background:#fff8ea;border-radius:12px;">\n' +
    '              <div style="font-size:13px;line-height:1.4;font-weight:700;color:#8a5a12;padding-bottom:6px;">헤드헌팅 경유 안내 · 요청 사항</div>\n' +
    '              <div style="font-size:14px;line-height:1.6;color:#1b2027;word-break:keep-all;overflow-wrap:break-word;">' + firm + recipient + '님, 안녕하세요. ' + position + '후보자 <strong>' + candidate + '</strong>님의 ' + purpose + '입니다.<br>' + instruction + '</div>\n' +
    '            </div>\n' +
    '          </td>\n' +
    '        </tr>\n' +
    // 아래 본문은 후보자에게 전달할 내용임을 구분해 보여 준다(본문 인사말은 후보자에게 하는 말).
    '        <tr>\n' +
    '          <td style="padding:0 0 16px;">\n' +
    '            <div style="font-size:12px;line-height:1.5;font-weight:700;color:#8a94a1;border-bottom:1px dashed #cfd8e3;padding-bottom:6px;">▼ 후보자 전달 내용 — 아래 내용을 후보자에게 전달해 주세요</div>\n' +
    '          </td>\n' +
    '        </tr>\n';
}

// 헤드헌팅 업체에 보내는 메일: 지원자용 버튼 문구를 대리 입력 문구로, 문의 안내는 카카오톡 대신 회신 안내로 바꾼다.
const HEADHUNTER_BUTTON_LABELS_ = [
  ['>가능한 시간대 선택하기<', '>후보자 가능 시간대 입력<'],
  ['>입사 가능일 선택하기<', '>후보자 입사 가능일 입력<']
];
function headhunterBodyHtml_(html) {
  return HEADHUNTER_BUTTON_LABELS_.reduce((out, pair) => out.split(pair[0]).join(pair[1]), String(html || ''));
}
function headhunterContactHtml_() {
  return '        <tr>\n' +
    '          <td style="padding-top:24px;border-top:1px solid #dde7f1;">\n' +
    '            <div style="font-size:15px;line-height:1.4;font-weight:700;color:#1b2027;padding-bottom:6px;">문의 및 회신</div>\n' +
    '            <div style="font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">후보자 회신과 문의는 본 메일에 회신하시거나 우미건설 피플팀 담당자에게 연락해 주세요. 회신 시 후보자명과 포지션명을 함께 적어 주세요.</div>\n' +
    '          </td>\n' +
    '        </tr>\n';
}

function insertForwardNotice_(html, data) {
  const block = forwardNoticeHtml_(data);
  if (!block) return html;
  const source = String(html || '');
  const marker = source.indexOf('<!-- 본문 -->');
  const tableStart = source.indexOf('<table', marker < 0 ? 0 : marker);
  const tableEnd = tableStart < 0 ? -1 : source.indexOf('>', tableStart);
  if (marker < 0 || tableEnd < 0) return html;
  return source.slice(0, tableEnd + 1) + '\n' + block + source.slice(tableEnd + 1);
}

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
  throw new Error('reference_template_type_required');
}

function renderReferenceMailTemplate_(html, raw, data) {
  const link = String(data.link || data.actionUrl || ((raw.match(/https?:\/\/[^\s]+/) || [''])[0])).trim();
  const candidateName = referenceNameWithoutHonorific_(data.candidateName || data.candName || data.supporterName || extractReferenceCandidateName_(raw) || '지원자');
  const refereeName = referenceNameWithoutHonorific_(data.refereeName || data.recipientName || data.targetName || extractReferenceRefereeName_(raw) || 'OOO');
  const positionText = referencePositionText_(data.positionText || data.position || extractReferencePosition_(raw) || '홍보 포지션');
  const deadlineText = formatReferenceDateTime_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS), true);
  const submittedText = formatReferenceDateTime_(data.submittedAt || new Date(), false);
  const shortDeadlineText = shortReferenceDeadline_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS));

  const replacements = {
    '{{candidateName}}': escapeMailHtml_(candidateName),
    '{{refereeName}}': escapeMailHtml_(refereeName),
    '{{positionText}}': escapeMailHtml_(positionText),
    '{{deadlineText}}': escapeMailHtml_(deadlineText),
    '{{shortDeadlineText}}': escapeMailHtml_(shortDeadlineText),
    '{{submittedText}}': escapeMailHtml_(submittedText),
    '{{actionUrl}}': escapeMailHtml_(link)
  };
  let rendered = String(html || '');
  Object.keys(replacements).forEach(function(marker) {
    rendered = rendered.split(marker).join(replacements[marker]);
  });
  rendered = applyKoreanJosa_(rendered);
  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error('unresolved_reference_mail_placeholder');
  }
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
  offer_health: 'mail_body_offer_health',
  final_pass: 'mail_body_final_pass',
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
  onboarding_internal: data => `신규입사자 안내 — ${data.joinDate || ''} 입사 예정${Array.isArray(data.joiners) && data.joiners.length > 1 ? ' ' + data.joiners.length + '명' : ''}`,
  offer_health: () => '처우 제안과 채용검진 일정을 안내드립니다.',
  final_pass: () => '최종 합격을 축하드립니다. 입사 가능일을 선택해 주세요.',
  rejection: () => '채용 결과를 안내드립니다.',
  interview_slot_request: () => '가능한 면접 날짜와 시간대를 선택해 주세요.',
  headhunter_forward: data => `헤드헌팅 후보자 ${data.candidateName || ''}님의 ${data.purpose || '채용 진행'} 안내입니다.`,
  general_notice: () => '채용 진행 관련 안내드립니다.'
};

const GENERAL_MAIL_HEADER_TITLES = {
  interview_first: '1차 면접 안내',
  interview_second: '2차 면접 안내',
  panel_schedule: '면접 일정 안내',
  onboarding: '입사 안내',
  onboarding_internal: '신규입사자 안내',
  offer_health: '채용검진 및 근로조건 안내',
  final_pass: '최종합격 안내',
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
  const loc = String(body.loc || '').trim();
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
    loc: loc || existing.loc || '',
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

// 여러 포지션·차수의 면접관 회신을 한 번에 돌려준다(시작 시 미리 받기용). items: [{ positionId, round }]
function getPanelAvailabilityResponsesBatch_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100)
    .map(item => ({ positionId: String(item && item.positionId || '').trim(), round: String(item && item.round || '').trim() }))
    .filter(item => item.positionId && item.round);
  const wanted = {};
  items.forEach(item => { wanted[item.positionId + '|' + item.round] = []; });
  readRows_('PanelAvailability').forEach(row => {
    const key = String(row.positionId) + '|' + String(row.round);
    if (!wanted[key]) return;
    wanted[key].push(Object.assign({}, row, {
      availabilityOptions: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
      selections: parseJsonArray_(row.selections)
    }));
  });
  return json_({ ok: true, results: wanted });
}

function verifyPanelAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
  if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    participantRole: 'panel',
    participantName: row.panelistName || '',
    positionText: row.positionTitle || '',
    interviewType: row.round || '',
    location: row.loc || '',
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
    const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('PanelAvailability', 'upsert', row.id, normalized);
    notifyIfPanelAvailabilityCohortComplete_(normalized);
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

function replaceMailPlaceholders_(html, replacements) {
  let rendered = String(html || '');
  Object.keys(replacements || {}).forEach(function(marker) {
    rendered = rendered.split('{{' + marker + '}}').join(String(replacements[marker] == null ? '' : replacements[marker]));
  });
  return rendered;
}

function assertGeneralMailFields_(templateKey, data, fields) {
  const missing = (fields || []).filter(function(field) {
    return !String((data || {})[field] || '').trim();
  });
  if (missing.length) {
    throw new Error('missing_general_mail_fields:' + templateKey + ':' + missing.join(','));
  }
}

// 제목 칸(머리글 왼쪽 56%)에 한 줄로 들어가도록 긴 제목은 글자를 줄인다(예: '채용검진 및 근로조건 안내').
function mailHeaderTitleSize_(title) {
  const len = String(title || '').replace(/&[a-z]+;/g, ' ').length;
  return len <= 9 ? '28px' : len <= 11 ? '25px' : '22px';
}

function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return loadMailFragment_('mail_shared_header_bottom')
    .replace(/{{ciSrc}}/g, loadMailAsset_('mail_asset_ci_src'))
    .replace(/{{headerArtSrc}}/g, loadMailAsset_('mail_asset_header_art_src'))
    .replace(/{{headerTitleSize}}/g, mailHeaderTitleSize_(title))
    .replace(/{{headerTitle}}/g, title)
    .replace(/{{headerSubtitle}}/g, subtitle);
}

// 메일 양식을 만들지 못한 이유(발송 실패 알림에 함께 보여 준다)
var GENERAL_MAIL_LAST_ERROR_ = '';
function generalMailHtml_(templateKey, data) {
  GENERAL_MAIL_LAST_ERROR_ = '';
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

    const forwarded = !!forwardNoticeData_(ctx);
    return headerTop + preheaderDiv + headerBottom + bodyOpen + forwardNoticeHtml_(ctx)
      + (forwarded ? headhunterBodyHtml_(filledBody) : filledBody)
      + (forwarded ? headhunterContactHtml_() : contactHtml) + bodyClose + footer;
  } catch (err) {
    GENERAL_MAIL_LAST_ERROR_ = String(err && err.message || err);
    console.warn('generalMailHtml_ failed: ' + GENERAL_MAIL_LAST_ERROR_);
    return '';
  }
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function isInternalGeneralMail_(templateKey) {
  return templateKey === 'panel_schedule' || templateKey === 'onboarding_internal';
}

// 공용 문의 블록(mail_shared_contact_qr)에 들어 있는 기본 문구 — 메일 종류에 맞는 문구로 바꿔 넣는다.
const KAKAO_CONTACT_FRAGMENT_TEXT_ = '레퍼런스 체크와 관련해 궁금한 점이 있으시면 카카오톡 채널로 문의해 주세요.';

// 문의는 메일 회신이 아니라 카카오톡 채널로 받는다(레퍼런스 메일과 같은 문의 블록·QR 사용).
// 내부 직원에게 가는 메일(면접관 안내, 사내 입사 안내, 면접관 일정 확인)에는 붙이지 않는다.
function generalMailContactHtml_(templateKey, data) {
  if (isInternalGeneralMail_(templateKey) || (data && data.internalRecipient)) return '';
  const message = String((data && data.contactMessage) || '채용 절차와 관련해 궁금한 점이 있으시면 카카오톡 채널로 문의해 주세요.');
  return loadMailFragment_('mail_shared_contact_qr').split(KAKAO_CONTACT_FRAGMENT_TEXT_).join(nlToBr_(message));
}

// 메일 날짜 형식(전 메일 공통): 2026년 10월 6일(화). 'YYYY-MM-DD'가 아니면 받은 값을 그대로 쓴다.
function mailDateLabel_(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return raw;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const wk = ['일','월','화','수','목','금','토'][new Date(y, mo - 1, d).getDay()];
  return y + '년 ' + mo + '월 ' + d + '일(' + wk + ')';
}

// '담당 / 과장'처럼 직책/직급을 함께 적은 값에서 직급만 꺼내고, 역량등급이 있으면 '과장 (CL3)'처럼 붙인다.
// 직급(역량등급) 표기: 'CL2 1년차 (대리)'. 직급 칸에 '대리 1년차'처럼 적으면 연차와 직급을 나눠 쓴다.
// '담당 / 과장'처럼 직책을 함께 적었으면 '/' 뒤의 직급만 쓴다.
function onboardingRankCl_(rank, cl) {
  const raw = String(rank || '').trim();
  const grade = raw.includes('/') ? raw.split('/').pop().trim() : raw;
  const yearMatch = grade.match(/\d+\s*년차/);
  const years = yearMatch ? yearMatch[0].replace(/\s+/g, '') : '';
  const title = grade.replace(/\d+\s*년차/, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = [String(cl || '').trim(), years].filter(Boolean).join(' ');
  if (!head && !title) return '-';
  return title ? (head ? head + ' (' + title + ')' : title) : head;
}

// 표 안의 짧은 입사일자: 10.6(화)
function shortMailDate_(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value || '');
  const mo = Number(m[2]), d = Number(m[3]);
  const wk = ['일','월','화','수','목','금','토'][new Date(Number(m[1]), mo - 1, d).getDay()];
  return mo + '.' + d + '(' + wk + ')';
}

// 입사 사전 정보 입력(SAP) 제출 기한: 지정값이 없으면 입사일 전날, 입사일도 없으면 '입사일 전까지'로 안내한다.
function onboardingPreDeadlineLabel_(data) {
  const explicit = String(data.preDeadline || '').trim();
  if (explicit) return mailDateLabel_(explicit);
  const m = String(data.joinDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '입사일 전';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
  const pad = n => (n < 10 ? '0' : '') + n;
  return mailDateLabel_(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
}

// ── 메일 종류별 공통 첨부(사전 입사 절차 매뉴얼·채용검진 안내) ─────────────
// 관리자 화면에서 한 번 등록하면 해당 메일을 보낼 때마다 자동으로 붙는다. 문서가 바뀌면 화면에서 교체한다.
// DriveApp은 드라이브 전체 권한이 필요해(drive.file로는 거부됨) 이미 쓰는 스프레드시트의 숨김 시트에
// base64 조각으로 보관한다. 파일 정보(이름·크기·등록일)는 스크립트 속성에 둔다.
// 이 시트는 동기화 대상(SHEET_SCHEMAS)이 아니라서 화면으로 내려가지 않는다.
const COMMON_MAIL_ATTACHMENTS = {
  onboarding: { property: 'ONBOARDING_MANUAL_FILE', label: '사전 입사 절차 매뉴얼' },
  offer_health: { property: 'OFFER_HEALTH_GUIDE_FILE', label: '채용검진 안내' }
};
const COMMON_MAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const COMMON_MAIL_ATTACHMENT_SHEET = '_MailAttachments';
const COMMON_MAIL_ATTACHMENT_CHUNK = 45000; // 셀 하나에 5만 자까지 들어간다

// ── DB 시트 점검: 시스템이 쓰는 시트와 쓰지 않는(예전 버전 등) 시트를 구분한다. 지우지 않고 보관(이름 변경+숨김)만 한다. ──
const DB_INTERNAL_SHEETS = ['_Changes', '_Changes_Archive', '_MailAttachments'];
const DB_ARCHIVE_PREFIX = '_보관_';
function dbSheetStatus_(name) {
  if (SHEET_SCHEMAS[name]) return 'used';
  if (DB_INTERNAL_SHEETS.indexOf(name) >= 0) return 'internal';
  if (String(name).indexOf(DB_ARCHIVE_PREFIX) === 0) return 'archived';
  return 'unknown';
}
function listDbSheets_() {
  const ss = getMainSpreadsheet_();
  const sheets = ss.getSheets().map(sheet => ({
    name: sheet.getName(),
    rows: Math.max(0, sheet.getLastRow() - 1),
    hidden: sheet.isSheetHidden(),
    status: dbSheetStatus_(sheet.getName())
  }));
  return json_({ ok: true, spreadsheet: ss.getName(), sheets });
}
function archiveDbSheet_(data) {
  const name = String(data && data.name || '').trim();
  if (!name) return json_({ error: 'missing_sheet_name' });
  if (dbSheetStatus_(name) !== 'unknown') return json_({ error: 'sheet_in_use' });
  const ss = getMainSpreadsheet_();
  const sheet = ss.getSheetByName(name);
  if (!sheet) return json_({ error: 'sheet_not_found' });
  if (ss.getSheets().filter(s => !s.isSheetHidden()).length <= 1 && !sheet.isSheetHidden()) return json_({ error: 'last_visible_sheet' });
  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  let newName = DB_ARCHIVE_PREFIX + stamp + '_' + name;
  if (ss.getSheetByName(newName)) newName += '_' + Date.now();
  sheet.setName(newName.slice(0, 99));
  sheet.hideSheet();
  return json_({ ok: true, name: sheet.getName() });
}

function getCommonAttachmentMeta_(kind) {
  const def = COMMON_MAIL_ATTACHMENTS[kind];
  if (!def) return null;
  try {
    const meta = JSON.parse(getScriptProperty_(def.property) || 'null');
    // 이전 Drive 저장 방식(fileId)은 현재 권한으로 읽을 수 없다. 미등록으로 보여 재등록을 유도한다.
    return meta && Number(meta.chunks) > 0 ? meta : null;
  } catch (err) { return null; }
}

function getCommonAttachments_() {
  const result = {};
  Object.keys(COMMON_MAIL_ATTACHMENTS).forEach(kind => { result[kind] = getCommonAttachmentMeta_(kind); });
  return result;
}

function commonAttachmentSheet_(create) {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(COMMON_MAIL_ATTACHMENT_SHEET);
  if (!sheet && create) {
    sheet = ss.insertSheet(COMMON_MAIL_ATTACHMENT_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['kind', 'index', 'data']]);
    sheet.hideSheet();
  }
  return sheet;
}

function commonAttachmentBlob_(kind) {
  const meta = getCommonAttachmentMeta_(kind);
  if (!meta) return null;
  try {
    const sheet = commonAttachmentSheet_(false);
    if (!sheet || sheet.getLastRow() < 2) return null;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
      .filter(row => String(row[0]) === kind)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    if (rows.length !== Number(meta.chunks) || rows.some((row, index) => Number(row[1]) !== index)) return null;
    const bytes = Utilities.base64Decode(rows.map(row => String(row[2])).join(''));
    if (bytes.length !== Number(meta.size)) return null;
    return Utilities.newBlob(bytes, 'application/pdf', meta.name || 'attachment.pdf');
  } catch (err) {
    console.warn('commonAttachmentBlob_ failed (' + kind + '): ' + String(err && err.message || err));
    return null;
  }
}

function uploadCommonAttachment_(data) {
  const kind = String(data && data.kind || '');
  const def = COMMON_MAIL_ATTACHMENTS[kind];
  if (!def) return json_({ error: 'unknown_attachment_kind' });
  const name = String(data && data.name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const base64 = String(data && data.base64 || '').replace(/\s+/g, '');
  if (!name || !base64) return json_({ error: 'missing_upload_fields' });
  if (!/\.pdf$/i.test(name)) return json_({ error: 'unsupported_file_type' });
  const size = Utilities.base64Decode(base64).length;
  if (size > COMMON_MAIL_ATTACHMENT_MAX_BYTES) return json_({ error: 'file_too_large' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = commonAttachmentSheet_(true);
    // 다른 종류의 조각은 그대로 두고, 이 종류의 이전 조각을 새 조각으로 바꿔 한 번에 다시 쓴다.
    const lastRow = sheet.getLastRow();
    const kept = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, 3).getValues().filter(row => String(row[0]) !== kind)
      : [];
    const chunks = [];
    for (let i = 0; i < base64.length; i += COMMON_MAIL_ATTACHMENT_CHUNK) {
      chunks.push([kind, chunks.length, base64.slice(i, i + COMMON_MAIL_ATTACHMENT_CHUNK)]);
    }
    const rows = kept.concat(chunks);
    if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
    sheet.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
    const meta = { name: name, size: size, chunks: chunks.length, uploadedAt: nowIso_() };
    PropertiesService.getScriptProperties().setProperty(def.property, JSON.stringify(meta));
    return json_({ ok: true, kind: kind, attachment: meta });
  } finally {
    lock.releaseLock();
  }
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

  // 도입 문구 — 가능 시간대를 회신받아 확정한 일정이면 '확정 안내', 아니면 기본(선정·일정 안내) 문구.
  // (가능 시간대까지 받은 지원자에게 다시 '대상자로 선정되어'라고 보내던 어색한 문구 방지)
  if (templateKey === 'interview_first' || templateKey === 'interview_second') {
    const confirmedIntro = String(data.availabilityConfirmed || '') === 'Y';
    const drop = confirmedIntro ? 'default' : 'confirmed';
    rendered = rendered
      .replace(new RegExp('\\s*<tr data-mail-intro="' + drop + '">[\\s\\S]*?<\\/tr>', 'g'), '')
      .replace(/<tr data-mail-intro="(?:default|confirmed)">/g, '<tr>');
  }

  if (templateKey === 'interview_first') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','interviewDateTime']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewDateTime: escapeMailHtml_(data.interviewDateTime || ''),
      location: escapeMailHtml_(data.location || '')
    });
  } else if (templateKey === 'interview_second') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','interviewDateTime']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewDateTime: escapeMailHtml_(data.interviewDateTime || ''),
      location: escapeMailHtml_(data.location || '')
    });
  } else if (templateKey === 'panel_schedule') {
    assertGeneralMailFields_(templateKey, data, [
      'dept','interviewType','scheduleText','targetCount','panelNames','targetList'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      dept: escapeMailHtml_(data.dept || ''),
      etype: escapeMailHtml_(data.etype || ''),
      interviewType: escapeMailHtml_(data.interviewType || ''),
      scheduleText: escapeMailHtml_(data.scheduleText || ''),
      location: escapeMailHtml_(data.location || ''),
      targetCount: escapeMailHtml_(String(data.targetCount || '')),
      panelNames: escapeMailHtml_(data.panelNames || ''),
      targetList: nlToBr_(data.targetList || '')
    });
  } else if (templateKey === 'onboarding') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','joinDate']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      joinDate: escapeMailHtml_(mailDateLabel_(data.joinDate)),
      joinTime: escapeMailHtml_(data.joinTime || '09:00'),
      reportLocation: escapeMailHtml_(data.reportLocation || '린스퀘어 14F'),
      dept: escapeMailHtml_(data.dept || ''),
      rank: escapeMailHtml_(data.rank || ''),
      rankCl: escapeMailHtml_(onboardingRankCl_(data.rank, data.cl)),
      etype: escapeMailHtml_(data.etype || ''),
      location: escapeMailHtml_(data.location || ''),
      preDeadline: escapeMailHtml_(onboardingPreDeadlineLabel_(data))
    });
    // 현장직 입사자에게만 개인 짐 준비 안내를 남긴다.
    if (!data.siteGear) rendered = rendered.replace(/<tr id="siteGearRow">[\s\S]*?<\/tr>/, '');
  } else if (templateKey === 'onboarding_internal') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','joinDate']);
    // 같은 날 같은 부서 입사자는 한 메일로 보낸다(data.joiners). 없으면 이 메일의 입사자 한 명.
    const joiners = Array.isArray(data.joiners) && data.joiners.length ? data.joiners : [data];
    const joinerFields = j => ({
      candidateName: escapeMailHtml_(j.candidateName || ''),
      positionText: escapeMailHtml_(j.positionText || ''),
      dept: escapeMailHtml_(j.dept || data.dept || ''),
      category: escapeMailHtml_(j.category || ''),
      nameEn: escapeMailHtml_(j.nameEn || '-'),
      etype: escapeMailHtml_(j.etype || ''),
      rankCl: escapeMailHtml_(onboardingRankCl_(j.rank, j.cl)),
      joinDateShort: escapeMailHtml_(shortMailDate_(j.joinDate || data.joinDate)),
      phone: escapeMailHtml_(j.phone || '연락처 미입력')
    });
    const repeatBlock = (startTag, endTag, list, tweak) => {
      const re = new RegExp('<!--' + startTag + '-->([\\s\\S]*?)<!--' + endTag + '-->');
      const m = rendered.match(re);
      if (!m) return;
      rendered = rendered.replace(m[0], list.map((j, i) => replaceMailPlaceholders_(tweak ? tweak(m[1], i) : m[1], joinerFields(j))).join(''));
    };
    // 두 번째 표부터는 위 표와 간격을 둔다.
    repeatBlock('JOINER_TABLE_START', 'JOINER_TABLE_END', joiners, (html, i) => i ? html.replace('<td style="padding:0;">', '<td style="padding:10px 0 0;">') : html);
    // 현장 입사자에게만 '숙소·제복 확인 요청'을 남긴다(구분이 현장이거나 근무지가 현장으로 보이는 경우).
    const siteJoiners = joiners.filter(j => j.category === '현장' || /현장|공사|사업소|프로젝트|PJ/i.test(String(j.location || j.workplace || j.site || '')));
    if (siteJoiners.length) repeatBlock('SITE_CONTACT_START', 'SITE_CONTACT_END', siteJoiners);
    else rendered = rendered.replace(/<tr id="siteOnboardingRequestRow">[\s\S]*?<\/tr>/, '');
    rendered = replaceMailPlaceholders_(rendered, {
      joinDate: escapeMailHtml_(mailDateLabel_(data.joinDate)),
      joinerPhrase: joiners.length > 1 ? '신규 입사자 ' + joiners.length + '명을' : '신규 입사자를',
      replyDeadline: escapeMailHtml_(data.replyDeadline || ''),
      deptCooperation: nlToBr_(data.deptCooperation || '')
    });
  } else if (templateKey === 'offer_health') {
    // 처우제안·채용검진 안내: 최종합격 전 단계라 합격·입사일 내용은 넣지 않는다(검진 적합 → 최종합격 통보).
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','healthDeadline','salary']);
    const salaryDigits = String(data.salary || '').replace(/[^0-9]/g, '');
    const allowanceLines = String(data.allowances || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      healthDeadline: escapeMailHtml_(shortMailDate_(data.healthDeadline)),
      org: escapeMailHtml_(data.org || '우미건설(주)'),
      etypeText: escapeMailHtml_(data.etypeText || data.etype || '-'),
      offerRank: escapeMailHtml_(onboardingRankCl_(data.rank, data.cl)),
      salaryText: escapeMailHtml_((salaryDigits ? salaryDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(data.salary || '')) + '원/年'),
      salaryNote: data.salaryNote ? ' (' + escapeMailHtml_(data.salaryNote) + ')' : '',
      allowancesHtml: allowanceLines.length
        ? '<div style="padding-top:4px;color:#334155;">' + allowanceLines.map(line => '- ' + escapeMailHtml_(line)).join('<br>') + '</div>'
        : '',
      benefitsText: escapeMailHtml_(data.benefits || '내규에 따름'),
      // 수습기간은 비워 두면 표에서 줄째로 뺀다.
      probationRow: data.probation
        ? '<tr><td width="96" valign="top" style="width:96px;padding:10px 10px;background:#f5f8fc;border-bottom:1px solid #e3eaf2;font-size:12.5px;line-height:1.5;font-weight:700;color:#5c6875;word-break:keep-all;">수습기간</td><td valign="top" style="padding:10px 12px;border-bottom:1px solid #e3eaf2;font-size:14px;line-height:1.5;color:#1b2027;word-break:keep-all;overflow-wrap:break-word;">' + escapeMailHtml_(data.probation) + '</td></tr>'
        : ''
    });
  } else if (templateKey === 'final_pass') {
    // 최종합격 통보 + 입사 가능일 회신 요청(제안 날짜 중 선택하는 공개 페이지 링크)
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','link']);
    const dates = String(data.options || '').split(',').map(x => x.trim()).filter(Boolean);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      optionsText: escapeMailHtml_(dates.map(shortMailDate_).join(', ') || '-'),
      replyDeadline: escapeMailHtml_(data.replyDeadline ? mailDateLabel_(data.replyDeadline) : '가능한 빨리'),
      link: escapeMailHtml_(data.link)
    });
  } else if (templateKey === 'rejection') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText)
    });
  } else if (templateKey === 'interview_slot_request') {
    assertGeneralMailFields_(templateKey, data, [
      'candidateName','positionText','interviewType','slotOptions','responseDeadline','availabilityLink'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewType: escapeMailHtml_(data.interviewType || ''),
      slotOptions: nlToBr_(data.slotOptions || ''),
      location: escapeMailHtml_(data.location || ''),
      responseDeadline: escapeMailHtml_(data.responseDeadline || ''),
      availabilityLink: escapeMailHtml_(data.availabilityLink || '#')
    });
  } else if (templateKey === 'headhunter_forward') {
    const forwardBody = data.forwardBody || data.body || '';
    const actionLink = String(data.actionLink || '').trim();
    const actionLabel = String(data.actionLabel || '바로가기').trim();
    const responseAction = actionLink
      ? '<div style="text-align:center;margin:22px 0 2px;"><a href="' + escapeMailHtml_(actionLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:7px;">' + escapeMailHtml_(actionLabel) + '</a></div>'
      : '';
    assertGeneralMailFields_(templateKey, Object.assign({}, data, { forwardBody }), [
      'candidateName','positionText','forwardBody'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      recipientName: escapeMailHtml_(data.recipientName || '헤드헌팅 담당자'),
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      purpose: escapeMailHtml_(data.purpose || '채용 진행'),
      forwardBody: nlToBr_(forwardBody),
      responseInstruction: escapeMailHtml_(data.responseInstruction || '아래 내용을 후보자에게 전달하신 후, 참석 가능 여부를 본 메일로 회신해 주세요.'),
      responseNote: escapeMailHtml_(data.responseNote || '회신 시 후보자명, 포지션명, 참석 가능 여부를 함께 기재해 주세요.'),
      responseAction
    });
  } else if (templateKey === 'general_notice') {
    const actionLink = String(data.actionLink || '').trim();
    const actionLabel = String(data.actionLabel || '바로가기').trim();
    const noticeBody = data.noticeBody || data.body || '';
    assertGeneralMailFields_(templateKey, Object.assign({}, data, { noticeBody }), [
      'candidateName','positionText','noticeBody'
    ]);
    const noticeHtml = nlToBr_(noticeBody) + (actionLink
      ? '<div style="text-align:center;margin:24px 0 2px;"><a href="' + escapeMailHtml_(actionLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:7px;">' + escapeMailHtml_(actionLabel) + '</a></div>'
      : '');
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      noticeBody: noticeHtml
    });
  }

  // 조사 표기는 값이 채워진 뒤에 받침을 보고 고른다(남은 {{...}} 검사보다 먼저).
  rendered = applyKoreanJosa_(rendered);

  if (['interview_first', 'interview_second', 'panel_schedule', 'onboarding', 'onboarding_internal', 'offer_health', 'final_pass',
       'interview_slot_request', 'rejection', 'headhunter_forward', 'general_notice'].includes(templateKey) &&
      /\{\{[^}]+\}\}/.test(rendered)) {
    // 어떤 칸이 남았는지 함께 알려 준다(서버 코드와 메일 양식 파일의 버전이 다를 때 주로 생긴다).
    throw new Error('unresolved_general_mail_placeholder:' + (rendered.match(/\{\{[^}]+\}\}/g) || []).filter((v, i, a) => a.indexOf(v) === i).join(','));
  }
  return rendered;
}

function handleSendGeneralMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const to = normalizeEmail_(body.toEmail || body.to || body.email);
  const subject = String(body.subject || '').trim();
  if (!to || !subject) return json_({ error: 'missing_mail_fields' });
  const dedupe = beginMailDedupe_('general', body);
  if (dedupe.duplicate) return json_(dedupe.duplicate);
  try {
    const html = generalMailHtml_(body.templateType, body);
    if (!html) throw new Error('mail_template_render_failed' + (GENERAL_MAIL_LAST_ERROR_ ? ':' + GENERAL_MAIL_LAST_ERROR_ : ''));
    // 메일 문구는 HTML 템플릿 한 곳에서만 관리한다 — 텍스트 버전도 렌더링된 HTML에서 만든다.
    const message = htmlToPlainText_(html) || String(body.body || body.message || '').trim();
    const attachments = buildMailAttachments_(body.attachments);
    // 메일 종류별 공통 첨부(입사안내: 사전 입사 절차 매뉴얼, 처우·검진 안내: 채용검진 안내)를 자동으로 붙인다.
    let commonAttached = false;
    if (COMMON_MAIL_ATTACHMENTS[body.templateType]) {
      const commonMeta = getCommonAttachmentMeta_(body.templateType);
      const common = commonAttachmentBlob_(body.templateType);
      if (commonMeta && !common) throw new Error('common_attachment_unavailable');
      if (common) { attachments.push(common); commonAttached = true; }
    }
    if (mailAttachmentTotalBytes_(attachments) > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error('attachment_too_large');
    }
    const result = sendMailViaGmail_(to, subject, message, html, attachments);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    finishMailDedupe_(dedupe.key, true);
    return json_({ ok: true, to: to, commonAttached: commonAttached });
  } catch (err) {
    finishMailDedupe_(dedupe.key, false);
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
      max_tokens: 3000,
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
  const choice = parsed.choices && parsed.choices[0];
  const content = choice && choice.message && choice.message.content || '';
  return json_({ ok: true, text: content, truncated: choice && choice.finish_reason === 'length' });
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
  const pos = readRowByIdIfSheetExists_('Positions', positionId);
  return !!pos && CLOSED_POSITION_STATUSES_.includes(String(pos.status || '').trim());
}

function candidateStageClosed_(value) {
  const stage = String(value == null ? '' : value).trim();
  return ['5', '6', '7', '최종합격', '불합격', '입사'].includes(stage);
}

function candidateProcessClosed_(candId) {
  if (candId === '' || candId == null) return false;
  const cand = readRowByIdIfSheetExists_('Candidates', candId);
  if (!cand) return false;
  if (candidateStageClosed_(cand.stage) || String(cand.held || '') === 'Y') return true;
  return positionProcessClosed_(cand.posId);
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
  if (EXEC_CACHE_.sheets[sheetName]) return EXEC_CACHE_.sheets[sheetName];
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    // 날짜(2026-10-15)·시각(09:00)·연락처(010…)가 날짜/숫자로 바뀌지 않도록 텍스트 형식으로 만든다.
    if (TEXT_FORMAT_SHEETS.indexOf(sheetName) >= 0) sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(sheet.getMaxColumns(), SHEET_SCHEMAS[sheetName].length)).setNumberFormat('@');
  }
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  EXEC_CACHE_.sheets[sheetName] = sheet;
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getScriptProperty_(REFERRAL_DATA_URL_PROPERTY) || getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return openSpreadsheetCached_(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return getMainSpreadsheet_();
}

function ensureChangeArchiveSheet_() {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(CHANGE_ARCHIVE_SHEET);
  if (!sheet) sheet = ss.insertSheet(CHANGE_ARCHIVE_SHEET);
  const headers = ['cursor','timestamp','sheet','action','id','actorEmail','result','data'];
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(headers);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
    if (headers.some(function(header, index) { return String(current[index] || '').trim() !== header; })) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sheet;
}

function archiveOldChanges_(retentionDays, maxRows) {
  const days = Math.max(1, Number(retentionDays) || CHANGE_ARCHIVE_RETENTION_DAYS);
  const limit = Math.max(1, Math.min(Number(maxRows) || CHANGE_ARCHIVE_BATCH_SIZE, CHANGE_ARCHIVE_BATCH_SIZE));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const source = ensureChangeLogSheet_();
    const available = source.getLastRow() - 1;
    if (available <= 0) return { ok: true, archived: 0, remaining: 0 };

    const scanCount = Math.min(available, limit);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const timestamps = source.getRange(2, 2, scanCount, 1).getValues();
    let archiveCount = 0;
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = new Date(timestamps[i][0]).getTime();
      if (!Number.isFinite(timestamp) || timestamp >= cutoff) break;
      archiveCount += 1;
    }
    if (!archiveCount) return { ok: true, archived: 0, remaining: available };

    const rows = source.getRange(2, 1, archiveCount, 8).getValues();
    const archive = ensureChangeArchiveSheet_();
    // 지난 실행이 아카이브에 쓴 뒤 원본 삭제 전에 끊겼다면 같은 행이 아카이브 끝에 이미 있다.
    // 커서 번호 크기로 거르면 같은 번호(두 프로젝트 동시 기록)·순서가 뒤바뀐 행이 아카이브 없이 삭제되므로
    // 아카이브 끝부분의 실제 행(커서·시각·시트·동작·id)과 비교한다.
    const archivedTail = Math.min(Math.max(archive.getLastRow() - 1, 0), rows.length);
    const archivedKeys = new Set(archivedTail
      ? archive.getRange(archive.getLastRow() - archivedTail + 1, 1, archivedTail, 5).getValues().map(changeArchiveRowKey_)
      : []);
    const newRows = rows.filter(function(row) { return !archivedKeys.has(changeArchiveRowKey_(row)); });
    if (newRows.length) {
      archive.getRange(archive.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
    }
    source.deleteRows(2, archiveCount);
    return {
      ok: true,
      archived: archiveCount,
      remaining: available - archiveCount,
      cutoff: new Date(cutoff).toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function changeArchiveRowKey_(row) {
  return [0, 1, 2, 3, 4].map(function(index) { return String(normalizeCell_(row[index])); }).join('|');
}

// 예전 _Changes에는 행 전체 JSON이 들어 있다. 한 번에 너무 많은 셀을 쓰지 않도록 제한된 수만
// 필드명 메타데이터로 바꾸며, 남은 건은 다음 weeklyOps 또는 수동 실행에서 이어서 처리한다.
function compactStoredChangeLogValues_(sheetName, maxRows) {
  const ss = getMainSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheetName, scanned: 0, compacted: 0, remaining: false };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const dataIndex = headers.indexOf('data');
  if (dataIndex < 0) return { sheet: sheetName, scanned: 0, compacted: 0, remaining: false };

  const count = sheet.getLastRow() - 1;
  const values = sheet.getRange(2, dataIndex + 1, count, 1).getValues();
  const limit = Math.max(1, Math.min(Number(maxRows) || CHANGE_COMPACT_BATCH_SIZE, CHANGE_COMPACT_BATCH_SIZE));
  const updates = [];
  let remaining = false;
  for (let index = 0; index < values.length; index++) {
    const raw = String(values[index][0] || '');
    if (raw.indexOf('{"fields":') === 0 && raw.indexOf('}') === raw.length - 1) continue; // 이미 정리된 행
    const parsed = parseJsonObject_(raw);
    const alreadyCompact = Array.isArray(parsed.fields) && Object.keys(parsed).every(function(key) { return key === 'fields'; });
    if (alreadyCompact) continue;
    if (updates.length >= limit) { remaining = true; break; }
    updates.push({ row: index + 2, value: JSON.stringify(compactChangeLogData_(parsed)) });
  }

  // 연속된 행끼리 묶어 API 호출 수를 줄인다.
  const ranges = [];
  updates.forEach(function(update) {
    const current = ranges[ranges.length - 1];
    if (current && current.start + current.values.length === update.row) current.values.push([update.value]);
    else ranges.push({ start: update.row, values: [[update.value]] });
  });
  ranges.forEach(function(range) {
    sheet.getRange(range.start, dataIndex + 1, range.values.length, 1).setValues(range.values);
  });
  return { sheet: sheetName, scanned: values.length, compacted: updates.length, remaining: remaining };
}

function compactChangeLogs() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return {
      active: compactStoredChangeLogValues_(CHANGE_LOG_SHEET),
      archive: compactStoredChangeLogValues_(CHANGE_ARCHIVE_SHEET)
    };
  } finally {
    lock.releaseLock();
  }
}

function archiveOldChanges() {
  return archiveOldChanges_();
}

// 매주 실행. 한 번에 CHANGE_ARCHIVE_BATCH_SIZE·CHANGE_COMPACT_BATCH_SIZE씩만 처리하되, 밀린 건이 있으면
// 실행시간 예산(OPS_TIME_BUDGET_MS) 안에서 배치를 반복한다. 예산을 넘겨 남은 건은 incomplete로 알리고
// 다음 실행(또는 수동 재실행)에서 이어서 처리한다. 같은 행을 두 번 아카이브하지 않는다(archiveOldChanges_).
function weeklyOps() {
  const guard = acquireOpsRunGuard_('weeklyOps');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    const archiveResult = archiveOldChanges_();
    const compactResult = compactChangeLogs();
    let archiveBatches = 1;
    let compactBatches = 1;
    // 직전 배치가 꽉 찼을 때만(남은 오래된 기록이 더 있을 수 있을 때만) 다음 배치를 돈다.
    let lastArchived = archiveResult.archived;
    while (lastArchived >= CHANGE_ARCHIVE_BATCH_SIZE && !opsTimeBudgetExceeded_()) {
      const next = archiveOldChanges_();
      archiveResult.archived += next.archived;
      archiveResult.remaining = next.remaining;
      archiveBatches++;
      lastArchived = next.archived;
    }
    while ((compactResult.active.remaining || compactResult.archive.remaining) && !opsTimeBudgetExceeded_()) {
      const next = compactChangeLogs();
      ['active', 'archive'].forEach(function(key) {
        compactResult[key].compacted += next[key].compacted;
        compactResult[key].remaining = next[key].remaining;
      });
      compactBatches++;
    }
    archiveResult.batches = archiveBatches;
    compactResult.batches = compactBatches;
    const incomplete = lastArchived >= CHANGE_ARCHIVE_BATCH_SIZE
      || !!(compactResult.active.remaining || compactResult.archive.remaining);
    console.log('weeklyOps: ' + JSON.stringify({ changeArchive: archiveResult, changeLogCompaction: compactResult, incomplete: incomplete }));
    return { ok: true, incomplete: incomplete, changeArchive: archiveResult, changeLogCompaction: compactResult };
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

// 진행이 끝난 지원자 id 집합 — 불합격, 보류(held), 또는 진행중이 아닌 포지션 소속.
function stoppedPipelineCandidateIds_() {
  const closedPositions = new Set(readRowsIfSheetExists_('Positions')
    .filter(row => CLOSED_POSITION_STATUSES_.includes(String(row.status || '').trim()))
    .map(row => String(row.id)));
  const ids = new Set();
  readRowsIfSheetExists_('Candidates').forEach(row => {
    const posId = row.posId === '' || row.posId == null ? '' : String(row.posId);
    if (candidateStageClosed_(row.stage) || String(row.held || '') === 'Y' || (posId && closedPositions.has(posId))) {
      ids.add(String(row.id));
    }
  });
  return ids;
}

// 트리거 등록은 운영자가 별도로 수행한다. 이 함수는 매일 09:00 실행을 전제로 하며,
// eventKey가 이미 성공 기록된 메일은 다시 보내지 않는다.
function dailyOps() {
  const guard = acquireOpsRunGuard_('dailyOps');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    const today = opsDateKey_(new Date());
    const results = {
      referenceCandidateReminders: 0,
      referenceResponseReminders: 0,
      candidateInterviewReminders: 0,
      internalNotices: 0,
      skipped: 0,
      deferred: 0,
      warnings: [],
      failed: []
    };

    // 충원완료·부분충원 마감·미채용·채용중단 포지션 소속, 불합격·보류 지원자에게는 자동 메일을 보내지 않는다.
    const stoppedCandIds = stoppedPipelineCandidateIds_();
    if (stoppedCandIds.size) results.skippedClosed = 0;
    const isStopped = candId => {
      const stopped = candId != null && stoppedCandIds.has(String(candId));
      if (stopped) results.skippedClosed++;
      return stopped;
    };

    readRowsIfSheetExists_('ReferenceCandidates').forEach(row => {
      if (!row.candEmail || row.refereesSubmittedAt || referenceLinkExpired_(row)) return;
      if (isStopped(row.pipelineCandId)) return;
      const reminder = referenceReminderKind_(row, today, false);
      if (!reminder) return;
      const eventKey = referenceReminderEventKey_('reference-candidate', row.id, reminder, today);
      const message = [
        row.candName + '님, 안녕하세요.', '',
        '레퍼런스 체크를 위한 추천인 등록이 아직 완료되지 않아 안내드립니다.',
        reminder === 'expiry-d3' ? '등록 링크가 3일 후 만료됩니다.'
          : reminder === 'overdue' ? '등록 기한이 지났습니다. 링크가 만료되기 전에 아래 링크에서 추천인 3명을 등록해 주세요.'
          : '아래 링크에서 추천인 3명을 등록해 주세요.',
        '', '추천인 등록 링크', row.link || buildReferenceCandidateLinkUrl_(row.token), '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.candEmail,
        '[우미건설] 레퍼런스 체크 추천인 등록 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'candidate_reminder', candidateName: row.candName,
          positionText: row.positionText || '', link: row.link || buildReferenceCandidateLinkUrl_(row.token),
          deadline: referenceDisplayDeadline_(row)
        }));
      countOpsResult_(results, send, 'referenceCandidateReminders', eventKey);
    });

    readRowsIfSheetExists_('ReferenceResponses').forEach(row => {
      if (!row.refereeEmail || row.submittedAt || referenceLinkExpired_(row)) return;
      if (isStopped(row.pipelineCandId)) return;
      const reminder = referenceReminderKind_(row, today, true);
      if (!reminder) return;
      const eventKey = referenceReminderEventKey_('reference-referee', row.id, reminder, today);
      const link = row.link || buildReferenceResponseLinkUrl_(row.token);
      const message = [
        row.refereeName + '님, 안녕하세요.', '',
        row.candName + '님에 대한 레퍼런스 체크 설문이 아직 접수되지 않아 재안내드립니다.',
        reminder === 'expiry-d3' ? '응답 링크가 3일 후 만료됩니다.'
          : reminder === 'overdue' ? '응답 기한이 지났습니다. 링크가 만료되기 전에 아래 링크에서 설문을 작성해 주세요.'
          : '아래 링크에서 설문을 작성해 주세요.',
        '', '설문 참여 링크', link, '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.refereeEmail,
        '[우미건설] ' + row.candName + '님 레퍼런스 체크 응답 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'referee_reminder', candidateName: row.candName,
          refereeName: row.refereeName, positionText: '', link, deadline: referenceDisplayDeadline_(row)
        }));
      countOpsResult_(results, send, 'referenceResponseReminders', eventKey);
    });

    const candidates = readRowsIfSheetExists_('Candidates');
    const candidateMap = new Map(candidates.map(row => [String(row.id), row]));
    const tomorrow = opsDateKey_(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const tomorrowInterviews = readRowsIfSheetExists_('Interviews').filter(row =>
      row.status === 'confirmed' && !row.result && isSheetTrue_(row.candidateNotified) && opsDateKey_(row.date) === tomorrow
      && !isStopped(row.candId)
    );
    tomorrowInterviews.forEach(row => {
      const candidate = candidateMap.get(String(row.candId));
      if (!candidate) return;
      const viaHeadhunter = String(candidate.source || '') === '헤드헌팅' && candidate.headhunterEmail;
      const to = viaHeadhunter ? candidate.headhunterEmail : candidate.email;
      if (!to) return;
      const eventKey = ['daily', 'interview-candidate', row.id, tomorrow].join(':');
      const place = row.candidateLoc || row.loc || '';
      const message = [
        (viaHeadhunter ? (candidate.headhunterManager || candidate.headhunterName || '담당자') : candidate.name) + '님, 안녕하세요.', '',
        candidate.name + '님의 ' + row.type + ' 면접이 내일 예정되어 있어 안내드립니다.',
        '일시: ' + formatOpsDateTime_(row.date),
        '장소: ' + place,
        viaHeadhunter ? '후보자에게 위 일정을 전달해 주세요.' : '안내된 시간에 맞춰 도착해 주세요.',
        '', '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, to,
        '[우미건설] ' + candidate.name + '님 면접 전날 안내', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'candidateInterviewReminders', eventKey);
    });

    const notifyEmail = getNotifyEmail_();
    if (!notifyEmail) results.warnings.push('notify_email_not_configured');
    if (notifyEmail && tomorrowInterviews.length) {
      const eventKey = ['daily', 'panel-preparation', tomorrow].join(':');
      const lines = tomorrowInterviews.map(row => {
        const candidate = candidateMap.get(String(row.candId));
        return '- ' + formatOpsDateTime_(row.date) + ' · ' + (candidate && candidate.name || row.candName || '-') +
          ' · 면접관 ' + (row.panel || '-') + ' · ' + (row.panelLoc || row.loc || '-');
      });
      const message = ['내일 예정된 면접입니다.', '면접관 안내는 면접조서 첨부 후 대시보드에서 수동 발송해 주세요.', '', lines.join('\n')].join('\n');
      const send = sendOpsMailOnce_(eventKey, notifyEmail, '[채용시스템] 내일 면접 준비 확인', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'internalNotices', eventKey);
    }

    const dueRewards = readRowsIfSheetExists_('Rewards').filter(row => {
      if (!row.dueDate || ['PAID', 'CANCELLED'].includes(String(row.status || '').toUpperCase())) return false;
      const days = opsDaysBetween_(today, opsDateKey_(row.dueDate));
      return days >= 0 && days <= 7;
    });
    if (notifyEmail && dueRewards.length) {
      const eventKey = ['daily', 'reward-due', today].join(':');
      const lines = dueRewards.map(row => '- ' + row.dueDate + ' · ' + (row.milestone || '-') + ' · ' +
        (row.refEmail || '-') + ' · ' + Number(row.amount || 0).toLocaleString('ko-KR') + '원');
      const message = ['7일 이내 도래하는 사내추천 보상 확인 대상입니다.', '', lines.join('\n')].join('\n');
      const send = sendOpsMailOnce_(eventKey, notifyEmail, '[채용시스템] 추천 보상 만기 확인', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'internalNotices', eventKey);
    }

    if (results.warnings.length) console.warn('dailyOps: Settings 시트의 notifyEmail이 비어 있어 내부 알림(면접 준비·보상 만기)을 보내지 않았습니다.');
    opsMailWarnings_().forEach(warning => {
      results.warnings.push(warning);
      console.warn('dailyOps: ' + (warning === 'mail_quota_exhausted'
        ? '일일 메일 발송 한도가 소진되어 남은 메일을 미뤘습니다. 한도가 회복된 뒤 다시 실행하면 이어서 보냅니다.'
        : '보낸 메일 일부를 MailLog에 기록하지 못했습니다. 다시 실행하면 같은 메일이 다시 나갈 수 있습니다.'));
    });
    // 실행시간 예산을 넘겨 보내지 못한 메일은 같은 날 다시 실행하면 이어서 보낸다(이미 보낸 메일은 eventKey로 건너뜀).
    results.incomplete = results.deferred > 0;
    console.log('dailyOps: ' + JSON.stringify(results));
    return Object.assign({ ok: results.failed.length === 0, date: today }, results);
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

// 매월 1일 실행을 전제로 한다. 파기는 수행하지 않고 승인 대상만 피플팀에 보낸다.
function monthlyRetention() {
  const notifyEmail = getNotifyEmail_();
  if (!notifyEmail) {
    console.warn('monthlyRetention: Settings 시트의 notifyEmail이 비어 있어 실행하지 않았습니다.');
    return { ok: false, error: 'notify_email_not_configured' };
  }
  const guard = acquireOpsRunGuard_('monthlyRetention');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    return monthlyRetentionUnguarded_(notifyEmail);
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

function monthlyRetentionUnguarded_(notifyEmail) {
  const today = opsDateKey_(new Date());
  const retentionSetting = getFirstSettingValue_(['retentionMonths']);
  const retentionParsed = Number(retentionSetting);
  const retentionValid = Number.isFinite(retentionParsed) && retentionParsed >= 1;
  const retentionMonths = retentionValid ? Math.floor(retentionParsed) : 6;
  const warnings = retentionSetting && !retentionValid ? ['retention_months_invalid'] : [];
  if (warnings.length) console.warn('monthlyRetention: Settings 시트의 retentionMonths 값(' + retentionSetting + ')이 올바르지 않아 기본값 6개월을 사용했습니다.');
  const cutoff = new Date(today + 'T00:00:00+09:00');
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  const positions = readRowsIfSheetExists_('Positions');
  const positionMap = new Map(positions.map(row => [String(row.id), row]));
  const targets = readRowsIfSheetExists_('Candidates').filter(candidate => {
    const position = positionMap.get(String(candidate.posId));
    const retentionDate = candidate.rejectedAt || (position && position.status !== 'active' ? position.closedAt : '');
    const time = new Date(retentionDate).getTime();
    return Number.isFinite(time) && time < cutoff.getTime();
  });
  if (!targets.length) return { ok: true, targets: 0, sent: false, retentionMonths: retentionMonths, warnings: warnings };

  const eventKey = ['monthly', 'retention-approval', today].join(':');
  const lines = targets.map(candidate => '- ID ' + candidate.id + ' · ' + maskOpsName_(candidate.name) +
    ' · 기준일 ' + opsDateKey_(candidate.rejectedAt || (positionMap.get(String(candidate.posId)) || {}).closedAt));
  const message = [
    '개인정보 보존기간 ' + retentionMonths + '개월이 경과한 지원자 ' + targets.length + '명입니다.',
    '자동 파기는 수행하지 않았습니다. 대시보드에서 대상을 검토하고 승인 후 파기해 주세요.', '',
    lines.join('\n')
  ].join('\n');
  const send = sendOpsMailOnce_(eventKey, notifyEmail,
    '[채용시스템] 개인정보 파기 승인 대상 ' + targets.length + '명', message, opsPlainHtml_(message));
  return { ok: send.ok || send.skipped, targets: targets.length, sent: !!send.ok, skipped: !!send.skipped, deferred: !!send.deferred, error: send.error || '', retentionMonths: retentionMonths, warnings: warnings.concat(opsMailWarnings_()) };
}

function sendOpsMailOnce_(eventKey, to, subject, body, htmlBody) {
  if (mailEventAlreadySent_(eventKey)) return { ok: false, skipped: true };
  // 실행시간 제한(6분)에 강제로 끊기면 '보냈는데 기록 전'인 메일이 생겨 다시 실행할 때 중복될 수 있다.
  // 예산을 넘기면 더 보내지 않고 미룬다 — 같은 날 다시 실행하면 이어서 보낸다.
  if (opsTimeBudgetExceeded_()) return { ok: false, deferred: true };
  // 일일 발송 한도가 남지 않았으면 보내지 않고 미룬다(한도 초과 오류를 메일마다 쌓지 않는다).
  const quota = opsMailQuotaLeft_();
  if (quota !== null && quota <= 0) {
    EXEC_CACHE_.opsMailQuotaExhausted = true;
    return { ok: false, deferred: true };
  }
  const result = sendMailViaGmail_(to, subject, body, htmlBody, [], eventKey);
  if (result && result.ok) {
    opsSentEventKeys_().add(String(eventKey || ''));
    if (quota !== null) EXEC_CACHE_.opsMailQuota = quota - 1;
    // 보냈지만 MailLog에 못 남기면 다음 실행에서 같은 메일을 다시 보낼 수 있다 — 결과에 경고로 남긴다.
    if (result.logged === false) EXEC_CACHE_.opsMailLogFailed = true;
  }
  return result;
}

// 남은 일일 메일 발송 한도. 실행당 한 번 읽고 보낼 때마다 줄인다. 읽을 수 없으면 null(한도 확인 생략).
function opsMailQuotaLeft_() {
  if (EXEC_CACHE_.opsMailQuota === undefined) {
    try {
      const left = Number(MailApp.getRemainingDailyQuota());
      EXEC_CACHE_.opsMailQuota = Number.isFinite(left) ? left : null;
    } catch (err) {
      EXEC_CACHE_.opsMailQuota = null;
    }
  }
  return EXEC_CACHE_.opsMailQuota;
}

function opsMailWarnings_() {
  const warnings = [];
  if (EXEC_CACHE_.opsMailQuotaExhausted) warnings.push('mail_quota_exhausted');
  if (EXEC_CACHE_.opsMailLogFailed) warnings.push('mail_log_failed');
  return warnings;
}

// MailLog 전체는 실행당 한 번만 읽는다(메일마다 다시 읽으면 기록이 쌓일수록 실행시간 제한에 걸린다).
function mailEventAlreadySent_(eventKey) {
  return opsSentEventKeys_().has(String(eventKey || ''));
}

function opsSentEventKeys_() {
  if (!EXEC_CACHE_.opsSentEventKeys) {
    EXEC_CACHE_.opsSentEventKeys = new Set(readRowsIfSheetExists_('MailLog')
      .filter(row => row.eventKey && String(row.status || '').toLowerCase() === 'sent')
      .map(row => String(row.eventKey)));
  }
  return EXEC_CACHE_.opsSentEventKeys;
}

// 운영 작업 중복 실행 방지. 메일을 보내는 몇 분 동안 스크립트 잠금을 잡고 있으면 그 사이 담당자 저장이
// 잠금 대기로 실패하므로, 잠금은 실행 표시를 확인·기록하는 순간에만 잡는다. 실행시간 제한으로 끊겨
// 표시가 남아도 OPS_RUN_GUARD_SECONDS가 지나면 다시 실행할 수 있다(Script Properties는 쓰지 않는다).
const OPS_RUN_GUARD_SECONDS = 7 * 60;
const OPS_TIME_BUDGET_MS = 4.5 * 60 * 1000;

function acquireOpsRunGuard_(name) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return '';
  try {
    const cache = CacheService.getScriptCache();
    const key = 'ops_running:' + name;
    if (cache.get(key)) return '';
    cache.put(key, nowIso_(), OPS_RUN_GUARD_SECONDS);
    EXEC_CACHE_.opsStartedAt = Date.now();
    return key;
  } finally {
    lock.releaseLock();
  }
}

function releaseOpsRunGuard_(key) {
  if (key) CacheService.getScriptCache().remove(key);
}

function opsTimeBudgetExceeded_() {
  return !!EXEC_CACHE_.opsStartedAt && Date.now() - EXEC_CACHE_.opsStartedAt > OPS_TIME_BUDGET_MS;
}

function countOpsResult_(results, send, field, eventKey) {
  if (send && send.ok) results[field]++;
  else if (send && send.skipped) results.skipped++;
  else if (send && send.deferred) results.deferred++;
  else results.failed.push({ eventKey, error: send && send.error || 'mail_send_failed' });
}

// 리마인드 판정(dailyOps가 하루 한 번 호출):
// - overdue: 기한(지원자 등록 3일 / 추천인 응답 7일)이 지났는데 미완료 → 한 번만 발송
// - reminder-d3: 추천인은 응답 기한(7일) 중간인 발송 3일째에 미응답이면 중간 안내
// - expiry-d3: 링크 만료 3일 전 최종 안내
// deadlineAt이 없는 행(기한 도입 전 발급분)은 기한 기준이 없으므로 만료 3일 전 안내만 보낸다 —
// 배포 직후 기존 행 전체에 기한 초과 메일이 한꺼번에 나가지 않도록 하기 위함이다.
function referenceReminderKind_(row, today, isReferee) {
  if (opsDaysBetween_(today, opsDateKey_(row.tokenExpiresAt)) === 3) return 'expiry-d3';
  if (!row.deadlineAt) return '';
  const deadline = parseOpsDate_(row.deadlineAt);
  if (!Number.isFinite(deadline.getTime())) return '';
  if (deadline.getTime() <= Date.now()) return 'overdue';
  if (isReferee) {
    const issuedKey = opsDateKey_(addReferenceDays_(deadline, -REFERENCE_RESPONSE_DEADLINE_DAYS));
    if (opsDaysBetween_(issuedKey, today) === 3) return 'reminder-d3';
  }
  return '';
}

// overdue는 기한이 지난 뒤 매일 판정되므로 날짜 없는 키로 한 번만 발송되게 한다.
function referenceReminderEventKey_(scope, id, reminder, today) {
  return ['daily', scope, id, reminder].concat(reminder === 'overdue' ? [] : [today]).join(':');
}

// 메일에 안내할 기한 — 기한이 남아 있으면 그 기한, 이미 지났거나 기한 도입 전 행이면 링크 만료일.
function referenceDisplayDeadline_(row) {
  const deadline = row && row.deadlineAt ? parseOpsDate_(row.deadlineAt) : null;
  return deadline && deadline.getTime() > Date.now() ? row.deadlineAt : row.tokenExpiresAt;
}

function opsDateKey_(value) {
  const date = parseOpsDate_(value);
  if (!Number.isFinite(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy-MM-dd');
}

function opsDaysBetween_(fromKey, toKey) {
  if (!fromKey || !toKey) return NaN;
  const from = new Date(fromKey + 'T00:00:00+09:00').getTime();
  const to = new Date(toKey + 'T00:00:00+09:00').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function formatOpsDateTime_(value) {
  const date = parseOpsDate_(value);
  if (!Number.isFinite(date.getTime())) return String(value || '');
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy년 M월 d일 HH:mm');
}

function parseOpsDate_(value) {
  if (value instanceof Date) return value;
  const text = String(value || '').trim();
  if (!text) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(text)) {
    return new Date(text.replace(' ', 'T') + ':00+09:00');
  }
  // 시각 없는 날짜는 한국 시간 자정으로 읽는다(new Date('yyyy-MM-dd')는 UTC 자정이 된다).
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(text + 'T00:00:00+09:00');
  return new Date(text);
}

function isSheetTrue_(value) {
  return value === true || ['y', 'yes', 'true', '1'].includes(String(value || '').trim().toLowerCase());
}

function opsPlainHtml_(message) {
  return '<div style="font-family:Arial,sans-serif;line-height:1.7;white-space:pre-line">' +
    escapeMailHtml_(message) + '</div>';
}

function maskOpsName_(name) {
  const text = String(name || '').trim();
  if (text.length <= 1) return '*';
  if (text.length === 2) return text.charAt(0) + '*';
  return text.charAt(0) + '*'.repeat(text.length - 2) + text.charAt(text.length - 1);
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
  const token = String(payload.adminToken || payload.query && payload.query.adminToken || payload.data && payload.data.adminToken || '').trim();
  const configuredToken = getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  return !!configuredToken && token === configuredToken;
}

function getDeploymentConfigStatus_() {
  const role = getScriptProperty_(DEPLOYMENT_ROLE_PROPERTY).toLowerCase();
  const localUsersConfigured = Object.keys(getLocalAdminUsers_()).length > 0;
  const adminTokenConfigured = !!getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  const uploadFolderConfigured = !!getScriptProperty_(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY);
  const mainSpreadsheetConfigured = !!getScriptProperty_(RECRUITMENT_SPREADSHEET_URL_PROPERTY);
  const errors = [];
  const warnings = [];

  if (role === 'public') errors.push('관리자 프로젝트의 배포 역할이 public으로 설정되어 있습니다.');
  if (!localUsersConfigured) errors.push('앱 내부 관리자 계정이 설정되어 있지 않습니다.');
  if (!adminTokenConfigured) errors.push('관리자 내부 API 토큰이 설정되어 있지 않습니다.');
  if (!role) warnings.push('RECRUITMENT_DEPLOYMENT_ROLE이 비어 있습니다. admin 설정을 권장합니다.');
  else if (role !== 'admin' && role !== 'public') warnings.push('RECRUITMENT_DEPLOYMENT_ROLE 값이 올바르지 않습니다.');
  if (!uploadFolderConfigured) warnings.push('REFERRAL_UPLOAD_FOLDER_ID가 없어 이력서 업로드가 실패할 수 있습니다.');
  if (!mainSpreadsheetConfigured) warnings.push('RECRUITMENT_SPREADSHEET_URL이 없어 연결된 기본 시트를 사용합니다.');

  let deploymentParts = null;
  try { deploymentParts = checkDeploymentParts_(); } catch (err) { deploymentParts = { checked: false, reason: String(err && err.message || err) }; }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    deploymentParts: deploymentParts,
    checks: {
      roleConfigured: role === 'admin',
      adminAuthConfigured: localUsersConfigured && adminTokenConfigured,
      uploadFolderConfigured: uploadFolderConfigured,
      mainSpreadsheetConfigured: mainSpreadsheetConfigured
    }
  };
}

function getDeploymentConfigStatus() {
  return getDeploymentConfigStatus_();
}

// 배포 파일 짝 맞춤 점검: 일부 파일만 올려 서버 코드와 메일 양식·화면 파일의 버전이 섞이면
// "메일 양식을 만들지 못했습니다" 같은 오류가 원인을 알기 어렵게 난다. 빌드 때 만든 지문 목록
// (admin_98_build_manifest.gs의 BUILD_MANIFEST_)과 실제로 올라가 있는 함수·파일을 비교해 다른 파일을 알려 준다.
// 같은 빌드에서 한 번 맞으면 6시간 동안 다시 계산하지 않는다.
// 비교 방식이 이 환경에서 맞지 않아 전부 다르게 나오면(예: 함수 원문을 읽을 수 없음) 오류 대신 점검 불가로 둔다.
function checkDeploymentParts_() {
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  if (typeof BUILD_MANIFEST_ === 'undefined') {
    return { checked: false, reason: 'manifest_missing', files: ['admin_98_build_manifest.gs'] };
  }
  const manifest = BUILD_MANIFEST_;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'deployment_parts_ok:' + manifest.build;
  if (cache.get(cacheKey)) return { checked: true, ok: true, build: manifest.build, files: [] };

  const fingerprint = text => sha256Hex_(String(text).replace(/\s+/g, '')).slice(0, 12);
  const gsFiles = {};
  let fnTotal = 0;
  let fnMismatch = 0;
  Object.keys(manifest.functions || {}).forEach(function(name) {
    const file = manifest.functions[name][0];
    const expected = manifest.functions[name][1];
    fnTotal++;
    const fn = root[name];
    const actual = typeof fn === 'function' ? fingerprint(Function.prototype.toString.call(fn)) : '';
    if (actual !== expected) { fnMismatch++; gsFiles[file] = true; }
  });
  const htmlFiles = [];
  const htmlNames = Object.keys(manifest.html || {});
  htmlNames.forEach(function(name) {
    let content = null;
    try { content = HtmlService.createHtmlOutputFromFile(name).getContent(); } catch (err) {}
    if (content == null || fingerprint(content) !== manifest.html[name]) htmlFiles.push(name + '.html');
  });
  const gsUnreliable = fnTotal > 0 && fnMismatch === fnTotal;
  const htmlUnreliable = htmlNames.length > 0 && htmlFiles.length === htmlNames.length;
  const files = (gsUnreliable ? [] : Object.keys(gsFiles)).concat(htmlUnreliable ? [] : htmlFiles).sort();
  const result = {
    checked: !(gsUnreliable && htmlUnreliable),
    ok: files.length === 0,
    build: manifest.build,
    files: files,
    unreliable: gsUnreliable || htmlUnreliable
  };
  if (result.checked && result.ok && !result.unreliable) cache.put(cacheKey, '1', 6 * 60 * 60);
  return result;
}

// 읽기 전용 점검: 과거(순차 전형) 로직에서 저장된 레퍼런스(구) 단계 레코드가 몇 건
// 남아 있는지, 2차면접이 이미 진행된 건은 몇 건인지 등을 집계한다. 아무 것도 쓰지
// 않으며, 새 병행 전형 코드 배포 전에 실행해 이관 대상을 확인하는 용도다.
function getLegacyReferenceStageMigrationPreview_() {
  const candidates = readRows_('Candidates');
  const interviews = readRows_('Interviews');
  const positions = readRows_('Positions');
  const posById = {};
  positions.forEach(p => { posById[String(p.id)] = p; });

  const legacy = candidates.filter(c => String(c.stage) === '레퍼런스');
  const hasInterviewOfType = (candId, type) =>
    interviews.some(i => String(i.candId) === String(candId) && i.type === type);
  const hasDoneFirstInterview = candId =>
    interviews.some(i => String(i.candId) === String(candId) && i.type === '1차' && i.status === 'done');

  const refStatusBreakdown = {};
  const byPositionStatus = {};
  let withSecondInterviewRecord = 0;
  let withoutSecondInterviewRecord = 0;
  let missingFirstInterviewCompletion = 0;
  let lastCompletedStageMismatch = 0;
  let heldCount = 0;

  const details = legacy.map(c => {
    const ref = c.ref || '미시작';
    refStatusBreakdown[ref] = (refStatusBreakdown[ref] || 0) + 1;

    const pos = posById[String(c.posId)];
    const posStatus = pos ? (pos.status || '(미지정)') : '(포지션 없음)';
    byPositionStatus[posStatus] = (byPositionStatus[posStatus] || 0) + 1;

    const hasSecond = hasInterviewOfType(c.id, '2차');
    if (hasSecond) withSecondInterviewRecord++; else withoutSecondInterviewRecord++;

    const firstDone = hasDoneFirstInterview(c.id);
    if (!firstDone) missingFirstInterviewCompletion++;

    // 레퍼런스(2) 단계에 있다면 1차(1)를 완료하고 넘어온 것이 정상이다.
    // lastCompletedStage가 1이 아니면 과거 되돌리기 등으로 생긴 불일치일 수 있다.
    const lastCompletedRaw = c.lastCompletedStage;
    const lastCompleted = (lastCompletedRaw === '' || lastCompletedRaw == null) ? null : Number(lastCompletedRaw);
    if (lastCompleted !== 1) lastCompletedStageMismatch++;

    const isHeld = String(c.held) === 'Y';
    if (isHeld) heldCount++;

    return {
      id: c.id,
      name: c.name,
      posId: c.posId,
      positionTitle: pos ? pos.title : '(알 수 없음)',
      positionStatus: posStatus,
      held: isHeld,
      ref: ref,
      refProgress: `${Number(c.refD) || 0}/${Number(c.refT) || 0}`,
      hasSecondInterviewRecord: hasSecond,
      firstInterviewDone: firstDone,
      lastCompletedStage: lastCompleted,
    };
  });

  return {
    ok: true,
    generatedAt: nowIso_(),
    totalLegacyReferenceCandidates: legacy.length,
    withSecondInterviewRecord: withSecondInterviewRecord,
    withoutSecondInterviewRecord: withoutSecondInterviewRecord,
    refStatusBreakdown: refStatusBreakdown,
    missingFirstInterviewCompletion: missingFirstInterviewCompletion,
    lastCompletedStageMismatch: lastCompletedStageMismatch,
    heldCount: heldCount,
    byPositionStatus: byPositionStatus,
    candidates: details,
    note: '읽기 전용 미리보기입니다. 아무 것도 쓰지 않았습니다 — 실제 이관(stage를 2차면접으로 변경)은 별도로 실행하세요.'
  };
}

// Apps Script 편집기에서 함수를 직접 선택해 실행할 때 쓰는 공개 래퍼. 실행 로그(보기
// > 로그)에서 결과를 확인할 수 있다.
function getLegacyReferenceStageMigrationPreview() {
  const result = getLegacyReferenceStageMigrationPreview_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// 레퍼런스(구) 단계 레코드를 2차면접으로 이관한다 — stage 필드만 바꾸고, 메일 발송이나
// 다른 부수효과는 전혀 일으키지 않는다. 일정·레퍼런스 응답·보고서 등 다른 데이터는
// 그대로 둔다(preserveCompletedStage와 달리 면접 레코드를 만들거나 건드리지 않는다).
// 이미 2차면접으로 넘어간 레코드는 대상에서 빠지므로 여러 번 실행해도 안전하다(멱등).
function migrateLegacyReferenceStageToSecondInterview_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const candidates = readRows_('Candidates');
    const legacy = candidates.filter(c => String(c.stage) === '레퍼런스');
    const migrated = [];
    const failed = [];

    legacy.forEach(c => {
      const next = Object.assign({}, c);
      next.stage = '2차면접';
      // 레퍼런스 단계에 있었다면 1차는 완료된 것이 정상이다. 비어 있을 때만 채우고,
      // 이미 다른 값이 있으면(과거 되돌리기 등) 건드리지 않는다.
      if (next.lastCompletedStage === '' || next.lastCompletedStage == null) {
        next.lastCompletedStage = 1;
      }
      let parsed = null;
      try {
        const output = upsertUnlocked_('Candidates', next, true);
        parsed = JSON.parse(output.getContent());
      } catch (err) {
        parsed = { error: String(err && err.message || err) };
      }
      if (parsed && parsed.status === 'ok') {
        migrated.push({ id: c.id, name: c.name });
      } else {
        failed.push({ id: c.id, name: c.name, error: (parsed && parsed.error) || 'unknown_error' });
      }
    });

    return {
      ok: failed.length === 0,
      generatedAt: nowIso_(),
      migratedCount: migrated.length,
      failedCount: failed.length,
      migrated: migrated,
      failed: failed,
      note: '레퍼런스(구) 단계였던 지원자의 stage만 2차면접으로 변경했습니다. 일정·레퍼런스 응답·보고서는 그대로입니다.'
    };
  } finally {
    lock.releaseLock();
  }
}

// Apps Script 편집기용 공개 래퍼. 실행 전 반드시 getLegacyReferenceStageMigrationPreview()로
// 대상을 먼저 확인할 것.
function migrateLegacyReferenceStageToSecondInterview() {
  const result = migrateLegacyReferenceStageToSecondInterview_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
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

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function adminLogin_(payload) {
  const data = payload && payload.data || {};
  const loginId = String(data.loginId || data.empNo || data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!loginId || !password) return { ok: false, error: 'missing_credentials' };
  if (loginId !== 'admin' && !/^\d+$/.test(loginId)) return { ok: false, error: 'invalid_credentials' };
  if (isAdminLoginLocked_(loginId)) return { ok: false, error: 'login_locked' };

  const users = getLocalAdminUsers_();
  const expectedHash = users[loginId];
  const check = expectedHash ? verifyAdminPassword_(password, expectedHash) : { ok: false };
  if (!check.ok) {
    recordAdminLoginFailure_(loginId);
    return { ok: false, error: 'invalid_credentials' };
  }
  if (check.upgrade) upgradeAdminPasswordHash_(loginId, password);

  clearAdminLoginFailures_(loginId);
  purgeExpiredAdminSessions_();
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const ttl = getAdminSessionSeconds_();
  saveAdminSession_(token, { loginId, issuedAt: nowIso_(), expiresAt: Date.now() + ttl * 1000 }, ttl);
  return { ok: true, token, loginId, expiresIn: ttl };
}

function adminLogout_(payload) {
  const token = getAdminSessionTokenFromPayload_(payload);
  if (token) {
    CacheService.getScriptCache().remove(adminSessionKey_(token));
    PropertiesService.getScriptProperties().deleteProperty(adminSessionKey_(token));
  }
  return { ok: true };
}

// CacheService는 지정한 TTL 전에도 항목을 임의로 비울 수 있어(best effort) 세션 저장소로만
// 쓰면 로그인이 예고 없이 풀린다. ScriptProperties에 만료시각과 함께 원본을 두고, 캐시는
// 빠른 조회용으로만 쓴다.
function saveAdminSession_(token, session, ttl) {
  const raw = JSON.stringify(session);
  PropertiesService.getScriptProperties().setProperty(adminSessionKey_(token), raw);
  CacheService.getScriptCache().put(adminSessionKey_(token), raw, Math.min(ttl, 6 * 60 * 60));
}

function hasValidAdminSession_(token) {
  token = String(token || '').trim();
  if (!token) return false;
  try {
    const key = adminSessionKey_(token);
    const cached = CacheService.getScriptCache().get(key);
    const raw = cached || PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (!session || !session.loginId) return false;
    const ttl = getAdminSessionSeconds_();
    // 만료시각이 없는 이전 형식 세션은 캐시가 살아 있는 동안만 인정한다.
    const expiresAt = Number(session.expiresAt) || (cached ? Date.now() + ttl * 1000 : 0);
    if (expiresAt <= Date.now()) {
      CacheService.getScriptCache().remove(key);
      PropertiesService.getScriptProperties().deleteProperty(key);
      return false;
    }
    // 사용 중이면 연장한다(남은 시간이 절반 미만일 때만 기록해 쓰기 횟수를 줄인다).
    if (expiresAt - Date.now() < ttl * 500) {
      saveAdminSession_(token, Object.assign({}, session, { expiresAt: Date.now() + ttl * 1000 }), ttl);
    } else if (!cached) {
      CacheService.getScriptCache().put(key, raw, Math.max(60, Math.min(Math.floor((expiresAt - Date.now()) / 1000), 6 * 60 * 60)));
    }
    return true;
  } catch (err) {
    return false;
  }
}

function purgeExpiredAdminSessions_() {
  const store = PropertiesService.getScriptProperties();
  const all = store.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(key => {
    if (key.indexOf('admin_session:') !== 0) return;
    try {
      const session = JSON.parse(all[key] || 'null');
      if (!session || !(Number(session.expiresAt) > now)) store.deleteProperty(key);
    } catch (err) {
      store.deleteProperty(key);
    }
  });
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
    const loginId = String(text.slice(0, idx) || '').trim().toLowerCase();
    const hash = text.slice(idx + 1).trim().toLowerCase();
    const allowedId = loginId === 'admin' || /^\d+$/.test(loginId);
    if (allowedId && isAdminPasswordHashFormat_(hash)) users[loginId] = hash;
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

function adminLoginFailKey_(loginId) {
  return 'admin_login_fail:' + loginId;
}

function adminLoginLockKey_(loginId) {
  return 'admin_login_lock:' + loginId;
}

function isAdminLoginLocked_(loginId) {
  return !!CacheService.getScriptCache().get(adminLoginLockKey_(loginId));
}

function recordAdminLoginFailure_(loginId) {
  const cache = CacheService.getScriptCache();
  const key = adminLoginFailKey_(loginId);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= 5) {
    cache.put(adminLoginLockKey_(loginId), '1', 10 * 60);
    cache.remove(key);
  } else {
    cache.put(key, String(count), 10 * 60);
  }
}

function clearAdminLoginFailures_(loginId) {
  const cache = CacheService.getScriptCache();
  cache.remove(adminLoginFailKey_(loginId));
  cache.remove(adminLoginLockKey_(loginId));
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => {
      const normalized = byte < 0 ? byte + 256 : byte;
      return ('0' + normalized.toString(16)).slice(-2);
    })
    .join('');
}

// 관리자 비밀번호 해시: PBKDF2-HMAC-SHA256(계정마다 다른 솔트, 반복 계산) — 'v2$반복횟수$솔트$해시' 형식.
// 예전 형식(솔트 없는 SHA-256 64자리)도 로그인은 되며, 로그인에 성공하면 그 계정만 새 형식으로 바꿔 저장한다.
// 새 계정 해시는 Apps Script 편집기에서 makeAdminPasswordHash('비밀번호')를 실행해 만든다.
const ADMIN_PASSWORD_HASH_ITERATIONS = 2000;
const ADMIN_PASSWORD_HASH_V2_RE = /^v2\$(\d{1,6})\$([a-f0-9]{32,128})\$([a-f0-9]{64})$/;

function isAdminPasswordHashFormat_(hash) {
  return /^[a-f0-9]{64}$/.test(hash) || ADMIN_PASSWORD_HASH_V2_RE.test(hash);
}

function bytesToHex_(bytes) {
  return bytes.map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('');
}

function hexToBytes_(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const v = parseInt(hex.substr(i, 2), 16);
    out.push(v > 127 ? v - 256 : v);
  }
  return out;
}

// PBKDF2-HMAC-SHA256, 출력 32바이트(한 블록).
function pbkdf2Sha256Hex_(password, saltBytes, iterations) {
  const key = Utilities.newBlob(String(password)).getBytes();
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const acc = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < acc.length; j++) acc[j] ^= u[j];
  }
  return bytesToHex_(acc);
}

// 길이가 같으면 끝까지 비교한다(어디서 달라지는지 응답 시간으로 드러나지 않게).
function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyAdminPassword_(password, stored) {
  const m = ADMIN_PASSWORD_HASH_V2_RE.exec(String(stored || ''));
  if (m) {
    const ok = constantTimeEqual_(pbkdf2Sha256Hex_(password, hexToBytes_(m[2]), Number(m[1])), m[3]);
    return { ok: ok, upgrade: ok && Number(m[1]) < ADMIN_PASSWORD_HASH_ITERATIONS };
  }
  const ok = /^[a-f0-9]{64}$/.test(String(stored || '')) && constantTimeEqual_(sha256Hex_(password), stored);
  return { ok: ok, upgrade: ok };
}

function makeAdminPasswordHash(password) {
  const salt = hexToBytes_((Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32));
  return 'v2$' + ADMIN_PASSWORD_HASH_ITERATIONS + '$' + bytesToHex_(salt) + '$' + pbkdf2Sha256Hex_(password || '', salt, ADMIN_PASSWORD_HASH_ITERATIONS);
}

// 로그인에 성공한 계정의 해시만 새 형식으로 바꿔 저장한다. 다른 계정 줄은 그대로 둔다. 실패해도 로그인은 계속된다.
function upgradeAdminPasswordHash_(loginId, password) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = String(props.getProperty(LOCAL_ADMIN_USERS_PROPERTY) || '');
    let replaced = false;
    const entries = raw.split(/[,\n;]/).map(function(entry) { return String(entry || '').trim(); }).filter(Boolean).map(function(entry) {
      const idx = entry.indexOf(':');
      if (idx <= 0 || String(entry.slice(0, idx)).trim().toLowerCase() !== loginId) return entry;
      replaced = true;
      return entry.slice(0, idx).trim() + ':' + makeAdminPasswordHash(password);
    });
    if (replaced) props.setProperty(LOCAL_ADMIN_USERS_PROPERTY, entries.join('\n'));
  } catch (err) {
    console.warn('upgradeAdminPasswordHash_ failed: ' + String(err && err.message || err));
  } finally {
    lock.releaseLock();
  }
}

function adminApi(payload) {
  try {
    payload = payload || {};
    if (payload.action === 'adminLogin') return adminLogin_(payload);
    if (payload.action === 'adminLogout') return adminLogout_(payload);

    const hasSession = hasValidAdminSession_(getAdminSessionTokenFromPayload_(payload));
    if (!hasSession) {
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

