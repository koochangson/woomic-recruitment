# Public Apps Script clasp deployment

The connected clasp mirror is whatever local folder your public project's
`.clasp.json` lives in. The `--target=<path>` argument is mandatory and there
is no fallback target. Do **not** reuse the admin mirror
folder (`../recruiting-hub-gas/recruiting-hub-gas`, see
[CLASP_ADMIN_DEPLOY.md](CLASP_ADMIN_DEPLOY.md)) for public pushes, and vice
versa — pushing the wrong bundle overwrites the other project's
`appsscript.json`, including its `webapp.executeAs`/`webapp.access` settings.

Run a dry check first:

```powershell
node tools/deploy_public_clasp.js --target="<path-to-public-clasp-folder>" --dry-run
```

Build, validate, synchronize, and upload the public project:

```powershell
node tools/deploy_public_clasp.js --target="<path-to-public-clasp-folder>"
```

The synchronization step copies only `Code.gs` (as `Code.js`) and
`appsscript.json` from `dist/apps-script-public` — nothing from the admin
bundle. It preserves `.clasp.json` and `.git`. Before writing, it rejects the
known admin script ID and verifies that the public manifest still uses
`USER_DEPLOYING` / `ANYONE_ANONYMOUS`.

`clasp push` updates the Apps Script project source. It does not change the
production web-app deployment version or its Execute As / Access settings.
After testing, edit the existing deployment and select a new version to
preserve the `/exec` URL.

## Expected webapp settings per project

| Setting | Admin project | Public project |
|---|---|---|
| Execute as | 나(USER_DEPLOYING) | 나(USER_DEPLOYING) |
| Who has access | 모든 사용자(익명 포함, ANYONE_ANONYMOUS) | 모든 사용자(익명 포함, ANYONE_ANONYMOUS) |

관리자 프로젝트는 Google 로그인 대신 자체 관리자 로그인 세션으로 데이터를 보호합니다. 공개 프로젝트는 접수·응답별 토큰 검증으로 보호하므로 두 프로젝트의 동일한 웹 앱 접근 설정이 인증 방식까지 같다는 뜻은 아닙니다.

The public project must allow anonymous access — candidates and referees
filling out the GitHub Pages forms don't have company Google accounts, so
the deployment relies on this Apps Script setting plus its own token-based
checks, not Google sign-in. If the public `/exec` URL stops responding for
anonymous visitors right after a clasp push, check the pushed
`appsscript.json` — if it shows `USER_ACCESSING`/`DOMAIN`, an old restricted
manifest was pushed. Re-run
`node tools/deploy_public_clasp.js` with the correct `--target`, then edit
the existing deployment in the Apps Script editor and deploy a new version.
