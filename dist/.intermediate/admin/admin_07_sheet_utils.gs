function ensureSheet_(sheetName) {
  assertKnownSheet_(sheetName);
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getScriptProperty_(REFERRAL_DATA_URL_PROPERTY) || getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return SpreadsheetApp.openByUrl(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return getMainSpreadsheet_();
}

function ensureHeaders_(sheet, schema) {
  if (!schema || !schema.length) throw new Error('missing_schema');
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

function appendChange_(sheetName, action, id, data) {
  const sheet = ensureChangeLogSheet_();
  const cursor = sheet.getLastRow();
  sheet.appendRow([cursor, nowIso_(), sheetName, action, id, getActiveUserEmail_(), 'ok', JSON.stringify(data || {})]);
}

function ensureChangeLogSheet_() {
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

function getChangeCursor_() {
  return Math.max(0, ensureChangeLogSheet_().getLastRow() - 1);
}

function readChangesAfter_(cursor, limit) {
  const sheet = ensureChangeLogSheet_();
  const lastRow = sheet.getLastRow();
  const startDataRow = Math.max(2, Number(cursor) + 2);
  if (lastRow < startDataRow) return [];
  const count = Math.min(Number(limit) || 500, lastRow - startDataRow + 1);
  const values = sheet.getRange(startDataRow, 1, count, 8).getValues();
  return values.map(row => ({
    cursor: Number(row[0]),
    timestamp: normalizeCell_(row[1]),
    sheet: String(row[2] || ''),
    action: String(row[3] || ''),
    id: String(row[4] || ''),
    actorEmail: String(row[5] || ''),
    result: String(row[6] || ''),
    data: parseJsonObject_(row[7])
  }));
}

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

function normalizeCell_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  return value == null ? '' : value;
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

