import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.ok(process.env.RUNNER_TEMP && process.env.LOCALAPPDATA && process.env.SystemRoot);
process.umask(0o077);
const output = join(process.env.RUNNER_TEMP, 'windows-setup-observations');
mkdirSync(output, { recursive: true });
const token = process.env.MEASURE_RELEASE_TOKEN;
assert.ok(token);
delete process.env.MEASURE_RELEASE_TOKEN;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
env.COTAL_TELEMETRY = 'off';
env.COTAL_SKIP_CONNECTOR_SEED = '1';
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const node = join(root, 'node.exe');
const cli = join(root, 'runtime', 'dist', 'cotal.js');
const binary = join(root, 'cotal-desktop.exe');
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const report = { schema: 1, head: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), root, calls: [], watch: [], limits: ['Silent setup only. Interactive prompts are not exercised.', 'No sign-in, space or agent. The runner logon predates task registration.', 'No claim about a repetition trigger armed by a later user logon.'] };
const save = () => writeFileSync(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
let serviceAttempted = false;
let installerUnknown = false;
let app;
async function run(file, args, timeout = 45_000, extraEnv = {}) {
  const start = Date.now();
  return new Promise(resolve => execFile(file, args, { env: { ...env, ...extraEnv }, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const result = { file, args, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start, code: error ? typeof error.code === 'number' ? error.code : null : 0, signal: error?.signal ?? null, killed: error?.killed ?? false, error: error?.message, stdout, stderr };
    report.calls.push(result);
    save();
    resolve(result);
  }));
}
async function daemon(verb, ...flags) {
  const result = await run(node, [cli, 'daemon', verb, '--json', ...flags], 120_000);
  try { result.body = JSON.parse(result.stdout); } catch { /* Raw output remains evidence. */ }
  save();
  return result;
}
async function status(version) {
  const deadline = Date.now() + 60_000;
  let last;
  do {
    last = await daemon('status');
    if (last.code === 0 && last.body?.result?.version === version) return last.body.result;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error(`Daemon never answered ${version}: ${JSON.stringify(last)}`);
}
async function census() {
  const script = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter "Name='cotal-desktop.exe' OR Name='node.exe'" -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate); $owned=@(); $unknown=@(); foreach($r in $rows) { if(!$r.ExecutablePath) { $unknown+=@{pid=$r.ProcessId;reason='Executable path unreadable'} } elseif($r.ExecutablePath.StartsWith($env:MEASURE_ROOT+'\\',[StringComparison]::OrdinalIgnoreCase)) { $owned+=@{pid=$r.ProcessId;parentPid=$r.ParentProcessId;path=$r.ExecutablePath;birth=$r.CreationDate.ToUniversalTime().ToString('o')} } }; $task=Get-ScheduledTask -TaskPath '\\' -TaskName $env:MEASURE_TASK -ErrorAction Stop; $i=Get-ScheduledTaskInfo -InputObject $task; @{processes=$owned;unknown=$unknown;task=@{state=$task.State.ToString();enabled=$task.Settings.Enabled;lastResult=$i.LastTaskResult;lastRunTime=$i.LastRunTime.ToUniversalTime().ToString('o');nextRunTime=$(if($null -ne $i.NextRunTime){$i.NextRunTime.ToUniversalTime().ToString('o')}else{$null})}} | ConvertTo-Json -Depth 6 -Compress`;
  const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 30_000, { MEASURE_ROOT: root, MEASURE_TASK: report.unit });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function download(version) {
  const name = `Cotal_${version}_x64-setup.exe`;
  const response = await fetch(`https://api.github.com/repos/Cotal-AI/Cotal/releases/tags/v${version}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  assert.equal(response.status, 200);
  const release = await response.json();
  assert.equal(release.draft, false);
  assert.equal(release.tag_name, `v${version}`);
  const asset = release.assets.find(row => row.name === name);
  assert.ok(asset?.digest?.startsWith('sha256:'));
  assert.equal(asset.browser_download_url, `https://github.com/Cotal-AI/Cotal/releases/download/v${version}/${name}`);
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) });
  assert.equal(download.status, 200);
  const file = join(process.env.RUNNER_TEMP, name);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(file, { flags: 'wx' }));
  const bytes = readFileSync(file);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(bytes.length, asset.size);
  assert.equal(digest, asset.digest);
  report[version] = { assetId: asset.id, name, digest, size: bytes.length };
  save();
  return file;
}
async function install(file) {
  const result = await run(file, ['/S'], 180_000);
  installerUnknown = result.code === null || result.signal !== null || result.killed;
  assert.equal(result.code, 0, result.stderr || result.error);
  return result;
}
try {
  assert.equal(existsSync(root), false, 'Disposable runner must begin with no desktop installation');
  const previous = await download('0.164.6');
  const next = await download('0.164.7');
  report.initialInstall = await install(previous);
  serviceAttempted = true;
  const installed = await daemon('install');
  assert.equal(installed.code, 0);
  report.unit = installed.body.result.unit;
  assert.ok(report.unit);
  report.before = await status('0.164.6');
  report.censusBefore = await census();
  assert.ok(report.censusBefore.processes.some(row => row.pid === report.before.pid && row.path.toLowerCase() === node.toLowerCase()));
  report.replacement = await install(next);
  report.firstStatus = await daemon('status');
  report.installedVersion = JSON.parse(readFileSync(join(root, 'runtime', 'package.json'), 'utf8')).version;
  assert.equal(report.installedVersion, '0.164.7');
  const watchStart = Date.now();
  for (let i = 0; i < 30; i++) {
    await delay(Math.max(0, watchStart + (i + 1) * 5000 - Date.now()));
    report.watch.push({ at: new Date().toISOString(), status: await daemon('status'), census: await census() });
    save();
  }
  app = spawn(binary, [], { env, stdio: 'ignore', windowsHide: false });
  const appError = new Promise((_, reject) => app.once('error', reject));
  await Promise.race([delay(8000), appError]);
  assert.ok(app.pid && app.exitCode === null && app.signalCode === null, 'Updated app must stay open');
  report.afterOpen = await daemon('status');
  report.afterOpenCensus = await census();
  const request = await daemon('start');
  assert.equal(request.code, 0);
  const recoveryStart = Date.now();
  report.recovered = await status('0.164.7');
  report.recoveryMs = Date.now() - recoveryStart;
  report.reproduced = report.watch.length === 30 && report.watch.every(row => row.status.body?.error?.code === 'TARGET_UNAVAILABLE' && row.status.body?.error?.cause?.code === 'NOT_RUNNING' && row.census.processes.length === 0 && row.census.unknown.length === 0 && row.census.task.state === 'Ready' && row.census.task.lastResult === 0) && report.afterOpen.body?.error?.code === 'TARGET_UNAVAILABLE';
  // Preserve the actual error shape before deciding whether the observation matches the issue.
  if (!report.reproduced) throw new Error('Raw observations did not match every expected baseline condition. Inspect result.json before claiming reproduction.');
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill();
    const stopped = await Promise.race([exited.then(() => true), delay(15_000).then(() => false)]);
    report.appCleanup = stopped ? 'owned child exited' : 'owned child still outstanding';
    if (!stopped) process.exitCode = 1;
  }
  if (serviceAttempted && !installerUnknown) {
    const removed = await daemon('uninstall', '--yes');
    report.serviceCleanup = removed;
    if (removed.code !== 0) process.exitCode = 1;
  } else if (serviceAttempted) {
    report.serviceCleanup = 'Withheld because installer outcome is unknown';
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ reproduced: report.reproduced, failure: report.failure, output }, null, 2));
}
