import fs from 'fs';
import path from 'path';
import { adminHtmlSource, adminIntermediateDir } from './project_paths.js';

const sourceName = 'src/admin/frontend/Dashboard.html';
const splitName = 'Dashboard.html';
const sourcePath = adminHtmlSource;
fs.mkdirSync(adminIntermediateDir, { recursive: true });

const source = fs.readFileSync(sourcePath, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';

function lineNumberAt(index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function findSingle(pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label} match count must be 1, got ${matches.length}`);
  }
  return matches[0];
}

const styleMatch = findSingle(/<style>[\s\S]*?<\/style>/g, 'style');
const inlineScripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)];
if (inlineScripts.length !== 1) {
  throw new Error(`inline script match count must be 1, got ${inlineScripts.length}`);
}
const scriptMatch = inlineScripts[0];

const styleFull = styleMatch[0];
const styleOpen = styleFull.match(/^<style[^>]*>\r?\n?/)[0];
const styleClose = styleFull.match(/\r?\n?<\/style>$/)[0];
const styleInner = styleFull.slice(styleOpen.length, styleFull.length - styleClose.length);
const scriptFull = scriptMatch[0];
const scriptOpen = scriptFull.match(/^<script[^>]*>\r?\n?/)[0];
const scriptClose = scriptFull.match(/\r?\n?<\/script>$/)[0];
const scriptInner = scriptFull.slice(scriptOpen.length, scriptFull.length - scriptClose.length);

const scriptTagLine = lineNumberAt(scriptMatch.index);
const scriptFirstInnerLine = scriptTagLine + 1;
const innerLineParts = scriptInner.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
if (innerLineParts[innerLineParts.length - 1] === '') innerLineParts.pop();

const baseScriptFirstInnerLine = 2623;
const lineShift = scriptFirstInnerLine - baseScriptFirstInnerLine;
const jsRanges = [
  ['js_00_state', 2623, 4059],
  ['js_02_sheets_sync', 4060, 5581],
  ['js_03_positions', 5582, 6697],
  ['js_05_interviews', 6698, 7732],
  ['js_04_candidates', 7733, 8450],
  ['js_08_dashboard', 8451, 8740],
  ['js_07_referral', 8741, 9615],
  ['js_04_candidates_flow', 9616, 10328],
  ['js_05_interviews_manage', 10329, 10554],
  ['js_06_reference', 10555, 11160],
  ['js_08_onboarding_bulk', 11161, 11521],
  ['js_09_settings', 11522, 11825],
  ['js_99_app', 11826, 12005],
].map(([name, start, end]) => [name, start + lineShift, end + lineShift]);
jsRanges[jsRanges.length - 1][2] = scriptFirstInnerLine + innerLineParts.length - 1;

function sliceOriginalLines(startLine, endLine) {
  const startIndex = startLine - scriptFirstInnerLine;
  const endIndex = endLine - scriptFirstInnerLine + 1;
  if (startIndex < 0 || endIndex > innerLineParts.length || startIndex >= endIndex) {
    throw new Error(`invalid range ${startLine}-${endLine}`);
  }
  return innerLineParts.slice(startIndex, endIndex).join('');
}

let expectedLine = scriptFirstInnerLine;
const includeLines = [];
const generated = new Map();

generated.set('app_css', styleInner);
generated.set('app_script', scriptFull);

for (const [name, startLine, endLine] of jsRanges) {
  if (startLine !== expectedLine) {
    throw new Error(`gap before ${name}: expected ${expectedLine}, got ${startLine}`);
  }
  const chunk = sliceOriginalLines(startLine, endLine);
  generated.set(name, chunk);
  includeLines.push(`<?!= include('${name}'); ?>`);
  expectedLine = endLine + 1;
}

if (expectedLine !== scriptFirstInnerLine + innerLineParts.length) {
  throw new Error(`ranges ended at ${expectedLine - 1}, expected ${scriptFirstInnerLine + innerLineParts.length - 1}`);
}

const splitHtml = source
  .slice(0, styleMatch.index)
  + `<style>${newline}<?!= include('app_css'); ?>${newline}</style>`
  + source.slice(styleMatch.index + styleFull.length, scriptMatch.index)
  + "<?!= include('app_script'); ?>"
  + source.slice(scriptMatch.index + scriptFull.length);

const combinedJs = jsRanges.map(([name, start, end]) => sliceOriginalLines(start, end)).join('');
if (combinedJs !== scriptInner) {
  let firstDiff = 0;
  while (firstDiff < scriptInner.length && scriptInner[firstDiff] === combinedJs[firstDiff]) firstDiff++;
  const expected = scriptInner.slice(firstDiff - 60, firstDiff + 120);
  const actual = combinedJs.slice(firstDiff - 60, firstDiff + 120);
  throw new Error(`combined JS differs at index ${firstDiff}\nEXPECTED:\n${expected}\nACTUAL:\n${actual}`);
}
if (generated.get('app_css') !== styleInner) {
  throw new Error('extracted CSS differs from original style contents');
}

fs.writeFileSync(path.join(adminIntermediateDir, splitName), splitHtml, 'utf8');
for (const [name, content] of generated.entries()) {
  fs.writeFileSync(path.join(adminIntermediateDir, `${name}.html`), content, 'utf8');
}

const counts = jsRanges.map(([name, start, end]) => `${name}.html ${end - start + 1} lines`);
console.log(`Created ${splitName}`);
console.log(`Created app_css.html ${styleInner.split(/\r?\n/).length} lines`);
console.log(counts.join('\n'));
console.log('Integrity check OK: CSS unchanged, combined JS unchanged');
