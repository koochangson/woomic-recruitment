import fs from 'fs';
import { adminGsSource, mailTemplatePath } from './project_paths.js';

const targets = [adminGsSource];

function extractConst(code, name) {
  const re = new RegExp(`const ${name} = "([^"]*)";`);
  const match = code.match(re);
  return match ? match[1] : '';
}

function replaceFunction(code, name, replacement) {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const next = code.indexOf('\nfunction ', start + 1);
  if (next < 0) throw new Error(`cannot find end of function ${name}`);
  return code.slice(0, start) + replacement + code.slice(next + 1);
}

function refactor(code) {
  code = code.replace(
    ' * 일반 메일용 공유 조각/본문은 Apps Script 파일 추가 부담을 줄이기 위해 아래 인라인 맵에 내장한다.',
    ' * 일반 메일용 공유 조각/본문은 별도 HTML 파일에서 읽어 조합한다.'
  );

  code = code.replace(/const GENERAL_MAIL_CI_SRC = "[^"]*";\r?\n/, '');
  code = code.replace(/const GENERAL_MAIL_HEADER_ART_SRC = "[^"]*";\r?\n/, '');

  code = code.replace(
    /\r?\nconst GENERAL_MAIL_INLINE_FRAGMENTS = \{[\s\S]*?\r?\n\};\r?\n\r?\nfunction loadMailFragment_/,
    '\nfunction loadMailFragment_'
  );

  code = code.replace(
    /function loadMailFragment_\(fileName\) \{\r?\n[\s\S]*?\r?\n\}\r?\n\r?\nfunction nlToBr_/,
    "function loadMailFragment_(fileName) {\n  return HtmlService.createHtmlOutputFromFile(fileName).getContent();\n}\n\nfunction loadMailAsset_(fileName) {\n  return loadMailFragment_(fileName).trim();\n}\n\nfunction nlToBr_"
  );

  const renderReplacement =
`function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return loadMailFragment_('mail_shared_header_bottom')
    .replace(/{{ciSrc}}/g, loadMailAsset_('mail_asset_ci_src'))
    .replace(/{{headerArtSrc}}/g, loadMailAsset_('mail_asset_header_art_src'))
    .replace(/{{headerTitle}}/g, title)
    .replace(/{{headerSubtitle}}/g, subtitle);
}

`;

  return replaceFunction(code, 'renderGeneralMailHeader_', renderReplacement);
}

const originalCode = fs.readFileSync(adminGsSource, 'utf8');
let ciSrc = extractConst(originalCode, 'GENERAL_MAIL_CI_SRC');
let headerArtSrc = extractConst(originalCode, 'GENERAL_MAIL_HEADER_ART_SRC');

const ciAssetPath = mailTemplatePath('assets', 'mail_asset_ci_src.html');
const headerArtAssetPath = mailTemplatePath('assets', 'mail_asset_header_art_src.html');

if (!ciSrc && fs.existsSync(ciAssetPath)) ciSrc = fs.readFileSync(ciAssetPath, 'utf8');
if (!headerArtSrc && fs.existsSync(headerArtAssetPath)) headerArtSrc = fs.readFileSync(headerArtAssetPath, 'utf8');

if (!ciSrc) throw new Error('missing GENERAL_MAIL_CI_SRC and mail_asset_ci_src.html');
if (!headerArtSrc) throw new Error('missing GENERAL_MAIL_HEADER_ART_SRC and mail_asset_header_art_src.html');

fs.writeFileSync(ciAssetPath, ciSrc, 'utf8');
fs.writeFileSync(headerArtAssetPath, headerArtSrc, 'utf8');

for (const target of targets) {
  const code = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, refactor(code), 'utf8');
  console.log(`Refactored ${target}`);
}

console.log('Created mail_asset_ci_src.html');
console.log('Created mail_asset_header_art_src.html');
