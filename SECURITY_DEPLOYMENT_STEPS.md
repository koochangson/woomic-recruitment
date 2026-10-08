# Recruiting Hub 보안 배포 절차

이 문서는 로컬 코드 반영 후 Apps Script/GitHub Pages에 적용할 때의 운영 순서입니다.

## 0. 배포 전 로컬 검사

배포 전 아래 검사를 실행합니다.

```powershell
npm run check
```

`npm run check`는 보안 검사(`scripts/security-scan.mjs`), 접근성·구문·배포 설정 검사, 관리자·공개 백엔드 어긋남 검사와 서버 테스트를 함께 실행합니다. 보안 검사가 실패하면 공개 토큰, 관리자 URL, 브라우저 OpenAI 호출, `adminToken` URL 전송 패턴이 다시 들어온 것입니다. 배포하지 말고 먼저 제거합니다.

## 1. 직원 DB Apps Script

`src/integrations/interviewer-directory/Code.gs`를 직원/면접관 DB Apps Script 프로젝트에 반영합니다.

Script Properties:

- `INTERVIEWER_DB_ADMIN_TOKEN`: 관리자 전체 조회/일괄 교체용 새 토큰
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 사번 단건 조회 전용 새 토큰

배포 후 확인:

- `lookupEmployeeByEmpNo`는 `lookupToken`이 있을 때만 성공해야 합니다.
- `getInterviewers`, `replaceAll`, `addInterviewer`, `updateInterviewer`, `deleteInterviewer`는 `adminToken`이 없으면 실패해야 합니다.

## 2. 공개 Apps Script

사내추천 접수, 레퍼런스 체크(지원자 추천인 등록·추천인 응답), 면접 가능 일정 회신, 입사일 회신 페이지가 모두 이 공개 프로젝트를 호출합니다.
공개 Apps Script 프로젝트에는 `dist/apps-script-public/`의 `Code.gs`,
`shared_00_runtime.gs`, `appsscript.json`을 함께 반영합니다.
원본 설정은 `config/appsscript.public.json`에서 관리합니다.

Script Properties:

- `RECRUITMENT_DEPLOYMENT_ROLE`: `public`(이 값이어야 관리자 액션이 차단됩니다)
- `RECRUITMENT_SPREADSHEET_URL`: 관리자 프로젝트와 같은 채용 데이터 시트 URL. 프로젝트가 그 시트에 연결(bound)되어 있지 않으면 필수
- `REFERRAL_UPLOAD_FOLDER_ID`: 사내추천 이력서를 저장할 비공개 Google Drive 폴더 ID
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 직원 DB와 같은 단건 조회 토큰
- 선택값: `REFERENCE_CANDIDATE_PAGE_URL`, `REFERENCE_RESPONSE_PAGE_URL`, `INTERVIEW_AVAILABILITY_PAGE_URL`(메일 속 페이지 주소를 바꿀 때만), `WOOMI_CI_URL`, `KAKAO_CHANNEL_URL`, `KAKAO_QR_URL`(공개 메일의 이미지·채널 주소를 바꿀 때만)

공개 프로젝트에는 아래 값을 넣지 않습니다.

- `RECRUITMENT_ADMIN_TOKEN`
- `INTERVIEWER_DB_ADMIN_TOKEN`

배포 URL이 바뀌면 `src/public/pages/referral/index.html`과 `src/public/pages/reference-check/*.html`의 `SCRIPT_URL`을 새 공개 배포 URL로 교체하고 다시 빌드합니다.
기존 배포를 편집해 버전만 바꾸면 URL이 유지되므로 교체할 필요가 없습니다.

## 3. 관리자 Apps Script

관리자 전용 Apps Script 프로젝트에는 `dist/apps-script-admin/UPLOAD_FILES.txt`에 적힌 파일을 모두 반영합니다.
`shared_00_runtime.gs`는 관리자·공개 백엔드가 함께 사용하는 공통 런타임이므로 누락하면 안 됩니다.
원본 설정은 `config/appsscript.admin.json`에서 관리합니다.

Script Properties:

- `RECRUITMENT_DEPLOYMENT_ROLE`: `admin`
- `RECRUITMENT_SPREADSHEET_URL`: 채용 데이터 시트 URL. 비우면 프로젝트에 연결된 시트를 사용하며 대시보드 설정 점검에서 경고합니다
- `REFERRAL_DATA_SPREADSHEET_URL`: 선택값. 사내추천 데이터를 별도 시트에 둘 때만(없으면 Settings 시트의 값 또는 채용 데이터 시트 사용)
- `REFERRAL_UPLOAD_FOLDER_ID`: 사내추천 이력서를 저장할 비공개 Google Drive 폴더 ID
- `RECRUITMENT_ADMIN_TOKEN`: 새 관리자 토큰
- `RECRUITMENT_LOCAL_ADMIN_USERS`: `사번:해시` 형식의 앱 내부 관리자 계정(`admin:해시` 계정도 유지). 계정은 쉼표 또는 줄바꿈으로 구분. 새 해시는 Apps Script 편집기에서 `makeAdminPasswordHash('비밀번호')`를 실행해 나온 `v2$...` 값을 씁니다(계정마다 솔트가 다른 PBKDF2-HMAC-SHA256). 예전 SHA-256 64자리 해시도 로그인되며, 로그인에 성공하면 그 계정 값이 자동으로 `v2$...`로 바뀝니다
- `RECRUITMENT_ADMIN_SESSION_SECONDS`: 선택값, 최대 6시간
- `OPENAI_API_KEY`: 레퍼런스 AI 요약용 OpenAI API 키
- `INTERVIEWER_DB_LOOKUP_TOKEN`: 직원 DB와 같은 단건 조회 토큰
- `INTERVIEWER_DB_ADMIN_TOKEN`: 전체 직원 DB 동기화가 필요한 경우에만 설정
- 선택값: `REFERENCE_CANDIDATE_PAGE_URL`, `REFERENCE_RESPONSE_PAGE_URL`, `INTERVIEW_AVAILABILITY_PAGE_URL`(메일 속 페이지 주소를 바꿀 때만)

배포 설정:

- access: `ANYONE_ANONYMOUS`
- executeAs: `USER_DEPLOYING`

Google 로그인 없이 관리자 로그인 화면까지 접근할 수 있지만, 모든 관리자 데이터 API는 앱 내부 로그인 세션이 있어야 실행됩니다. `RECRUITMENT_LOCAL_ADMIN_USERS`와 `RECRUITMENT_ADMIN_TOKEN`이 모두 설정되지 않으면 운영 배포하지 않습니다.

관리자 대시보드는 관리자 Apps Script의 `doGet()`이 직접 제공하므로 별도 HTML의 URL을 바꿀 필요가 없습니다.
관리자 URL은 공개 저장소에 하드코딩하지 않습니다.
업로드 묶음에는 빌드가 만든 `admin_98_build_manifest.gs`가 포함됩니다. 일부 파일만 올리면 대시보드가 "배포 파일 버전이 섞여 있습니다"로 알려 줍니다.

### 운영 자동화 설정

관리자 대시보드의 Settings 시트에서 아래 값을 먼저 확인합니다.

- `notifyEmail`: 면접 준비, 추천 보상 만기, 개인정보 파기 승인 대상 알림 수신 주소
- `retentionMonths`: 개인정보 보존기간(개월, 기본값 6)

트리거는 운영 계정에서 추후 수동 등록합니다. 코드를 배포하는 것만으로 트리거가 생성되지는 않습니다.

- `dailyOps`: 매일 09:00. 지원자 추천인 등록·추천인 응답 재안내(기한 초과·만료 임박), 지원자 면접 전날 안내, 면접관 수동 발송 준비, 보상 만기 확인
- `weeklyOps`: 매주 월요일 08:00. 90일 이전 `_Changes` 기록을 아카이브로 이관하고, 기존 변경 로그의 전체 JSON을 필드명 메타데이터로 정리. 1,000건 단위 배치를 실행시간 예산(약 4.5분) 안에서 반복
- `monthlyRetention`: 매월 1일. 보존기간 경과 대상을 관리자에게 알리며 자동 파기는 하지 않음

실행 안전 규칙:

- 세 작업 모두 같은 작업이 이미 실행 중이면 `ops_already_running`으로 건너뜁니다. 메일을 보내는 동안 스크립트 잠금을 잡지 않으므로 담당자 저장을 막지 않습니다.
- 자동 메일은 MailLog의 `eventKey`로 한 번만 보냅니다. 같은 날 다시 실행해도 이미 보낸 메일은 건너뜁니다.
- 실행시간 예산을 넘기면 남은 메일 발송이나 정리를 멈추고 결과에 `incomplete: true`를 남깁니다. 같은 작업을 같은 날 다시 실행하면 이어서 처리합니다(`weeklyOps`는 다음 주 실행에서도 이어집니다).
- `notifyEmail`이 비어 있으면 `dailyOps`는 내부 알림만 건너뛰고 결과 `warnings`에 `notify_email_not_configured`를 남깁니다. `monthlyRetention`은 실행하지 않고 같은 오류를 돌려줍니다.
- `retentionMonths`가 비어 있으면 6개월을 쓰고, 숫자가 아니거나 1보다 작으면 6개월을 쓰면서 `warnings`에 `retention_months_invalid`를 남깁니다.

면접관 메일은 면접조서 첨부가 필요하므로 `dailyOps`가 자동 발송하지 않습니다. `notifyEmail`로 준비 알림을 받은 뒤 대시보드에서 수동 발송합니다.

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
