function referralCodeKey_(email) {
  return 'referral_code:' + email;
}

function referralCodeSendKey_(empNo) {
  return 'referral_code_send:' + normalizeEmpNo_(empNo);
}

function referralCodeFailKey_(empNo) {
  return 'referral_code_fail:' + normalizeEmpNo_(empNo);
}

function referralCodeLockKey_(empNo) {
  return 'referral_code_lock:' + normalizeEmpNo_(empNo);
}

function allowReferralCodeSend_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return false;
  const cache = CacheService.getScriptCache();
  const key = referralCodeSendKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
  return count <= REFERRAL_CODE_SEND_LIMIT;
}

function isReferralCodeLocked_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return true;
  return !!CacheService.getScriptCache().get(referralCodeLockKey_(empNo));
}

function recordReferralCodeFailure_(empNo) {
  empNo = normalizeEmpNo_(empNo);
  if (!empNo) return;
  const cache = CacheService.getScriptCache();
  const key = referralCodeFailKey_(empNo);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFERRAL_CODE_VERIFY_LIMIT) {
    cache.put(referralCodeLockKey_(empNo), '1', REFERRAL_CODE_LOCK_SECONDS);
    cache.remove(key);
    cache.remove(referralCodeKey_(empNo));
    return;
  }
  cache.put(key, String(count), REFERRAL_CODE_TTL_SECONDS);
}

function clearReferralCodeFailures_(empNo) {
  const cache = CacheService.getScriptCache();
  cache.remove(referralCodeFailKey_(empNo));
  cache.remove(referralCodeLockKey_(empNo));
}

function referralTokenKey_(token) {
  return 'referral_token:' + String(token || '');
}

