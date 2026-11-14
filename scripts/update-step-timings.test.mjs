import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateStepTimings } from './update-step-timings.mjs';
test('extract ordered step receipts without inventing timings for older releases', () => {
  assert.deepEqual(updateStepTimings('old update output'), []);
  assert.deepEqual(updateStepTimings('noise\nUpdate step global-install completed in 123 ms\r\n\x1b[32mUpdate step connector:claude completed in 0 ms\x1b[0m\nUpdate step extension:@cotal-ai/tmux completed in 456 ms\n'), [
    { step: 'global-install', elapsedMs: 123 }, { step: 'connector:claude', elapsedMs: 0 }, { step: 'extension:@cotal-ai/tmux', elapsedMs: 456 },
  ]);
  assert.deepEqual(updateStepTimings('not Update step bad completed in 42 ms\nUpdate step bad completed in -1 ms'), []);
  assert.throws(() => updateStepTimings('Update step bad completed in 9007199254740992 ms'), /safe integer/);
});
