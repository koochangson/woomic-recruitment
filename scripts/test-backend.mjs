// 서버(Apps Script) 함수 동작 테스트 — 실제 Code.gs를 Node VM에서 실행하고 Apps Script 서비스는 가짜로 대신한다.
// 대상: 관리자 비밀번호 해시·로그인, 담당자 메일 중복 방지, 추천인 등록(잠금 밖 메일 발송), _Changes 커서 읽기.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { adminGsSource, publicGsSource, sharedBackendSource } from '../tools/project_paths.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

// Utilities.formatDate 흉내: 시간대별로 yyyy·MM·dd·HH·mm·ss·SSS·M·d와 '글자'만 처리한다.
function formatDateMock(date, timeZone, pattern) {
  const d = new Date(date);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  const values = { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, SSS: String(d.getUTCMilliseconds()).padStart(3, '0'), M: String(Number(parts.month)), d: String(Number(parts.day)) };
  return String(pattern).replace(/'([^']*)'|yyyy|SSS|MM|dd|HH|mm|ss|M|d/g, (token, literal) => (literal !== undefined ? literal : values[token]));
}
const toSigned = buf => Array.from(buf).map(v => (v > 127 ? v - 256 : v));
const toBuf = arr => Buffer.from(arr.map(v => v & 0xff));

// 가짜 Apps Script 환경. state로 메일 발송·잠금 상태를 들여다본다.
function loadBackend(gsPath) {
  const state = { props: {}, cache: {}, mails: 0, mailFail: false, lockHeld: false, mailsDuringLock: 0 };
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error: console.error },
    Utilities: {
      computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      newBlob: s => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      getUuid: () => crypto.randomUUID(),
      formatDate: (date, timeZone, pattern) => formatDateMock(date, timeZone, pattern),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => state.props[k] ?? null,
      setProperty: (k, v) => { state.props[k] = v; },
      deleteProperty: k => { delete state.props[k]; },
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => state.cache[k] ?? null,
      put: (k, v) => { state.cache[k] = v; },
      remove: k => { delete state.cache[k]; },
    }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { state.lockHeld = true; },
      tryLock: () => { state.lockHeld = true; return true; },
      releaseLock: () => { state.lockHeld = false; },
    }) },
    ContentService: { createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 'json' } },
    MailApp: { sendEmail: () => {
      if (state.lockHeld) state.mailsDuringLock++;
      if (state.mailFail) throw new Error('quota');
      state.mails++;
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(sharedBackendSource, 'utf8') + '\n' + fs.readFileSync(gsPath, 'utf8'), ctx);
  return { ctx, state, run: code => vm.runInContext(code, ctx) };
}

// ── 관리자 비밀번호 ─────────────────────────────────────────
{
  const { ctx, state, run } = loadBackend(adminGsSource);
  const saltHex = '00112233445566778899aabbccddeeff';
  check('PBKDF2 결과가 표준과 같음',
    run(`pbkdf2Sha256Hex_('pässword', hexToBytes_('${saltHex}'), 2000)`) === crypto.pbkdf2Sync('pässword', Buffer.from(saltHex, 'hex'), 2000, 32, 'sha256').toString('hex'));
  const hash = run(`makeAdminPasswordHash('secret1')`);
  check('새 해시 형식 v2', /^v2\$\d+\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(hash), hash);
  check('같은 비밀번호도 솔트가 달라 해시가 다름', hash !== run(`makeAdminPasswordHash('secret1')`));

  Object.assign(ctx, { isAdminLoginLocked_: () => false, recordAdminLoginFailure_: () => {}, purgeExpiredAdminSessions_: () => {}, saveAdminSession_: () => {} });
  const legacy = crypto.createHash('sha256').update('pw-admin').digest('hex');
  const other = crypto.createHash('sha256').update('pw-other').digest('hex');
  state.props.RECRUITMENT_LOCAL_ADMIN_USERS = `admin:${legacy}, 12345:${other}`;
  const login = (id, pw) => run(`adminLogin_(${JSON.stringify({ data: { loginId: id, password: pw } })})`);
  check('틀린 비밀번호 거절', login('admin', 'wrong').ok === false);
  check('예전 SHA-256 해시로 로그인', login('admin', 'pw-admin').ok === true);
  check('로그인한 계정만 v2로 전환', /admin:v2\$/.test(state.props.RECRUITMENT_LOCAL_ADMIN_USERS) && state.props.RECRUITMENT_LOCAL_ADMIN_USERS.includes(`12345:${other}`));
  check('전환 후 로그인', login('admin', 'pw-admin').ok === true);
  check('전환 후 틀린 비밀번호 거절', login('admin', 'pw-admin2').ok === false);
}

// ── 시트 날짜 칸: 한국 시간 자정 날짜는 yyyy-MM-dd로(하루 밀림 방지), 시각이 있으면 예전처럼 UTC 시각 ──
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { ctx, run } = loadBackend(gsPath);
  ctx.Session = { getScriptTimeZone: () => 'Asia/Seoul' };
  check(`${label}: 날짜만 있는 칸은 한국 날짜 그대로`, run(`normalizeCell_(new Date('2026-11-01T15:00:00.000Z'))`) === '2026-11-02');
  check(`${label}: 시각이 있는 칸은 UTC 시각 유지`, run(`normalizeCell_(new Date('2026-10-20T05:00:00.000Z'))`) === '2026-10-20T05:00:00.000Z');
  check(`${label}: 날짜가 아닌 값은 그대로`, run(`normalizeCell_('2026-11-02')`) === '2026-11-02' && run('normalizeCell_(null)') === '');
}
{
  const { run } = loadBackend(adminGsSource);
  check('운영 알림: 날짜만 있는 값은 한국 날짜 기준', run(`opsDateKey_('2026-11-02')`) === '2026-11-02' && run(`opsDateKey_('2026-11-01T15:00:00.000Z')`) === '2026-11-02');
}

// ── 사내추천 상태 표시(공개 조회 화면) ─────────────────────
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { run } = loadBackend(gsPath);
  const labels = run(`['PASSED','FAILED','WITHDRAWN','HIRED'].map(compactReferralStatus_)`);
  check(`${label}: 합격·불합격·철회 상태 표시`, JSON.stringify(labels) === JSON.stringify(['합격', '불합격', '종료', '입사']), labels);
}

// ── 담당자 메일 중복 방지 ───────────────────────────────────
{
  const { ctx, state, run } = loadBackend(adminGsSource);
  Object.assign(ctx, { isAdminRequest_: () => true, generalMailHtml_: () => '<p>hi</p>', htmlToPlainText_: () => 'hi', logMailSend_: () => {} });
  const body = { toEmail: 'a@b.com', subject: 'S', templateType: 'general_notice', noticeBody: 'x' };
  const send = b => run(`handleSendGeneralMail_(${JSON.stringify({ data: b })})`);
  check('첫 발송', send(body).ok === true && state.mails === 1);
  const dup = send(body);
  check('같은 메일 재요청 차단', dup.error === 'duplicate_recent' && dup.state === 'sent' && state.mails === 1, dup);
  check('세션 토큰은 비교에서 제외', send({ ...body, sessionToken: 'z' }).error === 'duplicate_recent');
  check('확인 후 재발송(allowDuplicate)', send({ ...body, allowDuplicate: true }).ok === true && state.mails === 2);
  check('다른 수신자는 발송', send({ ...body, toEmail: 'c@d.com' }).ok === true && state.mails === 3);
  state.mailFail = true;
  const failed = send({ ...body, subject: 'F' });
  state.mailFail = false;
  check('발송 실패는 오류로 반환', !!failed.error && failed.error !== 'duplicate_recent', failed);
  check('실패한 메일은 바로 다시 보낼 수 있음', send({ ...body, subject: 'F' }).ok === true);
}

// ── 추천인 등록: 시트 기록은 잠금 안, 메일은 잠금 밖 ─────────
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { ctx, state, run } = loadBackend(gsPath);
  const candidates = [{ id: 'RC1', token: 'tok', candName: '홍길동', pipelineCandId: 7, positionText: 'P', refereesSubmittedAt: '' }];
  Object.assign(ctx, {
    ensureSheet_: () => ({ appendRow: () => {}, getRange: () => ({ setValue: () => {} }) }),
    ensureHeaders_: (s, h) => h,
    findRowIndex_: () => 2,
    readRows_: name => (name === 'ReferenceCandidates' ? candidates : []),
    candidateProcessClosed_: () => false,
    referenceLinkExpired_: () => false,
    appendChange_: () => {},
    logMailSend_: () => {},
    buildReferenceResponseLinkUrl_: t => 'https://example.invalid/' + t,
    referenceMailHtml_: m => '<p>' + m + '</p>',
  });
  const referees = [1, 2, 3].map(i => ({ name: 'R' + i, email: `r${i}@x.com`, phone: '010-0000-000' + i, relation: '동료', company: 'C' }));
  const submit = refs => run(`submitReferenceCandidateReferees_(${JSON.stringify({ data: { token: 'tok', referees: refs } })})`);
  let r = submit(referees);
  check(`${label}: 등록 성공과 메일 건수`, r.ok === true && r.count === 3 && r.mailSent === 3 && r.mailFailed === 0, r);
  check(`${label}: 잠금 중에는 메일을 보내지 않음`, state.mailsDuringLock === 0 && state.mails === 3);
  state.mailFail = true;
  r = submit(referees);
  state.mailFail = false;
  check(`${label}: 메일 실패 건수 반환`, r.ok === true && r.mailFailed === 3, r);
  candidates[0].refereesSubmittedAt = '2026-10-08T00:00:00Z';
  check(`${label}: 이미 제출한 링크 재제출 차단`, submit(referees).error === 'already_submitted');
  check(`${label}: 오류도 JSON으로 반환`, submit(referees.slice(0, 2)).error === 'exactly_three_referees_required');
}

// ── 추천인 응답 제출: 완료 메일 없이 화면에서 안내 ─────────────
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { ctx, state, run } = loadBackend(gsPath);
  const responses = [{ id: 'RR1', token: 'rt', candName: '홍길동', refereeName: 'R1', refereeEmail: 'r1@x.com', verifiedAt: '2026-10-08T00:00:00Z', submittedAt: '' }];
  Object.assign(ctx, {
    ensureSheet_: () => ({ getRange: () => ({ setValues: () => {}, setValue: () => {} }) }),
    ensureHeaders_: (s, h) => h,
    findRowIndex_: () => 2,
    readRows_: name => (name === 'ReferenceResponses' ? responses : []),
    candidateProcessClosed_: () => false,
    referenceLinkExpired_: () => false,
    appendChange_: () => {},
  });
  const r = run(`submitReferenceResponseUnlocked_(${JSON.stringify({ data: { token: 'rt', answers: { q9_word: '성실' } } })})`);
  check(`${label}: 응답 제출 성공`, r.ok === true, r);
  check(`${label}: 추천인에게 완료 메일을 보내지 않음`, state.mails === 0);
}

// ── 사내추천 접수: 접수 완료 메일 없이 화면에서 안내 ─────────────
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { run } = loadBackend(gsPath);
  check(`${label}: 사내추천 접수 완료 메일 함수 없음`, run("typeof sendReferralReceipt_") === 'undefined');
}
check('사내추천 접수 저장 경로에서 완료 메일을 부르지 않음',
  ![adminGsSource, publicGsSource].some(file => /sendReferralReceipt_|receipts.forEach/.test(fs.readFileSync(file, 'utf8'))));

// ── _Changes 개인정보 최소화 + 응답 시 최신 행 복원 ──────────
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { ctx, run } = loadBackend(gsPath);
  const headers = ['id', 'name', 'email', 'rev'];
  const rows = [
    ['1', '홍길동', 'one@example.com', '1'],
    ['2', '김우미', 'two@example.com', '3'],
  ];
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: (row, col, count, width) => ({
      getValues: () => Array.from({ length: count }, (_, offset) => {
        const source = rows[row - 2 + offset] || [];
        return width === 1 ? [source[col - 1]] : source.slice(col - 1, col - 1 + width);
      }),
    }),
  };
  ctx.SHEET_SCHEMAS = { Candidates: headers };
  Object.assign(ctx, { ensureSheet_: () => sheet, ensureHeaders_: () => headers });
  const compact = run(`compactChangeLogData_({id:'2',name:'김우미',email:'two@example.com'})`);
  check(`${label}: 변경 로그 메타데이터에 개인정보 값 없음`,
    JSON.stringify(compact) === JSON.stringify({ fields: ['email', 'id', 'name'] }) && !JSON.stringify(compact).includes('example.com'), compact);
  const hydrated = run(`hydrateChangesForClient_([
    {cursor:1,sheet:'Candidates',action:'upsert',id:'2',data:{fields:['name']}},
    {cursor:2,sheet:'Candidates',action:'upsert',id:'3',data:{fields:['name']}},
    {cursor:3,sheet:'Candidates',action:'delete',id:'1',data:{email:'old@example.com'}}
  ])`);
  check(`${label}: 변경 응답은 원본 시트의 최신 행으로 복원`, hydrated[0].data.email === 'two@example.com' && hydrated[0].data.rev === '3', hydrated[0]);
  check(`${label}: 이미 사라진 행은 삭제 이벤트로 변환`, hydrated[1].action === 'delete' && Object.keys(hydrated[1].data).length === 0, hydrated[1]);
  check(`${label}: 삭제 이벤트에 과거 개인정보를 반환하지 않음`, Object.keys(hydrated[2].data).length === 0, hydrated[2]);
}
{
  const { ctx, run } = loadBackend(adminGsSource);
  const headers = ['cursor', 'timestamp', 'sheet', 'action', 'id', 'actorEmail', 'result', 'data'];
  const stored = [
    JSON.stringify({ id: '1', name: '홍길동', email: 'one@example.com' }),
    JSON.stringify({ fields: ['id', 'name'] }),
    JSON.stringify({ id: '2', phone: '01012345678' }),
    JSON.stringify({ id: '3', memo: '민감한 메모' }),
  ];
  const sheet = {
    getLastRow: () => stored.length + 1,
    getLastColumn: () => headers.length,
    getRange: (row, col, count) => ({
      getValues: () => row === 1 ? [headers] : stored.slice(row - 2, row - 2 + count).map(value => [value]),
      setValues: values => values.forEach((value, index) => { stored[row - 2 + index] = value[0]; }),
    }),
  };
  ctx.getMainSpreadsheet_ = () => ({ getSheetByName: () => sheet });
  let result = run(`compactStoredChangeLogValues_('_Changes', 2)`);
  check('기존 변경 로그는 제한된 배치만 정리', result.compacted === 2 && result.remaining === true, result);
  check('기존 변경 로그 정리 후 개인정보 값 없음', !stored.slice(0, 3).join('|').includes('example.com') && !stored.slice(0, 3).join('|').includes('01012345678'), stored);
  result = run(`compactStoredChangeLogValues_('_Changes', 2)`);
  check('다음 실행에서 남은 변경 로그 정리', result.compacted === 1 && result.remaining === false && !stored.join('|').includes('민감한 메모'), result);
}

// ── _Changes 커서: 끝부분만 읽어도 전체를 읽은 결과와 같아야 한다 ──
function referencePage(cursors, requested, limit) {
  const matches = [];
  let latest = 0;
  cursors.forEach((c, index) => { if (c > latest) latest = c; if (c > requested) matches.push({ index, cursor: c }); });
  matches.sort((a, b) => a.cursor - b.cursor || a.index - b.index);
  let end = Math.min(limit, matches.length);
  while (end < matches.length && matches[end].cursor === matches[end - 1].cursor) end++;
  return { ids: matches.slice(0, end).map(m => 'id' + m.index), latest, hasMore: matches.length > end };
}
for (const [label, gsPath] of [['관리자', adminGsSource], ['공개', publicGsSource]]) {
  const { ctx, run } = loadBackend(gsPath);
  let cellsRead = 0;
  let cursors = [];
  const sheet = {
    getLastRow: () => cursors.length + 1,
    getRange: (row, col, n, width) => {
      cellsRead += n * (width || 1);
      const out = [];
      for (let i = 0; i < n; i++) {
        const index = row - 2 + i;
        out.push(width === 8 ? [cursors[index], 't', 'S', 'upsert', 'id' + index, '', 'ok', '{}'] : [cursors[index]]);
      }
      return { getValues: () => out };
    },
  };
  Object.assign(ctx, { ensureChangeLogSheet_: () => sheet, getStoredChangeCursor_: () => 0 });
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let mismatches = 0;
  for (let t = 0; t < 30; t++) {
    const n = Math.floor(rnd() * 2500);
    cursors = [];
    let c = 100;
    for (let i = 0; i < n; i++) { if (rnd() > 0.05) c++; cursors.push(c); } // 같은 번호(동시 기록) 포함
    for (let k = 0; k < 5 && n > 2; k++) { // 끝부분 근처 순서 뒤바뀜
      const i = n - 1 - Math.floor(rnd() * Math.min(n - 1, 50));
      [cursors[i], cursors[i - 1]] = [cursors[i - 1], cursors[i]];
    }
    const max = n ? Math.max(...cursors) : 0;
    if (run('maxLoggedChangeCursor_(ensureChangeLogSheet_())') !== max) mismatches++;
    for (const requested of [0, max, max - 1, max - 10, Math.floor(max / 2), max + 5]) {
      for (const limit of [1, 50, 500]) {
        const got = run(`readChangePageAfter_(${requested}, ${limit})`);
        const want = referencePage(cursors, requested, limit);
        const same = JSON.stringify(got.changes.map(ch => ch.id)) === JSON.stringify(want.ids) && got.latestCursor === want.latest && got.hasMore === want.hasMore;
        if (!same) mismatches++;
      }
    }
  }
  check(`${label}: 커서 읽기 결과가 전체 스캔과 같음`, mismatches === 0, mismatches);
  cursors = Array.from({ length: 5000 }, (_, i) => i + 1);
  cellsRead = 0;
  run('readChangePageAfter_(4990, 500)');
  check(`${label}: 최근 변경 조회는 끝부분만 읽음`, cellsRead < 1000, cellsRead);
}

console.log(`Backend tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
