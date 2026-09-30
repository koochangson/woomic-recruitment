import fs from 'fs';
import path from 'path';
import { adminGsSource, adminIntermediateDir } from './project_paths.js';

const sourceName = 'src/admin/backend/Code.gs';
const sourcePath = adminGsSource;
fs.mkdirSync(adminIntermediateDir, { recursive: true });

const source = fs.readFileSync(sourcePath, 'utf8');
const lineParts = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
if (lineParts[lineParts.length - 1] === '') lineParts.pop();

const sections = [
  ['admin_00_core.gs', /^function sendMailViaGmail_/m],
  ['admin_01_mail_base.gs', /^function getAll_/m],
  ['admin_02_sheet_api.gs', /^function handleReferralSecurityAction_/m],
  ['admin_03_referral_public.gs', /^function buildReferenceCandidateLinkUrl_/m],
  ['admin_04_reference.gs', /^const GENERAL_MAIL_TEMPLATE_FILES/m],
  ['admin_05_general_mail.gs', /^function generateReferenceSummary_/m],
  ['admin_06_ai_referral_directory.gs', /^function ensureSheet_/m],
  ['admin_07_sheet_utils.gs', /^function referralCodeKey_/m],
  ['admin_08_referral_tokens.gs', /^function isAdminRequest_/m],
  ['admin_09_auth.gs', /^function adminApi/m],
  ['admin_99_admin_api.gs', /^$/m],
];

function lineForPattern(pattern, label) {
  const match = source.match(pattern);
  if (!match || typeof match.index !== 'number') {
    throw new Error(`missing split marker for ${label}: ${pattern}`);
  }
  return source.slice(0, match.index).split(/\r?\n/).length;
}

const ranges = [];
let startLine = 1;
for (let i = 0; i < sections.length; i++) {
  const [fileName, nextPattern] = sections[i];
  const isLast = i === sections.length - 1;
  const endLine = isLast ? lineParts.length : lineForPattern(nextPattern, fileName) - 1;
  ranges.push([fileName, startLine, endLine]);
  startLine = endLine + 1;
}

function sliceLines(startLine, endLine) {
  const startIndex = startLine - 1;
  const endIndex = endLine;
  if (startIndex < 0 || endIndex > lineParts.length || startIndex >= endIndex) {
    throw new Error(`invalid range ${startLine}-${endLine}`);
  }
  return lineParts.slice(startIndex, endIndex).join('');
}

let expectedLine = 1;
const outputs = [];
for (const [fileName, startLine, endLine] of ranges) {
  if (startLine !== expectedLine) {
    throw new Error(`gap before ${fileName}: expected ${expectedLine}, got ${startLine}`);
  }
  const content = sliceLines(startLine, endLine);
  outputs.push([fileName, content, startLine, endLine]);
  expectedLine = endLine + 1;
}

if (expectedLine !== lineParts.length + 1) {
  throw new Error(`ranges ended at ${expectedLine - 1}, expected ${lineParts.length}`);
}

const recomposed = outputs.map(([, content]) => content).join('');
if (recomposed !== source) {
  let firstDiff = 0;
  while (firstDiff < source.length && source[firstDiff] === recomposed[firstDiff]) firstDiff++;
  throw new Error(`recomposed server code differs at index ${firstDiff}`);
}

for (const [fileName, content] of outputs) {
  fs.writeFileSync(path.join(adminIntermediateDir, fileName), content, 'utf8');
}

console.log(`Split ${sourceName} into ${outputs.length} files`);
for (const [fileName, , startLine, endLine] of outputs) {
  console.log(`${fileName} ${endLine - startLine + 1} lines`);
}
console.log('Integrity check OK: split .gs files exactly reproduce source');
