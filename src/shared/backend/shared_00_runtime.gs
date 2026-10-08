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
