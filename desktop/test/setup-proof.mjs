import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const cell = process.argv[2];
const candidate = process.env.COTAL_SETUP_CANDIDATE;
assert.ok(candidate && existsSync(candidate));
const output = join(process.env.RUNNER_TEMP, 'setup-proof', cell);
mkdirSync(output, { recursive: true });
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const setupHome = join(process.env.LOCALAPPDATA, 'CotalSetup');
const node = join(root, 'node.exe');
const runtime = join(root, 'runtime');
const cli = join(runtime, 'dist', 'cotal.js');
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const report = { head: process.env.GITHUB_SHA, cell, calls: [], checks: [], limits: [] };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
Object.assign(env, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', COTAL_SETUP_ROOT: root, COTAL_SETUP_VERSION: '0.164.9' });
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
const check = (name, value) => { report.checks.push({ name, passed: Boolean(value) }); save(); assert.ok(value, name); };
const run = (file, args, timeout = 180_000) => new Promise(resolve => {
  const start = Date.now();
  execFile(file, args, { env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const result = { file, args, elapsedMs: Date.now() - start, code: error ? typeof error.code === 'number' ? error.code : null : 0, signal: error?.signal ?? null, error: error?.message, stdout, stderr };
    report.calls.push(result); save(); resolve(result);
  });
});
const daemon = (verb, ...args) => run(node, [cli, 'daemon', verb, '--json', ...args]);
const required = async (file, args, timeout) => { const result = await run(file, args, timeout); assert.equal(result.code, 0, result.stderr || result.stdout); return result; };
async function ready(version) {
  const until = Date.now() + 90_000;
  do {
    const result = await daemon('status');
    if (result.code === 0 && JSON.parse(result.stdout).result.version === version) return JSON.parse(result.stdout).result;
    await delay(500);
  } while (Date.now() < until);
  throw new Error(`Service did not answer ${version}`);
}
function inventory() {
  const rows = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, file);
      else if (entry.isFile()) rows.push({ file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      else throw new Error('Unexpected non-file in owned installation');
    }
  }
  visit(root);
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function compare(before, after) {
  writeFileSync(join(output, 'files-before.json'), JSON.stringify(before));
  writeFileSync(join(output, 'files-after.json'), JSON.stringify(after));
  const all = new Map(after.map(row => [row.file, row.sha256]));
  const changed = before.filter(row => all.get(row.file) !== row.sha256);
  report.changed = changed;
  const shipped = before.filter(row => row.file.startsWith('runtime/') || ['node.exe', 'cotal-desktop.exe', 'uninstall.exe'].includes(row.file));
  check('Every shipped application file is unchanged on refusal', shipped.every(row => all.get(row.file) === row.sha256));
  report.mutableChanges = changed.filter(row => !shipped.includes(row)).map(row => row.file);
}
let fixture, seat, locker, app;
let serviceInstalled = false;
try {
  assert.equal(existsSync(root), false, 'Each proof cell requires a fresh runner');
  const sourceVersion = cell === 'early' ? '0.157.0' : '0.164.7';
  const previous = join(process.env.RUNNER_TEMP, `Cotal_${sourceVersion}_x64-setup.exe`);
  assert.ok(existsSync(previous), 'Workflow must download and verify published source installer');
  if (cell !== 'fresh') await required(previous, ['/S']);
  if (cell !== 'fresh') check('Published files are installed', JSON.parse(readFileSync(join(runtime, 'package.json'))).version === sourceVersion);
  if (!['absent', 'fresh', 'foreign'].includes(cell)) {
    await required(node, [cli, 'daemon', 'install', '--json']); serviceInstalled = true;
    report.before = await ready(sourceVersion);
  }
  if (cell === 'foreign') {
    const foreignCli = join(process.env.RUNNER_TEMP, 'cli-service', 'node_modules', 'cotal-ai', 'dist', 'cotal.js');
    await required(process.execPath, [foreignCli, 'daemon', 'install', '--json']);
    report.foreignCli = foreignCli;
    serviceInstalled = true;
    const status = await required(process.execPath, [foreignCli, 'daemon', 'status', '--json']);
    report.before = JSON.parse(status.stdout).result;
    report.foreignReceipt = readFileSync(join(root, 'daemon', 'service-unit.json'), 'utf8');
  }
  if (cell === 'stopped') {
    const helper = join(repo, 'desktop/src-tauri/installers/service-update.mjs');
    // Establish an installed but stopped service through the same real graceful stop handshake.
    await required(process.execPath, [helper, 'prepare', root, '0.164.9']);
    await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/src-tauri/installers/service-task.ps1'), '-Action', 'enable']);
    rmSync(join(setupHome, 'service-update.json'));
    const stopped = await daemon('status');
    check('Fixture begins with a genuinely stopped installed service', JSON.parse(stopped.stdout).error?.cause?.code === 'NOT_RUNNING');
  }
  if (cell === 'interrupted') {
    const helper = join(repo, 'desktop/src-tauri/installers/service-update.mjs');
    await required(process.execPath, [helper, 'prepare', root, '0.164.9']);
    const taskScript = join(repo, 'desktop/src-tauri/installers/service-task.ps1');
    const attempted = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScript, '-Action', 'start']);
    check('Disabled task refuses launch while replacement barrier is held', attempted.code !== 0);
    const native = JSON.parse((await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScript, '-Action', 'inspect'])).stdout);
    check('Disabled task remains empty under explicit launch challenge', native.enabled === false && native.instances === 0);
    // A real interrupted copy has overwritten the manifest but not completed runtime publication.
    const handover = JSON.parse(readFileSync(join(setupHome, 'service-update.json')));
    handover.targetVersion = '0.164.8';
    writeFileSync(join(setupHome, 'service-update.json'), JSON.stringify(handover));
    writeFileSync(join(runtime, 'package.json'), '{"name":"cotal-ai","version":"0.164.8","type":"module"}');
    if (existsSync(join(repo, 'desktop/src-tauri/target/release/cotal-desktop.exe'))) {
      const guarded = await run(join(repo, 'desktop/src-tauri/target/release/cotal-desktop.exe'), ['--daemon']);
      check('New native launcher refuses unfinished handover before Node launch', guarded.code !== 0);
    }
    report.interrupted = true;
  }
  if (cell === 'app-open' || cell === 'app-tray') {
    app = spawn(join(root, 'cotal-desktop.exe'), [], { env, stdio: 'ignore', windowsHide: false });
    await delay(8000);
    check('Published app remains open while setup starts', app.pid && app.exitCode === null);
    if (cell === 'app-tray') {
      await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${app.pid} -ErrorAction Stop; if(!$p.CloseMainWindow()){throw 'Could not close owned app window to tray'}`]);
      await delay(1000);
      check('Owned app stays alive in tray', app.exitCode === null);
    }
  }
  if (cell === 'locker') {
    locker = spawn(node, ['-e', 'setInterval(()=>{},1000)'], { env, windowsHide: true, stdio: 'ignore' });
    await delay(1000);
    check('Real bundled Node locker stays alive', locker.pid && locker.exitCode === null);
  }
  if (cell === 'occupied' || cell === 'occupied-ui') {
    Object.assign(process.env, env);
    const { createFixtureSpace } = await import('../../bin/smoke/_fixture-space.mjs');
    const { installFixtureSeat } = await import('../../bin/smoke/_fixture-seat.mjs');
    fixture = await createFixtureSpace({ root: join(process.env.RUNNER_TEMP, 'seat-fixture'), machineHome: root, runtime, node, env });
    seat = await installFixtureSeat({ root: join(process.env.RUNNER_TEMP, 'seat-fixture'), runtime, node, env, cwd: fixture.participant, space: fixture.space });
    const manager = await fixture.startManager();
    report.manager = manager;
    report.seat = await seat.spawn(manager.instanceId);
    const birth = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${report.seat.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]);
    report.seat.birth = birth.stdout.trim();
    const status = JSON.parse((await daemon('status')).stdout).result;
    check('Real hosted Manager inventory contains the live fixture', status.agents.some(row => row.state === 'read' && row.agents.some(agent => agent.name === 'upgrade_fixture' && agent.state === 'running')));
  }
  const before = cell === 'fresh' ? [] : inventory();
  const start = Date.now();
  let result;
  if (cell === 'interactive' || cell === 'occupied-ui') {
    result = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/test/setup-ui.ps1'), '-Installer', candidate, '-Mode', cell === 'occupied-ui' ? 'occupied' : 'install', '-Output', join(output, 'ui.json')], 300_000);
    check('Actual UI Automation driver completed', result.code === 0);
    report.ui = JSON.parse(result.stdout);
    result.code = report.ui.exitCode;
  } else result = await run(candidate, ['/S'], 420_000);
  report.setup = result;
  report.setupElapsedMs = Date.now() - start;
  const diagnostic = JSON.parse(readFileSync(join(setupHome, 'result.json')));
  report.diagnostic = diagnostic;
  if (cell === 'interactive') {
    const ui = JSON.parse(readFileSync(join(output, 'ui.json'), 'utf8').replace(/^\uFEFF/, ''));
    check('Newer default click-through never offers the unsafe old-uninstaller choice', !ui.some(row => row.names.some(name => /uninstall before installing/i.test(name))));
  }
  if (['occupied', 'occupied-ui', 'locker', 'early', 'cannot-start'].includes(cell)) {
    check('Setup refuses before replacing files', result.code !== 0);
    compare(before, inventory());
    check('Service remains old and running', (await ready(sourceVersion)).pid === report.before.pid);
    if (seat) {
      const birth = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${report.seat.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]);
      check('Same real fixture process survives refusal', birth.stdout.trim() === report.seat.birth);
      check('Occupied refusal names agent count', diagnostic.code === 20 && diagnostic.activeAgents >= 1);
    }
    if (cell === 'cannot-start') check('Missing helper produces persistent refusal instead of success', diagnostic.code === 21 && diagnostic.message.includes('helper did not complete'));
    if (cell === 'early') check('Early shipped service lacks graceful stop and reports supported remedy', diagnostic.message.includes('uninstall --yes'));
  } else {
    check('Setup confirms success', result.code === 0);
    check('New files are installed', JSON.parse(readFileSync(join(runtime, 'package.json'))).version === '0.164.9');
    if (cell === 'foreign') {
      const status = JSON.parse((await required(process.execPath, [report.foreignCli, 'daemon', 'status', '--json'])).stdout).result;
      check('Foreign CLI service keeps its old PID and version', status.pid === report.before.pid && status.version === report.before.version);
      check('Foreign service receipt is unchanged', readFileSync(join(root, 'daemon', 'service-unit.json'), 'utf8') === report.foreignReceipt);
      check('Setup names untouched foreign service', diagnostic.message.includes('another installation'));
    } else if (cell === 'absent' || cell === 'fresh') check('No service was installed', !existsSync(join(root, 'daemon/service-unit.json')));
    else if (cell === 'stopped') {
      const stopped = await daemon('status');
      check('Previously stopped service stays stopped', stopped.code !== 0 && JSON.parse(stopped.stdout).error.cause.code === 'NOT_RUNNING');
    } else report.after = await ready('0.164.9');
  }
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  if (seat) { await seat.stop(report.manager.instanceId).catch(error => { report.seatCleanupFailure = error.message; process.exitCode = 1; }); }
  if (app?.exitCode === null) { const ended = new Promise(resolve => app.once('exit', resolve)); app.kill(); await ended; }
  if (locker?.exitCode === null) { const ended = new Promise(resolve => locker.once('exit', resolve)); locker.kill(); await ended; }
  if (serviceInstalled) { const result = report.foreignCli ? await run(process.execPath, [report.foreignCli, 'daemon', 'uninstall', '--yes', '--json']) : await daemon('uninstall', '--yes'); report.cleanup = result; if (result.code !== 0) process.exitCode = 1; }
  await fixture?.close();
  save();
  console.log(JSON.stringify({ cell, failure: report.failure, checks: report.checks, output }, null, 2));
}
