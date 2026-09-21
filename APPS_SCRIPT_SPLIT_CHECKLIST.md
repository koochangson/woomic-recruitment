# Apps Script 분리 반영 체크리스트

이 분리본은 기존 단일 파일 구조를 Apps Script `include()` 구조로 나눈 버전입니다.

## 0. 로컬 재생성

분리 파일과 `dist` 업로드 세트를 다시 만들 때는 아래 명령을 실행합니다.

```bash
node tools/rebuild_apps_script_split_bundle.js
```

이 명령은 화면 분리, 메일 asset 분리, 서버 분리, 업로드 폴더 생성, 누락 파일 검사를 한 번에 수행합니다.

## 1. 관리자 화면 HTML

Apps Script 편집기에 아래 HTML 파일을 추가합니다.

- `Dashboard.html`
- `app_css.html`
- `js_00_core.html`
- `js_01_sheets_sync.html`
- `js_02_positions_interviews.html`
- `js_03_ui_dashboard.html`
- `js_04_referral.html`
- `js_05_candidates_reference.html`
- `js_06_onboarding_settings.html`
- `js_99_app.html`

`Dashboard.html`이 진입 파일이며 `app_css.html`과 위 JavaScript 모듈 8개를 `include()`로 합칩니다. 업로드용 `app_css.html`은 `<style>` 태그를, 각 `js_*.html`은 `<script>` 태그를 자체 포함합니다. 파일명은 Apps Script 편집기에서 자동으로 붙는 `.html` 확장자를 제외한 이름으로 표시될 수 있습니다.

## 2. 메일 템플릿 HTML

메일 발송 템플릿도 Apps Script 파일로 함께 추가합니다.

- `mail_*.html`
- `mail_body_*.html`
- `mail_shared_*.html`
- `mail_asset_ci_src.html`
- `mail_asset_header_art_src.html`

`mail_asset_*` 파일은 메일 헤더 CI와 배경 이미지 data URI입니다.

## 3. 서버 GS

분리 구조를 사용할 때는 아래 `admin_*.gs` 파일을 추가합니다.

- `admin_00_core.gs`
- `admin_01_mail_base.gs`
- `admin_02_sheet_api.gs`
- `admin_03_referral_public.gs`
- `admin_04_reference.gs`
- `admin_05_general_mail.gs`
- `admin_06_ai_referral_directory.gs`
- `admin_07_sheet_utils.gs`
- `admin_08_referral_tokens.gs`
- `admin_09_auth.gs`
- `admin_99_admin_api.gs`

중요: 원본 단일 서버 파일 `src/admin/backend/Code.gs`와 위 `admin_*.gs` 파일을 Apps Script 안에 동시에 두지 않습니다. 동시에 두면 같은 함수와 상수가 중복 정의됩니다.

## 4. 운영 반영 순서

1. 운영 배포가 특정 버전 번호에 고정되어 있는지 확인합니다.
2. `/dev` 테스트에서 테스트용 시트와 테스트 수신자만 사용합니다.
3. 콘솔 오류, 로그인, 지원자 조회, 포지션 저장, 메일 미리보기, 메일 테스트 발송을 확인합니다.
4. 이상이 없으면 새 버전을 만듭니다.
5. `새 배포`가 아니라 기존 운영 배포를 편집해서 버전만 변경합니다.

## 5. 검증 결과

로컬 분리 검증 결과:

- `src/admin/frontend/Dashboard.html`, `app_css.html`, `js/*.html`은 각각 같은 이름의 업로드 파일과 동일합니다.
- 기능별 JavaScript 모듈 8개를 include 순서대로 합친 결과가 구문 검사를 통과했습니다.
- 분리된 `admin_*.gs`를 순서대로 합치면 `src/admin/backend/Code.gs`와 동일합니다.
- 분리된 JS와 GS 모두 구문 검사를 통과했습니다.
