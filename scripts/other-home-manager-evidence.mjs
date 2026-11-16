import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const modes = ['fresh-official-npm', 'selected-generation'];
const identity = value => value && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.start === 'string' && value.start.length > 0;
const same = (a, b) => identity(a) && identity(b) && a.pid === b.pid && a.start === b.start;
const ok = command => { assert(command); assert.equal(command.exit, 0); assert.equal(command.signal, null); assert.equal(command.timeout, false); };

/** Dedicated measurement catalog. Ordinary release and admission coordinates are unchanged. */
export function otherHomeManagerCells(plan) {
  assert.equal(plan.status, 'planned'); assert.equal(plan.phase, 'candidate');
  assert.match(plan.sourceSHA, /^[a-f0-9]{40}$/);
  assert.match(plan.targetVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const [major, minor, patch] = plan.targetVersion.split('.').map(Number);
  assert([major, minor, patch, patch + 2000].every(Number.isSafeInteger));
  return ['linux', 'darwin'].flatMap(platform => modes.map(mode => ({
    id: `${platform}-npm-other-home-${mode}`, platform, runner: platform === 'linux' ? 'ubuntu-24.04' : 'macos-15',
    mode, required: true, sourceSHA: plan.sourceSHA, officialVersion: '0.164.18',
    sourceVersion: plan.targetVersion, targetVersion: `${major}.${minor}.${patch + 1000}`, finalTargetVersion: `${major}.${minor}.${patch + 2000}`,
    requiredAssertions: ['official-origin', 'candidate-source-identity', 'two-public-self-hops', 'plain-update-exit-zero', 'same-native-manager', 'same-authenticated-seats', 'late-original-code', 'held-set-retained', 'no-cross-home-credentials', 'no-recovery', 'owned-cleanup'],
  })));
}

export function otherHomeMessages(version, instance, oldVersion) {
  return {
    self: `Updated to ${version}. Manager ${instance}, started from another Cotal home, keeps running ${oldVersion} until it is restarted.`,
    plain: `Manager ${instance}, started from another Cotal home, was left running.`,
  };
}

/** Reopen each native report's private archive. A report-only assertion cannot establish a pass. */
export function verifyOtherHomeManagerEvidence({ report, cell, output }) {
  assert.equal(report.mode, cell.mode); assert(modes.includes(report.mode));
  assert.equal(report.sourceSHA, cell.sourceSHA); assert.equal(report.platform, cell.platform);
  assert.match(report.evidence?.name ?? '', /^[A-Za-z0-9_.-]+\.json$/);
  const fd = openSync(join(output, report.evidence.name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), bytes = readFileSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size === report.evidence.bytes && stat.size < 16 * 1024 ** 2);
    assert.equal(sha(bytes), report.evidence.sha256);
    const { evidence, ...data } = report;
    assert.deepEqual(JSON.parse(bytes), data, 'archived other-home observation differs from report');
  } finally { closeSync(fd); }
  for (const command of report.calls ?? []) {
    const artifact = command.artifact;
    assert.match(artifact?.file ?? '', /^[A-Za-z0-9_.-]+\.json$/);
    const bytes = readFileSync(join(output, artifact.file));
    assert.equal(bytes.length, artifact.bytes); assert.equal(sha(bytes), artifact.sha256);
    const { artifact: ignored, ...observed } = command;
    assert.deepEqual(JSON.parse(bytes), observed, 'command archive differs from report');
  }
  assert.equal(report.official?.version, cell.officialVersion);
  assert.equal(report.official?.registry, 'https://registry.npmjs.org/');
  assert.equal(report.official?.installedVersion, cell.officialVersion);
  assert.equal(report.official?.dist?.integrity?.startsWith('sha512-'), true);
  assert.equal(report.candidate?.source, cell.sourceSHA);
  assert.equal(report.candidate?.sourceVersion, cell.sourceVersion);
  assert.equal(report.candidate?.targetVersion, cell.targetVersion);
  assert.equal(report.candidate?.followOnVersion, cell.finalTargetVersion);
  assert(report.candidateSourceInvocation?.argv?.includes('update'));
  assert.equal(report.origin?.selectedCliVersion, cell.sourceVersion);
  assert.equal(report.origin?.updateRoute, report.mode === 'selected-generation' ? 'staged' : 'in-place');
  if (report.mode === 'selected-generation') { ok(report.prime); assert.equal(report.origin.packageManagerRecordVersion, cell.officialVersion); }
  else { ok(report.candidateInstall); assert.equal(report.origin.packageManagerRecordVersion, cell.sourceVersion); }
  assert(report.homes?.manager && report.homes.updater && report.homes.manager !== report.homes.updater);
  assert.equal(report.updaterCredentialsBefore?.length, 0); assert.equal(report.updaterCredentialsAfter?.length, 0);
  const before = report.before;
  assert(identity(before?.manager) && before.manager.instanceId && before.version === cell.sourceVersion);
  const retained = (baseline, observed, label) => {
    assert(baseline?.length > 0 && Array.isArray(observed), `${label} baseline missing`);
    assert.equal(new Set(baseline.map(row => row.path)).size, baseline.length);
    assert.deepEqual(observed.map(row => ({ path: row.path, sha256: row.sha256 })), baseline, `${label} census differs from original`);
    assert(observed.every(row => row.observedSha256 === row.sha256), `${label} bytes changed`);
  };
  assert(before.work?.items?.length > 0, 'real original work required');
  assert.equal(report.hops?.length, 2);
  for (const [index, hop] of report.hops.entries()) {
    const version = index === 0 ? cell.targetVersion : cell.finalTargetVersion;
    assert.equal(hop.target, version); ok(hop.plain); ok(hop.self);
    for (const command of [hop.plain, hop.self]) {
      assert(report.calls.some(row => JSON.stringify(row) === JSON.stringify(command)), 'public action is not an archived invocation');
      assert(command.argv.includes(report.logicalUpdaterEntry));
      assert.equal(command.envhome?.COTAL_HOME, report.homes.updater);
    }
    const messages = otherHomeMessages(version, before.manager.instanceId, before.version);
    assert(hop.plain.stdout.includes(messages.plain)); assert(hop.self.stdout.includes(messages.self));
    assert(!/activation deferred|Cannot determine this Manager's original hosting command|stop this Manager through its original host/.test(hop.plain.stdout + hop.plain.stderr + hop.self.stdout + hop.self.stderr));
    assert(hop.plain.argv.includes('update') && !hop.plain.argv.includes('--self'));
    assert(hop.self.argv.includes('update') && hop.self.argv.includes('--self'));
    assert.equal(hop.selected.selectedCliVersion, version);
    const after = hop.after;
    assert(same(before.manager, after?.manager), 'other-home Manager native lifetime changed');
    assert.equal(after.manager.instanceId, before.manager.instanceId); assert.equal(after.version, before.version);
    for (const work of before.work.items) {
      const retained = after.work?.items?.find(row => row.id === work.id);
      assert(retained && retained.lifecycleUid === work.lifecycleUid, 'original seat changed');
    }
    retained(before.graph, after.graph, 'old program graph');
    retained(before.sets, after.sets, 'held connector set');
    assert.equal(after.console?.status, 200);
    assert(identity(after.lateReady) && after.lateReady.managerInstance === before.manager.instanceId);
    assert(after.lateWork?.items?.some(row => row.lifecycleUid === after.lateReady.lifecycleUid && row.name === after.lateReady.name));
    assert.equal(hop.recovery, null);
  }
  ok(report.finalCleanupProbe);
  assert(report.calls.some(row => JSON.stringify(row) === JSON.stringify(report.finalCleanupProbe)));
  assert(report.finalCleanupProbe.argv.includes('update') && !report.finalCleanupProbe.argv.includes('--self'));
  assert(report.finalCleanupProbe.stdout.includes(otherHomeMessages(cell.finalTargetVersion, before.manager.instanceId, before.version).plain));
  assert(same(before.manager, report.afterCleanup?.manager));
  retained(before.sets, report.afterCleanup.sets, 'cleanup held connector set');
  retained(before.graph, report.afterCleanup.graph, 'cleanup old program graph');
  assert.equal(report.cleanup?.passed, true); assert.equal(report.cleanup.remaining?.length, 0);
  assert.equal(report.status, 'collected');
  return { passed: true, assertions: Object.fromEntries(cell.requiredAssertions.map(name => [name, true])) };
}
