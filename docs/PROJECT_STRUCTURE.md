# 프로젝트 구조 기준

## 현재 실행 관계

### 관리자 화면

`src/admin/frontend/{Dashboard.html, app_css.html, js/*.html}` -> `tools/prepare_admin_frontend.js` -> `dist/.intermediate/admin/*` -> `dist/apps-script-admin/*`

Apps Script의 `doGet()`은 `Dashboard` 템플릿을 평가합니다. 이 템플릿은 `app_css`와 기능별 JavaScript 모듈 13개를 include합니다. 모듈은 실제 런타임 파일이며 `tools/project_paths.js`의 `adminJsFiles` 순서대로 합쳐져 구문 검사를 통과해야 합니다.

### 관리자 서버

`src/shared/backend/shared_00_runtime.gs` + `src/admin/backend/Code.gs` -> `tools/split_code_admin_gmail.js` -> `dist/.intermediate/admin/*` -> `dist/apps-script-admin/*`

`tools/prepare_apps_script_split_bundle.js`가 업로드 목록(`UPLOAD_FILES.txt`)과 지문 목록(`admin_98_build_manifest.gs`, `tools/build_manifest.js`)을 함께 만듭니다. clasp 반영은 `tools/sync_admin_clasp.js`(관리자)와 `tools/sync_public_clasp.js`(공개)가 하며, 서로 상대 프로젝트 폴더에는 쓰지 않습니다.

### 공개 서버

`src/shared/backend/shared_00_runtime.gs` + `src/public/backend/Code.gs` -> `tools/prepare_apps_script_public_bundle.js` -> `dist/apps-script-public/*`

공개 HTML은 GitHub Pages에서 공개 Apps Script 배포 URL을 호출합니다.

`shared_00_runtime.gs`는 관리자·공개 배포가 같은 내용으로 쓰는 함수의 단일 원본입니다. 앞부분은 헤더·행 변환, 변경 로그와 커서, 실행 단위 캐시 같은 기반 함수이고, 뒷부분("관리자·공개 공통 처리")은 공개 페이지 회신 처리·시트 API·사내추천 인증처럼 두 `Code.gs`에 같은 사본으로 있던 함수입니다. 권한, 라우팅, 메일 발송 방식과 배포별 시트 선택처럼 배포마다 달라야 하는 함수만 각 `Code.gs`에 두며, 두 파일에 같은 이름으로 있는 함수는 `config/backend-divergence.json`에 이유가 등록된 것뿐입니다.

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
