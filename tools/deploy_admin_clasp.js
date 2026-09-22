import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { root } from './project_paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultTarget = path.resolve(root, '..', 'recruiting-hub-gas', 'recruiting-hub-gas');
const targetArg = process.argv.find(arg => arg.startsWith('--target='));
const targetDir = path.resolve(targetArg ? targetArg.slice('--target='.length) : defaultTarget);
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

const syncArgs = ['tools/sync_admin_clasp.js', `--target=${targetDir}`];
if (dryRun) syncArgs.push('--dry-run');
run('Synchronize clasp mirror', process.execPath, syncArgs);

if (dryRun) {
  console.log('\nDry run complete. clasp push was not executed.');
  process.exit(0);
}

const windowsClasp = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'clasp.cmd') : '';
const claspCommand = process.platform === 'win32' && fs.existsSync(windowsClasp) ? windowsClasp : 'clasp';
run('Push admin Apps Script', claspCommand, ['push', '--force'], {
  cwd: targetDir,
  shell: process.platform === 'win32',
});

console.log('\nAdmin Apps Script upload completed. Create or update the deployment version separately when ready.');
