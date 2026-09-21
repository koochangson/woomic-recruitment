import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const root = path.resolve(__dirname, '..');
export const adminHtmlSource = path.join(root, 'src', 'admin', 'frontend', 'Dashboard.html');
export const adminGsSource = path.join(root, 'src', 'admin', 'backend', 'Code.gs');
export const publicGsSource = path.join(root, 'src', 'public', 'backend', 'Code.gs');
export const publicPagesDir = path.join(root, 'src', 'public', 'pages');
export const mailTemplatesDir = path.join(root, 'templates', 'mail');
export const configDir = path.join(root, 'config');
export const adminIntermediateDir = path.join(root, 'dist', '.intermediate', 'admin');
export const adminDistDir = path.join(root, 'dist', 'apps-script-admin');
export const publicDistDir = path.join(root, 'dist', 'apps-script-public');
export const referralDistDir = path.join(root, 'dist', 'github-pages', 'referral');
export const referenceDistDir = path.join(root, 'dist', 'github-pages', 'reference-check');
export const previewDistDir = path.join(root, 'dist', 'previews');

export const mailTemplateFiles = [
  ['reference', 'mail_01_reference_candidate_request.html'],
  ['reference', 'mail_02_reference_candidate_reminder.html'],
  ['reference', 'mail_03_reference_referee_request.html'],
  ['reference', 'mail_04_reference_referee_reminder.html'],
  ['reference', 'mail_05_reference_referee_complete.html'],
  ['assets', 'mail_asset_ci_src.html'],
  ['assets', 'mail_asset_header_art_src.html'],
  ['body', 'mail_body_general_notice.html'],
  ['body', 'mail_body_headhunter_forward.html'],
  ['body', 'mail_body_interview_first.html'],
  ['body', 'mail_body_interview_second.html'],
  ['body', 'mail_body_interview_slot_request.html'],
  ['body', 'mail_body_onboarding.html'],
  ['body', 'mail_body_onboarding_internal.html'],
  ['body', 'mail_body_panel_schedule.html'],
  ['body', 'mail_body_rejection.html'],
  ['shared', 'mail_shared_body_close.html'],
  ['shared', 'mail_shared_body_open.html'],
  ['shared', 'mail_shared_contact_qr.html'],
  ['shared', 'mail_shared_footer.html'],
  ['shared', 'mail_shared_header_bottom.html'],
  ['shared', 'mail_shared_header_top.html'],
];

export function mailTemplatePath(group, name) {
  return path.join(mailTemplatesDir, group, name);
}
