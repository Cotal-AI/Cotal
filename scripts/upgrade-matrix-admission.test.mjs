import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPhase, boundedCells, targetAdmissionCells, verifyResults } from './upgrade-matrix-plan.mjs';

const sourceSHA = 'a'.repeat(40);
const plan = planPhase({ inputs: { phase: 'candidate', source_sha: sourceSHA, target_version: '0.164.18', profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion: '0.164.17' });
const suffixes = ['foreign-preserving', 'offline', 'manager-unknown', 'consent-stop', 'consent-declined'];

test('measurement selects ten unchanged controls and five new cases per POSIX platform', () => {
  const ordinary = boundedCells(plan);
  const snapshot = structuredClone(ordinary);
  const cells = targetAdmissionCells(plan);
  assert.equal(cells.length, 20);
  assert.equal(new Set(cells.map(cell => cell.id)).size, 20);
  assert.deepEqual(boundedCells(plan), snapshot);
  const controls = ordinary.filter(cell => ['candidate-next-daemon-self', 'candidate-next-stopped-daemon-self', 'candidate-next-disabled-daemon-self', 'candidate-next-second-self'].includes(cell.scenario));
  assert.equal(controls.length, 10);
  assert.deepEqual(cells.filter(cell => !cell.targetAdmission), controls);
  assert.deepEqual(Object.fromEntries(['linux', 'darwin', 'win32'].map(platform => [platform, cells.filter(cell => cell.platform === platform).length])), { linux: 9, darwin: 9, win32: 2 });
  for (const platform of ['linux', 'darwin']) for (const suffix of suffixes) {
    const cell = cells.find(cell => cell.id === `${platform}-npm-candidate-next-target-admission-${suffix}`);
    assert.equal(cell.targetAdmission, suffix);
    assert.equal(cell.sourceVersion, plan.targetVersion);
    assert.equal(cell.targetVersion, '0.164.1018');
    assert.equal(cell.sourceSHA, sourceSHA);
    assert.equal(cell.targetSourceSHA, sourceSHA);
    assert.equal(cell.sourceKind, 'packed-candidate-A');
    assert.equal(cell.targetSource, 'packed-next-B');
    assert.equal(cell.required, true);
    assert(cell.requiredAssertions.includes('target-admission-evidence'));
    assert(!cell.requiredAssertions.includes('native-service-manual'));
  }
  assert.throws(() => targetAdmissionCells({ ...plan, phase: 'published' }), /candidate-only/);
  assert.throws(() => targetAdmissionCells({ status: 'skipped' }), /candidate-only/);
});

test('measurement cannot pass with missing admission evidence or a missing coordinate', () => {
  const cells = targetAdmissionCells(plan);
  const results = cells.map(cell => ({ id: cell.id, status: 'passed', assertions: Object.fromEntries(cell.requiredAssertions.map(name => [name, true])) }));
  assert.equal(verifyResults(cells, results).acceptance, true);
  assert.equal(verifyResults(cells, results.slice(1)).acceptance, false);
  delete results.find(row => row.id.includes('target-admission')).assertions['target-admission-evidence'];
  assert.equal(verifyResults(cells, results).acceptance, false);
});

test('measurement workflow binds direct source, real artifacts, POSIX dependencies and custom grading', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  for (const token of ["const cells = targetAdmissionCells(plan)", "['rev-parse', 'HEAD^']", 'fetch-depth: 2', "assert.equal(plan.phase, 'candidate'", "options['target-admission'] = cell.targetAdmission", "options.prepare = prepareTargetAdmission", "./scripts/target-admission-fixture.ts", "./scripts/target-admission-evidence.mjs", 'admissionEvidence?.passed === true', 'if (!cell.targetAdmission) pairedEvidence = verifyCandidateNextEvidence', 'nats-download.sha256', 'nats-release-SHA256SUMS', 'nats-server-v2.14.0-$platform-$arch.tar.gz', 'shasum -a 256 -c selected.sha256', 'matrix.targetAdmission != null || matrix.scenario']) assert(workflow.includes(token), token);
  for (const suffix of suffixes) assert.equal(workflow.split(`'candidate-next-target-admission-${suffix}': 'daemon'`).length - 1, 2);
  assert(workflow.includes('options: [bounded, extended]'));
  assert(workflow.includes('>= (measurement ? 0 : 1)'));
});
