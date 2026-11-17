import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planRelease, verifyResults } from './upgrade-matrix-plan.mjs';
import { verifyTwoHomeUpgrade } from './automatic-update-two-homes-evidence.mjs';

test('two-home POSIX coordinates are required in both release phases and cannot disappear from census', () => {
  for (const phase of ['candidate', 'published']) {
    const plan = planRelease({ eventName: 'workflow_dispatch', inputs: { phase, sourceSHA: 'a'.repeat(40), targetVersion: '0.165.4' } }, { sourceVersion: '0.165.3' });
    const homes = plan.cells.filter(cell => cell.scenario === 'candidate-next-two-homes');
    assert.deepEqual(homes.map(cell => cell.platform), ['linux', 'darwin']);
    assert(homes.every(cell => cell.required && cell.sourceVersion === '0.165.4' && cell.targetVersion === '0.165.1004'));
    for (const cell of homes) for (const name of ['two-home-up', 'two-home-launch', 'old-manager-preserved', 'home-only-remedy', 'owned-stack-cleanup']) assert(cell.requiredAssertions.includes(name));
    const results = plan.cells.filter(cell => cell.required).map(cell => ({ id: cell.id, status: 'passed', assertions: Object.fromEntries(cell.requiredAssertions.map(name => [name, true])) }));
    assert(verifyResults(plan.cells, results).acceptance);
    assert(!verifyResults(plan.cells, results.filter(cell => cell.id !== homes[0].id)).acceptance);
    delete results.find(cell => cell.id === homes[0].id).assertions['old-manager-preserved'];
    assert(!verifyResults(plan.cells, results).acceptance);
  }
});

test('workflow downloads paired artifacts, runs actual callable and strict summary grader', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  assert(workflow.includes("matrix.scenario == 'candidate-next-two-homes'"));
  assert(workflow.includes("const { twoHomeUpgrade } = await import('./scripts/automatic-update-two-homes.mjs')"));
  assert(workflow.includes("const verdict = verifyTwoHomeUpgrade(report)"));
  assert(workflow.includes("report.old.manifestSha256, nextOrigin.sourceManifestSha256"));
  assert(workflow.includes("report.target.manifestSha256, nextOrigin.targetManifestSha256"));
  assert(workflow.includes("report.harnessFiles[name]"));
});

test('incomplete or success-only two-home evidence never grades acceptance', () => {
  for (const value of [undefined, {}, { acceptance: true, cleanup: 'both owned stacks stopped', checks: [] }]) assert.throws(() => verifyTwoHomeUpgrade(value));
});
