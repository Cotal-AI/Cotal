import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import test from 'node:test';
import { privateChildEnv, requestState, runController } from './windows-journey.mjs';

for (const outcome of ['success', 'failure', 'cancel']) {
  test(`account-only controller uses one real IPC child and preserves ${outcome} cleanup`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'account-controller-'));
    const directory = join(root, 'private'), output = join(root, 'desktop-account-e2e');
    mkdirSync(output);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let launches = 0, childExit, finallySeen = false;
    const running = runController(directory, output, { cell: 'account-only', retainMs: 5,
      spawnFixture(node, args, options) {
        launches++;
        assert.deepEqual(args.slice(3), ['--desktop-window', '--keep-fixture', '--desktop-account']);
        assert.equal(options.env.HOME, join(directory, 'outer-account', 'home'));
        const script = `
          const finish = new Promise(resolve => process.once('message', resolve));
          process.send({ kind: 'progress', phase: 'account-ready', status: 'start' });
          await finish;
          try { process.exitCode = ${outcome === 'success' ? 0 : 1}; }
          finally { process.send({ kind: 'progress', phase: 'cleanup-account', status: 'start' });
            process.send({ kind: 'progress', phase: 'cleanup-account', status: 'complete' }); }
          process.disconnect();
        `;
        const child = spawn(node, ['--input-type=module', '-e', script], options);
        childExit = once(child, 'exit');
        child.on('message', row => {
          if (row.phase === 'cleanup-account' && row.status === 'complete') finallySeen = true;
          if (row.phase === 'account-ready' && outcome !== 'cancel') child.send({ kind: 'finish' });
        });
        return child;
      },
    });
    let controller;
    for (let n = 0; n < 200; n++) {
      try { controller = JSON.parse(readFileSync(join(directory, 'controller.json'), 'utf8')); break; }
      catch { await delay(5); }
    }
    assert.ok(controller);
    if (outcome === 'cancel') {
      await assert.rejects(requestState(controller, 'resume'), /refused/);
      assert.equal((await requestState(controller, 'status')).state, 'account');
      await requestState(controller, 'cancel');
    }
    await running;
    await childExit;
    assert.equal(launches, 1);
    assert.equal(finallySeen, true);
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.code, outcome === 'success' ? 0 : 1);
    assert.equal(result.cancelled, outcome === 'cancel');
    const records = readFileSync(join(output, 'windows-journey-phases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(row => row.kind === 'fixture-exit'));
    assert.ok(!records.some(row => row.phase === 'service-recovery' || row.phase === 'paused'));
  });
}

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
