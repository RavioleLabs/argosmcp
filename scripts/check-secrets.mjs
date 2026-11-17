import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /GOCSPX-[\w-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{25,}/,
  /AIza[\w-]{30,}/,
];
const found = files.filter(
  (f) =>
    /(^|\/)(\.data|\.env|\.dev.vars|node_modules|build)(\/|$)/.test(f) ||
    /\.secrets\.json$/.test(f) ||
    patterns.some((p) => p.test(readFileSync(f, 'utf8'))),
);
if (found.length) {
  console.error('Potential secret or generated state in tracked files:', found.join(', '));
  process.exit(1);
}
console.log(
  `Checked ${files.length} tracked files for known secret patterns and forbidden state files. This is not a complete secret audit.`,
);
