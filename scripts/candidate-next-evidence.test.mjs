import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {captureDaemonDiagnostics} from './daemon-cell-diagnostics.mjs';
import {evaluateManualDaemonState} from './daemon-manual-acceptance.mjs';
import {matchSource16410Refusal, source16410Refusals} from './source-16410-refusal.mjs';
import {candidateSourceIdentity, hostedManagerRestored, intermediateWholeMachine, verifyCandidateNextEvidence} from './candidate-next-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (path, value) => writeFileSync(path, JSON.stringify(value), {mode: 0o600});

function hostedCapture(output, stage, at, change = () => {}) {
  const evidence = {space: 'proof-space',
    status: {exit: 0, signal: null, timeout: false, stderr: '', stdout: JSON.stringify({result: {state: 'ready', version: '1.2.3', managers: [{space: 'proof-space', state: 'answering', instanceId: 'current-manager'}]}})},
    seats: {exit: 0, signal: null, timeout: false, stderr: '', stdout: JSON.stringify({result: {kind: 'seats', items: [], managers: [{instanceId: 'current-manager', state: 'answered'}]}})}};
  change(evidence);
  const bytes = Buffer.from(JSON.stringify({status: evidence.status, seats: evidence.seats}));
  const artifact = `${stage.replaceAll(' ', '-')}-${Math.random().toString(16).slice(2)}.txt`;
  writeFileSync(join(output, artifact), bytes, {mode: 0o600, flag: 'wx'});
  evidence.commands = {artifact, bytes: bytes.length, sha256: hash(bytes)};
  const calls = [
    {label: `${stage} hosted Manager status`, argv: ['cli', 'daemon', 'status', '--space', evidence.space, '--json'], ...evidence.status},
    {label: `${stage} hosted Manager seats`, argv: ['cli', 'ps', '--on', 'current-manager', '--space', evidence.space, '--json'], ...evidence.seats},
  ].map(call => ({...call, startedAt: at, finishedAt: at}));
  return {evidence, calls, output, target: '1.2.3', stage, after: at, before: at};
}

function archiveHostedObservations(f) {
  const {evidence, output} = f;
  const bytes = Buffer.from(JSON.stringify({status: evidence.status, seats: evidence.seats,
    ...(evidence.observations ? {observations: evidence.observations} : {})}));
  writeFileSync(join(output, evidence.commands.artifact), bytes, {mode: 0o600});
  evidence.commands.bytes = bytes.length;
  evidence.commands.sha256 = hash(bytes);
}

function hostedObservations(attempts = 2, {
  output = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-observations-'))),
  start = Date.parse('2026-11-14T18:00:00.000Z'),
} = {}) {
  const iso = offset => new Date(start + offset).toISOString();
  const f = hostedCapture(output, 'between hops', iso(0));
  const statusCall = f.calls[0], seatsCall = f.calls[1];
  f.evidence.timeoutMs = 180000;
  f.evidence.observationWindow = {startedAt: start, deadline: start + 180000};
  f.evidence.observations = Array.from({length: attempts}, (_, index) => {
    const status = structuredClone(f.evidence.status);
    const retryAfterMs = index === attempts - 1 ? 0 : 1000;
    if (retryAfterMs) {
      const body = JSON.parse(status.stdout);
      body.result.managers[0].state = 'starting';
      body.result.managers[0].reason = '✗ actor cli of owner u_qdvahusrmtf2a7iyw3oyzwk45q is over its limit of 60 connects a minute - retry in 1s - only actor "cli" is limited, not the account\'s other actors';
      status.stdout = JSON.stringify(body);
    }
    return {status, observedAt: start + index * 1100 + 100, retryAfterMs};
  });
  f.calls = f.evidence.observations.map((observation, index) => ({...statusCall, ...observation.status,
    label: `${f.stage} hosted Manager status${index ? ` retry ${index}` : ''}`,
    startedAt: iso(index * 1100), finishedAt: iso(index * 1100 + 100)}));
  const end = attempts * 1100;
  f.calls.push({...seatsCall, startedAt: iso(end), finishedAt: iso(end + 100)});
  f.before = iso(end + 100);
  archiveHostedObservations(f);
  return f;
}

test('hosted observations accept archived single answer and two attempts with the stated 1s delay', () => {
  for (const attempts of [1, 2]) {
    const f = hostedObservations(attempts);
    const before = JSON.stringify(f);
    assert.deepEqual(hostedManagerRestored(f), {passed: true, space: 'proof-space', instanceId: 'current-manager'});
    assert.equal(JSON.stringify(f), before);
    assert.deepEqual(JSON.parse(readFileSync(join(f.output, f.evidence.commands.artifact))), {
      status: f.evidence.status, seats: f.evidence.seats, observations: f.evidence.observations,
    });
  }
});

test('hosted observations reject a changed STARTING reason even when archive and actual call agree', () => {
  for (const reason of ['unreachable', 'actor manager of owner proof_owner is over its limit of 60 connects a minute - retry in 1s - only actor "cli" is limited, not the account\'s other actors', undefined]) {
    const f = hostedObservations();
    const status = f.evidence.observations[0].status;
    const body = JSON.parse(status.stdout);
    body.result.managers[0].reason = reason;
    status.stdout = f.calls[0].stdout = JSON.stringify(body);
    archiveHostedObservations(f);
    assert.throws(() => hostedManagerRestored(f), /unmeasured hosted Manager STARTING reason/);
  }
});

test('hosted observations require the complete archive and bind every actual status call', () => {
  const cases = [
    ['missing observations', f => { delete f.evidence.observations; }],
    ['missing first refusal', f => { f.evidence.observations.shift(); }],
    ['missing actual call', f => { f.calls.shift(); }],
    ['additional actual call', f => { f.calls.splice(1, 0, structuredClone(f.calls[0])); }],
    ['changed actual reply', f => { f.calls[0].stderr = 'unbound'; }],
    ['changed actual argv', f => { f.calls[0].argv[4] = 'other-space'; }],
    ['missing retry index', f => { f.calls[1].label = `${f.stage} hosted Manager status retry 2`; }],
    ['false stated delay', f => { f.evidence.observations[0].retryAfterMs = 1; }],
    ['final status differs', f => { f.evidence.status.stderr = 'unbound'; }],
  ];
  for (const [name, change] of cases) {
    const f = hostedObservations();
    change(f);
    archiveHostedObservations(f);
    assert.throws(() => hostedManagerRestored(f), assert.AssertionError, name);
  }
  const f = hostedObservations();
  f.evidence.observations[0].observedAt++;
  assert.throws(() => hostedManagerRestored(f), assert.AssertionError, 'archive must retain observation timestamps');
});

test('hosted observations reject early retry, widened deadlines and invalid call or observation timestamps', () => {
  const cases = [
    ['early retry', f => { f.calls[1].startedAt = new Date(f.evidence.observations[0].observedAt + 999).toISOString(); }],
    ['widened timeout', f => { f.evidence.timeoutMs++; f.evidence.observationWindow.deadline++; }],
    ['widened deadline', f => { f.evidence.observationWindow.deadline++; }],
    ['at deadline', f => { f.evidence.observations[1].observedAt = f.evidence.observationWindow.deadline; }],
    ['observation before call finished', f => { f.evidence.observations[0].observedAt--; }],
    ['call before window', f => { f.calls[0].startedAt = new Date(f.evidence.observationWindow.startedAt - 1).toISOString(); }],
    ['reversed first call', f => { f.calls[0].finishedAt = new Date(f.evidence.observationWindow.startedAt - 1).toISOString(); }],
    ['invalid first call time', f => { f.calls[0].startedAt = 'invalid'; }],
    ['final call after before', f => { f.before = f.calls[1].startedAt; }],
    ['seats before after', f => { f.calls.at(-1).startedAt = new Date(Date.parse(f.after) - 1).toISOString(); }],
  ];
  for (const [name, change] of cases) {
    const f = hostedObservations();
    change(f);
    archiveHostedObservations(f);
    assert.throws(() => hostedManagerRestored(f), assert.AssertionError, name);
  }
});

test('hosted observations bind the initial refusal to the same after-update time boundary', () => {
  const f = hostedObservations();
  f.after = new Date(f.evidence.observationWindow.startedAt + 1).toISOString();
  assert.throws(() => hostedManagerRestored(f), /predates.*update/);
});

test('hosted Manager helper reopens replies and rejects missing, stale, relabeled and altered receipts', () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-evidence-')));
  const f = hostedCapture(output, 'between hops', '2026-11-14T18:00:00.000Z');
  assert.deepEqual(hostedManagerRestored(f), {passed: true, space: 'proof-space', instanceId: 'current-manager'});
  for (const change of [
    v => { delete v.evidence; },
    v => { delete v.evidence.commands; },
    v => { v.evidence.commands.artifact = 'missing.txt'; },
    v => { v.evidence.commands.sha256 = '0'.repeat(64); },
    v => { v.evidence.status.stdout = '{}'; },
    v => { v.calls.pop(); },
    v => { v.calls.push(structuredClone(v.calls[0])); },
    v => { v.calls[0].label = 'after update hosted Manager status'; },
    v => { v.calls[0].argv[2] = 'setup'; },
    v => { v.calls[1].argv[3] = 'old-manager'; },
    v => { v.calls[0].stdout = '{}'; },
    v => { v.calls[0].startedAt = '2026-11-14T17:59:59.000Z'; },
    v => { v.calls[1].finishedAt = '2026-11-14T18:00:01.000Z'; },
  ]) {
    const value = structuredClone(f); change(value);
    assert.throws(() => hostedManagerRestored(value));
  }
});

test('hosted Manager helper rejects unknown outcomes, unready Managers and false empty-seat evidence', () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-state-')));
  for (const change of [
    e => { e.status.exit = 2; },
    e => { e.status.signal = 'SIGTERM'; },
    e => { e.seats.timeout = true; },
    e => { e.seats.exit = null; },
    e => { e.status.stdout = e.status.stdout.replace('ready', 'stopped'); },
    e => { e.status.stdout = e.status.stdout.replace('1.2.3', '1.2.2'); },
    e => { e.status.stdout = e.status.stdout.replace('answering', 'starting'); },
    e => { const v = JSON.parse(e.status.stdout); v.result.managers = []; e.status.stdout = JSON.stringify(v); },
    e => { const v = JSON.parse(e.status.stdout); v.result.managers.push(v.result.managers[0]); e.status.stdout = JSON.stringify(v); },
    e => { const v = JSON.parse(e.seats.stdout); v.result.items = [{name: 'upgrade_proof_worker'}]; e.seats.stdout = JSON.stringify(v); },
    e => { e.seats.stdout = e.seats.stdout.replace('answered', 'unreachable'); },
    e => { e.seats.stdout = e.seats.stdout.replace('current-manager', 'old-manager'); },
    e => { const v = JSON.parse(e.seats.stdout); delete v.result.items; e.seats.stdout = JSON.stringify(v); },
  ]) {
    const value = hostedCapture(output, 'between hops', '2026-11-14T18:00:00.000Z', change);
    let passed = false;
    try { passed = hostedManagerRestored(value).passed; } catch (error) { assert(error instanceof assert.AssertionError); }
    assert.equal(passed, false);
  }
});
function installed() {
  const pkg = mkdtempSync(join(tmpdir(), 'candidate-source-'));
  mkdirSync(join(pkg, 'dist'), {mode: 0o700});
  const cli = join(pkg, 'dist/cotal.js');
  write(join(pkg, 'package.json'), {name: 'cotal-ai', version: '1.2.3'});
  writeFileSync(cli, '// synthetic candidate A entry\n', {mode: 0o600});
  const files = Object.fromEntries(['package.json', 'dist/cotal.js'].map(name => [name, hash(readFileSync(join(pkg, name)))]));
  const loadedRoot = join(pkg, 'node_modules/@cotal-ai/cli');
  mkdirSync(join(loadedRoot, 'dist'), {recursive: true, mode: 0o700});
  write(join(loadedRoot, 'package.json'), {name: '@cotal-ai/cli', version: '1.2.3', type: 'module', exports: {'./update': {import: './dist/update.js'}}});
  writeFileSync(join(loadedRoot, 'dist/update.js'), 'export const synthetic = true;\n', {mode: 0o600});
  const loadedFiles = Object.fromEntries(['package.json', 'dist/update.js'].map(name => [name, hash(readFileSync(join(loadedRoot, name)))]));
  return {pkg, cli, argv: [cli, 'update', '--self'], identity: {sourceVersion: '1.2.3', sourcePackages: [{name: 'cotal-ai', files}, {name: '@cotal-ai/cli', files: loadedFiles}]}};
}
test('candidate source binds real installed package, entry, version and argv without changing bytes', () => {
  const f = installed();
  const before = ['package.json', 'dist/cotal.js'].map(name => readFileSync(join(f.pkg, name)));
  assert.deepEqual(candidateSourceIdentity(f), {path: realpathSync(f.cli), sha256: hash(before[1]), packageSha256: hash(before[0]), name: 'cotal-ai', version: '1.2.3', argv: f.argv, loadedCli: {path: realpathSync(join(f.pkg, 'node_modules/@cotal-ai/cli/dist/update.js')), member: 'dist/update.js', sha256: f.identity.sourcePackages[1].files['dist/update.js'], packageSha256: f.identity.sourcePackages[1].files['package.json'], name: '@cotal-ai/cli', version: '1.2.3'}});
  for (const change of [
    v => { v.identity.sourcePackages[0].files['dist/cotal.js'] = '0'.repeat(64); },
    v => { v.identity.sourcePackages[0].files['package.json'] = '0'.repeat(64); },
    v => { v.identity.sourceVersion = '1.2.2'; },
    v => { v.identity.sourcePackages = []; },
    v => { v.identity.sourcePackages.pop(); },
    v => { v.identity.sourcePackages[1].files['package.json'] = 'bad'; },
    v => { v.identity.sourcePackages[1].files['dist/update.js'] = 'bad'; },
    v => { v.argv = [f.cli, 'update']; },
  ]) {
    const value = structuredClone(f); change(value);
    assert.throws(() => candidateSourceIdentity(value));
  }
  assert.deepEqual(['package.json', 'dist/cotal.js'].map(name => readFileSync(join(f.pkg, name))), before);
});

// Real filesystem/socket/process capture, but synthetic supervisor and public CLI replies.
// No native service or published archive acceptance is claimed by this fixture.
async function capture(t, {recovery, stage = 'between-hops'} = {}) {
  assert.equal(process.platform, 'linux');
  const temporaryHome = mkdtempSync(join(tmpdir(), 'candidate-state-'));
  const home = realpathSync(temporaryHome);
  const dirs = Object.fromEntries(['output', 'cotalHome', 'daemonHome', 'config', 'pkg', 'globalRoot', 'tmp'].map(key => [key, join(home, key)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, {mode: 0o700});
  const socketPath = join(temporaryHome, 'daemon.sock');
  const server = createServer(peer => peer.destroy());
  server.listen(socketPath); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const socket = lstatSync(socketPath);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  write(join(dirs.pkg, 'package.json'), {name: 'cotal-ai', version: '1.2.3'});
  write(join(dirs.daemonHome, 'daemon.lock'), {pid: process.pid, start, socket: {path: join(home, 'daemon.sock'), dev: socket.dev, ino: socket.ino}});
  if (recovery !== undefined) write(join(dirs.cotalHome, 'update-recovery.json'), recovery);
  const run = (stdout, bounds) => new Promise(resolve => {
    execFile(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)})`], {cwd: home, env: {PATH: '/usr/bin:/bin', HOME: home, COTAL_HOME: dirs.cotalHome, XDG_CONFIG_HOME: dirs.config, TMPDIR: dirs.tmp}, timeout: bounds.timeoutMs, maxBuffer: bounds.maxBuffer, encoding: 'utf8'}, (error, stdout, stderr) => resolve({exit: error ? error.code : 0, stdout, stderr}));
  });
  const diagnostics = await captureDaemonDiagnostics({...dirs, home, platform: 'linux', id: 'candidate', stage, startedAt: new Date().toISOString(), plan: {globalRoot: dirs.globalRoot, unit: 'cotal-daemon.service'}, run: (_file, _args, bounds) => run(`LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=${process.pid}\n`, bounds), daemonStatus: bounds => run(JSON.stringify({result: {state: 'ready', pid: process.pid, version: '1.2.3'}}), bounds)});
  return {diagnostics, output: dirs.output, target: '1.2.3', platform: 'linux', status: {exit: 0, stdout: JSON.stringify({result: {state: 'ready', version: '1.2.3', update: {lastResult: 'completed', restartEvidence: {prepared: false}}}})}, updateCheck: {exit: 0, timeout: false, signal: null}};
}
test('intermediate capture requires ready A, no pause, clear fence and successful public update check', async t => {
  const f = await capture(t);
  const before = JSON.stringify(f);
  assert.equal(evaluateManualDaemonState({...f, diagnostics: {...f.diagnostics, stage: 'after-update'}}).passed, true);
  assert.equal(intermediateWholeMachine(f).passed, true);
  for (const change of [
    v => { v.status = undefined; },
    v => { v.status.exit = 1; },
    v => { v.status.stdout = JSON.stringify({result: {state: 'stopped', version: '1.2.3'}}); },
    v => { v.status.stdout = v.status.stdout.replace('1.2.3', '1.2.2'); },
    v => { v.status.stdout = v.status.stdout.replace('completed', 'paused'); },
    v => { v.status.stdout = v.status.stdout.replace('false', 'true'); },
    v => { v.status.stdout = JSON.stringify({result: {state: 'ready', version: '1.2.3', update: {lastResult: 'completed'}}}); },
    v => { v.updateCheck = undefined; },
    v => { v.updateCheck.exit = 1; },
    v => { v.updateCheck.timeout = true; },
    v => { v.updateCheck.signal = 'SIGTERM'; },
    v => { v.diagnostics.observations = v.diagnostics.observations.filter(row => row.kind !== 'daemon-status'); },
  ]) {
    const value = structuredClone(f); change(value);
    assert.equal(intermediateWholeMachine(value).passed, false);
  }
  assert.equal(JSON.stringify(f), before);
});
test('intermediate capture fails closed on real archived unresolved recovery', async t => {
  assert.equal(intermediateWholeMachine(await capture(t, {recovery: {phase: 'paused'}})).passed, false);
});
test('hosted consent chain requires both timed Manager stages and exact first-hop consent', async t => {
  const f = await capture(t, {stage: 'after-update'}), source = installed();
  const at = f.diagnostics.capturedAt;
  const pair = {...source.identity, source: 'synthetic-sha', sourceManifestSha256: 'source-manifest', targetManifestSha256: 'target-manifest', targetVersion: '1.2.3'};
  const contract = source16410Refusals.find(row => row.platform === 'linux' && row.layout === 'npm');
  const firstUpdate = {exit: 2, signal: null, timeout: false,
    stdout: 'this 0.164.10 process remains loaded until the verified global copy takes over\n'
      + 'machine daemon: waiting up to 120s for Cotal 1.2.3 and its hosted Managers before the continuity check\n'
      + '✓ cotal-ai@1.2.3 installed globally and reconciled\n', stderr: contract.trailer};
  const secondUpdate = {exit: 0, signal: null, timeout: false, stdout: '', stderr: ''};
  const middle = hostedCapture(f.output, 'between hops', at);
  const last = hostedCapture(f.output, 'after update', at);
  const bytes = Buffer.from(JSON.stringify({status: f.status, updateCheck: f.updateCheck}));
  const commands = {artifact: 'hosted-between-hop-commands.txt', bytes: bytes.length, sha256: hash(bytes)};
  writeFileSync(join(f.output, commands.artifact), bytes, {mode: 0o600});
  const agentBefore = JSON.stringify({result: {kind: 'seats', items: [{name: 'upgrade_proof_worker'}], managers: [{instanceId: 'initial-manager', state: 'answered'}]}});
  const report = {candidateNext: pair, candidateSourceInvocation: candidateSourceIdentity(source), source: '0.164.10', target: '1.2.3', agentHost: 'daemon', agentBefore,
    participant: {space: 'proof-space'}, managerHost: {mode: 'daemon-hosted', space: 'proof-space', instanceId: 'initial-manager'},
    calls: [
      {label: 'confirm daemon-hosted seat', argv: [source.cli, 'ps', '--on', 'initial-manager', '--space', 'proof-space', '--json'], exit: 0, signal: null, timeout: false, stdout: agentBefore, stderr: '', startedAt: at, finishedAt: at},
      {label: 'upgrade under test', argv: [source.cli, 'update', '--self', '--stop-agents'], ...firstUpdate, startedAt: at, finishedAt: at},
      {label: 'between hops public daemon status', argv: [source.cli, 'daemon', 'status', '--json'], ...f.status, startedAt: at, finishedAt: at},
      {label: 'between hops public update check', argv: [source.cli, 'update', '--check'], ...f.updateCheck, startedAt: at, finishedAt: at},
      ...middle.calls,
      {label: 'candidate second hop under test', argv: source.argv, ...secondUpdate, startedAt: at, finishedAt: at},
      ...last.calls,
    ],
    nextHop: {mode: 'source-0.164.10', finalTargetVersion: '1.2.3',
      firstHop: {update: firstUpdate, refusal: matchSource16410Refusal({platform: 'linux', layout: 'npm', sourceVersion: '0.164.10', targetVersion: '1.2.3', update: firstUpdate})},
      intermediate: {status: f.status, updateCheck: f.updateCheck, commands, hostedManager: middle.evidence},
      secondHop: {update: secondUpdate, hostedManager: last.evidence}},
    daemonDiagnostics: {'between-hops': f.diagnostics, 'after-update': f.diagnostics}};
  const args = {report, cell: {scenario: 'agent-stop-consent', sourceSHA: pair.source, platform: 'linux', channel: 'npm'}, output: f.output, sourceManifestSha256: pair.sourceManifestSha256, targetManifestSha256: pair.targetManifestSha256};
  assert.deepEqual(verifyCandidateNextEvidence(args), {sourceIdentity: true, firstRefusal: true, intermediateWhole: true, nextHopSuccess: true, hostedManagerRestored: true});
  const retryMiddle = hostedObservations(2, {output: f.output, start: Date.parse(at)});
  const retryReport = structuredClone(report);
  retryReport.nextHop.intermediate.hostedManager = retryMiddle.evidence;
  retryReport.calls.splice(4, 2, ...retryMiddle.calls);
  for (const call of retryReport.calls.slice(7)) {
    call.startedAt = retryMiddle.before;
    call.finishedAt = retryMiddle.before;
  }
  assert.deepEqual(verifyCandidateNextEvidence({...args, report: retryReport}), {sourceIdentity: true, firstRefusal: true, intermediateWhole: true, nextHopSuccess: true, hostedManagerRestored: true});
  for (const change of [
    v => { v.calls.splice(5, 0, {label: 'repair installation', argv: ['cli', 'daemon', 'setup']}); },
    v => { v.calls.splice(5, 0, {label: 'unarchived status', argv: ['cli', 'daemon', 'status', '--space', 'proof-space', '--json']}); },
    v => { v.calls.splice(5, 1); },
    v => { v.calls.push(structuredClone(v.calls[4])); },
    v => { v.calls[4].startedAt = new Date(Date.parse(at) - 1).toISOString(); },
  ]) {
    const value = structuredClone(retryReport);
    change(value);
    assert.throws(() => verifyCandidateNextEvidence({...args, report: value}));
  }
  for (const change of [
    v => { v.calls[1].argv.pop(); },
    v => { v.calls[1].argv[0] = 'other-installed-entry'; },
    v => { v.calls.shift(); },
    v => { v.calls.push(structuredClone(v.calls[0])); },
    v => { v.calls[0].exit = 1; },
    v => { v.calls[0].signal = 'SIGTERM'; },
    v => { v.calls[0].timeout = true; },
    v => { v.agentBefore = '{}'; },
    v => { v.calls[0].argv[3] = 'other-manager'; },
    v => { v.calls[0].finishedAt = '2099-01-01T00:00:00.000Z'; },
    v => { v.calls.splice(3, 0, {label: 'repair installation', argv: ['cli', 'daemon', 'setup']}); },
    v => { v.calls.splice(2, 1); },
    v => { delete v.calls[1].startedAt; },
    v => { v.calls[1].startedAt = '2099-01-01T00:00:00.000Z'; },
    v => { delete v.calls[6].finishedAt; },
    v => { v.calls[6].finishedAt = '2000-01-01T00:00:00.000Z'; },
    v => { v.calls[2].startedAt = '2000-01-01T00:00:00.000Z'; },
    v => { v.calls[3].finishedAt = '2000-01-01T00:00:00.000Z'; },
    v => { v.calls[3].finishedAt = '2099-01-01T00:00:00.000Z'; },
    v => { v.calls[2].argv = [source.cli, 'daemon', 'setup', '--json']; },
    v => { v.calls[3].argv = [source.cli, 'update', '--self']; },
    v => { v.calls[2].stdout = '{}'; },
    v => { v.calls[3].stderr = 'different receipt'; },
    v => { v.calls[3].exit = 1; },
    v => { [v.calls[2], v.calls[3]] = [v.calls[3], v.calls[2]]; },
    ...[
      inventory => { inventory.items = []; },
      inventory => { inventory.items.push({name: 'other-worker'}); },
      inventory => { inventory.items[0].name = 'other-worker'; },
      inventory => { inventory.managers[0].state = 'unreachable'; },
      inventory => { inventory.managers[0].instanceId = 'foreign-manager'; },
    ].map(change => v => {
      const inventory = JSON.parse(v.agentBefore); change(inventory.result);
      v.agentBefore = JSON.stringify(inventory); v.calls[0].stdout = v.agentBefore;
    }),
    v => { v.agentHost = 'standalone'; },
    v => { v.participant.space = 'other-space'; },
    v => { delete v.nextHop.intermediate.hostedManager; },
    v => { delete v.nextHop.secondHop.hostedManager; },
    v => { v.nextHop.secondHop.hostedManager.commands.sha256 = '0'.repeat(64); },
    v => { v.calls[4].label = 'relabeled'; },
    v => { v.calls[4].startedAt = '2000-01-01T00:00:00.000Z'; },
    v => { v.calls.at(-1).startedAt = '2000-01-01T00:00:00.000Z'; },
  ]) {
    const value = structuredClone(report); change(value);
    assert.throws(() => verifyCandidateNextEvidence({...args, report: value}));
  }
  for (const stage of ['intermediate', 'secondHop']) {
    const value = structuredClone(report);
    const replacement = hostedCapture(f.output, stage === 'intermediate' ? 'between hops' : 'after update', at, evidence => {
      const inventory = JSON.parse(evidence.seats.stdout);
      inventory.result.items = [{name: 'upgrade_proof_worker'}];
      evidence.seats.stdout = JSON.stringify(inventory);
    });
    value.nextHop[stage].hostedManager = replacement.evidence;
    value.calls = value.calls.map(call => replacement.calls.find(other => other.label === call.label) ?? call);
    const result = verifyCandidateNextEvidence({...args, report: value});
    assert.equal(result.hostedManagerRestored, false);
    assert.equal(result.nextHopSuccess, false);
    assert.equal(result.intermediateWhole, stage !== 'intermediate');
  }
});
test('candidate evidence binds captured artifacts, public command receipts and default measured refusal', async t => {
  const f = await capture(t, {stage: 'after-update'}), source = installed();
  const pair = {...source.identity, source: 'synthetic-sha', sourceManifestSha256: 'source-manifest', targetManifestSha256: 'target-manifest', targetVersion: '1.2.3'};
  const report = {candidateNext: pair, candidateSourceInvocation: candidateSourceIdentity(source), source: '1.2.3', target: '1.2.3', calls: [{label: 'upgrade under test', argv: source.argv, exit: 0, signal: null, timeout: false}], nextHop: {mode: 'candidate', finalTargetVersion: '1.2.3', secondHop: {update: {exit: 0, signal: null, timeout: false}}}, daemonDiagnostics: {'after-update': f.diagnostics}};
  const args = {report, cell: {sourceSHA: pair.source, platform: 'linux', channel: 'npm'}, output: f.output, sourceManifestSha256: pair.sourceManifestSha256, targetManifestSha256: pair.targetManifestSha256};
  const before = JSON.stringify(report);
  assert.deepEqual(verifyCandidateNextEvidence(args), {sourceIdentity: true, firstRefusal: false, intermediateWhole: true, nextHopSuccess: true});
  assert.equal(JSON.stringify(report), before);
  for (const change of [
    v => { v.candidateSourceInvocation.sha256 = 'bad'; },
    v => { v.candidateSourceInvocation.version = '1.2.2'; },
    v => { v.candidateSourceInvocation.argv = ['cli', 'update']; },
    v => { v.candidateSourceInvocation.loadedCli.sha256 = 'bad'; },
    v => { v.candidateSourceInvocation.loadedCli.version = '1.2.2'; },
    v => { v.calls = []; },
    v => { v.calls.push(structuredClone(v.calls[0])); },
    v => { v.calls[0].stdout = 'diverged'; },
    v => { v.calls[0].stderr = 'diverged'; },
    v => { v.calls[0].argv = [source.cli, 'update']; },
    v => { v.calls[0].argv = ['wrong-entry', 'update', '--self']; },
    v => { v.calls[0].exit = 1; },
    v => { v.calls[0].signal = 'SIGTERM'; },
    v => { v.calls[0].timeout = true; },
  ]) { const value = structuredClone(report); change(value); assert.throws(() => verifyCandidateNextEvidence({...args, report: value})); }
  const chain = structuredClone(report);
  chain.source = '0.164.10'; chain.nextHop.mode = 'source-0.164.10';
  chain.calls[0].label = 'candidate second hop under test';
  chain.nextHop.firstHop = {update: {exit: 1, signal: null, timeout: false, stdout: 'synthetic', stderr: ''}, refusal: {passed: true}};
  assert.throws(() => verifyCandidateNextEvidence({...args, report: chain}));
  // Generated measured structure only, never a native original or acceptance claim.
  const measured = source16410Refusals.find(row => row.platform === 'linux' && row.layout === 'npm');
  const update = {exit: 2, signal: null, timeout: false,
    stdout: 'this 0.164.10 process remains loaded until the verified global copy takes over\n'
      + 'machine daemon: waiting up to 120s for Cotal 1.2.3 and its hosted Managers before the continuity check\n'
      + '✓ cotal-ai@1.2.3 installed globally and reconciled\n', stderr: measured.trailer};
  chain.calls[0].startedAt = f.diagnostics.capturedAt;
  chain.calls.push({label: 'upgrade under test', argv: ['synthetic-source-cli', 'update', '--self'], ...update, finishedAt: f.diagnostics.capturedAt});
  chain.nextHop.firstHop = {update, refusal: matchSource16410Refusal({platform: 'linux', layout: 'npm', sourceVersion: '0.164.10', targetVersion: '1.2.3', update})};
  const commandBytes = Buffer.from(JSON.stringify({status: f.status, updateCheck: f.updateCheck}));
  const commands = {artifact: 'between-hop-commands.txt', bytes: commandBytes.length, sha256: hash(commandBytes)};
  writeFileSync(join(f.output, commands.artifact), commandBytes, {mode: 0o600});
  chain.nextHop.intermediate = {status: f.status, updateCheck: f.updateCheck, commands};
  chain.daemonDiagnostics['between-hops'] = f.diagnostics;
  assert.deepEqual(verifyCandidateNextEvidence({...args, report: chain}), {sourceIdentity: true, firstRefusal: true, intermediateWhole: true, nextHopSuccess: true});
  for (const change of [
    v => { v.calls.pop(); },
    v => { v.calls.push(structuredClone(v.calls[1])); },
    v => { v.calls[1].stdout += 'diverged'; },
    v => { v.calls[1].argv = ['synthetic-source-cli', 'update']; },
    v => { v.calls[1].finishedAt = new Date(Date.parse(f.diagnostics.capturedAt) + 1).toISOString(); },
    v => { v.calls[0].startedAt = new Date(Date.parse(f.diagnostics.capturedAt) - 1).toISOString(); },
    v => { delete v.nextHop.intermediate.commands; },
    v => { v.nextHop.intermediate.commands.sha256 = '0'.repeat(64); },
    v => { v.nextHop.intermediate.commands.bytes += 1; },
    v => { v.nextHop.intermediate.status.stdout = v.nextHop.intermediate.status.stdout.replace('completed', 'different embedded result'); },
    v => { v.nextHop.intermediate.updateCheck.exit = 1; },
  ]) {
    const changed = structuredClone(chain); change(changed);
    assert.throws(() => verifyCandidateNextEvidence({...args, report: changed}));
  }
  chain.nextHop.firstHop.update.stderr += 'changed';
  chain.calls[1].stderr = chain.nextHop.firstHop.update.stderr;
  assert.throws(() => verifyCandidateNextEvidence({...args, report: chain}), /terminal refusal/);
  chain.nextHop.firstHop.refusal = {passed: true};
  assert.throws(() => verifyCandidateNextEvidence({...args, report: chain}), /terminal refusal/);
});
