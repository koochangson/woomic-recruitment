# Recruiting Hub 보안 배포 절차

이 문서는 로컬 코드 반영 후 Apps Script/GitHub Pages에 적용할 때의 운영 순서입니다.

## 0. 배포 전 로컬 검사

배포 전 아래 검사를 실행합니다.

```powershell
C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe .\scripts\security-scan.mjs
```

검사 실패 시 공개 토큰, 관리자 URL, 브라우저 OpenAI 호출, `adminToken` URL 전송 패턴이 다시 들어온 것입니다. 배포하지 말고 먼저 제거합니다.

## 1. 직원 DB Apps Script

`src/integrations/interviewer-directory/Code.gs`를 직원/면접관 DB Apps Script 프로젝트에 반영합니다.

Script Properties:

- `INTERVIEWER_DB_ADMIN_TOKEN`: 관리자 전체 조회/일괄 교체용 새 토큰
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 사번 단건 조회 전용 새 토큰

배포 후 확인:

- `lookupEmployeeByEmpNo`는 `lookupToken`이 있을 때만 성공해야 합니다.
- `getInterviewers`, `replaceAll`, `addInterviewer`, `updateInterviewer`, `deleteInterviewer`는 `adminToken`이 없으면 실패해야 합니다.

## 2. 공개 추천 접수 Apps Script

공개 접수 전용 Apps Script 프로젝트에는 `dist/apps-script-public/` 파일을 반영합니다.
원본 설정은 `config/appsscript.public.json`에서 관리합니다.

Script Properties:

- `RECRUITMENT_DEPLOYMENT_ROLE`: `public`
- `REFERRAL_UPLOAD_FOLDER_ID`: 사내추천 이력서를 저장할 비공개 Google Drive 폴더 ID
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 직원 DB와 같은 단건 조회 토큰

공개 프로젝트에는 아래 값을 넣지 않습니다.

- `RECRUITMENT_ADMIN_TOKEN`
- `INTERVIEWER_DB_ADMIN_TOKEN`

배포 후 `src/public/pages/referral/index.html`의 `SCRIPT_URL`을 공개 추천 접수 배포 URL로 교체합니다.
GitHub Pages에 배포되는 `index.html`도 같은 공개 추천 접수 배포 URL을 사용해야 합니다.

## 3. 관리자 Apps Script

관리자 전용 Apps Script 프로젝트에는 `dist/apps-script-admin/` 파일을 반영합니다.
원본 설정은 `config/appsscript.admin.json`에서 관리합니다.

Script Properties:

- `RECRUITMENT_DEPLOYMENT_ROLE`: `admin`
- `REFERRAL_UPLOAD_FOLDER_ID`: 사내추천 이력서를 저장할 비공개 Google Drive 폴더 ID
- `RECRUITMENT_ADMIN_TOKEN`: 새 관리자 토큰
- `RECRUITMENT_LOCAL_ADMIN_USERS`: `사번:SHA-256해시` 형식의 앱 내부 관리자 계정. 기존 `admin:SHA-256해시` 계정도 유지하며 계정은 쉼표 또는 줄바꿈으로 구분
- `RECRUITMENT_ADMIN_SESSION_SECONDS`: 선택값, 최대 6시간
- `OPENAI_API_KEY`: 레퍼런스 AI 요약용 OpenAI API 키
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 직원 DB와 같은 단건 조회 토큰
- `INTERVIEWER_DB_ADMIN_TOKEN`: 전체 직원 DB 동기화가 필요한 경우에만 설정

배포 설정:

- access: `ANYONE_ANONYMOUS`
- executeAs: `USER_DEPLOYING`

Google 로그인 없이 관리자 로그인 화면까지 접근할 수 있지만, 모든 관리자 데이터 API는 앱 내부 로그인 세션이 있어야 실행됩니다. `RECRUITMENT_LOCAL_ADMIN_USERS`와 `RECRUITMENT_ADMIN_TOKEN`이 모두 설정되지 않으면 운영 배포하지 않습니다.

배포 후 `recruitment_dashboard_v4.html`의 관리자용 Google Sheets URL을 관리자 배포 URL로 교체합니다.
관리자 URL은 공개 저장소에 하드코딩하지 않고 설정 탭 또는 사내 전용 배포 설정으로 주입합니다.

## 4. GitHub Pages

- 공개 추천 접수 화면만 공개 Pages에 유지합니다.
- 관리자 대시보드는 공개 저장소/공개 Pages에 배포하지 않는 것을 목표로 합니다.
- GitHub 플랜 때문에 private Pages가 불가능하면 관리자 화면은 사내 인증이 있는 별도 호스팅으로 이전합니다.

## 5. 점검

- 기존 유출 토큰은 재사용하지 않습니다.
- Google Sheets 공유 권한은 피플팀/관리자 그룹으로 제한합니다.
- 이력서 업로드 Drive 폴더 공유 권한을 수동 점검합니다.
- 테스트 업로드 후 생성된 Drive 파일이 링크 공개가 아닌 비공개/제한됨 상태인지 확인합니다.
- 기존 관리자 PC에서 대시보드 1회 접속 후 `woomic_settings`의 과거 `openaiKey`가 제거됐는지 확인합니다.
- `_Changes` 시트에 `actorEmail`, `result` 컬럼이 생성되는지 확인합니다.

## 6. 개인정보/AI 승인 체크

레퍼런스 AI 요약을 켜기 전에 아래를 승인받습니다.

- 레퍼런스 원문과 후보자 관련 정보가 OpenAI API로 전송될 수 있음을 피플팀/개인정보 담당자가 승인
- `OPENAI_API_KEY`는 관리자 Apps Script Script Properties에만 저장
- 브라우저 localStorage, Google Sheets Settings, GitHub 저장소에는 OpenAI API 키 저장 금지
- AI 요약 결과는 보조 자료로만 사용하고 최종 판단 전 사람이 원문과 대조
- 필요 시 개인정보 처리방침/후보자 및 추천인 안내 문구에 AI 처리 여부 반영
