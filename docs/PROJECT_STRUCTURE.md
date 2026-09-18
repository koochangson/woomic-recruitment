# 프로젝트 구조 기준

## 현재 실행 관계

### 관리자 화면

`Dashboard_gmail.html` -> `tools/split_dashboard_gmail.js` -> `Dashboard_gmail_split.html`, `app_css.html`, `app_script.html` -> `apps_script_split_upload/Dashboard.html`

Apps Script의 `doGet()`은 `Dashboard` 템플릿을 평가합니다. 이 템플릿은 `app_css`와 `app_script`만 include합니다. `js_*.html`은 원본 JavaScript를 기능 구간으로 재결합하는 검증용 생성물이며 런타임 파일이 아닙니다.

### 관리자 서버

`Code_admin_gmail.gs` -> `tools/split_code_admin_gmail.js` -> `admin_*.gs` -> `apps_script_split_upload/admin_*.gs`

### 공개 서버

`apps_script_referral_security.gs` -> `tools/prepare_apps_script_public_bundle.js` -> `apps_script_public_upload/Code.gs`

공개 HTML은 GitHub Pages에서 공개 Apps Script 배포 URL을 호출합니다.

## 목표 구조

```text
src/admin/frontend/
src/admin/backend/
src/public/backend/
src/public/pages/
src/integrations/interviewer-directory/
templates/mail/
assets/
config/
dist/apps-script-admin/
dist/apps-script-public/
dist/github-pages/
dist/previews/
tools/
scripts/
docs/
```

목표 구조로 이동하기 전까지는 `AGENTS.md`의 현재 원본 경로를 사용합니다. 경로 이동은 빌드와 검증 스크립트를 동시에 변경하고, 기존 결과와의 동등성 검사를 통과한 뒤 적용합니다.
