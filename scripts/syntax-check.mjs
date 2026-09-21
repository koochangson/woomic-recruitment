import fs from 'node:fs';

const htmlFiles = [
  'recruitment_dashboard_v4.html',
  'src/admin/frontend/Dashboard.html',
  'src/public/pages/referral/index.html',
  'src/public/pages/reference-check/reference_candidate_intake.html',
  'src/public/pages/reference-check/reference_check_intake.html',
  'src/public/pages/reference-check/interview_availability.html',
  '새 폴더/index.html',
];

const scriptFiles = [
  'src/admin/backend/Code.gs',
  'src/public/backend/Code.gs',
  'src/integrations/interviewer-directory/Code.gs',
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
