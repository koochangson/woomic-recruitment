import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'backups', 'backup_2026-08-27']);
const targetExts = new Set(['.html', '.js', '.gs', '.json', '.md']);

const rules = [
  {
    id: 'known-leaked-admin-token',
    pattern: /woomic-ats-admin-20260731-v1-change-this/,
    message: 'Known leaked admin token must not appear in source.',
  },
  {
    id: 'master-test-otp',
    pattern: /MASTER_TEST_OTP_CODE|000000.*OTP|OTP.*000000/,
    message: 'Test/master OTP bypass must not appear in source.',
  },
  {
    id: 'admin-token-query',
    pattern: /url\.searchParams\.set\(['"]adminToken['"]/,
    message: 'adminToken must not be sent as a URL query parameter from browser code.',
  },
  {
    id: 'browser-openai-direct-call',
    pattern: /https:\/\/api\.openai\.com\/v1\/chat\/completions|Authorization['"]?\s*:\s*`?Bearer/,
    message: 'OpenAI API calls must not be made directly from browser HTML.',
    appliesTo: file => file.endsWith('.html'),
  },
  {
    id: 'browser-openai-key-setting',
    pattern: /openaiKey\s*:|set\(['"]cfg-openai-key['"]\s*,\s*(cfg|gsCfg)\.openaiKey/,
    message: 'OpenAI API keys must not be collected or restored as browser settings.',
    appliesTo: file => file.endsWith('.html'),
  },
  {
    id: 'admin-script-url-hardcoded',
    pattern: /(scriptUrl|interviewerUrl|refAutoUrl|referralScriptUrl)\s*:\s*['"]https:\/\/script\.google\.com\/macros\/s\//,
    message: 'Admin dashboard must not hardcode Apps Script deployment URLs.',
    appliesTo: file => /recruitment_dashboard|새 폴더[\\/]index\.html$/.test(file),
  },
];

const requiredPatterns = [
  {
    id: 'uploaded-file-sharing-hardened',
    file: 'src/public/backend/Code.gs',
    pattern: /hardenUploadedFileSharing_\(\s*file\s*\)/,
    message: 'Referral file uploads must harden Drive file sharing after creation.',
  },
  {
    id: 'legacy-browser-secret-scrub',
    file: 'recruitment_dashboard_v4.html',
    pattern: /function\s+scrubLegacyBrowserSecrets\(/,
    message: 'Dashboard must scrub legacy browser-stored secrets.',
  },
  {
    id: 'deployment-role-gate',
    file: 'src/public/backend/Code.gs',
    pattern: /isPublicDeployment_\(\)\s*&&\s*isAdminRequest_|!\s*isPublicDeployment_\(\)\s*&&\s*isAdminRequest_/,
    message: 'Apps Script must gate admin actions by deployment role.',
  },
  {
    id: 'public-admin-action-hard-gate',
    file: 'src/public/backend/Code.gs',
    pattern: /isPublicDeployment_\(\)\s*&&\s*PUBLIC_BLOCKED_ADMIN_ACTIONS\[action\]/,
    message: 'Public Apps Script must reject privileged actions before dispatch.',
  },
  {
    id: 'public-referee-verification-rate-limit',
    file: 'src/public/backend/Code.gs',
    pattern: /isRefereeVerifyLocked_\(token\)[\s\S]{0,120}too_many_attempts/,
    message: 'Public Apps Script must rate-limit referee identity verification.',
  },
  {
    id: 'admin-referral-upload-folder-property',
    file: 'src/admin/backend/Code.gs',
    pattern: /getScriptProperty_\(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY\)/,
    message: 'Admin Apps Script must read the referral upload folder from Script Properties.',
  },
  {
    id: 'public-referral-upload-folder-property',
    file: 'src/public/backend/Code.gs',
    pattern: /getScriptProperty_\(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY\)/,
    message: 'Public Apps Script must read the referral upload folder from Script Properties.',
  },
  {
    id: 'public-mail-send-logging',
    file: 'src/public/backend/Code.gs',
    pattern: /function sendLoggedMail_\([\s\S]{0,500}logMailSend_\(to, subject, 'sent'/,
    message: 'Public Apps Script must log successful and failed mail sends.',
  },
  {
    id: 'admin-reference-link-reissue-invalidates-old-token',
    file: 'src/admin/backend/Code.gs',
    pattern: /invalidatePriorReferenceCandidateLinks_\(sheet, headers, pipelineCandId, candEmail\)/,
    message: 'Admin Apps Script must invalidate prior candidate reference links before reissue.',
  },
  {
    id: 'public-reference-link-reissue-invalidates-old-token',
    file: 'src/public/backend/Code.gs',
    pattern: /invalidatePriorReferenceCandidateLinks_\(sheet, headers, pipelineCandId, candEmail\)/,
    message: 'Public Apps Script must invalidate prior candidate reference links before reissue.',
  },
  {
    id: 'admin-reference-public-writes-locked',
    file: 'src/admin/backend/Code.gs',
    pattern: /function submitReferenceCandidateReferees_\([\s\S]{0,260}submitReferenceCandidateRefereesUnlocked_[\s\S]*function submitReferenceResponse_\([\s\S]{0,260}submitReferenceResponseUnlocked_/,
    message: 'Admin Apps Script must serialize public reference submissions.',
  },
  {
    id: 'public-reference-public-writes-locked',
    file: 'src/public/backend/Code.gs',
    pattern: /function submitReferenceCandidateReferees_\([\s\S]{0,260}submitReferenceCandidateRefereesUnlocked_[\s\S]*function submitReferenceResponse_\([\s\S]{0,260}submitReferenceResponseUnlocked_/,
    message: 'Public Apps Script must serialize public reference submissions.',
  },
  {
    id: 'admin-batch-upsert-uses-indexed-write',
    file: 'src/admin/backend/Code.gs',
    pattern: /function batchUpsert_\([\s\S]{0,900}rowIndexById[\s\S]{0,4000}appendChanges_\(changes\)/,
    message: 'Admin batch upsert must use one indexed sheet read and batched change logging.',
  },
  {
    id: 'public-batch-upsert-uses-indexed-write',
    file: 'src/public/backend/Code.gs',
    pattern: /function batchUpsert_\([\s\S]{0,900}rowIndexById[\s\S]{0,4000}appendChanges_\(changes\)/,
    message: 'Public batch upsert must use one indexed sheet read and batched change logging.',
  },
  {
    id: 'admin-change-cursor-is-monotonic',
    file: 'src/admin/backend/Code.gs',
    pattern: /CHANGE_CURSOR_PROPERTY[\s\S]*reserveChangeCursors_\(sheet, source\.length\)[\s\S]*Number\(row\[0\]\) > requestedCursor/,
    message: 'Admin change cursors must be property-backed and read by cursor value rather than row position.',
  },
  {
    id: 'public-change-cursor-is-monotonic',
    file: 'src/public/backend/Code.gs',
    pattern: /CHANGE_CURSOR_PROPERTY[\s\S]*reserveChangeCursors_\(sheet, source\.length\)[\s\S]*Number\(row\[0\]\) > requestedCursor/,
    message: 'Public change cursors must be property-backed and read by cursor value rather than row position.',
  },
  {
    id: 'admin-core-writes-use-revisions',
    file: 'src/admin/backend/Code.gs',
    pattern: /REVISIONED_SHEETS[\s\S]*revisionState_\(sheetName, headers, existingValues, source\)[\s\S]*revision_conflict[\s\S]*source\.rev = revision\.current \+ 1/,
    message: 'Admin core writes must reject stale revisions and increment the server revision.',
  },
  {
    id: 'public-core-writes-use-revisions',
    file: 'src/public/backend/Code.gs',
    pattern: /REVISIONED_SHEETS[\s\S]*revisionState_\(sheetName, headers, existingValues, source\)[\s\S]*revision_conflict[\s\S]*source\.rev = revision\.current \+ 1/,
    message: 'Public core writes must reject stale revisions and increment the server revision.',
  },
  {
    id: 'dashboard-surfaces-revision-conflicts',
    file: 'src/admin/frontend/js/js_01_sheets_sync.html',
    pattern: /result\?\.error === 'revision_conflict'[\s\S]*showRevisionConflict_\(sheet, result\)/,
    message: 'Dashboard writes must surface revision conflicts without retrying stale data.',
  },
  {
    id: 'dashboard-polls-change-log',
    file: 'src/admin/frontend/js/js_01_sheets_sync.html',
    pattern: /GS_CHANGE_POLL_INTERVAL_MS = 60 \* 1000[\s\S]*document\.hidden[\s\S]*setInterval\(pollGsChanges_, GS_CHANGE_POLL_INTERVAL_MS\)[\s\S]*visibilitychange/,
    message: 'Dashboard must poll incremental changes only while the page is visible.',
  },
  {
    id: 'dashboard-starts-change-polling',
    file: 'src/admin/frontend/js/js_99_app.html',
    pattern: /setTimeout\(flushGsRetryQueue, 1500\);[\s\S]{0,120}startGsChangePolling_\(\)/,
    message: 'Dashboard initialization must start periodic change polling.',
  },
  {
    id: 'delegated-call-runtime-failures-visible',
    file: 'src/admin/frontend/js/js_99_app.html',
    pattern: /reportDelegatedCallFailure_\('unregistered_function'[\s\S]*reportDelegatedCallFailure_\('unsupported_argument'[\s\S]*reportDelegatedCallFailure_\('execution_failed'/,
    message: 'Delegated UI calls must report registration, argument, and execution failures.',
  },
  {
    id: 'delegated-calls-validated-at-build',
    file: 'tools/prepare_admin_frontend.js',
    pattern: /missingDelegatedCalls[\s\S]*Unregistered delegated calls/,
    message: 'Admin frontend builds must reject unregistered delegated calls.',
  },
  {
    id: 'interview-results-use-explicit-options',
    file: 'src/admin/frontend/js/js_05_candidates_reference.html',
    pattern: /function saveIntResult\([\s\S]{0,900}!\['합격','불합격'\]\.includes\(result\)[\s\S]{0,500}syncIntToGS\(itv\)/,
    message: 'Individual interview results must allow only pass/fail and synchronize the saved result.',
  },
  {
    id: 'referral-render-does-not-persist-derived-state',
    file: 'src/admin/frontend/js/js_04_referral.html',
    pattern: /function renderReferralSection\(\)\s*\{\s*recalculateReferralFlags\(\{transient:true\}\);/,
    message: 'Referral rendering must not persist derived flags or timestamps.',
  },
  {
    id: 'reference-mail-template-type-required',
    file: 'src/admin/backend/Code.gs',
    pattern: /REFERENCE_MAIL_TEMPLATE_FILES\[templateType\][\s\S]{0,100}reference_template_type_required/,
    message: 'Reference mail sends must require an explicit template type.',
  },
  {
    id: 'reference-mail-unresolved-placeholders-rejected',
    file: 'src/admin/backend/Code.gs',
    pattern: /unresolved_reference_mail_placeholder/,
    message: 'Reference mail rendering must reject unresolved placeholders.',
  },
  {
    id: 'reference-candidate-request-placeholders',
    file: 'templates/mail/reference/mail_01_reference_candidate_request.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{deadlineText\}\}[\s\S]*\{\{actionUrl\}\}/,
    message: 'Candidate request mail must use explicit name, position, deadline, and action URL placeholders.',
  },
  {
    id: 'reference-candidate-reminder-placeholders',
    file: 'templates/mail/reference/mail_02_reference_candidate_reminder.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{deadlineText\}\}[\s\S]*\{\{actionUrl\}\}/,
    message: 'Candidate reminder mail must use explicit name, deadline, and action URL placeholders.',
  },
  {
    id: 'reference-referee-request-placeholders',
    file: 'templates/mail/reference/mail_03_reference_referee_request.html',
    pattern: /\{\{refereeName\}\}[\s\S]*\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{deadlineText\}\}[\s\S]*\{\{actionUrl\}\}/,
    message: 'Referee request mail must use explicit recipient, candidate, position, deadline, and action URL placeholders.',
  },
  {
    id: 'reference-referee-reminder-placeholders',
    file: 'templates/mail/reference/mail_04_reference_referee_reminder.html',
    pattern: /\{\{refereeName\}\}[\s\S]*\{\{candidateName\}\}[\s\S]*\{\{deadlineText\}\}[\s\S]*\{\{actionUrl\}\}/,
    message: 'Referee reminder mail must use explicit recipient, candidate, deadline, and action URL placeholders.',
  },
  {
    id: 'reference-referee-complete-placeholders',
    file: 'templates/mail/reference/mail_05_reference_referee_complete.html',
    pattern: /\{\{refereeName\}\}[\s\S]*\{\{candidateName\}\}[\s\S]*\{\{submittedText\}\}/,
    message: 'Referee completion mail must use explicit recipient, candidate, and submitted time placeholders.',
  },
  {
    id: 'general-mail-unresolved-placeholders-rejected',
    file: 'src/admin/backend/Code.gs',
    pattern: /unresolved_general_mail_placeholder/,
    message: 'Converted general mail templates must reject unresolved placeholders.',
  },
  {
    id: 'first-interview-mail-placeholders',
    file: 'templates/mail/body/mail_body_interview_first.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{interviewDateTime\}\}[\s\S]*\{\{location\}\}/,
    message: 'First interview mail must use explicit candidate, position, date, and location placeholders.',
  },
  {
    id: 'second-interview-mail-placeholders',
    file: 'templates/mail/body/mail_body_interview_second.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{interviewDateTime\}\}[\s\S]*\{\{location\}\}/,
    message: 'Second interview mail must use explicit candidate, position, date, and location placeholders.',
  },
  {
    id: 'interview-slot-mail-placeholders',
    file: 'templates/mail/body/mail_body_interview_slot_request.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{interviewType\}\}[\s\S]*\{\{slotOptions\}\}[\s\S]*\{\{responseDeadline\}\}[\s\S]*\{\{availabilityLink\}\}/,
    message: 'Interview slot mail must use explicit schedule, deadline, and response link placeholders.',
  },
  {
    id: 'rejection-mail-placeholders',
    file: 'templates/mail/body/mail_body_rejection.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}/,
    message: 'Rejection mail must use explicit candidate and position placeholders.',
  },
  {
    id: 'panel-schedule-mail-placeholders',
    file: 'templates/mail/body/mail_body_panel_schedule.html',
    pattern: /\{\{dept\}\}[\s\S]*\{\{interviewType\}\}[\s\S]*\{\{scheduleText\}\}[\s\S]*\{\{location\}\}[\s\S]*\{\{targetCount\}\}[\s\S]*\{\{panelNames\}\}[\s\S]*\{\{targetList\}\}/,
    message: 'Panel schedule mail must use explicit schedule, panel, and candidate placeholders.',
  },
  {
    id: 'onboarding-mail-placeholders',
    file: 'templates/mail/body/mail_body_onboarding.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{joinDate\}\}[\s\S]*\{\{joinTime\}\}[\s\S]*\{\{reportLocation\}\}[\s\S]*\{\{prepNotes\}\}/,
    message: 'Candidate onboarding mail must use explicit candidate and joining placeholders.',
  },
  {
    id: 'internal-onboarding-mail-placeholders',
    file: 'templates/mail/body/mail_body_onboarding_internal.html',
    pattern: /\{\{joinDate\}\}[\s\S]*\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{phone\}\}[\s\S]*\{\{replyDeadline\}\}[\s\S]*\{\{deptCooperation\}\}/,
    message: 'Internal onboarding mail must use explicit candidate, deadline, and cooperation placeholders.',
  },
  {
    id: 'headhunter-forward-mail-placeholders',
    file: 'templates/mail/body/mail_body_headhunter_forward.html',
    pattern: /\{\{recipientName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{candidateName\}\}[\s\S]*\{\{purpose\}\}[\s\S]*\{\{forwardBody\}\}/,
    message: 'Headhunter forwarding mail must use explicit recipient, candidate, purpose, and body placeholders.',
  },
  {
    id: 'general-notice-mail-placeholders',
    file: 'templates/mail/body/mail_body_general_notice.html',
    pattern: /\{\{candidateName\}\}[\s\S]*\{\{positionText\}\}[\s\S]*\{\{noticeBody\}\}/,
    message: 'General notice mail must use explicit recipient, position, and notice placeholders.',
  },
  {
    id: 'admin-date-normalization-utc',
    file: 'src/admin/backend/Code.gs',
    pattern: /Utilities\.formatDate\(value,\s*['"]UTC['"],\s*"yyyy-MM-dd'T'HH:mm:ss\.SSS'Z'"\)/,
    message: 'Admin Apps Script Date values must be normalized as real UTC timestamps.',
  },
  {
    id: 'public-date-normalization-utc',
    file: 'src/public/backend/Code.gs',
    pattern: /Utilities\.formatDate\(value,\s*['"]UTC['"],\s*"yyyy-MM-dd'T'HH:mm:ss\.SSS'Z'"\)/,
    message: 'Public Apps Script Date values must be normalized as real UTC timestamps.',
  },
  {
    id: 'public-clasp-target-required',
    file: 'tools/sync_public_clasp.js',
    pattern: /if \(!targetArg \|\| !targetArg\.slice\('--target='\.length\)\.trim\(\)\)[\s\S]{0,180}process\.exit\(1\)/,
    message: 'Public clasp synchronization must require an explicit target folder.',
  },
  {
    id: 'public-clasp-rejects-admin-project',
    file: 'tools/sync_public_clasp.js',
    pattern: /publicScriptId === adminScriptId[\s\S]{0,180}Refusing public synchronization/,
    message: 'Public clasp synchronization must reject the connected admin Apps Script project.',
  },
  {
    id: 'public-clasp-validates-webapp-policy',
    file: 'tools/sync_public_clasp.js',
    pattern: /webapp\?\.executeAs !== 'USER_DEPLOYING'[\s\S]{0,160}webapp\?\.access !== 'ANYONE_ANONYMOUS'/,
    message: 'Public clasp synchronization must validate anonymous web-app manifest settings.',
  },
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (targetExts.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const findings = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of rules) {
    if (rule.appliesTo && !rule.appliesTo(rel)) continue;
    const match = text.match(rule.pattern);
    if (!match) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    findings.push({ rule: rule.id, file: rel, line, message: rule.message });
  }
}

for (const rule of requiredPatterns) {
  const file = path.join(root, rule.file);
  if (!fs.existsSync(file) || !rule.pattern.test(fs.readFileSync(file, 'utf8'))) {
    findings.push({ rule: rule.id, file: rule.file, line: 1, message: rule.message });
  }
}

if (findings.length) {
  console.error('Security scan failed:');
  for (const item of findings) {
    console.error(`- ${item.rule}: ${item.file}:${item.line} - ${item.message}`);
  }
  process.exit(1);
}

console.log('Security scan passed.');
