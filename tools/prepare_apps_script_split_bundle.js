import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'apps_script_split_upload');

const files = [
  ['appsscript.admin.template.json', 'appsscript.json'],

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

  ['Dashboard_gmail_split.html', 'Dashboard.html'],
  'app_css.html',
  'app_script.html',
  'js_00_state.html',
  'js_02_sheets_sync.html',
  'js_03_positions.html',
  'js_04_candidates.html',
  'js_04_candidates_flow.html',
  'js_05_interviews.html',
  'js_05_interviews_manage.html',
  'js_06_reference.html',
  'js_07_referral.html',
  'js_08_dashboard.html',
  'js_08_onboarding_bulk.html',
  'js_09_settings.html',
  'js_99_app.html',

  'mail_01_reference_candidate_request.html',
  'mail_02_reference_candidate_reminder.html',
  'mail_03_reference_referee_request.html',
  'mail_04_reference_referee_reminder.html',
  'mail_05_reference_referee_complete.html',
  'mail_asset_ci_src.html',
  'mail_asset_header_art_src.html',
  'mail_body_general_notice.html',
  'mail_body_headhunter_forward.html',
  'mail_body_interview_first.html',
  'mail_body_interview_second.html',
  'mail_body_interview_slot_request.html',
  'mail_body_onboarding.html',
  'mail_body_onboarding_internal.html',
  'mail_body_panel_schedule.html',
  'mail_body_rejection.html',
  'mail_shared_body_close.html',
  'mail_shared_body_open.html',
  'mail_shared_contact_qr.html',
  'mail_shared_footer.html',
  'mail_shared_header_bottom.html',
  'mail_shared_header_top.html',
];

fs.mkdirSync(outDir, { recursive: true });
['Dashboard_gmail_split.html'].forEach(name => {
  const stalePath = path.join(outDir, name);
  if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
});

const copied = [];
for (const item of files) {
  const [srcName, destName] = Array.isArray(item) ? item : [item, item];
  const src = path.join(root, srcName);
  const dest = path.join(outDir, destName);
  if (!fs.existsSync(src)) throw new Error(`missing required file: ${srcName}`);
  fs.copyFileSync(src, dest);
  copied.push(destName);
}

const readme = `# Apps Script Split Upload Set

이 폴더는 Apps Script 관리자 웹앱 반영용 파일 세트입니다.

## 넣는 파일

이 폴더 안의 파일을 Apps Script 프로젝트에 추가합니다.

## 넣지 않는 파일

기존 단일본 \`Code_admin_gmail.gs\`, \`Dashboard.html\`, \`Dashboard_gmail.html\`은 이 분리 세트와 동시에 두지 않습니다.

## 진입 파일

- 서버: \`admin_00_core.gs\`의 \`doGet()\`
- 화면: \`Dashboard.html\`

## 운영 반영

1. 테스트 배포(/dev)에서 먼저 확인합니다.
2. 테스트 기간에는 운영 시트와 실제 지원자 메일 발송을 피합니다.
3. 검증 후 새 버전을 만들고, 기존 운영 배포를 편집해서 버전만 변경합니다.

## 파일 수

총 ${copied.length}개 파일입니다.
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');
fs.writeFileSync(path.join(outDir, 'UPLOAD_FILES.txt'), copied.join('\n') + '\n', 'utf8');

console.log(`Prepared ${outDir}`);
console.log(`Copied ${copied.length} files`);
