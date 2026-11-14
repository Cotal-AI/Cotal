import assert from 'node:assert/strict';
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
  for (const marker of ['$null = $owner.Handle', '$owner.Path, $expected', '$report.birth', 'GetWindowThreadProcessId($hwnd', '$windowPid -ne $AppPid', 'IsWindowVisible($hwnd)', "AutomationId -ceq 'details'", "AutomationId -ceq 'refusal-detail'", "$_.Current.Name -ceq 'Details'", '$buttons.Count -ne 1', 'InvokePattern', '$report.before', '$report.after', '$report.refusal']) assert.ok(helper.includes(marker), marker);
  assert.equal((helper.match(/\$invoke.Invoke\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(helper, /mouse_event|SetCursorPos|Try again|AutomationId -ceq 'recover'|daemon_request|NODE_OPTIONS/);
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
