function nowIso_() {
  return new Date().toISOString();
}

function isAdminRequest_(payload) {
  const token = String(payload.adminToken || payload.query && payload.query.adminToken || payload.data && payload.data.adminToken || '').trim();
  const configuredToken = getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  return !!configuredToken && token === configuredToken;
}

function isPublicDeployment_() {
  return getScriptProperty_(DEPLOYMENT_ROLE_PROPERTY).toLowerCase() === 'public';
}

function getScriptProperty_(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getDeploymentConfigStatus_() {
  const role = getScriptProperty_(DEPLOYMENT_ROLE_PROPERTY).toLowerCase();
  const localUsersConfigured = Object.keys(getLocalAdminUsers_()).length > 0;
  const adminTokenConfigured = !!getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  const uploadFolderConfigured = !!getScriptProperty_(REFERRAL_UPLOAD_FOLDER_ID_PROPERTY);
  const mainSpreadsheetConfigured = !!getScriptProperty_(RECRUITMENT_SPREADSHEET_URL_PROPERTY);
  const errors = [];
  const warnings = [];

  if (role === 'public') errors.push('관리자 프로젝트의 배포 역할이 public으로 설정되어 있습니다.');
  if (!localUsersConfigured) errors.push('앱 내부 관리자 계정이 설정되어 있지 않습니다.');
  if (!adminTokenConfigured) errors.push('관리자 내부 API 토큰이 설정되어 있지 않습니다.');
  if (!role) warnings.push('RECRUITMENT_DEPLOYMENT_ROLE이 비어 있습니다. admin 설정을 권장합니다.');
  else if (role !== 'admin' && role !== 'public') warnings.push('RECRUITMENT_DEPLOYMENT_ROLE 값이 올바르지 않습니다.');
  if (!uploadFolderConfigured) warnings.push('REFERRAL_UPLOAD_FOLDER_ID가 없어 이력서 업로드가 실패할 수 있습니다.');
  if (!mainSpreadsheetConfigured) warnings.push('RECRUITMENT_SPREADSHEET_URL이 없어 연결된 기본 시트를 사용합니다.');

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    checks: {
      roleConfigured: role === 'admin',
      adminAuthConfigured: localUsersConfigured && adminTokenConfigured,
      uploadFolderConfigured: uploadFolderConfigured,
      mainSpreadsheetConfigured: mainSpreadsheetConfigured
    }
  };
}

function getDeploymentConfigStatus() {
  return getDeploymentConfigStatus_();
}

function getActiveUserEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (err) {
    return '';
  }
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
    EXPIRED: '만료',
    CANCELLED: '종료'
  };
  return map[String(status || '').toUpperCase()] || '접수';
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

function sendReferralReceipt_(row) {
  try {
    if (!row || !row.refEmail) return;
    const message = [
      '사내추천 접수가 완료되었습니다.',
      '',
      '접수번호: ' + row.id,
      '접수일: ' + String(row.submittedAt || '').slice(0, 10),
      '유효기간: ' + String(row.validUntil || '').slice(0, 10),
      '',
      '접수 현황은 추천 접수 화면에서 동일한 사번 인증 후 확인할 수 있습니다.',
      '',
      '우미건설 피플팀'
    ].join('\n');
    const result = sendMailViaGmail_(row.refEmail, '[우미건설] 사내추천 접수 완료', message);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('sendReferralReceipt_ failed: ' + String(err && err.message || err));
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function adminLogin_(payload) {
  const data = payload && payload.data || {};
  const loginId = String(data.loginId || data.empNo || data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!loginId || !password) return { ok: false, error: 'missing_credentials' };
  if (loginId !== 'admin' && !/^\d+$/.test(loginId)) return { ok: false, error: 'invalid_credentials' };
  if (isAdminLoginLocked_(loginId)) return { ok: false, error: 'login_locked' };

  const users = getLocalAdminUsers_();
  const expectedHash = users[loginId];
  if (!expectedHash || sha256Hex_(password) !== expectedHash) {
    recordAdminLoginFailure_(loginId);
    return { ok: false, error: 'invalid_credentials' };
  }

  clearAdminLoginFailures_(loginId);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const ttl = getAdminSessionSeconds_();
  CacheService.getScriptCache().put(adminSessionKey_(token), JSON.stringify({
    loginId,
    issuedAt: nowIso_()
  }), ttl);
  return { ok: true, token, loginId, expiresIn: ttl };
}

function adminLogout_(payload) {
  const token = getAdminSessionTokenFromPayload_(payload);
  if (token) CacheService.getScriptCache().remove(adminSessionKey_(token));
  return { ok: true };
}

function hasValidAdminSession_(token) {
  token = String(token || '').trim();
  if (!token) return false;
  try {
    const raw = CacheService.getScriptCache().get(adminSessionKey_(token));
    if (!raw) return false;
    const session = JSON.parse(raw);
    return !!session && !!session.loginId;
  } catch (err) {
    return false;
  }
}

function getAdminSessionTokenFromPayload_(payload) {
  return String(payload && (payload.sessionToken || payload.data && payload.data.sessionToken || payload.query && payload.query.sessionToken) || '').trim();
}

function getLocalAdminUsers_() {
  const raw = getScriptProperty_(LOCAL_ADMIN_USERS_PROPERTY);
  const users = {};
  raw.split(/[,\n;]/).forEach(entry => {
    const text = String(entry || '').trim();
    if (!text) return;
    const idx = text.indexOf(':');
    if (idx <= 0) return;
    const loginId = String(text.slice(0, idx) || '').trim().toLowerCase();
    const hash = text.slice(idx + 1).trim().toLowerCase();
    const allowedId = loginId === 'admin' || /^\d+$/.test(loginId);
    if (allowedId && /^[a-f0-9]{64}$/.test(hash)) users[loginId] = hash;
  });
  return users;
}

function getAdminSessionSeconds_() {
  const configured = Number(getScriptProperty_(ADMIN_SESSION_SECONDS_PROPERTY));
  if (!Number.isFinite(configured) || configured <= 0) return 6 * 60 * 60;
  return Math.max(60, Math.min(configured, 6 * 60 * 60));
}

function adminSessionKey_(token) {
  return 'admin_session:' + token;
}

function adminLoginFailKey_(loginId) {
  return 'admin_login_fail:' + loginId;
}

function adminLoginLockKey_(loginId) {
  return 'admin_login_lock:' + loginId;
}

function isAdminLoginLocked_(loginId) {
  return !!CacheService.getScriptCache().get(adminLoginLockKey_(loginId));
}

function recordAdminLoginFailure_(loginId) {
  const cache = CacheService.getScriptCache();
  const key = adminLoginFailKey_(loginId);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= 5) {
    cache.put(adminLoginLockKey_(loginId), '1', 10 * 60);
    cache.remove(key);
  } else {
    cache.put(key, String(count), 10 * 60);
  }
}

function clearAdminLoginFailures_(loginId) {
  const cache = CacheService.getScriptCache();
  cache.remove(adminLoginFailKey_(loginId));
  cache.remove(adminLoginLockKey_(loginId));
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => {
      const normalized = byte < 0 ? byte + 256 : byte;
      return ('0' + normalized.toString(16)).slice(-2);
    })
    .join('');
}

function makeAdminPasswordHash(password) {
  return sha256Hex_(password || '');
}

