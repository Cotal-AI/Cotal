import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const installation = join(process.env.LOCALAPPDATA, 'Cotal');
const root = join(installation, 'runtime');
const node = join(installation, 'node.exe');
const cli = join(root, 'dist/cotal.js');
const home = join(installation, 'daemon');
const output = resolve('scripts/shutdown-records');
const recorder = resolve('scripts/windows-shutdown-record.cjs');
mkdirSync(output, { recursive: true });
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
assert.equal(version, process.env.SHUTDOWN_EXPECTED_VERSION || '0.164.8');
assert.ok(existsSync(node) && existsSync(join(installation, 'cotal-desktop.exe')));
const { processStartTime } = await import(pathToFileURL(join(root, 'node_modules/@cotal-ai/seat/dist/index.js')).href);
const mode = process.env.SHUTDOWN_MODE;
assert.ok(['restart', 'disabled-start'].includes(mode));
const report = { package: 'cotal-ai', version, runner: 'Windows', run: process.env.GITHUB_RUN_ID, mode, installation, rounds: 40, calls: [], results: [], serverLimit: 'Published GUI launcher filters preload flags and NODE_OPTIONS, no product source changed.' };
let id = 0;
function call(verb, flags = [], script) {
  const started = new Date().toISOString();
  const child = spawnSync(node, [`--require=${recorder}`, ...(script ? ['--input-type=module', '-e', script] : [cli, 'daemon', verb, '--json', ...flags])], { encoding: 'utf8', timeout: 240_000, maxBuffer: 512 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const row = { id: ++id, verb, started, ended: new Date().toISOString(), pid: child.pid, exit: child.status, signal: child.signal, error: child.error?.message };
  writeFileSync(join(output, `call-${id}.stdout`), child.stdout || '');
  writeFileSync(join(output, `call-${id}.stderr`), child.stderr || '');
  let body;
  try { body = JSON.parse(child.stdout); } catch { /* Original bytes retained. */ }
  Object.assign(row, { code: body?.error?.code, nativeCode: body?.error?.cause?.code, message: body?.error?.message });
  report.calls.push(row);
  writeFileSync(join(output, 'calls.json'), JSON.stringify(report.calls, null, 2));
  console.log(JSON.stringify(row));
  assert.ok(!child.error && !child.signal && child.status !== null, `${verb} outcome unknown, not repeated`);
  return { row, body };
}
function ok(verb, flags) {
  const r = call(verb, flags);
  assert.equal(r.row.exit, 0, JSON.stringify(r.row));
  return r.body.result;
}
async function observe(ready) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = call('status');
    if (ready && r.row.exit === 0 && r.body.result?.state === 'ready') return r.body.result;
    if (!ready && r.row.nativeCode === 'NOT_RUNNING') return;
    assert.ok(r.row.exit === 0 || r.row.nativeCode === 'NOT_RUNNING', 'observation preserves identity refusal');
    assert.ok(Date.now() < deadline, 'bounded status observation');
    await delay(200);
  }
}
try {
  const initial = call('status');
  assert.equal(initial.row.nativeCode, 'NOT_RUNNING', 'default service absent before measurement');
  for (let round = 1; round <= 40; round++) {
    const result = { round, checks: {} };
    report.results.push(result);
    const plan = ok('install', ['--dry-run']);
    ok('install');
    let before = await observe(true);
    const receipt = readFileSync(join(home, 'service-unit.json'));
    result.unit = plan.unit;
    result.daemonPid = before.pid;
    result.daemonBirth = processStartTime(before.pid);
    const identity = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:SHUTDOWN_PEER_PID);if(!$p){throw 'Daemon absent'};$q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId);@{pid=[int]$p.ProcessId;path=$p.ExecutablePath;parentPid=[int]$q.ProcessId;parentPath=$q.ExecutablePath}|ConvertTo-Json -Compress"], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: Object.fromEntries(Object.entries({ ...process.env, SHUTDOWN_PEER_PID: String(before.pid) }).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')) });
    assert.ok(identity.status === 0 && !identity.error && !identity.signal, 'read exact service executable parent');
    result.identity = JSON.parse(identity.stdout);
    assert.equal(result.identity.path.toLowerCase(), node.toLowerCase());
    assert.equal(result.identity.parentPath.toLowerCase(), join(installation, 'cotal-desktop.exe').toLowerCase());
    result.parentBirth = processStartTime(result.identity.parentPid);
    const source = readFileSync(plan.unitPath);
    assert.match(source.toString('utf16le'), /cotal-desktop\.exe/);
    assert.match(source.toString('utf16le'), /<Arguments>--daemon<\/Arguments>/);
    assert.match(plan.unit, /^cotal-daemon-S-1-/);
    result.checks.desktopLauncherSource = true;
    if (mode === 'restart') {
      const birth = processStartTime(before.pid);
      const script = `process.argv=[process.execPath,${JSON.stringify(cli)}];process.execArgv=[];const {restartInstalled}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/install.js')).href)});const {daemonPaths}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/endpoint.js')).href)});await restartInstalled(daemonPaths());`;
      result.restart = call('restartInstalled', [], script).row;
      assert.equal(result.restart.exit, 0, 'restart refusal retained, no command retry');
      const after = await observe(true);
      result.checks.oldRestartLifetimeGone = processStartTime(before.pid) !== birth;
      result.checks.newRestartLifetime = after.pid !== before.pid || processStartTime(after.pid) !== birth;
      before = after;
    } else {
      ok('uninstall', ['--dry-run']);
      const script = `process.argv=[process.execPath,${JSON.stringify(cli)}];process.execArgv=[];const {spawnSync}=await import('node:child_process');const {join}=await import('node:path');const {openVerified}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/client.js')).href)});const {daemonPaths}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/endpoint.js')).href)});const {requestInstalledDaemon}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/install.js')).href)});const {processBirth,readLifetimeRecord}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/daemon/lifetime.js')).href)});const paths=daemonPaths();const socket=await openVerified({paths});socket.on('error',()=>{});try{const owner=readLifetimeRecord(paths.lock);await requestInstalledDaemon(socket,'daemon-stop');for(const args of [["/Change","/TN",${JSON.stringify(plan.unit)},"/DISABLE"],["/End","/TN",${JSON.stringify(plan.unit)}]]){const r=spawnSync(join(process.env.SystemRoot,'System32/schtasks.exe'),args,{encoding:'utf8',timeout:30000,windowsHide:true});if(r.error||r.signal||r.status!==0)throw new Error('owned native pause failed');}if(processBirth(owner.pid)===owner.start)await requestInstalledDaemon(socket,'daemon-stop',true);}finally{socket.destroy();}`;
      result.prepareDisabled = call('prepareDisabled', [], script).row;
      assert.equal(result.prepareDisabled.exit, 0, 'pinned two-phase disabled preparation completes');
      await observe(false);
      ok('start');
      before = await observe(true);
    }
    result.checks.receiptPreserved = readFileSync(join(home, 'service-unit.json')).equals(receipt);
    result.checks.sourcePreserved = readFileSync(plan.unitPath).equals(source);
    const birth = processStartTime(before.pid);
    assert.ok(birth);
    result.uninstall = call('uninstall', ['--yes']).row;
    assert.equal(result.uninstall.exit, 0, 'uninstall refusal retained, no retry on same default service');
    await observe(false);
    result.checks.oldLifetimeGone = processStartTime(before.pid) !== birth;
    result.checks.receiptRemoved = !existsSync(join(home, 'service-unit.json'));
    result.checks.sourceRemoved = !existsSync(plan.unitPath);
    result.checks.taskAbsent = ok('install', ['--dry-run']).state === 'would-install';
    assert.ok(Object.values(result.checks).every(Boolean));
    writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  for (const name of ['daemon.log', 'service-unit.json', 'service-task.xml']) if (existsSync(join(home, name))) copyFileSync(join(home, name), join(output, `final-${name}`));
  report.counts = { rounds: report.results.length, uninstallAttempted: report.results.filter(r => r.uninstall).length, uninstallRefused: report.results.filter(r => r.uninstall && r.uninstall.exit !== 0).length, restartAttempted: report.results.filter(r => r.restart).length, restartRefused: report.results.filter(r => r.restart && r.restart.exit !== 0).length };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ counts: report.counts, failure: report.failure }));
}
