import assert from 'node:assert/strict';
import test from 'node:test';
import { foreignStackEnded } from './foreign-stack-cleanup.mjs';
const fixture = () => ({
  before: { id: 'owned', label: 'cell', startedAt: '2026-11-14T06:44:51Z', pid1Supervise: true },
  stop: { exit: 137, signal: null, timeout: false, startedAt: '2026-11-14T06:45:37.952Z', finishedAt: '2026-11-14T06:45:38.669Z' },
  after: { Id: 'owned', Config: { Labels: { 'cotal.upgrade.cell': 'cell' } }, State: { Running: false, Pid: 0, ExitCode: 0, OOMKilled: false, StartedAt: '2026-11-14T06:44:51Z', FinishedAt: '2026-11-14T06:45:38.667841852Z' } },
  noProcesses: true,
});
test('PID1 shutdown exec137 requires observed clean same-incarnation end during command', () => {
  assert.equal(foreignStackEnded(fixture()), true);
  const zero = fixture(); zero.stop.exit = 0; assert.equal(foreignStackEnded(zero), true);
});
test('other failures and uncertain cleanup never inherit the PID1 allowance', () => {
  for (const mutate of [f => { f.stop.exit = 1; }, f => { f.stop.exit = 143; }, f => { f.stop.timeout = true; }, f => { f.stop.signal = 'SIGTERM'; }, f => { f.before.pid1Supervise = false; }, f => { f.noProcesses = false; }, f => { f.after.State.Running = true; }, f => { f.after.State.Pid = 42; }, f => { f.after.State.ExitCode = 137; }, f => { f.after.State.OOMKilled = true; }, f => { f.after.State.FinishedAt = '2026-11-14T06:45:40Z'; }, f => { f.after.State.FinishedAt = 'unknown'; }]) {
    const f = fixture(); mutate(f); assert.equal(foreignStackEnded(f), false);
  }
  for (const mutate of [f => { f.after.Id = 'foreign'; }, f => { f.after.Config.Labels['cotal.upgrade.cell'] = 'foreign'; }, f => { f.after.State.StartedAt = '2026-11-14T06:45:00Z'; }]) {
    const f = fixture(); mutate(f); assert.throws(() => foreignStackEnded(f));
  }
});
