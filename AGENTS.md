# Claude/Codex 작업 기준

이 저장소는 Claude와 Codex가 번갈아 작업합니다. 작업 전에는 반드시 `git status --short`와 `git log --oneline -5`를 확인하고, 다른 작업자의 미커밋 변경을 덮어쓰지 않습니다.

## 1. 직접 수정하는 원본

- 관리자 화면: `Dashboard_gmail.html`
- 관리자 Apps Script: `Code_admin_gmail.gs`
- 공개 Apps Script: `apps_script_referral_security.gs`
- 공개 화면: `referral_intake.html`, `reference_candidate_intake.html`, `reference_check_intake.html`, `interview_availability.html`
- 면접관 DB Apps Script: `interviewer_db_apps_script_updated.gs`
- 메일 템플릿: `mail_*.html`, `mail_body_*.html`, `mail_shared_*.html`
- 메일 원본 이미지: `woomi-ci.png`, `woomi-mail-header-bg.jpg` 등 이미지 파일
- Apps Script 설정: `appsscript.admin.template.json`, `appsscript.public.template.json`
- 빌드·검사 코드: `tools/**`, `scripts/**`, `package.json`
- 문서: `*.md`, `docs/**`

## 2. 직접 수정하지 않는 생성물

- `Dashboard_gmail_split.html`, `app_css.html`, `app_script.html`
- 루트 `js_*.html`, `admin_*.gs`
- `apps_script_split_upload/**`, `apps_script_public_upload/**`
- `index.html` (`referral_intake.html`의 배포 복사본)
- `mail_samples_preview.html`
- `backups/**`, `backup_*/**`, `*.zip`

생성물은 수동으로 고치지 않습니다. 다음 빌드에서 덮어써집니다.

## 3. 빌드와 검증

```bash
node tools/rebuild_apps_script_split_bundle.js
node scripts/security-scan.mjs
node scripts/syntax-check.mjs
node scripts/deployment-readiness.mjs
```

관리자 화면은 `Dashboard.html`에서 `app_css.html`과 `app_script.html`만 include합니다. 루트의 `js_*.html`은 원본 JS 구간 재결합 검증용이며 Apps Script 업로드 대상이 아닙니다.

## 4. 배포 원칙

- 관리자 프로젝트에는 `apps_script_split_upload/`의 파일만 반영합니다.
- 공개 프로젝트에는 `apps_script_public_upload/`의 파일만 반영합니다.
- 단일본과 분리본을 같은 Apps Script 프로젝트에 동시에 넣지 않습니다.
- `/dev`와 테스트 데이터로 검증한 뒤 기존 운영 배포의 버전만 변경합니다.
- 작업이 끝나면 원본과 생성물을 함께 커밋합니다.

자세한 구조와 파일 관계는 `docs/PROJECT_STRUCTURE.md`를 따릅니다.
