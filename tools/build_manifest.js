// 관리자 업로드 묶음의 지문 목록(admin_98_build_manifest.gs)을 만든다.
// 서버 함수마다 본문 지문, 화면·메일 양식 파일마다 내용 지문을 적어 두면, 서버가 실행 중에
// 같은 방식으로 계산해 비교할 수 있다(checkDeploymentParts_). 일부 파일만 올려 버전이 섞이면 어떤 파일인지 알려 준다.
// 지문 = 공백을 모두 뺀 내용의 SHA-256 앞 12자리(서버 sha256Hex_와 같은 방식).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const manifestFileName = 'admin_98_build_manifest.gs';

export const partFingerprint = text => crypto
  .createHash('sha256')
  .update(String(text).replace(/\s+/g, ''), 'utf8')
  .digest('hex')
  .slice(0, 12);

// 맨 앞 칸의 function 선언부터 맨 앞 칸의 닫는 중괄호까지(서버에서 함수.toString()이 돌려주는 범위와 같다).
export function topLevelFunctions(source) {
  const text = String(source).replace(/\r\n/g, '\n');
  const out = [];
  const re = /^function ([A-Za-z0-9_$]+)\s*\(/gm;
  let match;
  while ((match = re.exec(text))) {
    const end = text.indexOf('\n}', match.index);
    if (end < 0) continue;
    out.push([match[1], text.slice(match.index, end + 2)]);
  }
  return out;
}

export function buildAdminManifestSource(distDir, uploadNames) {
  const functions = {};
  const html = {};
  for (const name of uploadNames) {
    if (name === manifestFileName) continue;
    const content = fs.readFileSync(path.join(distDir, name), 'utf8');
    if (name.endsWith('.gs')) {
      for (const [fnName, body] of topLevelFunctions(content)) functions[fnName] = [name, partFingerprint(body)];
    } else if (name.endsWith('.html') && name !== 'Dashboard.html') {
      // Dashboard.html은 서버 템플릿(<?!= ?>)이라 원문 그대로 읽히지 않을 수 있어 제외한다.
      html[name.replace(/\.html$/, '')] = partFingerprint(content);
    }
  }
  const sortedFunctions = Object.fromEntries(Object.keys(functions).sort().map(k => [k, functions[k]]));
  const sortedHtml = Object.fromEntries(Object.keys(html).sort().map(k => [k, html[k]]));
  const build = partFingerprint(JSON.stringify([sortedFunctions, sortedHtml]));
  return [
    '// 자동 생성 파일(tools/build_manifest.js) — 직접 고치지 않습니다.',
    '// 업로드한 파일들이 같은 빌드인지 서버가 확인하는 데 씁니다(checkDeploymentParts_).',
    `const BUILD_MANIFEST_ = ${JSON.stringify({ build, functions: sortedFunctions, html: sortedHtml }, null, 1)};`,
    '',
  ].join('\n');
}
