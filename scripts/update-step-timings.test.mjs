import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateStepTimings } from './update-step-timings.mjs';
test('extract ordered human-style step completions without inventing old timings', () => {
  assert.deepEqual(updateStepTimings('old update output'), []);
  assert.deepEqual(updateStepTimings('noise\n✓ global package install finished (12.3 s)\r\n\x1b[32m✓ built-in claude reconciled (0.0 s)\x1b[0m\n✓ extension @cotal-ai/tmux install finished (4.5 s)\n✓ integration codex refreshed (0.1 s)\n'), [
    { step: 'global-install', elapsedMs: 12300 }, { step: 'connector:claude', elapsedMs: 0 }, { step: 'extension:@cotal-ai/tmux', elapsedMs: 4500 }, { step: 'integration:codex', elapsedMs: 100 },
  ]);
  assert.deepEqual(updateStepTimings('not ✓ release archives checked (4.2 s)\n✓ unrelated (1.0 s)\n✓ release archives checked (-1.0 s)'), []);
  assert.throws(() => updateStepTimings('✓ release archives checked (9007199254740992.0 s)'), /safe integer/);
});
