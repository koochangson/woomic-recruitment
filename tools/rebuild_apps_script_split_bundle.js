import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const steps = [
  ['Split dashboard HTML', 'tools/split_dashboard_gmail.js'],
  ['Refactor general mail assets', 'tools/refactor_general_mail_assets.js'],
  ['Split server GS', 'tools/split_code_admin_gmail.js'],
  ['Prepare upload bundle', 'tools/prepare_apps_script_split_bundle.js'],
  ['Check upload bundle', 'tools/check_apps_script_split_bundle.js'],
];

for (const [label, script] of steps) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('\nApps Script split bundle is ready.');
