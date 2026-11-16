import assert from 'node:assert/strict';

export function selectMacosMeasurement(cells, { selector, eventName, ref, plan }) {
  if (!selector) return cells;
  assert.equal(selector, 'macos-release', 'unknown measurement selector');
  assert.equal(eventName, 'workflow_dispatch', 'measurement requires manual dispatch');
  assert.equal(ref, 'refs/heads/measure/macos-scheduler-receipt', 'measurement requires its dedicated ref');
  assert.equal(plan.phase, 'candidate');
  assert.equal(plan.profile, 'bounded');
  assert.equal(plan.sourceSHA, 'c28a56c2fbfc25171fd5ed615cd3cad1e8ab7666', 'measurement product source changed');
  assert.equal(plan.sourceVersion, '0.164.18');
  assert.equal(plan.targetVersion, '0.165.0');
  const ids = ['darwin-installer-daemon-scheduler', 'darwin-npm-candidate-next-second-self'];
  const selected = ids.map(id => {
    const matches = cells.filter(cell => cell.id === id);
    assert.equal(matches.length, 1, `measurement coordinate missing or duplicated: ${id}`);
    const [cell] = matches;
    assert.equal(cell.platform, 'darwin');
    assert.equal(cell.runner, 'macos-15');
    assert.equal(cell.required, true);
    assert.equal(cell.sourceSHA, plan.sourceSHA);
    return cell;
  });
  return selected;
}
