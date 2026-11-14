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
import {candidateSourceIdentity, intermediateWholeMachine, verifyCandidateNextEvidence} from './candidate-next-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (path, value) => writeFileSync(path, JSON.stringify(value), {mode: 0o600});
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
  const home = mkdtempSync(join(tmpdir(), 'candidate-state-'));
  const dirs = Object.fromEntries(['output', 'cotalHome', 'daemonHome', 'config', 'pkg', 'globalRoot', 'tmp'].map(key => [key, join(home, key)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, {mode: 0o700});
  const socketPath = join(home, 'daemon.sock');
  const server = createServer(peer => peer.destroy());
  server.listen(socketPath); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const socket = lstatSync(socketPath);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  write(join(dirs.pkg, 'package.json'), {name: 'cotal-ai', version: '1.2.3'});
  write(join(dirs.daemonHome, 'daemon.lock'), {pid: process.pid, start, socket: {path: socketPath, dev: socket.dev, ino: socket.ino}});
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
