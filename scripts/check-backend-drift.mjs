// 관리자·공개 백엔드 중복 함수 어긋남 검사.
// 두 Code.gs에 같은 이름으로 있는 함수는 내용(주석·공백 제외)이 같아야 한다. 한쪽만 고치면 다른 쪽에 같은 버그가 남기 때문이다.
// 의도적으로 다른 함수는 config/backend-divergence.json에 이유와 함께 등록하고, 등록 당시 두 본문의 지문을 기억한다.
// 등록된 함수를 어느 한쪽이라도 고치면 지문이 달라져 실패한다 → 다른 쪽도 같이 고쳐야 하는지 확인한 뒤
//   node scripts/check-backend-drift.mjs --update
// 로 지문을 갱신한다. 공통 런타임(shared_00_runtime.gs)에 있는 함수를 백엔드에 다시 정의해도 실패한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root, adminGsSource, publicGsSource, sharedBackendSource } from '../tools/project_paths.js';

const allowlistPath = path.join(root, 'config', 'backend-divergence.json');
const update = process.argv.includes('--update');

function functionsOf(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const out = {};
  const re = /^function ([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const end = src.indexOf('\n}\n', m.index);
    out[m[1]] = src.slice(m.index, end < 0 ? src.length : end + 2);
  }
  return out;
}
// 주석·공백·끝 쉼표·화살표 함수 괄호 차이는 무시한다.
const normalize = body => body
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  .replace(/\s+/g, '')
  .replace(/,([}\])])/g, '$1')
  .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, '$1=>');
const fingerprint = body => crypto.createHash('sha256').update(normalize(body)).digest('hex').slice(0, 16);

const admin = functionsOf(adminGsSource);
const pub = functionsOf(publicGsSource);
const shared = functionsOf(sharedBackendSource);
const allow = fs.existsSync(allowlistPath) ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) : { functions: {} };
allow.functions = allow.functions || {};

const errors = [];
const notes = [];
Object.keys(shared).forEach(name => {
  if (admin[name]) errors.push(`${name}: 공통 런타임에 있는 함수를 관리자 Code.gs에 다시 정의했습니다.`);
  if (pub[name]) errors.push(`${name}: 공통 런타임에 있는 함수를 공개 Code.gs에 다시 정의했습니다.`);
});

const common = Object.keys(admin).filter(name => pub[name]).sort();
let identical = 0;
common.forEach(name => {
  const same = normalize(admin[name]) === normalize(pub[name]);
  const entry = allow.functions[name];
  if (same) {
    identical++;
    if (entry) {
      if (update) delete allow.functions[name];
      else notes.push(`${name}: 이제 두 본문이 같습니다. 예외 목록에서 빼도 됩니다(--update).`);
    }
    return;
  }
  const current = { admin: fingerprint(admin[name]), public: fingerprint(pub[name]) };
  if (!entry) {
    errors.push(`${name}: 관리자·공개 본문이 다릅니다. 한쪽만 고쳤다면 다른 쪽도 맞추고, 의도된 차이면 config/backend-divergence.json에 이유를 적어 등록하세요.`);
    return;
  }
  if (entry.admin !== current.admin || entry.public !== current.public) {
    if (update) Object.assign(entry, current);
    else {
      const changed = [entry.admin !== current.admin && '관리자', entry.public !== current.public && '공개'].filter(Boolean).join('·');
      errors.push(`${name}: 의도적으로 다른 함수인데 ${changed} 쪽이 바뀌었습니다(사유: ${entry.reason}). 다른 쪽도 같이 고쳐야 하는지 확인한 뒤 --update로 지문을 갱신하세요.`);
    }
  }
});
Object.keys(allow.functions).forEach(name => {
  if (!admin[name] || !pub[name]) {
    if (update) delete allow.functions[name];
    else notes.push(`${name}: 한쪽에 더 이상 없습니다. 예외 목록에서 빼도 됩니다(--update).`);
  }
});

if (update) {
  const sorted = Object.fromEntries(Object.keys(allow.functions).sort().map(k => [k, allow.functions[k]]));
  fs.writeFileSync(allowlistPath, JSON.stringify({ ...allow, functions: sorted }, null, 2) + '\n');
  console.log(`Updated ${path.relative(root, allowlistPath)}`);
}
notes.forEach(note => console.log('note: ' + note));
if (errors.length) {
  console.error('Backend drift check failed:');
  errors.forEach(error => console.error('- ' + error));
  process.exit(1);
}
console.log(`Backend drift check passed: ${common.length} shared names, ${identical} identical, ${common.length - identical} intentional differences.`);
