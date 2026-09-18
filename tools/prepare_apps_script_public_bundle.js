import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'apps_script_public_upload');

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(root, 'apps_script_referral_security.gs'), path.join(outDir, 'Code.gs'));
fs.copyFileSync(path.join(root, 'appsscript.public.template.json'), path.join(outDir, 'appsscript.json'));
fs.copyFileSync(path.join(root, 'referral_intake.html'), path.join(root, 'index.html'));

console.log(`Prepared ${outDir}`);
console.log('Copied Code.gs, appsscript.json, and referral index.html');
