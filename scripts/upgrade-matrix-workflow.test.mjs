import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { planRelease } from './upgrade-matrix-plan.mjs';
const workflow = parse(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
const summary = workflow.jobs['release-summary'].steps.find(s => s.name === 'Verify expected coordinate census and assertion contract').run;
const program = summary.split("<<'NODE'\n")[1].split('\nNODE')[0];
test('durable events preserve immutable heads without privileged PR execution or cancellation', () => {
  assert.deepEqual(workflow.on.pull_request.types, ['opened', 'synchronize', 'reopened']);
  assert.equal(workflow.on.pull_request.paths, undefined);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Changesets'], types: ['completed'] });
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  const select = workflow.jobs.select.steps.find(s => s.id === 'plan').with.script;
  for (const token of ['changeset-release/main', 'upgrade-publication', 'publication.sourceSHA', 'publication.runId', "actual.path, '.github/workflows/changesets.yml'"]) assert(select.includes(token), token);
  assert(workflow.jobs['release-native'].steps[0].with.ref.includes('needs.select.outputs.source'));
  assert(workflow.jobs['release-pack'].steps.some(s => s.with?.path === 'product' && s.with.ref.includes('needs.select.outputs.source')));
  assert(workflow.jobs['release-summary'].if.includes('always()'));
  assert.equal(workflow.jobs['release-cells'].strategy['fail-fast'], false);
});
function fixture(change = () => {}) {
  const root = mkdtempSync('/var/tmp/upgrade-matrix/census-guard-');
  const base = planRelease({ inputs: { phase: 'candidate', source_sha: 'a'.repeat(40), target_version: '0.164.7', profile: 'bounded' } }, { eventName: 'workflow_dispatch' });
  const cell = base.cells.find(c => c.id === 'linux-npm-configured');
  const plan = { ...base, cells: [cell] };
  const directory = join(root, 'upgrade-results', `upgrade-cell-${cell.id}`);
  mkdirSync(directory, { recursive: true }); mkdirSync(join(root, 'upgrade-plan'));
  const names = ['CLI version is target', 'selected CLI reports target', 'every recorded extension is at target', 'recorded extension package versions match target', 'every prior extension remains recorded', 'cotal status exits zero', 'no paused recovery record', 'no manual step or refusal'];
  const data = { cell: structuredClone(cell), origin: { source: plan.sourceSHA, artifact: '42', digest: 'sha256:fixed' }, report: { id: 'candidate-B-linux-0.164.6-npm-configured-self', tier: 'candidate-B (synthetic registry, real native processes)', platform: 'linux', source: '0.164.6', target: plan.targetVersion, layout: 'npm', state: 'configured', method: 'self', result: 'passed', environment: { hostedDisposable: true, registryOverridden: true }, candidate: { source: plan.sourceSHA, direction: 'B' }, extensionsBefore: Array.from({ length: 8 }, (_, i) => ({ pkg: `extension-${i}` })), assertions: names.map(name => ({ name, passed: true })), calls: [] } };
  change(data);
  writeFileSync(join(root, 'upgrade-plan/plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'coordinate.json'), JSON.stringify(data.cell));
  writeFileSync(join(directory, 'candidate-origin.json'), JSON.stringify(data.origin));
  writeFileSync(join(directory, 'cell.json'), JSON.stringify(data.report));
  writeFileSync(join(root, 'summary.mjs'), program.replace("'./scripts/upgrade-matrix-plan.mjs'", JSON.stringify(new URL('./upgrade-matrix-plan.mjs', import.meta.url).href)));
  const env = { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary.md'), EXPECTED_CANDIDATE_ARTIFACT: '42', EXPECTED_CANDIDATE_DIGEST: 'sha256:fixed' };
  try { execFileSync(process.execPath, [join(root, 'summary.mjs')], { env, stdio: 'pipe' }); return { exit: 0, root }; }
  catch (error) { return { exit: error.status, stderr: error.stderr.toString(), root }; }
}
test('actual workflow census accepts precisely matching configured evidence', () => assert.equal(fixture().exit, 0));
test('actual workflow census refuses fresh report relabelled configured', () => assert.notEqual(fixture(d => { d.report.state = 'fresh'; d.report.extensionsBefore = []; }).exit, 0));
test('actual workflow census refuses wrong immutable artifact identity', () => assert.notEqual(fixture(d => { d.origin.artifact = 'foreign'; }).exit, 0));
test('actual workflow census refuses changed coordinate metadata', () => assert.notEqual(fixture(d => { d.cell.scenario = 'fresh'; }).exit, 0));
test('actual workflow census refuses missing manual/recovery/status requirements', () => {
  for (const name of ['no manual step or refusal', 'no paused recovery record', 'cotal status exits zero']) assert.notEqual(fixture(d => { d.report.assertions = d.report.assertions.filter(a => a.name !== name); }).exit, 0);
});
test('publisher receipt is written after successful promotion and is independent of GitHub Release creation', () => {
  const publisher = parse(readFileSync(new URL('../.github/workflows/changesets.yml', import.meta.url), 'utf8'));
  const steps = publisher.jobs.publish.steps;
  const promotion = steps.findIndex(s => s.name === 'Promote verified packages to latest');
  const receipt = steps.findIndex(s => s.name === 'Record the published upgrade target');
  assert(receipt > promotion);
  assert.equal(steps[receipt].if, "steps.publish.outputs.published == 'true'");
  assert(steps[receipt].run.includes('sourceSHA: process.env.GITHUB_SHA'));
  assert(steps[receipt].run.includes('published: true, promoted: true'));
  assert.equal(steps.find(s => s.with?.name === 'upgrade-publication').if, "steps.publish.outputs.published == 'true'");
});
