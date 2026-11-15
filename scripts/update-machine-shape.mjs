import assert from 'node:assert/strict';

/** Only disposable native runners may change install/service masks for a proof cell. */
export function machineShapeOptions(options, { disposable, platform }) {
  const installUmask = options['install-umask'];
  const serviceUmask = options['service-umask'];
  const pinnedNode = options['pinned-node'];
  if (installUmask !== undefined) assert(disposable && platform !== 'win32' && installUmask === '0002', 'install-umask requires disposable POSIX runner and 0002');
  if (serviceUmask !== undefined) assert(disposable && platform === 'linux' && options.state === 'daemon' && serviceUmask === '0002', 'service-umask requires disposable Linux daemon and 0002');
  if (pinnedNode !== undefined) {
    assert(disposable, 'pinned-node requires disposable runner');
    assert.match(pinnedNode, /^\d+\.\d+\.\d+$/, 'pinned-node requires an exact release');
  }
  const withoutRuntimeDir = options['without-runtime-dir'];
  if (withoutRuntimeDir !== undefined) assert(disposable && platform === 'linux' && withoutRuntimeDir === 'true' && ['daemon', 'fresh'].includes(options.state), 'without-runtime-dir requires disposable Linux daemon or fresh cell');
  return { installUmask, serviceUmask, pinnedNode, withoutRuntimeDir: withoutRuntimeDir === 'true' };
}

/** Apply the mask to the actual child, never the shared harness process. */
export function machineShapeCommand(file, argv, installUmask) {
  if (installUmask === undefined) return { file, argv };
  assert.equal(installUmask, '0002');
  return { file: '/bin/sh', argv: ['-c', 'umask 0002; exec "$@"', 'cotal-cell', file, ...argv] };
}

/** The daemon's independently observed lifetime must remain unchanged after a no-runtime refusal. */
export function runtimeDirectoryRefusal({ update, before, after, version }) {
  return update.exit === 1 && update.signal === null && update.timeout === false
    && /machine daemon is running and this session has no XDG_RUNTIME_DIR/.test(update.stdout + update.stderr)
    && before.state === 'ready' && after.state === 'ready' && before.version === version && after.version === version
    && before.pid === after.pid && before.startedAt === after.startedAt;
}

export function stagedSchedulerSucceeded(report, pair) {
  const evidence = report.stagedScheduler;
  assert.equal(evidence?.selectedBefore.updateRoute, 'staged');
  assert.equal(evidence.selectedBefore.selectedCliVersion, pair.targetVersion);
  assert.equal(evidence.selectedBefore.packageManagerRecordVersion, pair.sourceVersion);
  assert.equal(evidence.selected.selectedCliVersion, pair.followOnVersion);
  const calls = report.calls.filter(row => row.label === 'staged scheduler observation');
  assert(calls.length > 0, 'staged scheduler status call missing');
  const last = calls.at(-1);
  for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(last[key], evidence.status[key]);
  assert(last.exit === 0 && last.signal === null && last.timeout === false);
  const status = JSON.parse(last.stdout).result;
  assert.equal(status.state, 'ready');
  assert.equal(status.version, pair.followOnVersion);
  assert.match(evidence.attempt.result, new RegExp(`^(?:repaired and )?updated to ${pair.followOnVersion.replaceAll('.', '\\.')}(?:$|\\s)`));
  assert(evidence.eligibility.observations.some(row => row.exit === 0 && row.status?.version === pair.targetVersion && row.status.update?.automatic === true), 'staged scheduler eligibility missing');
  const first = report.calls.findIndex(row => row.label === 'upgrade under test');
  assert(first >= 0 && report.calls.slice(first + 1).every(row => !row.argv?.includes('--self')), 'manual updater cannot substitute for staged scheduler');
  return report.nextHop.followOn.update.scheduler === true && report.nextHop.followOn.update.exit === 0;
}
