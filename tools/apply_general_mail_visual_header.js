import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const codePath = path.join(root, 'Code_admin_gmail.gs');

const dataUri = (name) => {
  const ext = path.extname(name).replace('.', '').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const encoded = fs.readFileSync(path.join(root, name)).toString('base64');
  return `data:${mime};base64,${encoded}`;
};

let code = fs.readFileSync(codePath, 'utf8');

const constants = [
  `const GENERAL_MAIL_CI_SRC = ${JSON.stringify(dataUri('woomi-ci.png'))};`,
  `const GENERAL_MAIL_HEADER_ART_SRC = ${JSON.stringify(dataUri('woomi-mail-header-bg.jpg'))};`,
].join('\n');

if (/const GENERAL_MAIL_CI_SRC = /.test(code)) {
  const start = code.indexOf('const GENERAL_MAIL_CI_SRC = ');
  const end = code.indexOf('const GENERAL_MAIL_INLINE_FRAGMENTS = ', start);
  if (start === -1 || end === -1) {
    throw new Error('general mail asset constants block not found');
  }
  code = code.slice(0, start) + constants + '\n\n' + code.slice(end);
} else {
  code = code.replace(
    /(const GENERAL_MAIL_HEADER_TITLES = \{[\s\S]*?\};)/,
    `$1\n\n${constants}`
  );
}

const visualHeaderFunction = String.raw`function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const eyebrow = escapeMailHtml_(ctx.headerEyebrow || 'WOOMI RECRUITMENT');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return '\n<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;box-sizing:border-box;background:#ffffff;border:1px solid #dde7f1;box-shadow:0 12px 28px rgba(15,52,96,0.10);">\n' +
    '  <tr>\n' +
    '    <td style="height:4px;line-height:4px;font-size:0;background:#003087;">&nbsp;</td>\n' +
    '  </tr>\n' +
    '  <tr>\n' +
    '    <td background="' + GENERAL_MAIL_HEADER_ART_SRC + '" style="padding:26px 30px 28px;background-color:#f7fbff;background-image:url(' + GENERAL_MAIL_HEADER_ART_SRC + ');background-repeat:no-repeat;background-position:center top;background-size:cover;border-bottom:1px solid #dde7f1;">\n' +
    '      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="min-height:172px;">\n' +
    '        <tr>\n' +
    '          <td width="56%" valign="top" style="width:56%;padding:0 12px 0 0;">\n' +
    '            <img src="' + GENERAL_MAIL_CI_SRC + '" width="104" height="39" alt="우미건설" style="display:block;width:104px;height:39px;border:0;font-size:16px;font-weight:700;color:#003087;">\n' +
    '            <div style="padding-top:16px;font-size:32px;line-height:1.18;font-weight:700;color:#003087;word-break:keep-all;overflow-wrap:break-word;">' + title + '</div>\n' +
    '            <div style="width:40px;height:2px;background:#003087;line-height:2px;font-size:0;margin-top:12px;">&nbsp;</div>\n' +
    '            <div style="padding-top:15px;font-size:14px;line-height:1.65;color:#52667a;word-break:keep-all;overflow-wrap:break-word;">' + subtitle + '</div>\n' +
    '          </td>\n' +
    '          <td width="44%" valign="top" style="width:44%;font-size:0;line-height:0;">&nbsp;</td>\n' +
    '        </tr>\n' +
    '      </table>\n' +
    '    </td>\n' +
    '  </tr>\n';
}`;

code = code.replace(
  /function renderGeneralMailHeader_\([\s\S]*?\n\}\r?\n\r?\nfunction generalMailHtml_/,
  `${visualHeaderFunction}\n\nfunction generalMailHtml_`
);

fs.writeFileSync(codePath, code, 'utf8');
console.log('Code_admin_gmail.gs visual general mail header applied');
