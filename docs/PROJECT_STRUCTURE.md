# 프로젝트 구조 기준

## 현재 실행 관계

### 관리자 화면

`src/admin/frontend/{Dashboard.html, app_css.html, js/*.html}` -> `tools/prepare_admin_frontend.js` -> `dist/.intermediate/admin/*` -> `dist/apps-script-admin/*`

Apps Script의 `doGet()`은 `Dashboard` 템플릿을 평가합니다. 이 템플릿은 `app_css`와 기능별 JavaScript 모듈 13개를 include합니다. 모듈은 실제 런타임 파일이며 `tools/project_paths.js`의 `adminJsFiles` 순서대로 합쳐져 구문 검사를 통과해야 합니다.

### 관리자 서버

`src/shared/backend/shared_00_runtime.gs` + `src/admin/backend/Code.gs` -> `tools/split_code_admin_gmail.js` -> `dist/.intermediate/admin/*` -> `dist/apps-script-admin/*`

### 공개 서버

`src/shared/backend/shared_00_runtime.gs` + `src/public/backend/Code.gs` -> `tools/prepare_apps_script_public_bundle.js` -> `dist/apps-script-public/*`

공개 HTML은 GitHub Pages에서 공개 Apps Script 배포 URL을 호출합니다.

`shared_00_runtime.gs`는 헤더·행 변환, 변경 로그와 커서, 실행 단위 스프레드시트 캐시 등 관리자·공개 배포가 같은 규칙으로 사용해야 하는 기반 함수의 단일 원본입니다. 권한, 라우팅, 메일 발송과 배포별 시트 선택은 각 `Code.gs`에 둡니다.

## 표준 구조

```text
src/admin/frontend/
src/admin/frontend/js/
src/admin/backend/
src/shared/backend/
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
