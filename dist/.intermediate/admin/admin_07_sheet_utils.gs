function ensureSheet_(sheetName) {
  assertKnownSheet_(sheetName);
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getScriptProperty_(REFERRAL_DATA_URL_PROPERTY) || getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return SpreadsheetApp.openByUrl(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return getMainSpreadsheet_();
}

function ensureHeaders_(sheet, schema) {
  if (!schema || !schema.length) throw new Error('missing_schema');
  const lastColumn = Math.max(sheet.getLastColumn(), schema.length);
  let headers = [];
  if (sheet.getLastRow() >= 1 && lastColumn > 0) {
    headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(v => String(v || '').trim());
  }
  if (!headers.filter(Boolean).length) {
    sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
    return schema.slice();
  }
  const next = headers.slice();
  schema.forEach(header => {
    if (!next.includes(header)) next.push(header);
  });
  if (next.length !== headers.length) {
    sheet.getRange(1, 1, 1, next.length).setValues([next]);
  }
  return next;
}

function readRows_(sheetName) {
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = normalizeCell_(row[index]);
    });
    return obj;
  }).filter(row => String(row[primaryKey_(sheetName)] || '').trim());
}

function schemaRow_(sheetName, row) {
  const schema = SHEET_SCHEMAS[sheetName];
  const result = {};
  schema.forEach(key => {
    result[key] = row[key] == null ? '' : row[key];
  });
  return result;
}

function revisionState_(sheetName, headers, existingValues, source) {
  const enabled = REVISIONED_SHEETS.includes(sheetName);
  if (!enabled) return { enabled: false, conflict: false, expected: 0, current: 0 };
  const revIndex = headers.indexOf('rev');
  const current = existingValues && revIndex >= 0 ? Number(existingValues[revIndex]) || 0 : 0;
  const expected = Number(source && source.rev) || 0;
  return {
    enabled: true,
    conflict: !!existingValues && expected !== current,
    expected,
    current
  };
}

function rowObjectFromValues_(headers, values) {
  const result = {};
  (headers || []).forEach(function(header, index) {
    result[header] = normalizeCell_((values || [])[index]);
  });
  return result;
}

function findRowIndex_(sheet, key, id, headers) {
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error('missing_key_column');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  const target = String(id);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
  }
  return -1;
}

function appendChange_(sheetName, action, id, data) {
  appendChanges_([{ sheetName, action, id, data }]);
}

function appendChanges_(changes) {
  const source = Array.isArray(changes) ? changes : [];
  if (!source.length) return;
  const sheet = ensureChangeLogSheet_();
  const firstCursor = reserveChangeCursors_(sheet, source.length);
  const actorEmail = getActiveUserEmail_();
  const values = source.map(function(change, index) {
    return [
      firstCursor + index,
      nowIso_(),
      change.sheetName,
      change.action,
      change.id,
      actorEmail,
      'ok',
      JSON.stringify(change.data || {})
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 8).setValues(values);
}

function ensureChangeLogSheet_() {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(CHANGE_LOG_SHEET);
  if (!sheet) sheet = ss.insertSheet(CHANGE_LOG_SHEET);
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['cursor','timestamp','sheet','action','id','actorEmail','result','data']);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 8)).getValues()[0].map(v => String(v || '').trim());
    const expected = ['cursor','timestamp','sheet','action','id','actorEmail','result','data'];
    let changed = false;
    expected.forEach((header, index) => {
      if (current[index] !== header) {
        current[index] = header;
        changed = true;
      }
    });
    if (changed) sheet.getRange(1, 1, 1, expected.length).setValues([current.slice(0, expected.length)]);
  }
  return sheet;
}

function ensureChangeArchiveSheet_() {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(CHANGE_ARCHIVE_SHEET);
  if (!sheet) sheet = ss.insertSheet(CHANGE_ARCHIVE_SHEET);
  const headers = ['cursor','timestamp','sheet','action','id','actorEmail','result','data'];
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(headers);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
    if (headers.some(function(header, index) { return String(current[index] || '').trim() !== header; })) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sheet;
}

function archiveOldChanges_(retentionDays, maxRows) {
  const days = Math.max(1, Number(retentionDays) || CHANGE_ARCHIVE_RETENTION_DAYS);
  const limit = Math.max(1, Math.min(Number(maxRows) || CHANGE_ARCHIVE_BATCH_SIZE, CHANGE_ARCHIVE_BATCH_SIZE));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const source = ensureChangeLogSheet_();
    const available = source.getLastRow() - 1;
    if (available <= 0) return { ok: true, archived: 0, remaining: 0 };

    const scanCount = Math.min(available, limit);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const timestamps = source.getRange(2, 2, scanCount, 1).getValues();
    let archiveCount = 0;
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = new Date(timestamps[i][0]).getTime();
      if (!Number.isFinite(timestamp) || timestamp >= cutoff) break;
      archiveCount += 1;
    }
    if (!archiveCount) return { ok: true, archived: 0, remaining: available };

    const rows = source.getRange(2, 1, archiveCount, 8).getValues();
    const archive = ensureChangeArchiveSheet_();
    const lastArchivedCursor = archive.getLastRow() < 2
      ? 0
      : Number(archive.getRange(archive.getLastRow(), 1).getValue()) || 0;
    const newRows = rows.filter(function(row) { return Number(row[0]) > lastArchivedCursor; });
    if (newRows.length) {
      archive.getRange(archive.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
    }
    source.deleteRows(2, archiveCount);
    return {
      ok: true,
      archived: archiveCount,
      remaining: available - archiveCount,
      cutoff: new Date(cutoff).toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function archiveOldChanges() {
  return archiveOldChanges_();
}

function weeklyOps() {
  const archiveResult = archiveOldChanges_();
  console.log('weeklyOps: ' + JSON.stringify({ changeArchive: archiveResult }));
  return { ok: true, changeArchive: archiveResult };
}

// 트리거 등록은 운영자가 별도로 수행한다. 이 함수는 매일 09:00 실행을 전제로 하며,
// eventKey가 이미 성공 기록된 메일은 다시 보내지 않는다.
function dailyOps() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: false, error: 'ops_already_running' };
  try {
    const today = opsDateKey_(new Date());
    const results = {
      referenceCandidateReminders: 0,
      referenceResponseReminders: 0,
      candidateInterviewReminders: 0,
      internalNotices: 0,
      skipped: 0,
      failed: []
    };

    readRowsIfSheetExists_('ReferenceCandidates').forEach(row => {
      if (!row.candEmail || row.refereesSubmittedAt || referenceLinkExpired_(row)) return;
      const reminder = referenceReminderKind_(row.createdAt || row.updatedAt, row.tokenExpiresAt, today);
      if (!reminder) return;
      const eventKey = ['daily', 'reference-candidate', row.id, reminder, today].join(':');
      const message = [
        row.candName + '님, 안녕하세요.', '',
        '레퍼런스 체크를 위한 추천인 등록이 아직 완료되지 않아 안내드립니다.',
        reminder === 'expiry-d3' ? '등록 링크가 3일 후 만료됩니다.' : '아래 링크에서 추천인 3명을 등록해 주세요.',
        '', '추천인 등록 링크', row.link || buildReferenceCandidateLinkUrl_(row.token), '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.candEmail,
        '[우미건설] 레퍼런스 체크 추천인 등록 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'candidate_reminder', candidateName: row.candName,
          positionText: row.positionText || '', link: row.link || buildReferenceCandidateLinkUrl_(row.token),
          deadline: row.tokenExpiresAt
        }));
      countOpsResult_(results, send, 'referenceCandidateReminders', eventKey);
    });

    readRowsIfSheetExists_('ReferenceResponses').forEach(row => {
      if (!row.refereeEmail || row.submittedAt || referenceLinkExpired_(row)) return;
      const reminder = referenceReminderKind_(row.updatedAt, row.tokenExpiresAt, today);
      if (!reminder) return;
      const eventKey = ['daily', 'reference-referee', row.id, reminder, today].join(':');
      const link = row.link || buildReferenceResponseLinkUrl_(row.token);
      const message = [
        row.refereeName + '님, 안녕하세요.', '',
        row.candName + '님에 대한 레퍼런스 체크 설문이 아직 접수되지 않아 재안내드립니다.',
        reminder === 'expiry-d3' ? '응답 링크가 3일 후 만료됩니다.' : '아래 링크에서 설문을 작성해 주세요.',
        '', '설문 참여 링크', link, '',
        '감사합니다.', '우미건설 피플팀 드림'
      ].join('\n');
      const send = sendOpsMailOnce_(eventKey, row.refereeEmail,
        '[우미건설] ' + row.candName + '님 레퍼런스 체크 응답 재안내', message,
        referenceMailHtml_(message, {
          templateType: 'referee_reminder', candidateName: row.candName,
          refereeName: row.refereeName, positionText: '', link, deadline: row.tokenExpiresAt
        }));
      countOpsResult_(results, send, 'referenceResponseReminders', eventKey);
    });

    const candidates = readRowsIfSheetExists_('Candidates');
    const candidateMap = new Map(candidates.map(row => [String(row.id), row]));
    const tomorrow = opsDateKey_(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const tomorrowInterviews = readRowsIfSheetExists_('Interviews').filter(row =>
      row.status === 'confirmed' && !row.result && isSheetTrue_(row.candidateNotified) && opsDateKey_(row.date) === tomorrow
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

    console.log('dailyOps: ' + JSON.stringify(results));
    return Object.assign({ ok: results.failed.length === 0, date: today }, results);
  } finally {
    lock.releaseLock();
  }
}

// 매월 1일 실행을 전제로 한다. 파기는 수행하지 않고 승인 대상만 피플팀에 보낸다.
function monthlyRetention() {
  const notifyEmail = getNotifyEmail_();
  if (!notifyEmail) return { ok: false, error: 'notify_email_not_configured' };
  const today = opsDateKey_(new Date());
  const retentionMonths = Math.max(1, Number(getFirstSettingValue_(['retentionMonths'])) || 6);
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
  if (!targets.length) return { ok: true, targets: 0, sent: false };

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
  return { ok: send.ok || send.skipped, targets: targets.length, sent: !!send.ok, skipped: !!send.skipped, error: send.error || '' };
}

function sendOpsMailOnce_(eventKey, to, subject, body, htmlBody) {
  if (mailEventAlreadySent_(eventKey)) return { ok: false, skipped: true };
  return sendMailViaGmail_(to, subject, body, htmlBody, [], eventKey);
}

function mailEventAlreadySent_(eventKey) {
  return readRowsIfSheetExists_('MailLog').some(row =>
    String(row.eventKey || '') === String(eventKey || '') && String(row.status || '').toLowerCase() === 'sent'
  );
}

function countOpsResult_(results, send, field, eventKey) {
  if (send && send.ok) results[field]++;
  else if (send && send.skipped) results.skipped++;
  else results.failed.push({ eventKey, error: send && send.error || 'mail_send_failed' });
}

function referenceReminderKind_(createdAt, expiresAt, today) {
  const untilExpiry = opsDaysBetween_(today, opsDateKey_(expiresAt));
  if (untilExpiry === 3) return 'expiry-d3';
  const elapsed = opsDaysBetween_(opsDateKey_(createdAt), today);
  return elapsed === 3 || elapsed === 7 ? 'reminder-d' + elapsed : '';
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

function getChangeCursor_() {
  return getStoredChangeCursor_(ensureChangeLogSheet_());
}

function reserveChangeCursors_(sheet, count) {
  const size = Math.max(0, Number(count) || 0);
  const current = getStoredChangeCursor_(sheet);
  if (!size) return current + 1;
  PropertiesService.getScriptProperties().setProperty(CHANGE_CURSOR_PROPERTY, String(current + size));
  return current + 1;
}

function getStoredChangeCursor_(sheet) {
  const properties = PropertiesService.getScriptProperties();
  const stored = Number(properties.getProperty(CHANGE_CURSOR_PROPERTY));
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const lastRow = sheet.getLastRow();
  const existing = lastRow < 2
    ? 0
    : Math.max.apply(null, sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(row) {
        return Number(row[0]) || 0;
      }));
  properties.setProperty(CHANGE_CURSOR_PROPERTY, String(existing));
  return existing;
}

function readChangesAfter_(cursor, limit) {
  const sheet = ensureChangeLogSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const requestedCursor = Number(cursor) || 0;
  const cursorValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const startOffset = cursorValues.findIndex(function(row) {
    return Number(row[0]) > requestedCursor;
  });
  if (startOffset < 0) return [];
  const startDataRow = startOffset + 2;
  const count = Math.min(Number(limit) || 500, lastRow - startDataRow + 1);
  const values = sheet.getRange(startDataRow, 1, count, 8).getValues();
  return values.map(row => ({
    cursor: Number(row[0]),
    timestamp: normalizeCell_(row[1]),
    sheet: String(row[2] || ''),
    action: String(row[3] || ''),
    id: String(row[4] || ''),
    actorEmail: String(row[5] || ''),
    result: String(row[6] || ''),
    data: parseJsonObject_(row[7])
  }));
}

