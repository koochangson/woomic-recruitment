/**
 * Shared runtime used by both admin and public Apps Script deployments.
 * Keep deployment-specific authorization and routing in each deployment's Code.gs.
 */

function parseJsonObject_(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function primaryKey_(sheetName) {
  return ['Employees', 'Interviewers'].includes(sheetName) ? 'email' : 'id';
}

function assertKnownSheet_(sheetName) {
  if (!SHEET_SCHEMAS[sheetName]) throw new Error('unknown_sheet: ' + sheetName);
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmpNo_(value) {
  return String(value || '').trim();
}

function normalizePhone_(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

// 시트가 '2026-11-02' 같은 글자를 날짜로 바꿔 저장한 칸은 Date로 읽힌다. 예전에는 UTC 시각
// (2026-11-01T15:00:00.000Z)으로 돌려줘 화면에서 앞 10자리를 쓰면 하루 전 날짜로 보였다.
// 한국 시간 자정(시각 없는 날짜)이면 화면이 쓰는 형식 그대로 'yyyy-MM-dd'로 돌려주고, 시각이 있으면 예전처럼 UTC 시각으로 둔다.
function normalizeCell_(value) {
  if (value instanceof Date) {
    const timeZone = sheetDateTimeZone_();
    if (Utilities.formatDate(value, timeZone, 'HH:mm:ss.SSS') === '00:00:00.000') return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
    return Utilities.formatDate(value, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  }
  return value == null ? '' : value;
}

let SHEET_DATE_TIME_ZONE_ = '';
function sheetDateTimeZone_() {
  if (!SHEET_DATE_TIME_ZONE_) {
    try { SHEET_DATE_TIME_ZONE_ = Session.getScriptTimeZone() || 'Asia/Seoul'; } catch (err) { SHEET_DATE_TIME_ZONE_ = 'Asia/Seoul'; }
  }
  return SHEET_DATE_TIME_ZONE_;
}

function pickFirst_(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = row[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function getFirstSettingValue_(keys) {
  const settings = readRowsIfSheetExists_('Settings');
  for (let i = 0; i < keys.length; i++) {
    const target = String(keys[i] || '');
    const row = settings.find(item => String(item.id || '').trim() === target);
    if (row && String(row.value || '').trim()) return String(row.value).trim();
  }
  return '';
}

function nowIso_() {
  return new Date().toISOString();
}

function isPublicDeployment_() {
  return getScriptProperty_(DEPLOYMENT_ROLE_PROPERTY).toLowerCase() === 'public';
}

function getScriptProperty_(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getActiveUserEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (err) {
    return '';
  }
}

// _Changes에는 동기화에 필요한 변경 힌트만 남긴다. 실제 값은 getChanges 응답을 만들 때
// 원본 시트에서 다시 읽으므로 이름·이메일·연락처 같은 개인정보가 변경 이력에 복제되지 않는다.
function compactChangeLogData_(data) {
  const source = data && typeof data === 'object' ? data : {};
  return { fields: Object.keys(source).sort() };
}

// 키 열은 한 번만 스캔하고, 요청된 행 본문만 연속 구간 단위로 읽는다.
function readSheetRowsByIds_(sheet, headers, key, ids) {
  const targets = new Set((ids || []).map(function(id) { return String(id || '').trim(); }).filter(Boolean));
  const keyIndex = headers.indexOf(key);
  const lastRow = sheet.getLastRow();
  if (!targets.size || keyIndex < 0 || lastRow < 2) return { lastRow: lastRow, rows: {} };

  const keyValues = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  const rowNumbers = [];
  keyValues.forEach(function(values, index) {
    if (targets.has(String(values[0] || '').trim())) rowNumbers.push(index + 2);
  });
  if (!rowNumbers.length) return { lastRow: lastRow, rows: {} };

  const ranges = [];
  rowNumbers.forEach(function(rowNumber) {
    const current = ranges[ranges.length - 1];
    if (current && current.start + current.count === rowNumber) current.count++;
    else ranges.push({ start: rowNumber, count: 1 });
  });

  const result = {};
  ranges.forEach(function(range) {
    sheet.getRange(range.start, 1, range.count, headers.length).getValues().forEach(function(values, offset) {
      const id = String(values[keyIndex] || '').trim();
      if (id) result[id] = { rowNumber: range.start + offset, values: values };
    });
  });
  return { lastRow: lastRow, rows: result };
}

// 기존 행은 실제로 바뀐 연속 구간만 쓰고, 신규 행은 마지막에 한 묶음으로 추가한다.
// 배치 일부를 저장할 때 시트 전체를 다시 써서 다른 배포의 동시 변경을 덮는 일을 피한다.
function writeBatchRows_(sheet, columnCount, rowsById, newIds, lastRow) {
  const existing = Object.keys(rowsById || {}).map(function(id) { return rowsById[id]; })
    .filter(function(record) { return Number(record && record.rowNumber) >= 2; })
    .sort(function(a, b) { return a.rowNumber - b.rowNumber; });
  const ranges = [];
  existing.forEach(function(record) {
    const current = ranges[ranges.length - 1];
    if (current && current.start + current.values.length === record.rowNumber) current.values.push(record.values);
    else ranges.push({ start: record.rowNumber, values: [record.values] });
  });
  ranges.forEach(function(range) {
    sheet.getRange(range.start, 1, range.values.length, columnCount).setValues(range.values);
  });

  const additions = (newIds || []).map(function(id) { return rowsById[id]; })
    .filter(Boolean)
    .map(function(record) { return record.values; });
  if (additions.length) sheet.getRange(Math.max(2, Number(lastRow) + 1), 1, additions.length, columnCount).setValues(additions);
}

// Apps Script 요청 한 번 안에서만 유지되는 캐시다. 배포별 시트 라우팅은 각 Code.gs에 남기고,
// 공통 시트 접근 함수는 이 캐시를 함께 사용한다.
const EXEC_CACHE_ = { spreadsheets: {}, sheets: {}, headers: new Map() };
const CHANGE_CURSOR_TAIL_ROWS = 200;
const CHANGE_READ_CHUNK_ROWS = 500;

function ensureHeaders_(sheet, schema) {
  if (!schema || !schema.length) throw new Error('missing_schema');
  const cached = EXEC_CACHE_.headers.get(sheet);
  if (cached && schema.every(header => cached.includes(header))) return cached.slice();
  const resolved = ensureHeadersUncached_(sheet, schema);
  EXEC_CACHE_.headers.set(sheet, resolved.slice());
  return resolved;
}

function ensureHeadersUncached_(sheet, schema) {
  const lastColumn = Math.max(sheet.getLastColumn(), schema.length);
  let headers = [];
  if (sheet.getLastRow() >= 1 && lastColumn > 0) {
    headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(v => String(v || '').trim());
  }
  if (!headers.filter(Boolean).length) {
    sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
    return schema.slice();
  }
  const next = headers.slice();
  schema.forEach(header => {
    if (!next.includes(header)) next.push(header);
  });
  if (next.length !== headers.length) {
    sheet.getRange(1, 1, 1, next.length).setValues([next]);
  }
  return next;
}

function readRows_(sheetName) {
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = normalizeCell_(row[index]);
    });
    return obj;
  }).filter(row => String(row[primaryKey_(sheetName)] || '').trim());
}

function schemaRow_(sheetName, row) {
  const schema = SHEET_SCHEMAS[sheetName];
  const result = {};
  schema.forEach(key => {
    result[key] = row[key] == null ? '' : row[key];
  });
  return result;
}

function revisionState_(sheetName, headers, existingValues, source) {
  const enabled = REVISIONED_SHEETS.includes(sheetName);
  if (!enabled) return { enabled: false, conflict: false, expected: 0, current: 0 };
  const revIndex = headers.indexOf('rev');
  const current = existingValues && revIndex >= 0 ? Number(existingValues[revIndex]) || 0 : 0;
  const expected = Number(source && source.rev) || 0;
  return {
    enabled: true,
    conflict: !!existingValues && expected !== current,
    expected,
    current
  };
}

function rowObjectFromValues_(headers, values) {
  const result = {};
  (headers || []).forEach(function(header, index) {
    result[header] = normalizeCell_((values || [])[index]);
  });
  return result;
}

function findRowIndex_(sheet, key, id, headers) {
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error('missing_key_column');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  const target = String(id);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
  }
  return -1;
}

// 행 번호를 찾은 뒤 실제로 쓰기 전에 다른 프로젝트가 행을 지우면(관리자·공개 프로젝트는 스크립트 잠금이 서로 다르다)
// 번호가 밀려 엉뚱한 행에 쓸 수 있다. 쓰기 직전에 그 행의 키 값을 다시 확인하고, 다르면 다시 찾는다. 행이 없으면 -1.
function confirmRowIndex_(sheet, headers, key, value, rowIndex) {
  const keyIndex = headers.indexOf(key);
  if (keyIndex >= 0 && rowIndex >= 2 && rowIndex <= sheet.getLastRow()
      && String(sheet.getRange(rowIndex, keyIndex + 1).getValue()) === String(value)) {
    return rowIndex;
  }
  return findRowIndex_(sheet, key, value, headers);
}

function appendChange_(sheetName, action, id, data) {
  appendChanges_([{ sheetName, action, id, data }]);
}

function appendChanges_(changes) {
  const source = Array.isArray(changes) ? changes : [];
  if (!source.length) return;
  const sheet = ensureChangeLogSheet_();
  const firstCursor = reserveChangeCursors_(sheet, source.length);
  const actorEmail = getActiveUserEmail_();
  const values = source.map(function(change, index) {
    return [
      firstCursor + index,
      nowIso_(),
      change.sheetName,
      change.action,
      change.id,
      actorEmail,
      'ok',
      JSON.stringify(compactChangeLogData_(change.data))
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 8).setValues(values);
}

function ensureChangeLogSheet_() {
  if (EXEC_CACHE_.changeLogSheet) return EXEC_CACHE_.changeLogSheet;
  EXEC_CACHE_.changeLogSheet = ensureChangeLogSheetUncached_();
  return EXEC_CACHE_.changeLogSheet;
}

function ensureChangeLogSheetUncached_() {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(CHANGE_LOG_SHEET);
  if (!sheet) sheet = ss.insertSheet(CHANGE_LOG_SHEET);
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['cursor','timestamp','sheet','action','id','actorEmail','result','data']);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 8)).getValues()[0].map(v => String(v || '').trim());
    const expected = ['cursor','timestamp','sheet','action','id','actorEmail','result','data'];
    let changed = false;
    expected.forEach((header, index) => {
      if (current[index] !== header) {
        current[index] = header;
        changed = true;
      }
    });
    if (changed) sheet.getRange(1, 1, 1, expected.length).setValues([current.slice(0, expected.length)]);
  }
  return sheet;
}

function openSpreadsheetCached_(url) {
  const key = url || '__active__';
  if (!EXEC_CACHE_.spreadsheets[key]) {
    EXEC_CACHE_.spreadsheets[key] = url ? SpreadsheetApp.openByUrl(url) : SpreadsheetApp.getActiveSpreadsheet();
  }
  return EXEC_CACHE_.spreadsheets[key];
}

function getMainSpreadsheet_() {
  return openSpreadsheetCached_(getScriptProperty_(RECRUITMENT_SPREADSHEET_URL_PROPERTY));
}

function getChangeCursor_() {
  const sheet = ensureChangeLogSheet_();
  return Math.max(getStoredChangeCursor_(sheet), maxLoggedChangeCursor_(sheet));
}

function reserveChangeCursors_(sheet, count) {
  const size = Math.max(0, Number(count) || 0);
  const current = Math.max(getStoredChangeCursor_(sheet), maxLoggedChangeCursor_(sheet));
  if (!size) return current + 1;
  PropertiesService.getScriptProperties().setProperty(CHANGE_CURSOR_PROPERTY, String(current + size));
  return current + 1;
}

function maxLoggedChangeCursor_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const count = Math.min(lastRow - 1, CHANGE_CURSOR_TAIL_ROWS);
  return sheet.getRange(lastRow - count + 1, 1, count, 1).getValues().reduce(function(max, row) {
    const value = Number(row[0]) || 0;
    return value > max ? value : max;
  }, 0);
}

function getStoredChangeCursor_(sheet) {
  const properties = PropertiesService.getScriptProperties();
  const stored = Number(properties.getProperty(CHANGE_CURSOR_PROPERTY));
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const lastRow = sheet.getLastRow();
  const existing = lastRow < 2
    ? 0
    : Math.max.apply(null, sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(row) {
        return Number(row[0]) || 0;
      }));
  properties.setProperty(CHANGE_CURSOR_PROPERTY, String(existing));
  return existing;
}

function readChangesAfter_(cursor, limit) {
  return readChangePageAfter_(cursor, limit).changes;
}

function readChangePageAfter_(cursor, limit) {
  const sheet = ensureChangeLogSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { changes: [], latestCursor: 0, hasMore: false };
  const requestedCursor = Number(cursor) || 0;
  const pageSize = Math.max(1, Number(limit) || 500);
  let latestCursor = 0;
  const matches = [];
  let end = lastRow - 1;
  while (end > 0) {
    const start = Math.max(0, end - CHANGE_READ_CHUNK_ROWS);
    const chunk = sheet.getRange(start + 2, 1, end - start, 1).getValues();
    let reachedOlder = false;
    chunk.forEach(function(row, offset) {
      const value = Number(row[0]) || 0;
      if (value > latestCursor) latestCursor = value;
      if (Number(row[0]) > requestedCursor) matches.push({ index: start + offset, cursor: value });
      else reachedOlder = true;
    });
    if (reachedOlder) break;
    end = start;
  }
  if (!matches.length) return { changes: [], latestCursor: latestCursor, hasMore: false };
  matches.sort(function(a, b) { return a.cursor - b.cursor || a.index - b.index; });
  let pageEnd = Math.min(pageSize, matches.length);
  while (pageEnd < matches.length && matches[pageEnd].cursor === matches[pageEnd - 1].cursor) pageEnd++;
  const page = matches.slice(0, pageEnd);
  const firstIndex = Math.min.apply(null, page.map(function(item) { return item.index; }));
  const lastIndex = Math.max.apply(null, page.map(function(item) { return item.index; }));
  const values = sheet.getRange(firstIndex + 2, 1, lastIndex - firstIndex + 1, 8).getValues();
  const changes = page.map(function(item) {
    const row = values[item.index - firstIndex];
    return {
      cursor: Number(row[0]),
      timestamp: normalizeCell_(row[1]),
      sheet: String(row[2] || ''),
      action: String(row[3] || ''),
      id: String(row[4] || ''),
      actorEmail: String(row[5] || ''),
      result: String(row[6] || ''),
      data: parseJsonObject_(row[7])
    };
  });
  return { changes: changes, latestCursor: Math.max(latestCursor, getStoredChangeCursor_(sheet)), hasMore: matches.length > page.length };
}

// 지정한 id의 행만 객체로 읽는다. 변경 이력 응답 복원 등 읽기 전용 경로에서 사용한다.
function readRowsByIds_(sheetName, ids) {
  assertKnownSheet_(sheetName);
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const loaded = readSheetRowsByIds_(sheet, headers, key, ids);
  const result = {};
  Object.keys(loaded.rows).forEach(function(id) {
    result[id] = rowObjectFromValues_(headers, loaded.rows[id].values);
  });
  return result;
}

// 변경분 조회(getAll의 since=시각)용: 변경 이력 끝에서부터 거꾸로 읽어 since 이후 바뀐 그 시트의 id를 모은다.
// 두 프로젝트가 번갈아 기록해 시각 순서가 조금 어긋날 수 있으므로 since보다 CHANGE_TIME_SLACK_MS 더 이른
// 기록을 만나야 '빠짐없이 모았다(complete)'고 본다. 그 전에 이력 맨 앞에 닿으면(오래된 이력이 아카이브됨)
// complete=false — 호출하는 쪽은 예전처럼 시트 전체를 읽는다.
const CHANGE_TIME_SLACK_MS = 10 * 60 * 1000;
function changedIdsSince_(sheetName, sinceTime) {
  const sheet = ensureChangeLogSheet_();
  const lastRow = sheet.getLastRow();
  const ids = {};
  if (lastRow < 2) return { ids: [], complete: false };
  let end = lastRow - 1;
  while (end > 0) {
    const start = Math.max(0, end - CHANGE_READ_CHUNK_ROWS);
    const rows = sheet.getRange(start + 2, 1, end - start, 5).getValues();
    let reachedOlder = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const time = new Date(normalizeCell_(rows[i][1])).getTime();
      if (!Number.isFinite(time)) continue;
      if (time < sinceTime - CHANGE_TIME_SLACK_MS) { reachedOlder = true; continue; }
      if (String(rows[i][2]) !== sheetName) continue;
      // 시트 통째 교체(replaceAll)는 행별 기록이 없으므로 바뀐 행을 알 수 없다 — 전체 읽기로 처리하게 한다.
      if (String(rows[i][3]) === 'replaceAll') return { ids: [], complete: false };
      if (String(rows[i][3]) === 'upsert') {
        const id = String(rows[i][4] || '').trim();
        if (id) ids[id] = true;
      }
    }
    if (reachedOlder) return { ids: Object.keys(ids), complete: true };
    end = start;
  }
  return { ids: Object.keys(ids), complete: false };
}

// id로 한 행만 읽는다(키 열만 훑고 그 행만 가져온다). 시트가 없으면 만들지 않고 null.
// 행 하나를 보려고 시트 전체를 읽던 상태 확인(지원자·포지션 종료 여부 등)에 쓴다.
function readRowByIdIfSheetExists_(sheetName, id) {
  if (id === '' || id == null) return null;
  if (!getSpreadsheetForSheet_(sheetName).getSheetByName(sheetName)) return null;
  return readRowsByIds_(sheetName, [id])[String(id).trim()] || null;
}

// 저장 로그의 메타데이터를 클라이언트에 그대로 보내지 않고 현재 원본 행으로 채운다.
// 로그 뒤에 행이 삭제됐다면 삭제 이벤트로 바꿔 오래된 개인정보가 다시 살아나지 않게 한다.
function hydrateChangesForClient_(changes) {
  const result = (Array.isArray(changes) ? changes : []).map(function(change) {
    return Object.assign({}, change, { data: {} });
  });
  const idsBySheet = {};
  result.forEach(function(change) {
    if (change.action !== 'upsert' || !SHEET_SCHEMAS[change.sheet]) return;
    if (!idsBySheet[change.sheet]) idsBySheet[change.sheet] = [];
    idsBySheet[change.sheet].push(change.id);
  });

  const rowsBySheet = {};
  Object.keys(idsBySheet).forEach(function(sheetName) {
    rowsBySheet[sheetName] = readRowsByIds_(sheetName, idsBySheet[sheetName]);
  });
  result.forEach(function(change) {
    if (change.action !== 'upsert' || !rowsBySheet[change.sheet]) return;
    const row = rowsBySheet[change.sheet][String(change.id || '').trim()];
    if (row) change.data = row;
    else change.action = 'delete';
  });
  return result;
}

function compactRewardStatus_(status) {
  const map = {
    SCHEDULED: '예정',
    RETENTION_OK: '재직확인',
    REQUESTED: '지급요청',
    PAID: '지급완료',
    CANCELLED: '취소'
  };
  return map[String(status || '').toUpperCase()] || '예정';
}

function maskName_(value) {
  const text = String(value || '').trim();
  if (!text) return '후보자';
  if (text.length <= 1) return text + '*';
  return text.slice(0, 1) + '*'.repeat(Math.min(2, text.length - 1));
}

// ══════════════════════════════════════════════════════════════
// 관리자·공개 공통 처리
// 두 Code.gs에 내용이 같은 사본으로 있던 함수(공개 페이지 회신 처리, 시트 API, 사내추천 인증 등)를 한 곳에 둔다.
// 배포별로 달라야 하는 함수(라우팅·권한·메일 발송 방식·시트 선택)는 각 Code.gs에 두며 config/backend-divergence.json에 이유가 있다.
// ══════════════════════════════════════════════════════════════

function logMailSend_(to, subject, status, error, eventKey) {
  try {
    const sheet = ensureSheet_('MailLog');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.MailLog);
    const row = {
      id: 'ML-' + Utilities.getUuid(),
      eventKey: String(eventKey || ''),
      to: String(to || ''),
      subject: String(subject || ''),
      status: String(status || ''),
      error: String(error || '').slice(0, 5000),
      sentAt: nowIso_()
    };
    sheet.appendRow(headers.map(function(h) { return row[h] == null ? '' : row[h]; }));
    return true;
  } catch (err) {
    console.warn('logMailSend_ failed: ' + String(err && err.message || err));
    return false;
  }
}


function getAll_(sheetName, query) {
  const since = query && query.since ? String(query.since) : '';
  if (!since) {
    return json_({ data: readRows_(sheetName), cursor: getChangeCursor_(), serverTime: nowIso_() });
  }

  // 화면은 since로 마지막 동기화 시각(ISO)을 보낸다. 변경 이력으로 그 뒤 바뀐 행만 골라 읽는다.
  // 이력이 since까지 남아 있지 않으면(아카이브 등) 아래 예전 방식(시트 전체 읽기)으로 처리한다.
  const sinceTime = Date.parse(since);
  if (Number.isFinite(sinceTime)) {
    const changed = changedIdsSince_(sheetName, sinceTime);
    if (changed.complete) {
      const byId = changed.ids.length ? readRowsByIds_(sheetName, changed.ids) : {};
      return json_({ data: Object.keys(byId).map(id => byId[id]), cursor: getChangeCursor_(), serverTime: nowIso_() });
    }
  }
  const changedIds = {};
  const changes = readChangesAfter_(Number(since) || 0, 5000)
    .filter(change => change.sheet === sheetName);
  changes.forEach(change => { changedIds[String(change.id)] = true; });

  const key = primaryKey_(sheetName);
  const rows = readRows_(sheetName);
  const data = rows.filter(row => changedIds[String(row[key])] || String(row.updatedAt || '') >= since);
  return json_({ data, cursor: getChangeCursor_(), serverTime: nowIso_() });
}


// 쓰기 계열 함수(upsert_/batchUpsert_/replaceAll_/deleteRow_)는 모두 같은 스크립트 락을 사용한다.
// batchUpsert_는 각 행마다 다시 락을 거는 대신, 하나의 락 범위 안에서 upsertUnlocked_를 반복 호출한다
// (Apps Script의 LockService는 같은 실행 안에서 재진입을 지원하지 않으므로 중첩 획득을 피해야 한다).
function upsert_(sheetName, row, isAdmin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return upsertUnlocked_(sheetName, row, isAdmin);
  } finally {
    lock.releaseLock();
  }
}


function upsertUnlocked_(sheetName, row, isAdmin) {
  let source = Object.assign({}, row || {});

  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const id = String(source[key] || '').trim();
  if (!id) return json_({ error: 'missing_id' });

  const rowIndex = findRowIndex_(sheet, key, id, headers);
  const existingValues = rowIndex > 0
    ? sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]
    : null;
  const revision = revisionState_(sheetName, headers, existingValues, source);
  if (revision.conflict) {
    return json_({
      error: 'revision_conflict',
      id,
      expectedRev: revision.expected,
      currentRev: revision.current,
      data: rowObjectFromValues_(headers, existingValues)
    });
  }
  if (sheetName === 'Referrals') {
    source = secureReferralRowForUpsert_(source, rowIndex > 0, isAdmin);
  }

  if (revision.enabled) {
    source.rev = revision.current + 1;
    source.updatedAt = nowIso_();
  } else {
    source.updatedAt = source.updatedAt || nowIso_();
  }
  const normalized = schemaRow_(sheetName, source);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);

  appendChange_(sheetName, 'upsert', id, normalized);
  return json_({ status: 'ok', id, data: normalized, cursor: getChangeCursor_(), serverTime: nowIso_() });
}


function replaceAll_(sheetName, rows, isAdmin) {
  if (!isAdmin) throw new Error('admin_auth_required');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const source = Array.isArray(rows) ? rows : [];
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const lastRow = sheet.getLastRow();
    const revisioned = REVISIONED_SHEETS.includes(sheetName);
    const priorRevisions = {};
    if (revisioned && lastRow > 1) {
      const keyIndex = headers.indexOf(primaryKey_(sheetName));
      const revIndex = headers.indexOf('rev');
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function(values) {
        const id = String(values[keyIndex] || '').trim();
        if (id) priorRevisions[id] = Number(values[revIndex]) || 0;
      });
    }
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
    }
    const normalizedRows = source.map(row => {
      const next = Object.assign({}, row || {});
      if (revisioned) {
        const id = String(next[primaryKey_(sheetName)] || '').trim();
        next.rev = (priorRevisions[id] || 0) + 1;
        next.updatedAt = nowIso_();
      } else {
        next.updatedAt = next.updatedAt || nowIso_();
      }
      return schemaRow_(sheetName, next);
    });
    if (normalizedRows.length) {
      const values = normalizedRows.map(row => headers.map(header => row[header] == null ? '' : row[header]));
      sheet.getRange(2, 1, values.length, headers.length).setValues(values);
    }
    appendChange_(sheetName, 'replaceAll', 'all', { count: normalizedRows.length });
    return json_({ status: 'ok', count: normalizedRows.length, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}


function deleteRow_(sheetName, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const cleanId = String(id || '').trim();
    if (!cleanId) return json_({ error: 'missing_id' });

    const rowIndex = findRowIndex_(sheet, key, cleanId, headers);
    if (rowIndex > 0) sheet.deleteRow(rowIndex);
    appendChange_(sheetName, 'delete', cleanId, {});
    return json_({ status: 'deleted', id: cleanId, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}


function getChanges_(query) {
  const cursor = Number(query && query.cursor) || 0;
  const limit = Math.min(Number(query && query.limit) || 500, 1000);
  const page = readChangePageAfter_(cursor, limit);
  const changes = hydrateChangesForClient_(page.changes);
  const latestCursor = page.latestCursor;
  const nextCursor = changes.length ? Number(changes[changes.length - 1].cursor) : Math.max(cursor, latestCursor);
  return json_({
    changes,
    cursor: nextCursor,
    latestCursor,
    serverTime: nowIso_(),
    resyncRequired: false,
    hasMore: page.hasMore
  });
}


function verifyReferralCode_(payload) {
  const empNo = normalizeEmpNo_(payload.empNo);
  const code = String(payload.code || '').trim();
  if (isReferralCodeLocked_(empNo)) {
    return json_({ ok: false, error: 'too_many_attempts' });
  }
  const cache = CacheService.getScriptCache();
  const saved = JSON.parse(cache.get(referralCodeKey_(empNo)) || 'null');
  const employee = findActiveEmployeeByEmpNo_(empNo);

  if (!employee || !saved || saved.code !== code) {
    recordReferralCodeFailure_(empNo);
    return json_({ ok: false, error: 'invalid_or_expired_code' });
  }

  const token = Utilities.getUuid();
  cache.remove(referralCodeKey_(empNo));
  clearReferralCodeFailures_(empNo);
  cache.put(referralTokenKey_(token), JSON.stringify({
    email: employee.email,
    empNo: employee.empNo,
    issuedAt: nowIso_()
  }), REFERRAL_TOKEN_TTL_SECONDS);

  return json_({
    ok: true,
    token,
    employee: {
      email: employee.email,
      name: employee.name,
      empNo: employee.empNo,
      dept: employee.dept
    }
  });
}


function uploadReferralFile_(payload) {
  const employee = validateReferralToken_(payload.verificationToken, payload.refEmail);
  if (!employee) return json_({ error: 'verification_required' });
  if (!payload.referralId || !payload.fileName || !payload.data) {
    return json_({ error: 'missing_upload_fields' });
  }
  const safeName = String(payload.fileName).replace(/[\\/:*?"<>|]/g, '_');
  const ext = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : '';
  if (!REFERRAL_ALLOWED_EXTENSIONS.includes(ext)) return json_({ error: 'unsupported_file_type' });
  const estimatedBytes = Math.floor(String(payload.data || '').length * 3 / 4);
  if (estimatedBytes > REFERRAL_MAX_UPLOAD_BYTES) return json_({ error: 'file_too_large' });
  const uploadFolderId = getScriptProperty_(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY);
  if (!uploadFolderId) {
    return json_({ error: 'missing_upload_folder_id' });
  }

  const folder = DriveApp.getFolderById(uploadFolderId);
  const bytes = Utilities.base64Decode(payload.data);
  if (bytes.length > REFERRAL_MAX_UPLOAD_BYTES) return json_({ error: 'file_too_large' });
  const prefix = [payload.referralId, employee.empNo || employee.email, payload.candName || 'candidate']
    .join('_')
    .replace(/[\\/:*?"<>|]/g, '_');
  const blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', prefix + '_' + safeName);
  const file = folder.createFile(blob);
  hardenUploadedFileSharing_(file);

  return json_({
    ok: true,
    fileId: file.getId(),
    url: file.getUrl(),
    fileName: file.getName()
  });
}


function hardenUploadedFileSharing_(file) {
  try {
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (err) {
    console.warn('hardenUploadedFileSharing_ failed: ' + String(err && err.message || err));
  }
}


function getMyReferrals_(payload) {
  const employee = validateReferralToken_(payload.verificationToken, payload.refEmail || payload.email);
  if (!employee) return json_({ error: 'verification_required' });
  const email = employee.email;
  const referralRows = readRows_('Referrals')
    .filter(row => normalizeEmail_(row.refEmail) === email && !row.deletedAt)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  const rewardRows = readRows_('Rewards').filter(row => !row.deletedAt);
  const data = referralRows.map(row => {
    const refItems = parseRefItems_(row.refItems);
    return {
      id: row.id,
      submittedAt: row.submittedAt,
      validUntil: row.validUntil,
      status: compactReferralStatus_(row.status),
      candidateLabel: maskName_(row.candName),
      posText: row.posText || '',
      referralTrack: refItems.referralTrack || '',
      actionRequirementStatus: refItems.actionRequirementStatus || '',
      rewardEligibilityStatus: refItems.rewardEligibilityStatus || '',
      rewards: rewardRows
        .filter(reward => String(reward.referralId) === String(row.id))
        .map(reward => ({
          milestone: reward.milestone,
          dueDate: reward.dueDate,
          payMonth: reward.payMonth,
          amount: reward.amount,
          status: compactRewardStatus_(reward.status)
        }))
    };
  });
  return json_({ ok: true, data });
}


function buildReferenceCandidateLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_CANDIDATE_PAGE_URL') || REFERENCE_CANDIDATE_PAGE_URL, { token });
}


function buildReferenceResponseLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_RESPONSE_PAGE_URL') || REFERENCE_RESPONSE_PAGE_URL, { token });
}


function buildInterviewAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, { token });
}


function normalizeInterviewAvailabilityOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, 7).map(item => {
    const date = String(item && item.date || '').trim();
    const periods = Array.isArray(item && item.periods)
      ? item.periods.map(v => String(v || '').toUpperCase()).filter(v => v === 'AM' || v === 'PM')
      : [];
    return { date, periods: periods.filter((v, i, arr) => arr.indexOf(v) === i) };
  }).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.periods.length);
}


function interviewAvailabilityExpired_(row) {
  return !!(row.availabilityExpiresAt && new Date(row.availabilityExpiresAt).getTime() < Date.now());
}


function verifyInterviewAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  let selections = [];
  try { selections = JSON.parse(row.availabilitySelections || '[]'); } catch (err) {}
  const candidate = readRows_('Candidates').find(item => String(item.id) === String(row.candId)) || {};
  return json_({
    ok: true,
    candName: row.candName || '',
    positionText: candidate.pos || '',
    interviewType: row.type || '',
    location: row.loc || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE',
    unavailable: row.availabilityStatus === 'UNAVAILABLE',
    selections,
    note: row.availabilityNote || '',
    responseBy: row.availabilityResponseBy || 'candidate',
    responderName: row.availabilityResponderName || '',
    responderEmail: row.availabilityResponderEmail || '',
    responderOrg: row.availabilityResponderOrg || '',
    proxyConfirmed: !!row.availabilityProxyConfirmedAt
  });
}


function submitInterviewAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(v => String(v || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  const proxyConfirmed = body.proxyConfirmed === true || String(body.proxyConfirmed || '').toLowerCase() === 'true';
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'availabilityToken', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
    if (row && candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    // 제출한 일정은 수정할 수 없다(변경은 담당자 문의 → 담당자가 다시 요청하면 새로 받는다).
    if (row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE') return json_({ ok: false, error: 'already_submitted' });
    if (row.availabilityResponseBy === 'headhunter' && !proxyConfirmed) return json_({ ok: false, error: 'proxy_confirmation_required' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, arr) => allowed[value] && arr.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const next = Object.assign({}, row, {
      availabilitySelections: JSON.stringify(unavailable ? [] : selections),
      availabilityStatus: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      availabilityRespondedAt: nowIso_(),
      availabilityNote: note,
      availabilityProxyConfirmedAt: row.availabilityResponseBy === 'headhunter' ? nowIso_() : '',
      // 관리자 화면이 이 회신을 받기 전 예전 내용으로 저장해도 덮어쓰지 않도록 버전을 올린다
      // (그 저장은 버전 충돌이 되고, 화면의 자동 병합이 회신 칸을 서버 값으로 유지한다).
      rev: (Number(row.rev) || 0) + 1,
      updatedAt: nowIso_()
    });
    const normalized = schemaRow_('Interviews', next);
    const writeRow = confirmRowIndex_(sheet, headers, 'availabilityToken', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('Interviews', 'upsert', row.id, normalized);
    notifyIfInterviewAvailabilityCohortComplete_(normalized);
    return json_({ ok: true, status: normalized.availabilityStatus, respondedAt: normalized.availabilityRespondedAt });
  } finally {
    lock.releaseLock();
  }
}


function normalizeJoinDateOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.map(v => String(v || '').trim().slice(0, 10))
    .filter((v, i, arr) => /^\d{4}-\d{2}-\d{2}$/.test(v) && arr.indexOf(v) === i)
    .sort()
    .slice(0, 31);
}


function joinDateRequestExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}


function joinDateReplyDeadlinePassed_(row) {
  const deadline = String(row && row.deadline || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false;
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd') > deadline;
}


// 최종합격(5) 단계인 지원자만 회신할 수 있다(불합격·보류·입사 처리 후에는 받지 않는다).
function joinDateProcessClosed_(candId) {
  const cand = readRows_('Candidates').find(row => String(row.id) === String(candId));
  if (!cand) return true;
  if (String(cand.held || '') === 'Y') return true;
  return !['5', '최종합격'].includes(String(cand.stage == null ? '' : cand.stage).trim());
}


function issueJoinDateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const candId = String(body.candId || '').trim();
  const candName = String(body.candName || '').trim();
  const options = normalizeJoinDateOptions_(body.options);
  if (!candId || !candName || !options.length) return json_({ error: 'missing_join_date_fields' });
  if (joinDateProcessClosed_(candId)) return json_({ error: 'process_closed' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'id', candId, headers);
    const existing = readRows_('JoinDateRequests').find(row => String(row.id) === candId) || {};
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + JOIN_DATE_LINK_TTL_DAYS * 86400000).toISOString();
    const link = buildUrlWithParams_(JOIN_DATE_PAGE_URL, { token });
    const row = schemaRow_('JoinDateRequests', Object.assign({}, existing, {
      id: candId, candId, candName, positionText: String(body.positionText || '').trim(),
      options: JSON.stringify(options), token, tokenExpiresAt: expiresAt, link,
      deadline: String(body.deadline || '').trim().slice(0, 10),
      selection: '', status: 'SENT', note: '', respondedAt: '',
      responseBy: body.responseBy === 'headhunter' ? 'headhunter' : 'candidate',
      createdAt: existing.createdAt || nowIso_(), updatedAt: nowIso_()
    }));
    const values = headers.map(header => row[header] == null ? '' : row[header]);
    if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]); else sheet.appendRow(values);
    appendChange_('JoinDateRequests', 'upsert', candId, row);
    return json_({ ok: true, id: candId, link, tokenExpiresAt: expiresAt });
  } finally {
    lock.releaseLock();
  }
}


function verifyJoinDateToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.status !== 'RESPONDED' && row.status !== 'UNAVAILABLE' && joinDateReplyDeadlinePassed_(row)) return json_({ ok: false, error: 'deadline_expired' });
  return json_({
    ok: true, candName: row.candName || '', positionText: row.positionText || '',
    options: normalizeJoinDateOptions_(row.options), deadline: row.deadline || '',
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE', selection: row.selection || '', note: row.note || '',
    responseBy: row.responseBy || 'candidate'
  });
}


function submitJoinDate_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const selection = String(body.selection || '').trim().slice(0, 10);
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !selection) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
    if (rowIndex < 0 || !row) return json_({ ok: false, error: 'invalid_token' });
    if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (joinDateReplyDeadlinePassed_(row)) return json_({ ok: false, error: 'deadline_expired' });
    if (!unavailable && normalizeJoinDateOptions_(row.options).indexOf(selection) < 0) return json_({ ok: false, error: 'invalid_selection' });
    const next = schemaRow_('JoinDateRequests', Object.assign({}, row, {
      selection: unavailable ? '' : selection, status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      note, respondedAt: nowIso_(), updatedAt: nowIso_()
    }));
    const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length).setValues([headers.map(header => next[header] == null ? '' : next[header])]);
    appendChange_('JoinDateRequests', 'upsert', row.id, next);
    // 담당자 알림(설정의 '일정 응답 완료 알림 받을 이메일')
    const choice = unavailable ? '제안 날짜 모두 어려움 · 희망: ' + note : '입사 가능일 ' + selection + (note ? ' · 메모: ' + note : '');
    sendCohortCompleteNotice_('[입사일 회신] ' + (row.candName || '') + '님 ' + (unavailable ? '날짜 조정 요청' : selection),
      (row.candName || '') + '님이 입사일을 회신했습니다.\n\n' + choice + '\n\n채용 관리 화면의 입사 안내에서 확인해 주세요.');
    return json_({ ok: true, status: next.status, respondedAt: next.respondedAt });
  } finally {
    lock.releaseLock();
  }
}


function getNotifyEmail_() {
  return getFirstSettingValue_(['notifyEmail']);
}


// 지원자 전원(해당 포지션·회차 발송 대상)이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfInterviewAvailabilityCohortComplete_(justUpdatedRow) {
  const cand = readRows_('Candidates').find(c => String(c.id) === String(justUpdatedRow.candId));
  if (!cand || !cand.posId) return;
  const cohortCandIds = readRows_('Candidates')
    .filter(c => String(c.posId) === String(cand.posId))
    .map(c => String(c.id));
  const cohort = readRows_('Interviews').filter(i =>
    i.type === justUpdatedRow.type &&
    cohortCandIds.includes(String(i.candId)) &&
    ['SENT', 'RESPONDED', 'UNAVAILABLE'].includes(i.availabilityStatus)
  );
  if (!cohort.length || !cohort.every(i => i.availabilityStatus === 'RESPONDED' || i.availabilityStatus === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${cand.pos || '포지션'} ${justUpdatedRow.type} 지원자 전원 일정 응답 완료`,
    `${cand.pos || '포지션'} ${justUpdatedRow.type} 대상 지원자 ${cohort.length}명 전원이 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
}


// 면접관 전원이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfPanelAvailabilityCohortComplete_(justUpdatedRow) {
  const cohort = readRows_('PanelAvailability').filter(r =>
    String(r.positionId) === String(justUpdatedRow.positionId) &&
    String(r.round) === String(justUpdatedRow.round)
  );
  if (!cohort.length || !cohort.every(r => r.status === 'RESPONDED' || r.status === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 전원 일정 응답 완료`,
    `${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 ${cohort.length}명 전원이 참석 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
}


function referenceLinkExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}


function invalidatePriorReferenceCandidateLinks_(sheet, headers, pipelineCandId, candEmail) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const idIndex = headers.indexOf('pipelineCandId');
  const emailIndex = headers.indexOf('candEmail');
  const tokenIndex = headers.indexOf('token');
  const expiresIndex = headers.indexOf('tokenExpiresAt');
  const linkIndex = headers.indexOf('link');
  const submittedIndex = headers.indexOf('refereesSubmittedAt');
  const statusIndex = headers.indexOf('status');
  const updatedIndex = headers.indexOf('updatedAt');
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const invalidated = [];
  const updatedAt = nowIso_();

  rows.forEach(function(values) {
    const matches = pipelineCandId
      ? String(values[idIndex] || '') === pipelineCandId
      : normalizeEmail_(values[emailIndex]) === candEmail;
    if (!matches || !String(values[tokenIndex] || '').trim()) return;
    values[tokenIndex] = '';
    values[expiresIndex] = '';
    values[linkIndex] = '';
    if (!values[submittedIndex]) values[statusIndex] = 'REPLACED';
    values[updatedIndex] = updatedAt;
    invalidated.push(values);
  });

  if (!invalidated.length) return 0;
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  invalidated.forEach(function(values) {
    const row = {};
    headers.forEach(function(header, index) { row[header] = values[index]; });
    appendChange_('ReferenceCandidates', 'upsert', row.id, row);
  });
  return invalidated.length;
}


// 후보자가 등록 링크를 열었을 때 화면에 본인 이름을 띄우기 위한 토큰 검증.
function verifyReferenceCandidateToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceCandidates').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    candName: row.candName,
    positionText: row.positionText,
    alreadySubmitted: !!row.refereesSubmittedAt
  });
}


// 후보자가 추천인 목록(이름/이메일/관계/소속)을 제출하면, 추천인별로 별도 토큰을 발급해
// ReferenceResponses에 한 줄씩 만들고 각 추천인에게 응답 링크를 메일로 보낸다.
function submitReferenceCandidateReferees_(payload) {
  const outbox = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let result;
  try {
    result = submitReferenceCandidateRefereesUnlocked_(payload, outbox);
  } finally {
    lock.releaseLock();
  }
  if (!result || !result.ok) return json_(result || { error: 'unknown_error' });
  // 시트 기록이 끝난 뒤 잠금을 풀고 메일을 보낸다. 메일 발송이 느려도 다른 저장이 잠금 대기로 실패하지 않게 하고,
  // 추천인별 발송 결과를 돌려준다(실패 내역은 MailLog에도 남고, 관리자 화면에서 링크를 다시 보낼 수 있다).
  const mailResults = outbox.map(job => ({ refereeName: job.refereeName, ok: sendReferenceRefereeRequestMail_(job) }));
  const mailFailed = mailResults.filter(r => !r.ok).length;
  return json_(Object.assign({}, result, { mailSent: mailResults.length - mailFailed, mailFailed: mailFailed }));
}


// 추천인이 응답 링크를 열었을 때의 1차 확인 — 링크 자체가 살아있는지만 본다.
// 아직 본인 확인(이메일·전화번호) 전이라 후보자명은 여기서 보여주지 않는다(신원 미확인 상태에서 노출 방지).
function verifyReferenceRefereeToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceResponses').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });
  return json_({ ok: true });
}


// 링크 확인 다음 단계 — 등록 시 후보자가 입력한 이메일·전화번호와 일치하는지 확인한 뒤에만
// 후보자명을 공개하고 12문항 응답 폼을 열어준다. 링크만 유출돼도 아무나 응답할 수 없게 하는
// 최소한의 신원 확인 장치(강력한 인증은 아니지만, 링크를 잘못 전달받은 제3자를 걸러낸다).
function refereeVerifyFailKey_(token) {
  return 'referee_verify_fail:' + String(token || '');
}


function refereeVerifyLockKey_(token) {
  return 'referee_verify_lock:' + String(token || '');
}


function isRefereeVerifyLocked_(token) {
  if (!token) return true;
  return !!CacheService.getScriptCache().get(refereeVerifyLockKey_(token));
}


function recordRefereeVerifyFailure_(token) {
  if (!token) return;
  const cache = CacheService.getScriptCache();
  const key = refereeVerifyFailKey_(token);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFEREE_VERIFY_ATTEMPT_LIMIT) {
    cache.put(refereeVerifyLockKey_(token), '1', REFEREE_VERIFY_LOCK_SECONDS);
    cache.remove(key);
    return;
  }
  cache.put(key, String(count), REFEREE_VERIFY_LOCK_SECONDS);
}


function clearRefereeVerifyFailures_(token) {
  const cache = CacheService.getScriptCache();
  cache.remove(refereeVerifyFailKey_(token));
  cache.remove(refereeVerifyLockKey_(token));
}


function verifyRefereeIdentity_(payload) {
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const email = normalizeEmail_(body.email);
  const phone = normalizePhone_(body.phone);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!email || !phone) return json_({ ok: false, error: 'identity_fields_required' });
  if (isRefereeVerifyLocked_(token)) return json_({ ok: false, error: 'too_many_attempts' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
  const row = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });

  // 이메일·전화번호 중 하나만 일치해도 통과(둘 다 일치해야 하는 건 너무 엄격함).
  if (normalizeEmail_(row.refereeEmail) !== email && normalizePhone_(row.refereePhone) !== phone) {
    recordRefereeVerifyFailure_(token);
    return json_({ ok: false, error: 'identity_mismatch' });
  }
  clearRefereeVerifyFailures_(token);

  const verifiedAtCol = headers.indexOf('verifiedAt') + 1;
  const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
  if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
  if (verifiedAtCol > 0) sheet.getRange(writeRow, verifiedAtCol).setValue(nowIso_());
  appendChange_('ReferenceResponses', 'upsert', row.id, { verifiedAt: true });

  return json_({ ok: true, candName: row.candName, refereeName: row.refereeName });
}


// 추천인의 12문항 응답을 저장한다. 토큰 1개당 1회만 제출 가능.
function submitReferenceResponse_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return submitReferenceResponseUnlocked_(payload);
  } finally {
    lock.releaseLock();
  }
}


function submitReferenceResponseUnlocked_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const answers = body.answers || {};
  if (!token) return json_({ error: 'token_required' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const existing = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!existing) return json_({ error: 'invalid_token' });
  if (candidateProcessClosed_(existing.pipelineCandId)) return json_({ error: 'process_closed' });
  if (existing.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(existing)) return json_({ error: 'token_expired' });
  if (!existing.verifiedAt) return json_({ error: 'identity_not_verified' });

  const ANSWER_KEYS = ['q1_periodStart','q1_periodEnd','q1_relation','q1_frequency',
    'q1_2_mainTask','q1_2_projectScale','q1_2_soloVsShared',
    'q2_startStyle','q3_judgeStyle','q3_initiative',
    'q4_successNarrative','q4_failureNarrative','q5_feedbackResponse',
    'q6_conflictStyle','q6_example','q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas','q9_word','q9_reason',
    'q10_firstAction','q10_sharedTiming','q11_juniorSupportStyle','q11_example',
    'q12_exitReasonSource','q12_exitReasonDetail','respondentName','respondentAffiliation',
    'respondentContact','respondentConsentObserved','respondentConsentDataUse'];
  const merged = Object.assign({}, existing);
  ANSWER_KEYS.forEach(key => { merged[key] = String(answers[key] == null ? '' : answers[key]).trim(); });
  merged.submittedAt = nowIso_();
  merged.status = 'SUBMITTED';
  merged.updatedAt = nowIso_();

  const values = headers.map(h => merged[h] == null ? '' : merged[h]);
  const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
  if (writeRow < 0) return json_({ error: 'invalid_token' });
  sheet.getRange(writeRow, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  // 제출 완료 안내는 응답 화면에서 한다(추천인에게 별도 완료 메일은 보내지 않는다).
  return json_({ ok: true });
}


function escapeMailHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function panelAvailabilityId_(positionId, round, email) {
  return [String(positionId || '').trim(), String(round || '').trim(), normalizeEmail_(email)].join(':');
}


function parseJsonArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}


function buildPanelAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, {
    audience: 'panel',
    token: token
  });
}


function panelAvailabilityExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}


function getPanelAvailabilityResponses_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || body.query && body.query.positionId || '').trim();
  const round = String(body.round || body.query && body.query.round || '').trim();
  if (!positionId || !round) return json_({ error: 'missing_panel_availability_query' });
  const responses = readRows_('PanelAvailability')
    .filter(row => String(row.positionId) === positionId && String(row.round) === round)
    .map(row => Object.assign({}, row, {
      availabilityOptions: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
      selections: parseJsonArray_(row.selections)
    }));
  return json_({ ok: true, responses });
}


function verifyPanelAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
  if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    participantRole: 'panel',
    participantName: row.panelistName || '',
    positionText: row.positionTitle || '',
    interviewType: row.round || '',
    location: row.loc || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE',
    selections: parseJsonArray_(row.selections),
    note: row.note || ''
  });
}


function submitPanelAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(value => String(value || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('PanelAvailability');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
    if (row && positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (row.status === 'RESPONDED' || row.status === 'UNAVAILABLE') return json_({ ok: false, error: 'already_submitted' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, array) => allowed[value] && array.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const normalized = schemaRow_('PanelAvailability', Object.assign({}, row, {
      selections: JSON.stringify(unavailable ? [] : selections),
      status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      respondedAt: nowIso_(),
      note,
      updatedAt: nowIso_()
    }));
    const writeRow = confirmRowIndex_(sheet, headers, 'token', token, rowIndex);
    if (writeRow < 0) return json_({ ok: false, error: 'invalid_token' });
    sheet.getRange(writeRow, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('PanelAvailability', 'upsert', row.id, normalized);
    notifyIfPanelAvailabilityCohortComplete_(normalized);
    return json_({ ok: true, status: normalized.status, respondedAt: normalized.respondedAt });
  } finally {
    lock.releaseLock();
  }
}


function parseRefItems_(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value)) || {};
  } catch (err) {
    return {};
  }
}


function secureReferralRowForUpsert_(row, isExistingRow, isAdmin) {
  if (isAdmin) {
    const adminRow = Object.assign({}, row || {});
    delete adminRow.verificationToken;
    return adminRow;
  }
  if (!row || !row.verificationToken) {
    throw new Error('verification_required');
  }
  if (isExistingRow) throw new Error('public_referral_update_not_allowed');

  const employee = validateReferralToken_(row.verificationToken, row.refEmail);
  if (!employee) throw new Error('verification_required');

  const cleaned = Object.assign({}, row);
  cleaned.refEmail = employee.email;
  cleaned.refName = employee.name;
  cleaned.refEmpNo = employee.empNo;
  cleaned.refDept = employee.dept;
  cleaned.updatedBy = employee.email;
  delete cleaned.verificationToken;
  return cleaned;
}


function validateReferralToken_(token, email) {
  const normalizedEmail = normalizeEmail_(email);
  const saved = JSON.parse(CacheService.getScriptCache().get(referralTokenKey_(token)) || 'null');
  if (!saved || saved.email !== normalizedEmail) return null;
  const employee = saved.empNo ? findActiveEmployeeByEmpNo_(saved.empNo) : findActiveEmployeeByEmail_(normalizedEmail);
  if (!employee) return null;
  if (saved.empNo && normalizeEmpNo_(employee.empNo) !== normalizeEmpNo_(saved.empNo)) return null;
  return employee;
}


function findActiveEmployeeByEmpNo_(empNo) {
  if (!empNo) return null;
  const remote = lookupEmployeeByEmpNoFromUrl_(empNo);
  if (remote) return remote;
  const rows = readEmployeeDirectoryRows_();
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeEmployeeDirectoryRow_(rows[i]);
    if (normalizeEmpNo_(row.empNo) !== empNo) continue;
    return normalizeActiveEmployee_(row);
  }
  return null;
}


function lookupEmployeeByEmpNoFromUrl_(empNo) {
  const url = getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS);
  if (!url) return null;
  const lookupToken = getScriptProperty_(EMPLOYEE_DIRECTORY_LOOKUP_TOKEN_PROPERTY);
  if (!lookupToken) return null;
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'lookupEmployeeByEmpNo',
      empNo: normalizeEmpNo_(empNo),
      lookupToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return null;
    const payload = JSON.parse(res.getContentText() || '{}');
    if (!payload.success || !payload.employee) return null;
    return normalizeActiveEmployee_(normalizeEmployeeDirectoryRow_(payload.employee));
  } catch (err) {
    console.warn('lookupEmployeeByEmpNoFromUrl_ failed: ' + String(err && err.message || err));
    return null;
  }
}


function findActiveEmployeeByEmail_(email) {
  if (!email) return null;
  const rows = readEmployeeDirectoryRows_();
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeEmployeeDirectoryRow_(rows[i]);
    if (normalizeEmail_(row.email) !== email) continue;
    return normalizeActiveEmployee_(row);
  }
  return null;
}


function readEmployeeDirectoryRows_() {
  const rows = [];
  rows.push.apply(rows, fetchEmployeeDirectoryRowsFromUrl_());
  REFERRAL_EMPLOYEE_DIRECTORY_SHEETS.forEach(sheetName => {
    rows.push.apply(rows, readRowsIfSheetExists_(sheetName));
  });
  return dedupeEmployeeDirectoryRows_(rows);
}


function fetchEmployeeDirectoryRowsFromUrl_() {
  const url = getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS);
  if (!url) return [];
  const adminToken = getScriptProperty_(EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY);
  if (!adminToken) return [];
  const cache = CacheService.getScriptCache();
  const cached = readEmployeeDirectoryCache_(cache);
  if (cached) return cached;
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'getInterviewers',
      adminToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return [];
    const payload = JSON.parse(res.getContentText() || '{}');
    let rows = [];
    if (Array.isArray(payload.interviewers)) rows = payload.interviewers;
    else if (Array.isArray(payload.data)) rows = payload.data;
    else if (Array.isArray(payload.rows)) rows = payload.rows;
    writeEmployeeDirectoryCache_(cache, rows);
    return rows;
  } catch (err) {
    console.warn('fetchEmployeeDirectoryRowsFromUrl_ failed: ' + String(err && err.message || err));
  }
  return [];
}


// 면접관 DB 응답(1700명대, ~400KB)을 매 요청마다 새로 받아오면 느려서(수십 초까지 발생)
// CacheService에 청크 단위로 잘라 5분간 캐시한다. 한 키당 100KB 제한이 있어 5만자 단위로 분할.
function writeEmployeeDirectoryCache_(cache, rows) {
  try {
    const json = JSON.stringify(rows);
    const chunkSize = EMPLOYEE_DIRECTORY_CACHE_CHUNK_SIZE;
    const chunkCount = Math.max(1, Math.ceil(json.length / chunkSize));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = json.slice(i * chunkSize, (i + 1) * chunkSize);
      cache.put(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + i, chunk, EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS);
    }
    cache.put(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + 'count', String(chunkCount), EMPLOYEE_DIRECTORY_CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn('writeEmployeeDirectoryCache_ failed: ' + String(err && err.message || err));
  }
}


function readEmployeeDirectoryCache_(cache) {
  try {
    const countStr = cache.get(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + 'count');
    if (!countStr) return null;
    const count = Number(countStr);
    if (!Number.isFinite(count) || count <= 0) return null;
    let json = '';
    for (let i = 0; i < count; i++) {
      const chunk = cache.get(EMPLOYEE_DIRECTORY_CACHE_KEY_PREFIX + i);
      if (chunk == null) return null;
      json += chunk;
    }
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}


function positionProcessClosed_(positionId) {
  if (positionId === '' || positionId == null) return false;
  const pos = readRowByIdIfSheetExists_('Positions', positionId);
  return !!pos && CLOSED_POSITION_STATUSES_.includes(String(pos.status || '').trim());
}


function candidateStageClosed_(value) {
  const stage = String(value == null ? '' : value).trim();
  return ['5', '6', '7', '최종합격', '불합격', '입사'].includes(stage);
}


function candidateProcessClosed_(candId) {
  if (candId === '' || candId == null) return false;
  const cand = readRowByIdIfSheetExists_('Candidates', candId);
  if (!cand) return false;
  if (candidateStageClosed_(cand.stage) || String(cand.held || '') === 'Y') return true;
  return positionProcessClosed_(cand.posId);
}


function dedupeEmployeeDirectoryRows_(rows) {
  const map = {};
  rows.forEach(row => {
    const normalized = normalizeEmployeeDirectoryRow_(row);
    const key = normalized.empNo || normalized.email;
    if (key && !map[key]) map[key] = normalized;
  });
  return Object.keys(map).map(key => map[key]);
}


function normalizeEmployeeDirectoryRow_(row) {
  row = row || {};
  return {
    email: normalizeEmail_(pickFirst_(row, ['email','mail','companyEmail','회사이메일','이메일'])),
    name: String(pickFirst_(row, ['name','displayName','userName','성명','이름']) || '').trim(),
    empNo: normalizeEmpNo_(pickFirst_(row, ['empNo','employeeNo','employeeId','emp_no','staffNo','사번','직번'])),
    dept: String(pickFirst_(row, ['dept','department','division','team','org','소속','부서','팀']) || '').trim(),
    status: String(pickFirst_(row, ['status','activeStatus','employmentStatus','재직상태','상태']) || '').trim(),
    updatedAt: pickFirst_(row, ['updatedAt','updated_at','수정일'])
  };
}


function buildUrlWithParams_(baseUrl, params) {
  const pairs = [];
  Object.keys(params || {}).forEach(key => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
  });
  if (!pairs.length) return String(baseUrl || '');
  return String(baseUrl || '') + (String(baseUrl || '').indexOf('?') >= 0 ? '&' : '?') + pairs.join('&');
}


function normalizeActiveEmployee_(row) {
  const status = String(row.status || '').trim().toLowerCase();
  const active = !status || ['재직', '재직중', 'active'].includes(status);
  if (!active) return null;
  return {
    email: normalizeEmail_(row.email),
    name: String(row.name || '').trim(),
    empNo: normalizeEmpNo_(row.empNo),
    dept: String(row.dept || '').trim(),
    status
  };
}


function referralCodeKey_(email) {
  return 'referral_code:' + email;
}


function referralCodeSendKey_(empNo) {
  return 'referral_code_send:' + normalizeEmpNo_(empNo);
}


function referralCodeFailKey_(empNo) {
  return 'referral_code_fail:' + normalizeEmpNo_(empNo);
}


function referralCodeLockKey_(empNo) {
  return 'referral_code_lock:' + normalizeEmpNo_(empNo);
}


function allowReferralCodeSend_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return false;
  const cache = CacheService.getScriptCache();
  const key = referralCodeSendKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
  return count <= REFERRAL_CODE_SEND_LIMIT;
}


function isReferralCodeLocked_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return true;
  return !!CacheService.getScriptCache().get(referralCodeLockKey_(empNo));
}


function recordReferralCodeFailure_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return;
  const cache = CacheService.getScriptCache();
  const key = referralCodeFailKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFERRAL_CODE_VERIFY_LIMIT) {
    cache.put(referralCodeLockKey_(empNo), '1', REFERRAL_CODE_LOCK_SECONDS);
    cache.remove(key);
    cache.remove(referralCodeKey_(empNo));
    return;
  }
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
}


function clearReferralCodeFailures_(empNo) {
  const cache = CacheService.getScriptCache();
  cache.remove(referralCodeFailKey_(empNo));
  cache.remove(referralCodeLockKey_(empNo));
}


function referralTokenKey_(token) {
  return 'referral_token:' + String(token || '');
}


function compactReferralStatus_(status) {
  const map = {
    SUBMITTED: '접수',
    REVIEWING: '검토중',
    IN_PROCESS: '전형진행',
    PASSED: '합격',
    FAILED: '불합격',
    HIRED: '입사',
    REJECTED: '종료',
    WITHDRAWN: '종료',
    EXPIRED: '만료',
    CANCELLED: '종료'
  };
  return map[String(status || '').toUpperCase()] || '접수';
}


function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

