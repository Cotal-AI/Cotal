import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const rows = JSON.parse(execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { encoding: 'utf8' }));
for (const row of rows) {
  const file = join(row.path, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.name === 'cotal-ai' || pkg.name?.startsWith('@cotal-ai/') && !pkg.private) {
    pkg.version = '0.164.9';
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
