# 공개 Apps Script 반영 방법

대상 프로젝트: `사내추천관리_public`

## 업로드 파일

- `Code.gs`: 기존 공개 프로젝트의 `Code.gs` 전체를 이 파일 내용으로 교체
- `appsscript.json`: 기존 매니페스트와 권한을 비교한 뒤 반영

관리자 프로젝트의 `admin_*.gs`, `Dashboard.html`, `js_*.html`, `mail_*.html`은 이 프로젝트에 넣지 않는다.

## 필수 스크립트 속성

Apps Script의 **프로젝트 설정 > 스크립트 속성**에 다음 값을 설정한다.

| 속성 | 값 |
| --- | --- |
| `RECRUITMENT_DEPLOYMENT_ROLE` | `public` |
| `RECRUITMENT_SPREADSHEET_URL` | 관리자 채용 데이터가 저장된 Google Sheets 전체 URL |
| `RECRUITMENT_ADMIN_TOKEN` | 관리자 프로젝트와 동일한 긴 임의 토큰 |

기존 사내추천 설정인 업로드 폴더, 임직원 DB 및 `referralDataUrl`은 현재 값을 유지한다.

## 데이터 저장 위치

- 공개 프로젝트에 연결된 시트: `Referrals`, `Rewards`, `RefRules`, `Employees`, `Settings`
- `RECRUITMENT_SPREADSHEET_URL` 시트: `Candidates`, `Interviews`, `Positions`, `RecruitPlans`, `ReferenceCandidates`, `ReferenceResponses`

## 배포

1. 기존 공개 프로젝트의 사본을 만든다.
2. `Code.gs`를 교체하고 저장한다.
3. 스크립트 속성을 확인한다.
4. 테스트 배포에서 사내추천 인증, 추천인 등록, 추천인 본인확인, 면접 가능일 응답을 확인한다.
5. **배포 관리 > 기존 공개 배포 편집**에서 새 버전으로 변경한다. 새 배포를 만들지 않아야 URL이 유지된다.

현재 공개 화면 5개는 모두 동일한 기존 `/exec` URL을 사용한다.
