// Measures the PowerShell calls inside one fresh `daemon install --json`.
// The product bound stays 30 s. This copy watches every powershell.exe the
// install starts, records its command and duration, and lets the first one
// finish instead of inheriting the runner's kill. Later calls keep the
// product's own 30 s bound. It changes no product code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const candidate = process.env.COTAL_SETUP_CANDIDATE;
assert.ok(candidate && existsSync(candidate), 'Candidate installer required');
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const node = join(root, 'node.exe');
const cli = join(root, 'runtime', 'dist', 'cotal.js');
const nativeRun = join(root, 'runtime', 'dist', 'daemon', 'install-native-run.js');
const output = join(process.env.RUNNER_TEMP, 'setup-proof', 'measure-6879');
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'PSModulePath'].includes(key)));
Object.assign(env, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const report = { head: process.env.GITHUB_SHA ?? null, cell: 'measure-6879', boundMs: 30_000, calls: [] };
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));

const run = (file, args, timeout) => new Promise(resolve => {
  const start = Date.now();
  const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), timeout);
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ file, args, elapsedMs: Date.now() - start, code, signal, stdout, stderr });
  });
});

const watch = () => new Promise(resolve => {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=@()",
    "Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier starts | Out-Null",
    "Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier stops | Out-Null",
    "while ($true) {",
    "  Wait-Event -Timeout 1 | Out-Null",
    "  foreach ($event in @(Get-Event -ErrorAction SilentlyContinue)) {",
    "    $name=[string]$event.SourceEventArgs.NewEvent.ProcessName",
    "    if ($name -eq 'powershell.exe') {",
    "      $rows += @{kind=$event.SourceIdentifier; pid=[int]$event.SourceEventArgs.NewEvent.ProcessID; parentPid=[int]$event.SourceEventArgs.NewEvent.ParentProcessID; commandLine=[string]$event.SourceEventArgs.NewEvent.CommandLine; at=(Get-Date).ToUniversalTime().ToString('o')}",
    "    }",
    "    Remove-Event -EventIdentifier $event.EventIdentifier",
    "  }",
    "  if (Test-Path -LiteralPath $env:COTAL_MEASURE_DONE) { break }",
    "}",
    "$rows | ConvertTo-Json -Depth 4 -Compress",
  ].join('\n');
  const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, COTAL_MEASURE_DONE: join(output, 'done') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stdout, stderr }));
});

assert.equal(existsSync(root), false, 'Cell requires a fresh install folder');
const installed = await run(candidate, ['/S'], 300_000);
assert.equal(installed.code, 0, installed.stderr || installed.stdout);
const before = readFileSync(nativeRun, 'utf8');
const marker = 'timeoutMs = 30_000)';
assert.equal(before.split(marker).length - 1, 1, 'Installed native runner no longer has one 30 s default');
const needle = 'timeoutMs = 30_000) {';
const brace = before.indexOf(needle);
assert.notEqual(brace, -1, 'Installed native runner signature is not the ES2022 form');
const insertAt = brace + needle.length;
const rewritten = `${before.slice(0, insertAt)} if (String(file).toLowerCase().endsWith('powershell.exe') && !globalThis.__cotalFirstPowerShell) { globalThis.__cotalFirstPowerShell = true; timeoutMs = 180_000; }${before.slice(insertAt)}`;
writeFileSync(nativeRun, rewritten);
report.firstReadBoundMs = 180_000;
report.laterCallBoundMs = 30_000;

const watcher = watch();
await new Promise(resolve => setTimeout(resolve, 2000));
const install = await run(node, [cli, 'daemon', 'install', '--json'], 180_000);
writeFileSync(join(output, 'done'), 'done');
const watched = await Promise.race([
  watcher,
  new Promise(resolve => setTimeout(() => resolve({ code: null, stdout: '', stderr: 'watch did not finish' }), 30_000)),
]);
let events = [];
try { events = JSON.parse(watched.stdout || '[]'); } catch { events = []; }
if (!Array.isArray(events)) events = [events];
const starts = new Map();
for (const event of events) {
  if (event.kind === 'starts') starts.set(event.pid, event);
  if (event.kind === 'stops' && starts.has(event.pid)) {
    const start = starts.get(event.pid);
    report.calls.push({ pid: event.pid, parentPid: event.parentPid, commandLine: start.commandLine, startedAt: start.at, stoppedAt: event.at });
    starts.delete(event.pid);
  }
}
for (const start of starts.values()) report.calls.push({ pid: start.pid, parentPid: start.parentPid, commandLine: start.commandLine, startedAt: start.at, stoppedAt: null });
report.install = { code: install.code, elapsedMs: install.elapsedMs, signal: install.signal, stdout: install.stdout.slice(0, 2000), stderr: install.stderr.slice(0, 2000) };
report.watch = { code: watched.code, stderr: watched.stderr.slice(0, 1000), eventCount: events.length };
report.powershellCount = report.calls.length;
save();
if (install.code !== 0) process.exitCode = 1;
