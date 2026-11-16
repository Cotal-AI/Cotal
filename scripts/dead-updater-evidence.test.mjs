import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyDeadUpdaterEvidence} from './dead-updater-evidence.mjs';

// These are verifier contract tests, not native updater acceptance.
function fixture() {
  const output = mkdtempSync(join(tmpdir(), 'dead-updater-evidence-'));
  const sourceEntry = '/prefix/lib/node_modules/cotal-ai/dist/cotal.js';
  const base = Date.parse('2026-11-16T12:00:00Z');
  const at = offset => new Date(base + offset).toISOString();
  const command = (label, offset, argv, extra = {}) => ({label, file: '/node', argv: [sourceEntry, ...argv], exit: 0, signal: null, timeout: false, stdout: '', stderr: '', startedAt: at(offset), finishedAt: at(offset + 10), ...extra});
  const before = {daemon: {pid: 100, start: 'daemon-birth'}, manager: {pid: 101, start: 'manager-birth', instanceId: 'instance'}};
  const prepared = {prepared: true, managers: [{fenced: true, seats: 0}]};
  const recoveredStatus = {ok: true, data: {instanceId: 'instance', agentCount: 0, stopImpact: {maintenance: 'active', resumeRequired: false, stopping: false}}};
  const initial = command('dead updater initial ps', -100, ['ps', '--space', 'test', '--json']);
  const stopped = command('dead updater native stopped state', 2420, [], {argv: ['-o', 'stat=', '-p', '102'], stdout: 'T'});
  const held = command('dead updater held ps', 2500, ['ps', '--space', 'test', '--json'], {exit: 2, stderr: 'Manager preserving'});
  const recovered = command('dead updater recovery ps 1', 2700, ['ps', '--space', 'test', '--json']);
  const status = command('autonomous Manager active', 2800, ['--input-type=module', '-e', 'installed status'], {stdout: JSON.stringify(recoveredStatus)});
  const update = command('upgrade under test', 3000, ['update', '--self']);
  const after = command('dead updater after ps', 3100, ['ps', '--space', 'test', '--json']);
  const e = {mode: 'dead-updater', space: 'test', sourceEntry, sourceVersion: '0.165.1', sourceEntrySha256: 'a'.repeat(64), producer: {pid: 102, start: 'updater-birth', argv: [sourceEntry, 'update', '--self'], stdout: 'Saving update recovery snapshot', stderr: '', pausedAt: base, signal: 'SIGKILL', exit: null}, stoppedProcess: stopped, killRequestedAt: base + 2590, heldObservedAt: base + 2400, killedAt: base + 2600, recoveredAt: base + 2900, prepared, before, recovered: structuredClone(before), heldPs: held, recoveredPs: recovered, recoveredStatus, update, selectedVersion: '0.165.2', after: {version: '0.165.2', update: {restartEvidence: {prepared: false}}, managers: [{space: 'test', state: 'answering'}]}, recovery: null, observations: [{label: 'live owner still prepared', value: {update: {restartEvidence: prepared}}}, {label: 'autonomous daemon recovery', value: {update: {restartEvidence: {prepared: false}}}}]};
  const report = {source: '0.165.1', candidateSourceInvocation: {path: sourceEntry, sha256: 'a'.repeat(64)}, deadUpdater: e, calls: [initial, held, recovered, status, update, after, stopped]};
  const cell = {deadUpdater: true, platform: 'linux', targetVersion: '0.165.2'};
  function archive() { const {artifact, ...saved} = e; const bytes = Buffer.from(JSON.stringify(saved)); writeFileSync(join(output, 'evidence.json'), bytes, {mode: 0o600}); e.artifact = {name: 'evidence.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}; }
  archive(); return {report, cell, output, archive, close: () => rmSync(output, {recursive: true, force: true})};
}

test('complete synthetic dead-updater evidence carries the three required assertions', () => {
  const f = fixture(); try { assert.deepEqual(verifyDeadUpdaterEvidence(f), {passed: true, assertions: {'dead-updater-release': true, 'live-owner-held': true, 'next-update-alone': true}}); } finally { f.close(); }
});
for (const [name, alter] of [
  ['not actually stopped', f => { f.report.deadUpdater.stoppedProcess.stdout = 'S'; }],
  ['short live hold', f => { f.report.deadUpdater.heldObservedAt = f.report.deadUpdater.producer.pausedAt + 2300; }],
  ['live owner read succeeds', f => { f.report.deadUpdater.heldPs.exit = 0; }],
  ['manager incarnation replaced', f => { f.report.deadUpdater.recovered.manager.start = 'another-birth'; }],
  ['slow autonomous release', f => { f.report.deadUpdater.recoveredAt = f.report.deadUpdater.killedAt + 15001; }],
  ['missing public recovery call', f => { f.report.calls.splice(2, 1); }],
  ['status not active', f => { const e = f.report.deadUpdater; e.recoveredStatus.data.stopImpact.maintenance = 'preserving'; f.report.calls[3].stdout = JSON.stringify(e.recoveredStatus); }],
  ['unrecorded repair', f => { f.report.calls.push({...f.report.calls[2], label: 'operator resume', argv: ['manager', 'resume']}); }],
  ['failed next update', f => { f.report.deadUpdater.update.exit = 1; }],
  ['foreign installed source', f => { f.report.candidateSourceInvocation.sha256 = 'b'.repeat(64); }],
  ['prepared after update', f => { f.report.deadUpdater.after.update.restartEvidence.prepared = true; }],
]) test(`rejects ${name}`, () => { const f = fixture(); try { alter(f); f.archive(); assert.throws(() => verifyDeadUpdaterEvidence(f)); } finally { f.close(); } });
test('rejects changed artifact bytes', () => { const f = fixture(); try { writeFileSync(join(f.output, 'evidence.json'), '{}'); assert.throws(() => verifyDeadUpdaterEvidence(f)); } finally { f.close(); } });
