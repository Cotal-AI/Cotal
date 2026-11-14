import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { retainProcess, observeAfterStop } from './process-observation.mjs';

// These are helper contract tests only. They do not reproduce the Windows defect.
let closed = 0;
let exited = false;
const binding = {
  pinProcess: () => ({ token: 'birth-1', exited: () => exited, close: () => closed++ }),
};
assert.throws(() => retainProcess(binding, { pid: 0, token: 'birth-1' }), /invalid fixture PID/);
assert.throws(() => retainProcess(binding, { pid: 123, token: 'birth-2' }), /changed incarnation/);
assert.equal(closed, 1);
const retained = retainProcess(binding, { pid: 123, token: 'birth-1', role: 'seat' });
assert.equal(retained.observe().exited, false);
exited = true;
assert.equal(retained.observe().exited, true);
retained.close();
retained.close();
assert.equal(closed, 2);
assert.throws(() => retained.observe(), /already closed/);
assert.throws(() => retainProcess({ pinProcess() { throw new Error('ACCESS_DENIED'); } }, { pid: 123, token: 'birth-1' }), /ACCESS_DENIED/);
const unreadable = retainProcess({ pinProcess: () => ({ token: 'birth-1', exited() { throw new Error('WAIT_FAILED'); }, close() {} }) }, { pid: 123, token: 'birth-1' });
assert.throws(() => unreadable.observe(), /WAIT_FAILED/);
unreadable.close();
const rows = [];
await observeAfterStop([{ observe: () => ({ exited: false }) }], performance.now(), (row) => rows.push(row), [0, 5, 10]);
assert.deepEqual(rows.map((row) => row.offsetMs), [0, 5, 10]);
assert(rows.every((row) => row.elapsedMs >= row.offsetMs - 2));
assert(rows.every((row) => row.processes[0].exited === false));
await assert.rejects(observeAfterStop([], performance.now(), () => {}, [0, 0]), /offsets must increase/);
console.log('Observation helper contracts passed. Synthetic only, no Windows reproduction.');
