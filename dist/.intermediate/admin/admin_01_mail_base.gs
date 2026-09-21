function sendMailViaGmail_(to, subject, body, htmlBody) {
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

    MailApp.sendEmail(options);
    logMailSend_(recipients.join(','), cleanSubject, 'sent', '');
    return { ok: true, to: recipients.join(',') };
  } catch (err) {
    const errorText = String(err && err.message || err);
    logMailSend_(recipients.join(','), cleanSubject, 'failed', errorText);
    return { ok: false, error: errorText };
  }
}

function handleSendMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const result = sendMailViaGmail_(body.toEmail || body.to || body.email, body.subject, body.body || body.message, body.htmlBody);
  return json_(result);
}

function logMailSend_(to, subject, status, error) {
  try {
    const sheet = ensureSheet_('MailLog');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.MailLog);
    const row = {
      id: 'ML-' + Utilities.getUuid(),
      to: String(to || ''),
      subject: String(subject || ''),
      status: String(status || ''),
      error: String(error || '').slice(0, 5000),
      sentAt: nowIso_()
    };
    sheet.appendRow(headers.map(function(h) { return row[h] == null ? '' : row[h]; }));
  } catch (err) {
    console.warn('logMailSend_ failed: ' + String(err && err.message || err));
  }
}

