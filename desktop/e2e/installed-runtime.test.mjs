import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./launch.ts', import.meta.url), 'utf8');

test('installed Windows failure preserves the original verdict and captures native Details before teardown', () => {
  const failure = source.slice(source.indexOf('} catch (error) {\n  report.outcome'), source.indexOf('\nfinally {'));
  assert.match(failure, /process.platform === "win32" && nativePid/);
  assert.match(failure, /windows-launch-details.ps1/);
  assert.match(failure, /"-AppPid", String\(nativePid\)/);
  assert.match(failure, /"-Binary", binary!/);
  assert.match(failure, /"failure-details.json"/);
  assert.match(failure, /"failure-details.png"/);
  assert.doesNotMatch(failure, /bridgeTrace|CDP|remote-debugging/);
  assert.match(failure, /throw error;/);
  assert.doesNotMatch(failure, /outcome = "passed"|nativeLifecycle|NODE_OPTIONS|--features|daemon.*desktop/);
});

test('Windows failure block retains failed native Details and never replaces the original error', () => {
  const block = source.slice(source.indexOf('  report.outcome = "failed"; report.failure'), source.indexOf('\n  if (process.platform === "linux") {', source.indexOf('  report.outcome = "failed"; report.failure'))).replace('binary!', 'binary');
  for (const diagnosticThrows of [false, true]) {
    const calls = [], writes = [], report = {}, original = new Error('original metadata timeout');
    runInNewContext(block, { report, error: original, process: { platform: 'win32' }, nativePid: 42, binary: 'C:/owned/cotal-desktop.exe', repo: '/repo', output: '/proof', env: {},
      performance: { now: () => 10 }, join: (...parts) => parts.join('/'),
      spawnSync: (file, args, options) => { calls.push({ file, args, options }); if (diagnosticThrows) throw new Error('diagnostic refused'); return { status: 1, signal: null, stdout: '{"ok":false,"error":"UIA unavailable"}', stderr: 'native refused' }; },
      writeFileSync: (file, data) => writes.push({ file, data: JSON.parse(data) }),
    });
    assert.equal(report.outcome, 'failed');
    assert.equal(report.failure, String(original));
    assert.equal(report.bridgeTrace, undefined);
    assert.equal(calls[0].args.at(-1), 'C:/owned/cotal-desktop.exe');
    assert.equal(calls[0].options.timeout, 20_000);
    if (diagnosticThrows) assert.match(report.detailsDiagnosticError, /diagnostic refused/);
    else {
      assert.equal(writes[0].data.status, 1);
      assert.equal(writes[0].data.source, 'native-uia-details');
      assert.equal(calls[1].args.at(-1), '/proof/failure-details.png');
    }
  }
});

test('Windows Details helper pins the installed process and admits only the exact disclosure action', () => {
  const helper = readFileSync(new URL('./windows-launch-details.ps1', import.meta.url), 'utf8');
  for (const marker of ['$null = $owner.Handle', '$report.imagePaths.observedRaw = $owner.Path', '$report.birth', 'GetWindowThreadProcessId($hwnd', '$windowPid -ne $AppPid', 'IsWindowVisible($hwnd)', "AutomationId -ceq 'details'", "AutomationId -ceq 'refusal-detail'", "$_.Current.Name -ceq 'Details'", '$buttons.Count -ne 1', 'InvokePattern', '$report.before', '$report.after', '$report.refusal']) assert.ok(helper.includes(marker), marker);
  assert.equal((helper.match(/\$invoke.Invoke\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(helper, /mouse_event|SetCursorPos|Try again|AutomationId -ceq 'recover'|daemon_request|NODE_OPTIONS/);
});

test('native Windows ownership accepts short and long names of one file and rejects another file', { skip: process.platform !== 'win32' }, () => {
  const helper = readFileSync(new URL('./windows-launch-details.ps1', import.meta.url), 'utf8');
  const code = helper.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const admission = helper.slice(helper.indexOf('    $report.imagePaths.observedRaw ='), helper.indexOf('    $hwnd = $owner.MainWindowHandle'));
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
${code}
'@
Add-Type @'
using System.Text;
using System.Runtime.InteropServices;
public static class ShortPathTest {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  public static extern uint GetShortPathNameW(string path, StringBuilder result, uint capacity);
}
'@
$root = Join-Path ([IO.Path]::GetTempPath()) ('cotal-long-identity-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
try {
  $first = Join-Path $root 'Installed Application One.exe'
  $second = Join-Path $root 'Installed Application Two.exe'
  [IO.File]::WriteAllText($first, 'first')
  [IO.File]::WriteAllText($second, 'second')
  $buffer = [Text.StringBuilder]::new(32768)
  $length = [ShortPathTest]::GetShortPathNameW($first, $buffer, [uint32]$buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Native short path unavailable.' }
  $short = $buffer.ToString()
  if ($short -ceq $first) { throw 'Test did not produce a distinct short spelling.' }
  function Check-Admission($expected, $observed) {
    $owner = [pscustomobject]@{ Path = $observed }
    $report = [ordered]@{ imagePaths = [ordered]@{ expectedRaw = $expected; observedRaw = $null; expectedNormalized = $null; observedNormalized = $null } }
    $accepted = $false
    try {
${admission}
      $accepted = $true
    } catch { }
    [pscustomobject]@{ accepted = $accepted; paths = $report.imagePaths }
  }
  $same = Check-Admission $short $first
  if (!$same.accepted) { throw 'Same file short/long identity refused.' }
  if ($same.paths.expectedRaw -cne $short -or $same.paths.observedRaw -cne $first -or $same.paths.expectedNormalized -cne $same.paths.observedNormalized) { throw 'Raw/normalized image path receipts lost.' }
  $different = Check-Admission $short $second
  if ($different.accepted) { throw 'Different files admitted.' }
  if (!$different.paths.expectedNormalized -or !$different.paths.observedNormalized) { throw 'Refusal lost normalized image paths.' }
  $missingRefused = $false
  try { $null = [LaunchDetailsWindow]::LongPath((Join-Path $root 'missing.exe')) } catch { $missingRefused = $true }
  if (!$missingRefused) { throw 'Missing file did not fail closed.' }
  Write-Output 'same-short-long PASS; different-file REFUSED; missing-file REFUSED'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000 });
  assert.match(result, /same-short-long PASS; different-file REFUSED; missing-file REFUSED/);
});

test('installed launch ownership resolves both executable spellings through the native long-path API', () => {
  const helper = readFileSync(new URL('./windows-launch-details.ps1', import.meta.url), 'utf8');
  assert.match(helper, /GetLongPathNameW/);
  assert.match(helper, /expectedRaw = \$Binary; observedRaw = \$null; expectedNormalized = \$null; observedNormalized = \$null/);
  assert.match(helper, /\$report.imagePaths.observedRaw = \$owner.Path/);
  assert.match(helper, /expectedNormalized = \[LaunchDetailsWindow\]::LongPath\(\$expected\)/);
  assert.match(helper, /observedNormalized = \[LaunchDetailsWindow\]::LongPath\(\$report.imagePaths.observedRaw\)/);
  assert.match(helper, /Equals\(\$report.imagePaths.observedNormalized, \$report.imagePaths.expectedNormalized/);
  assert.match(helper, /if \(length == 0\) throw/);
  assert.match(helper, /if \(length >= buffer.Capacity\) throw/);
  assert.doesNotMatch(helper, /EndsWith|GetFileName|\.Path, \$expected, \[StringComparison\]/);
});

test('installed refusal process census publishes only app descendants and explicit unknown on failure', () => {
  const helper = readFileSync(new URL('./windows-launch-details.ps1', import.meta.url), 'utf8');
  const census = helper.slice(helper.indexOf('$processes = @('), helper.indexOf('$root = [System.Windows.Automation.AutomationElement]'));
  assert.match(census, /Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate/);
  assert.match(census, /\$parents = @\(\$AppPid\)/);
  assert.match(census, /\$process.ParentProcessId -in \$parents/);
  assert.match(census, /\$seen.Add\(\[int\]\$process.ProcessId\)/);
  assert.match(census, /\$parents = \$next/);
  for (const field of ['name = $process.Name', 'pid = $process.ProcessId', 'parentPid = $process.ParentProcessId', "creationTime = $process.CreationDate.ToUniversalTime().ToString('o')"]) assert.ok(census.includes(field), field);
  assert.match(census, /Assert-WindowOwner/);
  assert.match(census, /processTreeError/);
  assert.match(helper, /processTree = \$null/);
  assert.doesNotMatch(helper, /CommandLine|ExecutablePath|GetOwner|Environment|\.Arguments/);
});

test('installed entitlement assertion accepts codesign output forms and rejects a missing key', () => {
  const assertion = source.split('\n').find(line => line.includes('assert.match(entitlements,'));
  assert.ok(assertion);
  for (const entitlements of [
    '<dict><key>com.apple.security.cs.allow-jit</key><true/></dict>',
    '[Dict]\n\t[Key] com.apple.security.cs.allow-jit\n\t[Value]\n\t\t[Bool] true',
  ]) runInNewContext(assertion, { assert, entitlements });
  assert.throws(() => runInNewContext(assertion, { assert, entitlements: '[Dict]' }), { code: 'ERR_ASSERTION' });
});

test('installed macOS client executes the shipped signature and its own Node and CLI', () => {
  const start = source.indexOf('const installed = "/Applications/Cotal.app"');
  const end = source.indexOf('} else if (process.platform === "win32")', start);
  const mac = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(mac, /assert\.ok\(!existsSync\(installed\)/);
  assert.match(mac, /run\("ditto", \[join\(mount, apps\[0\]\), installed\]\)/);
  assert.ok(mac.includes('run("codesign", ["--verify", "--deep", "--strict", installed])'));
  assert.doesNotMatch(mac, /--force|--sign|--preserve-metadata/);
  assert.ok(mac.includes('const node = join(installed, "Contents/MacOS/cotal-node")'));
  assert.ok(mac.includes('const cli = join(installed, "Contents/Resources/runtime/dist/cotal.js")'));
  assert.ok(mac.includes('assert.equal(realpathSync(node), node'));
  assert.ok(mac.includes('assert.equal(realpathSync(cli), cli'));
  assert.ok(mac.includes('["-d", "--entitlements", "-", node]'));
  assert.match(mac, /com\\\.apple\\\.security\\\.cs\\\.allow-jit/);
  assert.ok(mac.includes('const args = [cli, "daemon", "status", "--json"]'));
  assert.ok(mac.includes('spawnSync(node, args, { env, cwd: env.HOME'));
  for (const assertion of ['status.status, 2', 'status.signal, null', 'answer.schemaVersion, 1', 'answer.command, "daemon status"', 'answer.completeness, "not-checked"', 'answer.outcome, "refused"', 'answer.result, null', 'answer.error?.code, "TARGET_UNAVAILABLE"', 'answer.error?.cause?.code, "NOT_RUNNING"']) assert.ok(mac.includes(assertion), assertion);
  assert.ok(mac.includes('"applications-daemon-status.json"'));
  assert.ok(mac.includes('"applications-node-entitlements.plist"'));
  assert.ok(mac.indexOf('spawnSync(node, args') < mac.indexOf('targets.push('));
});

test('installed Windows launch requires settled welcome with Continue with Cotal Cloud and screens out exact refusal text within 45 s', () => {
  const win = source.slice(source.lastIndexOf('} else if (process.platform === "win32")'), source.indexOf('} else {', source.lastIndexOf('} else if (process.platform === "win32")')));
  const match = win.match(/},\s*(value\s*=>\s*[\s\S]*?),\s*45_000\)/);
  assert.ok(match, 'Windows welcome wait keeps its 45 s bound');
  const predicate = runInNewContext(match[1].replace(/ as \{[^}]+\}\[\]/g, ''), { JSON });
  const checking = JSON.stringify([
    { name: 'runnervm9zap3', id: '', type: 'ControlType.Text' },
    { name: 'Windows · 64-bit Intel / AMD · 16 GB', id: '', type: 'ControlType.Text' },
    { name: 'Checking connection', id: '', type: 'ControlType.Text' },
    { name: 'Welcome to Cotal', id: '', type: 'ControlType.Group' },
    { name: 'Checking this computer…', id: 'loading-title', type: 'ControlType.Text' },
  ]).toLowerCase();
  const refusal = JSON.stringify([
    { name: 'Windows · 64-bit Intel / AMD · 16 GB', id: '', type: 'ControlType.Text' },
    { name: 'Welcome to Cotal', id: '', type: 'ControlType.Group' },
    { name: 'Continue with Cotal Cloud', id: 'login', type: 'ControlType.Button' },
    { name: 'This operation could not finish', id: 'connection-title', type: 'ControlType.Text' },
  ]).toLowerCase();
  const settled = JSON.stringify([
    { name: 'runnervm9zap3', id: '', type: 'ControlType.Text' },
    { name: 'Windows · 64-bit Intel / AMD · 16 GB', id: '', type: 'ControlType.Text' },
    { name: 'Not connected', id: '', type: 'ControlType.Text' },
    { name: 'Welcome to Cotal', id: 'connection-title', type: 'ControlType.Text' },
    { name: 'Continue with Cotal Cloud', id: 'login', type: 'ControlType.Button' },
  ]).toLowerCase();
  assert.equal(predicate(checking), false, 'Checking this computer… must not pass');
  assert.equal(predicate(refusal), false, 'This operation could not finish must not pass');
  assert.equal(predicate(settled), true, 'settled welcome with Continue with Cotal Cloud button must pass');
  assert.match(win, /replace\(\/\^\\uFEFF\/, ""\)/);
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node --test[\s\S]*?desktop\/e2e\/installed-runtime\.test\.mjs/);
});
