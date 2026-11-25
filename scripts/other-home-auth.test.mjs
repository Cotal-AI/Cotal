import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { otherHomeNotice, verifyOtherHomeAuthEvidence } from './other-home-auth-evidence.mjs';
import { planRelease, verifyResults } from './upgrade-matrix-plan.mjs';
function fixture(nodePath = process.execPath) {
  const cell = { otherHomeAuth: true, platform: 'linux', sourceVersion: '0.166.3' };
  const home = '/private/b', project = home + '/project', installedRoot = '/private/prefix/lib/node_modules/cotal-ai';
  const before = { pid: 123, birth: '456', instanceId: 'instance', root: project, cwd: project, loadedRoot: installedRoot, reportedVersion: cell.sourceVersion, loadedVersion: cell.sourceVersion, argv: [nodePath, '--max-semi-space-size=1', installedRoot + '/dist/cotal.js', '--no-color', '__service-manager'], graph: ['package.json', 'dist/cotal-program.js', 'node_modules/core/index.js'].map(path => ({ path, sha256: 'a'.repeat(64) })) };
  const connectorRoot = '/private/b/extensions';
  Object.assign(before, { connectorRoot, connectorGraph: ['extensions.json', 'node_modules/connector/index.js'].map(path => ({ path, sha256: 'b'.repeat(64) })) });
  const e = { connectorRoot, mode: 'second-private-home-static-auth', space: 'other-home-proof', home, project, updaterHome: '/private/a', installedRoot, sourceVersion: cell.sourceVersion, nodePath, before, after: structuredClone(before), descriptorBefore: false };
  const command = (label, argv, home, n, stdout = '') => ({ label, argv, home, exit: 0, signal: null, timeout: false, stdout, stderr: '', startedAt: new Date(n * 1000).toISOString(), finishedAt: new Date(n * 1000 + 100).toISOString() });
  const auth = command('other home original continuity read', ['--input-type=module', '-e', 'readManagerContinuity'], e.updaterHome, 2, JSON.stringify({ refused: true, code: 'AUTH_REQUIRED', nativeCode: 'CREDENTIALS_MISSING' }));
  e.authRead = structuredClone(auth);
  const report = { otherHomeAuth: e, environment: { nativeServiceRequested: true }, compositionCleanup: 'owned composition stopped before reporting', calls: [command('native install', [], e.updaterHome, 0), command('other home Manager before', [], home, 1, JSON.stringify({result:{managers:[{instanceId:before.instanceId,state:'answered'}]}})), auth, command('upgrade under test', ['entry', 'update', '--self'], e.updaterHome, 3, otherHomeNotice(e)), command('other home Manager after', [], home, 4, JSON.stringify({result:{managers:[{instanceId:before.instanceId,state:'answered'}]}})), command('other home cleanup', ['entry', 'down', '--space', e.space, '--with-agents', '--yes'], home, 5)] };
  report.calls.push(...[1, 4].map(n => command('other home loaded version', ['--input-type=module', '-e', 'managerStatus'], home, n, JSON.stringify({ instanceId: before.instanceId, version: cell.sourceVersion }))));
  return { report, cell };
}
test('summary accepts the Node path recorded by a different runner', () => {
  const cellNodePath = '/opt/hostedtoolcache/node/24.22.2/x64/bin/node';
  const nodePath = cellNodePath === process.execPath ? '/opt/hostedtoolcache/node/24.22.3/x64/bin/node' : cellNodePath;
  assert(Object.values(verifyOtherHomeAuthEvidence(fixture(nodePath))).every(Boolean));
});
test('summary requires the recorded Node path to match Manager argv', () => {
  const input = fixture();
  input.report.otherHomeAuth.nodePath = `${process.execPath}.other`;
  assert.throws(() => verifyOtherHomeAuthEvidence(input), { code: 'ERR_ASSERTION' });
  delete input.report.otherHomeAuth.nodePath;
  assert.throws(() => verifyOtherHomeAuthEvidence(input), /recorded Node path missing/);
});
test('cell verification requires the recorded Node path to match the local executable', () => {
  const options = { requireCleanup: false, expectedNodePath: process.execPath };
  assert.equal(verifyOtherHomeAuthEvidence({ ...fixture(), ...options })['other-home-manager-preserved'], true);
  assert.throws(() => verifyOtherHomeAuthEvidence({ ...fixture(`${process.execPath}.other`), ...options }), { code: 'ERR_ASSERTION' });
});
test('strict other-home evidence accepts complete observations and rejects weakened identity, auth, graph, notice, timing or cleanup', () => {
  assert(Object.values(verifyOtherHomeAuthEvidence(fixture())).every(Boolean));
  const corruptions = [
    x => { x.report.otherHomeAuth.after.connectorGraph[0].sha256 = 'c'.repeat(64); },
    x => { x.report.otherHomeAuth.after.pid++; }, x => { x.report.otherHomeAuth.after.birth = 'new'; },
    x => { x.report.otherHomeAuth.after.instanceId = 'new'; }, x => { x.report.otherHomeAuth.after.argv.push('new'); },
    x => { x.report.otherHomeAuth.after.graph.pop(); }, x => { x.report.otherHomeAuth.after.loadedVersion = 'new'; },
    x => { x.report.otherHomeAuth.home = x.report.otherHomeAuth.updaterHome; }, x => { x.report.otherHomeAuth.descriptorBefore = true; },
    x => { x.report.calls[3].exit = 1; }, x => { x.report.calls[3].stdout = 'update complete'; },
    x => { x.report.calls[2].home = '/private/b'; }, x => { x.report.calls[2].stdout = '{}'; },
    x => { x.report.calls[4].startedAt = new Date(0).toISOString(); }, x => { x.report.calls.pop(); },
    x => { x.report.environment.nativeServiceRequested = false; }, x => { x.cell.platform = 'darwin'; },
  ];
  for (const corrupt of corruptions) { const input = fixture(); corrupt(input); assert.throws(() => verifyOtherHomeAuthEvidence(input)); }
});
test('both phases require exactly one Linux other-home candidate-next cell and every assertion', () => {
  for (const phase of ['candidate', 'published']) {
    const plan = planRelease({ inputs: { phase, source_sha: 'a'.repeat(40), target_version: '0.166.3', profile: 'bounded' } }, { eventName: 'workflow_dispatch', sourceVersion: '0.166.2' });
    const rows = plan.cells.filter(c => c.otherHomeAuth); assert.equal(rows.length, 1);
    const cell = rows[0]; assert.equal(cell.id, 'linux-npm-candidate-next-other-home-auth'); assert.equal(cell.sourceVersion, '0.166.3'); assert.equal(cell.targetVersion, '0.166.1003');
    const good = plan.cells.filter(c => c.required).map(c => ({ id: c.id, status: 'passed', assertions: Object.fromEntries(c.requiredAssertions.map(a => [a, true])) }));
    assert.equal(verifyResults(plan.cells, good).acceptance, true);
    for (const key of cell.requiredAssertions) { const bad = structuredClone(good); delete bad.find(r => r.id === cell.id).assertions[key]; assert.equal(verifyResults(plan.cells, bad).acceptance, false); }
  }
});
test('workflow routes other-home through paired artifacts, native service and independent strict grader without sign-in fixture build', () => {
  const source = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  for (const text of ['matrix.otherHomeAuth == true', 'cell.otherHomeAuth === true', "options['other-home-auth'] = 'true'", 'prepareOtherHomeAuth', 'verifyOtherHomeAuthEvidence', '...otherHomeAssertions', "['candidate-next-other-home-auth', 'candidate-next-dead-updater'"]) assert(source.includes(text), text);
  const build = source.split('- name: Build only the signed-in participant fixture dependencies')[1].split('- name: Run one real product upgrade coordinate')[0]; assert(!build.includes('otherHomeAuth'));
});
