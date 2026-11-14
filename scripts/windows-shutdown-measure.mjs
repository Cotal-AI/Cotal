import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32', 'Windows only');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = resolve(process.env.SHUTDOWN_PACKAGE_ROOT);
const cli = join(root, 'dist', 'cotal.js');
const recorder = resolve('scripts/windows-shutdown-record.cjs');
const output = resolve('scripts/shutdown-records');
mkdirSync(output, { recursive: true });
const rounds = Number(process.env.SHUTDOWN_ROUNDS || 40);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 40);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(join(root, 'package.json'));
const seat = require.resolve('@cotal-ai/seat');
const { mkSecretDir } = await import(pathToFileURL(require.resolve('@cotal-ai/core')).href);
const { processStartTime } = await import(pathToFileURL(seat).href);
const base = mkdtempSync(join(process.env.RUNNER_TEMP, 'csp-'));
mkSecretDir(base);
const calls = [];
const results = [];
let counter = 0;
function call(home, verb, flags = [], script) {
  const id = ++counter;
  const argv = [`--require=${recorder}`, ...(script ? ['--input-type=module', '-e', script] : [cli, 'daemon', verb, '--daemon-home', home, '--json', ...flags])];
  const started = new Date().toISOString();
  const child = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 240_000, maxBuffer: 512 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(output, `call-${id}.stdout`), child.stdout || '');
  writeFileSync(join(output, `call-${id}.stderr`), child.stderr || '');
  let body;
  try { body = JSON.parse(child.stdout); } catch { /* The raw result stays in the artifact. */ }
  const row = { id, home, verb, flags, started, ended: new Date().toISOString(), pid: child.pid, exit: child.status, signal: child.signal, error: child.error?.message, outcome: body?.outcome, code: body?.error?.code, nativeCode: body?.error?.cause?.code, message: body?.error?.message };
  calls.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(join(output, 'calls.json'), JSON.stringify(calls, null, 2));
  assert.ok(!child.error && !child.signal && child.status !== null, `${verb}: unknown outcome, no repeat`);
  return { row, body };
}
function ok(home, verb, flags = []) {
  const result = call(home, verb, flags);
  assert.equal(result.row.exit, 0, `${verb}: ${JSON.stringify(result.row)}`);
  return result.body.result;
}
async function ready(home) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = call(home, 'status');
    if (result.row.exit === 0 && result.body.result?.state === 'ready') return result.body.result;
    assert.equal(result.row.nativeCode, 'NOT_RUNNING', 'readiness does not suppress ownership refusals');
    assert.ok(Date.now() < deadline, 'daemon readiness deadline');
    await delay(500);
  }
}
const summary = { package: manifest.name, version: manifest.version, node: process.version, runner: process.env.RUNNER_OS, run: process.env.GITHUB_RUN_ID, rounds, results, calls, surface: 'restartInstalled from shipped install.js, identical to existing real-service test' };
try {
  // This diagnostic documents the literal brief command without claiming it stops a daemon.
  const diagnostic = join(base, 'surface');
  mkSecretDir(diagnostic);
  call(diagnostic, 'restart');
  for (let round = 1; round <= rounds; round++) {
    const home = join(base, String(round));
    mkSecretDir(home);
    const result = { round, home, checks: {} };
    results.push(result);
    const plan = ok(home, 'install', ['--dry-run']);
    result.unit = plan.unit;
    ok(home, 'install');
    const before = await ready(home);
    const birth = processStartTime(before.pid);
    assert.ok(birth, 'kernel birth before stop');
    const receipt = readFileSync(join(home, 'service-unit.json'));
    const source = readFileSync(plan.unitPath);
    const script = `process.argv=[process.execPath,${JSON.stringify(cli)}]; process.execArgv=[${JSON.stringify(`--require=${recorder}`)}]; const {restartInstalled}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/install.js')).href)}); const {daemonPathsFor}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/endpoint.js')).href)}); await restartInstalled(daemonPathsFor(${JSON.stringify(home)}),${JSON.stringify(home)});`;
    const restarted = call(home, 'restartInstalled', [], script);
    result.restart = restarted.row;
    if (restarted.row.exit === 0) {
      const after = await ready(home);
      result.checks.restartOldLifetimeGone = processStartTime(before.pid) !== birth;
      result.checks.restartNewLifetime = after.pid !== before.pid || processStartTime(after.pid) !== birth;
      result.checks.restartReceiptRetained = readFileSync(join(home, 'service-unit.json')).equals(receipt);
      result.checks.restartSourceRetained = readFileSync(plan.unitPath).equals(source);
      result.checks.restartTaskPresent = ok(home, 'uninstall', ['--dry-run']).unit === plan.unit;
      assert.ok(Object.values(result.checks).every(Boolean), 'restart completion evidence');
    }
    // A fresh install is required for every uninstall path, including when restart failed.
    // This is a separate installation, never a retry of a refused mutation.
    const uninstallHome = join(base, `u${round}`);
    mkSecretDir(uninstallHome);
    const uninstallPlan = ok(uninstallHome, 'install', ['--dry-run']);
    ok(uninstallHome, 'install');
    const uninstallBefore = await ready(uninstallHome);
    const uninstallBirth = processStartTime(uninstallBefore.pid);
    assert.ok(uninstallBirth, 'uninstall kernel birth');
    const removed = call(uninstallHome, 'uninstall', ['--yes']);
    result.uninstall = removed.row;
    if (removed.row.exit === 0) {
      const absent = call(uninstallHome, 'status');
      result.checks.uninstallEndpointAbsent = absent.row.nativeCode === 'NOT_RUNNING';
      result.checks.uninstallOldLifetimeGone = processStartTime(uninstallBefore.pid) !== uninstallBirth;
      result.checks.uninstallReceiptRemoved = !existsSync(join(uninstallHome, 'service-unit.json'));
      result.checks.uninstallSourceRemoved = !existsSync(uninstallPlan.unitPath);
      result.checks.uninstallNativeTaskAbsent = ok(uninstallHome, 'install', ['--dry-run']).state === 'would-install';
      assert.ok(Object.values(result.checks).every(Boolean), 'uninstall completion evidence');
    }
    // Retire a successful restart's separate installation once, through stock authorization.
    if (restarted.row.exit === 0) result.restartCleanup = call(home, 'uninstall', ['--yes']).row;
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  }
} catch (error) {
  summary.failure = error.stack;
  process.exitCode = 1;
} finally {
  summary.counts = Object.fromEntries(['restart', 'uninstall'].map(key => [key, { attempted: results.filter(r => r[key]).length, succeeded: results.filter(r => r[key]?.exit === 0).length, failed: results.filter(r => r[key] && r[key].exit !== 0).length }]));
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ counts: summary.counts, failure: summary.failure }));
}
