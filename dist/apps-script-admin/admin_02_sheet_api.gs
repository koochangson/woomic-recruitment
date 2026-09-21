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

function upsert_(sheetName, row, isAdmin) {
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
  let count = 0;
  source.forEach(row => {
    const result = JSON.parse(upsertRaw_(sheetName, row, isAdmin).getContent());
    if (!result.error) count++;
  });
  return json_({ status: 'ok', count, cursor: getChangeCursor_(), serverTime: nowIso_() });
}

function upsertRaw_(sheetName, row, isAdmin) {
  return upsert_(sheetName, row, isAdmin);
}

function replaceAll_(sheetName, rows, isAdmin) {
  if (!isAdmin) throw new Error('admin_auth_required');
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
}

function deleteRow_(sheetName, id) {
  const sheet = ensureSheet_(sheetName);
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS[sheetName]);
  const key = primaryKey_(sheetName);
  const cleanId = String(id || '').trim();
  if (!cleanId) return json_({ error: 'missing_id' });

  const rowIndex = findRowIndex_(sheet, key, cleanId, headers);
  if (rowIndex > 0) sheet.deleteRow(rowIndex);
  appendChange_(sheetName, 'delete', cleanId, {});
  return json_({ status: 'deleted', id: cleanId, cursor: getChangeCursor_(), serverTime: nowIso_() });
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

