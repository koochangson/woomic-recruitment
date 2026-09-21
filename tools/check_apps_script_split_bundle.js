import fs from 'fs';
import path from 'path';
import { adminDistDir, adminJsFiles } from './project_paths.js';

const bundleDir = adminDistDir;

const forbidden = new Set([
  'Code_admin_gmail.gs',
  'Dashboard_gmail.html',
  'mail_samples_preview.html',
]);

const files = fs.readdirSync(bundleDir).filter(name => fs.statSync(path.join(bundleDir, name)).isFile());
const baseNames = new Set(files.map(name => name.replace(/\.(gs|html|json|md|txt)$/i, '')));

const missing = new Set();
const forbiddenFound = files.filter(name => forbidden.has(name));

for (const file of files) {
  const content = fs.readFileSync(path.join(bundleDir, file), 'utf8');
  const patterns = [
    /include\('([^']+)'\)/g,
    /createHtmlOutputFromFile\('([^']+)'\)/g,
    /loadMailFragment_\('([^']+)'\)/g,
    /loadMailAsset_\('([^']+)'\)/g,
    /'((?:(?:mail_(?:\d{2}|body|shared|asset)_)|js_|app_(?:css|script)$|Dashboard$)[a-zA-Z0-9_]*)'/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content))) {
      const ref = match[1];
      if (
        /^(mail_(?:\d{2}|body|shared|asset)_|js_|app_(?:css|script)$|Dashboard$)/.test(ref) &&
        !baseNames.has(ref)
      ) {
        missing.add(`${ref} referenced from ${file}`);
      }
    }
  }
}

const gs = files
  .filter(name => name.endsWith('.gs'))
  .sort()
  .map(name => fs.readFileSync(path.join(bundleDir, name), 'utf8'))
  .join('\n');
new Function(gs);

const js = adminJsFiles
  .map(name => fs.readFileSync(path.join(bundleDir, name), 'utf8'))
  .join('');
new Function(js);

if (forbiddenFound.length || missing.size) {
  if (forbiddenFound.length) console.error(`Forbidden files found: ${forbiddenFound.join(', ')}`);
  if (missing.size) console.error([...missing].join('\n'));
  process.exit(1);
}

console.log(`Bundle check OK: ${files.length} files, no missing references, syntax OK`);
