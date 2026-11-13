import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exclusion, requiresManualStep, sources, states, methods } from './automatic-update-platform-baseline.mjs';

test('funding suggestions do not require upgrade intervention', () => {
  assert.equal(requiresManualStep('61 packages are looking for funding\n  run `npm fund` for details\n✓ cotal-ai@0.164.0 installed globally and reconciled'), false);
});
test('actual upgrade remedies and unknown outcomes stay red', () => {
  for (const text of ['run `cotal update --self`', 'Outcome unconfirmed', 'Code: OPERATION_UNKNOWN', 'an interrupted update needs restoration', 'manual intervention']) assert.equal(requiresManualStep(text), true, text);
});
test('matrix includes each requested source, state and method', () => {
  assert.deepEqual(sources, ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest']);
  assert.equal(states.length, 7);
  assert.equal(methods.length, 3);
  assert(exclusion({ layout: 'npm', method: 'installer', state: 'fresh' }));
  assert(exclusion({ layout: 'npm', method: 'scheduler', state: 'fresh' }));
  assert.equal(exclusion({ layout: 'npm', method: 'scheduler', state: 'daemon' }), undefined);
});
