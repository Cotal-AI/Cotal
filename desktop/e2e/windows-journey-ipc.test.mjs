import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { privateChildEnv } from './windows-journey.mjs';

for (const action of ['resume', 'cancel', 'disconnect']) {
  test(`actual checkpoint child executes finally after ${action}`, async () => {
    const moduleUrl = new URL('./windows-journey.mjs', import.meta.url).href;
    const script = `
      import { waitForResume } from ${JSON.stringify(moduleUrl)};
      try { await waitForResume(process, 'service-recovery-complete', 5000); }
      catch { process.exitCode = 1; }
      finally { if (process.connected) process.send({ kind: 'fixture-finally' }); }
      process.disconnect?.();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let finallySeen = false;
    child.on('message', row => { if (row?.kind === 'fixture-finally') finallySeen = true; });
    const exit = once(child, 'exit');
    const [checkpoint] = await once(child, 'message');
    assert.deepEqual(checkpoint, { kind: 'checkpoint', phase: 'service-recovery-complete' });
    if (action === 'disconnect') child.disconnect();
    else child.send({ kind: action, phase: 'service-recovery-complete' });
    const [code, signal] = await exit;
    assert.equal(code, action === 'resume' ? 0 : 1);
    assert.equal(signal, null);
    if (action !== 'disconnect') assert.equal(finallySeen, true);
  });
}

test('actual fixture emits bounded passive progress only with private split-journey IPC', async () => {
  const moduleUrl = new URL('./windows-journey.mjs', import.meta.url).href;
  const script = `
    import { windowsJourneyProgress } from ${JSON.stringify(moduleUrl)};
    windowsJourneyProgress({ phase: 'recovery-settled', status: 'start' });
    windowsJourneyProgress({ phase: 'secret=value', status: 'start' });
    windowsJourneyProgress({ phase: 'cleanup-driver-close', waitingOn: 'driver-stop', status: 'start' });
    process.disconnect();
  `;
  for (const split of [false, true]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', ...(split ? ['--desktop-service-phase'] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const records = [];
    child.on('message', row => records.push(row));
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(records, split ? [
      { kind: 'progress', phase: 'recovery-settled', status: 'start' },
      { kind: 'progress', phase: 'cleanup-driver-close', waitingOn: 'driver-stop', status: 'start' },
    ] : []);
  }
});

test('private import-time CLI environment keeps real Windows shell known folders', () => {
  const original = { HOME: 'foreign-home', COTAL_HOME: 'foreign-cotal', USERPROFILE: 'native-profile', APPDATA: 'native-roaming', LOCALAPPDATA: 'native-local' };
  const env = privateChildEnv('/owned/controller', original);
  assert.equal(env.HOME, join('/owned/controller', 'home'));
  assert.equal(env.COTAL_HOME, join('/owned/controller', 'cotal'));
  assert.equal(env.XDG_CONFIG_HOME, join('/owned/controller', 'config'));
  assert.equal(env.USERPROFILE, original.USERPROFILE);
  assert.equal(env.APPDATA, original.APPDATA);
  assert.equal(env.LOCALAPPDATA, original.LOCALAPPDATA);
  assert.equal(original.HOME, 'foreign-home');
});
