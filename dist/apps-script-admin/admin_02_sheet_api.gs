function getAll_(sheetName, query) {
  const rows = readRows_(sheetName);
  const since = query && query.since ? String(query.since) : '';
  if (!since) {
    return json_({ data: rows, cursor: getChangeCursor_(), serverTime: nowIso_() });
  }

  const changedIds = {};
  const changes = readChangesAfter_(Number(since) || 0, 5000)
    .filter(change => change.sheet === sheetName);
  changes.forEach(change => { changedIds[String(change.id)] = true; });

  const key = primaryKey_(sheetName);
  const data = rows.filter(row => changedIds[String(row[key])] || String(row.updatedAt || '') >= since);
  return json_({ data, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

// 쓰기 계열 함수(upsert_/batchUpsert_/replaceAll_/deleteRow_)는 모두 같은 스크립트 락을 사용한다.
// batchUpsert_는 각 행마다 다시 락을 거는 대신, 하나의 락 범위 안에서 upsertUnlocked_를 반복 호출한다
// (Apps Script의 LockService는 같은 실행 안에서 재진입을 지원하지 않으므로 중첩 획득을 피해야 한다).
function upsert_(sheetName, row, isAdmin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return upsertUnlocked_(sheetName, row, isAdmin);
  } finally {
    lock.releaseLock();
  }
}

function upsertUnlocked_(sheetName, row, isAdmin) {
  let source = Object.assign({}, row || {});

  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const id = String(source[key] || '').trim();
  if (!id) return json_({ error: 'missing_id' });

  const rowIndex = findRowIndex_(sheet, key, id, headers);
  if (sheetName === 'Referrals') {
    source = secureReferralRowForUpsert_(source, rowIndex > 0, isAdmin);
  }

  source.updatedAt = source.updatedAt || nowIso_();
  const normalized = schemaRow_(sheetName, source);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);

  appendChange_(sheetName, 'upsert', id, normalized);
  if (sheetName === 'Referrals' && !isAdmin && rowIndex < 0) sendReferralReceipt_(normalized);
  return json_({ status: 'ok', id, data: normalized, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function batchUpsert_(sheetName, rows, isAdmin) {
  const source = Array.isArray(rows) ? rows : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  const receipts = [];
  let result;
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const keyIndex = headers.indexOf(key);
    const lastRow = sheet.getLastRow();
    const values = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
      : [];
    const rowIndexById = {};
    values.forEach(function(rowValues, index) {
      const id = String(rowValues[keyIndex] || '').trim();
      if (id) rowIndexById[id] = index;
    });

    const changes = [];
    let count = 0;
    source.forEach(function(row) {
      let next = Object.assign({}, row || {});
      const id = String(next[key] || '').trim();
      if (!id) return;
      const existingIndex = Object.prototype.hasOwnProperty.call(rowIndexById, id)
        ? rowIndexById[id]
        : -1;
      if (sheetName === 'Referrals') {
        next = secureReferralRowForUpsert_(next, existingIndex >= 0, isAdmin);
      }
      next.updatedAt = next.updatedAt || nowIso_();
      const normalized = schemaRow_(sheetName, next);
      const rowValues = headers.map(function(header) {
        return normalized[header] == null ? '' : normalized[header];
      });
      if (existingIndex >= 0) {
        values[existingIndex] = rowValues;
      } else {
        rowIndexById[id] = values.length;
        values.push(rowValues);
        if (sheetName === 'Referrals' && !isAdmin) receipts.push(normalized);
      }
      changes.push({ sheetName, action: 'upsert', id, data: normalized });
      count++;
    });

    if (count) {
      sheet.getRange(2, 1, values.length, headers.length).setValues(values);
      appendChanges_(changes);
    }
    result = { status: 'ok', count, cursor: getChangeCursor_(), serverTime: nowIso_() };
  } finally {
    lock.releaseLock();
  }
  receipts.forEach(sendReferralReceipt_);
  return json_(result);
}

function replaceAll_(sheetName, rows, isAdmin) {
  if (!isAdmin) throw new Error('admin_auth_required');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const source = Array.isArray(rows) ? rows : [];
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
    }
    const normalizedRows = source.map(row => {
      const next = Object.assign({}, row || {});
      next.updatedAt = next.updatedAt || nowIso_();
      return schemaRow_(sheetName, next);
    });
    if (normalizedRows.length) {
      const values = normalizedRows.map(row => headers.map(header => row[header] == null ? '' : row[header]));
      sheet.getRange(2, 1, values.length, headers.length).setValues(values);
    }
    appendChange_(sheetName, 'replaceAll', 'all', { count: normalizedRows.length });
    return json_({ status: 'ok', count: normalizedRows.length, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

function deleteRow_(sheetName, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const cleanId = String(id || '').trim();
    if (!cleanId) return json_({ error: 'missing_id' });

    const rowIndex = findRowIndex_(sheet, key, cleanId, headers);
    if (rowIndex > 0) sheet.deleteRow(rowIndex);
    appendChange_(sheetName, 'delete', cleanId, {});
    return json_({ status: 'deleted', id: cleanId, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

// 조건에 맞는 행을 모두 삭제한다. 뒤에서부터 지워야 앞쪽 삭제로 인한 행 번호 밀림을 피할 수 있다.
function deleteRowsWhere_(sheetName, predicate) {
  const sheet = ensureSheet_(sheetName);
  const rows = readRows_(sheetName);
  const key = primaryKey_(sheetName);
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!predicate(rows[i])) continue;
    sheet.deleteRow(i + 2);
    appendChange_(sheetName, 'delete', String(rows[i][key] || ''), {});
    removed++;
  }
  return removed;
}

// 보존기한이 지난 지원자의 개인정보를 연결된 시트 전체에서 삭제한다(Candidates/Interviews 외
// ReferenceCandidates/ReferenceResponses/MailLog). purgeExpiredPii()가 예전에는 Candidates·Interviews만
// 지우고 나머지는 그대로 남겨 "파기 완료" 표시와 실제 데이터 상태가 어긋나던 문제를 해결한다.
// _Changes 보존·압축 정책은 별도 설계가 필요해 이번 범위에서는 다루지 않는다.
function purgeCandidatePii_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(v => String(v).trim()).filter(Boolean) : [];
  if (!ids.length) return json_({ error: 'missing_candidate_ids' });
  const idSet = new Set(ids);
  const emails = Array.isArray(body.candidateEmails)
    ? body.candidateEmails.map(v => normalizeEmail_(v)).filter(Boolean)
    : [];

  const removed = {
    candidates: deleteRowsWhere_('Candidates', row => idSet.has(String(row.id))),
    interviews: deleteRowsWhere_('Interviews', row => idSet.has(String(row.candId))),
    referenceCandidates: deleteRowsWhere_('ReferenceCandidates', row => idSet.has(String(row.pipelineCandId))),
    referenceResponses: deleteRowsWhere_('ReferenceResponses', row => idSet.has(String(row.pipelineCandId))),
    mailLog: emails.length ? deleteRowsWhere_('MailLog', row =>
      String(row.to || '').split(/[;,]/).some(addr => emails.includes(normalizeEmail_(addr)))
    ) : 0
  };

  return json_({ ok: true, removed, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function getChanges_(query) {
  const cursor = Number(query && query.cursor) || 0;
  const limit = Math.min(Number(query && query.limit) || 500, 1000);
  const latestCursor = getChangeCursor_();
  const changes = readChangesAfter_(cursor, limit);
  const nextCursor = changes.length ? Number(changes[changes.length - 1].cursor) : latestCursor;
  return json_({
    changes,
    cursor: nextCursor,
    latestCursor,
    serverTime: nowIso_(),
    resyncRequired: false,
    hasMore: nextCursor < latestCursor
  });
}

