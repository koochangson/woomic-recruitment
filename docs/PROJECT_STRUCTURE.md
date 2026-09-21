# 프로젝트 구조 기준

## 현재 실행 관계

### 관리자 화면

`src/admin/frontend/Dashboard.html` -> `tools/split_dashboard_gmail.js` -> `dist/.intermediate/admin/*` -> `dist/apps-script-admin/Dashboard.html`

Apps Script의 `doGet()`은 `Dashboard` 템플릿을 평가합니다. 이 템플릿은 `app_css`와 `app_script`만 include합니다. `js_*.html`은 원본 JavaScript를 기능 구간으로 재결합하는 검증용 생성물이며 런타임 파일이 아닙니다.

### 관리자 서버

`src/admin/backend/Code.gs` -> `tools/split_code_admin_gmail.js` -> `dist/.intermediate/admin/admin_*.gs` -> `dist/apps-script-admin/admin_*.gs`

### 공개 서버

`src/public/backend/Code.gs` -> `tools/prepare_apps_script_public_bundle.js` -> `dist/apps-script-public/Code.gs`

공개 HTML은 GitHub Pages에서 공개 Apps Script 배포 URL을 호출합니다.

## 표준 구조

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

AI는 `src/**`, `templates/**`, `config/**`, `tools/**`, `scripts/**`, `docs/**`만 직접 수정합니다. `dist/**`는 빌드 결과이므로 직접 수정하지 않습니다.
