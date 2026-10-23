// Fails if a token or secret is about to be committed.
// Usage: node scripts/secret-scan.mjs        (staged files, used by pre-commit)
//        node scripts/secret-scan.mjs --all  (every tracked + untracked file, used by CI)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const RULES = [
  ['Meta access token', /\bEAA[A-Za-z0-9]{30,}\b/],
  ['access_token in URL', /access_token=[A-Za-z0-9]{20,}/],
  ['Filled FB_ secret in env-style file', /^\s*FB_(USER_ACCESS_TOKEN|PAGE_ACCESS_TOKEN|APP_SECRET)[ \t]*=[ \t]*[^\s#]{8,}/m],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Generic API key', /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/],
];
const BLOCKED_FILES = [/(^|\/)\.env(\.(?!example$)[^/]+)?$/, /\.(pem|key|p12|keystore|jks)$/];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = process.argv.includes('--all')
  ? git('ls-files', '--cached', '--others', '--exclude-standard')
  : git('diff', '--cached', '--name-only', '--diff-filter=ACM');

const problems = [];
for (const f of files) {
  if (BLOCKED_FILES.some((r) => r.test(f))) problems.push(`${f}: secret file must not be committed`);
  if (!existsSync(f) || f.startsWith('node_modules/')) continue;
  const text = readFileSync(f, 'utf8');
  for (const [name, re] of RULES) if (re.test(text)) problems.push(`${f}: ${name}`);
}
if (problems.length) {
  console.error('Secret scan FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files).`);
