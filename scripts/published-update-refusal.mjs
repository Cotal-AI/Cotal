import assert from 'node:assert/strict';

/** Old updater version-check refusal is a safe escape notice, not a successful upgrade. */
export function publishedStagedRefusal(update) {
  return update?.exit === 1 && update.signal === null && update.timeout === false
    && /Install the new version once by hand/.test((update.stdout ?? '') + (update.stderr ?? ''));
}

/** Regrade recorded outcomes without turning a pre-replacement deferral into a failure. */
export function publishedSchedulerBudget(observations, { fixedSource = false } = {}) {
  assert.equal(observations.length, 3, 'three independent observations required');
  for (const [index, row] of observations.entries()) {
    const { before, attempt, stimulusAt, observedAt } = row;
    assert(Number.isInteger(before?.failures) && before.failures >= 0, 'prior failure budget missing');
    assert(Number.isFinite(observedAt) && observedAt >= stimulusAt, 'observation time missing');
    assert(attempt.next > stimulusAt, 'scheduler attempt did not settle');
    if (index > 0) assert.equal(before.failures, observations[index - 1].attempt.failures, 'failure budget was changed between observations');
    let delay;
    if (before.failures >= 2) {
      assert.equal(attempt.failures, before.failures, 'waiting changed failure budget');
      assert.match(attempt.result, /failed twice; waiting/);
      assert.equal(row.logSha256, row.beforeLogSha256, 'waiting launched or rewrote updater log');
      delay = 86400000;
    } else {
      assert.match(row.text, /Install the new version once by hand/);
      assert(row.logMtimeMs >= stimulusAt, 'refusal log was not written by this attempt');
      if (typeof attempt.deferred === 'string') {
        assert.equal(attempt.result, attempt.deferred, 'deferral result disagrees with its reason');
        assert.equal(attempt.failures, before.failures, 'deferral changed failure budget');
        delay = /registry or extension closure availability/.test(attempt.deferred) ? 3600000 : 60000;
      } else {
        assert.equal(attempt.failures, before.failures + 1, 'failure must increment budget once');
        delay = 3600000;
      }
    }
    assert(attempt.next >= stimulusAt + delay && attempt.next <= observedAt + delay, 'outcome next-attempt time disagrees with recorded type');
    assert(['complete', 'missing'].includes(row.store?.state), 'store census did not complete');
    assert(Number.isSafeInteger(row.store.logicalBytes), 'store byte census missing');
    if (fixedSource) {
      assert.equal(row.store.passed, true, 'fixed source left unsafe staging');
      assert.equal(row.store.logicalBytes, row.beforeStore.logicalBytes, 'fixed refusal grew generation store');
    }
  }
  return true;
}
