# Admin Apps Script clasp deployment

The connected clasp mirror is:

`..\recruiting-hub-gas\recruiting-hub-gas`

Run a dry check first:

```powershell
node tools/deploy_admin_clasp.js --dry-run
```

Build, validate, synchronize, and upload the admin project:

```powershell
node tools/deploy_admin_clasp.js
```

The synchronization step converts generated `.gs` files to clasp `.js` files, copies all HTML templates and `appsscript.json`, and removes obsolete pushable files such as `app_script.html` and `js_02_positions_interviews.html`. It preserves `.clasp.json` and `.git`.

`clasp push` updates the Apps Script project source. It does not change the production web-app deployment version. After testing, edit the existing deployment and select a new version to preserve the `/exec` URL.
