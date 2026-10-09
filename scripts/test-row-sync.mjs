// 입사 등록(Onboardings)·처우 기록(Offers) 줄 단위 동기화 테스트.
// 화면 코드(js_07_state의 줄 동기화, js_01의 GS_SCHEMA)를 두 대의 가짜 PC에 올리고,
// 서버 batchUpsert의 rev 규칙(불일치면 전체 거절, 저장 시 rev+1)을 흉내 낸 공용 서버로 동시 수정을 재현한다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { adminJsDir } from '../tools/project_paths.js';

const read = name => fs.readFileSync(path.join(adminJsDir, name), 'utf8').replace(/\r\n/g, '\n');
const stateJs = read('js_07_state.html');
const syncJs = read('js_01_sheets_sync.html');
const sliceFunction = (src, name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
};
const rowSyncStart = stateJs.indexOf('const ROW_SYNC_SNAPSHOT_KEY_');
const rowSyncEnd = stateJs.indexOf('\n}\n', stateJs.indexOf('function replaceRowSyncRecord_(')) + 3;
if (rowSyncStart < 0 || rowSyncEnd < 3) throw new Error('row sync block not found');
const rowSyncCode = stateJs.slice(rowSyncStart, rowSyncEnd).replace(/^(let|const) /gm, 'var ');
const schemaCode = 'var GS_SCHEMA = {' + ['Onboardings', 'Offers', 'RefReports', 'NotifyLog', 'ActivityLog'].map(name => {
  const m = syncJs.match(new RegExp('  ' + name + ': \\[[^\\]]*\\]'));
  if (!m) throw new Error('schema not found: ' + name);
  return m[0];
}).join(',\n') + '};';

const requests = { deleteRow: 0, deleteRows: 0 };
let serverKnowsDeleteRows = true;
const server = { Onboardings: {}, Offers: {}, RefReports: {}, NotifyLog: {}, ActivityLog: {} };
const feed = [];
function serverBatchUpsert(sheet, rows) {
  const conflicts = [];
  rows.forEach(row => {
    const current = server[sheet][row.id];
    const currentRev = current ? Number(current.rev) || 0 : 0;
    if (current && (Number(row.rev) || 0) !== currentRev) conflicts.push({ id: row.id, expectedRev: Number(row.rev) || 0, currentRev, data: { ...current } });
  });
  if (conflicts.length) return { error: 'revision_conflict', count: 0, conflicts };
  const revs = {};
  rows.forEach(row => {
    const currentRev = server[sheet][row.id] ? Number(server[sheet][row.id].rev) || 0 : 0;
    const stored = {};
    Object.keys(row).forEach(k => { stored[k] = row[k] == null ? '' : String(row[k]); }); // 시트는 텍스트로 저장
    stored.rev = String(currentRev + 1);
    server[sheet][row.id] = stored;
    revs[row.id] = currentRev + 1;
    feed.push({ sheet, action: 'upsert', id: row.id, data: { ...stored } });
  });
  return { status: 'ok', count: rows.length, revs };
}

function makePc() {
  const storage = {};
  const ctx = {
    console: { info() {}, warn() {}, log() {} },
    localStorage: { getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; } },
    onboardings: [],
    offers: [],
    refReports: {},
    notifyLog: [],
    activityLog: [],
    conflictNotices: 0,
    hasGsBridge_: () => true,
    localYmd_: d => d.toISOString().slice(0, 10),
    setTimeout: () => 0,
    clearTimeout: () => {},
    saveState: () => {},
    gsGetAllResult: async sheet => ({ data: Object.values(server[sheet]).map(row => ({ ...row })) }),
    gsFetch: async (action, sheet, data) => {
      if (action === 'batchUpsert') return serverBatchUpsert(sheet, data);
      if (action === 'deleteRows') {
        if (!serverKnowsDeleteRows) { ctx.gsLastError_ = 'unknown_action'; return null; }
        requests.deleteRows++;
        data.ids.forEach(id => { delete server[sheet][id]; feed.push({ sheet, action: 'delete', id }); });
        return { status: 'deleted', ids: data.ids };
      }
      requests.deleteRow++;
      delete server[sheet][data.id];
      return { status: 'deleted' };
    },
    gsLastError_: '',
  };
  ctx.showRevisionConflict_ = () => { ctx.conflictNotices++; };
  vm.createContext(ctx);
  vm.runInContext([schemaCode, sliceFunction(syncJs, 'gsSchemaPayload'), rowSyncCode].join('\n'), ctx);
  return ctx;
}

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}
const deliver = (pc, from) => feed.slice(from).forEach(change => pc.applyRowSyncChange_(change.sheet, change));

const A = makePc();
const B = makePc();
A.onboardings.push({ id: 1, candId: 10, candName: '홍길동', dept: '건축팀', deptLead: '', joinDate: '2026-11-02', notes: '', notified: false, deptNotified: false });
await A.loadRowSyncSheets_();
await A.flushRowSync_();
check('새 기록 저장 시 rev 1', server.Onboardings['1']?.rev === '1' && A.onboardings[0].rev === 1, server.Onboardings['1']);
await B.loadRowSyncSheets_();
check('다른 PC가 rev 포함해 불러옴', B.onboardings.length === 1 && B.onboardings[0].rev === 1);

// 같은 기록의 다른 칸을 두 PC가 고침 — A가 먼저 저장, B는 변경 이력을 받기 전에 저장
A.onboardings[0].deptLead = 'lead@x.com';
B.onboardings[0].notes = 'B 메모';
let mark = feed.length;
await A.flushRowSync_();
await B.flushRowSync_();
let row = server.Onboardings['1'];
check('충돌 시 두 수정이 모두 남음', row.deptLead === 'lead@x.com' && row.notes === 'B 메모', row);
check('충돌 병합 후 rev 3', row.rev === '3', row.rev);
check('B 화면도 병합 결과와 rev 3', B.onboardings[0].deptLead === 'lead@x.com' && B.onboardings[0].rev === 3, B.onboardings[0]);
check('자동 병합은 충돌 알림을 띄우지 않음', B.conflictNotices === 0);
deliver(A, mark);
check('A는 변경 이력으로 병합 결과를 받음', A.onboardings[0].notes === 'B 메모' && A.onboardings[0].rev === 3, A.onboardings[0]);
await A.flushRowSync_();
check('받은 내용은 다시 올리지 않음', server.Onboardings['1'].rev === '3');

// 같은 칸을 둘 다 고치면 나중 저장이 반영
A.onboardings[0].dept = '토목팀';
B.onboardings[0].dept = '전기팀';
await A.flushRowSync_();
await B.flushRowSync_();
check('같은 칸은 나중 저장 반영', server.Onboardings['1'].dept === '전기팀');

// 변경 이력 도착 시 이 PC의 미저장 수정은 덮어쓰지 않고 합친다
mark = feed.length;
B.onboardings[0].joinTime = '09:30';
A.onboardings[0].rev = Number(server.Onboardings['1'].rev);
A.onboardings[0].dept = '전기팀';
A.onboardings[0].notes = 'A 메모';
await A.flushRowSync_();
deliver(B, mark);
check('미저장 수정 유지 + 다른 PC 수정 반영', B.onboardings[0].joinTime === '09:30' && B.onboardings[0].notes === 'A 메모', B.onboardings[0]);
await B.flushRowSync_();
row = server.Onboardings['1'];
check('미저장 수정이 충돌 없이 저장', row.joinTime === '09:30' && row.notes === 'A 메모', row);

// 자기 저장의 늦은 회신(예전 rev)은 무시
const staleEcho = { sheet: 'Onboardings', action: 'upsert', id: '1', data: { ...row, rev: '1', notes: '예전 값' } };
B.applyRowSyncChange_('Onboardings', staleEcho);
check('예전 rev 변경 이력은 무시', B.onboardings[0].notes === 'A 메모');

// 처우 기록: 객체 칸(allowanceItems) 포함 병합
mark = feed.length;
A.offers.push({ candId: 10, candName: '홍길동', salary: '5000', allowanceItems: { 식대: '20' }, healthStatus: '' });
await A.flushRowSync_();
deliver(B, mark);
check('처우 기록 전달', B.offers.length === 1 && B.offers[0].allowanceItems.식대 === '20', B.offers);
A.offers[0].salary = '5200';
B.offers[0].healthStatus = '완료';
await A.flushRowSync_();
await B.flushRowSync_();
const offer = server.Offers['10'];
check('처우 기록 병합', offer.salary === '5200' && offer.healthStatus === '완료' && JSON.parse(offer.allowanceItems).식대 === '20', offer);

// 레퍼런스 결과 정리(RefReports): 화면에서는 지원자 id를 키로 한 객체
mark = feed.length;
A.refReports[10] = { candId: 10, candName: '홍길동', overall: '추천', expertise: '', updatedAt: '2026. 10. 8. 오후 3:00:00', updatedBy: 'admin' };
await A.flushRowSync_();
check('예전 저장 시각은 savedAt으로 옮겨 저장', server.RefReports['10']?.savedAt === '2026. 10. 8. 오후 3:00:00' && server.RefReports['10']?.rev === '1', server.RefReports['10']);
deliver(B, mark);
check('다른 PC에 새 결과 정리가 객체로 추가됨', B.refReports['10']?.overall === '추천' && B.refReports['10']?.rev === 1, B.refReports);
A.refReports[10].expertise = '구조 설계 강점';
B.refReports['10'].character = '꼼꼼함';
await A.flushRowSync_();
await B.flushRowSync_();
const report = server.RefReports['10'];
check('결과 정리 동시 수정 병합', report.expertise === '구조 설계 강점' && report.character === '꼼꼼함' && report.overall === '추천', report);
mark = feed.length;
delete A.refReports[10];
await A.flushRowSync_();
check('지운 결과 정리는 서버에서도 삭제', !server.RefReports['10']);

// 알림·활동 기록(NotifyLog·ActivityLog): 추가만 하는 최신순 목록
{
  const legacy = [
    { ch: 'Gmail', type: '면접안내', target: '홍길동', to: 'a@x.com', time: '오후 02:30', date: '2026-10-08' },
    { ch: 'Gmail', type: '불합격', target: '김철수', to: 'b@x.com', time: '오전 09:05', date: '2026-10-08' },
  ];
  // 두 PC가 같은 예전 기록(설정 시트 덩어리에서 받은 것)을 가진 채 처음 줄 동기화
  const C = makePc();
  const D = makePc();
  C.notifyLog.push(...legacy.map(e => ({ ...e })));
  D.notifyLog.push(...legacy.map(e => ({ ...e })));
  await C.loadRowSyncSheets_(); await C.flushRowSync_();
  await D.loadRowSyncSheets_(); await D.flushRowSync_();
  check('예전 기록을 두 PC가 올려도 중복 없음', Object.keys(server.NotifyLog).length === 2, Object.keys(server.NotifyLog));
  check('예전 기록 정렬: 오후 2:30이 오전 9:05보다 먼저', C.notifyLog[0].time === '오후 02:30' && D.notifyLog[0].time === '오후 02:30');
  // 두 PC가 동시에 새 기록 추가 → 둘 다 남는다(예전 덩어리 방식은 나중 저장이 덮어씀)
  mark = feed.length;
  C.notifyLog.unshift({ id: C.newLogEntryId_(), ch: 'Gmail', type: 'C안내', target: 'c', to: 'c@x.com', time: '오후 03:00', date: '2026-10-09', at: '2026-10-09T06:00:00.000Z' });
  D.notifyLog.unshift({ id: D.newLogEntryId_(), ch: 'Gmail', type: 'D안내', target: 'd', to: 'd@x.com', time: '오후 03:01', date: '2026-10-09', at: '2026-10-09T06:01:00.000Z' });
  await C.flushRowSync_(); await D.flushRowSync_();
  deliver(C, mark); deliver(D, mark);
  check('두 PC의 새 기록이 모두 남음', Object.keys(server.NotifyLog).length === 4 && C.notifyLog.length === 4 && D.notifyLog.length === 4, { server: Object.keys(server.NotifyLog).length, C: C.notifyLog.length, D: D.notifyLog.length });
  check('최신 기록이 맨 앞', C.notifyLog[0].type === 'D안내' && D.notifyLog[0].type === 'D안내', [C.notifyLog[0].type, D.notifyLog[0].type]);
  // 최대 개수(활동 기록 300) 초과분은 지워지고 시트에서도 삭제
  for (let i = 0; i < 305; i++) C.activityLog.unshift({ id: 'A' + i, action: '테스트', detail: String(i), time: '오전 10:00', date: '2026-10-09', at: new Date(Date.parse('2026-10-09T01:00:00Z') + i * 1000).toISOString() });
  C.ROW_SYNC_SHEETS_.ActivityLog.set(C.ROW_SYNC_SHEETS_.ActivityLog.list());
  await C.flushRowSync_();
  check('활동 기록은 최대 300개만 유지', C.activityLog.length === 300 && C.activityLog[0].id === 'A304', { len: C.activityLog.length, first: C.activityLog[0]?.id });
  const before = { ...requests };
  C.activityLog = C.activityLog.slice(0, 290);
  await C.flushRowSync_();
  check('지운 기록은 시트에서도 삭제', Object.keys(server.ActivityLog).length === 290, Object.keys(server.ActivityLog).length);
  check('지운 기록 10건을 한 번의 요청으로 삭제', requests.deleteRows - before.deleteRows === 1 && requests.deleteRow === before.deleteRow, requests);
  // 예전 서버(deleteRows 없음)면 한 건씩 지운다
  serverKnowsDeleteRows = false;
  const beforeOld = { ...requests };
  C.activityLog = C.activityLog.slice(0, 287);
  await C.flushRowSync_();
  check('예전 서버면 한 건씩 삭제로 대신함', Object.keys(server.ActivityLog).length === 287 && requests.deleteRow - beforeOld.deleteRow === 3, { left: Object.keys(server.ActivityLog).length, requests });
  serverKnowsDeleteRows = true;
}

console.log(`Row sync tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
