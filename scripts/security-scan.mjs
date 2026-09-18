import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules']);
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
    file: 'apps_script_referral_security.gs',
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
    file: 'apps_script_referral_security.gs',
    pattern: /isPublicDeployment_\(\)\s*&&\s*isAdminRequest_|!\s*isPublicDeployment_\(\)\s*&&\s*isAdminRequest_/,
    message: 'Apps Script must gate admin actions by deployment role.',
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
