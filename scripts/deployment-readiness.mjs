import fs from 'node:fs';

const checks = [
  {
    id: 'public-template-role',
    file: 'appsscript.public.template.json',
    pattern: /"access"\s*:\s*"ANYONE_ANONYMOUS"/,
    message: 'Public template must allow anonymous access for referral intake.',
  },
  {
    id: 'admin-template-domain',
    file: 'appsscript.admin.template.json',
    pattern: /"access"\s*:\s*"DOMAIN"/,
    message: 'Admin template must use DOMAIN access.',
  },
  {
    id: 'admin-template-user-accessing',
    file: 'appsscript.admin.template.json',
    pattern: /"executeAs"\s*:\s*"USER_ACCESSING"/,
    message: 'Admin template must execute as the accessing user.',
  },
  {
    id: 'deployment-steps-exist',
    file: 'SECURITY_DEPLOYMENT_STEPS.md',
    pattern: /RECRUITMENT_DEPLOYMENT_ROLE/,
    message: 'Deployment steps must document deployment role properties.',
  },
  {
    id: 'runbook-exists',
    file: 'SECURITY_RUNBOOK.md',
    pattern: /비밀값 유출 의심 시/,
    message: 'Security runbook must exist.',
  },
  {
    id: 'github-workflow-exists',
    file: '.github/workflows/security-checks.yml',
    pattern: /npm run check/,
    message: 'GitHub security workflow must run npm run check.',
  },
  {
    id: 'codeowners-exists',
    file: '.github/CODEOWNERS',
    pattern: /recruiting-admins/,
    message: 'CODEOWNERS must be configured for recruiting admins.',
  },
];

const failures = [];

for (const check of checks) {
  if (!fs.existsSync(check.file)) {
    failures.push(`${check.id}: missing ${check.file}`);
    continue;
  }
  const text = fs.readFileSync(check.file, 'utf8');
  if (!check.pattern.test(text)) failures.push(`${check.id}: ${check.message}`);
}

if (failures.length) {
  console.error('Deployment readiness failed:');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}

console.log('Deployment readiness checks passed.');
