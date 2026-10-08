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

