import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
const { nativeLifecycle } = await tsImport('./native-lifecycle.ts', import.meta.url);
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const helper = read('./lifecycle-windows.ps1');
const caller = read('./first-run.ts');
const wrapper = read('./native-lifecycle.ts');

test('Windows helper persists unfiltered PID birth and executable candidates before owner admission', () => {
  const admission = helper.indexOf("if ($Action -eq 'login-entry')");
  assert.ok(helper.indexOf('    Process-Candidates\n', 0) < admission);
  assert.match(helper, /function Process-Candidates[\s\S]*?birth = \$_\.StartTime\.ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.match(helper, /pid = \$_\.Id; birth =[\s\S]*?path = \$_\.Path/);
  assert.equal((helper.match(/candidates = @\(\$candidates\)/g) ?? []).length, 3);
  assert.doesNotMatch(helper.slice(helper.indexOf('function Process-Candidates'), helper.indexOf('function Assert-Owner')), /CommandLine|Arguments|Win32_Process/);
  const select = helper.indexOf('if ($AppPid) { $owners =');
  assert.ok(helper.indexOf('$diagnostics.Add([ordered]@{ candidates = @($candidates) })') < select);
});

test('candidate collection retains partial rows and sidecar refuses unknown evidence rather than recording empty success', () => {
  const collector = helper.slice(helper.indexOf('function Process-Candidates'), helper.indexOf('function Assert-Owner'));
  assert.match(collector, /\$script:candidates \+=/);
  assert.doesNotMatch(helper, /\$candidates = @\(Process-Candidates\)/);
  assert.match(wrapper, /ok: report.ok/);
  assert.match(wrapper, /Array.isArray\(report.candidates\)/);
});

test('actual lifecycle wrapper forwards launch PID and retains candidates even on native refusal', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  const candidates = [{ pid: 42, birth: '2026-11-14T01:42:37.507Z', path: 'C:\\owned\\cotal-desktop.exe' },
    { pid: 43, birth: '2026-11-14T01:20:00.000Z', path: 'C:\\owned\\cotal-desktop.exe' }];
  let refused = false;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(refused ? new Error('native refusal') : null,
      JSON.stringify({ ok: !refused, pid: 42, candidates, commandLine: 'NOT-RETAINED' }), '');
  });
  syncBuiltinESMExports();
  const root = mkdtempSync(join(tmpdir(), 'desktop-owner-'));
  const env = { COTAL_DESKTOP_E2E_NATIVE_LOG: join(root, 'native-errors.jsonl') };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const observed = await nativeLifecycle(candidates[0].path, 'describe', env, 42);
    assert.deepEqual(observed.candidates, candidates, 'PID selection must not filter the full census');
    assert.deepEqual(calls[0].args.slice(-2), ['-AppPid', '42']);
    refused = true;
    await assert.rejects(nativeLifecycle(candidates[0].path, 'close-window', env, 42), /native refusal/);
    const evidence = readFileSync(join(root, 'windows-lifecycle-candidates.jsonl'), 'utf8');
    const rows = evidence.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.ok), [true, false]);
    assert.ok(rows.every(row => row.appPid === 42 && row.candidates.length === 2));
    assert.doesNotMatch(evidence, /NOT-RETAINED|commandLine/);
    for (const pid of [0, -1, 1.5, NaN]) await assert.rejects(nativeLifecycle(candidates[0].path, 'close-window', env, pid));
    assert.equal(calls.length, 2, 'invalid PID never reaches the native helper');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('close-window receives launch-pinned PID only after separate duplicate-process admission', () => {
  assert.match(wrapper, /appPid\?: number/);
  assert.match(wrapper, /args\.push\("-AppPid", String\(appPid\)\)/);
  assert.match(caller, /windowsAppPid = .*\.pid/);
  const close = caller.slice(caller.indexOf('const lifecycle ='), caller.indexOf('let server:'));
  assert.match(close, /action === "close-window"[\s\S]*?nativeLifecycle\(binary, "describe", env, windowsAppPid, \{ pid: daemon.pid, start: daemon.start \}\)/);
  assert.match(close, /check\(`single app process before close-window: \$\{JSON\.stringify\(census\.candidates\)\}`/);
  assert.match(close, /census\.appCandidates\?\.length === 1 && census.appCandidates\[0\].pid === windowsAppPid/);
  assert.ok(close.indexOf('single app process before close-window') < close.indexOf('nativeLifecycle(binary, action, env,'));
  assert.match(close, /process.platform === "win32" \? windowsAppPid : undefined/);
  assert.match(caller, /row\.source === "process-argv" && row\.atUnixMs >= launchStarted/);
});

test('app census excludes only the answering daemon parent with exact birth/path and retains complete evidence', () => {
  const census = helper.slice(helper.indexOf('if ($DaemonPid)'), helper.indexOf("if ($Action -eq 'login-entry')"));
  assert.match(census, /Get-CimInstance Win32_Process -Filter "ProcessId=\$DaemonPid" -Property ProcessId,ParentProcessId/);
  assert.doesNotMatch(census, /CommandLine|\.CreationDate/);
  for (const marker of ['ToFileTimeUtc().ToString() -cne $DaemonStart', '$null = $daemonProcess.Handle', '$null = $launcher.Handle', '$launcher.Id -eq $AppPid', '$launcher.Path, $expected', '$launcher.StartTime -gt $daemonProcess.StartTime', '$matchingLauncher.Count -ne 1', '$daemonProcess.HasExited -or $launcher.HasExited']) assert.ok(census.includes(marker), marker);
  assert.match(census, /\$appCandidates = @\(\$candidates \| Where-Object \{ \$_.pid -ne \$serviceLauncher.pid \}\)/);
  assert.doesNotMatch(census, /\$candidates =/);
});
