/** Observe and interrupt only a real public repair child after its own protected intent is visible. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function interruptRepairAtPhase({ file, args, cwd, env, phase, birth, inspect, confirmStopped, observeNative, record, timeoutMs = 90000 }) {
  assert.equal(process.platform, 'darwin', 'repair interruption acceptance requires actual macOS');
  assert(['prepared', 'published'].includes(phase));
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 130000);
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError;
  let ended = false, suspended = false, stoppedBirth, captured, closeResult;
  child.stdout.on('data', bytes => stdout += bytes);
  child.stderr.on('data', bytes => stderr += bytes);
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', (exit, signal) => { ended = true; closeResult = { exit, signal }; resolve(closeResult); }));
  const deadline = Date.now() + timeoutMs;
  const sameChild = () => !ended && child.pid && stoppedBirth && birth(child.pid) === stoppedBirth;
  const send = signal => {
    assert(sameChild(), 'the public repair child lifetime changed; no signal was sent');
    process.kill(child.pid, signal);
  };
  const awaitClose = async bound => {
    let timer;
    try {
      return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned public repair child did not confirm exit within its observation bound')), bound); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    for (;;) {
      if (spawnError) throw spawnError;
      if (ended) throw new Error(`setup miss: public repair finished before real ${phase} intent was captured`);
      if (Date.now() >= deadline) throw new Error(`setup miss: real ${phase} intent was not captured within the observation bound`);
      stoppedBirth ??= child.pid ? birth(child.pid) : undefined;
      if (stoppedBirth) break;
      await delay(5);
    }
    record({ event: 'repair-child', pid: child.pid, birth: stoppedBirth, phase });
    while (Date.now() < deadline && !ended) {
      // inspect reads the shipped protected record and validates the real source/receipt pair.
      const observation = inspect();
      if (observation?.phase === phase) {
        send('SIGSTOP'); suspended = true;
        confirmStopped(child.pid, stoppedBirth);
        const stopped = inspect();
        assert.equal(stopped?.phase, phase, 'setup miss: intent phase changed before the actual public child was suspended');
        assert(sameChild(), 'public child changed after suspension');
        const native = observeNative();
        const afterNative = inspect();
        assert.deepEqual(afterNative, stopped, 'setup miss: persisted repair state changed during suspended native observation');
        captured = { ...stopped, native };
        record({ event: 'captured-real-phase', pid: child.pid, birth: stoppedBirth, phase, observation: captured });
        send('SIGKILL'); suspended = false;
        const result = await awaitClose(10000);
        assert.equal(result.signal, 'SIGKILL', 'the exact interrupted public CLI must confirm the requested exit');
        assert.notEqual(birth(child.pid), stoppedBirth, 'the interrupted public CLI lifetime must end before retry');
        record({ event: 'interrupted-child-exited', pid: child.pid, birth: stoppedBirth, ...result });
        return { ...result, pid: child.pid, birth: stoppedBirth, phase, captured, stdout, stderr };
      }
      await delay(5);
    }
    throw new Error(`setup miss: real ${phase} intent was not captured before public repair ended or its bound elapsed`);
  } finally {
    try {
      if (suspended) {
        if (sameChild()) { send('SIGCONT'); suspended = false; }
        else if (!ended) throw new Error('suspended public repair child identity could not be confirmed for resume');
      }
      if (!ended) {
        // An unsuccessful capture resumes its real CLI and records normal completion first.
        try { await awaitClose(Math.max(1, deadline - Date.now())); }
        catch {
          // An elapsed setup bound is never crash acceptance. Retire only this pinned CLI.
          if (!sameChild()) throw new Error('public repair CLI cleanup lifetime is unconfirmed');
          send('SIGTERM');
          try { await awaitClose(5000); }
          catch {
            send('SIGKILL');
            await awaitClose(5000);
          }
        }
      }
    } catch (error) {
      record({ event: 'cleanup-unconfirmed', pid: child.pid, birth: stoppedBirth });
      throw error;
    } finally {
      record({ event: 'repair-child-final', pid: child.pid, birth: stoppedBirth, captured: Boolean(captured), ended, closeResult, spawnError: spawnError?.message, stdout, stderr });
    }
  }
}
