# Claude/Codex 작업 기준

이 저장소는 Claude와 Codex가 번갈아 작업합니다. 작업 전에는 반드시 `git status --short`와 `git log --oneline -5`를 확인하고, 다른 작업자의 미커밋 변경을 덮어쓰지 않습니다.

## 1. 직접 수정하는 원본

- 관리자 화면 마크업: `src/admin/frontend/Dashboard.html`
- 관리자 화면 스타일: `src/admin/frontend/app_css.html`
- 관리자 화면 기능: `src/admin/frontend/js/js_*.html`
- 관리자 Apps Script: `src/admin/backend/Code.gs`
- 공개 Apps Script: `src/public/backend/Code.gs`
- 관리자·공개 공통 Apps Script: `src/shared/backend/shared_00_runtime.gs`
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
node scripts/test-backend.mjs     # 서버 함수 동작(로그인 해시·메일 중복 방지·추천인 등록·변경 이력 커서)
node scripts/test-row-sync.mjs    # 입사·처우 기록 두 PC 동시 수정 병합
node scripts/check-backend-drift.mjs  # 관리자·공개 Code.gs 같은 이름 함수 어긋남
node scripts/test-deployment-parts.mjs  # 업로드 묶음 일부만 올렸을 때 감지(admin_98_build_manifest.gs)
```

관리자·공개 `Code.gs`에 같은 이름으로 있는 함수는 내용이 같아야 합니다. 한쪽을 고치면 다른 쪽도 같이 고칩니다. 의도적으로 다른 함수는 `config/backend-divergence.json`에 이유와 함께 등록되어 있으며, 그 함수를 고친 뒤에는 다른 쪽도 맞춰야 하는지 확인하고 `node scripts/check-backend-drift.mjs --update`로 지문을 갱신합니다.

`npm run check`가 위 검사를 모두 실행하며 GitHub Actions에서도 같은 명령을 씁니다. 서버 함수나 줄 동기화 규칙을 바꾸면 해당 테스트도 함께 고칩니다.

관리자 화면은 `Dashboard.html`에서 `app_css.html`과 기능별 JavaScript 모듈 13개를 순서대로 include합니다. 파일 순서는 `tools/project_paths.js`의 `adminJsFiles`를 단일 기준으로 사용하며, 빌드 결과인 `dist/**`는 직접 수정하지 않습니다.

## 4. 배포 원칙

- 관리자 프로젝트에는 `dist/apps-script-admin/`의 파일만 반영합니다.
- 공개 프로젝트에는 `dist/apps-script-public/`의 파일만 반영합니다.
- 단일본과 분리본을 같은 Apps Script 프로젝트에 동시에 넣지 않습니다.
- `/dev`와 테스트 데이터로 검증한 뒤 기존 운영 배포의 버전만 변경합니다.
- 작업이 끝나면 원본과 생성물을 함께 커밋합니다.

자세한 구조와 파일 관계는 `docs/PROJECT_STRUCTURE.md`를 따릅니다.

## 5. 화면 알림(우측 상단 toast) 기준

우측 상단 알림은 화면 자체로는 알 수 없는 것만 알립니다. 구현은 `js_03_ui_dashboard.html`의 `toast()`에 있으며, 아래 기준을 함수가 강제합니다.

오류·경고·이벤트 알림은 누르거나 ×를 누를 때까지 유지되고, 완료(3초)·안내(4초)는 저절로 사라집니다(마우스를 올리면 유지).

| 종류 | 호출 | 표시 | 언제 쓰는가 |
|---|---|---|---|
| 오류 | `toast(msg, 'terr')` | 누를 때까지 | 작업이 막혔거나 실패함. 무엇이 안 됐는지와 사용자가 할 일(필수 입력 누락 포함) |
| 경고 | `toast(msg, 'tw')` | 누를 때까지 | 작업은 됐지만 일부 실패·지연·재시도 중이거나 주의할 점이 있음. 가능하면 다음 할 일을 함께 적는다 |
| 안내 | `toast(msg, 'tinfo')` | 4초 후 자동 | 할 일이 없거나 이미 된 상태(보낼 대상 없음, 이미 등록됨, 작업 중이라 닫을 수 없음). 주황 경고와 구분 |
| 완료 | `toast(msg, 'tok')` | 3초 후 자동 | 창이 닫히거나 화면이 바뀌지 않아 결과가 보이지 않을 때만 |
| 이벤트 | `toast(msg, 'tok', { sticky:true, onClick })` | 누를 때까지(누르면 해당 작업으로 이동) | 다른 사람이 한 일(면접관·지원자 회신 등). 누르면 해당 작업으로 이동 |

- 처리 중(진행) 상황은 알림으로 띄우지 않습니다. 누른 버튼("처리 중…"), 진행창, 창 안의 상태 문구로 보여 줍니다. `toast()`는 '…중입니다/중…'으로 끝나는 완료·정보 알림을 무시합니다.
- 창(진행창 포함)이 이미 같은 결과를 보여 주면 완료 알림을 띄우지 않습니다.
- 같은 문구는 쌓지 않고 맨 아래(최신)로 옮기며, 최대 5개까지 표시합니다. 넘치면 가장 오래된 일반 알림부터 정리하고 이벤트 알림은 유지합니다. 알림은 열린 창보다 위 레이어(z-index 10050)에 표시됩니다.
- 오류 문구는 "무엇이 안 됐는지 + 다음 할 일"로 씁니다(예: "…를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요."). 서버 오류 코드, 영문 오류, 내부 id를 그대로 보여 주지 않고 `friendlyError_(오류, 기본 안내)`로 바꿔 표시합니다. 새 서버 오류 코드를 만들면 `js_00_core.html`의 `FRIENDLY_ERRORS_`에 한국어 안내를 함께 추가합니다.
- "대상이 없습니다"처럼 할 일이 없는 상황은 오류가 아니라 안내(`tinfo`)입니다. 먼저 해야 할 일이 있으면(예: 일정을 먼저 확정) 오류로 쓰고 그 할 일을 적습니다.
- 입력값 확인 오류는 `toast` 대신 `fieldError_(칸 id 또는 선택자, 문구)`를 씁니다. 해당 칸에 빨간 테두리와 커서가 가고, 고치기 시작하면 표시가 사라집니다. 여러 칸을 한 번에 검사할 때는 "필수값을 입력하세요"처럼 묶지 말고 비어 있는 첫 칸을 이름으로 알려 줍니다.
- 알림 문구는 "~해 주세요."로 끝맺고, 이름 뒤 조사는 `josa_(이름, '을', '를')`처럼 받침에 맞춰 붙입니다("을(를)" 금지).

## 6. 여러 기기 동시 작업(버전 충돌) 기준

- 지원자·면접·포지션(`Candidates`·`Interviews`·`Positions`)은 행마다 `rev`로 버전을 관리합니다. 시트에서 행을 읽는 모든 경로(전체 로드, 변경 감지, 단건 로드)는 반드시 `rev`를 포함한 공용 변환(`normalizeGsCandidate`·`normalizeGsInterview`·`normalizeGsPosition`)을 씁니다. 전용 변환을 새로 만들지 않습니다.
- 입사 등록·처우 기록(`Onboardings`·`Offers`)도 행마다 `rev`가 있습니다. 이 둘은 `js_07_state`의 줄 동기화(`flushRowSync_`)가 저장하며, 충돌 시 마지막으로 서버와 맞춘 내용(snapshot)을 base로 같은 규칙으로 병합합니다(`mergeRowSyncRecord_`). `batchUpsert` 응답의 `revs`로 새 rev를 받습니다.
- 레퍼런스 결과 정리(`RefReports`)와 알림·활동 기록(`NotifyLog`·`ActivityLog`)도 같은 줄 동기화로 저장합니다. 알림·활동 기록은 추가만 하는 최신순 목록이며 최대 200/300개를 넘거나 보존기간이 지나 화면에서 빠진 기록은 시트에서도 지워집니다. 설정 시트의 보조 데이터 덩어리(auxState)에는 추천인 응답 사본(`refDetails`)만 남습니다.
- 기기마다 마지막으로 받은 서버본(base)을 `woomic_gs_base_v1`에 기억합니다. 서버 행을 받는 새 경로를 추가하면 `rememberGsBaseRows_`를 호출합니다.
- 저장 시 버전 충돌이 나면 `gsUpsert`가 자동 병합 후 재저장합니다: base 대비 이 기기가 바꾼 필드는 이 기기 값, 나머지는 서버 최신값. 같은 필드를 양쪽이 바꾼 경우 나중 저장이 반영됩니다. 화면별로 충돌 처리 코드를 따로 두지 않습니다.
- base가 없는 기기(배포 직후 첫 접속)는 첫 동기화를 전체 로드로 진행해 base를 채웁니다.

## 7. 화면 즉시 반영 기준

- 로컬 데이터가 바뀌면(`saveState`) `scheduleViewRefresh_`가 대시보드·사이드바 배지·현재 화면·열린 포지션 상세를 한 번에 다시 그립니다. 처리 함수마다 다시 그릴 화면을 챙기지 않아도 됩니다.
- 새 처리 기능은 데이터 변경 후 `saveState()`(또는 `sync*ToGS`)만 호출하면 화면에 즉시 반영됩니다. 화면에만 있고 `saveState` 대상이 아닌 값(예: 면접관 회신 캐시)은 해당 기능에서 직접 다시 그립니다.
- 화면(.sect) 안 입력칸에 입력 중이면 포커스가 빠질 때까지 다시 그리기를 미룹니다.

## 8. 종료 포지션 기준

- 충원완료·부분충원 마감·미채용·채용중단 포지션은 남은 지원자와 메일 발송 실패 건까지 모두 종료로 봅니다. 처리 필요 목록·포지션 처리 안내·재발송 필요 항목을 만들지 않습니다.
- 계속 진행하려면 포지션을 진행중으로 복원하거나(보류 지원자 재개 선택) 지원자를 다른 포지션으로 옮깁니다. 종료 시 발송 실패자는 알림에 이름을 보여 개별 안내할 수 있게 합니다.
