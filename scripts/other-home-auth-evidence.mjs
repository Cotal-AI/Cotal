import assert from 'node:assert/strict';

export const otherHomeNotice = e => `Manager pid ${e.before.pid}, instance unavailable in space ${JSON.stringify(e.space)} at ${JSON.stringify(e.project)} keeps running the version it loaded until it is restarted from its own home; its root is not registered in this home.`;
const clean = row => row?.exit === 0 && row.signal === null && row.timeout === false;
export function verifyOtherHomeAuthEvidence({ report, cell, requireCleanup = true }) {
  const e = report.otherHomeAuth;
  assert.equal(cell.otherHomeAuth, true);
  assert.equal(cell.platform, 'linux');
  assert.equal(report.environment?.nativeServiceRequested, true);
  assert.equal(e?.mode, 'second-private-home-static-auth');
  assert.notEqual(e.home, e.updaterHome);
  assert.equal(e.sourceVersion, cell.sourceVersion);
  assert.equal(e.before.loadedVersion, cell.sourceVersion);
  assert(Number.isSafeInteger(e.before.pid) && e.before.pid > 0);
  assert.equal(typeof e.before.birth, 'string'); assert(e.before.birth);
  assert.equal(typeof e.before.instanceId, 'string'); assert(e.before.instanceId);
  assert.equal(e.before.argv[1], e.installedRoot + '/dist/cotal.js');
  assert.equal(e.before.reportedVersion, cell.sourceVersion);
  assert.equal(e.before.argv[0], process.execPath);
  assert(e.before.argv.includes('supervise'));
  assert.equal(e.before.cwd, e.project);
  assert(e.before.graph.length > 0);
  assert.equal(e.descriptorBefore, false);
  assert.equal(e.before.root, e.project);
  assert.equal(e.before.loadedRoot, e.installedRoot);
  for (const path of ['package.json', 'dist/cotal-program.js']) assert(e.before.graph.some(row => row.path === path && /^[a-f0-9]{64}$/.test(row.sha256)));
  assert(e.before.graph.some(row => row.path.startsWith('node_modules/')));
  assert(!e.before.graph.some(row => row.path === 'dist/cotal.js'));
  assert.equal(e.before.connectorRoot, e.connectorRoot);
  assert(e.before.connectorGraph.some(row => row.path === 'extensions.json' && /^[a-f0-9]{64}$/.test(row.sha256)));
  assert(e.before.connectorGraph.some(row => row.path.startsWith('node_modules/')));
  assert.deepEqual(e.after, e.before, 'Manager native identity and complete loaded graph must survive');
  assert(e.authRead && clean(e.authRead));
  assert.deepEqual(JSON.parse(e.authRead.stdout), { refused: true, code: 'AUTH_REQUIRED', nativeCode: 'CREDENTIALS_MISSING' });
  const one = label => { const rows = report.calls.filter(row => row.label === label); assert.equal(rows.length, 1, label); return rows[0]; };
  const auth = one('other home original continuity read');
  for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(auth[key], e.authRead[key]);
  assert(auth.argv.at(-1).includes('readManagerContinuity'));
  assert.equal(auth.home, e.updaterHome);
  const update = one('upgrade under test'); assert(clean(update));
  assert.deepEqual(update.argv.slice(-2), ['update', '--self']);
  assert((update.stdout + update.stderr).split(/\r?\n/).includes(otherHomeNotice(e)));
  assert(Date.parse(auth.finishedAt) <= Date.parse(update.startedAt));
  const before = one('other home Manager before'), after = one('other home Manager after');
  assert(clean(before) && clean(after));
  assert.equal(typeof e.space, 'string'); assert(e.space);
  assert.equal(before.home, e.home); assert.equal(after.home, e.home);
  for (const row of [before, after]) {
    const result = JSON.parse(row.stdout).result;
    assert(result.managers.some(m => m.instanceId === e.before.instanceId && m.state === 'answered'));
  }
  assert(Date.parse(before.finishedAt) <= Date.parse(auth.startedAt));
  assert(Date.parse(after.startedAt) >= Date.parse(update.finishedAt));
  const versions = report.calls.filter(row => row.label === 'other home loaded version');
  assert.equal(versions.length, 2);
  for (const row of versions) {
    assert(clean(row)); assert.equal(row.home, e.home);
    const value = JSON.parse(row.stdout);
    assert.equal(value.instanceId, e.before.instanceId); assert.equal(value.version, cell.sourceVersion);
    assert(row.argv.at(-1).includes('managerStatus'));
  }
  assert(report.calls.some(row => row.label === 'native install' && clean(row)));
  if (requireCleanup) {
    const cleanup = one('other home cleanup'); assert(clean(cleanup));
    assert.equal(cleanup.home, e.home);
    assert.deepEqual(cleanup.argv.slice(-5), ['down', '--space', e.space, '--with-agents', '--yes']);
    assert(Date.parse(cleanup.startedAt) >= Date.parse(after.finishedAt));
    assert.equal(report.compositionCleanup, 'owned composition stopped before reporting');
  }
  return { 'other-home-cleanup': requireCleanup, 'other-home-auth-required': true, 'other-home-manager-preserved': true, 'other-home-loaded-graph-preserved': true, 'other-home-update-notice': true };
}
