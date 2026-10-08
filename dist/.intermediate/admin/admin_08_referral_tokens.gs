function stoppedPipelineCandidateIds_() {
  const closedPositions = new Set(readRowsIfSheetExists_('Positions')
    .filter(row => CLOSED_POSITION_STATUSES_.includes(String(row.status || '').trim()))
    .map(row => String(row.id)));
  const ids = new Set();
  readRowsIfSheetExists_('Candidates').forEach(row => {
    const posId = row.posId === '' || row.posId == null ? '' : String(row.posId);
    if (candidateStageClosed_(row.stage) || String(row.held || '') === 'Y' || (posId && closedPositions.has(posId))) {
      ids.add(String(row.id));
    }
  });
  return ids;
}

// 트리거 등록은 운영자가 별도로 수행한다. 이 함수는 매일 09:00 실행을 전제로 하며,
// eventKey가 이미 성공 기록된 메일은 다시 보내지 않는다.
function dailyOps() {
  const guard = acquireOpsRunGuard_('dailyOps');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    const today = opsDateKey_(new Date());
    const results = {
      referenceCandidateReminders: 0,
      referenceResponseReminders: 0,
      candidateInterviewReminders: 0,
      internalNotices: 0,
      skipped: 0,
      deferred: 0,
      warnings: [],
      failed: []
    };

    // 충원완료·부분충원 마감·미채용·채용중단 포지션 소속, 불합격·보류 지원자에게는 자동 메일을 보내지 않는다.
    const stoppedCandIds = stoppedPipelineCandidateIds_();
    if (stoppedCandIds.size) results.skippedClosed = 0;
    const isStopped = candId => {
      const stopped = candId != null && stoppedCandIds.has(String(candId));
      if (stopped) results.skippedClosed++;
      return stopped;
    };

    readRowsIfSheetExists_('ReferenceCandidates').forEach(row => {
      if (!row.candEmail || row.refereesSubmittedAt || referenceLinkExpired_(row)) return;
      if (isStopped(row.pipelineCandId)) return;
      const reminder = referenceReminderKind_(row, today, false);
      if (!reminder) return;
      const eventKey = referenceReminderEventKey_('reference-candidate', row.id, reminder, today);
      const message = [
        row.candName + '님, 안녕하세요.', '',
        '레퍼런스 체크를 위한 추천인 등록이 아직 완료되지 않아 안내드립니다.',
        reminder === 'expiry-d3' ? '등록 링크가 3일 후 만료됩니다.'
          : reminder === 'overdue' ? '등록 기한이 지났습니다. 링크가 만료되기 전에 아래 링크에서 추천인 3명을 등록해 주세요.'
          : '아래 링크에서 추천인 3명을 등록해 주세요.',
        '', '추천인 등록 링크', row.link || buildReferenceCandidateLinkUrl_(row.token), '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.candEmail,
        '[우미건설] 레퍼런스 체크 추천인 등록 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'candidate_reminder', candidateName: row.candName,
          positionText: row.positionText || '', link: row.link || buildReferenceCandidateLinkUrl_(row.token),
          deadline: referenceDisplayDeadline_(row)
        }));
      countOpsResult_(results, send, 'referenceCandidateReminders', eventKey);
    });

    readRowsIfSheetExists_('ReferenceResponses').forEach(row => {
      if (!row.refereeEmail || row.submittedAt || referenceLinkExpired_(row)) return;
      if (isStopped(row.pipelineCandId)) return;
      const reminder = referenceReminderKind_(row, today, true);
      if (!reminder) return;
      const eventKey = referenceReminderEventKey_('reference-referee', row.id, reminder, today);
      const link = row.link || buildReferenceResponseLinkUrl_(row.token);
      const message = [
        row.refereeName + '님, 안녕하세요.', '',
        row.candName + '님에 대한 레퍼런스 체크 설문이 아직 접수되지 않아 재안내드립니다.',
        reminder === 'expiry-d3' ? '응답 링크가 3일 후 만료됩니다.'
          : reminder === 'overdue' ? '응답 기한이 지났습니다. 링크가 만료되기 전에 아래 링크에서 설문을 작성해 주세요.'
          : '아래 링크에서 설문을 작성해 주세요.',
        '', '설문 참여 링크', link, '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.refereeEmail,
        '[우미건설] ' + row.candName + '님 레퍼런스 체크 응답 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'referee_reminder', candidateName: row.candName,
          refereeName: row.refereeName, positionText: '', link, deadline: referenceDisplayDeadline_(row)
        }));
      countOpsResult_(results, send, 'referenceResponseReminders', eventKey);
    });

    const candidates = readRowsIfSheetExists_('Candidates');
    const candidateMap = new Map(candidates.map(row => [String(row.id), row]));
    const tomorrow = opsDateKey_(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const tomorrowInterviews = readRowsIfSheetExists_('Interviews').filter(row =>
      row.status === 'confirmed' && !row.result && isSheetTrue_(row.candidateNotified) && opsDateKey_(row.date) === tomorrow
      && !isStopped(row.candId)
    );
    tomorrowInterviews.forEach(row => {
      const candidate = candidateMap.get(String(row.candId));
      if (!candidate) return;
      const viaHeadhunter = String(candidate.source || '') === '헤드헌팅' && candidate.headhunterEmail;
      const to = viaHeadhunter ? candidate.headhunterEmail : candidate.email;
      if (!to) return;
      const eventKey = ['daily', 'interview-candidate', row.id, tomorrow].join(':');
      const place = row.candidateLoc || row.loc || '';
      const message = [
        (viaHeadhunter ? (candidate.headhunterManager || candidate.headhunterName || '담당자') : candidate.name) + '님, 안녕하세요.', '',
        candidate.name + '님의 ' + row.type + ' 면접이 내일 예정되어 있어 안내드립니다.',
        '일시: ' + formatOpsDateTime_(row.date),
        '장소: ' + place,
        viaHeadhunter ? '후보자에게 위 일정을 전달해 주세요.' : '안내된 시간에 맞춰 도착해 주세요.',
        '', '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, to,
        '[우미건설] ' + candidate.name + '님 면접 전날 안내', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'candidateInterviewReminders', eventKey);
    });

    const notifyEmail = getNotifyEmail_();
    if (!notifyEmail) results.warnings.push('notify_email_not_configured');
    if (notifyEmail && tomorrowInterviews.length) {
      const eventKey = ['daily', 'panel-preparation', tomorrow].join(':');
      const lines = tomorrowInterviews.map(row => {
        const candidate = candidateMap.get(String(row.candId));
        return '- ' + formatOpsDateTime_(row.date) + ' · ' + (candidate && candidate.name || row.candName || '-') +
          ' · 면접관 ' + (row.panel || '-') + ' · ' + (row.panelLoc || row.loc || '-');
      });
      const message = ['내일 예정된 면접입니다.', '면접관 안내는 면접조서 첨부 후 대시보드에서 수동 발송해 주세요.', '', lines.join('\n')].join('\n');
      const send = sendOpsMailOnce_(eventKey, notifyEmail, '[채용시스템] 내일 면접 준비 확인', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'internalNotices', eventKey);
    }

    const dueRewards = readRowsIfSheetExists_('Rewards').filter(row => {
      if (!row.dueDate || ['PAID', 'CANCELLED'].includes(String(row.status || '').toUpperCase())) return false;
      const days = opsDaysBetween_(today, opsDateKey_(row.dueDate));
      return days >= 0 && days <= 7;
    });
    if (notifyEmail && dueRewards.length) {
      const eventKey = ['daily', 'reward-due', today].join(':');
      const lines = dueRewards.map(row => '- ' + row.dueDate + ' · ' + (row.milestone || '-') + ' · ' +
        (row.refEmail || '-') + ' · ' + Number(row.amount || 0).toLocaleString('ko-KR') + '원');
      const message = ['7일 이내 도래하는 사내추천 보상 확인 대상입니다.', '', lines.join('\n')].join('\n');
      const send = sendOpsMailOnce_(eventKey, notifyEmail, '[채용시스템] 추천 보상 만기 확인', message, opsPlainHtml_(message));
      countOpsResult_(results, send, 'internalNotices', eventKey);
    }

    if (results.warnings.length) console.warn('dailyOps: Settings 시트의 notifyEmail이 비어 있어 내부 알림(면접 준비·보상 만기)을 보내지 않았습니다.');
    opsMailWarnings_().forEach(warning => {
      results.warnings.push(warning);
      console.warn('dailyOps: ' + (warning === 'mail_quota_exhausted'
        ? '일일 메일 발송 한도가 소진되어 남은 메일을 미뤘습니다. 한도가 회복된 뒤 다시 실행하면 이어서 보냅니다.'
        : '보낸 메일 일부를 MailLog에 기록하지 못했습니다. 다시 실행하면 같은 메일이 다시 나갈 수 있습니다.'));
    });
    // 실행시간 예산을 넘겨 보내지 못한 메일은 같은 날 다시 실행하면 이어서 보낸다(이미 보낸 메일은 eventKey로 건너뜀).
    results.incomplete = results.deferred > 0;
    console.log('dailyOps: ' + JSON.stringify(results));
    return Object.assign({ ok: results.failed.length === 0, date: today }, results);
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

// 매월 1일 실행을 전제로 한다. 파기는 수행하지 않고 승인 대상만 피플팀에 보낸다.
function monthlyRetention() {
  const notifyEmail = getNotifyEmail_();
  if (!notifyEmail) {
    console.warn('monthlyRetention: Settings 시트의 notifyEmail이 비어 있어 실행하지 않았습니다.');
    return { ok: false, error: 'notify_email_not_configured' };
  }
  const guard = acquireOpsRunGuard_('monthlyRetention');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    return monthlyRetentionUnguarded_(notifyEmail);
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

function monthlyRetentionUnguarded_(notifyEmail) {
  const today = opsDateKey_(new Date());
  const retentionSetting = getFirstSettingValue_(['retentionMonths']);
  const retentionParsed = Number(retentionSetting);
  const retentionValid = Number.isFinite(retentionParsed) && retentionParsed >= 1;
  const retentionMonths = retentionValid ? Math.floor(retentionParsed) : 6;
  const warnings = retentionSetting && !retentionValid ? ['retention_months_invalid'] : [];
  if (warnings.length) console.warn('monthlyRetention: Settings 시트의 retentionMonths 값(' + retentionSetting + ')이 올바르지 않아 기본값 6개월을 사용했습니다.');
  const cutoff = new Date(today + 'T00:00:00+09:00');
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  const positions = readRowsIfSheetExists_('Positions');
  const positionMap = new Map(positions.map(row => [String(row.id), row]));
  const targets = readRowsIfSheetExists_('Candidates').filter(candidate => {
    const position = positionMap.get(String(candidate.posId));
    const retentionDate = candidate.rejectedAt || (position && position.status !== 'active' ? position.closedAt : '');
    const time = new Date(retentionDate).getTime();
    return Number.isFinite(time) && time < cutoff.getTime();
  });
  if (!targets.length) return { ok: true, targets: 0, sent: false, retentionMonths: retentionMonths, warnings: warnings };

  const eventKey = ['monthly', 'retention-approval', today].join(':');
  const lines = targets.map(candidate => '- ID ' + candidate.id + ' · ' + maskOpsName_(candidate.name) +
    ' · 기준일 ' + opsDateKey_(candidate.rejectedAt || (positionMap.get(String(candidate.posId)) || {}).closedAt));
  const message = [
    '개인정보 보존기간 ' + retentionMonths + '개월이 경과한 지원자 ' + targets.length + '명입니다.',
    '자동 파기는 수행하지 않았습니다. 대시보드에서 대상을 검토하고 승인 후 파기해 주세요.', '',
    lines.join('\n')
  ].join('\n');
  const send = sendOpsMailOnce_(eventKey, notifyEmail,
    '[채용시스템] 개인정보 파기 승인 대상 ' + targets.length + '명', message, opsPlainHtml_(message));
  return { ok: send.ok || send.skipped, targets: targets.length, sent: !!send.ok, skipped: !!send.skipped, deferred: !!send.deferred, error: send.error || '', retentionMonths: retentionMonths, warnings: warnings.concat(opsMailWarnings_()) };
}

function sendOpsMailOnce_(eventKey, to, subject, body, htmlBody) {
  if (mailEventAlreadySent_(eventKey)) return { ok: false, skipped: true };
  // 실행시간 제한(6분)에 강제로 끊기면 '보냈는데 기록 전'인 메일이 생겨 다시 실행할 때 중복될 수 있다.
  // 예산을 넘기면 더 보내지 않고 미룬다 — 같은 날 다시 실행하면 이어서 보낸다.
  if (opsTimeBudgetExceeded_()) return { ok: false, deferred: true };
  // 일일 발송 한도가 남지 않았으면 보내지 않고 미룬다(한도 초과 오류를 메일마다 쌓지 않는다).
  const quota = opsMailQuotaLeft_();
  if (quota !== null && quota <= 0) {
    EXEC_CACHE_.opsMailQuotaExhausted = true;
    return { ok: false, deferred: true };
  }
  const result = sendMailViaGmail_(to, subject, body, htmlBody, [], eventKey);
  if (result && result.ok) {
    opsSentEventKeys_().add(String(eventKey || ''));
    if (quota !== null) EXEC_CACHE_.opsMailQuota = quota - 1;
    // 보냈지만 MailLog에 못 남기면 다음 실행에서 같은 메일을 다시 보낼 수 있다 — 결과에 경고로 남긴다.
    if (result.logged === false) EXEC_CACHE_.opsMailLogFailed = true;
  }
  return result;
}

// 남은 일일 메일 발송 한도. 실행당 한 번 읽고 보낼 때마다 줄인다. 읽을 수 없으면 null(한도 확인 생략).
function opsMailQuotaLeft_() {
  if (EXEC_CACHE_.opsMailQuota === undefined) {
    try {
      const left = Number(MailApp.getRemainingDailyQuota());
      EXEC_CACHE_.opsMailQuota = Number.isFinite(left) ? left : null;
    } catch (err) {
      EXEC_CACHE_.opsMailQuota = null;
    }
  }
  return EXEC_CACHE_.opsMailQuota;
}

function opsMailWarnings_() {
  const warnings = [];
  if (EXEC_CACHE_.opsMailQuotaExhausted) warnings.push('mail_quota_exhausted');
  if (EXEC_CACHE_.opsMailLogFailed) warnings.push('mail_log_failed');
  return warnings;
}

// MailLog 전체는 실행당 한 번만 읽는다(메일마다 다시 읽으면 기록이 쌓일수록 실행시간 제한에 걸린다).
function mailEventAlreadySent_(eventKey) {
  return opsSentEventKeys_().has(String(eventKey || ''));
}

function opsSentEventKeys_() {
  if (!EXEC_CACHE_.opsSentEventKeys) {
    EXEC_CACHE_.opsSentEventKeys = new Set(readRowsIfSheetExists_('MailLog')
      .filter(row => row.eventKey && String(row.status || '').toLowerCase() === 'sent')
      .map(row => String(row.eventKey)));
  }
  return EXEC_CACHE_.opsSentEventKeys;
}

// 운영 작업 중복 실행 방지. 메일을 보내는 몇 분 동안 스크립트 잠금을 잡고 있으면 그 사이 담당자 저장이
// 잠금 대기로 실패하므로, 잠금은 실행 표시를 확인·기록하는 순간에만 잡는다. 실행시간 제한으로 끊겨
// 표시가 남아도 OPS_RUN_GUARD_SECONDS가 지나면 다시 실행할 수 있다(Script Properties는 쓰지 않는다).
const OPS_RUN_GUARD_SECONDS = 7 * 60;
const OPS_TIME_BUDGET_MS = 4.5 * 60 * 1000;

function acquireOpsRunGuard_(name) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return '';
  try {
    const cache = CacheService.getScriptCache();
    const key = 'ops_running:' + name;
    if (cache.get(key)) return '';
    cache.put(key, nowIso_(), OPS_RUN_GUARD_SECONDS);
    EXEC_CACHE_.opsStartedAt = Date.now();
    return key;
  } finally {
    lock.releaseLock();
  }
}

function releaseOpsRunGuard_(key) {
  if (key) CacheService.getScriptCache().remove(key);
}

function opsTimeBudgetExceeded_() {
  return !!EXEC_CACHE_.opsStartedAt && Date.now() - EXEC_CACHE_.opsStartedAt > OPS_TIME_BUDGET_MS;
}

function countOpsResult_(results, send, field, eventKey) {
  if (send && send.ok) results[field]++;
  else if (send && send.skipped) results.skipped++;
  else if (send && send.deferred) results.deferred++;
  else results.failed.push({ eventKey, error: send && send.error || 'mail_send_failed' });
}

// 리마인드 판정(dailyOps가 하루 한 번 호출):
// - overdue: 기한(지원자 등록 3일 / 추천인 응답 7일)이 지났는데 미완료 → 한 번만 발송
// - reminder-d3: 추천인은 응답 기한(7일) 중간인 발송 3일째에 미응답이면 중간 안내
// - expiry-d3: 링크 만료 3일 전 최종 안내
// deadlineAt이 없는 행(기한 도입 전 발급분)은 기한 기준이 없으므로 만료 3일 전 안내만 보낸다 —
// 배포 직후 기존 행 전체에 기한 초과 메일이 한꺼번에 나가지 않도록 하기 위함이다.
function referenceReminderKind_(row, today, isReferee) {
  if (opsDaysBetween_(today, opsDateKey_(row.tokenExpiresAt)) === 3) return 'expiry-d3';
  if (!row.deadlineAt) return '';
  const deadline = parseOpsDate_(row.deadlineAt);
  if (!Number.isFinite(deadline.getTime())) return '';
  if (deadline.getTime() <= Date.now()) return 'overdue';
  if (isReferee) {
    const issuedKey = opsDateKey_(addReferenceDays_(deadline, -REFERENCE_RESPONSE_DEADLINE_DAYS));
    if (opsDaysBetween_(issuedKey, today) === 3) return 'reminder-d3';
  }
  return '';
}

// overdue는 기한이 지난 뒤 매일 판정되므로 날짜 없는 키로 한 번만 발송되게 한다.
function referenceReminderEventKey_(scope, id, reminder, today) {
  return ['daily', scope, id, reminder].concat(reminder === 'overdue' ? [] : [today]).join(':');
}

// 메일에 안내할 기한 — 기한이 남아 있으면 그 기한, 이미 지났거나 기한 도입 전 행이면 링크 만료일.
function referenceDisplayDeadline_(row) {
  const deadline = row && row.deadlineAt ? parseOpsDate_(row.deadlineAt) : null;
  return deadline && deadline.getTime() > Date.now() ? row.deadlineAt : row.tokenExpiresAt;
}

function opsDateKey_(value) {
  const date = parseOpsDate_(value);
  if (!Number.isFinite(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy-MM-dd');
}

function opsDaysBetween_(fromKey, toKey) {
  if (!fromKey || !toKey) return NaN;
  const from = new Date(fromKey + 'T00:00:00+09:00').getTime();
  const to = new Date(toKey + 'T00:00:00+09:00').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function formatOpsDateTime_(value) {
  const date = parseOpsDate_(value);
  if (!Number.isFinite(date.getTime())) return String(value || '');
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy년 M월 d일 HH:mm');
}

function parseOpsDate_(value) {
  if (value instanceof Date) return value;
  const text = String(value || '').trim();
  if (!text) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(text)) {
    return new Date(text.replace(' ', 'T') + ':00+09:00');
  }
  // 시각 없는 날짜는 한국 시간 자정으로 읽는다(new Date('yyyy-MM-dd')는 UTC 자정이 된다).
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(text + 'T00:00:00+09:00');
  return new Date(text);
}

function isSheetTrue_(value) {
  return value === true || ['y', 'yes', 'true', '1'].includes(String(value || '').trim().toLowerCase());
}

function opsPlainHtml_(message) {
  return '<div style="font-family:Arial,sans-serif;line-height:1.7;white-space:pre-line">' +
    escapeMailHtml_(message) + '</div>';
}

function maskOpsName_(name) {
  const text = String(name || '').trim();
  if (text.length <= 1) return '*';
  if (text.length === 2) return text.charAt(0) + '*';
  return text.charAt(0) + '*'.repeat(text.length - 2) + text.charAt(text.length - 1);
}

