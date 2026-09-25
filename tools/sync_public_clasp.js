import fs from 'fs';
import path from 'path';
import { publicDistDir, root } from './project_paths.js';

const targetArg = process.argv.find(arg => arg.startsWith('--target='));
if (!targetArg || !targetArg.slice('--target='.length).trim()) {
  console.error('Public synchronization requires --target=<public-clasp-folder>.');
  process.exit(1);
}
const targetDir = path.resolve(targetArg.slice('--target='.length));
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Public bundle only ever contains Code.gs + appsscript.json (see dist/apps-script-public/README.md).
// Unlike the admin bundle it has no UPLOAD_FILES.txt / module list, so the source set is fixed here.
const sourceNames = ['Code.gs', 'appsscript.json'];

function targetName(sourceName) {
  return sourceName.endsWith('.gs') ? sourceName.replace(/\.gs$/, '.js') : sourceName;
}

const claspPath = path.join(targetDir, '.clasp.json');
if (!fs.existsSync(claspPath)) fail(`Missing .clasp.json in ${targetDir}`);
if (!fs.existsSync(publicDistDir)) fail(`Missing public build output: ${publicDistDir}`);

const claspConfig = JSON.parse(fs.readFileSync(claspPath, 'utf8'));
const publicScriptId = String(claspConfig.scriptId || '').trim();
if (!publicScriptId) fail('The connected clasp project has no scriptId.');

const adminClaspPath = path.resolve(root, '..', 'recruiting-hub-gas', 'recruiting-hub-gas', '.clasp.json');
if (fs.existsSync(adminClaspPath)) {
  const adminConfig = JSON.parse(fs.readFileSync(adminClaspPath, 'utf8'));
  const adminScriptId = String(adminConfig.scriptId || '').trim();
  if (adminScriptId && publicScriptId === adminScriptId) {
    fail('Refusing public synchronization: target is connected to the admin Apps Script project.');
  }
}

const publicManifestPath = path.join(publicDistDir, 'appsscript.json');
const publicManifest = JSON.parse(fs.readFileSync(publicManifestPath, 'utf8'));
if (publicManifest.webapp?.executeAs !== 'USER_DEPLOYING' ||
    publicManifest.webapp?.access !== 'ANYONE_ANONYMOUS') {
  fail('Public manifest must use USER_DEPLOYING and ANYONE_ANONYMOUS.');
}

const desired = new Map();
for (const sourceName of sourceNames) {
  const sourcePath = path.join(publicDistDir, sourceName);
  if (!fs.existsSync(sourcePath)) fail(`Upload source is missing: ${sourcePath}`);
  desired.set(targetName(sourceName), sourcePath);
}

const isPushable = name => name === 'appsscript.json' || /\.(?:js|gs|html)$/i.test(name);
const existing = fs.readdirSync(targetDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && isPushable(entry.name))
  .map(entry => entry.name);
const removals = existing.filter(name => !desired.has(name)).sort();
const writes = [];

for (const [outputName, sourcePath] of desired) {
  const outputPath = path.join(targetDir, outputName);
  const source = fs.readFileSync(sourcePath);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
  if (!current || !source.equals(current)) writes.push([outputName, sourcePath, outputPath]);
}

console.log(`Public clasp target: ${targetDir}`);
console.log(`Connected scriptId: ${publicScriptId}`);
console.log('Manifest policy: USER_DEPLOYING / ANYONE_ANONYMOUS');
console.log(`Files to write: ${writes.length}`);
console.log(`Obsolete files to remove: ${removals.length}`);
removals.forEach(name => console.log(`  remove ${name}`));

if (dryRun) {
  writes.forEach(([name]) => console.log(`  write  ${name}`));
  console.log('Dry run complete. No files changed.');
  process.exit(0);
}

for (const name of removals) fs.rmSync(path.join(targetDir, name));
for (const [, sourcePath, outputPath] of writes) fs.copyFileSync(sourcePath, outputPath);

console.log(`Clasp mirror synchronized: ${desired.size} files.`);
