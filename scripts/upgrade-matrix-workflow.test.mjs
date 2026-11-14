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
test('ordinary landing push cannot admit the legacy priority cascade', () => {
  const condition = workflow.jobs.priority.if;
  const evaluate = message => Function('github', 'contains', `return (${condition});`)(
    { event_name: 'push', event: { head_commit: { message } } }, (text, part) => text.includes(part));
  assert.equal(evaluate('test: qualify version heads and published upgrades continuously'), false);
  assert.equal(evaluate('test: explicit diagnostic [matrix-diagnostics]'), true);
  assert.equal(evaluate('test: corrected native [windows-job-only]'), false);
  assert.equal(workflow.jobs['desktop-beside-cli'].needs, 'priority');
  assert(workflow.jobs['desktop-beside-cli'].if.includes("needs.priority.result == 'success' || needs.priority.result == 'failure'"));
});
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
test('actual publication selector reports a missing receipt without starting the published phase', async () => {
  const script = workflow.jobs.select.steps.find(s => s.id === 'plan').with.script;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const artifacts of [[], [{ name: 'upgrade-publication', expired: true }]]) {
    const outputs = {}, saved = {}, messages = [];
    const repository = { full_name: 'Cotal-AI/Cotal' };
    const run = { id: 42, name: 'Changesets', status: 'completed', head_branch: 'main', head_sha: 'a'.repeat(40), head_repository: repository, path: '.github/workflows/changesets.yml' };
    const jobsAPI = () => {}, artifactsAPI = () => {};
    const fakeRequire = name => {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:url') return { pathToFileURL: value => new URL(`file://${value}`) };
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(path, bytes) { saved[path] = JSON.parse(bytes); } };
      assert.equal(name, 'node:child_process');
      return { execFileSync() { assert.fail('missing receipt must not download or inspect a publication'); } };
    };
    const summary = { addHeading() { return this; }, addRaw(message) { messages.push(message); return this; }, async write() {} };
    await new AsyncFunction('require', 'context', 'github', 'process', 'core', script)(fakeRequire,
      { eventName: 'workflow_run', repo: { owner: 'Cotal-AI', repo: 'Cotal' }, payload: { action: 'completed', repository, workflow_run: run } },
      { rest: { actions: { getWorkflowRun: async () => ({ data: run }), listJobsForWorkflowRun: jobsAPI, listWorkflowRunArtifacts: artifactsAPI } }, paginate: async method => method === jobsAPI ? [{ name: 'publish', conclusion: 'success' }] : (assert.equal(method, artifactsAPI), artifacts) },
      { env: { GITHUB_WORKSPACE: new URL('..', import.meta.url).pathname.replace(/\/$/, ''), RUNNER_TEMP: '/fixture' } },
      { setOutput(key, value) { outputs[key] = value; }, summary });
    assert.equal(outputs.applicable, 'false');
    assert.equal(outputs.matrix, '{"include":[]}');
    assert.equal(saved['/fixture/upgrade-plan/plan.json'].status, 'skipped');
    assert(messages.some(message => message.includes('publication not confirmed by validated API evidence')));
  }
});
test('publication receipt is isolated from the strict publisher and all downstream jobs', () => {
  const publisher = parse(readFileSync(new URL('../.github/workflows/changesets.yml', import.meta.url), 'utf8'));
  const publish = publisher.jobs.publish;
  const job = publisher.jobs['upgrade-publication'];
  assert(publish.steps.some(s => s.name === 'Promote verified packages to latest'));
  assert.equal(publish['continue-on-error'], undefined);
  assert(publish.steps.every(s => s['continue-on-error'] !== true));
  assert(!publish.steps.some(s => s.name === 'Record the published upgrade target' || s.with?.name === 'upgrade-publication'));
  assert.equal(job.needs, 'publish');
  assert.equal(job.if, "needs.publish.outputs.published == 'true'");
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.environment, undefined);
  assert.equal(job.concurrency, undefined);
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const receipt = job.steps.findIndex(s => s.name === 'Record the published upgrade target');
  const upload = job.steps.findIndex(s => s.with?.name === 'upgrade-publication');
  assert(receipt >= 0 && upload > receipt);
  assert(job.steps[receipt].run.includes('sourceSHA: process.env.GITHUB_SHA'));
  assert(job.steps[receipt].run.includes('published: true, promoted: true'));
  assert.equal(job.steps[upload].with['if-no-files-found'], 'error');
  for (const downstream of Object.values(publisher.jobs)) {
    const needs = Array.isArray(downstream.needs) ? downstream.needs : [downstream.needs];
    assert(!needs.includes('upgrade-publication'), 'no job may wait for the optional receipt');
  }
  assert.equal(publisher.jobs['verify-install'].needs, 'publish');
  assert.equal(publisher.jobs['verify-install'].if, "needs.publish.outputs.published == 'true'");
});
