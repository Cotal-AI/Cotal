import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const repo = resolve('.');
const root = join(process.env.RUNNER_TEMP, 'win-updater-build');
mkdirSync(root, { recursive: true });
const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const key = join(root, 'throwaway.key');
const configKey = join(root, 'inert-config.key');
const keyId = encoded => {
  const lines = Buffer.from(encoded, 'base64').toString('utf8').trim().split(/\r?\n/);
  const raw = Buffer.from(lines.at(-1), 'base64');
  assert.equal(raw.length, 42, 'Expected a Tauri minisign public key');
  return raw.subarray(2, 10).toString('hex');
};
const mismatchWarnings = [];
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run through pnpm exec node');
const run = (cwd, args, env, log) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, [pnpm, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = bytes => { output += bytes; };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', rejectRun);
  child.once('exit', (code, signal) => { writeFileSync(log, output); code === 0 ? resolveRun() : rejectRun(new Error(`${args.join(' ')} failed ${code}/${signal}; see ${log}`)); });
});
const env = { ...process.env, COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' };
for (const name of Object.keys(env)) if (name.startsWith('TAURI_SIGNING_') || name.startsWith('COTAL_UPDATER_')) delete env[name];
const cwd = join(root, 'work');
try {
  await run(repo, ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'generate', '--ci', '--write-keys', key], env, join(root, 'private-signer.log'));
  const trust = readFileSync(`${key}.pub`, 'utf8').trim();
  await run(repo, ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'generate', '--ci', '--write-keys', configKey], env, join(root, 'private-config-signer.log'));
  const inertPubkey = readFileSync(`${configKey}.pub`, 'utf8').trim();
  rmSync(configKey, { force: true }); rmSync(join(root, 'private-config-signer.log'), { force: true });
  const fixtureKeyId = keyId(trust);
  const configKeyId = keyId(inertPubkey);
  assert.notEqual(configKeyId, fixtureKeyId, 'Config key must not verify fixture signatures');
  const endpoint = 'http://127.0.0.1:43189/latest.json';
  const proofEnv = { ...env, COTAL_UPDATER_PUBLIC_KEY: trust, COTAL_UPDATER_PROOF_CONFIG_PUBLIC_KEY: inertPubkey, COTAL_UPDATER_TEST_ENDPOINT: endpoint, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  await execute('git', ['worktree', 'add', '--detach', cwd, head], { cwd: repo });
  await run(cwd, ['install', '--frozen-lockfile'], env, join(root, 'work-install.log'));
  await execute(process.execPath, ['packages/workspace/scripts/build-native.mjs'], { cwd, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await execute(process.execPath, ['packages/seat/scripts/build-native.mjs', '--host'], { cwd, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  for (const [name, version] of [['N', '0.164.8'], ['N1', '0.164.9'], ['N2', '0.164.10']]) {
    rmSync(join(cwd, 'desktop/src-tauri/runtime'), { recursive: true, force: true });
    rmSync(join(cwd, 'desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe'), { force: true });
    rmSync(join(cwd, 'desktop/src-tauri/target/debug/bundle/nsis'), { recursive: true, force: true });
    await run(cwd, ['exec', 'node', 'desktop/test/mac-updater-version.mjs', version, ...(name === 'N1' ? ['--fault-daemon-serve', '--extra-preference'] : [])], proofEnv, join(root, `${name}-version.log`));
    const now = new Date();
    utimesSync(join(cwd, 'desktop/src-tauri/tauri.conf.json'), now, now);
    await run(cwd, ['--workspace-concurrency=3', '--filter', 'cotal-ai...', 'build'], env, join(root, `${name}-build.log`));
    await run(cwd, ['--filter', 'cotal-ai', 'seeded-connectors'], env, join(root, `${name}-seed.log`));
    await run(cwd, ['--dir', 'desktop', 'prepare:runtime'], env, join(root, `${name}-runtime.log`));
    await run(cwd, ['--dir', 'desktop', 'check:runtime'], env, join(root, `${name}-runtime-check.log`));
    const stagedManifest = JSON.parse(readFileSync(join(cwd, 'desktop/src-tauri/runtime/desktop-runtime.json'), 'utf8'));
    assert.equal(stagedManifest.version, version, `Staged runtime manifest must match ${version}`);
    await run(cwd, ['--dir', 'desktop', 'exec', 'tauri', 'build', '--debug', '--features', 'updater-e2e', '--bundles', 'nsis', '--config', 'src-tauri/updater-proof.json'], proofEnv, join(root, `${name}-native.log`));
    const warning = readFileSync(join(root, `${name}-native.log`), 'utf8').includes('does not match the public key from `plugins > updater > pubkey`');
    assert.equal(warning, true, 'Bundler must report the deliberately mismatched config key');
    mismatchWarnings.push({ build: name, version, observed: warning });
    const directory = join(cwd, 'desktop/src-tauri/target/debug/bundle/nsis');
    const installers = readdirSync(directory).filter(file => file.endsWith('-setup.exe'));
    assert.equal(installers.length, 1, 'One actual Tauri NSIS updater bundle is required');
    assert.equal(installers[0], `Cotal_${version}_x64-setup.exe`);
    copyFileSync(join(directory, installers[0]), join(root, `${name}-setup.exe`));
    copyFileSync(join(directory, `${installers[0]}.sig`), join(root, `${name}-setup.exe.sig`));
    const executable = join(cwd, 'desktop/src-tauri/target/debug/cotal-desktop.exe');
    const config = JSON.parse((await execute(executable, ['--updater-config'], { windowsHide: true })).stdout);
    assert.deepEqual(config.endpoints, [endpoint]); assert.equal(config.test, true);
  }
  const invalid = [
    { name: 'feature', env: proofEnv, args: ['--features', 'updater-e2e'] },
    { name: 'endpoint', env: { ...env, COTAL_UPDATER_TEST_ENDPOINT: endpoint }, args: [] },
    { name: 'insecure', env: { ...env, COTAL_UPDATER_INSECURE: '1' }, args: [] },
  ];
  for (const control of invalid) {
    const log = join(root, `release-refuses-${control.name}.log`);
    let refused = false;
    try { await run(cwd, ['--dir', 'desktop', 'exec', 'tauri', 'build', '--no-bundle', ...control.args], control.env, log); }
    catch { refused = readFileSync(log, 'utf8').includes('Release builds refuse updater test features, endpoints and insecure transport inputs'); }
    assert.equal(refused, true, `Release must refuse ${control.name} at the actual build input guard`);
  }
  const invalidInstaller = join(root, 'invalid-install.exe');
  writeFileSync(invalidInstaller, 'signed invalid updater installer, test-owned input\n');
  await run(repo, ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'sign', '-f', key, '--app-version', '0.164.9', invalidInstaller], { ...env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }, join(root, 'invalid-install-sign.log'));
  writeFileSync(join(root, 'build-result.json'), JSON.stringify({ schema: 1, source: head, versions: ['0.164.8', '0.164.9', '0.164.10'], debug: true, endpoint, signing: 'disposable updater key and unsigned NSIS bundles', fixturePubkey: trust, fixtureKeyId, configPubkey: inertPubkey, configKeyId, configEndpoints: [], mismatchWarnings }, null, 2));
} finally {
  for (const file of [key, `${key}.pub`, configKey, `${configKey}.pub`, join(root, 'private-signer.log'), join(root, 'private-config-signer.log')]) rmSync(file, { force: true });
  try { await execute('git', ['worktree', 'remove', '--force', cwd], { cwd: repo }); } catch { rmSync(cwd, { recursive: true, force: true }); }
}
