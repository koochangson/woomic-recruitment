function generateReferenceSummary_(data) {
  const apiKey = getScriptProperty_(OPENAI_API_KEY_PROPERTY);
  if (!apiKey) return json_({ error: 'openai_key_not_configured' });
  const prompt = String(data && data.prompt || '').trim();
  if (!prompt) return json_({ error: 'prompt_required' });
  if (prompt.length > 20000) return json_({ error: 'prompt_too_large' });

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    payload: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1400,
      messages: [
        { role: 'system', content: '당신은 건설회사 피플팀 채용 담당자를 돕는 전문 어시스턴트입니다.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const text = res.getContentText() || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return json_({ error: 'openai_invalid_response' });
  }
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    return json_({ error: parsed.error && parsed.error.message || 'openai_request_failed' });
  }
  return json_({ ok: true, text: parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || '' });
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

function secureReferralRowBeforeSave_(row) {
  return secureReferralRowForUpsert_(row, false, false);
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

function readRowsIfSheetExists_(sheetName) {
  const ss = getMainSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  return readRows_(sheetName);
}

function getInterviewersFromDirectory_(payload) {
  const data = payload && payload.data || {};
  const url = String(data.url || getFirstSettingValue_(REFERRAL_EMPLOYEE_DIRECTORY_URL_SETTING_KEYS) || '').trim();
  if (!url) return json_({ success: false, error: 'interviewer_url_missing', interviewers: [] });
  const adminToken = getScriptProperty_(EMPLOYEE_DIRECTORY_ADMIN_TOKEN_PROPERTY);
  if (!adminToken) return json_({ success: false, error: 'interviewer_admin_token_missing', interviewers: [] });
  try {
    const endpoint = buildUrlWithParams_(url, {
      action: 'getInterviewers',
      adminToken
    });
    const res = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    const text = res.getContentText() || '{}';
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
      return json_({ success: false, error: 'interviewer_fetch_failed', status: res.getResponseCode(), interviewers: [] });
    }
    const remote = JSON.parse(text);
    if (!remote.success) return json_({ success: false, error: remote.error || 'interviewer_fetch_failed', interviewers: [] });
    return json_({ success: true, interviewers: remote.interviewers || [] });
  } catch (err) {
    return json_({ success: false, error: String(err && err.message || err), interviewers: [] });
  }
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

