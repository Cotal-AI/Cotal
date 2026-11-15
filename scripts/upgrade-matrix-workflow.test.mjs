import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parse } from 'yaml';
import { planRelease } from './upgrade-matrix-plan.mjs';
import { knownRefusals } from './upgrade-matrix-refusals.mjs';
import { matchSource16410Refusal, source16410Refusals } from './source-16410-refusal.mjs';
const workflow = parse(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
const summary = workflow.jobs['release-summary'].steps.find(s => s.name === 'Verify expected coordinate census and assertion contract').run;
const program = summary.split("<<'NODE'\n")[1].split('\nNODE')[0];
test('all required release coordinates fit in the concurrency budget without waiting for macOS', () => {
  const plan = planRelease({ inputs: { phase: 'candidate', source_sha: 'a'.repeat(40), target_version: '0.164.9', profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion: '0.164.8' });
  const cells = workflow.jobs['release-cells'];
  assert.equal(plan.matrix.include.length, 40);
  assert.equal(cells.strategy['max-parallel'], plan.matrix.include.length);
  assert.deepEqual(cells.needs, ['select', 'release-pack', 'release-next']);
  assert.equal(cells.strategy['fail-fast'], false);
  assert.equal(cells['runs-on'], '${{ matrix.runner }}');
  assert(plan.matrix.include.some(cell => cell.platform === 'darwin'));
  assert(plan.matrix.include.some(cell => cell.platform === 'linux'));
  assert(plan.matrix.include.some(cell => cell.platform === 'win32'));
  assert.equal(workflow.jobs['release-native'].strategy['max-parallel'], 3);
});
test('paired next-hop builders are explicit in both phases and stamp B and C before building', () => {
  assert(!workflow.jobs['release-native'].if.includes("phase == 'candidate'"));
  assert(!workflow.jobs['release-next'].if.includes("phase == 'candidate'"));
  const pack = workflow.jobs['release-pack'];
  const ordinary = pack.steps.find(step => step.name === 'Pack exact candidate version using the guarded harness packer');
  assert.equal(ordinary.if, "needs.select.outputs.phase == 'candidate'");
  const published = pack.steps.find(step => step.name === 'Fetch exact published A package closure without rebuilding');
  assert.equal(published.if, "needs.select.outputs.phase == 'published'");
  assert.equal(published.run, 'node scripts/fetch-published-candidate.mjs --version "$TARGET_VERSION" --source "$SOURCE_SHA" --source-root "$GITHUB_WORKSPACE/product" --output "$RUNNER_TEMP/release-candidate"');
  const next = workflow.jobs['release-next'];
  assert(next.steps.some(step => step.with?.path === 'product' && step.with.ref.includes('needs.select.outputs.source')));
  assert(!next.steps.some(step => step.run?.includes('pnpm --workspace-concurrency 3 build')));
  assert(next.steps.some(step => step.run?.includes('node scripts/pack-candidate-next.mjs --source-root')));
  assert(next.steps.some(step => step.run?.includes('--offset 2000')));
  assert.equal(workflow.jobs['release-cells'].strategy['max-parallel'], 40);
  for (const job of ['release-native', 'release-pack', 'release-next']) assert(workflow.jobs[job]);
});
test('paired routes preserve ordinary published arguments and bind artifact receipts', () => {
  const cells = workflow.jobs['release-cells'];
  const run = cells.steps.find(step => step.name === 'Run one real product upgrade coordinate').run;
  assert(run.includes("'source-0.164.10-daemon-self-chain': 'daemon'"));
  assert(run.includes("'candidate-next-stopped-daemon-self': 'daemon'"));
  assert(run.includes("'candidate-next-disabled-daemon-self': 'daemon'"));
  assert(run.includes("'candidate-next-stopped-desktop-self': 'daemon'"));
  assert(run.includes("'candidate-next-second-self': 'daemon'"));
  assert(run.includes("'candidate-next-manual-npm': 'daemon'"));
  assert(run.includes("'candidate-next-installer-rerun': 'daemon'"));
  assert(run.includes("'--next-hop-source', cell.chain ? '0.164.10' : 'candidate'"));
  assert(run.includes("'--next-hop-phase', process.env.PHASE"));
  assert(run.includes("if (cell.stoppedDaemonBeforeUpdate) args.push('--stopped-daemon-before-update', 'true')"));
  assert(run.includes("if (cell.disabledDaemonBeforeUpdate) args.push('--disabled-daemon-before-update', 'true')"));
  assert(run.includes("if (cell.desktopBesideCli) args.push('--desktop-runtime'"));
  assert(run.includes("'--next-hop-final-target', cell.finalTargetVersion"));
  assert(run.includes("} else if (process.env.PHASE === 'candidate')"));
  assert(run.includes('cell.finalTargetVersion ?? cell.targetVersion'));
  const download = cells.steps.find(step => step.with?.['artifact-ids'] === '${{ needs.release-next.outputs.artifact }}');
  assert(download.if.includes('matrix.chain == true'));
  for (const name of ['candidate-next-origin.json', 'EXPECTED_NEXT_ARTIFACT', 'EXPECTED_NEXT_DIGEST', 'EXPECTED_FOLLOW_ON_ARTIFACT', 'EXPECTED_FOLLOW_ON_DIGEST', 'sourceManifestSha256', 'targetManifestSha256', 'followOnManifestSha256', 'verifyCandidateNextEvidence', "'candidate-source-identity'", "'candidate-next-target'", "'next-hop-success'", "'stopped-daemon-before-update'", "'disabled-daemon-before-update'", "'stopped-desktop-beside-cli'", "'follow-on-target'", "'follow-on-success'", "'exact-source-refusal'", "'intermediate-whole-machine'"]) assert(program.includes(name), name);
});
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
function fixture(change = () => {}, { scenario = 'configured', channel = 'npm', sourceVersion = '0.164.6', targetVersion = '0.164.7', phase = 'candidate', corrupt = false } = {}) {
  const root = mkdtempSync('/var/tmp/upgrade-matrix/census-guard-');
  const base = planRelease({ inputs: { phase: 'candidate', source_sha: 'a'.repeat(40), target_version: targetVersion, profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion });
  base.phase = phase;
  for (const cell of base.cells) cell.phase = phase;
  const cell = base.cells.find(c => c.id === `linux-${channel}-${scenario}`);
  const plan = { ...base, cells: [cell] };
  const directory = join(root, 'upgrade-results', `upgrade-cell-${cell.id}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'upgrade-plan'), { mode: 0o700 });
  const names = ['CLI version is target', 'selected CLI reports target', 'every recorded extension is at target', 'recorded extension package versions match target', 'every prior extension remains recorded', 'cotal status exits zero', 'no paused recovery record', 'no manual step or refusal'];
  const harnessSource = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const harnessSha256 = digest(execFileSync('git', ['show', harnessSource + ':scripts/automatic-update-platform-baseline.mjs'], { cwd: new URL('..', import.meta.url) }));
  const data = { cell: structuredClone(cell), origin: { source: plan.sourceSHA, artifact: '42', digest: 'sha256:fixed' }, report: { id: `candidate-B-linux-${sourceVersion}-${channel}-configured-self`, tier: 'candidate-B (synthetic registry, real native processes)', platform: 'linux', source: sourceVersion, sourceRequested: sourceVersion, harnessSource, harnessSha256, cleanupSafety: { passed: true }, target: plan.targetVersion, layout: channel, state: 'configured', method: 'self', result: 'passed', environment: { hostedDisposable: true, registryOverridden: true }, candidate: { source: plan.sourceSHA, direction: 'B' }, extensionsBefore: Array.from({ length: 8 }, (_, i) => ({ pkg: `extension-${i}` })), assertions: names.map(name => ({ name, passed: true })), calls: [] } };
  change(data, directory);
  writeFileSync(join(root, 'upgrade-plan/plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'coordinate.json'), JSON.stringify(data.cell));
  writeFileSync(join(directory, 'candidate-origin.json'), JSON.stringify(data.origin));
  if (data.nextOrigin) writeFileSync(join(directory, 'candidate-next-origin.json'), JSON.stringify(data.nextOrigin));
  writeFileSync(join(directory, data.report.id + '.json'), JSON.stringify(data.report));
  writeFileSync(join(directory, data.report.id + '.log'), 'recorded transcript\n');
  writeFileSync(join(directory, data.report.id + '.sha256'), [data.report.id + '.json', data.report.id + '.log'].map(name => `${digest(readFileSync(join(directory, name)))}  ${name}\n`).join(''));
  if (corrupt) writeFileSync(join(directory, data.report.id + '.log'), 'tampered transcript\n');
  writeFileSync(join(root, 'summary.mjs'), program
    .replace("'./scripts/upgrade-matrix-plan.mjs'", JSON.stringify(new URL('./upgrade-matrix-plan.mjs', import.meta.url).href))
    .replace("'./scripts/upgrade-matrix-refusals.mjs'", JSON.stringify(new URL('./upgrade-matrix-refusals.mjs', import.meta.url).href))
    .replace("'./scripts/candidate-next-evidence.mjs'", JSON.stringify(new URL('./candidate-next-evidence.mjs', import.meta.url).href))
    .replace("'./scripts/daemon-manual-acceptance.mjs'", JSON.stringify(new URL('./daemon-manual-acceptance.mjs', import.meta.url).href)));
  const env = { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary.md'), EXPECTED_CANDIDATE_ARTIFACT: '42', EXPECTED_CANDIDATE_DIGEST: 'sha256:fixed', EXPECTED_NEXT_ARTIFACT: '43', EXPECTED_NEXT_DIGEST: 'sha256:next', EXPECTED_FOLLOW_ON_ARTIFACT: '44', EXPECTED_FOLLOW_ON_DIGEST: 'sha256:follow', EXPECTED_HARNESS_SOURCE: harnessSource };
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
function archivePairManifests(data, directory, a, b, c) {
  const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat().sort();
  const sides = [['source', 'candidate-source-manifest.json', a], ['target', 'candidate-next-manifest.json', b], ...(c ? [['followOn', 'candidate-follow-on-manifest.json', c]] : [])];
  for (const [side, filename, version] of sides) {
    const packages = names.map((name, index) => ({ name, version, archive: `package-${index}.tgz`, sha256: 'e'.repeat(64), files: { 'package.json': 'c'.repeat(64), 'dist/cotal.js': 'd'.repeat(64) } }));
    const bytes = JSON.stringify({ source: data.cell.sourceSHA, packages });
    writeFileSync(join(directory, filename), bytes, { mode: 0o600 });
    const sha = createHash('sha256').update(bytes).digest('hex');
    data.nextOrigin[side + 'ManifestSha256'] = sha;
    data.report.candidateNext[side + 'ManifestSha256'] = sha;
    data.report.candidateNext[side + 'Packages'] = packages;
    data.report.candidateNext[side + 'Archives'] = packages.map(({ name, sha256 }) => ({ name, sha256 }));
  }
}
function freshNextEvidence(data, directory) {
  const a = data.cell.sourceVersion, b = data.cell.targetVersion;
  const sourceManifestSha256 = 'a'.repeat(64), targetManifestSha256 = 'b'.repeat(64);
  data.report.source = a;
  data.report.sourceRequested = a;
  data.report.target = b;
  data.report.candidate = { source: data.cell.sourceSHA, direction: 'A' };
  data.report.candidateNext = { source: data.cell.sourceSHA, sourceVersion: a, targetVersion: b, sourceManifestSha256, targetManifestSha256, sourcePackages: [{ name: 'cotal-ai', files: { 'package.json': 'c'.repeat(64), 'dist/cotal.js': 'd'.repeat(64) } }] };
  data.report.candidateSourceInvocation = { name: 'cotal-ai', version: a, sha256: 'd'.repeat(64), packageSha256: 'c'.repeat(64), argv: ['/owned/dist/cotal.js', 'update', '--self'] };
  data.report.nextHop = { mode: 'candidate', sourceVersion: a, firstTargetVersion: a, finalTargetVersion: b, secondHop: { update: { exit: 0, timeout: false, signal: null } } };
  data.nextOrigin = { source: data.cell.sourceSHA, artifact: '43', digest: 'sha256:next', sourceManifestSha256, targetManifestSha256 };
  data.report.candidateSourceInvocation.loadedCli = { name: '@cotal-ai/cli', version: a, packageSha256: 'c'.repeat(64), sha256: 'd'.repeat(64), member: 'dist/cotal.js' };
  archivePairManifests(data, directory, a, b);
  manualServiceEvidence(data, directory);
  Object.assign(data.report.calls.find(call => call.label === 'upgrade under test'), { argv: ['/owned/dist/cotal.js', 'update', '--self'], signal: null, timeout: false });
}
function followOnEvidence(data, directory, route = 'in-place') {
  const a = data.cell.sourceVersion, b = data.cell.targetVersion, c = data.cell.finalTargetVersion;
  freshNextEvidence(data, directory);
  data.report.target = c;
  data.report.candidateNext.followOnVersion = c;
  data.nextOrigin.followOnArtifact = '44';
  data.nextOrigin.followOnDigest = 'sha256:follow';
  archivePairManifests(data, directory, a, b, c);
  const middleDirectory = join(directory, 'middle');
  mkdirSync(middleDirectory);
  manualServiceEvidence(data, middleDirectory);
  const middle = structuredClone(data.report.daemonDiagnostics['after-update']);
  for (const row of middle.observations) if (row.artifact) {
    const name = 'middle-' + row.artifact;
    copyFileSync(join(middleDirectory, row.artifact), join(directory, name));
    row.artifact = name;
  }
  const finalCell = { ...data.cell, targetVersion: c };
  const originalCell = data.cell;
  data.cell = finalCell;
  manualServiceEvidence(data, directory);
  data.cell = originalCell;
  if (route === 'staged' && data.cell.followOnAction === 'self') {
    const obs = data.report.daemonDiagnostics['after-update'].observations.find(row => row.kind === 'installed-version');
    const stagedRecord = {
      name: 'cotal-ai',
      version: c,
      selectedCliVersion: c,
      packageManagerRecordVersion: a,
      updateRoute: 'staged',
      generationId: `gen-${c}`,
      inventorySha256: '1'.repeat(64),
      activeDescriptorSha256: '2'.repeat(64),
      stagedProgramSha256: '3'.repeat(64),
    };
    const bytes = Buffer.from(JSON.stringify(stagedRecord));
    writeFileSync(join(directory, obs.artifact), bytes, { mode: 0o600 });
    obs.bytes = bytes.length;
    obs.sha256 = createHash('sha256').update(bytes).digest('hex');
    obs.selectedCliVersion = c;
    obs.packageManagerRecordVersion = a;
    obs.updateRoute = 'staged';
  }
  data.report.daemonDiagnostics['between-hops'] = middle;
  const firstHopCall = data.report.calls.find(call => call.label === 'upgrade under test');
  Object.assign(firstHopCall, { argv: ['/owned/dist/cotal.js', 'update', '--self'], signal: null, timeout: false, startedAt: '2026-11-14T10:59:58.000Z', finishedAt: '2026-11-14T10:59:59.000Z' });
  const status = { exit: 0, stdout: JSON.stringify({ result: { state: 'ready', version: b, update: { lastResult: 'updated', restartEvidence: { prepared: false } } } }) };
  const updateCheck = { exit: 0, timeout: false, signal: null };
  const commandBytes = JSON.stringify({ status, updateCheck });
  writeFileSync(join(directory, 'between-commands.txt'), commandBytes, { mode: 0o600 });
  const commands = { artifact: 'between-commands.txt', bytes: Buffer.byteLength(commandBytes), sha256: createHash('sha256').update(commandBytes).digest('hex') };
  const followUpdate = { exit: 0, signal: null, timeout: false, stdout: '', stderr: '' };
  data.report.nextHop = {
    mode: 'candidate',
    sourceVersion: a,
    firstTargetVersion: a,
    finalTargetVersion: c,
    secondHop: { update: { exit: 0, timeout: false, signal: null } },
    intermediate: { status, updateCheck, commands },
    followOn: { action: data.cell.followOnAction, targetVersion: c, ...(data.cell.followOnAction === 'npm' ? { npmInstall: followUpdate } : {}), update: followUpdate },
  };
  if (data.cell.followOnAction === 'self') {
    data.report.calls.push({ label: 'candidate follow-on self update under test', startedAt: '2026-11-14T11:00:01.000Z', finishedAt: '2026-11-14T11:00:02.000Z', argv: ['/owned/dist/cotal.js', 'update', '--self'], ...followUpdate });
  } else if (data.cell.followOnAction === 'npm') {
    const bareVersion = { exit: 0, signal: null, timeout: false, stdout: `cotal-ai ${c}\n  Reconciliation pending: Run \`cotal update --self\` to reconcile this installation.\n`, stderr: '' };
    const reconciledVersion = { exit: 0, signal: null, timeout: false, stdout: `cotal-ai ${c}\n`, stderr: '' };
    const bareRuntimes = { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { items: [{ name: 'tmux', state: 'installed', package: '@cotal-ai/tmux', reachable: null, error: `@cotal-ai/tmux is ${b} and this cotal is ${c} - run \`cotal update --self\` to reconcile this installation` }] } }), stderr: '' };
    const reconciledRuntimes = { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { items: [{ name: 'tmux', state: 'installed', package: '@cotal-ai/tmux', reachable: true, error: null }] } }), stderr: '' };
    const bareDaemonStatus = { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { state: 'ready', version: c, pid: 1234 } }), stderr: '' };
    const bareRoute = { name: 'cotal-ai', version: c, selectedCliVersion: c, packageManagerRecordVersion: c, updateRoute: 'in-place' };
    const bareExtensions = [{ pkg: '@cotal-ai/tmux', version: b }, ...Array.from({ length: 7 }, (_, i) => ({ pkg: `@cotal-ai/ext-${i}`, version: b }))];
    const reconciledExtensions = [{ pkg: '@cotal-ai/tmux', version: c }, ...Array.from({ length: 7 }, (_, i) => ({ pkg: `@cotal-ai/ext-${i}`, version: c }))];
    const bareBytes = JSON.stringify({
      version: bareVersion,
      daemonStatus: bareDaemonStatus,
      runtimes: bareRuntimes,
      route: bareRoute,
      recovery: null,
      extensions: bareExtensions,
      installedExtensions: bareExtensions,
      launchGateRefusal: {
        command: { exit: 1, signal: null, timeout: false, stdout: '', stderr: `✗ failed to reconcile @cotal-ai/tmux@${c} - run \`cotal update --self\` to reconcile this installation\n` },
        extensions: bareExtensions,
        installedExtensions: bareExtensions,
      },
      launchGateReconcile: {
        command: { exit: 2, signal: null, timeout: false, stdout: '', stderr: '' },
        version: reconciledVersion,
        runtimes: reconciledRuntimes,
        extensions: reconciledExtensions,
        installedExtensions: reconciledExtensions,
      },
      scheduledReconcile: {
        pendingBefore: bareVersion,
        attempt: { version: c, failures: 0, result: `updated to ${c}`, next: Date.now() + 86400000 },
        version: reconciledVersion,
        runtimes: reconciledRuntimes,
        daemonStatus: bareDaemonStatus,
        extensions: reconciledExtensions,
        installedExtensions: reconciledExtensions,
      },
    });
    writeFileSync(join(directory, 'bare-manual-npm.txt'), bareBytes, { mode: 0o600 });
    data.report.nextHop.followOn.bareNpmObservation = {
      passed: true,
      commands: { artifact: 'bare-manual-npm.txt', bytes: Buffer.byteLength(bareBytes), sha256: createHash('sha256').update(bareBytes).digest('hex') },
    };
    data.report.calls.push(
      { label: 'manual npm install follow-on target', startedAt: '2026-11-14T11:00:01.000Z', finishedAt: '2026-11-14T11:00:02.000Z', argv: ['install', '-g', '--prefix', '/prefix', `cotal-ai@${c}`, '--no-audit', '--no-fund'], ...followUpdate },
      { label: 'bare manual npm CLI version observation', startedAt: '2026-11-14T11:00:02.000Z', finishedAt: '2026-11-14T11:00:02.000Z', argv: ['/owned/dist/cotal.js', '--version'], ...bareVersion },
      { label: 'bare manual npm daemon status', startedAt: '2026-11-14T11:00:02.000Z', finishedAt: '2026-11-14T11:00:02.000Z', argv: ['/owned/dist/cotal.js', 'daemon', 'status', '--json'], ...bareDaemonStatus },
      { label: 'reconcile manual npm follow-on target', startedAt: '2026-11-14T11:00:02.000Z', finishedAt: '2026-11-14T11:00:03.000Z', argv: ['/owned/dist/cotal.js', 'update', '--self'], ...followUpdate },
    );
    data.report.assertions.push({ name: 'bare manual npm install reaches target in-place and names any pending extension reconciliation', passed: true });
  } else {
    data.report.candidateInstaller = { source: data.cell.sourceSHA, sha256: '4'.repeat(64) };
    data.report.calls.push({ label: 'candidate follow-on source installer', startedAt: '2026-11-14T11:00:01.000Z', finishedAt: '2026-11-14T11:00:02.000Z', argv: ['/follow-on/installer.sh', '--version', c, '--no-setup', '--no-modify-path'], ...followUpdate });
  }
  data.report.assertions = [...new Map([
    ...data.report.assertions,
    { name: 'follow-on target matches packed artifact', passed: true },
    { name: 'follow-on action exits successfully', passed: true },
  ].map(row => [row.name, row])).values()];
}
test('actual summary accepts all three follow-on scenarios across phases and route modes', () => {
  for (const phase of ['candidate', 'published']) {
    for (const [scenario, channel] of [
      ['candidate-next-second-self', 'npm'],
      ['candidate-next-manual-npm', 'npm'],
      ['candidate-next-installer-rerun', 'installer'],
    ]) {
      const result = fixture((data, directory) => followOnEvidence(data, directory, 'in-place'), { scenario, channel, phase });
      assert.equal(result.exit, 0, result.stderr);
    }
    const stagedSecondSelf = fixture((data, directory) => followOnEvidence(data, directory, 'staged'), { scenario: 'candidate-next-second-self', channel: 'npm', phase });
    assert.equal(stagedSecondSelf.exit, 0, stagedSecondSelf.stderr);
  }
});
test('actual paired summary accepts candidate-owned B only with both receipts and independent final state', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(freshNextEvidence, { scenario: 'candidate-next-daemon-self', phase });
    assert.equal(result.exit, 0, result.stderr);
  }
});
test('paired summary rejects wrong B origin, entry hash, timeout, exit 3 and absent final capture', () => {
  for (const mutate of [
    data => { data.nextOrigin.artifact = 'foreign'; },
    data => { data.nextOrigin.targetManifestSha256 = 'f'.repeat(64); },
    data => { data.nextOrigin.targetManifestSha256 = data.report.candidateNext.targetManifestSha256 = 'f'.repeat(64); },
    data => { data.report.candidateNext.sourcePackages.find(row => row.name === 'cotal-ai').files['dist/cotal.js'] = data.report.candidateSourceInvocation.sha256 = 'f'.repeat(64); },
    data => { data.report.candidateSourceInvocation.sha256 = 'f'.repeat(64); },
    data => { data.report.nextHop.secondHop.update.timeout = true; },
    data => { data.report.nextHop.secondHop.update.exit = 3; },
    data => { delete data.report.daemonDiagnostics; },
  ]) {
    const result = fixture((data, directory) => { freshNextEvidence(data, directory); mutate(data); }, { scenario: 'candidate-next-daemon-self' });
    assert.notEqual(result.exit, 0);
  }
});
function chainEvidence(data, directory) {
  const a = data.cell.targetVersion, b = data.cell.finalTargetVersion;
  freshNextEvidence(data, directory);
  data.report.source = data.report.sourceRequested = '0.164.10';
  data.report.target = b;
  data.report.candidateNext.sourceVersion = a;
  data.report.candidateNext.targetVersion = b;
  data.report.candidateSourceInvocation.version = a;
  data.report.candidateSourceInvocation.loadedCli.version = a;
  archivePairManifests(data, directory, a, b);
  // Keep separate archived native captures for A and B, including their hashes.
  const middleDirectory = join(directory, 'middle');
  mkdirSync(middleDirectory);
  manualServiceEvidence(data, middleDirectory);
  const middle = structuredClone(data.report.daemonDiagnostics['after-update']);
  for (const row of middle.observations) if (row.artifact) {
    const name = 'middle-' + row.artifact;
    copyFileSync(join(middleDirectory, row.artifact), join(directory, name));
    row.artifact = name;
  }
  // The final capture must describe B, not the first-hop target A.
  const finalCell = { ...data.cell, targetVersion: b };
  const originalCell = data.cell;
  data.cell = finalCell;
  manualServiceEvidence(data, directory);
  data.cell = originalCell;
  data.report.daemonDiagnostics['between-hops'] = middle;
  const contract = source16410Refusals.find(row => row.platform === 'linux' && row.layout === 'npm');
  const first = { exit: 2, signal: null, timeout: false, stdout: `synthetic fixture reconciliation progress\nthis 0.164.10 process remains loaded until the verified global copy takes over\nmachine daemon: waiting up to 120s for Cotal ${a} and its hosted Managers before the continuity check\n✓ cotal-ai@${a} installed globally and reconciled\n`, stderr: contract.trailer };
  const refusal = matchSource16410Refusal({ platform: 'linux', layout: 'npm', sourceVersion: '0.164.10', targetVersion: a, update: first });
  data.report.nextHop = { mode: 'source-0.164.10', sourceVersion: '0.164.10', firstTargetVersion: a, finalTargetVersion: b, firstHop: { update: first, refusal }, intermediate: { status: { exit: 0, stdout: JSON.stringify({ result: { state: 'ready', version: a, update: { lastResult: 'updated', restartEvidence: { prepared: false } } } }) }, updateCheck: { exit: 0, timeout: false, signal: null } }, secondHop: { update: { exit: 0, timeout: false, signal: null } } };
  const commandBytes = JSON.stringify({ status: data.report.nextHop.intermediate.status, updateCheck: data.report.nextHop.intermediate.updateCheck });
  writeFileSync(join(directory, 'between-commands.txt'), commandBytes, { mode: 0o600 });
  data.report.nextHop.intermediate.commands = { artifact: 'between-commands.txt', bytes: Buffer.byteLength(commandBytes), sha256: createHash('sha256').update(commandBytes).digest('hex') };
  data.report.assertions = [...new Map(data.report.assertions.map(row => [row.name, row])).values()];
  Object.assign(data.report.calls.find(call => call.label === 'upgrade under test'), first, { finishedAt: '2026-11-14T10:59:59.000Z' });
  data.report.calls.push({ label: 'candidate second hop under test', startedAt: '2026-11-14T11:00:01.000Z', argv: ['/owned/dist/cotal.js', 'update', '--self'], exit: 0, signal: null, timeout: false });
}
function hostedChainEvidence(data, directory) {
  chainEvidence(data, directory);
  const {report, cell} = data;
  const space = 'prepared-hosted-space';
  report.state = 'agent'; report.agentHost = 'daemon';
  report.managerHost = {mode: 'daemon-hosted', space, instanceId: 'initial-manager'};
  report.agentBefore = JSON.stringify({result: {kind: 'seats', items: [{name: 'upgrade_proof_worker'}], managers: [{instanceId: 'initial-manager', state: 'answered'}]}});
  report.participant = {space, remote: true, localManagerStarted: false};
  report.cleanup = 'receipt-guarded native removal confirmed';
  const first = report.calls.find(call => call.label === 'upgrade under test');
  first.argv = ['/owned/dist/cotal.js', 'update', '--self', '--stop-agents'];
  first.startedAt = '2026-11-14T10:59:58.000Z';
  report.calls.unshift({label: 'confirm daemon-hosted seat', argv: ['cli', 'ps', '--on', 'initial-manager', '--space', space, '--json'], startedAt: '2026-11-14T10:59:57.000Z', finishedAt: '2026-11-14T10:59:57.000Z', exit: 0, signal: null, timeout: false, stdout: report.agentBefore});
  report.calls.find(call => call.label === 'candidate second hop under test').finishedAt = '2026-11-14T11:00:02.000Z';
  report.calls.splice(report.calls.indexOf(first) + 1, 0,
    {label: 'between hops public daemon status', argv: ['cli', 'daemon', 'status', '--json'], startedAt: '2026-11-14T11:00:00.000Z', finishedAt: '2026-11-14T11:00:00.000Z', ...report.nextHop.intermediate.status},
    {label: 'between hops public update check', argv: ['cli', 'update', '--check'], startedAt: '2026-11-14T11:00:00.000Z', finishedAt: '2026-11-14T11:00:00.000Z', ...report.nextHop.intermediate.updateCheck});
  for (const [stage, version, time, hop] of [
    ['between hops', cell.targetVersion, '2026-11-14T11:00:00.000Z', report.nextHop.intermediate],
    ['after update', cell.finalTargetVersion, '2026-11-14T11:00:03.000Z', report.nextHop.secondHop],
  ]) {
    const instanceId = stage === 'between hops' ? 'manager-A' : 'manager-B';
    const status = {exit: 0, signal: null, timeout: false, stderr: '', stdout: JSON.stringify({result: {state: 'ready', version, managers: [{space, state: 'answering', instanceId}]}})};
    const seats = {exit: 0, signal: null, timeout: false, stderr: '', stdout: JSON.stringify({result: {kind: 'seats', items: [], managers: [{instanceId, state: 'answered'}]}})};
    const bytes = Buffer.from(JSON.stringify({status, seats}));
    const artifact = stage.replaceAll(' ', '-') + '-manager.txt';
    writeFileSync(join(directory, artifact), bytes, {mode: 0o600});
    hop.hostedManager = {space, status, seats, commands: {artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}};
    const commands = [{label: `${stage} hosted Manager status`, argv: ['cli', 'daemon', 'status', '--space', space, '--json'], startedAt: time, finishedAt: time, ...status},
      {label: `${stage} hosted Manager seats`, argv: ['cli', 'ps', '--on', instanceId, '--space', space, '--json'], startedAt: time, finishedAt: time, ...seats}];
    if (stage === 'between hops') report.calls.splice(report.calls.findIndex(call => call.label === 'candidate second hop under test'), 0, ...commands);
    else report.calls.push(...commands);
  }
  report.assertions.push({name: 'hosted Manager restored after both update hops', passed: true}, {name: 'daemon-hosted consent ends owned seat', passed: true}, {name: 'owned daemon-hosted Manager stop succeeds', passed: true});
}
test('actual summary accepts hosted consent source chain only with both restored Manager captures', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(hostedChainEvidence, {scenario: 'agent-stop-consent', sourceVersion: '0.164.10', targetVersion: '0.164.11', phase});
    assert.equal(result.exit, 0, result.stderr);
    const census = JSON.parse(readFileSync(join(result.root, 'upgrade-results/census.json')));
    assert.equal(census.passed.length, 1);
    assert.equal(census.knownRefusals.length, 0);
  }
});
test('actual hosted summary regrades every rate-limited observation and the original deadline', () => {
  function retryEvidence(data, directory) {
    hostedChainEvidence(data, directory);
    const evidence = data.report.nextHop.intermediate.hostedManager;
    const original = data.report.calls.find(call => call.label === 'between hops hosted Manager status');
    const retry = {...original, label: 'between hops hosted Manager status retry 1'};
    const body = JSON.parse(original.stdout);
    body.result.managers[0].state = 'starting';
    body.result.managers[0].reason = '✗ actor cli of owner u_qdvahusrmtf2a7iyw3oyzwk45q is over its limit of 60 connects a minute - retry in 1s - only actor "cli" is limited, not the account\'s other actors';
    const refusal = {exit: 0, signal: null, timeout: false, stderr: '', stdout: JSON.stringify(body)};
    Object.assign(original, refusal, {startedAt: '2026-11-14T11:00:00.000Z', finishedAt: '2026-11-14T11:00:00.000Z'});
    retry.startedAt = retry.finishedAt = '2026-11-14T11:00:01.000Z';
    const seatsCall = data.report.calls.find(call => call.label === 'between hops hosted Manager seats');
    seatsCall.startedAt = seatsCall.finishedAt = '2026-11-14T11:00:01.000Z';
    const second = data.report.calls.find(call => call.label === 'candidate second hop under test');
    second.startedAt = second.finishedAt = '2026-11-14T11:00:02.000Z';
    data.report.calls.splice(data.report.calls.indexOf(original) + 1, 0, retry);
    evidence.timeoutMs = 180000;
    evidence.observationWindow = {startedAt: Date.parse(original.startedAt), deadline: Date.parse(original.startedAt) + 180000};
    evidence.observations = [{status: refusal, observedAt: Date.parse(original.finishedAt), retryAfterMs: 1000}, {status: evidence.status, observedAt: Date.parse(retry.finishedAt), retryAfterMs: 0}];
    const bytes = Buffer.from(JSON.stringify({status: evidence.status, seats: evidence.seats, observations: evidence.observations}));
    writeFileSync(join(directory, evidence.commands.artifact), bytes, {mode: 0o600});
    evidence.commands.bytes = bytes.length;
    evidence.commands.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  const options = {scenario: 'agent-stop-consent', sourceVersion: '0.164.10', targetVersion: '0.164.11'};
  const good = fixture(retryEvidence, options);
  assert.equal(good.exit, 0, good.stderr);
  for (const change of [
    d => { d.report.nextHop.intermediate.hostedManager.timeoutMs = 180001; },
    d => { d.report.calls.find(c => c.label.endsWith('status retry 1')).startedAt = '2026-11-14T11:00:00.999Z'; },
    d => { d.report.nextHop.intermediate.hostedManager.observations.shift(); },
    d => { d.report.calls.find(c => c.label === 'between hops hosted Manager status').stdout = '{}'; },
  ]) {
    const result = fixture((data, directory) => { retryEvidence(data, directory); change(data); }, options);
    assert.notEqual(result.exit, 0);
  }
});

test('actual hosted consent summary rejects absent, wrong, stale or unbound Manager evidence', () => {
  for (const change of [
    d => { delete d.report.agentBefore; },
    d => { d.report.calls.splice(d.report.calls.findIndex(c => c.label === 'candidate second hop under test'), 0, {label: 'repair installation', argv: ['cli', 'daemon', 'setup'], exit: 0}); },
    d => { d.report.calls.find(c => c.label === 'upgrade under test').argv[0] = '/other/dist/cotal.js'; },
    d => { delete d.report.nextHop.intermediate.hostedManager; },
    d => { delete d.report.nextHop.secondHop.hostedManager; },
    d => { d.report.participant.space = 'other-space'; },
    d => { d.report.nextHop.intermediate.hostedManager.commands.sha256 = '0'.repeat(64); },
    d => { d.report.nextHop.secondHop.hostedManager = structuredClone(d.report.nextHop.intermediate.hostedManager); },
    d => { d.report.calls.find(c => c.label === 'between hops hosted Manager status').startedAt = '2026-11-14T10:00:00.000Z'; },
    d => { d.report.calls.find(c => c.label === 'after update hosted Manager seats').stdout = '{}'; },
    d => { d.report.calls.find(c => c.label === 'upgrade under test').argv.pop(); },
    d => { d.report.nextHop.secondHop.update.exit = 2; d.report.calls.find(c => c.label === 'candidate second hop under test').exit = 2; },
    d => { d.report.assertions = d.report.assertions.filter(a => a.name !== 'daemon-hosted consent ends owned seat'); },
  ]) {
    const result = fixture((data, directory) => { hostedChainEvidence(data, directory); change(data); }, {scenario: 'agent-stop-consent', sourceVersion: '0.164.10', targetVersion: '0.164.11'});
    assert.notEqual(result.exit, 0);
  }
});

test('actual summary counts complete source chain as genuine without waiving the raw first-hop refusal', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(chainEvidence, { scenario: 'source-0.164.10-daemon-self-chain', phase });
    assert.equal(result.exit, 0, result.stderr);
    const census = JSON.parse(readFileSync(join(result.root, 'upgrade-results/census.json')));
    assert.equal(census.passed.length, 1);
    assert.equal(census.knownRefusals.length, 0);
    assert.equal(census.upgradeAcceptance, true);
  }
});
test('chain summary rejects unhealthy intermediate machine and changed measured refusal or second hop', () => {
  for (const mutate of [
    data => { const status = JSON.parse(data.report.nextHop.intermediate.status.stdout); status.result.update.restartEvidence.prepared = true; data.report.nextHop.intermediate.status.stdout = JSON.stringify(status); },
    data => { const status = JSON.parse(data.report.nextHop.intermediate.status.stdout); status.result.update.lastResult = 'paused'; data.report.nextHop.intermediate.status.stdout = JSON.stringify(status); },
    data => { data.report.daemonDiagnostics['between-hops'].observations.find(row => row.kind === 'update-recovery.json').state = 'archived'; },
    data => { delete data.report.nextHop.intermediate.updateCheck; },
    data => { data.report.calls.find(call => call.label === 'candidate second hop under test').startedAt = '2026-11-14T10:59:00.000Z'; },
    data => { data.report.calls.find(call => call.label === 'upgrade under test').stdout += 'different actual call'; },
    data => { delete data.report.nextHop.intermediate.commands; },
    data => { data.report.candidateSourceInvocation.loadedCli.sha256 = 'f'.repeat(64); },
    data => { data.report.nextHop.firstHop.update.signal = 'SIGTERM'; },
    data => { data.report.nextHop.firstHop.update.exit = 3; },
    data => { data.report.nextHop.firstHop.update.stderr += 'extra trailer\n'; },
    data => { data.report.nextHop.secondHop.update.timeout = true; data.report.calls.find(call => call.label === 'candidate second hop under test').timeout = true; },
  ]) {
    const result = fixture((data, directory) => { chainEvidence(data, directory); mutate(data); }, { scenario: 'source-0.164.10-daemon-self-chain' });
    assert.notEqual(result.exit, 0);
  }
});
test('paired summary cannot pass ordinary evidence relabelled as candidate-own-next in either phase', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(data => {
      data.report.source = data.cell.sourceVersion;
      data.report.sourceRequested = data.cell.sourceVersion;
      data.report.target = data.cell.targetVersion;
    }, { scenario: 'candidate-next-daemon-self', phase });
    assert.notEqual(result.exit, 0);
  }
});
test('pinned source chain cannot pass without second-hop and whole-machine evidence', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(data => {
      data.report.source = data.cell.sourceVersion;
      data.report.sourceRequested = data.cell.sourceVersion;
      data.report.target = data.cell.finalTargetVersion;
    }, { scenario: 'source-0.164.10-daemon-self-chain', phase });
    assert.notEqual(result.exit, 0);
  }
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
function containerRefusalEvidence(data) {
  const entry = knownRefusals.find(entry => entry.id === 'linux-npm-container-manager');
  const space = 'update-participant-a-1794633286189';
  const owner = 'u_wdhhojionrz2rav4mearesx4ou';
  const stdout = entry.stdout.replaceAll('{{space}}', space);
  const stderr = entry.stderr.replaceAll('{{owner}}', owner);
  const update = { exit: entry.exit, signal: null, timeout: false, stdout, stderr };
  Object.assign(data.report, { result: 'failed', state: 'configured', participant: { remote: true, localManagerStarted: false, space, owner }, update });
  data.report.extensionsBefore = Array.from({ length: 8 }, (_, i) => ({ pkg: `@cotal-ai/extension-${i}`, version: data.cell.sourceVersion }));
  data.report.extensionsAfter = structuredClone(data.report.extensionsBefore);
  data.report.assertions = [...entry.failedAssertions.map(name => ({ name, passed: false, observed: name === 'upgrade exits successfully' ? update : name === 'CLI version is target' ? data.cell.sourceVersion : undefined })), ...entry.requiredAssertions.map(name => ({ name, passed: true }))];
}
test('actual summary accepts only exact safe listed red and keeps full upgrade acceptance false', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(data => {
      containerRefusalEvidence(data);
      if (phase === 'published') { data.report.tier = 'published'; data.report.environment.registryOverridden = false; delete data.report.candidate; }
    }, { scenario: 'container-manager', phase });
    assert.equal(result.exit, 0, result.stderr);
    const census = JSON.parse(readFileSync(join(result.root, 'upgrade-results/census.json')));
    assert.equal(census.acceptance, true);
    assert.equal(census.upgradeAcceptance, false);
    assert.equal(census.passed.length, 0);
    assert.equal(census.knownRefusals[0].issue, 'https://github.com/Cotal-AI/Cotal/issues/6785');
  }
});
test('actual summary accepts standalone-stop-consent as a genuine pass with no known refusal', () => {
  for (const phase of ['candidate', 'published']) {
    const result = fixture(data => {
      data.report.state = 'agent';
      data.report.agentHost = 'standalone';
      data.report.calls = [{ argv: ['update', '--self', '--stop-agents'], exit: 0 }];
      data.report.assertions.push({ name: 'owned local stack cleanup succeeds', passed: true });
      if (phase === 'published') { data.report.tier = 'published'; data.report.environment.registryOverridden = false; delete data.report.candidate; }
    }, { scenario: 'standalone-stop-consent', sourceVersion: '0.164.16', targetVersion: '0.164.17', phase });
    assert.equal(result.exit, 0, result.stderr);
    const census = JSON.parse(readFileSync(join(result.root, 'upgrade-results/census.json')));
    assert.equal(census.acceptance, true);
    assert.equal(census.upgradeAcceptance, true);
    assert.deepEqual(census.passed, ['linux-npm-standalone-stop-consent']);
    assert.equal(census.knownRefusals.length, 0);
  }
});
test('actual summary refuses listed green, changed refusal, extra failure and missing cleanup', () => {
  for (const mutate of [d => { d.report.result = 'passed'; }, d => { d.report.update.stdout += 'changed\n'; }, d => { d.report.assertions.push({ name: 'extra failure', passed: false }); }, d => { d.report.cleanupSafety.passed = false; }, d => { d.report.candidate.source = 'b'.repeat(40); }]) {
    const result = fixture(d => { containerRefusalEvidence(d); mutate(d); }, { scenario: 'container-manager' });
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
