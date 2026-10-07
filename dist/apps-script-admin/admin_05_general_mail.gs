const GENERAL_MAIL_TEMPLATE_FILES = {
  interview_first: 'mail_body_interview_first',
  interview_second: 'mail_body_interview_second',
  panel_schedule: 'mail_body_panel_schedule',
  onboarding: 'mail_body_onboarding',
  onboarding_internal: 'mail_body_onboarding_internal',
  offer_health: 'mail_body_offer_health',
  final_pass: 'mail_body_final_pass',
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
  onboarding_internal: data => `신규입사자 안내 — ${data.joinDate || ''} 입사 예정${Array.isArray(data.joiners) && data.joiners.length > 1 ? ' ' + data.joiners.length + '명' : ''}`,
  offer_health: () => '처우 제안과 채용검진 일정을 안내드립니다.',
  final_pass: () => '최종 합격을 축하드립니다. 입사 가능일을 선택해 주세요.',
  rejection: () => '채용 결과를 안내드립니다.',
  interview_slot_request: () => '가능한 면접 날짜와 시간대를 선택해 주세요.',
  headhunter_forward: data => `헤드헌팅 후보자 ${data.candidateName || ''}님의 ${data.purpose || '채용 진행'} 안내입니다.`,
  general_notice: () => '채용 진행 관련 안내드립니다.'
};

const GENERAL_MAIL_HEADER_TITLES = {
  interview_first: '1차 면접 안내',
  interview_second: '2차 면접 안내',
  panel_schedule: '면접 일정 안내',
  onboarding: '입사 안내',
  onboarding_internal: '신규입사자 안내',
  offer_health: '채용검진 및 근로조건 안내',
  final_pass: '최종합격 안내',
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
  const loc = String(body.loc || '').trim();
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
    loc: loc || existing.loc || '',
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
  if (positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
  if (panelAvailabilityExpired_(row)) return json_({ ok: false, error: 'token_expired' });
  return json_({
    ok: true,
    participantRole: 'panel',
    participantName: row.panelistName || '',
    positionText: row.positionTitle || '',
    interviewType: row.round || '',
    location: row.loc || '',
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
    if (row && positionProcessClosed_(row.positionId)) return json_({ ok: false, error: 'process_closed' });
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
    notifyIfPanelAvailabilityCohortComplete_(normalized);
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

// 제목 칸(머리글 왼쪽 56%)에 한 줄로 들어가도록 긴 제목은 글자를 줄인다(예: '채용검진 및 근로조건 안내').
function mailHeaderTitleSize_(title) {
  const len = String(title || '').replace(/&[a-z]+;/g, ' ').length;
  return len <= 9 ? '28px' : len <= 11 ? '25px' : '22px';
}

function renderGeneralMailHeader_(templateKey, data) {
  const ctx = data || {};
  const title = escapeMailHtml_(ctx.headerTitle || GENERAL_MAIL_HEADER_TITLES[templateKey] || ctx.subject || '채용 진행 안내');
  const subtitle = escapeMailHtml_(ctx.headerSubtitle || ctx.positionText || '우미건설 채용 절차 안내');
  return loadMailFragment_('mail_shared_header_bottom')
    .replace(/{{ciSrc}}/g, loadMailAsset_('mail_asset_ci_src'))
    .replace(/{{headerArtSrc}}/g, loadMailAsset_('mail_asset_header_art_src'))
    .replace(/{{headerTitleSize}}/g, mailHeaderTitleSize_(title))
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

    return headerTop + preheaderDiv + headerBottom + bodyOpen + forwardNoticeHtml_(ctx) + filledBody + contactHtml + bodyClose + footer;
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

// 공용 문의 블록(mail_shared_contact_qr)에 들어 있는 기본 문구 — 메일 종류에 맞는 문구로 바꿔 넣는다.
const KAKAO_CONTACT_FRAGMENT_TEXT_ = '레퍼런스 체크와 관련해 궁금한 점이 있으시면 카카오톡 채널로 문의해 주세요.';

// 문의는 메일 회신이 아니라 카카오톡 채널로 받는다(레퍼런스 메일과 같은 문의 블록·QR 사용).
// 내부 직원에게 가는 메일(면접관 안내, 사내 입사 안내, 면접관 일정 확인)에는 붙이지 않는다.
function generalMailContactHtml_(templateKey, data) {
  if (isInternalGeneralMail_(templateKey) || (data && data.internalRecipient)) return '';
  const message = String((data && data.contactMessage) || '채용 절차와 관련해 궁금한 점이 있으시면 카카오톡 채널로 문의해 주세요.');
  return loadMailFragment_('mail_shared_contact_qr').split(KAKAO_CONTACT_FRAGMENT_TEXT_).join(nlToBr_(message));
}

// 메일 날짜 형식(전 메일 공통): 2026년 10월 6일(화). 'YYYY-MM-DD'가 아니면 받은 값을 그대로 쓴다.
function mailDateLabel_(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return raw;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const wk = ['일','월','화','수','목','금','토'][new Date(y, mo - 1, d).getDay()];
  return y + '년 ' + mo + '월 ' + d + '일(' + wk + ')';
}

// '담당 / 과장'처럼 직책/직급을 함께 적은 값에서 직급만 꺼내고, 역량등급이 있으면 '과장 (CL3)'처럼 붙인다.
// 직급(역량등급) 표기: 'CL2 1년차 (대리)'. 직급 칸에 '대리 1년차'처럼 적으면 연차와 직급을 나눠 쓴다.
// '담당 / 과장'처럼 직책을 함께 적었으면 '/' 뒤의 직급만 쓴다.
function onboardingRankCl_(rank, cl) {
  const raw = String(rank || '').trim();
  const grade = raw.includes('/') ? raw.split('/').pop().trim() : raw;
  const yearMatch = grade.match(/\d+\s*년차/);
  const years = yearMatch ? yearMatch[0].replace(/\s+/g, '') : '';
  const title = grade.replace(/\d+\s*년차/, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = [String(cl || '').trim(), years].filter(Boolean).join(' ');
  if (!head && !title) return '-';
  return title ? (head ? head + ' (' + title + ')' : title) : head;
}

// 표 안의 짧은 입사일자: 10.6(화)
function shortMailDate_(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value || '');
  const mo = Number(m[2]), d = Number(m[3]);
  const wk = ['일','월','화','수','목','금','토'][new Date(Number(m[1]), mo - 1, d).getDay()];
  return mo + '.' + d + '(' + wk + ')';
}

// 입사 사전 정보 입력(SAP) 제출 기한: 지정값이 없으면 입사일 전날, 입사일도 없으면 '입사일 전까지'로 안내한다.
function onboardingPreDeadlineLabel_(data) {
  const explicit = String(data.preDeadline || '').trim();
  if (explicit) return mailDateLabel_(explicit);
  const m = String(data.joinDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '입사일 전';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
  const pad = n => (n < 10 ? '0' : '') + n;
  return mailDateLabel_(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
}

// ── 메일 종류별 공통 첨부(사전 입사 절차 매뉴얼·채용검진 안내) ─────────────
// 관리자 화면에서 한 번 등록하면 해당 메일을 보낼 때마다 자동으로 붙는다. 문서가 바뀌면 화면에서 교체한다.
// DriveApp은 드라이브 전체 권한이 필요해(drive.file로는 거부됨) 이미 쓰는 스프레드시트의 숨김 시트에
// base64 조각으로 보관한다. 파일 정보(이름·크기·등록일)는 스크립트 속성에 둔다.
// 이 시트는 동기화 대상(SHEET_SCHEMAS)이 아니라서 화면으로 내려가지 않는다.
const COMMON_MAIL_ATTACHMENTS = {
  onboarding: { property: 'ONBOARDING_MANUAL_FILE', label: '사전 입사 절차 매뉴얼' },
  offer_health: { property: 'OFFER_HEALTH_GUIDE_FILE', label: '채용검진 안내' }
};
const COMMON_MAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const COMMON_MAIL_ATTACHMENT_SHEET = '_MailAttachments';
const COMMON_MAIL_ATTACHMENT_CHUNK = 45000; // 셀 하나에 5만 자까지 들어간다

function getCommonAttachmentMeta_(kind) {
  const def = COMMON_MAIL_ATTACHMENTS[kind];
  if (!def) return null;
  try {
    const meta = JSON.parse(getScriptProperty_(def.property) || 'null');
    // 이전 Drive 저장 방식(fileId)은 현재 권한으로 읽을 수 없다. 미등록으로 보여 재등록을 유도한다.
    return meta && Number(meta.chunks) > 0 ? meta : null;
  } catch (err) { return null; }
}

function getCommonAttachments_() {
  const result = {};
  Object.keys(COMMON_MAIL_ATTACHMENTS).forEach(kind => { result[kind] = getCommonAttachmentMeta_(kind); });
  return result;
}

function commonAttachmentSheet_(create) {
  const ss = getMainSpreadsheet_();
  let sheet = ss.getSheetByName(COMMON_MAIL_ATTACHMENT_SHEET);
  if (!sheet && create) {
    sheet = ss.insertSheet(COMMON_MAIL_ATTACHMENT_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['kind', 'index', 'data']]);
    sheet.hideSheet();
  }
  return sheet;
}

function commonAttachmentBlob_(kind) {
  const meta = getCommonAttachmentMeta_(kind);
  if (!meta) return null;
  try {
    const sheet = commonAttachmentSheet_(false);
    if (!sheet || sheet.getLastRow() < 2) return null;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
      .filter(row => String(row[0]) === kind)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    if (rows.length !== Number(meta.chunks) || rows.some((row, index) => Number(row[1]) !== index)) return null;
    const bytes = Utilities.base64Decode(rows.map(row => String(row[2])).join(''));
    if (bytes.length !== Number(meta.size)) return null;
    return Utilities.newBlob(bytes, 'application/pdf', meta.name || 'attachment.pdf');
  } catch (err) {
    console.warn('commonAttachmentBlob_ failed (' + kind + '): ' + String(err && err.message || err));
    return null;
  }
}

function uploadCommonAttachment_(data) {
  const kind = String(data && data.kind || '');
  const def = COMMON_MAIL_ATTACHMENTS[kind];
  if (!def) return json_({ error: 'unknown_attachment_kind' });
  const name = String(data && data.name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const base64 = String(data && data.base64 || '').replace(/\s+/g, '');
  if (!name || !base64) return json_({ error: 'missing_upload_fields' });
  if (!/\.pdf$/i.test(name)) return json_({ error: 'unsupported_file_type' });
  const size = Utilities.base64Decode(base64).length;
  if (size > COMMON_MAIL_ATTACHMENT_MAX_BYTES) return json_({ error: 'file_too_large' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = commonAttachmentSheet_(true);
    // 다른 종류의 조각은 그대로 두고, 이 종류의 이전 조각을 새 조각으로 바꿔 한 번에 다시 쓴다.
    const lastRow = sheet.getLastRow();
    const kept = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, 3).getValues().filter(row => String(row[0]) !== kind)
      : [];
    const chunks = [];
    for (let i = 0; i < base64.length; i += COMMON_MAIL_ATTACHMENT_CHUNK) {
      chunks.push([kind, chunks.length, base64.slice(i, i + COMMON_MAIL_ATTACHMENT_CHUNK)]);
    }
    const rows = kept.concat(chunks);
    if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
    sheet.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
    const meta = { name: name, size: size, chunks: chunks.length, uploadedAt: nowIso_() };
    PropertiesService.getScriptProperties().setProperty(def.property, JSON.stringify(meta));
    return json_({ ok: true, kind: kind, attachment: meta });
  } finally {
    lock.releaseLock();
  }
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

  // 도입 문구 — 가능 시간대를 회신받아 확정한 일정이면 '확정 안내', 아니면 기본(선정·일정 안내) 문구.
  // (가능 시간대까지 받은 지원자에게 다시 '대상자로 선정되어'라고 보내던 어색한 문구 방지)
  if (templateKey === 'interview_first' || templateKey === 'interview_second') {
    const confirmedIntro = String(data.availabilityConfirmed || '') === 'Y';
    const drop = confirmedIntro ? 'default' : 'confirmed';
    rendered = rendered
      .replace(new RegExp('\\s*<tr data-mail-intro="' + drop + '">[\\s\\S]*?<\\/tr>', 'g'), '')
      .replace(/<tr data-mail-intro="(?:default|confirmed)">/g, '<tr>');
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
      joinDate: escapeMailHtml_(mailDateLabel_(data.joinDate)),
      joinTime: escapeMailHtml_(data.joinTime || '09:00'),
      reportLocation: escapeMailHtml_(data.reportLocation || '린스퀘어 14F'),
      dept: escapeMailHtml_(data.dept || ''),
      rank: escapeMailHtml_(data.rank || ''),
      rankCl: escapeMailHtml_(onboardingRankCl_(data.rank, data.cl)),
      etype: escapeMailHtml_(data.etype || ''),
      location: escapeMailHtml_(data.location || ''),
      preDeadline: escapeMailHtml_(onboardingPreDeadlineLabel_(data))
    });
    // 현장직 입사자에게만 개인 짐 준비 안내를 남긴다.
    if (!data.siteGear) rendered = rendered.replace(/<tr id="siteGearRow">[\s\S]*?<\/tr>/, '');
  } else if (templateKey === 'onboarding_internal') {
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','joinDate']);
    // 같은 날 같은 부서 입사자는 한 메일로 보낸다(data.joiners). 없으면 이 메일의 입사자 한 명.
    const joiners = Array.isArray(data.joiners) && data.joiners.length ? data.joiners : [data];
    const joinerFields = j => ({
      candidateName: escapeMailHtml_(j.candidateName || ''),
      positionText: escapeMailHtml_(j.positionText || ''),
      dept: escapeMailHtml_(j.dept || data.dept || ''),
      category: escapeMailHtml_(j.category || ''),
      nameEn: escapeMailHtml_(j.nameEn || '-'),
      etype: escapeMailHtml_(j.etype || ''),
      rankCl: escapeMailHtml_(onboardingRankCl_(j.rank, j.cl)),
      joinDateShort: escapeMailHtml_(shortMailDate_(j.joinDate || data.joinDate)),
      phone: escapeMailHtml_(j.phone || '연락처 미입력')
    });
    const repeatBlock = (startTag, endTag, list, tweak) => {
      const re = new RegExp('<!--' + startTag + '-->([\\s\\S]*?)<!--' + endTag + '-->');
      const m = rendered.match(re);
      if (!m) return;
      rendered = rendered.replace(m[0], list.map((j, i) => replaceMailPlaceholders_(tweak ? tweak(m[1], i) : m[1], joinerFields(j))).join(''));
    };
    // 두 번째 표부터는 위 표와 간격을 둔다.
    repeatBlock('JOINER_TABLE_START', 'JOINER_TABLE_END', joiners, (html, i) => i ? html.replace('<td style="padding:0;">', '<td style="padding:10px 0 0;">') : html);
    // 현장 입사자에게만 '숙소·제복 확인 요청'을 남긴다(구분이 현장이거나 근무지가 현장으로 보이는 경우).
    const siteJoiners = joiners.filter(j => j.category === '현장' || /현장|공사|사업소|프로젝트|PJ/i.test(String(j.location || j.workplace || j.site || '')));
    if (siteJoiners.length) repeatBlock('SITE_CONTACT_START', 'SITE_CONTACT_END', siteJoiners);
    else rendered = rendered.replace(/<tr id="siteOnboardingRequestRow">[\s\S]*?<\/tr>/, '');
    rendered = replaceMailPlaceholders_(rendered, {
      joinDate: escapeMailHtml_(mailDateLabel_(data.joinDate)),
      joinerPhrase: joiners.length > 1 ? '신규 입사자 ' + joiners.length + '명을' : '신규 입사자를',
      replyDeadline: escapeMailHtml_(data.replyDeadline || ''),
      deptCooperation: nlToBr_(data.deptCooperation || '')
    });
  } else if (templateKey === 'offer_health') {
    // 처우제안·채용검진 안내: 최종합격 전 단계라 합격·입사일 내용은 넣지 않는다(검진 적합 → 최종합격 통보).
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','healthDeadline','salary']);
    const salaryDigits = String(data.salary || '').replace(/[^0-9]/g, '');
    const allowanceLines = String(data.allowances || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      healthDeadline: escapeMailHtml_(shortMailDate_(data.healthDeadline)),
      org: escapeMailHtml_(data.org || '우미건설(주)'),
      etypeText: escapeMailHtml_(data.etypeText || data.etype || '-'),
      offerRank: escapeMailHtml_(onboardingRankCl_(data.rank, data.cl)),
      salaryText: escapeMailHtml_((salaryDigits ? salaryDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(data.salary || '')) + '원/年'),
      salaryNote: data.salaryNote ? ' (' + escapeMailHtml_(data.salaryNote) + ')' : '',
      allowancesHtml: allowanceLines.length
        ? '<div style="padding-top:4px;color:#334155;">' + allowanceLines.map(line => '- ' + escapeMailHtml_(line)).join('<br>') + '</div>'
        : '',
      benefitsText: escapeMailHtml_(data.benefits || '내규에 따름'),
      // 수습기간은 비워 두면 표에서 줄째로 뺀다.
      probationRow: data.probation
        ? '<tr><td width="96" valign="top" style="width:96px;padding:10px 10px;background:#f5f8fc;border-bottom:1px solid #e3eaf2;font-size:12.5px;line-height:1.5;font-weight:700;color:#5c6875;word-break:keep-all;">수습기간</td><td valign="top" style="padding:10px 12px;border-bottom:1px solid #e3eaf2;font-size:14px;line-height:1.5;color:#1b2027;word-break:keep-all;overflow-wrap:break-word;">' + escapeMailHtml_(data.probation) + '</td></tr>'
        : ''
    });
  } else if (templateKey === 'final_pass') {
    // 최종합격 통보 + 입사 가능일 회신 요청(제안 날짜 중 선택하는 공개 페이지 링크)
    assertGeneralMailFields_(templateKey, data, ['candidateName','positionText','link']);
    const dates = String(data.options || '').split(',').map(x => x.trim()).filter(Boolean);
    rendered = replaceMailPlaceholders_(rendered, {
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      optionsText: escapeMailHtml_(dates.map(shortMailDate_).join(', ') || '-'),
      replyDeadline: escapeMailHtml_(data.replyDeadline ? mailDateLabel_(data.replyDeadline) : '가능한 빨리'),
      link: escapeMailHtml_(data.link)
    });
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
    const actionLink = String(data.actionLink || '').trim();
    const actionLabel = String(data.actionLabel || '바로가기').trim();
    const responseAction = actionLink
      ? '<div style="text-align:center;margin:22px 0 2px;"><a href="' + escapeMailHtml_(actionLink) + '" style="display:inline-block;background:#003087;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:7px;">' + escapeMailHtml_(actionLabel) + '</a></div>'
      : '';
    assertGeneralMailFields_(templateKey, Object.assign({}, data, { forwardBody }), [
      'candidateName','positionText','forwardBody'
    ]);
    rendered = replaceMailPlaceholders_(rendered, {
      recipientName: escapeMailHtml_(data.recipientName || '헤드헌팅 담당자'),
      candidateName: escapeMailHtml_(candidateName),
      positionText: escapeMailHtml_(positionText),
      purpose: escapeMailHtml_(data.purpose || '채용 진행'),
      forwardBody: nlToBr_(forwardBody),
      responseInstruction: escapeMailHtml_(data.responseInstruction || '아래 내용을 후보자에게 전달하신 후, 참석 가능 여부를 본 메일로 회신해 주세요.'),
      responseNote: escapeMailHtml_(data.responseNote || '회신 시 후보자명, 포지션명, 참석 가능 여부를 함께 기재해 주세요.'),
      responseAction
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

  // 조사 표기는 값이 채워진 뒤에 받침을 보고 고른다(남은 {{...}} 검사보다 먼저).
  rendered = applyKoreanJosa_(rendered);

  if (['interview_first', 'interview_second', 'panel_schedule', 'onboarding', 'onboarding_internal', 'offer_health', 'final_pass',
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
  if (!to || !subject) return json_({ error: 'missing_mail_fields' });
  try {
    const html = generalMailHtml_(body.templateType, body);
    if (!html) throw new Error('mail_template_render_failed');
    // 메일 문구는 HTML 템플릿 한 곳에서만 관리한다 — 텍스트 버전도 렌더링된 HTML에서 만든다.
    const message = htmlToPlainText_(html) || String(body.body || body.message || '').trim();
    const attachments = buildMailAttachments_(body.attachments);
    // 메일 종류별 공통 첨부(입사안내: 사전 입사 절차 매뉴얼, 처우·검진 안내: 채용검진 안내)를 자동으로 붙인다.
    let commonAttached = false;
    if (COMMON_MAIL_ATTACHMENTS[body.templateType]) {
      const commonMeta = getCommonAttachmentMeta_(body.templateType);
      const common = commonAttachmentBlob_(body.templateType);
      if (commonMeta && !common) throw new Error('common_attachment_unavailable');
      if (common) { attachments.push(common); commonAttached = true; }
    }
    if (mailAttachmentTotalBytes_(attachments) > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error('attachment_too_large');
    }
    const result = sendMailViaGmail_(to, subject, message, html, attachments);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    return json_({ ok: true, to: to, commonAttached: commonAttached });
  } catch (err) {
    const errorText = String(err && err.message || err);
    console.warn('handleSendGeneralMail_ failed: ' + errorText);
    return json_({ error: errorText || 'mail_send_failed' });
  }
}

