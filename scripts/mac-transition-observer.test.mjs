import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { validateHandoff, handoffEvidence } from './mac-transition-observer.mjs';

test('handoff source must match exact private home, label, argv and bytes', () => {
  const label = `ai.cotal.update.${'a'.repeat(32)}`, bytes = Buffer.from('native plist');
  const receipt = { failures: 0, label, source: `/home/fixture/.cotal/${label}.plist`, sha256: createHash('sha256').update(bytes).digest('hex'), argv: ['/node', '/runner.js', label] };
  assert.equal(validateHandoff('/home/fixture/.cotal', receipt, bytes), receipt);
  assert.throws(() => validateHandoff('/home/fixture/.cotal', { ...receipt, source: `/other/${label}.plist` }, bytes));
  assert.throws(() => validateHandoff('/home/fixture/.cotal', receipt, Buffer.from('wrong')));
  assert.throws(() => validateHandoff('/home/fixture/.cotal', { ...receipt, argv: ['/node', '/runner.js', 'other'] }, bytes));
});

test('terminal success alone cannot establish active handoff, process exit or retirement', () => {
  assert.deepEqual(handoffEvidence([{ records: { 'update-attempt.json': { result: 'updated to 0.164.5' } } }]), { handoffObserved: false, activeObserved: false, completionAndExitObserved: false, retired: false });
});

test('active, completed exited and retired must each be observed', () => {
  const receipt = { label: 'owned' };
  const active = { records: { 'update-launchd.json': receipt, 'update-launchd-result.json': { done: false } }, runnerAlive: true, jobs: [{ label: 'owned', lookup: { state: 'loaded' }, sourcePresent: true }] };
  const doneAlive = { records: { 'update-launchd.json': receipt, 'update-launchd-result.json': { done: true } }, runnerAlive: true, jobs: active.jobs };
  const doneExited = { ...doneAlive, runnerAlive: false };
  const retired = { records: {}, jobs: [{ label: 'owned', lookup: { state: 'absent' }, sourcePresent: false }] };
  assert.equal(handoffEvidence([active, doneAlive]).completionAndExitObserved, false);
  assert.deepEqual(handoffEvidence([active, doneExited, retired]), { handoffObserved: true, activeObserved: true, completionAndExitObserved: true, retired: true });
  assert.equal(handoffEvidence([doneExited, active, retired]).completionAndExitObserved, false);
  const otherDone = { ...doneExited, records: { 'update-launchd.json': { label: 'other' }, 'update-launchd-result.json': { done: true } } };
  assert.equal(handoffEvidence([active, otherDone, retired]).completionAndExitObserved, false);
  assert.equal(handoffEvidence([active, doneExited, retired], 'owned').retired, false);
  assert.equal(handoffEvidence([active, doneExited, { ...retired, jobs: [{ lookup: { state: 'unavailable' }, sourcePresent: false }] }]).retired, false);
});
