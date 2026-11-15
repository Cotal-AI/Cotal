import assert from 'node:assert/strict';

/** Old updater version-check refusal is a safe escape notice, not a successful upgrade. */
export function publishedStagedRefusal(update) {
  return update?.exit === 1 && update.signal === null && update.timeout === false
    && /Install the new version once by hand/.test((update.stdout ?? '') + (update.stderr ?? ''));
}

/** Observe two real failures and the unchanged scheduler's third-budget decision. */
export function publishedSchedulerBudget(observations) {
  assert.equal(observations.length, 3, 'three independent observations required');
  const [first, second, third] = observations;
  for (const row of [first, second]) {
    assert(row.attempt.next > row.stimulusAt, 'scheduler attempt did not settle');
    assert.match(row.text, /Install the new version once by hand/);
    assert.equal(row.store.passed, true, 'refusal left unsafe staging');
  }
  assert(second.attempt.failures >= 2, 'unchanged scheduler must count two failures');
  assert.equal(third.attempt.failures, second.attempt.failures, 'third observation changed failure budget');
  assert.match(third.attempt.result, /failed twice; waiting/);
  assert.equal(third.store.passed, true);
  assert.equal(third.logSha256, second.logSha256, 'third observation launched or rewrote updater log');
  return true;
}
