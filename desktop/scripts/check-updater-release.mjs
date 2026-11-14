import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const [key, value] of Object.entries(process.env)) {
  if (/^(COTAL_UPDATER_TEST_ENDPOINT|COTAL_UPDATER_INSECURE|CARGO_FEATURE_UPDATER_E2E)$/i.test(key) && value !== undefined) throw new Error(`Release updater test input is set: ${key}`);
}
const executable = resolve(process.argv[2] ?? 'desktop/src-tauri/target/release/cotal-desktop' + (process.platform === 'win32' ? '.exe' : ''));
const config = JSON.parse(execFileSync(executable, ['--updater-config'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192 }));
assert.deepEqual(config, { schema: 1, endpoints: ['https://github.com/Cotal-AI/Cotal/releases/latest/download/desktop-latest.json'], insecure: false, test: false }, 'The release executable must carry only the production updater endpoint and no test input.');
console.log('Release executable updater configuration verified: production HTTPS endpoint only.');
