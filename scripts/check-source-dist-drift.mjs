import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const errors = [];

function expectSame(sourceName, outputName) {
  if (read(sourceName) !== read(outputName)) {
    errors.push(`${outputName} is stale relative to ${sourceName}`);
  }
}

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

if (adminParts.map(read).join('') !== read('Code_admin_gmail.gs')) {
  errors.push('admin_*.gs files are stale relative to Code_admin_gmail.gs');
}

const dashboard = read('Dashboard_gmail.html');
const styleMatch = dashboard.match(/<style[^>]*>[\s\S]*?<\/style>/);
const scriptMatch = dashboard.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);
const styleInner = styleMatch
  ? styleMatch[0]
    .replace(/^<style[^>]*>\r?\n?/, '')
    .replace(/\r?\n?<\/style>$/, '')
  : null;
if (styleInner === null || styleInner !== read('app_css.html')) {
  errors.push('app_css.html is stale relative to Dashboard_gmail.html');
}
if (!scriptMatch || scriptMatch[0] !== read('app_script.html')) {
  errors.push('app_script.html is stale relative to Dashboard_gmail.html');
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
const scriptInner = scriptMatch
  ? scriptMatch[0]
    .replace(/^<script[^>]*>\r?\n?/, '')
    .replace(/\r?\n?<\/script>$/, '')
  : null;
if (scriptInner === null || jsParts.map(read).join('') !== scriptInner) {
  errors.push('js_*.html files are stale relative to Dashboard_gmail.html');
}

expectSame('Dashboard_gmail_split.html', 'apps_script_split_upload/Dashboard.html');
for (const name of adminParts) expectSame(name, `apps_script_split_upload/${name}`);
expectSame('app_css.html', 'apps_script_split_upload/app_css.html');
expectSame('app_script.html', 'apps_script_split_upload/app_script.html');
expectSame('appsscript.admin.template.json', 'apps_script_split_upload/appsscript.json');
for (const name of fs.readdirSync(root).filter(name => /^mail_(?:\d{2}|body|shared|asset)_.*\.html$/.test(name))) {
  expectSame(name, `apps_script_split_upload/${name}`);
}
expectSame('apps_script_referral_security.gs', 'apps_script_public_upload/Code.gs');
expectSame('appsscript.public.template.json', 'apps_script_public_upload/appsscript.json');
expectSame('referral_intake.html', 'index.html');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log('Source/build drift check passed.');
