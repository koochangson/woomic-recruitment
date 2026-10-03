function adminApi(payload) {
  try {
    payload = payload || {};
    if (payload.action === 'adminLogin') return adminLogin_(payload);
    if (payload.action === 'adminLogout') return adminLogout_(payload);

    const hasSession = hasValidAdminSession_(getAdminSessionTokenFromPayload_(payload));
    if (!hasSession) {
      return { error: 'admin_login_required' };
    }

    const nextPayload = Object.assign({}, payload || {});
    nextPayload.adminToken = getScriptProperty_('RECRUITMENT_ADMIN_TOKEN');

    const output = routeRequest_(nextPayload);
    if (output && typeof output.getContent === 'function') {
      const content = output.getContent();
      try {
        return JSON.parse(content);
      } catch (parseErr) {
        return { ok: false, error: 'non_json_response', content: String(content || '') };
      }
    }
    if (typeof output === 'string') {
      try {
        return JSON.parse(output);
      } catch (parseErr) {
        return { ok: false, error: 'non_json_response', content: output };
      }
    }
    if (output && typeof output === 'object') return output;
    return { ok: false, error: 'empty_response' };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}

// Apps Script는 요청(실행)마다 전역을 새로 만든다 — 이 캐시는 한 요청 안에서만 유지된다.
// 한 요청에서 같은 스프레드시트를 openByUrl로 3~4번(본 시트·변경로그·커서) 새로 열고 헤더를
// 매번 다시 읽던 비용(회당 수백 ms~1초 이상)을 없앤다.
const EXEC_CACHE_ = { spreadsheets: {}, sheets: {}, headers: new Map() };

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


