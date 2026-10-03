# Claude/Codex 작업 기준

이 저장소는 Claude와 Codex가 번갈아 작업합니다. 작업 전에는 반드시 `git status --short`와 `git log --oneline -5`를 확인하고, 다른 작업자의 미커밋 변경을 덮어쓰지 않습니다.

## 1. 직접 수정하는 원본

- 관리자 화면 마크업: `src/admin/frontend/Dashboard.html`
- 관리자 화면 스타일: `src/admin/frontend/app_css.html`
- 관리자 화면 기능: `src/admin/frontend/js/js_*.html`
- 관리자 Apps Script: `src/admin/backend/Code.gs`
- 공개 Apps Script: `src/public/backend/Code.gs`
- 공개 화면: `src/public/pages/**`
- 면접관 DB Apps Script: `src/integrations/interviewer-directory/Code.gs`
- 메일 템플릿: `templates/mail/**`
- 메일 원본 이미지: `woomi-ci.png`, `woomi-mail-header-bg.jpg` 등 이미지 파일
- Apps Script 설정: `config/appsscript.admin.json`, `config/appsscript.public.json`
- 빌드·검사 코드: `tools/**`, `scripts/**`, `package.json`
- 문서: `*.md`, `docs/**`

## 2. 직접 수정하지 않는 생성물

- `dist/**`
- `backups/**`, `backup_*/**`, `*.zip`

생성물은 수동으로 고치지 않습니다. 다음 빌드에서 덮어써집니다.

## 3. 빌드와 검증

```bash
node tools/rebuild_apps_script_split_bundle.js
node scripts/security-scan.mjs
node scripts/syntax-check.mjs
node scripts/deployment-readiness.mjs
```

관리자 화면은 `Dashboard.html`에서 `app_css.html`과 기능별 JavaScript 모듈 8개를 순서대로 include합니다. 파일 순서는 `tools/project_paths.js`의 `adminJsFiles`를 단일 기준으로 사용하며, 빌드 결과인 `dist/**`는 직접 수정하지 않습니다.

## 4. 배포 원칙

- 관리자 프로젝트에는 `dist/apps-script-admin/`의 파일만 반영합니다.
- 공개 프로젝트에는 `dist/apps-script-public/`의 파일만 반영합니다.
- 단일본과 분리본을 같은 Apps Script 프로젝트에 동시에 넣지 않습니다.
- `/dev`와 테스트 데이터로 검증한 뒤 기존 운영 배포의 버전만 변경합니다.
- 작업이 끝나면 원본과 생성물을 함께 커밋합니다.

자세한 구조와 파일 관계는 `docs/PROJECT_STRUCTURE.md`를 따릅니다.

## 5. 화면 알림(우측 상단 toast) 기준

우측 상단 알림은 화면 자체로는 알 수 없는 것만 알립니다. 구현은 `js_03_ui_dashboard.html`의 `toast()`에 있으며, 아래 기준을 함수가 강제합니다.

| 종류 | 호출 | 표시 시간 | 언제 쓰는가 |
|---|---|---|---|
| 오류 | `toast(msg, 'terr')` | 8초 (마우스를 올리면 유지) | 작업이 막혔거나 실패함. 무엇이 안 됐는지와 사용자가 할 일(필수 입력 누락 포함) |
| 경고 | `toast(msg, 'tw')` | 6초 | 작업은 됐지만 일부 실패·지연·재시도 중이거나 주의할 점이 있음. 가능하면 다음 할 일을 함께 적는다 |
| 안내 | `toast(msg, 'tinfo')` | 4초 | 할 일이 없거나 이미 된 상태(보낼 대상 없음, 이미 등록됨, 작업 중이라 닫을 수 없음). 주황 경고와 구분 |
| 완료 | `toast(msg, 'tok')` | 3초 | 창이 닫히거나 화면이 바뀌지 않아 결과가 보이지 않을 때만 |
| 이벤트 | `toast(msg, 'tok', { sticky:true, onClick })` | 직접 닫을 때까지 | 다른 사람이 한 일(면접관·지원자 회신 등). 누르면 해당 작업으로 이동 |

- 처리 중(진행) 상황은 알림으로 띄우지 않습니다. 누른 버튼("처리 중…"), 진행창, 창 안의 상태 문구로 보여 줍니다. `toast()`는 '…중입니다/중…'으로 끝나는 완료·정보 알림을 무시합니다.
- 창(진행창 포함)이 이미 같은 결과를 보여 주면 완료 알림을 띄우지 않습니다.
- 같은 문구는 쌓지 않고 시간만 연장하며, 최대 4개까지만 표시합니다. 알림은 열린 창보다 위 레이어(z-index 10050)에 표시됩니다.
- 오류 문구는 "무엇이 안 됐는지 + 다음 할 일"로 씁니다(예: "…를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요."). 서버 오류 코드, 영문 오류, 내부 id를 그대로 보여 주지 않고 `friendlyError_(오류, 기본 안내)`로 바꿔 표시합니다. 새 서버 오류 코드를 만들면 `js_00_core.html`의 `FRIENDLY_ERRORS_`에 한국어 안내를 함께 추가합니다.
- "대상이 없습니다"처럼 할 일이 없는 상황은 오류가 아니라 안내(`tinfo`)입니다. 먼저 해야 할 일이 있으면(예: 일정을 먼저 확정) 오류로 쓰고 그 할 일을 적습니다.
- 입력값 확인 오류는 `toast` 대신 `fieldError_(칸 id 또는 선택자, 문구)`를 씁니다. 해당 칸에 빨간 테두리와 커서가 가고, 고치기 시작하면 표시가 사라집니다. 여러 칸을 한 번에 검사할 때는 "필수값을 입력하세요"처럼 묶지 말고 비어 있는 첫 칸을 이름으로 알려 줍니다.
- 알림 문구는 "~해 주세요."로 끝맺고, 이름 뒤 조사는 `josa_(이름, '을', '를')`처럼 받침에 맞춰 붙입니다("을(를)" 금지).
