import fs from 'fs';
import path from 'path';
import {
  adminDistDir,
  adminIntermediateDir,
  adminJsFiles,
  configDir,
  mailTemplateFiles,
  mailTemplatePath,
} from './project_paths.js';

const outDir = adminDistDir;

const files = [
  [path.join(configDir, 'appsscript.admin.json'), 'appsscript.json'],
  ...[
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
    'Dashboard.html',
    'app_css.html',
    ...adminJsFiles,
  ].map(name => [path.join(adminIntermediateDir, name), name]),
  ...mailTemplateFiles.map(([group, name]) => [mailTemplatePath(group, name), name]),
];

fs.mkdirSync(outDir, { recursive: true });
for (const name of fs.readdirSync(outDir)) {
  if (name === 'README.md' || name === 'UPLOAD_FILES.txt') continue;
  fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
}

const copied = [];
for (const item of files) {
  const [src, destName] = item;
  const dest = path.join(outDir, destName);
  if (!fs.existsSync(src)) throw new Error(`missing required file: ${src}`);
  fs.copyFileSync(src, dest);
  copied.push(destName);
}

const readme = `# Apps Script Split Upload Set

이 폴더는 Apps Script 관리자 웹앱 반영용 파일 세트입니다.

## 넣는 파일

이 폴더 안의 파일을 Apps Script 프로젝트에 추가합니다.

## 넣지 않는 파일

원본 \`src/admin/backend/Code.gs\`, \`src/admin/frontend/Dashboard.html\`과 이전에 생성된 \`js_*.html\`은 이 세트와 동시에 두지 않습니다.

화면 JavaScript는 기능별 \`js_*.html\` 8개로 나뉘며 \`Dashboard.html\`이 정해진 순서로 include합니다.

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
