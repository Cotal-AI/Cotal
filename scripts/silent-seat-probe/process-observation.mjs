import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// The caller supplies the shipped Windows binding. Never convert an unreadable
// process into an exited process or inspect any process's command line.
export function retainProcess(binding, identity) {
  assert(Number.isSafeInteger(identity.pid) && identity.pid > 0, 'invalid fixture PID');
  assert.equal(typeof identity.token, 'string');
  assert(identity.token.length > 0, 'missing fixture creation token');
  const pin = binding.pinProcess(identity.pid);
  if (pin.token !== identity.token) {
    pin.close();
    throw new Error(`fixture PID ${identity.pid} changed incarnation before observation`);
  }
  let closed = false;
  return {
    identity: { ...identity },
    observe() {
      assert(!closed, 'observation pin already closed');
      const exited = pin.exited();
      assert.equal(typeof exited, 'boolean');
      return { ...identity, exited, observedAt: new Date().toISOString() };
    },
    close() {
      if (!closed) { closed = true; pin.close(); }
    },
  };
}

export async function observeAfterStop(retained, stopCompletedAt, record, offsets = [0, 15000, 65000]) {
  assert(Number.isFinite(stopCompletedAt), 'missing monotonic stop completion time');
  let prior = -1;
  for (const offsetMs of offsets) {
    assert(Number.isFinite(offsetMs) && offsetMs >= 0 && offsetMs > prior, 'offsets must increase');
    prior = offsetMs;
    await delay(Math.max(0, stopCompletedAt + offsetMs - performance.now()));
    const observation = {
      offsetMs,
      elapsedMs: performance.now() - stopCompletedAt,
      processes: retained.map((process) => process.observe()),
    };
    await record(observation);
  }
}
