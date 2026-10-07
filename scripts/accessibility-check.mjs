import fs from 'node:fs';

const pages = [
  'src/public/pages/referral/index.html',
  'src/public/pages/reference-check/reference_candidate_intake.html',
  'src/public/pages/reference-check/reference_check_intake.html',
  'src/public/pages/reference-check/interview_availability.html',
  'src/public/pages/reference-check/join_date.html',
];

const requiredPatterns = [
  {
    file: pages[0],
    patterns: [/<fieldset class="choice-fieldset">/, /aria-current="step"/, /id="completePanel"[^>]*role="status"/],
  },
  {
    file: pages[1],
    patterns: [/role="alert"[^>]*aria-live="assertive"/, /label for="\$\{fieldId\('email'\)\}"/, /id="formMessage"[^>]*role="alert"/],
  },
  {
    file: pages[2],
    patterns: [/<fieldset class="opt-list option-fieldset"/, /label for="identityEmail"/, /data-form-step="1"[^>]*tabindex="-1"/],
  },
  {
    file: pages[3],
    patterns: [/<fieldset class="availability-fieldset">/, /id="loading"[^>]*role="status"/, /id="error"[^>]*role="alert"/, /id="form-message"[^>]*role="alert"/],
  },
];

const failures = [];

for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  if (!/aria-live=/.test(html)) failures.push(`${file}: missing aria-live region`);
  if (!/role="(?:status|alert)"/.test(html)) failures.push(`${file}: missing status or alert role`);

  const radioNames = [...html.matchAll(/<input[^>]*type="radio"[^>]*name="([^"]+)/g)]
    .map(match => match[1])
    .filter(name => !name.includes('$'));
  for (const name of new Set(radioNames)) {
    const position = html.indexOf(`name="${name}"`);
    const before = html.slice(0, position);
    if (before.lastIndexOf('<fieldset') < before.lastIndexOf('</fieldset>')) {
      failures.push(`${file}: radio group ${name} is outside a fieldset`);
    }
  }
}

for (const check of requiredPatterns) {
  const html = fs.readFileSync(check.file, 'utf8');
  check.patterns.forEach(pattern => {
    if (!pattern.test(html)) failures.push(`${check.file}: missing accessibility pattern ${pattern}`);
  });
}

if (failures.length) {
  console.error('Public accessibility check failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Public accessibility check passed (${pages.length} pages).`);
