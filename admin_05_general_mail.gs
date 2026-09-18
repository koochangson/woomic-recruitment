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

function loadMailAsset_(fileName) {
  return loadMailFragment_(fileName).trim();
}

function nlToBr_(value) {
  return escapeMailHtml_(value).replace(/\n/g, '<br>');
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
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 9월 22일 화요일 14:00/g, escapeMailHtml_(data.interviewDateTime || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''));
  } else if (templateKey === 'interview_second') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 9월 29일 화요일 10:00/g, escapeMailHtml_(data.interviewDateTime || ''))
      .replace(/본사 5층 임원회의실/g, escapeMailHtml_(data.location || ''));
  } else if (templateKey === 'panel_schedule') {
    rendered = rendered
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/1차 실무면접/g, escapeMailHtml_(data.interviewType || ''))
      .replace(/2026년 9월 22일 화요일 14:00~17:00/g, escapeMailHtml_(data.scheduleText || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''))
      .replace(/총 4명/g, '총 ' + escapeMailHtml_(String(data.targetCount || '')) + '명')
      .replace(/김민준 팀장, 박서연 과장/g, escapeMailHtml_(data.panelNames || ''))
      .replace(/이하늘 \(홍보 포지션\)<br>최지우 \(홍보 포지션\)/, nlToBr_(data.targetList || ''));
  } else if (templateKey === 'onboarding') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/2026년 10월 5일/g, escapeMailHtml_(data.joinDate || ''))
      .replace(/09:00/g, escapeMailHtml_(data.joinTime || '09:00'))
      .replace(/본사 3층 피플팀/g, escapeMailHtml_(data.reportLocation || '본사 3층 피플팀'))
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/주임/g, escapeMailHtml_(data.rank || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/본사/g, escapeMailHtml_(data.location || ''))
      .replace(/- 신분증 지참<br>- 계좌사본 제출/, nlToBr_(data.prepNotes || ''));
  } else if (templateKey === 'onboarding_internal') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/홍보팀/g, escapeMailHtml_(data.dept || ''))
      .replace(/2026년 10월 5일/g, escapeMailHtml_(data.joinDate || ''))
      .replace(/주임/g, escapeMailHtml_(data.rank || ''))
      .replace(/정규직/g, escapeMailHtml_(data.etype || ''))
      .replace(/본사/g, escapeMailHtml_(data.location || ''))
      .replace(/010-1234-5678/g, escapeMailHtml_(data.phone || ''))
      .replace(/2026년 9월 30일까지/g, escapeMailHtml_(data.replyDeadline || ''))
      .replace(/09:00 피플팀 방문 → 10:00 부서 배치/g, escapeMailHtml_(data.joinDaySchedule || ''))
      .replace(/- 좌석 배정<br>- 사원증 발급 요청/, nlToBr_(data.deptCooperation || ''));
    const workLocation = String(data.location || data.workplace || data.site || '');
    if (!/현장|공사|사업소|프로젝트|PJ/i.test(workLocation)) {
      rendered = rendered.replace(/<tr id="siteOnboardingRequestRow">[\s\S]*?<\/tr>/, '');
    }
  } else if (templateKey === 'rejection') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText));
  } else if (templateKey === 'interview_slot_request') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/1차 실무면접/g, escapeMailHtml_(data.interviewType || ''))
      .replace(/1\. 9월 22일\(화\) 오전·오후<br>2\. 9월 23일\(수\) 오전<br>3\. 9월 24일\(목\) 오후/, nlToBr_(data.slotOptions || ''))
      .replace(/본사 3층 대회의실/g, escapeMailHtml_(data.location || ''))
      .replace(/2026년 9월 20일/g, escapeMailHtml_(data.responseDeadline || ''))
      .replace(/INTERVIEW_AVAILABILITY_URL/g, escapeMailHtml_(data.availabilityLink || '#'));
  } else if (templateKey === 'headhunter_forward') {
    rendered = rendered
      .replace(/헤드헌팅 담당자/g, escapeMailHtml_(data.recipientName || '헤드헌팅 담당자'))
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/채용 진행/g, escapeMailHtml_(data.purpose || '채용 진행'))
      .replace(/후보자에게 전달할 내용이 표시됩니다\./, nlToBr_(data.forwardBody || data.body || ''));
  } else if (templateKey === 'general_notice') {
    rendered = rendered
      .replace(/이하늘/g, escapeMailHtml_(candidateName))
      .replace(/홍보 포지션/g, escapeMailHtml_(positionText))
      .replace(/채용 진행 안내 내용이 표시됩니다\./, nlToBr_(data.noticeBody || data.body || ''));
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
    const result = sendMailViaGmail_(to, subject, message, html);
    if (!result.ok) throw new Error(result.error || 'mail_send_failed');
    return json_({ ok: true, to: to });
  } catch (err) {
    console.warn('handleSendGeneralMail_ failed: ' + String(err && err.message || err));
    return json_({ error: 'mail_send_failed' });
  }
}

