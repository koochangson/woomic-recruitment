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
    pattern: /function batchUpsert_\([\s\S]{0,900}rowIndexById[\s\S]{0,1800}appendChanges_\(changes\)/,
    message: 'Admin batch upsert must use one indexed sheet read and batched change logging.',
  },
  {
    id: 'public-batch-upsert-uses-indexed-write',
    file: 'src/public/backend/Code.gs',
    pattern: /function batchUpsert_\([\s\S]{0,900}rowIndexById[\s\S]{0,1800}appendChanges_\(changes\)/,
    message: 'Public batch upsert must use one indexed sheet read and batched change logging.',
  },
  {
    id: 'referral-render-does-not-persist-derived-state',
    file: 'src/admin/frontend/js/js_04_referral.html',
    pattern: /function renderReferralSection\(\)\s*\{\s*recalculateReferralFlags\(\{transient:true\}\);/,
    message: 'Referral rendering must not persist derived flags or timestamps.',
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
