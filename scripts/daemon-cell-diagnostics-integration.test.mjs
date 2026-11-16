import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runDiagnosticCommand } from './automatic-update-platform-baseline.mjs';

// These real child commands exercise the observer runner, not a native service or an upgrade.
test('diagnostic command retains real child output and nonzero outcome without throwing', async () => {
  for (const exit of [0, 3]) {
    const result = await runDiagnosticCommand(process.execPath, ['-e', `console.log('observed');console.error('diagnostic');process.exitCode=${exit}`]);
    assert.equal(result.exit, exit);
    assert.equal(result.stdout, 'observed\n');
    assert.equal(result.stderr, 'diagnostic\n');
    assert.equal(result.timeout, false);
    assert.equal(result.truncated, false);
    assert(result.finishedAt >= result.startedAt);
  }
});

test('diagnostic timeout kills only its own child and retains an explicit unknown result', { skip: process.platform === 'win32' ? 'Unix signal result is asserted on POSIX' : false }, async () => {
  const result = await runDiagnosticCommand(process.execPath, ['-e', "process.stdout.write('started');setInterval(()=>{},1000)"], { timeoutMs: 200 });
  assert.equal(result.timeout, true);
  assert.equal(result.exit, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, 'started');
});

test('diagnostic timeout closes inherited pipes from its owned descendant group', { skip: process.platform === 'win32' ? 'POSIX process-group proof only' : false }, async () => {
  const grandchild = "setTimeout(()=>{},900)";
  const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});console.log(child.pid);setInterval(()=>{},1000)`;
  const started = Date.now();
  const result = await runDiagnosticCommand(process.execPath, ['-e', code], { timeoutMs: 100 });
  assert.equal(result.timeout, true);
  assert.equal(result.signal, 'SIGKILL');
  assert(Date.now() - started < 700, 'must not wait for the 900ms descendant to close inherited pipes');
  assert.match(result.stdout, /^\d+\n$/);
});

test('diagnostic output bound and spawn error remain explicit', async () => {
  const result = await runDiagnosticCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"], { maxBytes: 1024 });
  assert.equal(result.truncated, true);
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  const missing = await runDiagnosticCommand('/nonexistent-upgrade-matrix-observer-command', []);
  assert.equal(missing.exit, null);
  assert.match(missing.error, /ENOENT/);
});

test('all installed native service paths capture before update and before any cleanup on every outcome', () => {
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  const before = source.indexOf("await captureServiceEvidence('before-update')");
  const action = source.indexOf("if (options['first-install'] === 'true') update = sourceInstall");
  const final = source.indexOf("await captureServiceEvidence('after-update')");
  assert(before > 0 && before < action);
  assert(final > source.indexOf('} catch (error) {', action));
  for (const cleanup of ["if (compositionCleanup && !daemonHostedManager)", "if (daemonHostedManager && !uncertain", "if (installedService) {\n      report.cleanup"]) {
    assert(final < source.indexOf(cleanup, final));
  }
  const collector = source.slice(source.indexOf('async function captureServiceEvidence'), source.indexOf('async function call('));
  assert(collector.includes('if (!installedService) return'));
  assert(!collector.includes('uncertain ='));
  assert(!collector.includes('report.result ='));
  assert(!collector.includes('check('));
  assert(collector.includes("state: 'unreadable'"));
});
