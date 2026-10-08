function getAll_(sheetName, query) {
  const since = query && query.since ? String(query.since) : '';
  if (!since) {
    return json_({ data: readRows_(sheetName), cursor: getChangeCursor_(), serverTime: nowIso_() });
  }

  // 화면은 since로 마지막 동기화 시각(ISO)을 보낸다. 변경 이력으로 그 뒤 바뀐 행만 골라 읽는다.
  // 이력이 since까지 남아 있지 않으면(아카이브 등) 아래 예전 방식(시트 전체 읽기)으로 처리한다.
  const sinceTime = Date.parse(since);
  if (Number.isFinite(sinceTime)) {
    const changed = changedIdsSince_(sheetName, sinceTime);
    if (changed.complete) {
      const byId = changed.ids.length ? readRowsByIds_(sheetName, changed.ids) : {};
      return json_({ data: Object.keys(byId).map(id => byId[id]), cursor: getChangeCursor_(), serverTime: nowIso_() });
    }
  }
  const changedIds = {};
  const changes = readChangesAfter_(Number(since) || 0, 5000)
    .filter(change => change.sheet === sheetName);
  changes.forEach(change => { changedIds[String(change.id)] = true; });

  const key = primaryKey_(sheetName);
  const rows = readRows_(sheetName);
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
  const existingValues = rowIndex > 0
    ? sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]
    : null;
  const revision = revisionState_(sheetName, headers, existingValues, source);
  if (revision.conflict) {
    return json_({
      error: 'revision_conflict',
      id,
      expectedRev: revision.expected,
      currentRev: revision.current,
      data: rowObjectFromValues_(headers, existingValues)
    });
  }
  if (sheetName === 'Referrals') {
    source = secureReferralRowForUpsert_(source, rowIndex > 0, isAdmin);
  }

  if (revision.enabled) {
    source.rev = revision.current + 1;
    source.updatedAt = nowIso_();
  } else {
    source.updatedAt = source.updatedAt || nowIso_();
  }
  const normalized = schemaRow_(sheetName, source);
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);

  appendChange_(sheetName, 'upsert', id, normalized);
  return json_({ status: 'ok', id, data: normalized, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function batchUpsert_(sheetName, rows, isAdmin) {
  const source = Array.isArray(rows) ? rows : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result;
  try {
    const sheet = ensureSheet_(sheetName);
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
    const key = primaryKey_(sheetName);
    const ids = source.map(function(row) { return String((row || {})[key] || '').trim(); }).filter(Boolean);
    const loaded = readSheetRowsByIds_(sheet, headers, key, ids);
    const pendingRows = {};
    const newIds = [];

    const changes = [];
    const conflicts = [];
    const revs = {}; // 저장 후 행별 새 rev — 화면이 다음 저장 때 기준으로 쓴다
    let count = 0;
    source.forEach(function(row) {
      let next = Object.assign({}, row || {});
      const id = String(next[key] || '').trim();
      if (!id) return;
      const existing = pendingRows[id] || loaded.rows[id] || null;
      const existingValues = existing ? existing.values : null;
      const revision = revisionState_(sheetName, headers, existingValues, next);
      if (revision.conflict) {
        conflicts.push({
          id,
          expectedRev: revision.expected,
          currentRev: revision.current,
          data: rowObjectFromValues_(headers, existingValues)
        });
        return;
      }
      if (sheetName === 'Referrals') {
        next = secureReferralRowForUpsert_(next, !!existing, isAdmin);
      }
      if (revision.enabled) {
        next.rev = revision.current + 1;
        next.updatedAt = nowIso_();
        revs[id] = next.rev;
      } else {
        next.updatedAt = next.updatedAt || nowIso_();
      }
      const normalized = schemaRow_(sheetName, next);
      const rowValues = headers.map(function(header) {
        return normalized[header] == null ? '' : normalized[header];
      });
      if (!existing) newIds.push(id);
      pendingRows[id] = { rowNumber: existing ? existing.rowNumber : 0, values: rowValues };
      changes.push({ sheetName, action: 'upsert', id, data: normalized });
      count++;
    });

    if (conflicts.length) {
      result = {
        error: 'revision_conflict',
        count: 0,
        conflicts,
        cursor: getChangeCursor_(),
        serverTime: nowIso_()
      };
    } else if (count) {
      writeBatchRows_(sheet, headers.length, pendingRows, newIds, loaded.lastRow);
      appendChanges_(changes);
      result = { status: 'ok', count, revs, cursor: getChangeCursor_(), serverTime: nowIso_() };
    } else {
      result = { status: 'ok', count: 0, cursor: getChangeCursor_(), serverTime: nowIso_() };
    }
  } finally {
    lock.releaseLock();
  }
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
    const revisioned = REVISIONED_SHEETS.includes(sheetName);
    const priorRevisions = {};
    if (revisioned && lastRow > 1) {
      const keyIndex = headers.indexOf(primaryKey_(sheetName));
      const revIndex = headers.indexOf('rev');
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function(values) {
        const id = String(values[keyIndex] || '').trim();
        if (id) priorRevisions[id] = Number(values[revIndex]) || 0;
      });
    }
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
    }
    const normalizedRows = source.map(row => {
      const next = Object.assign({}, row || {});
      if (revisioned) {
        const id = String(next[primaryKey_(sheetName)] || '').trim();
        next.rev = (priorRevisions[id] || 0) + 1;
        next.updatedAt = nowIso_();
      } else {
        next.updatedAt = next.updatedAt || nowIso_();
      }
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

// 보존기한이 지난 지원자의 개인정보를 연결된 시트와 변경 로그 전체에서 삭제한다.
function purgeCandidatePii_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(v => String(v).trim()).filter(Boolean) : [];
  if (!ids.length) return json_({ error: 'missing_candidate_ids' });
  const idSet = new Set(ids);
  const emails = Array.isArray(body.candidateEmails)
    ? body.candidateEmails.map(v => normalizeEmail_(v)).filter(Boolean)
    : [];
  const emailSet = new Set(emails);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const removed = {
      candidates: deleteRowsWhere_('Candidates', row => idSet.has(String(row.id))),
      interviews: deleteRowsWhere_('Interviews', row => idSet.has(String(row.candId))),
      onboardings: deleteRowsWhere_('Onboardings', row => idSet.has(String(row.candId))),
      offers: deleteRowsWhere_('Offers', row => idSet.has(String(row.candId))),
      refReports: deleteRowsWhere_('RefReports', row => idSet.has(String(row.candId))),
      referenceCandidates: deleteRowsWhere_('ReferenceCandidates', row => idSet.has(String(row.pipelineCandId))),
      referenceResponses: deleteRowsWhere_('ReferenceResponses', row => idSet.has(String(row.pipelineCandId))),
      mailLog: emails.length ? deleteRowsWhere_('MailLog', row =>
        String(row.to || '').split(/[;,]/).some(addr => emailSet.has(normalizeEmail_(addr)))
      ) : 0
    };
    removed.changeLog = deleteCandidateChangeRows_(CHANGE_LOG_SHEET, idSet, emailSet);
    removed.changeArchive = deleteCandidateChangeRows_(CHANGE_ARCHIVE_SHEET, idSet, emailSet);

    return json_({ ok: true, removed, cursor: getChangeCursor_(), serverTime: nowIso_() });
  } finally {
    lock.releaseLock();
  }
}

function deleteCandidateChangeRows_(sheetName, candidateIds, candidateEmails) {
  const sheet = getMainSpreadsheet_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(sheet.getLastColumn(), 8)).getValues();
  const headers = values[0].map(value => String(value || '').trim());
  const sheetIndex = headers.indexOf('sheet');
  const idIndex = headers.indexOf('id');
  const dataIndex = headers.indexOf('data');
  if (sheetIndex < 0 || idIndex < 0 || dataIndex < 0) return 0;

  const kept = [];
  let removed = 0;
  values.slice(1).forEach(row => {
    if (changeRowContainsCandidatePii_(row, sheetIndex, idIndex, dataIndex, candidateIds, candidateEmails)) {
      removed++;
    } else {
      kept.push(row);
    }
  });
  if (!removed) return 0;

  const bodyRange = sheet.getRange(2, 1, values.length - 1, values[0].length);
  bodyRange.clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, values[0].length).setValues(kept);
  return removed;
}

function changeRowContainsCandidatePii_(row, sheetIndex, idIndex, dataIndex, candidateIds, candidateEmails) {
  const changedSheet = String(row[sheetIndex] || '');
  const changedId = String(row[idIndex] || '');
  if (changedSheet === 'Candidates' && candidateIds.has(changedId)) return true;

  let data = {};
  try {
    data = JSON.parse(String(row[dataIndex] || '{}')) || {};
  } catch (err) {
    data = {};
  }
  const idKeys = ['candId', 'candidateId', 'pipelineCandId'];
  if (idKeys.some(key => data[key] != null && candidateIds.has(String(data[key])))) return true;

  const emailKeys = ['email', 'candEmail', 'candidateEmail', 'to'];
  return emailKeys.some(key => {
    if (data[key] == null) return false;
    return String(data[key]).split(/[;,]/).some(value => candidateEmails.has(normalizeEmail_(value)));
  });
}

function getChanges_(query) {
  const cursor = Number(query && query.cursor) || 0;
  const limit = Math.min(Number(query && query.limit) || 500, 1000);
  const page = readChangePageAfter_(cursor, limit);
  const changes = hydrateChangesForClient_(page.changes);
  const latestCursor = page.latestCursor;
  const nextCursor = changes.length ? Number(changes[changes.length - 1].cursor) : Math.max(cursor, latestCursor);
  return json_({
    changes,
    cursor: nextCursor,
    latestCursor,
    serverTime: nowIso_(),
    resyncRequired: false,
    hasMore: page.hasMore
  });
}

