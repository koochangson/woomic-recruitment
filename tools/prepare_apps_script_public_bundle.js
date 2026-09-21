import fs from 'fs';
import path from 'path';
import {
  configDir,
  publicDistDir,
  publicGsSource,
  publicPagesDir,
  referenceDistDir,
  referralDistDir,
  root,
} from './project_paths.js';

for (const dir of [publicDistDir, referralDistDir, referenceDistDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.copyFileSync(publicGsSource, path.join(publicDistDir, 'Code.gs'));
fs.copyFileSync(path.join(configDir, 'appsscript.public.json'), path.join(publicDistDir, 'appsscript.json'));

const readme = `# Public Apps Script Upload Set

공개 접수용 Apps Script 프로젝트의 Code.gs와 appsscript.json을 이 폴더의 파일로 교체합니다.
관리자용 파일은 이 프로젝트에 넣지 않습니다.
`;
fs.writeFileSync(path.join(publicDistDir, 'README.md'), readme, 'utf8');

fs.copyFileSync(
  path.join(publicPagesDir, 'referral', 'index.html'),
  path.join(referralDistDir, 'index.html')
);
fs.copyFileSync(path.join(root, 'woomi-ci.png'), path.join(referralDistDir, 'woomi-ci.png'));

for (const name of [
  'reference_candidate_intake.html',
  'reference_check_intake.html',
  'interview_availability.html',
]) {
  fs.copyFileSync(path.join(publicPagesDir, 'reference-check', name), path.join(referenceDistDir, name));
}
for (const name of ['woomi-ci.png', 'woomi-ci-mark-white.png']) {
  fs.copyFileSync(path.join(root, name), path.join(referenceDistDir, name));
}

console.log(`Prepared ${publicDistDir}`);
console.log(`Prepared ${referralDistDir}`);
console.log(`Prepared ${referenceDistDir}`);
