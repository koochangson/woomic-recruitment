// 우미건설 채용 대시보드 - 면접관 DB API
// 직원현황 엑셀 업로드 연동용 업데이트본
//
// 사용 방법:
// 1. 기존 면접관 DB Apps Script의 Code.gs 내용을 이 파일 내용으로 교체
// 2. SHEET_ID가 현재 면접관 DB 스프레드시트 ID와 맞는지 확인
// 3. SHEET_NAME이 실제 탭명과 맞는지 확인
// 4. 새 버전으로 웹앱 배포

const SHEET_ID = '1_6T0iOTul8dtQH_MJCNYjcpzaoSaCz8oEWkEwWeMNTc';
const SHEET_NAME = '면접관DB';
const ADMIN_TOKEN_PROPERTY = 'INTERVIEWER_DB_ADMIN_TOKEN';
const LOOKUP_TOKEN_PROPERTY = 'INTERVIEWER_DB_LOOKUP_TOKEN';

const HEADERS = ['id', 'empNo', 'name', 'email', 'rank', 'dept', 'type', 'active', 'status', 'updatedAt'];

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || 'getInterviewers';

    if (action === 'lookupEmployeeByEmpNo') {
      assertLookupAuthorized(params);
      return jsonResponse(lookupEmployeeByEmpNo(params.empNo));
    }

    assertAdminAuthorized(params);

    if (action === 'getInterviewers') {
      return jsonResponse(getInterviewers(params.type || null));
    }

    if (action === 'getInterviewer') {
      return jsonResponse(getInterviewerById(Number(params.id)));
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
    const action = body.action;

    if (action === 'lookupEmployeeByEmpNo') {
      assertLookupAuthorized(body);
      return jsonResponse(lookupEmployeeByEmpNo(body.empNo));
    }

    assertAdminAuthorized(body);

    if (action === 'addInterviewer') return jsonResponse(addInterviewer(body));
    if (action === 'updateInterviewer') return jsonResponse(updateInterviewer(body));
    if (action === 'deleteInterviewer') return jsonResponse(deleteInterviewer(body.id));
    if (action === 'replaceAll') return jsonResponse(replaceAllInterviewers(body.data || body.rows || []));

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

function assertAdminAuthorized(payload) {
  const configured = getScriptProperty(ADMIN_TOKEN_PROPERTY);
  if (!configured) throw new Error('admin_token_not_configured');
  const token = String(payload && (payload.adminToken || payload.token) || '').trim();
  if (token !== configured) throw new Error('admin_auth_required');
}

function assertLookupAuthorized(payload) {
  const configured = getScriptProperty(LOOKUP_TOKEN_PROPERTY) || getScriptProperty(ADMIN_TOKEN_PROPERTY);
  if (!configured) throw new Error('lookup_token_not_configured');
  const token = String(payload && (payload.lookupToken || payload.adminToken || payload.token) || '').trim();
  if (token !== configured) throw new Error('lookup_auth_required');
}

function getScriptProperty(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), HEADERS.length);
  let current = [];
  if (sheet.getLastRow() >= 1) {
    current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(v => String(v || '').trim());
  }
  if (!current.filter(Boolean).length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }
  const next = current.slice();
  HEADERS.forEach(header => {
    if (!next.includes(header)) next.push(header);
  });
  if (next.length !== current.length) {
    sheet.getRange(1, 1, 1, next.length).setValues([next]);
  }
  return next;
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(v => String(v || '').trim());
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((key, index) => {
        obj[key] = row[index];
      });
      return obj;
    });
}

function getInterviewers(typeFilter) {
  let data = sheetToObjects(getSheet()).filter(row => isActive(row));

  if (typeFilter) {
    data = data.filter(row => {
      const types = String(row.type || '').split(',').map(value => value.trim());
      return types.includes(typeFilter);
    });
  }

  return {
    success: true,
    count: data.length,
    interviewers: data.map(row => ({
      id: row.id,
      empNo: row.empNo || row.employeeNo || '',
      name: row.name || '',
      email: String(row.email || '').trim().toLowerCase(),
      rank: row.rank || '',
      dept: row.dept || '',
      type: row.type || '',
      active: isActive(row),
      status: row.status || '',
      updatedAt: row.updatedAt || '',
      label: `${row.name || ''} ${row.rank || ''} · ${row.dept || ''}`.trim()
    }))
  };
}

function getInterviewerById(id) {
  const found = sheetToObjects(getSheet()).find(row => Number(row.id) === Number(id));
  if (!found) return { success: false, error: '면접관을 찾을 수 없습니다.' };
  return { success: true, interviewer: found };
}

function lookupEmployeeByEmpNo(empNo) {
  const target = String(empNo || '').replace(/\D/g, '');
  if (!target) return { success: false, error: 'empNo is required' };
  const found = sheetToObjects(getSheet()).find(row => normalizeEmpNo(row.empNo || row.employeeNo) === target && isActive(row));
  if (!found) return { success: false, error: '직원을 찾을 수 없습니다.' };
  return {
    success: true,
    employee: {
      empNo: found.empNo || found.employeeNo || '',
      name: found.name || '',
      email: String(found.email || '').trim().toLowerCase(),
      rank: found.rank || '',
      dept: found.dept || '',
      status: found.status || ''
    }
  };
}

function addInterviewer(body) {
  const sheet = getSheet();
  const rows = sheetToObjects(sheet);
  const email = String(body.email || '').trim().toLowerCase();

  if (!email) return { success: false, error: 'email is required' };
  if (rows.some(row => String(row.email || '').trim().toLowerCase() === email)) {
    return { success: false, error: '이미 등록된 이메일입니다.' };
  }

  const newId = nextId(rows);
  appendInterviewerRow(sheet, normalizeInterviewerRow({
    id: newId,
    empNo: body.empNo || '',
    name: body.name || '',
    email,
    rank: body.rank || '',
    dept: body.dept || '',
    type: body.type || '1차,2차',
    active: true,
    status: body.status || '재직',
    updatedAt: new Date().toISOString()
  }));

  return { success: true, id: newId, message: '면접관을 추가했습니다.' };
}

function updateInterviewer(body) {
  const sheet = getSheet();
  const headers = ensureHeaders(sheet);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (Number(values[i][headers.indexOf('id')]) === Number(body.id)) {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[i][index];
      });
      ['empNo', 'name', 'email', 'rank', 'dept', 'type', 'active', 'status'].forEach(key => {
        if (body[key] !== undefined) row[key] = body[key];
      });
      row.updatedAt = new Date().toISOString();
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([headers.map(header => row[header] == null ? '' : row[header])]);
      return { success: true, message: '수정했습니다.' };
    }
  }

  return { success: false, error: '해당 id를 찾을 수 없습니다.' };
}

function deleteInterviewer(id) {
  const sheet = getSheet();
  const headers = ensureHeaders(sheet);
  const values = sheet.getDataRange().getValues();
  const idIndex = headers.indexOf('id');
  const activeIndex = headers.indexOf('active');
  const updatedAtIndex = headers.indexOf('updatedAt');

  for (let i = 1; i < values.length; i++) {
    if (Number(values[i][idIndex]) === Number(id)) {
      sheet.getRange(i + 1, activeIndex + 1).setValue(false);
      if (updatedAtIndex >= 0) sheet.getRange(i + 1, updatedAtIndex + 1).setValue(new Date().toISOString());
      return { success: true, message: '비활성화했습니다.' };
    }
  }

  return { success: false, error: '해당 id를 찾을 수 없습니다.' };
}

function replaceAllInterviewers(rows) {
  if (!Array.isArray(rows)) return { success: false, error: 'data must be an array' };

  const sheet = getSheet();
  const headers = ensureHeaders(sheet);
  const normalized = rows
    .map((row, index) => normalizeInterviewerRow({
      id: index + 1,
      empNo: pick(row, ['empNo', 'employeeNo', '개인고유사번', '사용자/직원', '사번']),
      name: pick(row, ['name', '사용자명', '성명']),
      email: pick(row, ['email', '업무 이메일주소', '업무이메일주소', '업무 이메일', '업무이메일']),
      rank: pick(row, ['rank', '직급', '호칭']),
      dept: pick(row, ['dept', '통합조직', '최종 소속 통합조직 통합그룹 조직명', '소속', '부서']),
      type: pick(row, ['type']) || '1차,2차',
      active: true,
      status: pick(row, ['status', '직원 상태', '직원상태']) || '재직',
      updatedAt: new Date().toISOString()
    }))
    .filter(row => row.empNo && row.name && row.email);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
  }

  if (normalized.length) {
    const values = normalized.map(row => headers.map(header => row[header] == null ? '' : row[header]));
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }

  return { success: true, status: 'ok', count: normalized.length, message: `면접관 DB를 ${normalized.length}명으로 대체했습니다.` };
}

function appendInterviewerRow(sheet, row) {
  const headers = ensureHeaders(sheet);
  sheet.appendRow(headers.map(header => row[header] == null ? '' : row[header]));
}

function normalizeInterviewerRow(row) {
  return {
    id: row.id || '',
    empNo: String(row.empNo || '').trim(),
    name: String(row.name || '').trim(),
    email: String(row.email || '').trim().toLowerCase(),
    rank: String(row.rank || '').trim(),
    dept: String(row.dept || '').trim(),
    type: String(row.type || '').trim() || '1차,2차',
    active: row.active === false || row.active === 'FALSE' || row.active === 'false' ? false : true,
    status: String(row.status || '').trim() || '재직',
    updatedAt: row.updatedAt || new Date().toISOString()
  };
}

function nextId(rows) {
  const ids = rows.map(row => Number(row.id)).filter(Number.isFinite);
  return ids.length ? Math.max.apply(null, ids) + 1 : 1;
}

function isActive(row) {
  const active = row.active;
  const status = String(row.status || '').trim().toLowerCase();
  const activeFlag = active === true || active === 'TRUE' || active === 'true' || active === '' || active == null;
  const activeStatus = !status || ['재직', '재직중', 'active'].includes(status);
  return activeFlag && activeStatus;
}

function pick(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = row[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeEmpNo(value) {
  return String(value || '').replace(/\D/g, '');
}
