import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { otherHomeManagerCells, otherHomeMessages, verifyOtherHomeManagerEvidence } from './other-home-manager-evidence.mjs';

const plan = { status: 'planned', phase: 'candidate', sourceSHA: 'a'.repeat(40), targetVersion: '0.165.0' };
test('two real origin layouts on supported staged platforms, deterministic candidate hops', () => {
  const cells = otherHomeManagerCells(plan);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(cell => cell.platform), ['linux', 'linux', 'darwin', 'darwin']);
  assert(cells.every(cell => cell.officialVersion === '0.164.18' && cell.targetVersion === '0.165.1000' && cell.finalTargetVersion === '0.165.2000'));
  for (const changed of [{ phase: 'published' }, { sourceSHA: 'moving-main' }, { targetVersion: '0.165.0-preview' }]) assert.throws(() => otherHomeManagerCells({ ...plan, ...changed }));
});

test('wording is the approved plain sentence, never activation-deferred terminology', () => {
  assert.deepEqual(otherHomeMessages('0.165.1000', 'manager-one', '0.165.0'), {
    self: 'Updated to 0.165.1000. Manager manager-one, started from another Cotal home, keeps running 0.165.0 until it is restarted.',
    plain: 'Manager manager-one, started from another Cotal home, was left running.',
  });
});

// Synthetic archive checks only. No Manager, updater or native platform is exercised here.
function archive(mode = 'fresh-official-npm') {
  const output = mkdtempSync(join(tmpdir(), 'other-home-grade-'));
  const cell = otherHomeManagerCells(plan).find(cell => cell.platform === 'linux' && cell.mode === mode);
  const manager = { pid: 40, start: 'native-start', instanceId: 'manager-one' };
  const observation = () => ({ manager: { ...manager }, version: cell.sourceVersion, work: { items: [{ id: 'original', lifecycleUid: 'original-life' }] }, graph: [{ path: 'old/program.js', sha256: 'hash', observedSha256: 'hash' }], sets: [{ path: 'old/set.js', sha256: 'bytes', observedSha256: 'bytes' }], console: { status: 200 }, lateReady: { pid: 41, start: 'seat-native', name: 'late', lifecycleUid: 'late-life', managerInstance: manager.instanceId }, lateWork: { items: [{ name: 'late', lifecycleUid: 'late-life' }] } });
  const call = (self, version) => ({ argv: ['/installed/cotal.js', 'update', ...(self ? ['--self'] : [])], exit: 0, signal: null, timeout: false, stdout: otherHomeMessages(version, manager.instanceId, cell.sourceVersion)[self ? 'self' : 'plain'], stderr: '', envhome: { COTAL_HOME: '/private/B' } });
  const report = { mode, sourceSHA: plan.sourceSHA, platform: 'linux', official: { version: cell.officialVersion, installedVersion: cell.officialVersion, registry: 'https://registry.npmjs.org/', dist: { integrity: 'sha512-declared' } }, candidate: { source: plan.sourceSHA, sourceVersion: cell.sourceVersion, targetVersion: cell.targetVersion, followOnVersion: cell.finalTargetVersion }, candidateSourceInvocation: { argv: ['/installed/cotal.js', 'update', '--self'] }, origin: { selectedCliVersion: cell.sourceVersion, packageManagerRecordVersion: mode === 'selected-generation' ? cell.officialVersion : cell.sourceVersion, updateRoute: mode === 'selected-generation' ? 'staged' : 'in-place' }, prime: call(true, cell.sourceVersion), candidateInstall: call(false, cell.sourceVersion), homes: { manager: '/private/A', updater: '/private/B' }, updaterCredentialsBefore: [], updaterCredentialsAfter: [], before: observation(), hops: [cell.targetVersion, cell.finalTargetVersion].map(target => ({ target, plain: call(false, target), self: call(true, target), selected: { selectedCliVersion: target }, after: observation(), recovery: null })), finalCleanupProbe: call(false, cell.finalTargetVersion), afterCleanup: observation(), cleanup: { passed: true, remaining: [] }, status: 'collected' };
  report.before.graph = report.before.graph.map(({ path, sha256 }) => ({ path, sha256 }));
  report.before.sets = report.before.sets.map(({ path, sha256 }) => ({ path, sha256 }));
  report.logicalUpdaterEntry = '/installed/cotal.js';
  report.calls = [...report.hops.flatMap(hop => [hop.plain, hop.self]), report.finalCleanupProbe];
  function seal() {
    for (const [index, command] of report.calls.entries()) {
      const { artifact, ...data } = command; const bytes = Buffer.from(JSON.stringify(data)); const file = `command-${index}.json`;
      writeFileSync(join(output, file), bytes, { mode: 0o600 }); command.artifact = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const { evidence, ...data } = report; const bytes = Buffer.from(JSON.stringify(data)); writeFileSync(join(output, 'observations.json'), bytes, { mode: 0o600 }); report.evidence = { name: 'observations.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  seal();
  return { report, cell, seal, run: () => verifyOtherHomeManagerEvidence({ report, cell, output }), close: () => rmSync(output, { recursive: true, force: true }) };
}

test('strict archive grader accepts both declared origins, not a report-only alteration', () => {
  for (const mode of ['fresh-official-npm', 'selected-generation']) { const f = archive(mode); try { assert.equal(f.run().passed, true); f.report.hops[0].self.stdout = 'report-only green'; assert.throws(f.run, /differs/); } finally { f.close(); } }
});

test('negative boundaries reject changed native holder, old bytes, fake message, missing work, credential copy, cleanup error or veto', () => {
  const edits = [
    report => { report.hops[0].after.manager.start = 'reused'; },
    report => { report.hops[1].after.graph[0].sha256 = 'new'; report.hops[1].after.graph[0].observedSha256 = 'new'; },
    report => { report.hops[1].after.graph = []; },
    report => { report.hops[1].after.graph[0].observedSha256 = null; },
    report => { report.hops[0].after.sets[0].observedSha256 = 'changed'; },
    report => { report.hops[0].self.stdout = 'activation deferred: software update finished'; },
    report => { report.hops[0].after.work.items = []; },
    report => { report.hops[0].after.lateReady.managerInstance = 'different-manager'; },
    report => { report.updaterCredentialsAfter.push('copied-token'); },
    report => { report.cleanup.remaining.push({ pid: 99, start: 'live' }); },
    report => { report.hops[0].self.exit = 1; },
    report => { report.finalCleanupProbe.exit = 1; },
    report => { report.afterCleanup.sets[0].observedSha256 = null; },
  ];
  for (const mutate of edits) { const f = archive(); try { mutate(f.report); f.seal(); assert.throws(f.run); } finally { f.close(); } }
});
