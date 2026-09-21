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
console.log('JavaScript syntax and include order OK.');
