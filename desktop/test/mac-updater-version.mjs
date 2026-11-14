import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'darwin') throw new Error('Updater fixture versions require a disposable hosted Mac.');
const version = process.argv[2];
if (!/^0\.164\.(8|9)$/.test(version ?? '')) throw new Error('The updater fixture accepts only its declared N and N+1.');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run fixture version stamping with pnpm exec node.');
const rows = JSON.parse(execFileSync(process.execPath, [pnpm, 'list', '-r', '--depth', '-1', '--json'], { encoding: 'utf8' }));
for (const row of rows) {
  const path = join(row.path, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.name === 'cotal-ai' || pkg.name?.startsWith('@cotal-ai/') && !pkg.private) {
    pkg.version = version;
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
const endpoint = process.env.COTAL_UPDATER_TEST_ENDPOINT;
if (!endpoint) throw new Error('Compile the job-local updater endpoint explicitly.');
writeFileSync(resolve('desktop/src-tauri/updater-proof.json'), JSON.stringify({ bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: '-' } } }));
console.log(`Prepared debug updater bundle version ${version}.`);
