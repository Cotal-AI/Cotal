import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLaunchctlList, awaitingBootstrap, assertFailure, retryClock, assertRetryBudget, FAILURE } from './mac-pre-result-kill.mjs';

const label = `ai.cotal.update.${'a'.repeat(32)}`;
const header = 'PID\tStatus\tLabel\n';
test('documented full list resolves only the exact label and distinguishes absent from stopped', () => {
  assert.equal(parseLaunchctlList(header + `98 0 ${label}.other\n123 -9 ${label}\n`, label), 123);
  assert.equal(parseLaunchctlList(header + `- -9 ${label}\n`, label), 0);
  assert.equal(parseLaunchctlList(header + `123 0 ${label}.other\n`, label), undefined);
  assert.equal(parseLaunchctlList(header, label), undefined);
});
test('missing headers, duplicate labels, malformed rows and unsafe PIDs fail closed', () => {
  for (const text of [
    `123 0 ${label}`, 'pid status label\n', `Status PID Label\n123 0 ${label}`,
    header + `123 0 ${label}\n124 0 ${label}`,
    header + `123 bad ${label}`, header + `1 0 ${label}`,
    header + `9007199254740992 0 ${label}`, header + `123 0 ${label} extra`,
  ]) assert.throws(() => parseLaunchctlList(text, label));
});
test('receipt before bootstrap waits only for absent or loaded-not-running native job', () => {
  assert.equal(awaitingBootstrap('absent', undefined), true);
  assert.equal(awaitingBootstrap('loaded', 0), true);
  for (const [state, pid] of [['loaded', 123], ['absent', 123], ['unavailable', undefined], ['loaded', undefined]]) {
    assert.equal(awaitingBootstrap(state, pid), false);
  }
});
test('cleanup requires the exact product failure and a single increment', () => {
  assert.doesNotThrow(() => assertFailure({ failures: 3, result: FAILURE }, 2));
  for (const failures of [0, 2, 4, '3', undefined]) {
    assert.throws(() => assertFailure({ failures, result: FAILURE }, 2));
  }
  assert.throws(() => assertFailure({ failures: 3, result: 'failed' }, 2));
  assert.throws(() => assertFailure(undefined, 2));
});
test('retry accounting permits failed once, replacement begins, then success reset', () => {
  for (const failures of [1, 2, 0]) assert.doesNotThrow(() => assertRetryBudget({ failures }, 0));
  for (const failures of [3, -1, '2', undefined]) assert.throws(() => assertRetryBudget({ failures }, 0));
});

test('retry clock changes only next and leaves its input intact for retained proof', () => {
  const before = { failures: 3, result: FAILURE, next: 9000, other: 'keep' };
  const original = structuredClone(before);
  const after = retryClock(before, 8000000);
  assert.deepEqual(before, original);
  assert.deepEqual(after, { ...before, next: 800000 });
  assert.notEqual(after, before);
  for (const next of [undefined, '9000', NaN, Infinity]) assert.throws(() => retryClock({ next }, 8000000));
});
