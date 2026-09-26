# Recruiting Hub 보안 운영 런북

## 비밀값 유출 의심 시

1. 유출된 값을 즉시 폐기합니다.
2. 새 값을 발급하고 Apps Script Script Properties에만 반영합니다.
3. GitHub 저장소, Pages 배포본, 브라우저 localStorage, Google Sheets Settings에 같은 값이 남아 있는지 확인합니다.
4. `node scripts/security-scan.mjs`를 실행합니다.
5. Apps Script 배포 버전을 새로 만들고 공개/관리자 URL을 각각 검증합니다.
6. `_Changes` 시트와 Apps Script 실행 로그에서 비정상 요청을 확인합니다.

## 정기 점검

월 1회:

- GitHub 조직/저장소 관리자 권한자 확인
- Google Sheets 공유 대상 확인
- Apps Script 배포 권한 확인
- Drive 업로드 폴더 공유 상태 확인
- `RECRUITMENT_ADMIN_ALLOWLIST` 퇴사자/전보자 제거
- `INTERVIEWER_DB_ADMIN_TOKEN`, `INTERVIEWER_DB_LOOKUP_TOKEN`, `RECRUITMENT_ADMIN_TOKEN` 회전 필요 여부 검토

분기 1회:

- 토큰 회전
- 공개 저장소 secret scanning alert 확인
- 브랜치 보호/필수 status check 유지 여부 확인
- 개인정보 보존 기간 초과 데이터 삭제 여부 확인

## 배포 분리 원칙

공개 접수:

- `RECRUITMENT_DEPLOYMENT_ROLE=public`
- 익명 접근 가능
- 관리자 토큰 없음
- `INTERVIEWER_DB_LOOKUP_TOKEN`만 사용

관리자:

- `RECRUITMENT_DEPLOYMENT_ROLE=admin`
- Google 로그인 없이 진입 가능하되 앱 내부 관리자 세션 필수
- `RECRUITMENT_LOCAL_ADMIN_USERS`와 `RECRUITMENT_ADMIN_TOKEN` 필수
- `OPENAI_API_KEY`는 Script Properties에만 저장

직원 DB:

- 전체 조회/일괄 교체는 `INTERVIEWER_DB_ADMIN_TOKEN` 필요
- 사번 단건 조회는 `INTERVIEWER_DB_LOOKUP_TOKEN` 필요

## 배포 후 스모크 테스트

- 공개 접수 화면에서 인증번호 발송/검증 가능
- OTP 5회 실패 후 잠금 확인
- 관리자 대시보드에서 후보자 조회/저장 가능
- 직원 DB URL이 토큰 없이 전체 조회를 거부
- 이력서 테스트 업로드 파일이 Drive에서 제한됨 상태
- AI 요약은 관리자 Apps Script의 `OPENAI_API_KEY`가 있을 때만 성공
