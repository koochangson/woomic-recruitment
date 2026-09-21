import fs from 'fs';
import { adminGsSource, mailTemplateFiles, mailTemplatePath } from './project_paths.js';

const codePath = adminGsSource;
const templatePaths = new Map(mailTemplateFiles.map(([group, name]) => [name, mailTemplatePath(group, name)]));

let code = fs.readFileSync(codePath, 'utf8');

const fragments = [
  'mail_shared_header_top',
  'mail_shared_header_bottom',
  'mail_shared_body_open',
  'mail_shared_body_close',
  'mail_shared_contact_qr',
  'mail_shared_footer',
  'mail_body_interview_first',
  'mail_body_interview_second',
  'mail_body_interview_slot_request',
  'mail_body_panel_schedule',
  'mail_body_onboarding',
  'mail_body_onboarding_internal',
  'mail_body_rejection',
  'mail_body_headhunter_forward',
  'mail_body_general_notice'
];

function syncFragment(name) {
  const html = fs.readFileSync(templatePaths.get(name + '.html'), 'utf8');
  const nextIndex = fragments.indexOf(name) + 1;
  const nextName = fragments[nextIndex];
  const pattern = nextName
    ? new RegExp('  "' + name + '": [\\s\\S]*?,\\r?\\n  "' + nextName + '"')
    : new RegExp('  "' + name + '": [\\s\\S]*?\\r?\\n};');
  if (!pattern.test(code)) {
    throw new Error(name + ' inline fragment not found');
  }
  code = nextName
    ? code.replace(pattern, '  "' + name + '": ' + JSON.stringify(html) + ',\n  "' + nextName + '"')
    : code.replace(pattern, '  "' + name + '": ' + JSON.stringify(html) + '\n};');
}

fragments.forEach(syncFragment);

fs.writeFileSync(codePath, code, 'utf8');
console.log('Admin backend inline mail fragments synced');
