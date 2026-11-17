import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export function verifySelectedGraphs(graph, version) {
  assert(graph && typeof graph.logicalEntry === 'string' && graph.logicalEntry.startsWith('/'), 'selected root identity missing');
  assert.equal(graph.version, version, 'selected root version differs');
  const canonical = graph.canonical;
  assert(typeof canonical === 'string' && canonical.startsWith('/'), 'canonical graph root missing');
  const expected = join(canonical, 'installs', createHash('sha256').update(graph.logicalEntry).digest('hex'), 'sets', version, 'selection.json');
  assert.equal(graph.selectionPath, expected, 'selected root path differs');
  assert.deepEqual(graph.selection, { v: 1, entry: graph.logicalEntry, version, root: join(dirname(expected), 'cotal') }, 'selected root record differs');
  assert.equal(graph.selectedRoot, graph.selection.root, 'selected root missing');
  const validRows = rows => Array.isArray(rows) && rows.every(row => Array.isArray(row) && typeof row[0] === 'string' && ['file', 'link', 'directory'].includes(row[1]) && (row[1] === 'directory' || typeof row[2] === 'string'));
  const hasManifest = rows => rows.some(row => row[0] === 'extensions/extensions.json' && row[1] === 'file');
  assert(validRows(graph.selected) && hasManifest(graph.selected), 'selected graph missing');
  assert(Array.isArray(graph.old) && graph.old.length > 0 && graph.old.some(row => row.path === canonical) && graph.old.some(row => row.path === graph.oldRoot), 'old graph checks missing');
  for (const row of graph.old) {
    assert(row.path !== graph.selectedRoot && validRows(row.before) && validRows(row.after), 'old graph receipt missing or aliases selected root');
    if (row.path === graph.oldRoot) assert(hasManifest(row.before), 'old selected graph manifest missing');
    assert.deepEqual(row.after, row.before, 'old graph bytes or links changed');
  }
}

/** Fail closed on incomplete two-home evidence, including unreachable later routes. */
export function verifyTwoHomeUpgrade(report, { platform, hosted = false } = {}) {
  assert(['linux', 'darwin'].includes(report?.platform) && ['x64', 'arm64'].includes(report?.arch), 'native POSIX platform and architecture required');
  if (platform !== undefined) assert.equal(report.platform, platform, 'two-home evidence native platform differs from coordinate');
  if (hosted) assert.equal(report.environment?.hostedDisposable, true, 'two-home release evidence requires a disposable hosted runner');
  assert(report?.acceptance === true && report.cleanup === 'both owned stacks stopped', 'two-home workflow must finish with confirmed cleanup');
  assert(Array.isArray(report.checks) && report.checks.length >= 60 && report.checks.every(check => check.passed === true), 'all two-home checks must be present and passing');
  assert(report.old?.version && report.target?.version && report.old.version !== report.target.version, 'distinct old and target releases required');
  assert.equal(new Set(report.checks.map(check => check.name)).size, report.checks.length, 'duplicate two-home assertion');
  const identities = report.calls.map(call => `${call.route}/${call.home}/${call.label}`);
  assert.equal(new Set(identities).size, identities.length, 'duplicate two-home command receipt');
  for (const route of ['up', 'launch', 'old-manager']) {
    const calls = report.calls.filter(call => call.route === route);
    for (const [home, label] of [['A', 'install old closure'], ['A', route === 'old-manager' ? 'old Manager candidate install setup' : 'self update shared installation'], ['A', 'updated home version'], ['B', 'stale home version before command'], ['B', 'home status after command'], ['B', 'final owned stack down']])
      assert(calls.some(call => call.home === home && call.label === label && call.code === 0 && call.signal === null), `${route}/${home}: missing successful ${label}`);
    const stale = calls.find(call => call.home === 'B' && call.label === 'stale home version before command');
    assert(report.checks.some(check => check.name === `${route} home has no recovery obligation` && check.passed === true), `${route}: recovery obligation check missing`);
    assert(stale.stdout.startsWith(`cotal-ai ${report.target.version}\n`) && !stale.stdout.includes('update --self'), `${route}: wrong stale-home version or remedy`);
    const inventory = (output, version) => ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
    assert(inventory(stale.stdout, report.old.version), `${route}: stale home must carry every old built-in`);
    const updatedHome = calls.find(call => call.home === 'A' && call.label === 'updated home version');
    assert(inventory(updatedHome.stdout, report.target.version) && !updatedHome.stdout.includes('Reconciliation pending'), `${route}: updated A home is not reconciled`);
    verifySelectedGraphs(report.graphs?.[route], report.target.version);
    assert.equal(report[`${route}ManifestSha256`], report.graphs[route].selected.find(row => row[0] === 'extensions/extensions.json')[2], 'selected manifest hash differs');
    for (const name of [`${route} target selected root is isolated`, `${route} old graphs byte and link unchanged`]) assert(report.checks.some(check => check.name === name && check.passed === true), `missing ${name}`);
    {
      const launch = calls.find(call => call.home === 'B' && call.label === (route === 'up' ? 'ordinary next up' : route === 'launch' ? 'ordinary next agent launch' : 'ordinary old Manager agent launch'));
      assert(launch?.home === 'B' && launch.code === 0 && launch.signal === null, `${route}: ordinary B command did not complete`);
      const current = calls.find(call => call.home === 'B' && call.label === 'home version after ordinary command');
      assert(current?.code === 0 && inventory(current.stdout, report.target.version) && !current.stdout.includes('Reconciliation pending'), `${route}: home remains pending or skewed`);
    }
    if (route === 'old-manager') {
      assert(calls.some(call => call.home === 'B' && call.label === 'old Manager remains answering' && call.code === 0), 'old Manager must remain answering');
      for (const name of ['old-manager starts exact old Manager', 'old-manager real old fixture joined', 'old-manager version PID and birth unchanged'])
        assert(report.checks.some(check => check.name === name && check.passed === true), `missing ${name}`);
      const identity = report.managers?.[route];
      assert(identity?.before?.version === report.old.version && Number.isSafeInteger(identity.before.pid) && identity.before.pid > 0 && typeof identity.before.birth === 'string' && identity.before.birth.length > 0, 'old Manager identity missing');
      assert.deepEqual(identity.after, identity.before, 'old Manager identity changed');
      for (const [label, key] of [['old Manager served identity before', 'before'], ['old Manager served identity after', 'after']]) {
        const receipt = calls.find(call => call.home === 'B' && call.label === label);
        assert(receipt?.code === 0 && receipt.signal === null, 'served Manager probe missing');
        const served = JSON.parse(receipt.stdout);
        assert.equal(served.version, identity[key].version, 'served Manager version differs');
        assert.equal(served.instanceId, identity[key].instanceId, 'served Manager instance differs');
      }
      const launch = calls.find(call => call.label === 'ordinary old Manager agent launch');
      assert.equal(launch.args[launch.args.indexOf('--on') + 1], identity.before.instanceId, 'old Manager launch not pinned');
      assert(Number.isSafeInteger(report.oldManagerSeat?.pid) && report.oldManagerSeat.pid > 0 && report.oldManagerSeat.name === 'twohome-proof' && typeof report.oldManagerSeat.lifecycleUid === 'string', 'old Manager fixture join missing');
    }
  }
  assert(Number.isSafeInteger(report.seat?.pid) && report.seat.pid > 0 && report.seat.name === 'twohome-proof' && typeof report.seat.lifecycleUid === 'string', 'real no-sign-in seat join required');
  return { acceptance: true, routes: 3, checks: report.checks.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'usage: automatic-update-two-homes-evidence.mjs <result.json>');
  console.log(JSON.stringify(verifyTwoHomeUpgrade(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
}
