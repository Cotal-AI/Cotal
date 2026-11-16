import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { boundedCells, jobsMatrix } from './upgrade-matrix-plan.mjs';
import { selectMacosMeasurement } from './macos-release-measurement.mjs';

const plan = { status: 'planned', phase: 'candidate', profile: 'bounded', sourceSHA: 'c28a56c2fbfc25171fd5ed615cd3cad1e8ab7666', sourceVersion: '0.164.18', targetVersion: '0.165.0' };
const options = { selector: 'macos-release', eventName: 'workflow_dispatch', ref: 'refs/heads/measure/macos-scheduler-receipt', plan };
const cells = boundedCells(plan);

test('measurement freezes only the two original macOS coordinates without changing them', () => {
  const selected = selectMacosMeasurement(cells, options);
  assert.deepEqual(selected.map(cell => cell.id), ['darwin-installer-daemon-scheduler', 'darwin-npm-candidate-next-second-self']);
  assert(selected.every(cell => cells.includes(cell)));
  assert.equal(jobsMatrix(selected).include.length, 2);
  assert.equal(selected[0].sourceVersion, '0.164.18');
  assert.equal(selected[0].targetVersion, '0.165.0');
  assert.equal(selected[1].sourceVersion, '0.165.0');
  assert.equal(selected[1].targetVersion, '0.165.1000');
  assert.equal(selected[1].finalTargetVersion, '0.165.2000');
});

test('default release census is unchanged and measurement refuses other routes or inputs', () => {
  assert.equal(selectMacosMeasurement(cells, { ...options, selector: undefined }), cells);
  assert.equal(selectMacosMeasurement(cells, { ...options, selector: '' }), cells);
  for (const changed of [{ selector: 'other' }, { eventName: 'pull_request' }, { ref: 'refs/heads/main' }, { ref: 'refs/heads/measure/other' }]) {
    assert.throws(() => selectMacosMeasurement(cells, { ...options, ...changed }));
  }
  for (const changed of [{ phase: 'published' }, { profile: 'extended' }, { sourceSHA: 'a'.repeat(40) }, { sourceVersion: '0.164.17' }, { targetVersion: '0.165.1' }]) {
    assert.throws(() => selectMacosMeasurement(cells, { ...options, plan: { ...plan, ...changed } }));
  }
  const selected = selectMacosMeasurement(cells, options);
  assert.throws(() => selectMacosMeasurement(cells.filter(cell => cell.id !== selected[0].id), options));
  assert.throws(() => selectMacosMeasurement([...cells, selected[0]], options));
});

test('workflow freezes selected cells and retains the selected-census summary', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  assert(workflow.includes("options: ['', macos-release]"));
  assert(workflow.includes('selectMacosMeasurement(boundedCells(plan), { selector: event.inputs?.measurement, eventName: context.eventName, ref: context.ref, plan })'));
  assert(workflow.includes('verifyResults(plan.cells, actual, { knownRefusals })'));
});
