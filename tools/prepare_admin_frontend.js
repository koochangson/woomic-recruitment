import fs from 'fs';
import path from 'path';
import {
  adminCssSource,
  adminHtmlSource,
  adminIntermediateDir,
  adminJsDir,
  adminJsFiles,
} from './project_paths.js';

const dashboard = fs.readFileSync(adminHtmlSource, 'utf8');
const expectedIncludes = ['app_css', ...adminJsFiles.map(name => path.basename(name, '.html'))];
const actualIncludes = [...dashboard.matchAll(/include\('([^']+)'\)/g)].map(match => match[1]);
if (JSON.stringify(actualIncludes) !== JSON.stringify(expectedIncludes)) {
  throw new Error(`Dashboard include order mismatch: ${actualIncludes.join(', ')}`);
}

const moduleSources = adminJsFiles.map(name => {
  const source = fs.readFileSync(path.join(adminJsDir, name), 'utf8');
  new Function(source);
  return source;
});
const combinedJs = moduleSources.join('');
new Function(combinedJs);

const registryMatch = combinedJs.match(/const DELEGATED_CALLS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
if (!registryMatch) throw new Error('DELEGATED_CALLS registry was not found.');
const registeredCalls = new Set(
  registryMatch[1]
    .split(',')
    .map(value => value.trim())
    .filter(value => /^[A-Za-z_$][\w$]*$/.test(value)),
);
const delegatedSources = [dashboard, ...moduleSources];
const missingDelegatedCalls = new Set();
for (const source of delegatedSources) {
  for (const attribute of source.matchAll(/data-(?:call|oninput|onchange|onfocus|onblur|onkeydown|ondrop)=(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const sequence = attribute[1] ?? attribute[2] ?? attribute[3] ?? '';
    for (const call of sequence.matchAll(/(?:^|;)\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (name !== 'document' && name !== 'event' && !registeredCalls.has(name)) missingDelegatedCalls.add(name);
    }
  }
}
if (missingDelegatedCalls.size) {
  throw new Error(`Unregistered delegated calls: ${[...missingDelegatedCalls].sort().join(', ')}`);
}

fs.rmSync(adminIntermediateDir, { recursive: true, force: true });
fs.mkdirSync(adminIntermediateDir, { recursive: true });
fs.copyFileSync(adminHtmlSource, path.join(adminIntermediateDir, 'Dashboard.html'));
fs.copyFileSync(adminCssSource, path.join(adminIntermediateDir, 'app_css.html'));
for (let index = 0; index < adminJsFiles.length; index++) {
  const name = adminJsFiles[index];
  fs.writeFileSync(
    path.join(adminIntermediateDir, name),
    `<script>\n${moduleSources[index]}\n</script>\n`,
    'utf8',
  );
}

console.log(`Prepared admin frontend with ${adminJsFiles.length} JavaScript modules.`);
console.log(`JavaScript syntax, include order, and ${registeredCalls.size} delegated calls OK.`);
