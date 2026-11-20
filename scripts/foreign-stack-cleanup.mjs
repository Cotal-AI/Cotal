import assert from 'node:assert/strict';

/** A docker exec can die when its own container's PID 1 exits during stack shutdown. */
export function foreignStackEnded({ stop, before, after, noProcesses, observedAt, observedUntil }) {
  assert.equal(after.Id, before.id, 'cleanup container identity changed');
  assert.equal(after.Config?.Labels?.['cotal.upgrade.cell'], before.label, 'cleanup container label changed');
  assert.equal(after.State?.StartedAt, before.startedAt, 'cleanup container incarnation changed');
  const ended = after.State.Running === false && after.State.Pid === 0 && after.State.ExitCode === 0 && after.State.OOMKilled === false && noProcesses === true;
  if (stop.exit === 0) return ended;
  if (stop.exit !== 137 || stop.timeout !== false || stop.signal !== null || before.pid1Supervise !== true) return false;
  const finished = Date.parse(after.State.FinishedAt);
  const observationStarted = Date.parse(observedAt);
  const observationFinished = Date.parse(observedUntil);
  // Docker can stamp the finish after the exec returns. The inspect that reported the finish is its upper bound.
  return ended && Number.isFinite(finished) && Number.isFinite(observationStarted) && Number.isFinite(observationFinished) &&
    observationStarted >= Date.parse(stop.finishedAt) && observationFinished >= observationStarted &&
    finished >= Date.parse(stop.startedAt) && finished <= observationFinished;
}
