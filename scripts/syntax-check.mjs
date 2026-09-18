import fs from 'node:fs';

const htmlFiles = [
  'recruitment_dashboard_v4.html',
  'referral_intake.html',
  'index.html',
  '새 폴더/index.html',
];

const scriptFiles = [
  'apps_script_referral_security.gs',
  'interviewer_db_apps_script_updated.gs',
];

for (const file of htmlFiles) {
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .join('\n');
  new Function(scripts);
  console.log(`${file} JS syntax OK`);
}

for (const file of scriptFiles) {
  if (!fs.existsSync(file)) continue;
  new Function(fs.readFileSync(file, 'utf8'));
  console.log(`${file} syntax OK`);
}
