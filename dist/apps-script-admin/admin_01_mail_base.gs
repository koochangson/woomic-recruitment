function sendMailViaGmail_(to, subject, body, htmlBody, attachments, eventKey) {
  const recipients = String(to || '').split(/[;,]/).map(function(addr) { return addr.trim(); }).filter(Boolean);
  const cleanSubject = String(subject || '');
  try {
    if (!recipients.length) return { ok: false, error: 'no_recipient' };
    const hasHtml = String(htmlBody || '').trim();
    const options = {
      to: recipients.join(','),
      subject: cleanSubject,
      body: String(body || ''),
      name: '피플팀'
    };
    if (hasHtml) options.htmlBody = String(htmlBody);
    if (Array.isArray(attachments) && attachments.length) options.attachments = attachments;

    MailApp.sendEmail(options);
    const logged = logMailSend_(recipients.join(','), cleanSubject, 'sent', '', eventKey);
    return { ok: true, to: recipients.join(','), logged: logged !== false };
  } catch (err) {
    const errorText = String(err && err.message || err);
    logMailSend_(recipients.join(','), cleanSubject, 'failed', errorText, eventKey);
    return { ok: false, error: errorText };
  }
}

// 담당자가 보내는 메일의 중복 발송 방지.
// 응답이 늦어 다시 누르거나 두 번 클릭하면 같은 메일이 두 번 나갈 수 있었다. 수신자·제목·내용이 같은 메일이
// 최근(MAIL_DEDUPE_WINDOW_SECONDS)에 나갔거나 보내는 중이면 보내지 않고 duplicate_recent를 돌려준다.
// 담당자가 확인 후 다시 보내면(allowDuplicate) 그대로 보낸다.
const MAIL_DEDUPE_WINDOW_SECONDS = 10 * 60;

function mailDedupeKey_(kind, body) {
  const skip = { sessionToken: 1, allowDuplicate: 1, attachments: 1 };
  const fields = Object.keys(body || {}).filter(function(k) { return !skip[k]; }).sort().map(function(k) {
    const v = body[k];
    return [k, v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))];
  });
  const files = (Array.isArray(body && body.attachments) ? body.attachments : []).map(function(a) {
    return [String(a && a.name || ''), String(a && a.base64 || '').length];
  });
  return 'maildedupe:' + sha256Hex_(kind + '|' + JSON.stringify(fields) + '|' + JSON.stringify(files));
}

// 보내도 되면 { key }를, 막아야 하면 { duplicate: { error, sentAt } }를 돌려준다.
function beginMailDedupe_(kind, body) {
  if (body && body.allowDuplicate) return { key: '' };
  const key = mailDedupeKey_(kind, body);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { key: '' }; // 잠금을 못 얻으면 막지 않는다(발송 자체는 계속)
  try {
    const prev = cache.get(key);
    if (prev) {
      let info = {};
      try { info = JSON.parse(prev) || {}; } catch (e) {}
      return { duplicate: { error: 'duplicate_recent', state: info.state || 'sent', sentAt: info.at || '' } };
    }
    cache.put(key, JSON.stringify({ state: 'sending', at: nowIso_() }), MAIL_DEDUPE_WINDOW_SECONDS);
    return { key: key };
  } finally {
    lock.releaseLock();
  }
}

function finishMailDedupe_(key, sent) {
  if (!key) return;
  const cache = CacheService.getScriptCache();
  if (sent) cache.put(key, JSON.stringify({ state: 'sent', at: nowIso_() }), MAIL_DEDUPE_WINDOW_SECONDS);
  else cache.remove(key);
}

function handleSendMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const result = sendMailViaGmail_(body.toEmail || body.to || body.email, body.subject, body.body || body.message, body.htmlBody);
  return json_(result);
}

function logMailSend_(to, subject, status, error, eventKey) {
  try {
    const sheet = ensureSheet_('MailLog');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.MailLog);
    const row = {
      id: 'ML-' + Utilities.getUuid(),
      eventKey: String(eventKey || ''),
      to: String(to || ''),
      subject: String(subject || ''),
      status: String(status || ''),
      error: String(error || '').slice(0, 5000),
      sentAt: nowIso_()
    };
    sheet.appendRow(headers.map(function(h) { return row[h] == null ? '' : row[h]; }));
    return true;
  } catch (err) {
    console.warn('logMailSend_ failed: ' + String(err && err.message || err));
    return false;
  }
}

