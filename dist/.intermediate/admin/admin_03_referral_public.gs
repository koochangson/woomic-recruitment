function handleReferralSecurityAction_(payload) {
  if (!payload) return null;
  if (payload.action === 'sendReferralVerificationCode') return sendReferralVerificationCode_(payload);
  if (payload.action === 'verifyReferralCode') return verifyReferralCode_(payload);
  if (payload.action === 'uploadReferralFile') return uploadReferralFile_(payload);
  if (payload.action === 'getMyReferrals') return getMyReferrals_(payload);
  if (payload.action === 'getInterviewersFromDirectory') return getInterviewersFromDirectory_(payload);
  if (payload.action === 'issueReferenceCandidateLink') return issueReferenceCandidateLink_(payload);
  if (payload.action === 'issueInterviewAvailabilityLink') return issueInterviewAvailabilityLink_(payload);
  if (payload.action === 'setInterviewAvailabilityDeliveryStatus') return setInterviewAvailabilityDeliveryStatus_(payload);
  if (payload.action === 'verifyInterviewAvailabilityToken') return verifyInterviewAvailabilityToken_(payload);
  if (payload.action === 'submitInterviewAvailability') return submitInterviewAvailability_(payload);
  if (payload.action === 'issueJoinDateLink') return issueJoinDateLink_(payload);
  if (payload.action === 'verifyJoinDateToken') return verifyJoinDateToken_(payload);
  if (payload.action === 'submitJoinDate') return submitJoinDate_(payload);
  if (payload.action === 'issuePanelAvailabilityLink') return issuePanelAvailabilityLink_(payload);
  if (payload.action === 'getPanelAvailabilityResponses') return getPanelAvailabilityResponses_(payload);
  if (payload.action === 'getPanelAvailabilityResponsesBatch') return getPanelAvailabilityResponsesBatch_(payload);
  if (payload.action === 'verifyPanelAvailabilityToken') return verifyPanelAvailabilityToken_(payload);
  if (payload.action === 'submitPanelAvailability') return submitPanelAvailability_(payload);
  if (payload.action === 'verifyReferenceCandidateToken') return verifyReferenceCandidateToken_(payload);
  if (payload.action === 'submitReferenceCandidateReferees') return submitReferenceCandidateReferees_(payload);
  if (payload.action === 'verifyReferenceRefereeToken') return verifyReferenceRefereeToken_(payload);
  if (payload.action === 'verifyRefereeIdentity') return verifyRefereeIdentity_(payload);
  if (payload.action === 'submitReferenceResponse') return submitReferenceResponse_(payload);
  if (payload.action === 'resendReferenceRefereeLink') return resendReferenceRefereeLink_(payload);
  if (payload.action === 'sendReferenceEmail') return sendReferenceEmail_(payload);
  if (payload.action === 'sendGeneralMail') return handleSendGeneralMail_(payload);
  return null;
}

function sendReferralVerificationCode_(payload) {
  const empNo = normalizeEmpNo_(payload.empNo);
  if (isReferralCodeLocked_(empNo)) return json_({ ok: true });
  if (!allowReferralCodeSend_(empNo)) return json_({ ok: true });
  const employee = findActiveEmployeeByEmpNo_(empNo);

  // Do not reveal whether the employee number exists in the employee directory.
  if (!employee) return json_({ ok: true });
  if (!employee.email || !employee.email.includes('@')) return json_({ error: 'employee_email_missing' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put(referralCodeKey_(empNo), JSON.stringify({
    code,
    empNo,
    email: employee.email,
    issuedAt: nowIso_()
  }), REFERRAL_CODE_TTL_SECONDS);

  try {
    const message = [
      '사내추천 접수를 위한 인증번호입니다.',
      '',
      '인증번호: ' + code,
      '',
      '인증번호는 10분 동안 유효합니다.',
      '본인이 요청하지 않았다면 이 메일을 무시해주세요.',
      '',
      '우미건설 피플팀'
    ].join('\n');
    const result = sendMailViaGmail_(employee.email, '[우미건설] 사내추천 인증번호', message);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('sendReferralVerificationCode_ failed: ' + logErrorText_(err));
    return json_({ error: 'mail_send_failed' });
  }

  return json_({ ok: true });
}

