# GitHub 보안 설정 체크리스트

GitHub UI에서 적용해야 하는 저장소/조직 설정입니다.

## 저장소 가시성

- 공개 추천 접수 저장소와 관리자 대시보드 저장소를 분리합니다.
- 공개 추천 접수 저장소만 public Pages를 유지합니다.
- 관리자 대시보드는 public Pages에 배포하지 않습니다.
- GitHub Enterprise Cloud를 사용하는 경우 관리자 대시보드는 private Pages로 전환합니다.

## Branch Protection

`main` 또는 배포 브랜치에 아래 규칙을 적용합니다.

- Require a pull request before merging
- Require approvals: 1명 이상
- Require review from Code Owners
- Require status checks to pass before merging
- Required status check: `security-checks`
- Do not allow bypassing the above settings
- Restrict who can push to matching branches

## Secret Protection

가능하면 GitHub Secret Protection을 활성화합니다.

- Secret scanning
- Push protection
- Custom pattern:
  - `woomic-ats-admin-[0-9]{8}-v[0-9]+-[A-Za-z0-9_-]+`
  - `AKfycb[A-Za-z0-9_-]{30,}`
  - `sk-[A-Za-z0-9_-]{20,}`

## Actions

- GitHub Actions를 허용하되, 외부 PR에서 쓰기 권한을 주지 않습니다.
- `Security checks` 워크플로가 PR과 `main` push에서 성공해야 배포합니다.

## Access Review

월 1회 확인합니다.

- 저장소 관리자 권한 보유자
- GitHub organization/team 멤버
- GitHub Pages 배포 대상 브랜치
- 공개 포크 여부
- 배포된 Pages URL이 공개 접수 화면만 가리키는지
