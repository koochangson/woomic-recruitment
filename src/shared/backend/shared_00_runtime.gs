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

// 지정한 id의 행만 읽는다. 키 열은 한 번 스캔하고, 실제 본문은 필요한 연속 구간만 가져온다.
function readRowsByIds_(sheetName, ids) {
  assertKnownSheet_(sheetName);
  const targets = new Set((ids || []).map(function(id) { return String(id || '').trim(); }).filter(Boolean));
  if (!targets.size) return {};

  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const keyIndex = headers.indexOf(primaryKey_(sheetName));
  const lastRow = sheet.getLastRow();
  if (keyIndex < 0 || lastRow < 2) return {};

  const keyValues = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  const rowNumbers = [];
  keyValues.forEach(function(values, index) {
    if (targets.has(String(values[0] || '').trim())) rowNumbers.push(index + 2);
  });
  if (!rowNumbers.length) return {};

  const ranges = [];
  rowNumbers.forEach(function(rowNumber) {
    const current = ranges[ranges.length - 1];
    if (current && current.start + current.count === rowNumber) current.count++;
    else ranges.push({ start: rowNumber, count: 1 });
  });

  const result = {};
  ranges.forEach(function(range) {
    sheet.getRange(range.start, 1, range.count, headers.length).getValues().forEach(function(values) {
      const row = {};
      headers.forEach(function(header, index) { row[header] = normalizeCell_(values[index]); });
      const id = String(row[primaryKey_(sheetName)] || '').trim();
      if (id) result[id] = row;
    });
  });
  return result;
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
