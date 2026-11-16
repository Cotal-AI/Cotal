import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const base = JSON.parse(readFileSync('bin/package.json', 'utf8')).version;
assert.equal(base, '0.164.18');
assert(process.env.npm_execpath, 'Run through pnpm exec node');
const rows = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'list', '-r', '--depth', '-1', '--json'], {encoding:'utf8'}));
for (const row of rows) {
  const path = join(row.path, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.name === 'cotal-ai' || pkg.name?.startsWith('@cotal-ai/') && !pkg.private) {
    pkg.version = '0.164.3018';
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  }
}
console.log('Stamped hosted third installer version 0.164.3018');
