function ensureSheet_(sheetName) {
  assertKnownSheet_(sheetName);
  if (EXEC_CACHE_.sheets[sheetName]) return EXEC_CACHE_.sheets[sheetName];
  const ss = getSpreadsheetForSheet_(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    // 날짜(2026-10-15)·시각(09:00)·연락처(010…)가 날짜/숫자로 바뀌지 않도록 텍스트 형식으로 만든다.
    if (TEXT_FORMAT_SHEETS.indexOf(sheetName) >= 0) sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(sheet.getMaxColumns(), SHEET_SCHEMAS[sheetName].length)).setNumberFormat('@');
  }
  ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  EXEC_CACHE_.sheets[sheetName] = sheet;
  return sheet;
}

function getSpreadsheetForSheet_(sheetName) {
  if (REFERRAL_DATA_SHEETS.includes(sheetName)) {
    const referralDataUrl = getScriptProperty_(REFERRAL_DATA_URL_PROPERTY) || getFirstSettingValue_(REFERRAL_DATA_URL_SETTING_KEYS);
    if (referralDataUrl) {
      try {
        return openSpreadsheetCached_(referralDataUrl);
      } catch (err) {
        throw new Error('referral_data_file_open_failed: ' + String(err && err.message || err));
      }
    }
  }
  return getMainSpreadsheet_();
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
    // 지난 실행이 아카이브에 쓴 뒤 원본 삭제 전에 끊겼다면 같은 행이 아카이브 끝에 이미 있다.
    // 커서 번호 크기로 거르면 같은 번호(두 프로젝트 동시 기록)·순서가 뒤바뀐 행이 아카이브 없이 삭제되므로
    // 아카이브 끝부분의 실제 행(커서·시각·시트·동작·id)과 비교한다.
    const archivedTail = Math.min(Math.max(archive.getLastRow() - 1, 0), rows.length);
    const archivedKeys = new Set(archivedTail
      ? archive.getRange(archive.getLastRow() - archivedTail + 1, 1, archivedTail, 5).getValues().map(changeArchiveRowKey_)
      : []);
    const newRows = rows.filter(function(row) { return !archivedKeys.has(changeArchiveRowKey_(row)); });
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

function changeArchiveRowKey_(row) {
  return [0, 1, 2, 3, 4].map(function(index) { return String(normalizeCell_(row[index])); }).join('|');
}

// 예전 _Changes에는 행 전체 JSON이 들어 있다. 한 번에 너무 많은 셀을 쓰지 않도록 제한된 수만
// 필드명 메타데이터로 바꾸며, 남은 건은 다음 weeklyOps 또는 수동 실행에서 이어서 처리한다.
function compactStoredChangeLogValues_(sheetName, maxRows) {
  const ss = getMainSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheetName, scanned: 0, compacted: 0, remaining: false };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const dataIndex = headers.indexOf('data');
  if (dataIndex < 0) return { sheet: sheetName, scanned: 0, compacted: 0, remaining: false };

  const count = sheet.getLastRow() - 1;
  const values = sheet.getRange(2, dataIndex + 1, count, 1).getValues();
  const limit = Math.max(1, Math.min(Number(maxRows) || CHANGE_COMPACT_BATCH_SIZE, CHANGE_COMPACT_BATCH_SIZE));
  const updates = [];
  let remaining = false;
  for (let index = 0; index < values.length; index++) {
    const raw = String(values[index][0] || '');
    if (raw.indexOf('{"fields":') === 0 && raw.indexOf('}') === raw.length - 1) continue; // 이미 정리된 행
    const parsed = parseJsonObject_(raw);
    const alreadyCompact = Array.isArray(parsed.fields) && Object.keys(parsed).every(function(key) { return key === 'fields'; });
    if (alreadyCompact) continue;
    if (updates.length >= limit) { remaining = true; break; }
    updates.push({ row: index + 2, value: JSON.stringify(compactChangeLogData_(parsed)) });
  }

  // 연속된 행끼리 묶어 API 호출 수를 줄인다.
  const ranges = [];
  updates.forEach(function(update) {
    const current = ranges[ranges.length - 1];
    if (current && current.start + current.values.length === update.row) current.values.push([update.value]);
    else ranges.push({ start: update.row, values: [[update.value]] });
  });
  ranges.forEach(function(range) {
    sheet.getRange(range.start, dataIndex + 1, range.values.length, 1).setValues(range.values);
  });
  return { sheet: sheetName, scanned: values.length, compacted: updates.length, remaining: remaining };
}

function compactChangeLogs() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return {
      active: compactStoredChangeLogValues_(CHANGE_LOG_SHEET),
      archive: compactStoredChangeLogValues_(CHANGE_ARCHIVE_SHEET)
    };
  } finally {
    lock.releaseLock();
  }
}

function archiveOldChanges() {
  return archiveOldChanges_();
}

// 매주 실행. 한 번에 CHANGE_ARCHIVE_BATCH_SIZE·CHANGE_COMPACT_BATCH_SIZE씩만 처리하되, 밀린 건이 있으면
// 실행시간 예산(OPS_TIME_BUDGET_MS) 안에서 배치를 반복한다. 예산을 넘겨 남은 건은 incomplete로 알리고
// 다음 실행(또는 수동 재실행)에서 이어서 처리한다. 같은 행을 두 번 아카이브하지 않는다(archiveOldChanges_).
function weeklyOps() {
  const guard = acquireOpsRunGuard_('weeklyOps');
  if (!guard) return { ok: false, error: 'ops_already_running' };
  try {
    const archiveResult = archiveOldChanges_();
    const compactResult = compactChangeLogs();
    let archiveBatches = 1;
    let compactBatches = 1;
    // 직전 배치가 꽉 찼을 때만(남은 오래된 기록이 더 있을 수 있을 때만) 다음 배치를 돈다.
    let lastArchived = archiveResult.archived;
    while (lastArchived >= CHANGE_ARCHIVE_BATCH_SIZE && !opsTimeBudgetExceeded_()) {
      const next = archiveOldChanges_();
      archiveResult.archived += next.archived;
      archiveResult.remaining = next.remaining;
      archiveBatches++;
      lastArchived = next.archived;
    }
    while ((compactResult.active.remaining || compactResult.archive.remaining) && !opsTimeBudgetExceeded_()) {
      const next = compactChangeLogs();
      ['active', 'archive'].forEach(function(key) {
        compactResult[key].compacted += next[key].compacted;
        compactResult[key].remaining = next[key].remaining;
      });
      compactBatches++;
    }
    archiveResult.batches = archiveBatches;
    compactResult.batches = compactBatches;
    const incomplete = lastArchived >= CHANGE_ARCHIVE_BATCH_SIZE
      || !!(compactResult.active.remaining || compactResult.archive.remaining);
    console.log('weeklyOps: ' + JSON.stringify({ changeArchive: archiveResult, changeLogCompaction: compactResult, incomplete: incomplete }));
    return { ok: true, incomplete: incomplete, changeArchive: archiveResult, changeLogCompaction: compactResult };
  } finally {
    releaseOpsRunGuard_(guard);
  }
}

// 진행이 끝난 지원자 id 집합 — 불합격, 보류(held), 또는 진행중이 아닌 포지션 소속.
