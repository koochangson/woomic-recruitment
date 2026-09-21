# Apps Script Split Upload Set

이 폴더는 Apps Script 관리자 웹앱 반영용 파일 세트입니다.

## 넣는 파일

이 폴더 안의 파일을 Apps Script 프로젝트에 추가합니다.

## 넣지 않는 파일

원본 `src/admin/backend/Code.gs`, `src/admin/frontend/Dashboard.html`과 이전에 생성된 `js_*.html`은 이 세트와 동시에 두지 않습니다.

화면 JavaScript는 `app_script.html` 하나에 포함됩니다. `js_*.html`은 소스 구간 검증용 생성물이며 런타임 include 대상이 아닙니다.

## 진입 파일

- 서버: `admin_00_core.gs`의 `doGet()`
- 화면: `Dashboard.html`

## 운영 반영

1. 테스트 배포(/dev)에서 먼저 확인합니다.
2. 테스트 기간에는 운영 시트와 실제 지원자 메일 발송을 피합니다.
3. 검증 후 새 버전을 만들고, 기존 운영 배포를 편집해서 버전만 변경합니다.

## 파일 수

총 37개 파일입니다.
