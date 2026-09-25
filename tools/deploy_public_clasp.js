import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { root } from './project_paths.js';

const targetArg = process.argv.find(arg => arg.startsWith('--target='));
if (!targetArg || !targetArg.slice('--target='.length).trim()) {
  console.error('Public deployment requires --target=<public-clasp-folder>.');
  process.exit(1);
}
const targetDir = path.resolve(targetArg.slice('--target='.length));
const dryRun = process.argv.includes('--dry-run');

function run(label, command, args, options = {}) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    shell: options.shell || false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run('Rebuild Apps Script bundles', process.execPath, ['tools/rebuild_apps_script_split_bundle.js']);
run('Security scan', process.execPath, ['scripts/security-scan.mjs']);
run('Syntax check', process.execPath, ['scripts/syntax-check.mjs']);
run('Deployment readiness', process.execPath, ['scripts/deployment-readiness.mjs']);

const syncArgs = ['tools/sync_public_clasp.js', `--target=${targetDir}`];
if (dryRun) syncArgs.push('--dry-run');
run('Synchronize clasp mirror', process.execPath, syncArgs);

if (dryRun) {
  console.log('\nDry run complete. clasp push was not executed.');
  process.exit(0);
}

const windowsClasp = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'clasp.cmd') : '';
const claspCommand = process.platform === 'win32' && fs.existsSync(windowsClasp) ? windowsClasp : 'clasp';
run('Push public Apps Script', claspCommand, ['push', '--force'], {
  cwd: targetDir,
  shell: process.platform === 'win32',
});

console.log('\nPublic Apps Script upload completed. Create or update the deployment version separately when ready.');
console.log('Reminder: pushing files does NOT change an existing deployment\'s Execute As / Access settings.');
console.log('To keep the same /exec URL, edit the existing deployment in the Apps Script editor and select "New version".');
