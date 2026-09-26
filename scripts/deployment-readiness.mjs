import fs from 'node:fs';

const checks = [
  {
    id: 'public-template-role',
    file: 'config/appsscript.public.json',
    pattern: /"access"\s*:\s*"ANYONE_ANONYMOUS"/,
    message: 'Public template must allow anonymous access for referral intake.',
  },
  {
    id: 'admin-template-anonymous-entry',
    file: 'config/appsscript.admin.json',
    pattern: /"access"\s*:\s*"ANYONE_ANONYMOUS"/,
    message: 'Admin template must allow the application login page without Google sign-in.',
  },
  {
    id: 'admin-template-user-deploying',
    file: 'config/appsscript.admin.json',
    pattern: /"executeAs"\s*:\s*"USER_DEPLOYING"/,
    message: 'Admin template must execute as the deploying user.',
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
