import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !['darwin', 'win32'].includes(process.platform)) throw new Error('Updater fixture versions require a disposable hosted Mac or Windows runner.');
const version = process.argv[2];
const faultDaemonServe = process.argv.includes('--fault-daemon-serve');
const extraPreference = process.argv.includes('--extra-preference');
if (!/^0\.164\.(8|9|10)$/.test(version ?? '')) throw new Error('The updater fixture accepts only its declared N, N+1 and N+2.');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run fixture version stamping with pnpm exec node.');
execFileSync('git', ['checkout', '--', 'bin/daemon/command.ts', 'desktop/src-tauri/src/presence.rs'], { stdio: 'ignore' });
if (faultDaemonServe) {
  const commandPath = resolve('bin/daemon/command.ts');
  const original = readFileSync(commandPath, 'utf8');
  const target = 'running = await serveDaemon({';
  assert.equal(original.includes(target), true, 'Expected serveDaemon call in bin/daemon/command.ts');
  writeFileSync(commandPath, original.replace(target, `if (binVersion() === "${version}") throw new Error(\`synthetic #6880 fault: bundled daemon ${version} cannot start\`);\n    ${target}`));
}
if (extraPreference) {
  const presencePath = resolve('desktop/src-tauri/src/presence.rs');
  const original = readFileSync(presencePath, 'utf8');
  const target = '    close_explained: bool,';
  assert.equal(original.includes(target), true, 'Expected the preferences struct field');
  writeFileSync(presencePath, original.replace(target, `${target}\n    #[serde(default)]\n    rollback_probe: bool,`));
}
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
const pubkey = process.env.COTAL_UPDATER_PROOF_CONFIG_PUBLIC_KEY?.trim();
const fixtureKey = process.env.COTAL_UPDATER_PUBLIC_KEY?.trim();
if (!pubkey || !fixtureKey || pubkey === fixtureKey) throw new Error('The proof config requires a distinct disposable public key.');
writeFileSync(resolve('desktop/src-tauri/updater-proof.json'), JSON.stringify({ bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: '-' } }, plugins: { updater: { pubkey } } }));
console.log(`Prepared debug updater bundle version ${version}.`);
