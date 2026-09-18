## 변경 요약

- 

## 보안 체크

- [ ] `npm run check` 또는 `node scripts/security-scan.mjs && node scripts/syntax-check.mjs` 통과
- [ ] 공개 저장소에 관리자 Apps Script URL, 토큰, API 키를 추가하지 않음
- [ ] 공개 추천 접수 URL과 관리자용 DOMAIN 제한 URL을 혼동하지 않음
- [ ] 브라우저 localStorage 또는 Google Sheets Settings에 OpenAI API 키를 저장하지 않음
- [ ] 개인정보 필드 추가/변경 시 수집 목적과 보존 기간을 확인함
- [ ] 이력서/첨부파일 업로드 변경 시 Drive 공유권한을 확인함

## 배포 영향

- [ ] 공개 추천 접수 화면 영향 없음
- [ ] 관리자 대시보드 영향 확인
- [ ] Apps Script Script Properties 변경 필요 여부를 문서화함

필요한 Script Properties:

```text

```
