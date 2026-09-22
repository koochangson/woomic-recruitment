import fs from 'fs';
import path from 'path';
import { adminDistDir, root } from './project_paths.js';

const defaultTarget = path.resolve(root, '..', 'recruiting-hub-gas', 'recruiting-hub-gas');
const targetArg = process.argv.find(arg => arg.startsWith('--target='));
const targetDir = path.resolve(targetArg ? targetArg.slice('--target='.length) : defaultTarget);
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function targetName(sourceName) {
  return sourceName.endsWith('.gs') ? sourceName.replace(/\.gs$/, '.js') : sourceName;
}

const claspPath = path.join(targetDir, '.clasp.json');
if (!fs.existsSync(claspPath)) fail(`Missing .clasp.json in ${targetDir}`);
if (!fs.existsSync(adminDistDir)) fail(`Missing admin build output: ${adminDistDir}`);

const claspConfig = JSON.parse(fs.readFileSync(claspPath, 'utf8'));
if (!String(claspConfig.scriptId || '').trim()) fail('The connected clasp project has no scriptId.');

const uploadListPath = path.join(adminDistDir, 'UPLOAD_FILES.txt');
if (!fs.existsSync(uploadListPath)) fail(`Missing upload list: ${uploadListPath}`);
const sourceNames = fs.readFileSync(uploadListPath, 'utf8')
  .split(/\r?\n/)
  .map(name => name.trim())
  .filter(Boolean);

const desired = new Map();
for (const sourceName of sourceNames) {
  const sourcePath = path.join(adminDistDir, sourceName);
  if (!fs.existsSync(sourcePath)) fail(`Upload source is missing: ${sourcePath}`);
  const outputName = targetName(sourceName);
  if (desired.has(outputName)) fail(`Duplicate clasp output name: ${outputName}`);
  desired.set(outputName, sourcePath);
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

console.log(`Admin clasp target: ${targetDir}`);
console.log(`Connected scriptId: ${claspConfig.scriptId}`);
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
