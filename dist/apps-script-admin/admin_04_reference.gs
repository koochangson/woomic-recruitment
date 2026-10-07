function buildReferenceCandidateLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_CANDIDATE_PAGE_URL') || REFERENCE_CANDIDATE_PAGE_URL, { token });
}

function buildReferenceResponseLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('REFERENCE_RESPONSE_PAGE_URL') || REFERENCE_RESPONSE_PAGE_URL, { token });
}

function buildInterviewAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, { token });
}

function normalizeInterviewAvailabilityOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, 7).map(item => {
    const date = String(item && item.date || '').trim();
    const periods = Array.isArray(item && item.periods)
      ? item.periods.map(v => String(v || '').toUpperCase()).filter(v => v === 'AM' || v === 'PM')
      : [];
    return { date, periods: periods.filter((v, i, arr) => arr.indexOf(v) === i) };
  }).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.periods.length);
}

function interviewAvailabilityExpired_(row) {
  return !!(row.availabilityExpiresAt && new Date(row.availabilityExpiresAt).getTime() < Date.now());
}

function issueInterviewAvailabilityLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const interviewId = String(body.interviewId || body.id || '').trim();
  const candId = String(body.candId || '').trim();
  const candName = String(body.candName || '').trim();
  const responseBy = body.responseBy === 'headhunter' ? 'headhunter' : 'candidate';
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!interviewId || !candId || !candName || !options.length) return json_({ error: 'missing_interview_availability_fields' });

  const sheet = ensureSheet_('Interviews');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
  const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
  const existing = readRows_('Interviews').find(row => String(row.id) === interviewId) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const link = buildInterviewAvailabilityLinkUrl_(token);
  const row = Object.assign({}, existing, {
    id: interviewId,
    candId,
    candName,
    type: String(body.type || existing.type || ''),
    loc: String(body.loc || existing.loc || ''),
    status: existing.status || 'pending',
    availabilityOptions: JSON.stringify(options),
    availabilityToken: token,
    availabilityExpiresAt: expiresAt,
    availabilityLink: link,
    availabilitySelections: '',
    availabilityStatus: 'READY',
    availabilityRespondedAt: '',
    availabilityNote: '',
    availabilityResponseBy: responseBy,
    availabilityResponderName: String(body.responderName || '').trim(),
    availabilityResponderEmail: normalizeEmail_(body.responderEmail || ''),
    availabilityResponderOrg: String(body.responderOrg || '').trim(),
    availabilityProxyConfirmedAt: '',
    updatedAt: nowIso_()
  });
  const normalized = schemaRow_('Interviews', row);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);
  appendChange_('Interviews', 'upsert', interviewId, normalized);
  return json_({ ok: true, interviewId, link, tokenExpiresAt: expiresAt });
}

function setInterviewAvailabilityDeliveryStatus_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const interviewId = String(body.interviewId || body.id || '').trim();
  const status = String(body.status || '').trim().toUpperCase();
  if (!interviewId || !['SENT', 'SEND_FAILED'].includes(status)) {
    return json_({ error: 'invalid_interview_availability_delivery_status' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'id', interviewId, headers);
    if (rowIndex < 1) return json_({ error: 'interview_not_found' });
    const existing = readRows_('Interviews').find(row => String(row.id) === interviewId);
    if (!existing) return json_({ error: 'interview_not_found' });
    const normalized = schemaRow_('Interviews', Object.assign({}, existing, {
      availabilityStatus: status,
      updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([
      headers.map(header => normalized[header] == null ? '' : normalized[header])
    ]);
    appendChange_('Interviews', 'upsert', interviewId, normalized);
    return json_({ ok: true, interviewId, status });
  } finally {
    lock.releaseLock();
  }
}

function verifyInterviewAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  let selections = [];
  try { selections = JSON.parse(row.availabilitySelections || '[]'); } catch (err) {}
  const candidate = readRows_('Candidates').find(item => String(item.id) === String(row.candId)) || {};
  return json_({
    ok: true,
    candName: row.candName || '',
    positionText: candidate.pos || '',
    interviewType: row.type || '',
    location: row.loc || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.availabilityStatus === 'RESPONDED' || row.availabilityStatus === 'UNAVAILABLE',
    unavailable: row.availabilityStatus === 'UNAVAILABLE',
    selections,
    note: row.availabilityNote || '',
    responseBy: row.availabilityResponseBy || 'candidate',
    responderName: row.availabilityResponderName || '',
    responderEmail: row.availabilityResponderEmail || '',
    responderOrg: row.availabilityResponderOrg || '',
    proxyConfirmed: !!row.availabilityProxyConfirmedAt
  });
}

function submitInterviewAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(v => String(v || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  const proxyConfirmed = body.proxyConfirmed === true || String(body.proxyConfirmed || '').toLowerCase() === 'true';
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('Interviews');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.Interviews);
    const rowIndex = findRowIndex_(sheet, 'availabilityToken', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('Interviews').find(item => String(item.availabilityToken || '') === token);
    if (row && candidateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (interviewAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (row.availabilityResponseBy === 'headhunter' && !proxyConfirmed) return json_({ ok: false, error: 'proxy_confirmation_required' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, arr) => allowed[value] && arr.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const next = Object.assign({}, row, {
      availabilitySelections: JSON.stringify(unavailable ? [] : selections),
      availabilityStatus: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      availabilityRespondedAt: nowIso_(),
      availabilityNote: note,
      availabilityProxyConfirmedAt: row.availabilityResponseBy === 'headhunter' ? nowIso_() : '',
      updatedAt: nowIso_()
    });
    const normalized = schemaRow_('Interviews', next);
    sheet.getRange(rowIndex, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('Interviews', 'upsert', row.id, normalized);
    notifyIfInterviewAvailabilityCohortComplete_(normalized);
    return json_({ ok: true, status: normalized.availabilityStatus, respondedAt: normalized.availabilityRespondedAt });
  } finally {
    lock.releaseLock();
  }
}

// 담당자 알림을 받을 주소 — 설정(Settings 시트) 'notifyEmail' 값을 사용한다.
// ── 최종합격 통보 · 입사 가능일 회신 ─────────────────────────────
// 피플팀이 제안한 입사 가능 날짜 중 하나를 지원자가 공개 페이지(join_date.html)에서 고른다.
// 지원자 한 명당 한 줄(JoinDateRequests, id = 지원자 id)이며 다시 보내면 새 토큰으로 덮어쓴다.
const JOIN_DATE_PAGE_URL = 'https://wmpeopleteam.github.io/reference-check/join_date.html';
const JOIN_DATE_LINK_TTL_DAYS = 21;

function normalizeJoinDateOptions_(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch (err) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source.map(v => String(v || '').trim().slice(0, 10))
    .filter((v, i, arr) => /^\d{4}-\d{2}-\d{2}$/.test(v) && arr.indexOf(v) === i)
    .sort()
    .slice(0, 31);
}

function joinDateRequestExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

// 최종합격(5) 단계인 지원자만 회신할 수 있다(불합격·보류·입사 처리 후에는 받지 않는다).
function joinDateProcessClosed_(candId) {
  const cand = readRows_('Candidates').find(row => String(row.id) === String(candId));
  if (!cand) return true;
  if (String(cand.held || '') === 'Y') return true;
  return !['5', '최종합격'].includes(String(cand.stage == null ? '' : cand.stage).trim());
}

function issueJoinDateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const candId = String(body.candId || '').trim();
  const candName = String(body.candName || '').trim();
  const options = normalizeJoinDateOptions_(body.options);
  if (!candId || !candName || !options.length) return json_({ error: 'missing_join_date_fields' });
  if (joinDateProcessClosed_(candId)) return json_({ error: 'process_closed' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'id', candId, headers);
    const existing = readRows_('JoinDateRequests').find(row => String(row.id) === candId) || {};
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + JOIN_DATE_LINK_TTL_DAYS * 86400000).toISOString();
    const link = buildUrlWithParams_(JOIN_DATE_PAGE_URL, { token });
    const row = schemaRow_('JoinDateRequests', Object.assign({}, existing, {
      id: candId, candId, candName, positionText: String(body.positionText || '').trim(),
      options: JSON.stringify(options), token, tokenExpiresAt: expiresAt, link,
      deadline: String(body.deadline || '').trim().slice(0, 10),
      selection: '', status: 'SENT', note: '', respondedAt: '',
      responseBy: body.responseBy === 'headhunter' ? 'headhunter' : 'candidate',
      createdAt: existing.createdAt || nowIso_(), updatedAt: nowIso_()
    }));
    const values = headers.map(header => row[header] == null ? '' : row[header]);
    if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]); else sheet.appendRow(values);
    appendChange_('JoinDateRequests', 'upsert', candId, row);
    return json_({ ok: true, id: candId, link, tokenExpiresAt: expiresAt });
  } finally {
    lock.releaseLock();
  }
}

function verifyJoinDateToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
  if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true, candName: row.candName || '', positionText: row.positionText || '',
    options: normalizeJoinDateOptions_(row.options), deadline: row.deadline || '',
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE', selection: row.selection || '', note: row.note || '',
    responseBy: row.responseBy || 'candidate'
  });
}

function submitJoinDate_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const selection = String(body.selection || '').trim().slice(0, 10);
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !selection) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('JoinDateRequests');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.JoinDateRequests);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    const row = readRows_('JoinDateRequests').find(item => String(item.token || '') === token);
    if (rowIndex < 0 || !row) return json_({ ok: false, error: 'invalid_token' });
    if (joinDateProcessClosed_(row.candId)) return json_({ ok: false, error: 'process_closed' });
    if (joinDateRequestExpired_(row)) return json_({ ok: false, error: 'token_expired' });
    if (row.status === 'RESPONDED' || row.status === 'UNAVAILABLE') return json_({ ok: false, error: 'already_submitted' });
    if (!unavailable && normalizeJoinDateOptions_(row.options).indexOf(selection) < 0) return json_({ ok: false, error: 'invalid_selection' });
    const next = schemaRow_('JoinDateRequests', Object.assign({}, row, {
      selection: unavailable ? '' : selection, status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      note, respondedAt: nowIso_(), updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([headers.map(header => next[header] == null ? '' : next[header])]);
    appendChange_('JoinDateRequests', 'upsert', row.id, next);
    // 담당자 알림(설정의 '일정 응답 완료 알림 받을 이메일')
    const choice = unavailable ? '제안 날짜 모두 어려움 · 희망: ' + note : '입사 가능일 ' + selection + (note ? ' · 메모: ' + note : '');
    sendCohortCompleteNotice_('[입사일 회신] ' + (row.candName || '') + '님 ' + (unavailable ? '날짜 조정 요청' : selection),
      (row.candName || '') + '님이 입사일을 회신했습니다.\n\n' + choice + '\n\n채용 관리 화면의 입사 안내에서 확인해 주세요.');
    return json_({ ok: true, status: next.status, respondedAt: next.respondedAt });
  } finally {
    lock.releaseLock();
  }
}

function getNotifyEmail_() {
  return getFirstSettingValue_(['notifyEmail']);
}

function sendCohortCompleteNotice_(subject, message) {
  const to = getNotifyEmail_();
  if (!to) return;
  try {
    sendMailViaGmail_(to, subject, message, '');
  } catch (err) {
    console.warn('sendCohortCompleteNotice_ failed: ' + (err && err.message || err));
  }
}

// 지원자 전원(해당 포지션·회차 발송 대상)이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfInterviewAvailabilityCohortComplete_(justUpdatedRow) {
  const cand = readRows_('Candidates').find(c => String(c.id) === String(justUpdatedRow.candId));
  if (!cand || !cand.posId) return;
  const cohortCandIds = readRows_('Candidates')
    .filter(c => String(c.posId) === String(cand.posId))
    .map(c => String(c.id));
  const cohort = readRows_('Interviews').filter(i =>
    i.type === justUpdatedRow.type &&
    cohortCandIds.includes(String(i.candId)) &&
    ['SENT', 'RESPONDED', 'UNAVAILABLE'].includes(i.availabilityStatus)
  );
  if (!cohort.length || !cohort.every(i => i.availabilityStatus === 'RESPONDED' || i.availabilityStatus === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${cand.pos || '포지션'} ${justUpdatedRow.type} 지원자 전원 일정 응답 완료`,
    `${cand.pos || '포지션'} ${justUpdatedRow.type} 대상 지원자 ${cohort.length}명 전원이 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
}

// 면접관 전원이 가능일정 응답을 마치면 담당자에게 1회 알림을 보낸다.
function notifyIfPanelAvailabilityCohortComplete_(justUpdatedRow) {
  const cohort = readRows_('PanelAvailability').filter(r =>
    String(r.positionId) === String(justUpdatedRow.positionId) &&
    String(r.round) === String(justUpdatedRow.round)
  );
  if (!cohort.length || !cohort.every(r => r.status === 'RESPONDED' || r.status === 'UNAVAILABLE')) return;
  sendCohortCompleteNotice_(
    `[우미건설] ${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 전원 일정 응답 완료`,
    `${justUpdatedRow.positionTitle || '포지션'} ${justUpdatedRow.round} 면접관 ${cohort.length}명 전원이 참석 가능 일정 응답을 마쳤습니다.\n대시보드에서 공통 일정을 확정해 주세요.`
  );
}

function referenceLinkExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

function invalidatePriorReferenceCandidateLinks_(sheet, headers, pipelineCandId, candEmail) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const idIndex = headers.indexOf('pipelineCandId');
  const emailIndex = headers.indexOf('candEmail');
  const tokenIndex = headers.indexOf('token');
  const expiresIndex = headers.indexOf('tokenExpiresAt');
  const linkIndex = headers.indexOf('link');
  const submittedIndex = headers.indexOf('refereesSubmittedAt');
  const statusIndex = headers.indexOf('status');
  const updatedIndex = headers.indexOf('updatedAt');
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const invalidated = [];
  const updatedAt = nowIso_();

  rows.forEach(function(values) {
    const matches = pipelineCandId
      ? String(values[idIndex] || '') === pipelineCandId
      : normalizeEmail_(values[emailIndex]) === candEmail;
    if (!matches || !String(values[tokenIndex] || '').trim()) return;
    values[tokenIndex] = '';
    values[expiresIndex] = '';
    values[linkIndex] = '';
    if (!values[submittedIndex]) values[statusIndex] = 'REPLACED';
    values[updatedIndex] = updatedAt;
    invalidated.push(values);
  });

  if (!invalidated.length) return 0;
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  invalidated.forEach(function(values) {
    const row = {};
    headers.forEach(function(header, index) { row[header] = values[index]; });
    appendChange_('ReferenceCandidates', 'upsert', row.id, row);
  });
  return invalidated.length;
}

// 대시보드에서 후보자가 "레퍼런스" 단계로 이동할 때(또는 관리자가 재발급할 때) 관리자 권한으로 호출.
// 후보자용 추천인 등록 링크를 발급만 하고 반환한다 — 메일은 서버가 자동 발송하지 않는다.
// 후보자에게 추천인 등록 링크를 발급한다. 실제 안내 메일은 대시보드에서
// 관리자가 미리보기 후 Gmail/MailApp 발송 버튼을 눌러 처리한다.
// google.script.run(adminApi)로 호출되면 후보자 필드가 payload.data에 담겨 오고,
// 외부 fetch(POST)로 호출되면 payload 최상위에 바로 담겨 온다 — 둘 다 지원한다.
function issueReferenceCandidateLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const candName = String(body.candName || '').trim();
  const candEmail = normalizeEmail_(body.candEmail);
  const positionText = String(body.positionText || '').trim();
  const pipelineCandId = String(body.candId || '').trim();
  if (!candName || !candEmail) return json_({ error: 'missing_candidate_fields' });

  const token = Utilities.getUuid();
  const link = buildReferenceCandidateLinkUrl_(token);
  const row = {
    id: 'RC-' + Utilities.getUuid(),
    pipelineCandId, candName, candEmail, positionText, token,
    tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    deadlineAt: addReferenceDays_(new Date(), REFERENCE_CANDIDATE_DEADLINE_DAYS).toISOString(),
    link,
    refereesSubmittedAt: '',
    status: 'SENT',
    createdAt: nowIso_(),
    updatedAt: nowIso_()
  };
  const sheet = ensureSheet_('ReferenceCandidates');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceCandidates);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidatePriorReferenceCandidateLinks_(sheet, headers, pipelineCandId, candEmail);
    sheet.appendRow(headers.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceCandidates', 'upsert', row.id, row);
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true, id: row.id, link, candName, candEmail, tokenExpiresAt: row.tokenExpiresAt, deadlineAt: row.deadlineAt });
}

// 후보자가 등록 링크를 열었을 때 화면에 본인 이름을 띄우기 위한 토큰 검증.
function verifyReferenceCandidateToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceCandidates').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    candName: row.candName,
    positionText: row.positionText,
    alreadySubmitted: !!row.refereesSubmittedAt
  });
}

// 후보자가 추천인 목록(이름/이메일/관계/소속)을 제출하면, 추천인별로 별도 토큰을 발급해
// ReferenceResponses에 한 줄씩 만들고 각 추천인에게 응답 링크를 메일로 보낸다.
function submitReferenceCandidateReferees_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return submitReferenceCandidateRefereesUnlocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

function submitReferenceCandidateRefereesUnlocked_(payload) {
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const referees = Array.isArray(body.referees) ? body.referees : [];
  if (!token) return json_({ error: 'token_required' });
  if (referees.length !== REFERENCE_REQUIRED_REFEREES) return json_({ error: 'exactly_three_referees_required' });

  const candSheet = ensureSheet_('ReferenceCandidates');
  const candHeaders = ensureHeaders_(candSheet, SHEET_SCHEMAS.ReferenceCandidates);
  const rowIndex = findRowIndex_(candSheet, 'token', token, candHeaders);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const candRow = readRows_('ReferenceCandidates').find(row => String(row.token || '') === token);
  if (!candRow) return json_({ error: 'invalid_token' });
  if (candidateProcessClosed_(candRow.pipelineCandId)) return json_({ error: 'process_closed' });
  if (referenceLinkExpired_(candRow)) return json_({ error: 'token_expired' });
  if (candRow.refereesSubmittedAt) return json_({ error: 'already_submitted' });

  // 일부만 유효하고 일부가 빠진 상태로 시트에 쓰거나 메일을 보내기 시작하면 안 되므로,
  // 쓰기/발송을 시작하기 전에 3명 전원의 필수값(이름·이메일·전화번호)을 먼저 검증한다.
  const normalizedReferees = referees.map(ref => ({
    name: String(ref && ref.name || '').trim(),
    email: normalizeEmail_(ref && ref.email),
    phone: normalizePhone_(ref && ref.phone),
    relation: String(ref && ref.relation || '').trim(),
    company: String(ref && ref.company || '').trim(),
  }));
  if (normalizedReferees.some(r => !r.name || !r.email || !r.phone)) {
    return json_({ error: 'referee_fields_incomplete' });
  }
  const emailSet = {};
  if (normalizedReferees.some(r => emailSet[r.email] ? true : (emailSet[r.email] = true, false))) {
    return json_({ error: 'duplicate_referee_email' });
  }

  const responseSheet = ensureSheet_('ReferenceResponses');
  const responseHeaders = ensureHeaders_(responseSheet, SHEET_SCHEMAS.ReferenceResponses);
  let issuedCount = 0;

  normalizedReferees.forEach(ref => {
    const refereeName = ref.name;
    const refereeEmail = ref.email;
    const refereePhone = ref.phone;
    const refereeRelation = ref.relation;
    const refereeCompany = ref.company;
    const refToken = Utilities.getUuid();
    const refLink = buildReferenceResponseLinkUrl_(refToken);
    const row = {
      id: 'RR-' + Utilities.getUuid(),
      referenceCandidateId: candRow.id,
      pipelineCandId: candRow.pipelineCandId || '',
      candName: candRow.candName,
      refereeName, refereeEmail, refereePhone, refereeRelation, refereeCompany,
      token: refToken,
      tokenExpiresAt: new Date(Date.now() + REFERENCE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      deadlineAt: addReferenceDays_(new Date(), REFERENCE_RESPONSE_DEADLINE_DAYS).toISOString(),
      link: refLink,
      verifiedAt: '',
      submittedAt: '',
      status: 'SENT',
      updatedAt: nowIso_()
    };
    responseSheet.appendRow(responseHeaders.map(h => row[h] == null ? '' : row[h]));
    appendChange_('ReferenceResponses', 'upsert', row.id, row);
    issuedCount++;

    // 이 단계는 후보자 본인이 공개 페이지에서 직접 트리거하는 액션이라 관리자 검토 발송을 거칠 수 없다.
    // 그래서 서버가 Gmail/MailApp로 추천인에게 안내 메일을 자동 발송한다.
    try {
      const message = [
        refereeName + '님, 안녕하세요.',
        '',
        candRow.candName + '님께서 우미건설 채용 과정에서 ' + refereeName + '님을 추천인으로 등록해 주셨습니다.',
        '',
        '아래 버튼을 통해 레퍼런스 체크 설문에 참여해 주시기 바랍니다.',
        '',
        '설문 참여 링크',
        refLink,
        '',
        '설문 응답에는 약 10분 정도 소요됩니다.',
        '응답해 주신 내용은 채용 검토 목적으로만 활용됩니다.',
        '응답 기한: ' + formatReferenceDateTime_(row.deadlineAt, true),
        `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
        '',
        '감사합니다.',
        '우미건설 피플팀 드림'
      ].join('\n');
      const result = sendMailViaGmail_(
        refereeEmail,
        '[우미건설] ' + candRow.candName + '님 레퍼런스 체크 요청',
        message,
        referenceMailHtml_(message, {
          templateType: 'referee_request',
          candidateName: candRow.candName,
          refereeName,
          positionText: candRow.positionText || '',
          link: refLink,
          deadline: row.deadlineAt
        })
      );
      if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    } catch (err) {
      console.warn('submitReferenceCandidateReferees_ mail failed: ' + String(err && err.message || err));
    }
  });

  if (issuedCount !== REFERENCE_REQUIRED_REFEREES) return json_({ error: 'exactly_three_referees_required' });

  const updatedAtCol = candHeaders.indexOf('updatedAt') + 1;
  const submittedAtCol = candHeaders.indexOf('refereesSubmittedAt') + 1;
  const statusCol = candHeaders.indexOf('status') + 1;
  candSheet.getRange(rowIndex, submittedAtCol).setValue(nowIso_());
  candSheet.getRange(rowIndex, statusCol).setValue('REFEREES_REGISTERED');
  candSheet.getRange(rowIndex, updatedAtCol).setValue(nowIso_());
  appendChange_('ReferenceCandidates', 'upsert', candRow.id, { status: 'REFEREES_REGISTERED' });

  return json_({ ok: true, count: issuedCount });
}

// 추천인이 응답 링크를 열었을 때의 1차 확인 — 링크 자체가 살아있는지만 본다.
// 아직 본인 확인(이메일·전화번호) 전이라 후보자명은 여기서 보여주지 않는다(신원 미확인 상태에서 노출 방지).
function verifyReferenceRefereeToken_(payload) {
  const token = String(payload.token || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('ReferenceResponses').find(r => r.token === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });
  return json_({ ok: true });
}

// 링크 확인 다음 단계 — 등록 시 후보자가 입력한 이메일·전화번호와 일치하는지 확인한 뒤에만
// 후보자명을 공개하고 12문항 응답 폼을 열어준다. 링크만 유출돼도 아무나 응답할 수 없게 하는
// 최소한의 신원 확인 장치(강력한 인증은 아니지만, 링크를 잘못 전달받은 제3자를 걸러낸다).
function refereeVerifyFailKey_(token) {
  return 'referee_verify_fail:' + String(token || '');
}

function refereeVerifyLockKey_(token) {
  return 'referee_verify_lock:' + String(token || '');
}

function isRefereeVerifyLocked_(token) {
  if (!token) return true;
  return !!CacheService.getScriptCache().get(refereeVerifyLockKey_(token));
}

function recordRefereeVerifyFailure_(token) {
  if (!token) return;
  const cache = CacheService.getScriptCache();
  const key = refereeVerifyFailKey_(token);
  const count = Number(cache.get(key) || '0') + 1;
  if (count >= REFEREE_VERIFY_ATTEMPT_LIMIT) {
    cache.put(refereeVerifyLockKey_(token), '1', REFEREE_VERIFY_LOCK_SECONDS);
    cache.remove(key);
    return;
  }
  cache.put(key, String(count), REFEREE_VERIFY_LOCK_SECONDS);
}

function clearRefereeVerifyFailures_(token) {
  const cache = CacheService.getScriptCache();
  cache.remove(refereeVerifyFailKey_(token));
  cache.remove(refereeVerifyLockKey_(token));
}

function verifyRefereeIdentity_(payload) {
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const email = normalizeEmail_(body.email);
  const phone = normalizePhone_(body.phone);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!email || !phone) return json_({ ok: false, error: 'identity_fields_required' });
  if (isRefereeVerifyLocked_(token)) return json_({ ok: false, error: 'too_many_attempts' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
  const row = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (candidateProcessClosed_(row.pipelineCandId)) return json_({ ok: false, error: 'process_closed' });
  if (referenceLinkExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  if (row.submittedAt) return json_({ ok: false, error: 'already_submitted' });

  // 이메일·전화번호 중 하나만 일치해도 통과(둘 다 일치해야 하는 건 너무 엄격함).
  if (normalizeEmail_(row.refereeEmail) !== email && normalizePhone_(row.refereePhone) !== phone) {
    recordRefereeVerifyFailure_(token);
    return json_({ ok: false, error: 'identity_mismatch' });
  }
  clearRefereeVerifyFailures_(token);

  const verifiedAtCol = headers.indexOf('verifiedAt') + 1;
  if (verifiedAtCol > 0) sheet.getRange(rowIndex, verifiedAtCol).setValue(nowIso_());

  return json_({ ok: true, candName: row.candName, refereeName: row.refereeName });
}

// 추천인의 12문항 응답을 저장한다. 토큰 1개당 1회만 제출 가능.
function submitReferenceResponse_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return submitReferenceResponseUnlocked_(payload);
  } finally {
    lock.releaseLock();
  }
}

function submitReferenceResponseUnlocked_(payload) {
  const token = String(payload.token || '').trim();
  const answers = payload.answers || {};
  if (!token) return json_({ error: 'token_required' });

  const sheet = ensureSheet_('ReferenceResponses');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.ReferenceResponses);
  const rowIndex = findRowIndex_(sheet, 'token', token, headers);
  if (rowIndex < 0) return json_({ error: 'invalid_token' });
  const existing = readRows_('ReferenceResponses').find(item => String(item.token || '') === token);
  if (!existing) return json_({ error: 'invalid_token' });
  if (candidateProcessClosed_(existing.pipelineCandId)) return json_({ error: 'process_closed' });
  if (existing.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(existing)) return json_({ error: 'token_expired' });
  if (!existing.verifiedAt) return json_({ error: 'identity_not_verified' });

  const ANSWER_KEYS = ['q1_periodStart','q1_periodEnd','q1_relation','q1_frequency',
    'q1_2_mainTask','q1_2_projectScale','q1_2_soloVsShared',
    'q2_startStyle',
    'q3_judgeStyle','q3_initiative',
    'q4_successNarrative','q4_failureNarrative',
    'q5_feedbackResponse',
    'q6_conflictStyle','q6_example',
    'q7_entrustedRoles',
    'q8_reliableAreas','q8_supportNeededAreas',
    'q9_word','q9_reason',
    'q10_firstAction','q10_sharedTiming',
    'q11_juniorSupportStyle','q11_example',
    'q12_exitReasonSource','q12_exitReasonDetail',
    'respondentName','respondentAffiliation','respondentContact','respondentConsentObserved','respondentConsentDataUse'];
  const merged = Object.assign({}, existing);
  ANSWER_KEYS.forEach(key => { merged[key] = String(answers[key] == null ? '' : answers[key]).trim(); });
  merged.submittedAt = nowIso_();
  merged.status = 'SUBMITTED';
  merged.updatedAt = nowIso_();

  const values = headers.map(h => merged[h] == null ? '' : merged[h]);
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  appendChange_('ReferenceResponses', 'upsert', existing.id, merged);

  try {
    const message = [
      existing.refereeName + '님, 안녕하세요.',
      '',
      existing.candName + '님에 대한 레퍼런스 설문 응답이 정상적으로 접수되었습니다.',
      '',
      '바쁘신 중에도 시간을 내어 주셔서 진심으로 감사드립니다.',
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    const result = sendMailViaGmail_(
      existing.refereeEmail,
      '[우미건설] ' + existing.candName + '님 레퍼런스 체크 응답 접수 완료',
      message,
      referenceMailHtml_(message, {
        templateType: 'referee_complete',
        candidateName: existing.candName,
        refereeName: existing.refereeName,
        positionText: '',
        submittedAt: merged.submittedAt
      })
    );
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('submitReferenceResponse_ completion mail failed: ' + String(err && err.message || err));
  }

  return json_({ ok: true });
}

// 관리자가 대시보드에서 미응답 추천인에게 리마인드 메일을 다시 보낼 때 사용.
// 새 토큰을 발급하지 않고 기존 링크를 그대로 재발송한다(이미 열어본 링크가 있을 수 있으므로).
function resendReferenceRefereeLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const id = String(payload.id || '').trim();
  if (!id) return json_({ error: 'missing_id' });
  const row = readRows_('ReferenceResponses').find(r => String(r.id) === id);
  if (!row) return json_({ error: 'not_found' });
  if (row.submittedAt) return json_({ error: 'already_submitted' });
  if (referenceLinkExpired_(row)) return json_({ error: 'token_expired' });

  try {
    const message = [
      row.refereeName + '님, 안녕하세요.',
      '',
      row.candName + '님께서 우미건설 채용 과정에서 ' + row.refereeName + '님을 추천인으로 등록해 주셨습니다.',
      '',
      '아래 버튼을 통해 레퍼런스 체크 설문에 참여해 주시기 바랍니다.',
      '',
      '설문 참여 링크',
      buildReferenceResponseLinkUrl_(row.token),
      '',
      '설문 응답에는 약 10분 정도 소요됩니다.',
      '응답해 주신 내용은 채용 검토 목적으로만 활용됩니다.',
      '응답 기한: ' + formatReferenceDateTime_(referenceDisplayDeadline_(row), true),
      `본 링크는 발송일로부터 ${REFERENCE_LINK_TTL_DAYS}일간 유효합니다.`,
      '',
      '감사합니다.',
      '우미건설 피플팀 드림'
    ].join('\n');
    const result = sendMailViaGmail_(
      row.refereeEmail,
      '[우미건설] ' + row.candName + '님 레퍼런스 체크 응답 재안내',
      message,
      referenceMailHtml_(message, {
        templateType: 'referee_reminder',
        candidateName: row.candName,
        refereeName: row.refereeName,
        positionText: '',
        link: buildReferenceResponseLinkUrl_(row.token),
        deadline: referenceDisplayDeadline_(row)
      })
    );
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('resendReferenceRefereeLink_ mail failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
  return json_({ ok: true });
}

function sendReferenceEmail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const to = normalizeEmail_(body.toEmail || body.to || body.email);
  const subject = String(body.subject || '').trim();
  const message = String(body.body || body.message || '').trim();
  if (!to || !subject || !message) return json_({ error: 'missing_mail_fields' });
  const templateType = String(body.templateType || body.templateKey || body.mailType || '').trim();
  if (!REFERENCE_MAIL_TEMPLATE_FILES[templateType]) return json_({ error: 'reference_template_type_required' });
  try {
    const html = insertForwardNotice_(referenceMailHtml_(message, body), body);
    const result = sendMailViaGmail_(to, subject, htmlToPlainText_(html) || message, html);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
  } catch (err) {
    console.warn('sendReferenceEmail_ failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
  return json_({ ok: true, to: to });
}

function escapeMailHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REFERENCE_MAIL_TEMPLATE_FILES = {
  candidate_request: 'mail_01_reference_candidate_request',
  candidate_reminder: 'mail_02_reference_candidate_reminder',
  referee_request: 'mail_03_reference_referee_request',
  referee_reminder: 'mail_04_reference_referee_reminder',
  referee_complete: 'mail_05_reference_referee_complete'
};

// 헤드헌팅 경유 발송: 지원자에게 가는 것과 같은 템플릿을 업체 담당자에게 보내고, 본문 맨 위에
// "후보자에게 전달해 달라"는 안내 상자만 덧붙인다(예전에는 별도 headhunter_forward 템플릿에 텍스트를 넣었다).
// 템플릿의 {{josa:으로/로}}·{{josa:을/를}}·{{josa:이/가}}·{{josa:은/는}}·{{josa:과/와}} 표기를
// 바로 앞 글자(태그·공백 제외)의 받침에 맞춰 고른다. 예: "인테리어{{josa:으로/로}}" → "인테리어로",
// "공무팀{{josa:으로/로}}" → "공무팀으로". 숫자는 읽는 소리로 판단하고, 판단할 수 없는 글자
// (영문 등)는 "(으)로"처럼 두 형태를 함께 쓴다.
function koreanFinalConsonant_(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const jong = (code - 0xAC00) % 28;
    return jong === 0 ? 'none' : (jong === 8 ? 'rieul' : 'other');
  }
  const digit = { '0':'other', '1':'rieul', '2':'none', '3':'other', '4':'none', '5':'none', '6':'other', '7':'rieul', '8':'rieul', '9':'none' };
  return digit[ch] || 'unknown';
}

function applyKoreanJosa_(html) {
  return String(html || '').replace(/\{\{josa:([^/}]+)\/([^}]+)\}\}/g, function(token, withFinal, withoutFinal, offset, whole) {
    const before = whole.slice(0, offset).replace(/<[^>]*>/g, '').replace(/[\s"'”’)\]]+$/, '');
    const last = before.slice(-1);
    const kind = last ? koreanFinalConsonant_(last) : 'unknown';
    if (kind === 'unknown') return withFinal === '으로' ? '(으)로' : withFinal + '(' + withoutFinal + ')';
    if (withFinal === '으로') return kind === 'other' ? '으로' : '로';
    return kind === 'none' ? withoutFinal : withFinal;
  });
}

// HTML 메일 → 텍스트 버전(HTML을 못 여는 메일 앱용). 숨김 프리헤더·스타일은 빼고,
// 링크는 "문구 (주소)"로 남기며 줄바꿈 구조만 살린다.
function htmlToPlainText_(html) {
  let text = String(html || '');
  if (!text) return '';
  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function(_, href, label) {
      const plainLabel = String(label).replace(/<[^>]+>/g, '').trim();
      if (/^mailto:/i.test(href)) return plainLabel || href.replace(/^mailto:/i, '');
      return plainLabel && plainLabel !== href ? plainLabel + ' (' + href + ')' : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return text.split('\n').map(function(line) { return line.replace(/[ \t]+/g, ' ').trim(); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function forwardNoticeData_(data) {
  let notice = data && data.forwardNotice;
  if (typeof notice === 'string') { try { notice = JSON.parse(notice); } catch (err) { notice = null; } }
  return notice && typeof notice === 'object' ? notice : null;
}

function forwardNoticeHtml_(data) {
  const notice = forwardNoticeData_(data);
  if (!notice) return '';
  const recipient = escapeMailHtml_(notice.recipientName || '담당자');
  const firm = notice.firmName ? escapeMailHtml_(notice.firmName) + ' ' : '';
  const candidate = escapeMailHtml_(notice.candidateName || '후보자');
  const position = notice.positionText ? escapeMailHtml_(notice.positionText) + ' 포지션 ' : '';
  const purposeText = String(notice.purpose || '채용 진행').trim();
  const purpose = escapeMailHtml_(/안내$/.test(purposeText) ? purposeText : purposeText + ' 안내');
  const instruction = escapeMailHtml_(notice.instruction || '아래 내용을 후보자분께 전달해 주시고, 회신은 후보자명과 포지션명을 함께 기재해 본 메일로 보내 주세요.');
  return '        <tr>\n' +
    '          <td style="padding:0 0 22px;">\n' +
    '            <div style="padding:14px 16px;border:1px solid #f0d9a8;background:#fff8ea;border-radius:12px;">\n' +
    '              <div style="font-size:13px;line-height:1.4;font-weight:700;color:#8a5a12;padding-bottom:6px;">헤드헌팅 경유 안내</div>\n' +
    '              <div style="font-size:14px;line-height:1.6;color:#1b2027;word-break:keep-all;overflow-wrap:break-word;">' + firm + recipient + '님, 안녕하세요. ' + position + '후보자 <strong>' + candidate + '</strong>님의 ' + purpose + '입니다.<br>' + instruction + '</div>\n' +
    '            </div>\n' +
    '          </td>\n' +
    '        </tr>\n';
}

function insertForwardNotice_(html, data) {
  const block = forwardNoticeHtml_(data);
  if (!block) return html;
  const source = String(html || '');
  const marker = source.indexOf('<!-- 본문 -->');
  const tableStart = source.indexOf('<table', marker < 0 ? 0 : marker);
  const tableEnd = tableStart < 0 ? -1 : source.indexOf('>', tableStart);
  if (marker < 0 || tableEnd < 0) return html;
  return source.slice(0, tableEnd + 1) + '\n' + block + source.slice(tableEnd + 1);
}

function referenceMailHtml_(message, context) {
  const raw = String(message || '');
  const data = Object.assign({}, context || {});
  const key = resolveReferenceMailTemplateKey_(raw, data);
  try {
    const fileName = REFERENCE_MAIL_TEMPLATE_FILES[key];
    const templateHtml = HtmlService.createHtmlOutputFromFile(fileName).getContent();
    return renderReferenceMailTemplate_(templateHtml, raw, data);
  } catch (err) {
    console.warn('referenceMailHtml_ template failed: ' + String(err && err.message || err));
    return referenceMailHtmlFallback_(raw, data);
  }
}

function resolveReferenceMailTemplateKey_(raw, data) {
  const explicit = String(data.templateType || data.templateKey || data.mailType || '').trim();
  if (REFERENCE_MAIL_TEMPLATE_FILES[explicit]) return explicit;
  throw new Error('reference_template_type_required');
}

function renderReferenceMailTemplate_(html, raw, data) {
  const link = String(data.link || data.actionUrl || ((raw.match(/https?:\/\/[^\s]+/) || [''])[0])).trim();
  const candidateName = referenceNameWithoutHonorific_(data.candidateName || data.candName || data.supporterName || extractReferenceCandidateName_(raw) || '지원자');
  const refereeName = referenceNameWithoutHonorific_(data.refereeName || data.recipientName || data.targetName || extractReferenceRefereeName_(raw) || 'OOO');
  const positionText = referencePositionText_(data.positionText || data.position || extractReferencePosition_(raw) || '홍보 포지션');
  const deadlineText = formatReferenceDateTime_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS), true);
  const submittedText = formatReferenceDateTime_(data.submittedAt || new Date(), false);
  const shortDeadlineText = shortReferenceDeadline_(data.deadline || data.tokenExpiresAt || addReferenceDays_(new Date(), REFERENCE_LINK_TTL_DAYS));

  const replacements = {
    '{{candidateName}}': escapeMailHtml_(candidateName),
    '{{refereeName}}': escapeMailHtml_(refereeName),
    '{{positionText}}': escapeMailHtml_(positionText),
    '{{deadlineText}}': escapeMailHtml_(deadlineText),
    '{{shortDeadlineText}}': escapeMailHtml_(shortDeadlineText),
    '{{submittedText}}': escapeMailHtml_(submittedText),
    '{{actionUrl}}': escapeMailHtml_(link)
  };
  let rendered = String(html || '');
  Object.keys(replacements).forEach(function(marker) {
    rendered = rendered.split(marker).join(replacements[marker]);
  });
  rendered = applyKoreanJosa_(rendered);
  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error('unresolved_reference_mail_placeholder');
  }
  return rendered;
}

function referenceNameWithoutHonorific_(value) {
  return String(value || '').trim().replace(/님$/g, '');
}

function referencePositionText_(value) {
  const text = String(value || '').trim();
  if (!text) return '홍보 포지션';
  return /포지션$/.test(text) ? text : text + ' 포지션';
}

function extractReferenceCandidateName_(raw) {
  const match = String(raw || '').match(/([가-힣A-Za-z]+)님께서|([가-힣A-Za-z]+)님에 대한|안녕하세요,\s*([가-힣A-Za-z]+)님/);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function extractReferenceRefereeName_(raw) {
  const match = String(raw || '').match(/^([가-힣A-Za-z]+)님,\s*안녕하세요|안녕하세요,\s*([가-힣A-Za-z]+)님/);
  return match ? (match[1] || match[2] || '') : '';
}

function extractReferencePosition_(raw) {
  const match = String(raw || '').match(/우미건설\s+(.+?)\s+포지션/);
  return match ? match[1] + ' 포지션' : '';
}

function addReferenceDays_(date, days) {
  return new Date(new Date(date).getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function formatReferenceDateTime_(value, includeUntil) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = isNaN(date.getTime()) ? new Date() : date;
  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  const ymd = Utilities.formatDate(safeDate, 'Asia/Seoul', 'yyyy년 M월 d일');
  const hm = Utilities.formatDate(safeDate, 'Asia/Seoul', 'HH:mm');
  return ymd + ' ' + days[safeDate.getDay()] + ' ' + hm + (includeUntil ? '까지' : '');
}

function shortReferenceDeadline_(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = isNaN(date.getTime()) ? new Date() : date;
  const days = ['일','월','화','수','목','금','토'];
  return Utilities.formatDate(safeDate, 'Asia/Seoul', 'M월 d일') + '(' + days[safeDate.getDay()] + ') ' +
    Utilities.formatDate(safeDate, 'Asia/Seoul', 'HH:mm') + '까지';
}

function referenceMailHtmlFallback_(raw, data) {
  const firstLink = String(data.link || ((raw.match(/https?:\/\/[^\s]+/) || [''])[0]) || '').trim();
  const bodyHtml = String(raw || '').split('\n').map(line => {
    const text = line.trim();
    if (!text || text === '추천인 등록 링크' || text === '설문 참여 링크' || /^https?:\/\//.test(text)) return '';
    return '<div style="margin:0 0 10px;">' + escapeMailHtml_(text) + '</div>';
  }).join('');
  const cta = firstLink
    ? '<div style="text-align:center;margin:28px 0;"><a href="' + escapeMailHtml_(firstLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:8px;">바로가기</a></div>'
    : '';
  return '<div style="margin:0;padding:24px;background:#f7fbff;font-family:Arial,sans-serif;color:#1b2027;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dde7f1;padding:32px;">' +
    bodyHtml + cta +
    '<div style="border-top:1px solid #dde7f1;margin-top:28px;padding-top:16px;color:#5c6875;font-size:12px;">우미건설 피플팀</div>' +
    '</div></div>';
}

// ══════════════════════════════════════════════════════════════
// 일반 안내 메일(면접·입사·불합격 등) — 디자인 있는 HTML 메일
// 레퍼런스체크 5종(referenceMailHtml_)은 최종 HTML 파일을 유지한다.
// 일반 메일용 공유 조각/본문은 Apps Script 파일 추가 부담을 줄이기 위해 아래 인라인 맵에 내장한다.
// ══════════════════════════════════════════════════════════════
