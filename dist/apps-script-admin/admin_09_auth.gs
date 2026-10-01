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

