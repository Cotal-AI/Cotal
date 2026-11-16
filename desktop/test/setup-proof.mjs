import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const readText = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const baseVersion = JSON.parse(readText(new URL('../../bin/package.json', import.meta.url))).version;
assert.match(baseVersion ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable base version required in bin/package.json');
const candidateVersion = baseVersion.replace(/\d+$/, patch => String(Number(patch) + 1000));
const nextVersion = baseVersion.replace(/\d+$/, patch => String(Number(patch) + 2000));
const cell = process.argv[2];
const baseCandidate = process.env.COTAL_SETUP_CANDIDATE;
const nextHop = ['installed-candidate-to-next', 'app-installed', 'app-update-mode'].includes(cell);
const appInstalled = ['app-installed', 'app-update-mode', 'app-installed-0.164.9', 'app-installed-latest'].includes(cell);
const candidateNextChecks = ['installed-candidate-to-next', 'app-installed', 'app-update-mode', 'app-installed-0.164.9', 'app-installed-latest'].includes(cell);
const expectedVersion = nextHop ? nextVersion : candidateVersion;
const candidate = nextHop ? process.env.COTAL_SETUP_NEXT : baseCandidate;
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
const proofStartedAt = new Date().toISOString();
const report = { head: process.env.GITHUB_SHA, repeat: process.env.COTAL_SETUP_REPEAT ?? null, inheritedPSModulePath: process.env.PSModulePath ?? null, candidate: { kind: process.env.COTAL_SETUP_CANDIDATE_KIND ?? 'untraced', file: candidate, sha256: createHash('sha256').update(readFileSync(candidate)).digest('hex') }, cell, calls: [], checks: [], limits: [] };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'PSModulePath'].includes(key)));
Object.assign(env, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', COTAL_SETUP_ROOT: root, COTAL_SETUP_VERSION: expectedVersion });
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
const useFilteredToken = cell.endsWith('-filtered');
const filteredScratch = join(process.env.RUNNER_TEMP, 'setup-filtered', cell);
if (useFilteredToken) mkdirSync(filteredScratch, { recursive: true });
let filteredSeq = 0;
const runFiltered = async (file, args, timeout = 180_000) => {
  const start = Date.now();
  const id = ++filteredSeq;
  const specFile = join(filteredScratch, `filtered-spec-${id}.json`);
  const outFile = join(filteredScratch, `filtered-out-${id}.json`);
  const quotedArgs = args.map(a => /[\s"]/.test(a) ? `"${String(a).replaceAll('"', '\\"')}"` : String(a)).join(' ');
  report.filteredTokenEnvNames = Object.keys(env).sort();
  writeFileSync(specFile, JSON.stringify({ file, arguments: quotedArgs, env, timeoutMs: timeout, outFile }));
  try {
    const outer = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/test/setup-filtered-run.ps1'), '-Spec', specFile], timeout + 30_000);
    if (outer.code !== 0 || !existsSync(outFile)) {
      throw new Error(`Filtered runner failed (${outer.code}): ${outer.stderr || outer.stdout}`);
    }
    const inner = JSON.parse(readText(outFile));
    report.filteredTokenWhoami = inner.whoamiGroups;
    const result = { file, args, filteredToken: true, elapsedMs: Date.now() - start, code: inner.code, signal: null, stdout: inner.stdout, stderr: inner.stderr };
    report.calls.push(result);
    save();
    return result;
  } finally {
    rmSync(specFile, { force: true });
    rmSync(outFile, { force: true });
  }
};
const runUser = (file, args, timeout = 180_000) => useFilteredToken ? runFiltered(file, args, timeout) : run(file, args, timeout);
const requiredUser = async (file, args, timeout) => { const result = await runUser(file, args, timeout); assert.equal(result.code, 0, result.stderr || result.stdout); return result; };
const DAEMON_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SYSTEMROOT', 'WINDIR',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);
// Copies the spelling measured in the real app e2e run: plain node.exe and prefixed script path.
function installServiceViaAppBridge(usePrefix) {
  const prefixRoot = root.startsWith('\\\\?\\') ? root : `\\\\?\\${root}`;
  const bridgeNode = join(root, 'node.exe');
  const bridgeCli = `${usePrefix ? prefixRoot : root}\\runtime\\dist\\cotal.js`;
  const bridgeEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => DAEMON_ENV_KEYS.has(key.toUpperCase()))),
    DO_NOT_TRACK: '1',
  };
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(bridgeNode, [bridgeCli, 'daemon', 'desktop'], {
      env: bridgeEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, 150_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const frames = stdout.replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
      const progressFrames = frames.filter(frame => frame && frame.event === 'setup-progress');
      const resultFrame = frames.find(frame => frame && frame.event === 'result') ?? null;
      const call = {
        usePrefix,
        file: bridgeNode,
        args: [bridgeCli, 'daemon', 'desktop'],
        input: '{"op":"install"}\n',
        elapsedMs: Date.now() - start,
        code,
        signal,
        ok: code === 0 && resultFrame?.ok === true,
        progressFrames,
        resultFrame,
        stdout,
        stderr,
        frames,
      };
      report.appBridgeInstall = call;
      report.calls.push(call);
      save();
      resolve(call);
    });
    child.stdin.end('{"op":"install"}\n', 'utf8');
  });
}
async function observeInstalledService(label) {
  for (const [src, dst] of [
    [join(root, 'daemon', 'service-task.xml'), `service-task-${label}.xml`],
    [join(root, 'daemon', 'service-unit.json'), `service-unit-${label}.json`],
    [join(root, 'daemon', 'daemon.log'), `daemon-${label}.log`],
  ]) {
    if (existsSync(src)) writeFileSync(join(output, dst), readFileSync(src));
  }
  const daemonLogPath = join(root, 'daemon', 'daemon.log');
  const daemonLog = existsSync(daemonLogPath) ? readText(daemonLogPath) : null;
  const obs = await required(ps, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; ` +
    `Import-Module ScheduledTasks -ErrorAction SilentlyContinue; ` +
    `$receiptPath='${join(root, 'daemon', 'service-unit.json').replaceAll("'", "''")}'; ` +
    `$xmlPath='${join(root, 'daemon', 'service-task.xml').replaceAll("'", "''")}'; ` +
    `$receipt=if(Test-Path -LiteralPath $receiptPath){Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json}else{$null}; ` +
    `$xmlCommand=$null; $xmlArgs=$null; $xmlWorkDir=$null; ` +
    `if(Test-Path -LiteralPath $xmlPath){[xml]$xml=Get-Content -Raw -LiteralPath $xmlPath; $xmlCommand=[string]$xml.Task.Actions.Exec.Command; $xmlArgs=[string]$xml.Task.Actions.Exec.Arguments; $xmlWorkDir=[string]$xml.Task.Actions.Exec.WorkingDirectory}; ` +
    `$scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); ` +
    `$task=if($receipt){try{$scheduler.GetFolder('\\').GetTask($receipt.unit)}catch{$null}}else{$null}; ` +
    `$action=if($task -and $task.Definition.Actions.Count -ge 1){$task.Definition.Actions.Item(1)}else{$null}; ` +
    `$st=if($receipt){try{Get-ScheduledTask -TaskPath '\\' -TaskName $receipt.unit -ErrorAction Stop}catch{$null}}else{$null}; ` +
    `$sti=if($receipt){try{Get-ScheduledTaskInfo -TaskPath '\\' -TaskName $receipt.unit -ErrorAction Stop}catch{$null}}else{$null}; ` +
    `$procs=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | Where-Object { $_.Name -in @('cotal-desktop.exe','node.exe','uninstall.exe') -or ($_.ExecutablePath -and $_.ExecutablePath -like '*\\Cotal\\*') } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})} }); ` +
    `@{receipt=$receipt;xml=@{command=$xmlCommand;arguments=$xmlArgs;workingDirectory=$xmlWorkDir};task=$(if($task){@{name=$task.Name;enabled=[bool]$task.Enabled;state=[int]$task.State;scheduledTaskState=$(if($st){[string]$st.State}else{$null});instances=[int]$task.GetInstances(0).Count;lastRunTime=$(if($task.LastRunTime){$task.LastRunTime.ToUniversalTime().ToString('o')}else{$null});scheduledTaskLastRunTime=$(if($sti -and $sti.LastRunTime){$sti.LastRunTime.ToUniversalTime().ToString('o')}else{$null});lastTaskResult=[int]$task.LastTaskResult;lastTaskResultHex=('0x{0:X8}' -f ([uint32]([int64]$task.LastTaskResult -band 0xFFFFFFFFL)));scheduledTaskLastResult=$(if($sti){[int]$sti.LastTaskResult}else{$null});numberOfMissedRuns=$(if($sti){[int]$sti.NumberOfMissedRuns}else{$null});actionPath=$(if($action){[string]$action.Path}else{$null});actionArguments=$(if($action){[string]$action.Arguments}else{$null});actionWorkingDirectory=$(if($action){[string]$action.WorkingDirectory}else{$null})}}else{$null});processes=$procs} | ConvertTo-Json -Depth 6 -Compress`
  ]);
  const parsed = JSON.parse(obs.stdout);
  parsed.daemonLog = daemonLog;
  report[`serviceObservation_${label}`] = parsed;
  save();
  return parsed;
}
async function pollDaemonStatus(version, timeoutMs = 120_000) {
  const startedAt = Date.now();
  const until = startedAt + timeoutMs;
  let attempts = 0;
  let lastCall = null;
  do {
    attempts++;
    const result = await daemon('status');
    lastCall = { code: result.code, stdout: result.stdout, stderr: result.stderr, elapsedMs: result.elapsedMs };
    if (result.code === 0) {
      const parsed = JSON.parse(result.stdout).result;
      if (parsed.version === version) {
        const summary = {
          version,
          timeoutMs,
          startedAt: new Date(startedAt).toISOString(),
          answeredAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          attempts,
          answered: true,
          status: parsed,
          lastCall,
        };
        save();
        return summary;
      }
    }
    await delay(500);
  } while (Date.now() < until);
  const summary = {
    version,
    timeoutMs,
    startedAt: new Date(startedAt).toISOString(),
    answeredAt: null,
    elapsedMs: Date.now() - startedAt,
    attempts,
    answered: false,
    status: null,
    lastCall,
  };
  save();
  return summary;
}
async function ready(version) {
  const until = Date.now() + 90_000;
  do {
    const result = await daemon('status');
    if (result.code === 0 && JSON.parse(result.stdout).result.version === version) return JSON.parse(result.stdout).result;
    await delay(500);
  } while (Date.now() < until);
  throw new Error(`Service did not answer ${version}`);
}
async function observeDaemonLockState(label, statusPid) {
  const lockPath = join(root, 'daemon', 'daemon.lock');
  const exists = existsSync(lockPath);
  const st = exists ? statSync(lockPath) : null;
  const bytes = exists ? readText(lockPath) : null;
  let statusPidAlive = null;
  let statusPidBirth = null;
  if (Number.isInteger(statusPid) && statusPid > 0) {
    const procObs = await run(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $gp=Get-Process -Id ${statusPid} -ErrorAction SilentlyContinue; @{alive=[bool]($null -ne $gp);birth=$(if($gp){$gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null})} | ConvertTo-Json -Compress`,
    ], 15_000);
    if (procObs.code === 0) {
      const parsed = JSON.parse(procObs.stdout);
      statusPidAlive = parsed.alive;
      statusPidBirth = parsed.birth;
    }
  }
  const entry = {
    label,
    observedAt: new Date().toISOString(),
    lock: {
      exists,
      size: st ? st.size : null,
      mtime: st ? st.mtime.toISOString() : null,
      bytes,
    },
    statusPid: statusPid ?? null,
    statusPidAlive,
    statusPidBirth,
  };
  report.daemonLockBracket ??= {};
  report.daemonLockBracket[label] = entry;
  save();
  return entry;
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
async function observeSeatStop(label) {
  const result = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate); $ids=[Collections.Generic.HashSet[int]]::new(); $null=$ids.Add(${report.seat.pid}); ${[...new Set(report.seatProcessIds ?? [])].map(pid => `$null=$ids.Add(${pid});`).join(' ')} do { $changed=$false; foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$changed=$true}} } while($changed); ConvertTo-Json -InputObject @($rows|Where-Object{$ids.Contains([int]$_.ProcessId)}|ForEach-Object{@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})}}) -Compress`], 30_000);
  report.seatStopObservations ??= [];
  if (result.code === 0) {
    const rows = JSON.parse(result.stdout);
    report.seatProcessIds = [...new Set([...(report.seatProcessIds ?? []), ...rows.map(row => row.pid)])];
  }
  report.seatStopObservations.push({ label, observedAt: new Date().toISOString(), result });
  const log = join(root, 'daemon', `space.${Buffer.from(fixture.space).toString('hex')}`, 'manager', 'manager.log');
  for (const suffix of ['', '.1']) if (existsSync(log + suffix)) writeFileSync(join(output, `manager-${label}.log${suffix}`), readFileSync(log + suffix));
  save();
}
// Matches tauri-plugin-updater 2.14.1 install_inner / updater_parameters: ShellExecuteW "open"
// with `/P /UPDATE /R /ARGS --background` and immediate process exit(0) with no window close.
async function runUpdateModeSetup(installerPath, appChild) {
  const ended = new Promise(resolve => {
    if (appChild.exitCode !== null) resolve(appChild.exitCode);
    else appChild.once('exit', code => resolve(code));
  });
  const parameters = '/P /UPDATE /R /ARGS --background';
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class UpdaterLaunch {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct SHELLEXECUTEINFOW {',
    '    public int cbSize;',
    '    public uint fMask;',
    '    public IntPtr hwnd;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;',
    '    public int nShow;',
    '    public IntPtr hInstApp;',
    '    public IntPtr lpIDList;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;',
    '    public IntPtr hkeyClass;',
    '    public uint dwHotKey;',
    '    public IntPtr hIconOrMonitor;',
    '    public IntPtr hProcess;',
    '  }',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool ShellExecuteExW(ref SHELLEXECUTEINFOW lpExecInfo);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool TerminateProcess(IntPtr process, uint exitCode);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool CloseHandle(IntPtr handle);',
    '}',
    '"@',
    `$hApp = [UpdaterLaunch]::OpenProcess(0x00101001, $false, ${appChild.pid})`,
    "if ($hApp -eq [IntPtr]::Zero) { throw 'Could not open running N app handle' }",
    '$sei = New-Object UpdaterLaunch+SHELLEXECUTEINFOW',
    '$sei.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($sei)',
    '$sei.fMask = 0x00000040',
    '$sei.lpVerb = "open"',
    `$sei.lpFile = '${installerPath.replaceAll("'", "''")}'`,
    `$sei.lpParameters = '${parameters}'`,
    '$sei.nShow = 5',
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'if (-not [UpdaterLaunch]::ShellExecuteExW([ref]$sei)) { [UpdaterLaunch]::CloseHandle($hApp) | Out-Null; throw "ShellExecuteExW open failed" }',
    '$setupStartedElapsedMs = $sw.Elapsed.TotalMilliseconds',
    '$terminated = [UpdaterLaunch]::TerminateProcess($hApp, 0)',
    '$appWait = [UpdaterLaunch]::WaitForSingleObject($hApp, 15000)',
    '$appExitedElapsedMs = $sw.Elapsed.TotalMilliseconds',
    '$setupStartToAppExitMs = [Math]::Round($appExitedElapsedMs - $setupStartedElapsedMs, 3)',
    '$appExit = [uint32]999',
    '$appExitOk = [UpdaterLaunch]::GetExitCodeProcess($hApp, [ref]$appExit)',
    '[UpdaterLaunch]::CloseHandle($hApp) | Out-Null',
    'if (-not $appExitOk) { throw "GetExitCodeProcess failed for running N app handle" }',
    'if ($sei.hProcess -eq [IntPtr]::Zero) { throw "ShellExecuteExW returned no setup process handle" }',
    '$setupWait = [UpdaterLaunch]::WaitForSingleObject($sei.hProcess, 360000)',
    '$setupExit = [uint32]999',
    '$setupExitOk = [UpdaterLaunch]::GetExitCodeProcess($sei.hProcess, [ref]$setupExit)',
    '[UpdaterLaunch]::CloseHandle($sei.hProcess) | Out-Null',
    'if (-not $setupExitOk) { throw "GetExitCodeProcess failed for setup process handle" }',
    'if ($setupWait -ne 0) { throw "Update-mode setup did not finish within 360s" }',
    '@{verb="open";parameters=$sei.lpParameters;terminated=$terminated;appWait=[int]$appWait;setupStartToAppExitMs=$setupStartToAppExitMs;appExitCode=[int]$appExit;setupExitCode=[int]$setupExit} | ConvertTo-Json -Compress',
  ].join('\n');
  const launch = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 420_000);
  const parsed = JSON.parse(launch.stdout);
  parsed.nodeObservedAppExitCode = await ended;
  report.appUpdateModeLaunch = parsed;
  save();
  return { ...launch, code: parsed.setupExitCode };
}
async function pollRelaunchedApp(previousPid, previousBirth, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let lastRows = [];
  do {
    const obs = await required(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter "Name = 'cotal-desktop.exe'" | ForEach-Object { $gp=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine;birth=$(if($gp){$gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null})} }); ConvertTo-Json -InputObject @($rows) -Compress`,
    ]);
    lastRows = JSON.parse(obs.stdout);
    const appRows = lastRows.filter(row => !row.commandLine?.includes('--daemon'));
    if (appRows.length === 1 && appRows[0].pid !== previousPid && appRows[0].birth && appRows[0].birth !== previousBirth) {
      return { allDesktopProcesses: lastRows, appInstances: appRows };
    }
    await delay(500);
  } while (Date.now() < until);
  return { allDesktopProcesses: lastRows, appInstances: lastRows.filter(row => !row.commandLine?.includes('--daemon')) };
}

let fixture, seat, locker, app, elevatedExternalPid, systemExternalTask, stopExternalSpawner;
let serviceInstalled = false;
let seatStopped = false;
try {
  assert.equal(existsSync(root), false, 'Each proof cell requires a fresh runner');
  if (cell === 'path-probe') {
    const probeOutput = join(output, 'probe');
    const probeRun = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/test/setup-path-probe.ps1'), '-Installer', candidate, '-Output', probeOutput, '-ExpectedVersion', candidateVersion], 420_000);
    const probeResultPath = join(probeOutput, 'result.json');
    const probeReport = existsSync(probeResultPath) ? JSON.parse(readText(probeResultPath)) : null;
    report.pathProbe = probeReport ?? { code: probeRun.code, stderr: probeRun.stderr };
    check('Path-identity probe script exited 0', probeRun.code === 0);
    check('All 28 guard and recovery cases completed with zero issues or failures', probeReport?.status === 'fixed-acceptance-complete' && probeReport?.cases?.length === 28 && probeReport?.observationIssues?.length === 0 && probeReport?.acceptanceFailures?.length === 0);
    check('Missing-folder /S installer rerun cleared the stale handover', probeReport?.recovery?.handoverRemoved === true);
    check('Both plain and extended-length bridge entries answered about', probeReport?.bridgeObservations?.length === 2 && probeReport.bridgeObservations.every(row => row.exit === 0 && row.stdout.includes('"ok":true')));
  } else {
    let sourceVersion;
    if (nextHop) sourceVersion = candidateVersion;
    else if (cell === 'app-installed-0.164.9') sourceVersion = '0.164.9';
    else if (cell === 'app-installed-latest') {
      sourceVersion = process.env.COTAL_SETUP_LATEST_VERSION;
      assert.match(sourceVersion ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'app-installed-latest requires a runtime-resolved latest published version from the registry');
    } else if (cell === 'early') sourceVersion = '0.157.0';
    else sourceVersion = '0.164.7';
    const previous = nextHop ? baseCandidate : join(process.env.RUNNER_TEMP, `Cotal_${sourceVersion}_x64-setup.exe`);
    if (cell === 'fresh') {
      const freshCensus = JSON.parse((await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/src-tauri/installers/service-task.ps1'), '-Action', 'census'])).stdout);
      report.freshCensusBeforeInstall = freshCensus;
      check('Absent installation folder yields empty executableNames in census', Array.isArray(freshCensus.executableNames) && freshCensus.executableNames.length === 0 && Array.isArray(freshCensus.processes) && freshCensus.processes.length === 0 && Array.isArray(freshCensus.skipped) && freshCensus.skipped.length === 0);
    } else {
      assert.ok(previous && existsSync(previous), 'Workflow must provide the verified source installer');
      await requiredUser(previous, ['/S']);
    }
    if (cell !== 'fresh') check(nextHop ? 'Exact candidate files are installed' : 'Published files are installed', JSON.parse(readText(join(runtime, 'package.json'))).version === sourceVersion);
    if (!['absent', 'fresh', 'foreign'].includes(cell)) {
      if (candidateNextChecks) {
        const beforeManifest = readText(join(runtime, 'desktop-runtime.json'));
        check(nextHop ? 'Installed candidate runtime inventory matches N' : 'Installed published runtime inventory matches source version', JSON.parse(beforeManifest).version === sourceVersion);
        writeFileSync(join(output, 'runtime-before.json'), beforeManifest);
        report.candidateNext = { fromVersion: sourceVersion, toVersion: expectedVersion, appInstalled, updateMode: cell === 'app-update-mode', usePrefix: appInstalled, baseInstaller: { file: previous, sha256: createHash('sha256').update(readFileSync(previous)).digest('hex') }, nextInstaller: report.candidate, signing: 'unsigned direct NSIS setup, no updater signatures' };
      }
      if (appInstalled) {
        await installServiceViaAppBridge(true);
        serviceInstalled = existsSync(join(root, 'daemon', 'service-unit.json'));
        await observeInstalledService('after-install');
        report.initialDaemonPoll = await pollDaemonStatus(sourceVersion, 120_000);
        if (report.initialDaemonPoll.answered) {
          report.before = report.initialDaemonPoll.status;
          report.beforeBirth = (await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${report.before.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`])).stdout.trim();
        }
        await observeInstalledService('before');
      } else {
        await requiredUser(node, [cli, 'daemon', 'install', '--json']);
        serviceInstalled = true;
        if (candidateNextChecks) await observeInstalledService('after-install');
        report.before = await ready(sourceVersion);
        if (candidateNextChecks) {
          report.beforeBirth = (await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${report.before.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`])).stdout.trim();
          await observeInstalledService('before');
        }
      }
    }
    if (cell === 'foreign') {
      const foreignCli = join(process.env.RUNNER_TEMP, 'cli-service', 'node_modules', 'cotal-ai', 'dist', 'cotal.js');
      await required(process.execPath, [foreignCli, 'daemon', 'install', '--json']);
      report.foreignCli = foreignCli;
      serviceInstalled = true;
      const deadline = Date.now() + 60_000;
      let status;
      do {
        status = await run(process.execPath, [foreignCli, 'daemon', 'status', '--json']);
        if (status.code === 0) break;
        await delay(500);
      } while (Date.now() < deadline);
      assert.equal(status.code, 0, status.stdout || status.stderr);
      report.before = JSON.parse(status.stdout).result;
      report.foreignReceipt = readText(join(root, 'daemon', 'service-unit.json'));
    }
    if (cell === 'stopped') {
      const helper = join(repo, 'desktop/src-tauri/installers/service-update.mjs');
      await required(process.execPath, [helper, 'prepare', root, expectedVersion]);
      await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'desktop/src-tauri/installers/service-task.ps1'), '-Action', 'enable']);
      rmSync(join(setupHome, 'service-update.json'));
      const stopped = await daemon('status');
      check('Fixture begins with a genuinely stopped installed service', JSON.parse(stopped.stdout).error?.cause?.code === 'NOT_RUNNING');
    }
    if (cell === 'interrupted') {
      const helper = join(repo, 'desktop/src-tauri/installers/service-update.mjs');
      await required(process.execPath, [helper, 'prepare', root, expectedVersion]);
      const taskScript = join(repo, 'desktop/src-tauri/installers/service-task.ps1');
      const attempted = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScript, '-Action', 'start']);
      check('Disabled task refuses launch while replacement barrier is held', attempted.code !== 0);
      const native = JSON.parse((await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScript, '-Action', 'inspect'])).stdout);
      check('Disabled task remains empty under explicit launch challenge', native.enabled === false && native.instances === 0);
      const handover = JSON.parse(readText(join(setupHome, 'service-update.json')));
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
    if (cell === 'external-node-exiting' || cell === 'external-node-exiting-filtered') {
      let running = true;
      stopExternalSpawner = () => { running = false; };
      report.externalNodePath = process.execPath;
      for (let w = 0; w < 10; w++) {
        (async () => {
          while (running) {
            const p = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
            await new Promise(resolve => p.once('close', resolve));
          }
        })();
      }
      await delay(500);
    }
    if (cell === 'external-node-elevated' || cell === 'external-node-elevated-filtered') {
      const started = await required(ps, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList @('-e','setInterval(()=>{},1000)') -Verb RunAs -WindowStyle Hidden -PassThru; @{pid=[int]$p.Id;executablePath='${process.execPath.replaceAll("'", "''")}'} | ConvertTo-Json -Compress`,
      ]);
      const parsed = JSON.parse(started.stdout);
      elevatedExternalPid = parsed.pid;
      report.elevatedExternalNode = parsed;
      await delay(1000);
    }
    if (cell === 'external-node-system' || cell === 'external-node-system-filtered') {
      systemExternalTask = 'cotal-repro-system-node';
      const started = await required(ps, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; ` +
        `$node='${process.execPath.replaceAll("'", "''")}'; ` +
        `& "$env:SystemRoot\\System32\\schtasks.exe" /Create /TN '${systemExternalTask}' /TR "\`"$node\`" -e \`"setInterval(()=>{},1000)\`"" /SC ONCE /ST 00:00 /RU SYSTEM /RL HIGHEST /F | Out-Null; ` +
        `if($LASTEXITCODE -ne 0){throw 'Could not create SYSTEM node task'}; ` +
        `& "$env:SystemRoot\\System32\\schtasks.exe" /Run /TN '${systemExternalTask}' | Out-Null; ` +
        `if($LASTEXITCODE -ne 0){throw 'Could not start SYSTEM node task'}; ` +
        `$deadline=[DateTime]::UtcNow.AddSeconds(15); $found=$null; ` +
        `do { ` +
        `  $rows=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { !$_.ExecutablePath -or $_.ExecutablePath -ceq $node }); ` +
        `  foreach($r in $rows){ $o=Invoke-CimMethod -InputObject $r -MethodName GetOwner -ErrorAction SilentlyContinue; if($o -and $o.User -eq 'SYSTEM'){ $found=@{pid=[int]$r.ProcessId;parentPid=[int]$r.ParentProcessId;user=$o.User;domain=$o.Domain;wmiExecutablePath=$r.ExecutablePath}; break } }; ` +
        `  if($found){break}; Start-Sleep -Milliseconds 250 ` +
        `} while([DateTime]::UtcNow -lt $deadline); ` +
        `if(!$found){throw 'SYSTEM node.exe did not start'}; ` +
        `$found | ConvertTo-Json -Compress`,
      ]);
      report.systemExternalNode = JSON.parse(started.stdout);
    }
    if (cell === 'app-update-mode') {
      app = spawn(join(root, 'cotal-desktop.exe'), ['--background'], { env, stdio: 'ignore', windowsHide: false });
      await delay(8000);
      check('Candidate N app remains alive in tray with --background before update launch', app.pid && app.exitCode === null);
      const beforeApp = JSON.parse((await required(ps, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${app.pid}"; if(!$p){throw 'Candidate N app process not found'}; $gp=Get-Process -Id ${app.pid} -ErrorAction Stop; @{pid=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine;birth=$gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress`,
      ])).stdout);
      report.appUpdateModeBefore = beforeApp;
      check('Candidate N login-mode app carries --background argument', beforeApp.commandLine.includes('--background'));
    }
    if (cell === 'locker' || cell === 'locker-filtered' || cell === 'locker-short') {
      let lockerExe = node;
      if (cell === 'locker-short') {
        const shortResolved = await required(ps, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference='Stop'; Add-Type -Namespace Win32 -Name ShortPath -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetShortPathNameW(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);'; $sb=[Text.StringBuilder]::new(32768); $n=[Win32.ShortPath]::GetShortPathNameW('${node.replaceAll("'", "''")}', $sb, [uint32]$sb.Capacity); if($n -eq 0){throw 'GetShortPathNameW failed'}; $sb.ToString()`,
        ]);
        lockerExe = shortResolved.stdout.trim();
        report.lockerShortNode = { longPath: node, shortPath: lockerExe };
        check('Short 8.3 path of bundled node.exe differs from long path', lockerExe.length > 0 && lockerExe.toLowerCase() !== node.toLowerCase() && lockerExe.includes('~'));
      }
      locker = spawn(lockerExe, ['-e', 'setInterval(()=>{},1000)'], { env, windowsHide: true, stdio: 'ignore' });
      await delay(1000);
      check('Real bundled Node locker stays alive', locker.pid && locker.exitCode === null);
      if (cell === 'locker-short') {
        const shortObs = await required(ps, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference='Stop'; Add-Type -Namespace Win32 -Name ImgProbe -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, System.Text.StringBuilder exe, ref uint size); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);'; $h=[Win32.ImgProbe]::OpenProcess(0x1000, $false, ${locker.pid}); $img=$null; if($h -ne [IntPtr]::Zero){ try { $sb=[Text.StringBuilder]::new(32768); $sz=[uint32]32768; if([Win32.ImgProbe]::QueryFullProcessImageNameW($h, 0, $sb, [ref]$sz)){$img=$sb.ToString()} } finally { [Win32.ImgProbe]::CloseHandle($h)|Out-Null } }; $wmi=(Get-CimInstance Win32_Process -Filter "ProcessId = ${locker.pid}").ExecutablePath; @{pid=${locker.pid};spawnedPath='${lockerExe.replaceAll("'", "''")}';queryFullProcessImageName=$img;wmiExecutablePath=$wmi} | ConvertTo-Json -Compress`,
        ]);
        report.lockerShortProcessObservation = JSON.parse(shortObs.stdout);
      }
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
      report.activeAgents = status.agents.filter(row => row.state === 'read').reduce((sum, row) => sum + row.agents.filter(agent => agent.state === 'running').length, 0);
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
    } else if (cell === 'app-update-mode') {
      result = await runUpdateModeSetup(candidate, app);
    } else result = await runUser(candidate, ['/S'], 420_000);
    if (stopExternalSpawner) stopExternalSpawner();
    report.setup = result;
    report.setupElapsedMs = Date.now() - start;
    await observeDaemonLockState('whenSetupReturns', report.before?.pid);
    const diagnostic = existsSync(join(setupHome, 'result.json')) ? JSON.parse(readText(join(setupHome, 'result.json'))) : null;
    report.diagnostic = diagnostic;
    if (useFilteredToken) {
      check('Filtered-token setup ran with Medium Mandatory Level and BUILTIN\\Administrators deny-only', report.filteredTokenWhoami?.some(g => g.type === 'Label' && g.groupName?.includes('Medium Mandatory Level')) && report.filteredTokenWhoami?.some(g => g.groupName === 'BUILTIN\\Administrators' && g.attributes?.includes('deny only')));
    }
    if (before.length > 0 && !['occupied', 'occupied-ui', 'early', 'cannot-start'].includes(cell)) {
      const expectedExeNames = [...new Set(before.filter(row => row.file.toLowerCase().endsWith('.exe')).map(row => row.file.split('/').pop()))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      check('Census candidate executable set equals the .exe files in the installed inventory', Array.isArray(diagnostic?.executableNames) && diagnostic.executableNames.length >= 4 && JSON.stringify(diagnostic.executableNames.map(n => n.toLowerCase()).sort()) === JSON.stringify(expectedExeNames.map(n => n.toLowerCase()).sort()));
    }
    if (['running', 'app-open', 'app-tray', 'locker', 'locker-filtered', 'locker-short'].includes(cell)) {
      check('Census opens and classifies every Cotal process with zero skipped rows', Array.isArray(diagnostic?.skippedProcesses) && diagnostic.skippedProcesses.length === 0);
    }
    if (cell === 'external-node-system-filtered') {
      check('Filtered-token SYSTEM cell records the unopenable SYSTEM node.exe in skippedProcesses', Array.isArray(diagnostic?.skippedProcesses) && diagnostic.skippedProcesses.some(row => row.pid === report.systemExternalNode.pid && row.name === 'node.exe' && row.error === 'ERROR_ACCESS_DENIED (5)'));
    }
    if (['external-node-exiting', 'external-node-exiting-filtered', 'external-node-elevated', 'external-node-elevated-filtered', 'external-node-system'].includes(cell)) {
      check('External node cell records zero skipped processes when all candidates are openable or gone', Array.isArray(diagnostic?.skippedProcesses) && diagnostic.skippedProcesses.length === 0);
    }
    if (candidateNextChecks) {
      await observeInstalledService('after');
      if (existsSync(join(runtime, 'desktop-runtime.json'))) {
        writeFileSync(join(output, 'runtime-after.json'), readFileSync(join(runtime, 'desktop-runtime.json')));
      }
    }
    if (cell === 'interactive') {
      const ui = JSON.parse(readText(join(output, 'ui.json')).replace(/^\uFEFF/, ''));
      check('Newer default click-through never offers the unsafe old-uninstaller choice', !ui.some(row => row.names?.some(name => /uninstall before installing/i.test(name))));
    }
    if (['occupied', 'occupied-ui', 'locker', 'locker-filtered', 'locker-short', 'early', 'cannot-start'].includes(cell)) {
      check('Setup refuses before replacing files', result.code !== 0);
      compare(before, inventory());
      const postSetupStatus = await ready(sourceVersion);
      check('Service remains old and running', postSetupStatus.pid === report.before.pid);
      await observeDaemonLockState('afterPostSetupStatus', postSetupStatus.pid);
      if (seat) {
        const birth = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${report.seat.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]);
        check('Same real fixture process survives refusal', birth.stdout.trim() === report.seat.birth);
        check('Occupied refusal names the real agent count and Retry remedy', result.code === 20 && diagnostic.code === 20 && diagnostic.activeAgents === report.activeAgents && diagnostic.message.includes('Stop them and choose Retry.'));
        check('Occupied refusal cleanly releases its preparation fence', !diagnostic.message.includes('Recovery was not confirmed'));
        for (const file of ['helper.log', 'result.json', 'message.txt']) {
          const path = join(setupHome, file);
          if (existsSync(path)) writeFileSync(join(output, `refusal-${file}`), readFileSync(path));
        }
        await observeSeatStop('before-stop');
        await seat.stop(report.manager.instanceId);
        seatStopped = true;
        const stoppedAt = Date.now();
        await observeSeatStop('after-stop');
        report.retry = await run(candidate, ['/S'], 420_000);
        report.retryDiagnostic = JSON.parse(readText(join(setupHome, 'result.json')));
        await observeSeatStop('after-first-retry');
        if (report.retry.code !== 0) {
          report.delayedRetries = [];
          for (const offsetMs of [15_000, 60_000]) {
            await delay(Math.max(0, stoppedAt + offsetMs - Date.now()));
            await observeSeatStop(`retry-${offsetMs}`);
            const startedSinceStopMs = Date.now() - stoppedAt;
            const result = await run(candidate, ['/S'], 420_000);
            const diagnostic = JSON.parse(readText(join(setupHome, 'result.json')));
            report.delayedRetries.push({ offsetMs, startedSinceStopMs, sinceStopMs: Date.now() - stoppedAt, result, diagnostic });
            await observeSeatStop(`after-retry-${offsetMs}`);
            save();
            if (result.code === 0) break;
          }
        }
        check('Setup completes after the real seat stops and the user retries', report.retry.code === 0);
        report.after = await ready(expectedVersion);
        check('Retry confirms the new running service', report.after.version === expectedVersion);
      }
      if (cell === 'locker' || cell === 'locker-filtered' || cell === 'locker-short') {
        check('Refusal identifies the actual bundled Node locker', diagnostic.code === 21 && diagnostic.message.includes(`node.exe (${locker.pid})`) && diagnostic.message.includes('Close programs using this installation'));
        const status = await ready(sourceVersion);
        check('Locker refusal releases the hosted launch fence', status.update.restartEvidence.prepared === false);
      }
      if (cell === 'cannot-start') check('Missing helper produces persistent refusal instead of success', diagnostic.code === 21 && diagnostic.message.includes('helper did not complete'));
      if (cell === 'early') check('Early shipped service lacks graceful stop and reports supported remedy', diagnostic.message.includes('uninstall --yes'));
    } else if (appInstalled && !report.initialDaemonPoll?.answered) {
      report.afterSetupDaemonPoll = await pollDaemonStatus(expectedVersion, 30_000);
      await observeInstalledService('after-poll');
      check('App-installed daemon answered within 120 seconds before setup', false);
    } else {
      check('Setup confirms success', result.code === 0);
      check('New files are installed', JSON.parse(readText(join(runtime, 'package.json'))).version === expectedVersion);
      if (cell === 'foreign') {
        const status = JSON.parse((await required(process.execPath, [report.foreignCli, 'daemon', 'status', '--json'])).stdout).result;
        check('Foreign CLI service keeps its old PID and version', status.pid === report.before.pid && status.version === report.before.version);
        check('Foreign service receipt is unchanged', readText(join(root, 'daemon', 'service-unit.json')) === report.foreignReceipt);
        check('Setup names untouched foreign service', diagnostic.message.includes('another installation'));
      } else if (cell === 'absent' || cell === 'fresh') check('No service was installed', !existsSync(join(root, 'daemon/service-unit.json')));
      else if (cell === 'stopped') {
        const stopped = await daemon('status');
        check('Previously stopped service stays stopped', stopped.code !== 0 && JSON.parse(stopped.stdout).error.cause.code === 'NOT_RUNNING');
        const startServiceBridge = await installServiceViaAppBridge(true);
        report.stoppedStartServiceBridge = startServiceBridge;
        check('App bridge Start service reply is ok within its 15s deadline', startServiceBridge.ok === true && startServiceBridge.elapsedMs <= 15_000);
        report.after = await ready(expectedVersion);
        check('Stopped service started via app bridge answers at version N', report.after.version === expectedVersion);
        const lockRecord = JSON.parse(readText(join(root, 'daemon', 'daemon.lock')));
        const afterStoppedObs = await required(ps, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference='Stop'; ` +
          `$receipt=Get-Content -Raw -LiteralPath '${join(root, 'daemon', 'service-unit.json').replaceAll("'", "''")}' | ConvertFrom-Json; ` +
          `$scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); ` +
          `$task=$scheduler.GetFolder('\\').GetTask($receipt.unit); ` +
          `$lockProc=Get-Process -Id ${lockRecord.pid} -ErrorAction SilentlyContinue; ` +
          `$daemons=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*daemon-native.js*' } | ForEach-Object { $gp=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine;birth=$(if($gp){$gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null})} }); ` +
          `@{task=@{enabled=[bool]$task.Enabled;state=[int]$task.State;instances=[int]$task.GetInstances(0).Count};lockPidBirth=$(if($lockProc){$lockProc.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null});daemonProcesses=$daemons} | ConvertTo-Json -Depth 5 -Compress`,
        ]);
        const state = JSON.parse(afterStoppedObs.stdout);
        report.stoppedStartServiceState = { lockRecord, ...state };
        check('Owned task is enabled and running with one instance after Start service', state.task.enabled === true && state.task.state === 4 && state.task.instances === 1);
        check('Single daemon lifetime matches lock record and process birth', lockRecord.v === 1 && lockRecord.pid === report.after.pid && typeof lockRecord.start === 'string' && lockRecord.start === state.lockPidBirth && state.daemonProcesses.length === 1 && state.daemonProcesses[0].pid === lockRecord.pid && state.daemonProcesses[0].birth === lockRecord.start);
      } else report.after = await ready(expectedVersion);
      if (candidateNextChecks) {
        check('Candidate-to-next result binds both stamped versions', diagnostic.fromVersion === sourceVersion && diagnostic.toVersion === expectedVersion && diagnostic.outcome === 'updated');
        const processState = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$old=Get-Process -Id ${report.before.pid} -ErrorAction SilentlyContinue; $new=Get-Process -Id ${report.after.pid} -ErrorAction Stop; @{oldBirth=$(if($old){$old.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null});newBirth=$new.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress`]);
        report.nextProcessState = JSON.parse(processState.stdout);
        check('Old candidate kernel lifetime is gone and next lifetime differs', report.nextProcessState.oldBirth !== report.beforeBirth && report.nextProcessState.newBirth !== report.beforeBirth);
        const taskState = await required(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$receipt=Get-Content -Raw -LiteralPath '${join(root, 'daemon', 'service-unit.json').replaceAll("'", "''")}' | ConvertFrom-Json; $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); $task=$scheduler.GetFolder('\\').GetTask($receipt.unit); @{enabled=[bool]$task.Enabled;state=[int]$task.State;instances=[int]$task.GetInstances(0).Count} | ConvertTo-Json -Compress`]);
        report.nextTaskState = JSON.parse(taskState.stdout);
        check('Next candidate owned task is enabled and running', report.nextTaskState.enabled && report.nextTaskState.state === 4 && report.nextTaskState.instances === 1);
        const afterManifest = readText(join(runtime, 'desktop-runtime.json'));
        check(nextHop ? 'Synthetic next runtime inventory matches N plus1000' : 'Candidate runtime inventory matches target version', JSON.parse(afterManifest).version === expectedVersion);
        if (appInstalled) check('App bridge install answered within its 15s deadline', report.appBridgeInstall?.ok === true);
        if (cell === 'app-update-mode') {
          check('Candidate N app ended with exit code 0 at update launch without window close', report.appUpdateModeLaunch?.appExitCode === 0 && report.appUpdateModeLaunch?.nodeObservedAppExitCode === 0);
          check('Uninstaller was skipped in update mode', existsSync(join(root, 'daemon', 'service-unit.json')) && diagnostic?.outcome === 'updated' && !report.serviceObservation_after?.processes?.some(p => p.name === 'uninstall.exe'));
          const relaunched = await pollRelaunchedApp(report.appUpdateModeBefore.pid, report.appUpdateModeBefore.birth, 30_000);
          report.appUpdateModeAfter = relaunched;
          check('N+1 app was relaunched by /R as a single instance', relaunched.appInstances.length === 1);
          check('Relaunched N+1 app runs from installed path with new lifetime and --background', relaunched.appInstances[0]?.executablePath === join(root, 'cotal-desktop.exe') && relaunched.appInstances[0]?.pid !== report.appUpdateModeBefore.pid && relaunched.appInstances[0]?.birth !== report.appUpdateModeBefore.birth && relaunched.appInstances[0]?.commandLine?.includes('--background'));
        }
      }
    }
  }
} catch (error) { report.failure = error.stack; report.failureObservation = error.observation; process.exitCode = 1; }
finally {
  const retainedDaemonLog = join(root, 'daemon', 'daemon.log');
  if (existsSync(retainedDaemonLog)) writeFileSync(join(output, 'daemon-finally.log'), readFileSync(retainedDaemonLog));
  if (stopExternalSpawner) stopExternalSpawner();
  if (elevatedExternalPid) {
    await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${elevatedExternalPid} -Force -ErrorAction SilentlyContinue`], 15_000);
  }
  if (systemExternalTask) {
    await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& "$env:SystemRoot\\System32\\schtasks.exe" /End /TN '${systemExternalTask}' 2>$null | Out-Null; & "$env:SystemRoot\\System32\\schtasks.exe" /Delete /TN '${systemExternalTask}' /F 2>$null | Out-Null; if (${report.systemExternalNode?.pid ?? 0} -gt 0) { Stop-Process -Id ${report.systemExternalNode?.pid ?? 0} -Force -ErrorAction SilentlyContinue }`], 15_000);
  }
  for (const file of ['helper.log', 'service-update.json', 'result.json', 'message.txt']) {
    const path = join(setupHome, file);
    if (existsSync(path)) writeFileSync(join(output, `setup-${file}`), readFileSync(path));
  }
  const helperLog = join(setupHome, 'helper.log');
  if (existsSync(helperLog)) {
    const timings = new Map();
    for (const line of readText(helperLog).trim().split('\n')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.action !== 'recover' || !Number.isFinite(entry.elapsedMs)) continue;
      const timing = timings.get(entry.pid) ?? { pid: entry.pid, startupMs: null, totalMs: null, lastStep: null, lastElapsedMs: null };
      if (entry.step === 'start') timing.startupMs = entry.elapsedMs;
      if (entry.step === 'exit') timing.totalMs = entry.elapsedMs;
      timing.lastStep = entry.step;
      timing.lastElapsedMs = entry.elapsedMs;
      timings.set(entry.pid, timing);
    }
    report.recoverTimings = [...timings.values()];
  }
  if (seat?.launchOutput && existsSync(seat.launchOutput)) writeFileSync(join(output, 'seat-output.log'), readFileSync(seat.launchOutput));
  for (const [path, name] of [[seat?.seatEnvironmentNames, 'seat-environment-names.txt'], [seat?.managerEnvironmentNames, 'manager-environment-names.json']]) {
    if (path && existsSync(path)) writeFileSync(join(output, name), readFileSync(path));
  }
  if (seat && !seatStopped) { await seat.stop(report.manager.instanceId).catch(error => { report.seatCleanupFailure = error.message; process.exitCode = 1; }); }
  if (app?.exitCode === null) { const ended = new Promise(resolve => app.once('exit', resolve)); app.kill(); await ended; }
  if (cell === 'app-update-mode') {
    await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'cotal-desktop.exe'" | Where-Object { $_.CommandLine -notlike '*--daemon*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], 15_000);
  }
  if (locker?.exitCode === null) { const ended = new Promise(resolve => locker.once('exit', resolve)); locker.kill(); await ended; }
  if (serviceInstalled) {
    const runtimePkgPath = report.foreignCli
      ? join(process.env.RUNNER_TEMP, 'cli-service', 'node_modules', 'cotal-ai', 'package.json')
      : join(runtime, 'package.json');
    const uninstallVersion = existsSync(runtimePkgPath) ? JSON.parse(readText(runtimePkgPath)).version : null;
    const verMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(uninstallVersion ?? '');
    const isPre01649 = Boolean(verMatch && (Number(verMatch[1]) < 0 || (Number(verMatch[1]) === 0 && (Number(verMatch[2]) < 164 || (Number(verMatch[2]) === 164 && Number(verMatch[3]) < 9)))));
    const uninstallStartedAt = new Date().toISOString();
    const uninstallStartedMs = Date.now();
    const result = report.foreignCli ? await run(process.execPath, [report.foreignCli, 'daemon', 'uninstall', '--yes', '--json']) : await runUser(node, [cli, 'daemon', 'uninstall', '--json', '--yes']);
    const uninstallEndedAt = new Date().toISOString();
    const uninstallEndedMs = Date.now();
    report.cleanup = { ...result, uninstallVersion, uninstallStartedAt, uninstallEndedAt };
    if (result.code !== 0) {
      const atRefusal = await observeDaemonLockState('atRefusal', report.before?.pid);
      const daemonLogPath = join(root, 'daemon', 'daemon.log');
      const obs = await run(ps, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; ` +
        `Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class PipeInspect {\n  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);\n  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);\n  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);\n}\n'@; ` +
        `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $pipeName="\\\\.\\pipe\\cotal-daemon-$sid"; ` +
        `$h=[PipeInspect]::CreateFileW($pipeName, [uint32]2147483648, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero); $pipeServerPid=$null; $pipeErr=$null; ` +
        `if($h -ne [IntPtr]::new(-1) -and $h -ne [IntPtr]::Zero){ $pidOut=[uint32]0; if([PipeInspect]::GetNamedPipeServerProcessId($h, [ref]$pidOut)){$pipeServerPid=[int]$pidOut}else{$pipeErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}; [PipeInspect]::CloseHandle($h)|Out-Null }else{$pipeErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}; ` +
        `$procs=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | Where-Object { $_.Name -in @('cotal-desktop.exe','node.exe') -or ($_.ExecutablePath -and $_.ExecutablePath -like '*\\Cotal\\*') } | ForEach-Object { $gp=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine;birth=$(if($gp){$gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}else{$null})} }); ` +
        `@{pipeName=$pipeName;pipeServerPid=$pipeServerPid;pipeError=$pipeErr;processes=$procs} | ConvertTo-Json -Depth 5 -Compress`,
      ], 30_000);
      const pipeAndProcesses = obs.code === 0 ? JSON.parse(obs.stdout) : { code: obs.code, stderr: obs.stderr };
      let parsedCleanup = null;
      try { parsedCleanup = JSON.parse(result.stdout); } catch {}
      const matchesHeldDaemonLock = point => {
        if (!point?.lock?.exists || !(point.lock.size > 0) || point.statusPidAlive !== true || !point.statusPid || !point.statusPidBirth) return false;
        try {
          const rec = JSON.parse(point.lock.bytes);
          return rec.pid === point.statusPid && rec.start === point.statusPidBirth;
        } catch {
          return false;
        }
      };
      const whenSetupReturns = report.daemonLockBracket?.whenSetupReturns;
      const afterPostSetupStatus = report.daemonLockBracket?.afterPostSetupStatus;
      const emptiedMs = Date.parse(atRefusal.lock.mtime ?? '');
      const isKnown6820 = isPre01649 &&
        parsedCleanup?.error?.code === 'OPERATION_UNKNOWN' &&
        typeof parsedCleanup?.error?.message === 'string' &&
        /^the process answering at .+ is not the daemon holding .+; nothing was sent$/.test(parsedCleanup.error.message) &&
        matchesHeldDaemonLock(whenSetupReturns) &&
        matchesHeldDaemonLock(afterPostSetupStatus) &&
        whenSetupReturns.statusPid === afterPostSetupStatus.statusPid &&
        whenSetupReturns.statusPidBirth === afterPostSetupStatus.statusPidBirth &&
        atRefusal.lock.exists === true &&
        atRefusal.lock.size === 0 &&
        atRefusal.lock.bytes === '' &&
        Number.isFinite(emptiedMs) &&
        emptiedMs > Date.parse(afterPostSetupStatus.observedAt) &&
        emptiedMs >= uninstallStartedMs - 100 &&
        emptiedMs <= uninstallEndedMs + 100 &&
        atRefusal.statusPidAlive === false &&
        pipeAndProcesses?.pipeServerPid === null;
      report.cleanupRefusalObservation = {
        outcome: isKnown6820 ? `#6820 in published ${uninstallVersion}` : 'unexpected-cleanup-refusal',
        uninstallVersion,
        uninstallStartedAt,
        uninstallEndedAt,
        lockRecord: atRefusal.lock.bytes,
        lockState: atRefusal,
        bracket: report.daemonLockBracket ?? null,
        daemonLogTail: existsSync(daemonLogPath) ? readText(daemonLogPath).split('\n').slice(-40).join('\n') : null,
        pipeAndProcesses,
      };
      if (isKnown6820) {
        report.cleanupOutcome = `#6820 in published ${uninstallVersion}`;
      } else {
        process.exitCode = 1;
      }
    } else {
      report.cleanupOutcome = 'ok';
    }
  }
  const events = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $start=[DateTime]::Parse('${proofStartedAt}').ToUniversalTime(); $events=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000;StartTime=$start} -ErrorAction SilentlyContinue); ConvertTo-Json -InputObject @($events|ForEach-Object{@{time=$_.TimeCreated.ToUniversalTime().ToString('o');id=$_.Id;message=$_.Message}}) -Compress`], 30_000);
  writeFileSync(join(output, 'application-events-1000.json'), JSON.stringify(events, null, 2));
  await fixture?.close();
  save();
  console.log(JSON.stringify({ cell, failure: report.failure, cleanup: report.cleanupOutcome ?? null, checks: report.checks, output }, null, 2));
}
