import fs from 'node:fs';

const htmlFiles = [
  'recruitment_dashboard_v4.html',
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

const adminModuleFiles = [
  'src/admin/frontend/js/js_00_core.html',
  'src/admin/frontend/js/js_01_sheets_sync.html',
  'src/admin/frontend/js/js_02_positions_interviews.html',
  'src/admin/frontend/js/js_03_ui_dashboard.html',
  'src/admin/frontend/js/js_04_referral.html',
  'src/admin/frontend/js/js_05_candidates_reference.html',
  'src/admin/frontend/js/js_06_onboarding_settings.html',
  'src/admin/frontend/js/js_99_app.html',
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

const adminModuleSources = adminModuleFiles.map(file => {
  const source = fs.readFileSync(file, 'utf8');
  new Function(source);
  return source;
});
new Function(adminModuleSources.join(''));
console.log(`Admin frontend modules syntax OK (${adminModuleFiles.length} files)`);
