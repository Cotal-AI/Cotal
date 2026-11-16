// Measures what survives when only the desktop app dies.
// Starts the installed candidate app with the service installed, waits for the
// status-watch bridge (node.exe running cotal.js daemon desktop), then kills
// only cotal-desktop.exe with TerminateProcess. Two seconds later it records
// every process whose image is under the install folder. The required result is
// no node.exe from that folder. It then runs the next version's installer over
// the same folder and requires setup code 0, the service answering at the new
// version, and the app starting. A surviving bridge is the finding: the script
// records it and stops before the installer, and changes no product code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');

const readText = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const baseVersion = JSON.parse(readText(new URL('../../bin/package.json', import.meta.url))).version;
assert.match(baseVersion ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable base version required in bin/package.json');
const candidateVersion = baseVersion.replace(/\d+$/, patch => String(Number(patch) + 1000));
const nextVersion = baseVersion.replace(/\d+$/, patch => String(Number(patch) + 2000));

const output = join(process.env.RUNNER_TEMP, 'setup-proof', 'bridge-hard-exit');
mkdirSync(output, { recursive: true });
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const node = join(root, 'node.exe');
const runtime = join(root, 'runtime');
const cli = join(runtime, 'dist', 'cotal.js');
const appExe = join(root, 'cotal-desktop.exe');
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const candidate = process.env.COTAL_SETUP_CANDIDATE;
const next = process.env.COTAL_SETUP_NEXT;
assert.ok(candidate && existsSync(candidate), 'Candidate installer required in COTAL_SETUP_CANDIDATE');
assert.ok(next && existsSync(next), 'Next installer required in COTAL_SETUP_NEXT');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'PSModulePath'].includes(key)));
Object.assign(env, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });

const report = {
  head: process.env.GITHUB_SHA ?? null,
  cell: 'bridge-hard-exit',
  candidate: { file: candidate, sha256: createHash('sha256').update(readFileSync(candidate)).digest('hex'), version: candidateVersion },
  next: { file: next, sha256: createHash('sha256').update(readFileSync(next)).digest('hex'), version: nextVersion },
  checks: [],
};
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
const check = (name, value) => { report.checks.push({ name, passed: Boolean(value) }); save(); assert.ok(value, name); };
const run = (file, args, timeout = 300_000) => new Promise(resolve => {
  const start = Date.now();
  execFile(file, args, { env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ file, args, elapsedMs: Date.now() - start, code: error ? typeof error.code === 'number' ? error.code : null : 0, signal: error?.signal ?? null, error: error?.message ?? null, stdout, stderr });
  });
});
const psjson = async script => {
  const result = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const installFolderProcesses = () => psjson(
  `$ErrorActionPreference='Stop'; ` +
  `$root='${root.replaceAll("'", "''")}'; ` +
  `$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine} }); ` +
  `@{count=$rows.Count;processes=$rows} | ConvertTo-Json -Depth 4 -Compress`,
);

let app = null;
let serviceInstalled = false;
try {
  assert.equal(existsSync(root), false, 'Cell requires a fresh install folder');
  const installed = await run(candidate, ['/S']);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);
  check('Candidate installed', JSON.parse(readText(join(runtime, 'package.json'))).version === candidateVersion && existsSync(appExe));

  const daemonInstall = await run(node, [cli, 'daemon', 'install', '--json']);
  assert.equal(daemonInstall.code, 0, daemonInstall.stderr || daemonInstall.stdout);
  serviceInstalled = true;
  const readyUntil = Date.now() + 90_000;
  let before = null;
  while (Date.now() < readyUntil) {
    const status = await run(node, [cli, 'daemon', 'status', '--json']);
    if (status.code === 0) {
      const parsed = JSON.parse(status.stdout).result;
      if (parsed?.version === candidateVersion) { before = parsed; break; }
    }
    await delay(500);
  }
  assert.ok(before, 'Installed service did not answer');
  report.serviceBefore = { pid: before.pid, version: before.version };

  app = spawn(appExe, [], { env, stdio: 'ignore', windowsHide: false });
  const bridgeUntil = Date.now() + 60_000;
  let bridge = null;
  while (Date.now() < bridgeUntil) {
    const census = await installFolderProcesses();
    bridge = census.processes.find(row => row.name.toLowerCase() === 'node.exe' && /daemon desktop/.test(row.commandLine) && row.parentPid === app.pid) ?? null;
    if (bridge && app.exitCode === null) break;
    bridge = null;
    await delay(500);
  }
  report.bridge = bridge;
  report.appPid = app.pid;
  check('Status-watch bridge started under the app', Boolean(bridge) && app.exitCode === null);

  const killedAt = new Date().toISOString();
  const kill = await psjson(
    `$ErrorActionPreference='Stop'; ` +
    `Add-Type -Namespace Win32 -Name AppKill -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);'; ` +
    `$h=[Win32.AppKill]::OpenProcess(0x0001, $false, ${app.pid}); if($h -eq [IntPtr]::Zero){ throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }; ` +
    `try { if(-not [Win32.AppKill]::TerminateProcess($h, 1)){ throw "TerminateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } } finally { [Win32.AppKill]::CloseHandle($h) | Out-Null }; ` +
    `@{killedPid=${app.pid};at='${killedAt}'} | ConvertTo-Json -Compress`,
  );
  report.kill = kill;
  await delay(2000);
  const exit = await psjson(`$p=Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; @{alive=[bool]$p;exitAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`);
  report.appExit = exit;
  check('Only the app was killed and it is gone', exit.alive === false);

  const after = await installFolderProcesses();
  report.processesAfterKill = after.processes;
  const survivors = after.processes.filter(row => row.name.toLowerCase() === 'node.exe');
  report.bridgeSurvived = survivors.length > 0;
  report.bridgeExit = { pid: bridge.pid, alive: survivors.some(row => row.pid === bridge.pid), recordedAt: exit.exitAt };
  save();
  if (survivors.length > 0) {
    report.finding = 'bridge survived the app: node.exe from the install folder is still running two seconds after TerminateProcess on cotal-desktop.exe';
    save();
    throw new Error(report.finding);
  }
  check('No node.exe from the install folder two seconds after the app died', true);

  const setup = await run(next, ['/S'], 420_000);
  const diagnostic = JSON.parse(readText(join(process.env.LOCALAPPDATA, 'CotalSetup', 'result.json')));
  report.setup = { code: setup.code, elapsedMs: setup.elapsedMs, diagnostic };
  check('Next installer ends with setup code 0', setup.code === 0 && diagnostic.outcome === 'updated');
  check('Installed files are the next version', JSON.parse(readText(join(runtime, 'package.json'))).version === nextVersion);

  const answeredUntil = Date.now() + 120_000;
  let afterStatus = null;
  while (Date.now() < answeredUntil) {
    const status = await run(node, [cli, 'daemon', 'status', '--json']);
    if (status.code === 0) {
      const parsed = JSON.parse(status.stdout).result;
      if (parsed?.version === nextVersion) { afterStatus = parsed; break; }
    }
    await delay(500);
  }
  report.serviceAfter = afterStatus ? { pid: afterStatus.pid, version: afterStatus.version } : null;
  check('Service answers at the next version', afterStatus?.version === nextVersion);

  const relaunched = spawn(appExe, [], { env, stdio: 'ignore', windowsHide: false });
  await delay(8000);
  const started = relaunched.exitCode === null;
  report.appStarted = { pid: relaunched.pid, alive: started };
  if (relaunched.exitCode === null) relaunched.kill();
  check('App starts from the updated install', started);
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  save();
  if (app?.exitCode === null) app.kill();
  if (serviceInstalled && existsSync(node)) {
    const removed = await run(node, [cli, 'daemon', 'uninstall', '--json', '--yes']).catch(error => ({ code: null, error: error.message }));
    report.cleanup = { code: removed.code ?? null };
    save();
  }
}
