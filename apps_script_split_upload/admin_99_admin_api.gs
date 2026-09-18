function adminApi(payload) {
  try {
    payload = payload || {};
    if (payload.action === 'adminLogin') return adminLogin_(payload);
    if (payload.action === 'adminLogout') return adminLogout_(payload);

    const hasSession = hasValidAdminSession_(getAdminSessionTokenFromPayload_(payload));
    if (!hasSession && !isGoogleAllowlistedAdmin_()) {
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

function getMainSpreadsheet_() {
  const url = getScriptProperty_('RECRUITMENT_SPREADSHEET_URL');
  if (url) return SpreadsheetApp.openByUrl(url);
  return SpreadsheetApp.getActiveSpreadsheet();
}


