import fs from 'fs';
import path from 'path';
import {
  adminDistDir,
  adminGsSource,
  adminHtmlSource,
  adminIntermediateDir,
  configDir,
  mailTemplateFiles,
  mailTemplatePath,
  publicDistDir,
  publicGsSource,
  publicPagesDir,
  referenceDistDir,
  referralDistDir,
} from '../tools/project_paths.js';

const read = file => fs.readFileSync(file, 'utf8');
const errors = [];
const expectSame = (source, output) => {
  if (read(source) !== read(output)) errors.push(`${output} is stale relative to ${source}`);
};

const adminParts = [
  'admin_00_core.gs',
  'admin_01_mail_base.gs',
  'admin_02_sheet_api.gs',
  'admin_03_referral_public.gs',
  'admin_04_reference.gs',
  'admin_05_general_mail.gs',
  'admin_06_ai_referral_directory.gs',
  'admin_07_sheet_utils.gs',
  'admin_08_referral_tokens.gs',
  'admin_09_auth.gs',
  'admin_99_admin_api.gs',
];
if (adminParts.map(name => read(path.join(adminIntermediateDir, name))).join('') !== read(adminGsSource)) {
  errors.push('intermediate admin_*.gs files are stale relative to the admin backend source');
}

const dashboard = read(adminHtmlSource);
const styleMatch = dashboard.match(/<style[^>]*>[\s\S]*?<\/style>/);
const scriptMatch = dashboard.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);
const styleInner = styleMatch
  ? styleMatch[0].replace(/^<style[^>]*>\r?\n?/, '').replace(/\r?\n?<\/style>$/, '')
  : null;
const scriptInner = scriptMatch
  ? scriptMatch[0].replace(/^<script[^>]*>\r?\n?/, '').replace(/\r?\n?<\/script>$/, '')
  : null;

if (styleInner === null || styleInner !== read(path.join(adminIntermediateDir, 'app_css.html'))) {
  errors.push('intermediate app_css.html is stale relative to the admin frontend source');
}
if (!scriptMatch || scriptMatch[0] !== read(path.join(adminIntermediateDir, 'app_script.html'))) {
  errors.push('intermediate app_script.html is stale relative to the admin frontend source');
}

const jsParts = [
  'js_00_state.html',
  'js_02_sheets_sync.html',
  'js_03_positions.html',
  'js_05_interviews.html',
  'js_04_candidates.html',
  'js_08_dashboard.html',
  'js_07_referral.html',
  'js_04_candidates_flow.html',
  'js_05_interviews_manage.html',
  'js_06_reference.html',
  'js_08_onboarding_bulk.html',
  'js_09_settings.html',
  'js_99_app.html',
];
if (scriptInner === null || jsParts.map(name => read(path.join(adminIntermediateDir, name))).join('') !== scriptInner) {
  errors.push('intermediate js_*.html files are stale relative to the admin frontend source');
}

for (const name of ['Dashboard.html', 'app_css.html', 'app_script.html', ...adminParts]) {
  expectSame(path.join(adminIntermediateDir, name), path.join(adminDistDir, name));
}
expectSame(path.join(configDir, 'appsscript.admin.json'), path.join(adminDistDir, 'appsscript.json'));
for (const [group, name] of mailTemplateFiles) {
  expectSame(mailTemplatePath(group, name), path.join(adminDistDir, name));
}

expectSame(publicGsSource, path.join(publicDistDir, 'Code.gs'));
expectSame(path.join(configDir, 'appsscript.public.json'), path.join(publicDistDir, 'appsscript.json'));
expectSame(path.join(publicPagesDir, 'referral', 'index.html'), path.join(referralDistDir, 'index.html'));
for (const name of ['reference_candidate_intake.html', 'reference_check_intake.html', 'interview_availability.html']) {
  expectSame(path.join(publicPagesDir, 'reference-check', name), path.join(referenceDistDir, name));
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log('Source/build drift check passed.');
