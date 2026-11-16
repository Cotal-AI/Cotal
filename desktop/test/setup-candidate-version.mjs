import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Candidate version stamping requires a disposable hosted runner.');
const readText = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const baseVersion = JSON.parse(readText(new URL('../../bin/package.json', import.meta.url))).version;
assert.match(baseVersion ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable base version required in bin/package.json');
assert.ok(Number(baseVersion.split('.')[2]) < 1000, 'bin/package.json must carry the unstamped base version before stamping');
const version = baseVersion.replace(/\d+$/, patch => String(Number(patch) + (process.argv.includes('--next') ? 2000 : 1000)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run candidate stamping through pnpm exec node.');
const rows = JSON.parse(execFileSync(process.execPath, [pnpm, 'list', '-r', '--depth', '-1', '--json'], { encoding: 'utf8' }).replace(/\r\n/g, '\n'));
for (const row of rows) {
  const file = join(row.path, 'package.json');
  const pkg = JSON.parse(readText(file));
  if (pkg.name === 'cotal-ai' || pkg.name?.startsWith('@cotal-ai/') && !pkg.private) {
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
