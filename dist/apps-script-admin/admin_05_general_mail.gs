const GENERAL_MAIL_TEMPLATE_FILES = {
  interview_first: 'mail_body_interview_first',
  interview_second: 'mail_body_interview_second',
  panel_schedule: 'mail_body_panel_schedule',
  onboarding: 'mail_body_onboarding',
  onboarding_internal: 'mail_body_onboarding_internal',
  rejection: 'mail_body_rejection',
  interview_slot_request: 'mail_body_interview_slot_request',
  headhunter_forward: 'mail_body_headhunter_forward',
  general_notice: 'mail_body_general_notice'
};

const GENERAL_MAIL_PREHEADER = {
  interview_first: data => `1차 면접 일정을 안내드립니다. ${data.interviewDateTime || ''}`,
  interview_second: data => `2차 면접 일정을 안내드립니다. ${data.interviewDateTime || ''}`,
  panel_schedule: () => '면접 일정 및 대상자를 안내드립니다.',
  onboarding: data => `입사를 진심으로 축하드립니다. 입사일 ${data.joinDate || ''}`,
  onboarding_internal: data => `신규입사자 안내 — ${data.joinDate || ''} 입사 예정`,
  rejection: () => '채용 결과를 안내드립니다.',
  interview_slot_request: () => '가능한 면접 날짜와 오전·오후 시간대를 선택해 주세요.',
  headhunter_forward: data => `헤드헌팅 후보자 ${data.candidateName || ''}님의 ${data.purpose || '채용 진행'} 안내입니다.`,
  general_notice: () => '채용 진행 관련 안내드립니다.'
};

const GENERAL_MAIL_HEADER_TITLES = {
  interview_first: '1차 면접 안내',
  interview_second: '2차 면접 안내',
  panel_schedule: '면접 일정 안내',
  onboarding: '입사 안내',
  onboarding_internal: '신규입사자 안내',
  rejection: '채용 결과 안내',
  interview_slot_request: '면접 후보 일정 요청',
  headhunter_forward: '헤드헌팅 후보자 안내',
  general_notice: '채용 진행 안내'
};


var _mailFragmentCache_ = {};
function loadMailFragment_(fileName) {
  if (!Object.prototype.hasOwnProperty.call(_mailFragmentCache_, fileName)) {
    _mailFragmentCache_[fileName] = HtmlService.createHtmlOutputFromFile(fileName).getContent();
  }
  return _mailFragmentCache_[fileName];
}

function panelAvailabilityId_(positionId, round, email) {
  return [String(positionId || '').trim(), String(round || '').trim(), normalizeEmail_(email)].join(':');
}

function parseJsonArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function buildPanelAvailabilityLinkUrl_(token) {
  return buildUrlWithParams_(getScriptProperty_('INTERVIEW_AVAILABILITY_PAGE_URL') || INTERVIEW_AVAILABILITY_PAGE_URL, {
    audience: 'panel',
    token: token
  });
}

function panelAvailabilityExpired_(row) {
  return !!(row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() < Date.now());
}

function issuePanelAvailabilityLink_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || '').trim();
  const positionTitle = String(body.positionTitle || '').trim();
  const round = String(body.round || '').trim();
  const panelistName = String(body.panelistName || '').trim();
  const panelistEmail = normalizeEmail_(body.panelistEmail);
  const options = normalizeInterviewAvailabilityOptions_(body.options);
  if (!positionId || !positionTitle || !round || !panelistEmail || !options.length) {
    return json_({ error: 'missing_panel_availability_fields' });
  }

  const sheet = ensureSheet_('PanelAvailability');
  const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
  const id = panelAvailabilityId_(positionId, round, panelistEmail);
  const rowIndex = findRowIndex_(sheet, 'id', id, headers);
  const existing = readRows_('PanelAvailability').find(row => String(row.id) === id) || {};
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : new Date(Date.now() + INTERVIEW_AVAILABILITY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const link = buildPanelAvailabilityLinkUrl_(token);
  const normalized = schemaRow_('PanelAvailability', Object.assign({}, existing, {
    id,
    positionId,
    positionTitle,
    round,
    panelistName,
    panelistEmail,
    availabilityOptions: JSON.stringify(options),
    token,
    tokenExpiresAt: expiresAt,
    link,
    selections: '',
    status: 'SENT',
    respondedAt: '',
    note: '',
    createdAt: existing.createdAt || nowIso_(),
    updatedAt: nowIso_()
  }));
  const values = headers.map(header => normalized[header] == null ? '' : normalized[header]);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
  else sheet.appendRow(values);
  appendChange_('PanelAvailability', 'upsert', id, normalized);
  return json_({ ok: true, id, link, tokenExpiresAt: expiresAt, response: normalized });
}

function getPanelAvailabilityResponses_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const positionId = String(body.positionId || body.query && body.query.positionId || '').trim();
  const round = String(body.round || body.query && body.query.round || '').trim();
  if (!positionId || !round) return json_({ error: 'missing_panel_availability_query' });
  const responses = readRows_('PanelAvailability')
    .filter(row => String(row.positionId) === positionId && String(row.round) === round)
    .map(row => Object.assign({}, row, {
      availabilityOptions: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
      selections: parseJsonArray_(row.selections)
    }));
  return json_({ ok: true, responses });
}

function verifyPanelAvailabilityToken_(payload) {
  const token = String(payload && (payload.token || payload.data && payload.data.token) || '').trim();
  if (!token) return json_({ ok: false, error: 'token_required' });
  const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
  if (!row) return json_({ ok: false, error: 'invalid_token' });
  if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    participantRole: 'panel',
    participantName: row.panelistName || '',
    positionText: row.positionTitle || '',
    interviewType: row.round || '',
    options: normalizeInterviewAvailabilityOptions_(row.availabilityOptions),
    alreadySubmitted: row.status === 'RESPONDED' || row.status === 'UNAVAILABLE',
    unavailable: row.status === 'UNAVAILABLE',
    selections: parseJsonArray_(row.selections),
    note: row.note || ''
  });
}

function submitPanelAvailability_(payload) {
  const body = payload && payload.data && Object.keys(payload.data).length ? payload.data : (payload || {});
  const token = String(body.token || '').trim();
  const unavailable = body.unavailable === true || String(body.unavailable || '').toLowerCase() === 'true';
  const requested = Array.isArray(body.selections) ? body.selections.map(value => String(value || '').trim()) : [];
  const note = String(body.note || '').trim().slice(0, 500);
  if (!token) return json_({ ok: false, error: 'token_required' });
  if (!unavailable && !requested.length) return json_({ ok: false, error: 'selection_required' });
  if (unavailable && !note) return json_({ ok: false, error: 'alternative_note_required' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('PanelAvailability');
    const headers = ensureHeaders_(sheet, SHEET_SCHEMAS.PanelAvailability);
    const rowIndex = findRowIndex_(sheet, 'token', token, headers);
    if (rowIndex < 0) return json_({ ok: false, error: 'invalid_token' });
    const row = readRows_('PanelAvailability').find(item => String(item.token || '') === token);
    if (!row) return json_({ ok: false, error: 'invalid_token' });
    if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });

    const allowed = {};
    normalizeInterviewAvailabilityOptions_(row.availabilityOptions).forEach(option => {
      option.periods.forEach(period => { allowed[option.date + '|' + period] = true; });
    });
    const selections = requested.filter((value, index, array) => allowed[value] && array.indexOf(value) === index);
    if (!unavailable && selections.length !== requested.length) return json_({ ok: false, error: 'invalid_selection' });

    const normalized = schemaRow_('PanelAvailability', Object.assign({}, row, {
      selections: JSON.stringify(unavailable ? [] : selections),
      status: unavailable ? 'UNAVAILABLE' : 'RESPONDED',
      respondedAt: nowIso_(),
      note,
      updatedAt: nowIso_()
    }));
    sheet.getRange(rowIndex, 1, 1, headers.length)
      .setValues([headers.map(header => normalized[header] == null ? '' : normalized[header])]);
    appendChange_('PanelAvailability', 'upsert', row.id, normalized);
    return json_({ ok: true, status: normalized.status, respondedAt: normalized.respondedAt });
  } finally {
    lock.releaseLock();
  }
}

function loadMailAsset_(fileName) {
  return loadMailFragment_(fileName).trim();
}

function nlToBr_(value) {
  return escapeMailHtml_(value).replace(/\n/g, '<br>');
}

function replaceMailPlaceholders_(html, replacements) {
  let rendered = String(html || '');
  Object.keys(replacements || {}).forEach(function(marker) {
    rendered = rendered.split('{{' + marker + '}}').join(String(replacements[marker] == null ? '' : replacements[marker]));
  });
  return rendered;
}

function assertGeneralMailFields_(templateKey, data, fields) {
  const missing = (fields || []).filter(function(field) {
    return !String((data || {})[field] || '').trim();
  });
  if (missing.length) {
    throw new Error('missing_general_mail_fields:' + templateKey + ':' + missing.join(','));
  }
}

function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return loadMailFragment_('mail_shared_header_bottom')
    .replace(/{{ciSrc}}/g, loadMailAsset_('mail_asset_ci_src'))
    .replace(/{{headerArtSrc}}/g, loadMailAsset_('mail_asset_header_art_src'))
    .replace(/{{headerTitle}}/g, title)
    .replace(/{{headerSubtitle}}/g, subtitle);
}

function generalMailHtml_(templateKey, data) {
  try {
    const fileName = GENERAL_MAIL_TEMPLATE_FILES[templateKey];
    if (!fileName) return '';
    const ctx = data || {};
    const preheaderFn = GENERAL_MAIL_PREHEADER[templateKey] || (() => '');
    const preheader = escapeMailHtml_(preheaderFn(ctx));

    const headerTop = loadMailFragment_('mail_shared_header_top');
    const headerBottom = renderGeneralMailHeader_(templateKey, ctx);
    const bodyOpen = loadMailFragment_('mail_shared_body_open');
    const bodyClose = loadMailFragment_('mail_shared_body_close');
    const contactHtml = generalMailContactHtml_(templateKey, ctx);
    const footer = loadMailFragment_('mail_shared_footer');
    const rawBody = loadMailFragment_(fileName);
    const filledBody = renderGeneralMailTemplate_(rawBody, templateKey, ctx);

    const preheaderDiv = '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">' + preheader + '</div>';

    return headerTop + preheaderDiv + headerBottom + bodyOpen + filledBody + contactHtml + bodyClose + footer;
  } catch (err) {
    console.warn('generalMailHtml_ failed: ' + String(err && err.message || err));
    return '';
  }
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function isInternalGeneralMail_(templateKey) {
  return templateKey === 'panel_schedule' || templateKey === 'onboarding_internal';
}

function generalMailContactHtml_(templateKey, data) {
  if (isInternalGeneralMail_(templateKey)) return '';
  const message = String((data && data.contactMessage) || '채용 절차와 관련해 궁금한 점이 있으시면 본 메일에 회신해 주세요.');
  return '        <tr>\n' +
    '          <td style="padding-top:24px;border-top:1px solid #dde7f1;">\n' +
    '            <div style="font-size:15px;line-height:1.4;font-weight:700;color:#1b2027;padding-bottom:6px;word-break:keep-all;overflow-wrap:break-word;">문의사항</div>\n' +
    '            <div style="font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">' + nlToBr_(message) + '</div>\n' +
    '          </td>\n' +
    '        </tr>\n';
}

function renderGeneralMailTemplate_(html, templateKey, data) {
  let rendered = String(html || '');
  const candidateName = String(data.candidateName || '이하늘');
  const positionText = String(data.positionText || '홍보 포지션');

  // 메모(안내 추가문구) 행 — 값이 있으면 채우고, 없으면 행 자체를 제거한다.
  const memoText = String(data.memo || '').trim();
  if (templateKey === 'interview_first' || templateKey === 'interview_second') {
    if (memoText) {
      rendered = rendered.replace(/<tr id="mailMemoRow">[\s\S]*?<\/tr>/,
        '<tr><td style="padding-top:18px;font-size:14px;line-height:1.6;color:#5c6875;word-break:keep-all;overflow-wrap:break-word;">' + nlToBr_(memoText) + '</td></tr>');
    } else {
      rendered = rendered.replace(/<tr id="mailMemoRow">[\s\S]*?<\/tr>/, '');
    }
  }

  if (templateKey === 'interview_first') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','interviewDateTime']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewDateTime: escapeMailHtml_(data.interviewDateTime || ''),
      location: escapeMailHtml_(data.location || '')
    });
  } else if (templateKey === 'interview_second') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','interviewDateTime']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewDateTime: escapeMailHtml_(data.interviewDateTime || ''),
      location: escapeMailHtml_(data.location || '')
    });
  } else if (templateKey === 'panel_schedule') {
    assertGeneralMailFields_(templateKey, data, [
      'dept','interviewType','scheduleText','targetCount','panelNames','targetList'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      dept: escapeMailHtml_(data.dept || ''),
      etype: escapeMailHtml_(data.etype || ''),
      interviewType: escapeMailHtml_(data.interviewType || ''),
      scheduleText: escapeMailHtml_(data.scheduleText || ''),
      location: escapeMailHtml_(data.location || ''),
      targetCount: escapeMailHtml_(String(data.targetCount || '')),
      panelNames: escapeMailHtml_(data.panelNames || ''),
      targetList: nlToBr_(data.targetList || '')
    });
  } else if (templateKey === 'onboarding') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','joinDate']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      joinDate: escapeMailHtml_(data.joinDate || ''),
      joinTime: escapeMailHtml_(data.joinTime || '09:00'),
      reportLocation: escapeMailHtml_(data.reportLocation || '본사 3층 피플팀'),
      dept: escapeMailHtml_(data.dept || ''),
      rank: escapeMailHtml_(data.rank || ''),
      etype: escapeMailHtml_(data.etype || ''),
      location: escapeMailHtml_(data.location || ''),
      prepNotes: nlToBr_(data.prepNotes || '')
    });
  } else if (templateKey === 'onboarding_internal') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','joinDate']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      dept: escapeMailHtml_(data.dept || ''),
      joinDate: escapeMailHtml_(data.joinDate || ''),
      rank: escapeMailHtml_(data.rank || ''),
      etype: escapeMailHtml_(data.etype || ''),
      location: escapeMailHtml_(data.location || ''),
      phone: escapeMailHtml_(data.phone || ''),
      replyDeadline: escapeMailHtml_(data.replyDeadline || ''),
      joinDaySchedule: escapeMailHtml_(data.joinDaySchedule || ''),
      deptCooperation: nlToBr_(data.deptCooperation || '')
    });
    const workLocation = String(data.location || data.workplace || data.site || '');
    if (!/현장|공사|사업소|프로젝트|PJ/i.test(workLocation)) {
      rendered = rendered.replace(/<tr id="siteOnboardingRequestRow">[\s\S]*?<\/tr>/, '');
    }
  } else if (templateKey === 'rejection') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText']);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText)
    });
  } else if (templateKey === 'interview_slot_request') {
    assertGeneralMailFields_(templateKey, data, [
      'candidateName','positionText','interviewType','slotOptions','responseDeadline','availabilityLink'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      interviewType: escapeMailHtml_(data.interviewType || ''),
      slotOptions: nlToBr_(data.slotOptions || ''),
      location: escapeMailHtml_(data.location || ''),
      responseDeadline: escapeMailHtml_(data.responseDeadline || ''),
      availabilityLink: escapeMailHtml_(data.availabilityLink || '#')
    });
  } else if (templateKey === 'headhunter_forward') {
    const forwardBody = data.forwardBody || data.body || '';
    assertGeneralMailFields_(templateKey, Object.assign({}, data, { forwardBody }), [
      'candidateName','positionText','forwardBody'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      recipientName: escapeMailHtml_(data.recipientName || '헤드헌팅 담당자'),
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      purpose: escapeMailHtml_(data.purpose || '채용 진행'),
      forwardBody: nlToBr_(forwardBody)
    });
  } else if (templateKey === 'general_notice') {
    const actionLink = String(data.actionLink || '').trim();
    const actionLabel = String(data.actionLabel || '바로가기').trim();
    const noticeBody = data.noticeBody || data.body || '';
    assertGeneralMailFields_(templateKey, Object.assign({}, data, { noticeBody }), [
      'candidateName','positionText','noticeBody'
    ]);
    const noticeHtml = nlToBr_(noticeBody) + (actionLink
      ? '<div style="text-align:center;margin:24px 0 2px;"><a href="' + escapeMailHtml_(actionLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:7px;">' + escapeMailHtml_(actionLabel) + '</a></div>'
      : '');
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      noticeBody: noticeHtml
    });
  }

  if (['interview_first', 'interview_second', 'panel_schedule', 'onboarding', 'onboarding_internal',
       'interview_slot_request', 'rejection', 'headhunter_forward', 'general_notice'].includes(templateKey) &&
      /\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error('unresolved_general_mail_placeholder');
  }
  return rendered;
}

function handleSendGeneralMail_(payload) {
  if (!isAdminRequest_(payload)) return json_({ error: 'admin_auth_required' });
  const body = (payload && payload.data && Object.keys(payload.data).length) ? payload.data : (payload || {});
  const to = normalizeEmail_(body.toEmail || body.to || body.email);
  const subject = String(body.subject || '').trim();
  const message = String(body.body || body.message || '').trim();
  if (!to || !subject || !message) return json_({ error: 'missing_mail_fields' });
  try {
    const html = generalMailHtml_(body.templateType, body);
    if (!html) throw new Error('mail_template_render_failed');
    const result = sendMailViaGmail_(to, subject, message, html);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    return json_({ ok: true, to: to });
  } catch (err) {
    const errorText = String(err && err.message || err);
    console.warn('handleSendGeneralMail_ failed: ' + errorText);
    return json_({ error: errorText || 'mail_send_failed' });
  }
}

