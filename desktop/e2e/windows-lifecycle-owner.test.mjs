import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
const { nativeLifecycle } = await tsImport('./native-lifecycle.ts', import.meta.url);
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
  const diagnostics = [{ overflowMatches: [], count: 0 },
    { explorerButton: 'synthetic button', automationId: '', className: 'Button', offscreen: false },
    { rawExplorerSurface: { className: 'NotifyIconOverflowWindow', hwnd: 84, visible: false, pid: 24 },
      rawDescendantCount: 1, descendants: [{ controlType: 'ControlType.Pane', name: '', automationId: '', className: 'Pane', frameworkId: 'Win32', offscreen: true,
        boundingRectangle: { empty: true, left: null, top: null, width: null, height: null } }] }];
  let refused = false;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(refused ? new Error('native refusal') : null,
      JSON.stringify({ ok: !refused, pid: 42, candidates, diagnostics, commandLine: 'NOT-RETAINED' }), '');
  });
  syncBuiltinESMExports();
  const root = mkdtempSync(join(tmpdir(), 'desktop-owner-'));
  const env = { COTAL_DESKTOP_E2E_NATIVE_LOG: join(root, 'native-errors.jsonl') };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const observed = await nativeLifecycle(candidates[0].path, 'describe', env, 42);
    assert.deepEqual(observed.candidates, candidates, 'PID selection must not filter the full census');
    assert.deepEqual(calls[0].args.slice(-2), ['-AppPid', '42']);
    await nativeLifecycle(candidates[0].path, 'settings', env, 42, { pid: 100, start: '134391186778779367' });
    assert.deepEqual(calls[1].args.slice(-6), ['-AppPid', '42', '-DaemonPid', '100', '-DaemonStart', '134391186778779367']);
    refused = true;
    await assert.rejects(nativeLifecycle(candidates[0].path, 'close-window', env, 42, { pid: 100, start: '134391186778779367' }), /native refusal/);
    const evidence = readFileSync(join(root, 'windows-lifecycle-candidates.jsonl'), 'utf8');
    const rows = evidence.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.ok), [true, true, false]);
    assert.ok(rows.every(row => row.appPid === 42 && row.candidates.length === 2));
    assert.deepEqual(rows.map(row => row.diagnostics), [diagnostics, diagnostics, diagnostics], 'success and refusal must retain native diagnostics');
    assert.doesNotMatch(evidence, /NOT-RETAINED|commandLine/);
    for (const pid of [0, -1, 1.5, NaN]) await assert.rejects(nativeLifecycle(candidates[0].path, 'close-window', env, pid));
    assert.equal(calls.length, 3, 'invalid PID never reaches the native helper');
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
  assert.match(close, /check\(`single app process before close-window: appCandidates=\$\{JSON\.stringify\(census\.appCandidates\)\}, serviceLauncher=\$\{JSON\.stringify\(census\.serviceLauncher\)\}`/);
  assert.match(close, /census\.appCandidates\?\.length === 1 && census.appCandidates\[0\].pid === windowsAppPid/);
  assert.ok(close.indexOf('single app process before close-window') < close.indexOf('nativeLifecycle(binary, action, env,'));
  assert.match(close, /nativeLifecycle\(binary, action, env, process\.platform === "win32" \? windowsAppPid : undefined, windowsDaemon\)/);
  assert.match(caller, /row\.source === "process-argv" && row\.atUnixMs >= launchStarted/);
  const stop = caller.slice(caller.indexOf('const stopDriver ='), caller.indexOf('const open ='));
  assert.match(stop, /process\.platform === "linux" && linuxAppPid !== undefined/);
  assert.doesNotMatch(stop, /process\.kill\(pid/);
  assert.match(stop, /\/proc\/\$\{pid\}\/stat/);
  assert.match(stop, /owned Linux app process exit/);
  assert.match(caller, /if \(process\.platform === "linux"\) await lifecycle\("quit"\);\s*await stopDriver\(\);\s*const afterQuit = await status\(\);/);
});

test('app census excludes only the answering daemon parent with exact birth/path and retains complete evidence', () => {
  const census = helper.slice(helper.indexOf('if ($DaemonPid)'), helper.indexOf("if ($Action -eq 'login-entry')"));
  assert.doesNotMatch(census, /\$Action -ne 'describe'/);
  assert.match(census, /Get-CimInstance Win32_Process -Filter "ProcessId=\$DaemonPid" -Property ProcessId,ParentProcessId/);
  assert.doesNotMatch(census, /CommandLine|\.CreationDate/);
  for (const marker of ['ToFileTimeUtc().ToString() -cne $DaemonStart', '$null = $daemonProcess.Handle', '$null = $launcher.Handle', '$launcher.Id -eq $AppPid', '$launcher.Path, $expected', '$launcher.StartTime -gt $daemonProcess.StartTime', '$matchingLauncher.Count -ne 1', '$daemonProcess.HasExited -or $launcher.HasExited']) assert.ok(census.includes(marker), marker);
  assert.match(census, /\$appCandidates = @\(\$candidates \| Where-Object \{ \$_.pid -ne \$serviceLauncher.pid \}\)/);
  assert.doesNotMatch(census, /\$candidates =/);
  assert.match(helper, /if \(\$DaemonPid -and \(\$appCandidates\.Count -ne 1 -or \$appCandidates\[0\]\.pid -ne \$AppPid\)\)/);
});

test('tray icon lookup probes uID 1..16 on owned tray_icon_app requiring one S_OK, uses structural chevron 303/1502 when needed, and verifies #32768 menu owner and Settings… before pressing', () => {
  assert.match(helper, /Tauri 2\.12\.5[\s\S]*?tray-icon 0\.25\.1[\s\S]*?TrayIconId::new_unique\(\)[\s\S]*?TrayIcon::new/);
  assert.match(helper, /Shell_NotifyIconGetRect/);
  assert.match(helper, /NOTIFYICONIDENTIFIER/);
  const tray = helper.slice(helper.indexOf('# Tauri 2.12.5 tray/mod.rs:230-232'), helper.indexOf('# Keep the caller'));
  assert.match(tray, /className -ceq 'tray_icon_app'/);
  assert.match(tray, /foreach \(\$candidateUid in 1\.\.16\)/);
  assert.match(tray, /\$matches\.Count -gt 1/);
  assert.match(tray, /Ambiguous Shell_NotifyIconGetRect S_OK count/);
  assert.match(tray, /Shell_NotifyIconGetRect returned no S_OK for tray_icon_app hwnd/);
  assert.match(tray, /uID = \$foundUid/);
  assert.match(tray, /matchingUids =/);
  assert.match(tray, /Get-TrayIconTarget 'initial'/);
  assert.ok(tray.indexOf("Get-TrayIconTarget 'initial'") < tray.indexOf("AutomationId -ceq '303'"));
  assert.match(tray, /ClassName -ceq 'TrayNotifyWnd' -and \$_\.Current\.AutomationId -ceq '303'/);
  assert.match(tray, /ClassName -ceq 'Button' -and \$child\.Current\.AutomationId -ceq '1502'/);
  assert.match(tray, /overflowMatches = @\(\$expanders \| ForEach-Object/);
  assert.ok(tray.indexOf('overflowMatches =') < tray.indexOf('if ($expanders.Count -ne 1)'));
  assert.match(tray, /chevronHitTest =/);
  assert.match(tray, /Get-TrayIconTarget 'after-overflow'/);
  assert.match(tray, /overflowOpened =/);
  assert.match(tray, /menuObservation =/);
  assert.match(tray, /menuOwnerPid =/);
  assert.match(tray, /hasSettingsItem =/);
  assert.match(tray, /'Settings' \+ \[char\]0x2026/);
  assert.ok(tray.indexOf('hasSettingsItem') < tray.indexOf('GetMenuItemRect'));
});

test('raw tray diagnostics walk every verified surface including hidden overflow without selecting them', () => {
  const raw = helper.slice(helper.indexOf('function Record-RawExplorerTree'), helper.indexOf('function Explorer-Surfaces'));
  assert.match(raw, /\[System.Windows.Automation.TreeWalker\]::RawViewWalker/);
  assert.match(raw, /GetFirstChild\(\$parent\)/);
  assert.match(raw, /GetNextSibling\(\$element\)/);
  assert.match(raw, /Walk-RawChildren \$element/);
  for (const field of ['controlType = $current.ControlType.ProgrammaticName', 'name = $current.Name', 'automationId = $current.AutomationId',
    'className = $current.ClassName', 'frameworkId = $current.FrameworkId', 'offscreen = $current.IsOffscreen', 'boundingRectangle =',
    'empty = $rect.IsEmpty', 'left =', 'top =', 'width =', 'height =', 'rawDescendantCount = $null']) assert.ok(raw.includes(field), field);
  assert.ok(raw.indexOf('$diagnostics.Add($row)') < raw.indexOf('Walk-RawChildren $surface'));
  assert.match(raw, /\$row\['rawDescendantCount'\] = \$descendants.Count/);
  assert.doesNotMatch(raw, /IsControlElement|ControlViewWalker|Click-Element|Invoke\(/);
  const surfaces = helper.slice(helper.indexOf('function Explorer-Surfaces'), helper.indexOf('function Explorer-Children'));
  assert.match(surfaces, /foreach \(\$window in \$trayWindows\)/);
  assert.ok(surfaces.indexOf('Tray surface is not owned by Windows Explorer.') < surfaces.indexOf('Record-RawExplorerTree $surface $window'));
  assert.ok(surfaces.indexOf('Record-RawExplorerTree $surface $window') < surfaces.indexOf('if ($window.visible) { $surface }'));
});

test('tray diagnostics distinguish absent native surfaces from empty UI Automation descendants', () => {
  const surfaces = helper.slice(helper.indexOf('function Explorer-Surfaces'), helper.indexOf('    Process-Candidates'));
  assert.match(surfaces, /explorerSurfaces = @\(\$trayWindows \| ForEach-Object/);
  for (const field of ['className = $_.className', 'hwnd = $_.hwnd', 'visible = $_.visible', 'pid = $_.pid']) assert.ok(surfaces.includes(field), field);
  assert.match(surfaces, /if \(\$window.visible\) \{ \$surface \}/);
  assert.match(surfaces, /function Explorer-Children/);
  for (const field of ['className = $surface.Current.ClassName', 'hwnd = $surface.Current.NativeWindowHandle', 'pid = $surface.Current.ProcessId', 'descendantCount = $null']) assert.ok(surfaces.includes(field), field);
  assert.ok(surfaces.indexOf('$diagnostics.Add($row)') < surfaces.indexOf('$elements = @(Children $surface)'));
  assert.match(surfaces, /\$row\['descendantCount'\] = \$elements.Count/);
});
