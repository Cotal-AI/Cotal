import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parse } from 'yaml';
import { planRelease } from './upgrade-matrix-plan.mjs';
import { knownRefusals } from './upgrade-matrix-refusals.mjs';
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
function fixture(change = () => {}, { scenario = 'configured', sourceVersion = '0.164.6', targetVersion = '0.164.7', phase = 'candidate', corrupt = false } = {}) {
  const root = mkdtempSync('/var/tmp/upgrade-matrix/census-guard-');
  const base = planRelease({ inputs: { phase: 'candidate', source_sha: 'a'.repeat(40), target_version: targetVersion, profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion });
  base.phase = phase;
  for (const cell of base.cells) cell.phase = phase;
  const cell = base.cells.find(c => c.id === `linux-npm-${scenario}`);
  const plan = { ...base, cells: [cell] };
  const directory = join(root, 'upgrade-results', `upgrade-cell-${cell.id}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'upgrade-plan'), { mode: 0o700 });
  const names = ['CLI version is target', 'selected CLI reports target', 'every recorded extension is at target', 'recorded extension package versions match target', 'every prior extension remains recorded', 'cotal status exits zero', 'no paused recovery record', 'no manual step or refusal'];
  const harnessSource = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const harnessSha256 = digest(execFileSync('git', ['show', harnessSource + ':scripts/automatic-update-platform-baseline.mjs'], { cwd: new URL('..', import.meta.url) }));
  const data = { cell: structuredClone(cell), origin: { source: plan.sourceSHA, artifact: '42', digest: 'sha256:fixed' }, report: { id: 'candidate-B-linux-0.164.6-npm-configured-self', tier: 'candidate-B (synthetic registry, real native processes)', platform: 'linux', source: sourceVersion, sourceRequested: sourceVersion, harnessSource, harnessSha256, cleanupSafety: { passed: true }, target: plan.targetVersion, layout: 'npm', state: 'configured', method: 'self', result: 'passed', environment: { hostedDisposable: true, registryOverridden: true }, candidate: { source: plan.sourceSHA, direction: 'B' }, extensionsBefore: Array.from({ length: 8 }, (_, i) => ({ pkg: `extension-${i}` })), assertions: names.map(name => ({ name, passed: true })), calls: [] } };
  change(data, directory);
  writeFileSync(join(root, 'upgrade-plan/plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'coordinate.json'), JSON.stringify(data.cell));
  writeFileSync(join(directory, 'candidate-origin.json'), JSON.stringify(data.origin));
  writeFileSync(join(directory, data.report.id + '.json'), JSON.stringify(data.report));
  writeFileSync(join(directory, data.report.id + '.log'), 'recorded transcript\n');
  writeFileSync(join(directory, data.report.id + '.sha256'), [data.report.id + '.json', data.report.id + '.log'].map(name => `${digest(readFileSync(join(directory, name)))}  ${name}\n`).join(''));
  if (corrupt) writeFileSync(join(directory, data.report.id + '.log'), 'tampered transcript\n');
  writeFileSync(join(root, 'summary.mjs'), program
    .replace("'./scripts/upgrade-matrix-plan.mjs'", JSON.stringify(new URL('./upgrade-matrix-plan.mjs', import.meta.url).href))
    .replace("'./scripts/upgrade-matrix-refusals.mjs'", JSON.stringify(new URL('./upgrade-matrix-refusals.mjs', import.meta.url).href))
    .replace("'./scripts/daemon-manual-acceptance.mjs'", JSON.stringify(new URL('./daemon-manual-acceptance.mjs', import.meta.url).href)));
  const env = { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary.md'), EXPECTED_CANDIDATE_ARTIFACT: '42', EXPECTED_CANDIDATE_DIGEST: 'sha256:fixed', EXPECTED_HARNESS_SOURCE: harnessSource };
  try { execFileSync(process.execPath, [join(root, 'summary.mjs')], { env, stdio: 'pipe', cwd: new URL('..', import.meta.url) }); return { exit: 0, root }; }
  catch (error) { return { exit: error.status, stderr: error.stderr.toString(), root }; }
}
function manualServiceEvidence(data, directory) {
  const capturedAt = '2026-11-14T11:00:00.000Z';
  const observations = [{ kind: 'roots', state: 'observed' }];
  const archive = (kind, value, state = 'archived') => {
    const bytes = Buffer.from(JSON.stringify(value));
    const artifact = `manual-${kind}.txt`;
    writeFileSync(join(directory, artifact), bytes, { mode: 0o600 });
    observations.push({ kind, state, artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(kind === 'daemon-status' || kind === 'systemctl-show' ? { exit: 0 } : {}), ...(kind === 'installed-version' ? { version: data.cell.targetVersion } : {}) });
  };
  archive('daemon-status', { startedAt: capturedAt, finishedAt: capturedAt, exit: 0, timedOut: false, truncated: false, signal: null, stdout: JSON.stringify({ result: { state: 'ready', version: data.cell.targetVersion, pid: 1234 } }) }, 'observed');
  archive('systemctl-show', { exit: 0, timedOut: false, truncated: false, signal: null, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=1234\n' }, 'observed');
  archive('installed-version', { name: 'cotal-ai', version: data.cell.targetVersion });
  archive('daemon.lock', { record: { pid: 1234, socket: { dev: 1, ino: 2 } }, ownerProcess: { state: 'observed', startMatches: true, processState: 'S' } });
  archive('socket', { dev: 1, ino: 2, mtimeMs: Date.parse(capturedAt) });
  for (const kind of ['update-recovery.json', 'update-recovery-observed.json', '.extensions.lock', '.extensions.lock.update', '.extensions.lock.npm-child', '.cotal-update.lock', '.cotal-update-child']) observations.push({ kind, state: 'missing' });
  Object.assign(data.report, { state: 'daemon', daemonDiagnostics: { 'after-update': { stage: 'after-update', capturedAt, observations } } });
  data.report.environment.nativeServiceRequested = true;
  data.report.calls = [{ label: 'native install', exit: 0 }, { label: 'upgrade under test', exit: 0, argv: ['update', '--self'] }];
  data.report.assertions.push({ name: 'manual native service starts at source with scheduler disabled', passed: true }, { name: 'independent manual service final state', passed: true });
}
test('actual summary regrades manual native final state in both phases', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture((data, directory) => {
      manualServiceEvidence(data, directory);
      if (phase === 'published') { data.report.tier = 'published'; data.report.environment.registryOverridden = false; delete data.report.candidate; }
    }, { scenario: 'daemon-self', phase });
    assert.equal(result.exit, 0, result.stderr);
  }
});
test('manual service success text and booleans cannot waive missing, paused or tampered final state', () => {
  for (const mutate of [
    data => { delete data.report.daemonDiagnostics; },
    data => { data.report.daemonDiagnostics['after-update'].observations.find(row => row.kind === 'update-recovery.json').state = 'archived'; },
    data => { data.report.daemonDiagnostics['after-update'].observations.find(row => row.kind === 'daemon-status').sha256 = '0'.repeat(64); },
    data => { data.report.calls = data.report.calls.filter(call => call.label !== 'native install'); },
    data => { data.report.daemonDiagnostics['after-update'].observations.find(row => row.kind === 'systemctl-show').state = 'failed'; },
    data => { data.report.daemonDiagnostics['after-update'].observations.find(row => row.kind === 'socket').state = 'missing'; },
  ]) {
    const result = fixture((data, directory) => { manualServiceEvidence(data, directory); mutate(data); }, { scenario: 'daemon-self' });
    assert.notEqual(result.exit, 0, 'independent final state must fail closed');
  }
});
test('manual service route is daemon state, self method, native Linux preparation and no scheduler proof', () => {
  const run = workflow.jobs['release-cells'].steps.find(step => step.name === 'Run one real product upgrade coordinate').run;
  assert(run.includes("'daemon-self': 'daemon'"));
  assert(workflow.jobs['release-cells'].steps.find(step => step.name === 'Prepare disposable Linux user manager').if.includes("matrix.scenario == 'daemon-self'"));
  assert(run.includes("cell.platform === 'darwin' && method === 'scheduler'"));
  assert(program.includes('evaluateManualDaemonState({ diagnostics: report.daemonDiagnostics'));
});
test('actual workflow census accepts precisely matching configured evidence', () => assert.equal(fixture().exit, 0));
test('actual workflow census refuses fresh report relabelled configured', () => assert.notEqual(fixture(d => { d.report.state = 'fresh'; d.report.extensionsBefore = []; }).exit, 0));
test('actual workflow census refuses wrong immutable artifact identity', () => assert.notEqual(fixture(d => { d.origin.artifact = 'foreign'; }).exit, 0));
test('actual workflow census refuses changed coordinate metadata', () => assert.notEqual(fixture(d => { d.cell.scenario = 'fresh'; }).exit, 0));
test('actual census binds rolling source and rejects raw source, harness or digest skew', () => {
  assert.equal(fixture(() => {}, { sourceVersion: '0.164.7', targetVersion: '0.164.8' }).exit, 0);
  for (const change of [d => { d.report.source = '0.164.6'; }, d => { d.report.sourceRequested = 'latest'; }, d => { d.report.candidate.source = 'b'.repeat(40); }, d => { d.report.harnessSha256 = '0'.repeat(64); }, d => { delete d.report.cleanupSafety; }]) assert.notEqual(fixture(change, { sourceVersion: '0.164.7', targetVersion: '0.164.8' }).exit, 0);
  assert.notEqual(fixture(() => {}, { corrupt: true }).exit, 0);
});
function standaloneEvidence(data) {
  const entry = knownRefusals.find(entry => entry.id === 'linux-npm-standalone-stop-consent');
  const stdout = entry.stdout.replaceAll('{{space}}', 'upgrade-proof').replaceAll('{{manager}}', 'sdz0a0f5fxj1ct3pzd181eaqvdozem1').replaceAll('{{pid}}', '2699');
  const update = { exit: entry.exit, signal: null, timeout: false, stdout, stderr: entry.stderr };
  Object.assign(data.report, { result: 'failed', state: 'agent', agentHost: 'standalone', managerHost: { mode: 'standalone', space: 'upgrade-proof' }, update });
  data.report.extensionsBefore = Array.from({ length: 8 }, (_, i) => ({ pkg: `@cotal-ai/extension-${i}`, version: data.cell.sourceVersion }));
  data.report.extensionsAfter = structuredClone(data.report.extensionsBefore);
  data.report.assertions = [...entry.failedAssertions.map(name => ({ name, passed: false, observed: name === 'upgrade exits successfully' ? update : name === 'CLI version is target' ? data.cell.sourceVersion : undefined })), ...entry.requiredAssertions.map(name => ({ name, passed: true }))];
}
test('actual summary accepts only exact safe listed red and keeps full upgrade acceptance false', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(data => {
      standaloneEvidence(data);
      if (phase === 'published') { data.report.tier = 'published'; data.report.environment.registryOverridden = false; delete data.report.candidate; }
    }, { scenario: 'standalone-stop-consent', phase });
    assert.equal(result.exit, 0, result.stderr);
    const census = JSON.parse(readFileSync(join(result.root, 'upgrade-results/census.json')));
    assert.equal(census.acceptance, true);
    assert.equal(census.upgradeAcceptance, false);
    assert.equal(census.passed.length, 0);
    assert.equal(census.knownRefusals[0].issue, 'https://github.com/Cotal-AI/Cotal/issues/6802');
  }
});
test('actual summary refuses listed green, changed refusal, extra failure and missing cleanup', () => {
  for (const mutate of [d => { d.report.result = 'passed'; }, d => { d.report.update.stdout += 'changed\n'; }, d => { d.report.assertions.push({ name: 'extra failure', passed: false }); }, d => { d.report.cleanupSafety.passed = false; }, d => { d.report.candidate.source = 'b'.repeat(40); }]) {
    const result = fixture(d => { standaloneEvidence(d); mutate(d); }, { scenario: 'standalone-stop-consent' });
    assert.notEqual(result.exit, 0);
  }
  const unknown = fixture(d => { d.report.result = 'failed'; });
  assert.notEqual(unknown.exit, 0);
});
test('daemon consent summary uses daemon cleanup proof and cannot inherit standalone refusal', () => {
  const result = fixture(d => {
    d.report.state = 'agent'; d.report.agentHost = 'daemon';
    d.report.cleanup = 'receipt-guarded native removal confirmed';
    d.report.calls = [{ argv: ['update', '--self', '--stop-agents'], exit: 0 }];
    d.report.assertions.push({ name: 'owned daemon-hosted Manager stop succeeds', passed: true });
  }, { scenario: 'agent-stop-consent' });
  assert.equal(result.exit, 0, result.stderr);
});
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
      if (name === 'node:crypto') return { createHash };
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
      { setOutput(key, value) { outputs[key] = value; }, summary, info() {} });
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
