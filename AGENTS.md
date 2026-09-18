# 작업 기준 (Claude ↔ Codex 공용)

이 저장소는 Claude와 Codex가 번갈아 작업합니다. 아래 규칙은 둘 다 지킵니다.

## 1. 원본은 두 파일뿐입니다

- `Dashboard_gmail.html` (관리자 화면 전체 — CSS+HTML+JS 단일 파일)
- `Code_admin_gmail.gs` (Apps Script 서버 전체)

**수정은 이 두 파일에만 합니다.**

## 2. `apps_script_split_upload/`는 빌드 결과물입니다 — 직접 고치지 않습니다

이 폴더(그리고 루트에 있는 `app_script.html`, `app_css.html`, `admin_00_core.gs`~`admin_99_admin_api.gs`, `js_00_state.html`~`js_99_app.html`, `Dashboard_gmail_split.html`)는 전부 위 두 원본 파일에서 자동 생성됩니다.

```bash
node tools/rebuild_apps_script_split_bundle.js
```

이 스크립트가 화면 분리, 메일 asset 분리, 서버 분리, 업로드 폴더 생성, 누락 파일 검사를 전부 수행합니다.

**`apps_script_split_upload/` 안의 파일이나 `js_*.html`/`admin_*.gs`를 직접 편집하지 마세요.** 다음에 누군가 원본을 고치고 이 스크립트를 다시 돌리면 그 자리에서 덮어써져 조용히 사라집니다.

작업 순서:
1. `Dashboard_gmail.html` 또는 `Code_admin_gmail.gs`를 수정
2. `node tools/rebuild_apps_script_split_bundle.js` 실행
3. `apps_script_split_upload/`가 새로 생성됨 → 그걸 Apps Script 프로젝트에 업로드

Apps Script 프로젝트에는 통합본(`Code_admin_gmail.gs`, `Dashboard_gmail.html`)과 분리본(`admin_*.gs`, `js_*.html`, `Dashboard_gmail_split.html`)을 **동시에 넣지 않습니다** — 같은 함수·상수가 중복 정의되어 로드가 깨집니다. 자세한 배포 순서는 `APPS_SCRIPT_SPLIT_CHECKLIST.md` 참고.

## 3. 세션을 넘길 때는 커밋합니다

이 저장소는 이제 git으로 추적됩니다. Claude든 Codex든 작업을 마치면 커밋하고, 다음 세션(다른 쪽 도구)은 시작할 때 `git log`/`git diff`로 그 사이에 뭐가 바뀌었는지 먼저 확인합니다. 파일 수정시각만 보고 추측하지 않습니다.

## 4. 참고 문서

- `APPS_SCRIPT_SPLIT_CHECKLIST.md` — 분리본 배포 절차
- `SECURITY_DEPLOYMENT_STEPS.md` / `SECURITY_RUNBOOK.md` / `GITHUB_SECURITY_SETTINGS.md` — 보안 관련 배포 규칙
