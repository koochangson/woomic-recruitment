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

