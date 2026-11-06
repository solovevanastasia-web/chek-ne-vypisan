import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = execFileSync('git', ['rev-parse','--show-toplevel'], {cwd:root,encoding:'utf8'}).trim();
if (repository !== root.replace(/\/$/,'')) throw new Error('Run the publication guard from this project repository, not a parent repository.');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const forbiddenPath = /(^|\/)(env|\.ssh|\.git)(\/|$)|(^|\/)\.env(?!\.example$)(?:\.|$)|(^|\/)(id_ed25519|id_rsa|deploy_key)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i;
const patterns = [
  /gsk_[a-zA-Z0-9]{20,}/,
  /gh[pousr]_[a-zA-Z0-9]{20,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /sk-(?:proj-)?[a-zA-Z0-9_-]{24,}/,
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----/,
];
const issues = [];
for (const file of files) {
  if (forbiddenPath.test(file)) issues.push(`Private file tracked: ${file}`);
  const content = readFileSync(new URL('../' + file, import.meta.url));
  if (patterns.some(re => re.test(content.toString('utf8')))) issues.push(`Credential pattern found in: ${file}`);
}
if (issues.length) {
  // Deliberately report names only, never the matching secret value.
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${files.length} tracked files checked; no env/, private keys or known credential patterns.`);
}
