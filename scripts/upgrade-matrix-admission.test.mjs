import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { planPhase, boundedCells, targetAdmissionCells, verifyResults } from './upgrade-matrix-plan.mjs';

const sourceSHA = 'a'.repeat(40);
const plan = planPhase({ inputs: { phase: 'candidate', source_sha: sourceSHA, target_version: '0.164.18', profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion: '0.164.17' });
const suffixes = ['foreign-preserving', 'offline', 'manager-unknown', 'consent-stop', 'consent-declined'];

test('legacy pack is measurement-only, source-bound and guarded without blocking ordinary releases', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['admission-legacy-pack'];
  assert(job, 'foreign-preserving cells require a real legacy pack job');
  assert.deepEqual(job.needs, ['select', 'release-native']);
  assert(job.if.includes("github.event_name == 'workflow_dispatch'"));
  assert(job.if.includes("github.ref == 'refs/heads/measure/update-target-owned-admission'"));
  assert(job.steps.some(step => step.with?.path === 'legacy' && step.with.ref === '${{ env.ADMISSION_LEGACY_SOURCE }}' && step.with['fetch-depth'] === 0));
  assert.equal(job.steps.filter(step => step.run === 'pnpm install --frozen-lockfile --child-concurrency=2').length, 2);
  const guard = job.steps.find(step => step.name === 'Assemble and guard the complete source-matched native closure');
  assert.equal(guard['working-directory'], 'legacy');
  assert.equal(guard.env.NATIVE_SOURCE, '${{ needs.select.outputs.source }}');
  assert.equal(Object.keys(guard.env).filter(key => key.startsWith('SEAT_NATIVE_')).length, 6);
  assert.equal(Object.keys(guard.env).filter(key => key.startsWith('WORKSPACE_NATIVE_')).length, 4);
  for (const script of ['scripts/seat-assemble-natives.mjs', 'scripts/workspace-assemble-natives.mjs', 'packages/seat/scripts/assert-shipped-natives.mjs', 'packages/workspace/scripts/assert-shipped-natives.mjs']) assert(guard.run.includes(script));
  const run = job.steps.map(step => step.run ?? '').join('\n');
  for (const token of ['merge-base', '--is-ancestor', 'legacySourceSHA', 'productSourceSHA', 'ancestorOfProduct', "--filter 'cotal-ai...'", '--workspace-concurrency 3', 'scripts/pack-candidate-next.mjs', 'scripts/automatic-update-platform-baseline.mjs', 'bin/package.json']) assert(run.includes(token), token);
  assert(!run.includes('target-admission-disposition'));
  assert(run.includes('assertNativeInputsMatch(process.env.PRODUCT_SHA, process.env.ADMISSION_LEGACY_SOURCE'));
  assert(run.includes("build ? ['--filter', 'cotal-ai...', ...args] : args"));
  const steps = workflow.jobs['release-cells'].steps;
  const fixtureBuild = steps.findIndex(step => step.name === 'Build only the signed-in participant fixture dependencies');
  const fixtureTypes = steps.findIndex(step => step.run === 'pnpm exec tsc --noEmit -p tsconfig.admission-smoke.json');
  assert(fixtureTypes > fixtureBuild);
  assert.equal(steps[fixtureTypes].if, 'matrix.targetAdmission != null');
  for (const name of ['admission-legacy-candidate', 'admission-legacy-next']) assert(job.steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with.name === name));
  const condition = workflow.jobs['release-cells'].if;
  const evaluate = (measurement, result) => Function('always', 'needs', 'github', `return (${condition.replaceAll(/needs\.([a-z]+(?:-[a-z]+)+)/g, "needs['$1']")});`)(() => true, { select: { result: 'success', outputs: { applicable: 'true' } }, 'release-pack': { result: 'success' }, 'release-next': { result: 'success' }, 'admission-legacy-pack': { result } }, { event_name: measurement ? 'workflow_dispatch' : 'workflow_run', ref: measurement ? 'refs/heads/measure/update-target-owned-admission' : 'refs/heads/main' });
  assert.equal(evaluate(false, 'skipped'), true);
  assert.equal(evaluate(true, 'success'), true);
  for (const result of ['skipped', 'failure', 'cancelled']) assert.equal(evaluate(true, result), false);
});

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
  for (const token of ["admissionMeasurement ? targetAdmissionCells(plan) : boundedCells(plan)", "context.ref === 'refs/heads/measure/update-target-owned-admission'", "['rev-parse', 'HEAD^']", 'fetch-depth: 2', "assert.equal(plan.phase, 'candidate'", "options['target-admission'] = cell.targetAdmission", "options.prepare = prepareTargetAdmission", "./scripts/target-admission-fixture.ts", "./scripts/target-admission-evidence.mjs", 'admissionEvidence?.passed === true', 'if (!cell.targetAdmission) pairedEvidence = verifyCandidateNextEvidence', 'nats-download.sha256', 'nats-release-SHA256SUMS', 'nats-server-v2.14.0-$platform-$arch.tar.gz', 'shasum -a 256 -c selected.sha256', 'matrix.targetAdmission != null || matrix.scenario']) assert(workflow.includes(token), token);
  for (const suffix of suffixes) assert.equal(workflow.split(`'candidate-next-target-admission-${suffix}': 'daemon'`).length - 1, 2);
  assert(workflow.includes('options: [bounded, extended]'));
  assert(workflow.includes('>= (measurement ? 0 : 1)'));
});
