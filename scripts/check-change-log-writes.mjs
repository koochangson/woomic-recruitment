// 데이터 시트를 쓰는 서버 함수는 변경 이력(appendChange_/appendChanges_)을 남겨야 한다.
// 다른 PC의 변경 감지(getChanges)와 새로고침 변경분 조회(getAll since)가 변경 이력만 보고 바뀐 행을 고르기 때문이다.
// 시트에 쓰는데(setValues·setValue·appendRow·deleteRow·deleteRows) 변경 이력이 없는 함수는 아래 예외 목록에
// 이유와 함께 있어야 하며, 없으면 실패한다.
import fs from 'node:fs';
import { adminGsSource, publicGsSource, sharedBackendSource } from '../tools/project_paths.js';

const EXEMPT = {
  // 변경 이력 자체를 다루는 함수
  ensureChangeLogSheetUncached_: '변경 이력 시트(_Changes) 머리글 준비',
  ensureChangeArchiveSheet_: '변경 이력 보관 시트 머리글 준비',
  archiveOldChanges_: '오래된 변경 이력을 보관 시트로 이동',
  compactStoredChangeLogValues_: '변경 이력의 예전 전체 JSON 정리',
  deleteCandidateChangeRows_: '개인정보 파기 시 변경 이력에서 해당 지원자 기록 삭제',
  // 동기화 대상이 아닌 내부 시트
  logMailSend_: 'MailLog(발송 기록) — 화면 동기화 대상 아님',
  commonAttachmentSheet_: '_MailAttachments(공통 첨부) — 화면 동기화 대상 아님',
  uploadCommonAttachment_: '_MailAttachments(공통 첨부) — 화면 동기화 대상 아님',
  ensureHeadersUncached_: '시트 머리글(1행) 보정 — 데이터 행이 아님',
  // 호출하는 쪽이 변경 이력을 남기는 함수
  writeBatchRows_: 'batchUpsert_가 쓴 뒤 appendChanges_로 기록',
};

const sources = { admin: adminGsSource, public: publicGsSource, shared: sharedBackendSource };
const errors = [];
const seen = new Set();
for (const [label, file] of Object.entries(sources)) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const m of src.matchAll(/^function ([A-Za-z0-9_$]+)\s*\(/gm)) {
    const body = src.slice(m.index, src.indexOf('\n}\n', m.index) + 2);
    const writes = /\.(setValues|setValue|appendRow|deleteRow|deleteRows)\(/.test(body);
    const logs = /appendChanges?_\(/.test(body);
    if (!writes || logs) continue;
    seen.add(m[1]);
    if (!EXEMPT[m[1]]) errors.push(`${label}: ${m[1]} — 시트에 쓰지만 변경 이력(appendChange_)을 남기지 않습니다. 데이터 시트라면 appendChange_를 추가하고, 내부 시트라면 이 검사의 예외 목록에 이유를 적으세요.`);
  }
}
for (const name of Object.keys(EXEMPT)) {
  if (!seen.has(name)) console.log(`note: 예외 목록의 ${name}은(는) 더 이상 해당하지 않습니다. 목록에서 빼도 됩니다.`);
}
if (errors.length) {
  console.error('Change-log write check failed:');
  errors.forEach(e => console.error('- ' + e));
  process.exit(1);
}
console.log(`Change-log write check passed: ${seen.size} internal writers exempted with reasons.`);
