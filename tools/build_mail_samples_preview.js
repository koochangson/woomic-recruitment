import fs from 'fs';
import path from 'path';
import {
  mailTemplateFiles,
  mailTemplatePath,
  previewDistDir,
  root,
} from './project_paths.js';

fs.mkdirSync(previewDistDir, { recursive: true });
const outPath = path.join(previewDistDir, 'mail_samples_preview.html');
const templatePaths = new Map(mailTemplateFiles.map(([group, name]) => [name, mailTemplatePath(group, name)]));
const read = name => fs.readFileSync(templatePaths.get(name), 'utf8');
const assetDataUri = (name) => {
  const ext = path.extname(name).replace('.', '').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const data = fs.readFileSync(path.join(root, name)).toString('base64');
  return `data:${mime};base64,${data}`;
};

const ciSrc = assetDataUri('woomi-ci.png');
const headerBgSrc = assetDataUri('woomi-mail-header-bg.jpg');

const shared = {
  top: read('mail_shared_header_top.html'),
  open: read('mail_shared_body_open.html'),
  close: read('mail_shared_body_close.html'),
  footer: read('mail_shared_footer.html'),
};

const generalSamples = [
  ['interview_slot_request', '면접 후보 일정 요청', '홍보 포지션 1차 실무면접', 'mail_body_interview_slot_request.html'],
  ['interview_first', '1차 면접 안내', '홍보 포지션', 'mail_body_interview_first.html'],
  ['interview_second', '2차 면접 안내', '홍보 포지션', 'mail_body_interview_second.html'],
  ['panel_schedule', '면접 일정 안내', '홍보팀 정규직 채용', 'mail_body_panel_schedule.html'],
  ['onboarding', '입사 안내', '최종 합격 및 입사 준비사항', 'mail_body_onboarding.html'],
  ['onboarding_internal', '신규입사자 안내', '관련부서 공유', 'mail_body_onboarding_internal.html'],
  ['rejection', '채용 결과 안내', '홍보 포지션', 'mail_body_rejection.html'],
  ['headhunter_forward', '헤드헌팅 후보자 안내', '홍보 포지션 채용 진행', 'mail_body_headhunter_forward.html'],
  ['general_notice', '채용 진행 안내', '홍보 포지션', 'mail_body_general_notice.html'],
];

const referenceSamples = [
  ['reference_candidate_request', '레퍼런스 추천인 등록 요청', 'mail_01_reference_candidate_request.html'],
  ['reference_candidate_reminder', '레퍼런스 추천인 등록 리마인드', 'mail_02_reference_candidate_reminder.html'],
  ['reference_referee_request', '추천인 레퍼런스 체크 요청', 'mail_03_reference_referee_request.html'],
  ['reference_referee_reminder', '추천인 레퍼런스 체크 리마인드', 'mail_04_reference_referee_reminder.html'],
  ['reference_referee_complete', '추천인 응답 완료 안내', 'mail_05_reference_referee_complete.html'],
];

function renderGeneralHeader(title, subtitle) {
  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;box-sizing:border-box;background:#ffffff;border:1px solid #dde7f1;box-shadow:0 12px 28px rgba(15,52,96,0.10);">
  <tr>
    <td style="height:4px;line-height:4px;font-size:0;background:#003087;">&nbsp;</td>
  </tr>
  <tr>
    <td background="${headerBgSrc}" style="padding:26px 30px 28px;background-color:#f7fbff;background-image:url('${headerBgSrc}');background-repeat:no-repeat;background-position:center top;background-size:cover;border-bottom:1px solid #dde7f1;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="min-height:172px;">
        <tr>
          <td width="56%" valign="top" style="width:56%;padding:0 12px 0 0;">
            <img src="${ciSrc}" width="104" height="39" alt="우미건설" style="display:block;width:104px;height:39px;border:0;font-size:16px;font-weight:700;color:#003087;">
            <div style="padding-top:16px;font-size:32px;line-height:1.18;font-weight:700;color:#003087;word-break:keep-all;overflow-wrap:break-word;">${title}</div>
            <div style="width:40px;height:2px;background:#003087;line-height:2px;font-size:0;margin-top:12px;">&nbsp;</div>
            <div style="padding-top:15px;font-size:14px;line-height:1.65;color:#52667a;word-break:keep-all;overflow-wrap:break-word;">${subtitle}</div>
          </td>
          <td width="44%" valign="top" style="width:44%;font-size:0;line-height:0;">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderGeneralContact(id) {
  if (id === 'panel_schedule' || id === 'onboarding_internal') return '';
  return `        <tr>
          <td style="padding-top:24px;border-top:1px solid #dde7f1;">
            <div style="font-size:15px;line-height:1.4;font-weight:700;color:#1b2027;padding-bottom:6px;word-break:keep-all;overflow-wrap:break-word;">문의사항</div>
            <div style="font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">채용 절차와 관련해 궁금한 점이 있으시면 본 메일에 회신해 주세요.</div>
          </td>
        </tr>`;
}

function composeGeneral(bodyFile, title, subtitle, id) {
  return [
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>메일 샘플</title></head>',
    shared.top,
    '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">우미건설 채용 절차 안내입니다.</div>',
    renderGeneralHeader(title, subtitle),
    shared.open,
    read(bodyFile),
    renderGeneralContact(id),
    shared.close,
    shared.footer,
  ].join('\n');
}

function escAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sampleCard(kind, id, title, html, source) {
  return `
    <section class="sample" id="${escAttr(id)}">
      <div class="sample-head">
        <div>
          <div class="kind">${escAttr(kind)}</div>
          <h2>${escAttr(title)}</h2>
        </div>
        <div class="source">${escAttr(source)}</div>
      </div>
      <iframe title="${escAttr(title)}" srcdoc="${escAttr(html)}"></iframe>
    </section>`;
}

const cards = [
  ...generalSamples.map(([id, title, subtitle, file]) => sampleCard('일반 메일', id, title, composeGeneral(file, title, subtitle, id), file)),
  ...referenceSamples.map(([id, title, file]) => sampleCard('레퍼런스 메일', id, title, read(file), file)),
];

const nav = [...generalSamples, ...referenceSamples].map(([id, title]) =>
  `<a href="#${escAttr(id)}">${escAttr(title)}</a>`
).join('');

const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>우미건설 ATS 메일 샘플</title>
<style>
  body{margin:0;background:#f3f6fa;color:#142033;font-family:Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;}
  header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #dbe4ef;padding:18px 24px;}
  h1{margin:0 0 10px;font-size:18px;line-height:1.3;}
  .note{font-size:12px;color:#66748a;line-height:1.5;}
  nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;}
  nav a{display:inline-block;padding:6px 9px;border:1px solid #cdd8e6;border-radius:6px;background:#fff;color:#12375d;text-decoration:none;font-size:12px;font-weight:700;}
  main{padding:22px 24px 40px;display:grid;gap:24px;}
  .sample{background:#fff;border:1px solid #dbe4ef;border-radius:10px;box-shadow:0 2px 8px rgba(15,52,96,.08);overflow:hidden;}
  .sample-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid #e3ebf5;}
  .kind{font-size:11px;font-weight:700;color:#66748a;margin-bottom:3px;}
  h2{margin:0;font-size:15px;line-height:1.35;}
  .source{font-size:11px;color:#8a96a8;white-space:nowrap;}
  iframe{display:block;width:100%;height:760px;border:0;background:#edf6fb;}
</style>
</head>
<body>
<header>
  <h1>우미건설 ATS 메일 샘플</h1>
  <div class="note">일반 메일은 공통 상단/본문/문의/하단 템플릿을 조합한 미리보기입니다. 레퍼런스 메일 5종은 Apps Script에 남겨두는 원본 HTML 파일을 그대로 표시합니다.</div>
  <nav>${nav}</nav>
</header>
<main>${cards.join('\n')}</main>
</body>
</html>`;

fs.writeFileSync(outPath, page, 'utf8');
console.log(outPath);
