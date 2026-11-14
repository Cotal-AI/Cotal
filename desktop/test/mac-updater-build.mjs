import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute = promisify(execFile);
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const repo = resolve('.');
const root = join(process.env.RUNNER_TEMP, 'mac-updater-build');
mkdirSync(root, { recursive: true, mode: 0o700 });
const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const key = join(root, 'throwaway.key');
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run through pnpm exec node');
const run = (cwd, args, env, log) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [pnpm, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = bytes => { output += bytes; };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', reject);
  child.once('exit', (code, signal) => { writeFileSync(log, output); code === 0 ? resolve() : reject(new Error(`${args.join(' ')} failed ${code}/${signal}; see ${log}`)); });
});
const env = { ...process.env, COTAL_SKIP_CONNECTOR_SEED: '1', DO_NOT_TRACK: '1' };
for (const name of Object.keys(env)) if (name.startsWith('TAURI_SIGNING_') || name.startsWith('COTAL_UPDATER_')) delete env[name];
try {
  await run(repo, ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'generate', '--ci', '--write-keys', key], env, join(root, 'private-signer.log'));
  chmodSync(key, 0o600); chmodSync(`${key}.pub`, 0o600);
  const trust = readFileSync(`${key}.pub`, 'utf8').trim();
  const endpoint = 'http://127.0.0.1:43189/latest.json';
  const proofEnv = { ...env, COTAL_UPDATER_PUBLIC_KEY: trust, COTAL_UPDATER_TEST_ENDPOINT: endpoint, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  for (const [name, version] of [['N', '0.164.8'], ['target', '0.164.9']]) {
    const cwd = join(root, name);
    await execute('git', ['worktree', 'add', '--detach', cwd, head], { cwd: repo });
    await run(cwd, ['install', '--frozen-lockfile'], env, join(root, `${name}-install.log`));
    await run(cwd, ['exec', 'node', 'desktop/test/mac-updater-version.mjs', version], proofEnv, join(root, `${name}-version.log`));
    await execute(process.execPath, ['packages/workspace/scripts/build-native.mjs'], { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    await execute(process.execPath, ['packages/seat/scripts/build-native.mjs', '--host'], { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    await run(cwd, ['--workspace-concurrency=2', '--filter', 'cotal-ai...', 'build'], env, join(root, `${name}-build.log`));
    await run(cwd, ['--filter', 'cotal-ai', 'seeded-connectors'], env, join(root, `${name}-seed.log`));
    await run(cwd, ['--dir', 'desktop', 'prepare:runtime'], env, join(root, `${name}-runtime.log`));
    await run(cwd, ['--dir', 'desktop', 'check:runtime'], env, join(root, `${name}-runtime-check.log`));
    await run(cwd, ['--dir', 'desktop', 'exec', 'tauri', 'build', '--debug', '--features', 'updater-e2e', '--bundles', 'app', '--config', 'src-tauri/updater-proof.json'], proofEnv, join(root, `${name}-native.log`));
    const directory = join(cwd, 'desktop/src-tauri/target/debug/bundle/macos');
    const archives = readdirSync(directory).filter(file => file.endsWith('.app.tar.gz'));
    assert.equal(archives.length, 1, 'One actual Tauri updater bundle is required');
    copyFileSync(join(directory, archives[0]), join(root, `${name}.app.tar.gz`));
    copyFileSync(join(directory, `${archives[0]}.sig`), join(root, `${name}.app.tar.gz.sig`));
    const executable = join(directory, 'Cotal.app/Contents/MacOS/cotal-desktop');
    const config = JSON.parse((await execute(executable, ['--updater-config'])).stdout);
    assert.deepEqual(config.endpoints, [endpoint]); assert.equal(config.test, true);
  }
  const invalid = [
    { name: 'feature', env: proofEnv, args: ['--features', 'updater-e2e'] },
    { name: 'endpoint', env: { ...env, COTAL_UPDATER_TEST_ENDPOINT: endpoint }, args: [] },
    { name: 'insecure', env: { ...env, COTAL_UPDATER_INSECURE: '1' }, args: [] },
  ];
  const refusalDirectory = join(root, 'N');
  for (const control of invalid) {
    const log = join(root, `release-refuses-${control.name}.log`);
    let refused = false;
    try { await run(refusalDirectory, ['--dir', 'desktop', 'exec', 'tauri', 'build', '--no-bundle', ...control.args], control.env, log); }
    catch { refused = readFileSync(log, 'utf8').includes('Release builds refuse updater test features, endpoints and insecure transport inputs'); }
    assert.equal(refused, true, `Release must refuse ${control.name} at the actual build input guard`);
  }
  const invalidArchive = join(root, 'invalid-install.tar.gz');
  writeFileSync(invalidArchive, 'signed invalid updater archive, test-owned input\n');
  await run(repo, ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'sign', '--app-version', '0.164.9', invalidArchive], proofEnv, join(root, 'invalid-install-sign.log'));
  writeFileSync(join(root, 'build-result.json'), JSON.stringify({ schema: 1, source: head, versions: ['0.164.8', '0.164.9'], debug: true, endpoint: 'http://127.0.0.1:43189/latest.json', signing: 'disposable updater key and ad-hoc platform signatures' }, null, 2));
} finally {
  // Keep build evidence, never the generated private material or signer output.
  for (const file of [key, `${key}.pub`, join(root, 'private-signer.log')]) rmSync(file, { force: true });
}
