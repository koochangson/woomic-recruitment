import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const codePath = path.join(root, 'Code_admin_gmail.gs');

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
  const html = fs.readFileSync(path.join(root, name + '.html'), 'utf8');
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
console.log('Code_admin_gmail.gs inline mail fragments synced');
