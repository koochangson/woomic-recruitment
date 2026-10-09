// 배포 파일 짝 맞춤 점검(checkDeploymentParts_) 테스트.
// 실제 관리자 업로드 묶음(dist/apps-script-admin)을 Node VM(Apps Script와 같은 V8)에 올려
// ① 묶음 전체를 올린 경우 통과하고 ② 서버 파일 하나·양식 파일 하나가 예전 것이면 그 파일을 짚는지 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { adminDistDir } from '../tools/project_paths.js';
import { manifestFileName } from '../tools/build_manifest.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

const uploadNames = fs.readFileSync(path.join(adminDistDir, 'UPLOAD_FILES.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const toSigned = buf => Array.from(buf).map(v => (v > 127 ? v - 256 : v));

function loadBundle({ replaceGs = {}, replaceHtml = {}, skip = [] } = {}) {
  const cache = {};
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    Utilities: {
      computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
    },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    HtmlService: {
      createTemplateFromFile: name => {
        const file = path.join(adminDistDir, name + '.html');
        if (!fs.existsSync(file)) throw new Error('not found');
        const content = replaceHtml[name] ?? fs.readFileSync(file, 'utf8');
        return { getRawContent: () => content };
      },
      // Apps Script의 HtmlOutput은 원문을 정규화할 수 있다. 배포 지문 검사는 이 값을
      // 사용하지 않아야 하므로 테스트에서는 의도적으로 다른 내용을 돌려준다.
      createHtmlOutputFromFile: name => {
        const file = path.join(adminDistDir, name + '.html');
        if (!fs.existsSync(file)) throw new Error('not found');
        const content = replaceHtml[name] ?? fs.readFileSync(file, 'utf8');
        return { getContent: () => '<!-- normalized -->' + content };
      },
    },
  };
  vm.createContext(ctx);
  // Apps Script처럼 .gs 파일을 업로드 목록 순서대로 한 전역 공간에 올린다.
  for (const name of uploadNames.filter(n => n.endsWith('.gs') && !skip.includes(n))) {
    const source = replaceGs[name] ?? fs.readFileSync(path.join(adminDistDir, name), 'utf8');
    vm.runInContext(source, ctx, { filename: name });
  }
  return ctx;
}

let ctx = loadBundle();
let result = vm.runInContext('checkDeploymentParts_()', ctx);
check('묶음 전체를 올리면 통과', result.checked === true && result.ok === true && !result.unreliable && result.files.length === 0, result);
check('같은 빌드는 다음 점검을 캐시로 건너뜀', vm.runInContext('checkDeploymentParts_()', ctx).ok === true);

// 서버 파일 하나가 예전 버전(함수 내용이 다름)
const generalMail = fs.readFileSync(path.join(adminDistDir, 'admin_05_general_mail.gs'), 'utf8');
const staleGeneralMail = generalMail.replace(/function handleSendGeneralMail_\(payload\) \{/, "function handleSendGeneralMail_(payload) {\n  const legacyFlag = true;");
check('테스트용 예전 파일 생성', staleGeneralMail !== generalMail);
ctx = loadBundle({ replaceGs: { 'admin_05_general_mail.gs': staleGeneralMail } });
result = vm.runInContext('checkDeploymentParts_()', ctx);
check('예전 서버 파일을 짚음', result.ok === false && JSON.stringify(result.files) === JSON.stringify(['admin_05_general_mail.gs']), result);

// 메일 양식 파일 하나가 예전 버전
ctx = loadBundle({ replaceHtml: { mail_body_onboarding_internal: '<p>{{oldPlaceholder}}</p>' } });
result = vm.runInContext('checkDeploymentParts_()', ctx);
check('예전 양식 파일을 짚음', result.ok === false && JSON.stringify(result.files) === JSON.stringify(['mail_body_onboarding_internal.html']), result);

// 지문 목록 파일을 올리지 않음
ctx = loadBundle({ skip: [manifestFileName] });
result = vm.runInContext('checkDeploymentParts_()', ctx);
check('지문 목록 파일이 없으면 알림', result.checked === false && result.reason === 'manifest_missing', result);

// 이 환경에서 함수 원문을 읽을 수 없으면(전부 다르게 나옴) 오류로 보지 않는다
ctx = loadBundle();
vm.runInContext('Function.prototype.toString = function() { return "[native code]"; };', ctx);
result = vm.runInContext('checkDeploymentParts_()', ctx);
check('점검 방식이 안 맞으면 경고하지 않음', result.unreliable === true && result.files.length === 0, result);

console.log(`Deployment parts tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
