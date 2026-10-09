function isAdminRequest_(payload) {
  const token = String(payload.adminToken || payload.query && payload.query.adminToken || payload.data && payload.data.adminToken || '').trim();
  const configuredToken = getScriptProperty_(ADMIN_TOKEN_PROPERTY);
  return !!configuredToken && token === configuredToken;
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

  let deploymentParts = null;
  try { deploymentParts = checkDeploymentParts_(); } catch (err) { deploymentParts = { checked: false, reason: String(err && err.message || err) }; }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    deploymentParts: deploymentParts,
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

// 배포 파일 짝 맞춤 점검: 일부 파일만 올려 서버 코드와 메일 양식·화면 파일의 버전이 섞이면
// "메일 양식을 만들지 못했습니다" 같은 오류가 원인을 알기 어렵게 난다. 빌드 때 만든 지문 목록
// (admin_98_build_manifest.gs의 BUILD_MANIFEST_)과 실제로 올라가 있는 함수·파일을 비교해 다른 파일을 알려 준다.
// 같은 빌드에서 한 번 맞으면 6시간 동안 다시 계산하지 않는다.
// 비교 방식이 이 환경에서 맞지 않아 전부 다르게 나오면(예: 함수 원문을 읽을 수 없음) 오류 대신 점검 불가로 둔다.
function checkDeploymentParts_() {
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  if (typeof BUILD_MANIFEST_ === 'undefined') {
    return { checked: false, reason: 'manifest_missing', files: ['admin_98_build_manifest.gs'] };
  }
  const manifest = BUILD_MANIFEST_;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'deployment_parts_ok:' + manifest.build;
  if (cache.get(cacheKey)) return { checked: true, ok: true, build: manifest.build, files: [] };

  const fingerprint = text => sha256Hex_(String(text).replace(/\s+/g, '')).slice(0, 12);
  const gsFiles = {};
  let fnTotal = 0;
  let fnMismatch = 0;
  Object.keys(manifest.functions || {}).forEach(function(name) {
    const file = manifest.functions[name][0];
    const expected = manifest.functions[name][1];
    fnTotal++;
    const fn = root[name];
    const actual = typeof fn === 'function' ? fingerprint(Function.prototype.toString.call(fn)) : '';
    if (actual !== expected) { fnMismatch++; gsFiles[file] = true; }
  });
  const htmlFiles = [];
  const htmlNames = Object.keys(manifest.html || {});
  htmlNames.forEach(function(name) {
    let content = null;
    // HtmlOutput.getContent()는 Apps Script가 정규화한 HTML을 반환하므로 원본 빌드 지문과
    // 다를 수 있다. 배포된 파일 원문을 반환하는 HtmlTemplate API로 비교한다.
    try { content = HtmlService.createTemplateFromFile(name).getRawContent(); } catch (err) {}
    if (content == null || fingerprint(content) !== manifest.html[name]) htmlFiles.push(name + '.html');
  });
  const gsUnreliable = fnTotal > 0 && fnMismatch === fnTotal;
  const htmlUnreliable = htmlNames.length > 0 && htmlFiles.length === htmlNames.length;
  const files = (gsUnreliable ? [] : Object.keys(gsFiles)).concat(htmlUnreliable ? [] : htmlFiles).sort();
  const result = {
    checked: !(gsUnreliable && htmlUnreliable),
    ok: files.length === 0,
    build: manifest.build,
    files: files,
    unreliable: gsUnreliable || htmlUnreliable
  };
  if (result.checked && result.ok && !result.unreliable) cache.put(cacheKey, '1', 6 * 60 * 60);
  return result;
}

// 읽기 전용 점검: 과거(순차 전형) 로직에서 저장된 레퍼런스(구) 단계 레코드가 몇 건
// 남아 있는지, 2차면접이 이미 진행된 건은 몇 건인지 등을 집계한다. 아무 것도 쓰지
// 않으며, 새 병행 전형 코드 배포 전에 실행해 이관 대상을 확인하는 용도다.
function getLegacyReferenceStageMigrationPreview_() {
  const candidates = readRows_('Candidates');
  const interviews = readRows_('Interviews');
  const positions = readRows_('Positions');
  const posById = {};
  positions.forEach(p => { posById[String(p.id)] = p; });

  const legacy = candidates.filter(c => String(c.stage) === '레퍼런스');
  const hasInterviewOfType = (candId, type) =>
    interviews.some(i => String(i.candId) === String(candId) && i.type === type);
  const hasDoneFirstInterview = candId =>
    interviews.some(i => String(i.candId) === String(candId) && i.type === '1차' && i.status === 'done');

  const refStatusBreakdown = {};
  const byPositionStatus = {};
  let withSecondInterviewRecord = 0;
  let withoutSecondInterviewRecord = 0;
  let missingFirstInterviewCompletion = 0;
  let lastCompletedStageMismatch = 0;
  let heldCount = 0;

  const details = legacy.map(c => {
    const ref = c.ref || '미시작';
    refStatusBreakdown[ref] = (refStatusBreakdown[ref] || 0) + 1;

    const pos = posById[String(c.posId)];
    const posStatus = pos ? (pos.status || '(미지정)') : '(포지션 없음)';
    byPositionStatus[posStatus] = (byPositionStatus[posStatus] || 0) + 1;

    const hasSecond = hasInterviewOfType(c.id, '2차');
    if (hasSecond) withSecondInterviewRecord++; else withoutSecondInterviewRecord++;

    const firstDone = hasDoneFirstInterview(c.id);
    if (!firstDone) missingFirstInterviewCompletion++;

    // 레퍼런스(2) 단계에 있다면 1차(1)를 완료하고 넘어온 것이 정상이다.
    // lastCompletedStage가 1이 아니면 과거 되돌리기 등으로 생긴 불일치일 수 있다.
    const lastCompletedRaw = c.lastCompletedStage;
    const lastCompleted = (lastCompletedRaw === '' || lastCompletedRaw == null) ? null : Number(lastCompletedRaw);
    if (lastCompleted !== 1) lastCompletedStageMismatch++;

    const isHeld = String(c.held) === 'Y';
    if (isHeld) heldCount++;

    return {
      id: c.id,
      name: c.name,
      posId: c.posId,
      positionTitle: pos ? pos.title : '(알 수 없음)',
      positionStatus: posStatus,
      held: isHeld,
      ref: ref,
      refProgress: `${Number(c.refD) || 0}/${Number(c.refT) || 0}`,
      hasSecondInterviewRecord: hasSecond,
      firstInterviewDone: firstDone,
      lastCompletedStage: lastCompleted,
    };
  });

  return {
    ok: true,
    generatedAt: nowIso_(),
    totalLegacyReferenceCandidates: legacy.length,
    withSecondInterviewRecord: withSecondInterviewRecord,
    withoutSecondInterviewRecord: withoutSecondInterviewRecord,
    refStatusBreakdown: refStatusBreakdown,
    missingFirstInterviewCompletion: missingFirstInterviewCompletion,
    lastCompletedStageMismatch: lastCompletedStageMismatch,
    heldCount: heldCount,
    byPositionStatus: byPositionStatus,
    candidates: details,
    note: '읽기 전용 미리보기입니다. 아무 것도 쓰지 않았습니다 — 실제 이관(stage를 2차면접으로 변경)은 별도로 실행하세요.'
  };
}

// Apps Script 편집기에서 함수를 직접 선택해 실행할 때 쓰는 공개 래퍼. 실행 로그(보기
// > 로그)에서 결과를 확인할 수 있다.
function getLegacyReferenceStageMigrationPreview() {
  const result = getLegacyReferenceStageMigrationPreview_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// 레퍼런스(구) 단계 레코드를 2차면접으로 이관한다 — stage 필드만 바꾸고, 메일 발송이나
// 다른 부수효과는 전혀 일으키지 않는다. 일정·레퍼런스 응답·보고서 등 다른 데이터는
// 그대로 둔다(preserveCompletedStage와 달리 면접 레코드를 만들거나 건드리지 않는다).
// 이미 2차면접으로 넘어간 레코드는 대상에서 빠지므로 여러 번 실행해도 안전하다(멱등).
function migrateLegacyReferenceStageToSecondInterview_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const candidates = readRows_('Candidates');
    const legacy = candidates.filter(c => String(c.stage) === '레퍼런스');
    const migrated = [];
    const failed = [];

    legacy.forEach(c => {
      const next = Object.assign({}, c);
      next.stage = '2차면접';
      // 레퍼런스 단계에 있었다면 1차는 완료된 것이 정상이다. 비어 있을 때만 채우고,
      // 이미 다른 값이 있으면(과거 되돌리기 등) 건드리지 않는다.
      if (next.lastCompletedStage === '' || next.lastCompletedStage == null) {
        next.lastCompletedStage = 1;
      }
      let parsed = null;
      try {
        const output = upsertUnlocked_('Candidates', next, true);
        parsed = JSON.parse(output.getContent());
      } catch (err) {
        parsed = { error: String(err && err.message || err) };
      }
      if (parsed && parsed.status === 'ok') {
        migrated.push({ id: c.id, name: c.name });
      } else {
        failed.push({ id: c.id, name: c.name, error: (parsed && parsed.error) || 'unknown_error' });
      }
    });

    return {
      ok: failed.length === 0,
      generatedAt: nowIso_(),
      migratedCount: migrated.length,
      failedCount: failed.length,
      migrated: migrated,
      failed: failed,
      note: '레퍼런스(구) 단계였던 지원자의 stage만 2차면접으로 변경했습니다. 일정·레퍼런스 응답·보고서는 그대로입니다.'
    };
  } finally {
    lock.releaseLock();
  }
}

// Apps Script 편집기용 공개 래퍼. 실행 전 반드시 getLegacyReferenceStageMigrationPreview()로
// 대상을 먼저 확인할 것.
function migrateLegacyReferenceStageToSecondInterview() {
  const result = migrateLegacyReferenceStageToSecondInterview_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
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
  const check = expectedHash ? verifyAdminPassword_(password, expectedHash) : { ok: false };
  if (!check.ok) {
    recordAdminLoginFailure_(loginId);
    return { ok: false, error: 'invalid_credentials' };
  }
  if (check.upgrade) upgradeAdminPasswordHash_(loginId, password);

  clearAdminLoginFailures_(loginId);
  purgeExpiredAdminSessions_();
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const ttl = getAdminSessionSeconds_();
  saveAdminSession_(token, { loginId, issuedAt: nowIso_(), expiresAt: Date.now() + ttl * 1000 }, ttl);
  return { ok: true, token, loginId, expiresIn: ttl };
}

function adminLogout_(payload) {
  const token = getAdminSessionTokenFromPayload_(payload);
  if (token) {
    CacheService.getScriptCache().remove(adminSessionKey_(token));
    PropertiesService.getScriptProperties().deleteProperty(adminSessionKey_(token));
  }
  return { ok: true };
}

// CacheService는 지정한 TTL 전에도 항목을 임의로 비울 수 있어(best effort) 세션 저장소로만
// 쓰면 로그인이 예고 없이 풀린다. ScriptProperties에 만료시각과 함께 원본을 두고, 캐시는
// 빠른 조회용으로만 쓴다.
function saveAdminSession_(token, session, ttl) {
  const raw = JSON.stringify(session);
  PropertiesService.getScriptProperties().setProperty(adminSessionKey_(token), raw);
  CacheService.getScriptCache().put(adminSessionKey_(token), raw, Math.min(ttl, 6 * 60 * 60));
}

function hasValidAdminSession_(token) {
  token = String(token || '').trim();
  if (!token) return false;
  try {
    const key = adminSessionKey_(token);
    const cached = CacheService.getScriptCache().get(key);
    const raw = cached || PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (!session || !session.loginId) return false;
    const ttl = getAdminSessionSeconds_();
    // 만료시각이 없는 이전 형식 세션은 캐시가 살아 있는 동안만 인정한다.
    const expiresAt = Number(session.expiresAt) || (cached ? Date.now() + ttl * 1000 : 0);
    if (expiresAt <= Date.now()) {
      CacheService.getScriptCache().remove(key);
      PropertiesService.getScriptProperties().deleteProperty(key);
      return false;
    }
    // 사용 중이면 연장한다(남은 시간이 절반 미만일 때만 기록해 쓰기 횟수를 줄인다).
    if (expiresAt - Date.now() < ttl * 500) {
      saveAdminSession_(token, Object.assign({}, session, { expiresAt: Date.now() + ttl * 1000 }), ttl);
    } else if (!cached) {
      CacheService.getScriptCache().put(key, raw, Math.max(60, Math.min(Math.floor((expiresAt - Date.now()) / 1000), 6 * 60 * 60)));
    }
    return true;
  } catch (err) {
    return false;
  }
}

function purgeExpiredAdminSessions_() {
  const store = PropertiesService.getScriptProperties();
  const all = store.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(key => {
    if (key.indexOf('admin_session:') !== 0) return;
    try {
      const session = JSON.parse(all[key] || 'null');
      if (!session || !(Number(session.expiresAt) > now)) store.deleteProperty(key);
    } catch (err) {
      store.deleteProperty(key);
    }
  });
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
    if (allowedId && isAdminPasswordHashFormat_(hash)) users[loginId] = hash;
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

// 관리자 비밀번호 해시: PBKDF2-HMAC-SHA256(계정마다 다른 솔트, 반복 계산) — 'v2$반복횟수$솔트$해시' 형식.
// 예전 형식(솔트 없는 SHA-256 64자리)도 로그인은 되며, 로그인에 성공하면 그 계정만 새 형식으로 바꿔 저장한다.
// 새 계정 해시는 Apps Script 편집기에서 makeAdminPasswordHash('비밀번호')를 실행해 만든다.
const ADMIN_PASSWORD_HASH_ITERATIONS = 2000;
const ADMIN_PASSWORD_HASH_V2_RE = /^v2\$(\d{1,6})\$([a-f0-9]{32,128})\$([a-f0-9]{64})$/;

function isAdminPasswordHashFormat_(hash) {
  return /^[a-f0-9]{64}$/.test(hash) || ADMIN_PASSWORD_HASH_V2_RE.test(hash);
}

function bytesToHex_(bytes) {
  return bytes.map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('');
}

function hexToBytes_(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const v = parseInt(hex.substr(i, 2), 16);
    out.push(v > 127 ? v - 256 : v);
  }
  return out;
}

// PBKDF2-HMAC-SHA256, 출력 32바이트(한 블록).
function pbkdf2Sha256Hex_(password, saltBytes, iterations) {
  const key = Utilities.newBlob(String(password)).getBytes();
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const acc = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < acc.length; j++) acc[j] ^= u[j];
  }
  return bytesToHex_(acc);
}

// 길이가 같으면 끝까지 비교한다(어디서 달라지는지 응답 시간으로 드러나지 않게).
function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyAdminPassword_(password, stored) {
  const m = ADMIN_PASSWORD_HASH_V2_RE.exec(String(stored || ''));
  if (m) {
    const ok = constantTimeEqual_(pbkdf2Sha256Hex_(password, hexToBytes_(m[2]), Number(m[1])), m[3]);
    return { ok: ok, upgrade: ok && Number(m[1]) < ADMIN_PASSWORD_HASH_ITERATIONS };
  }
  const ok = /^[a-f0-9]{64}$/.test(String(stored || '')) && constantTimeEqual_(sha256Hex_(password), stored);
  return { ok: ok, upgrade: ok };
}

function makeAdminPasswordHash(password) {
  const salt = hexToBytes_((Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32));
  return 'v2$' + ADMIN_PASSWORD_HASH_ITERATIONS + '$' + bytesToHex_(salt) + '$' + pbkdf2Sha256Hex_(password || '', salt, ADMIN_PASSWORD_HASH_ITERATIONS);
}

// 로그인에 성공한 계정의 해시만 새 형식으로 바꿔 저장한다. 다른 계정 줄은 그대로 둔다. 실패해도 로그인은 계속된다.
function upgradeAdminPasswordHash_(loginId, password) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = String(props.getProperty(LOCAL_ADMIN_USERS_PROPERTY) || '');
    let replaced = false;
    const entries = raw.split(/[,\n;]/).map(function(entry) { return String(entry || '').trim(); }).filter(Boolean).map(function(entry) {
      const idx = entry.indexOf(':');
      if (idx <= 0 || String(entry.slice(0, idx)).trim().toLowerCase() !== loginId) return entry;
      replaced = true;
      return entry.slice(0, idx).trim() + ':' + makeAdminPasswordHash(password);
    });
    if (replaced) props.setProperty(LOCAL_ADMIN_USERS_PROPERTY, entries.join('\n'));
  } catch (err) {
    console.warn('upgradeAdminPasswordHash_ failed: ' + logErrorText_(err));
  } finally {
    lock.releaseLock();
  }
}

