import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    assert(report.checks.some(check => check.name === (route === 'old-manager' ? 'old Manager exclusion leaves no recovery obligation' : `${route} home has no recovery obligation`) && check.passed === true), `${route}: recovery obligation check missing`);
    assert(stale.stdout.startsWith(`cotal-ai ${report.target.version}\n`) && !stale.stdout.includes('update --self'), `${route}: wrong stale-home version or remedy`);
    const inventory = (output, version) => ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
    assert(inventory(stale.stdout, report.old.version), `${route}: stale home must carry every old built-in`);
    const updatedHome = calls.find(call => call.home === 'A' && call.label === 'updated home version');
    assert(inventory(updatedHome.stdout, report.target.version) && !updatedHome.stdout.includes('Reconciliation pending'), `${route}: updated A home is not reconciled`);
    if (route !== 'old-manager') {
      const launch = calls.find(call => call.home === 'B' && call.label === (route === 'up' ? 'ordinary next up' : 'ordinary next agent launch'));
      assert(launch?.home === 'B' && launch.code === 0 && launch.signal === null, `${route}: ordinary B command did not complete`);
      const current = calls.find(call => call.home === 'B' && call.label === 'home version after ordinary command');
      assert(current?.code === 0 && inventory(current.stdout, report.target.version) && !current.stdout.includes('Reconciliation pending'), `${route}: home remains pending or skewed`);
    } else {
      const refusal = calls.find(call => call.home === 'B' && call.label === 'old Manager exclusion');
      assert(refusal && refusal.code !== 0 && `${refusal.stdout}${refusal.stderr}`.includes('LIFECYCLE_BLOCKED'), 'old Manager must block automatic migration');
      assert(calls.some(call => call.home === 'B' && call.label === 'old Manager remains answering' && call.code === 0), 'old Manager must remain answering');
      for (const name of ['older Manager home inventory remains unchanged', 'older Manager exclusion starts no fixture process'])
        assert(report.checks.some(check => check.name === name && check.passed === true), `missing ${name}`);
    }
  }
  assert(Number.isSafeInteger(report.seat?.pid) && report.seat.pid > 0 && report.seat.name === 'twohome-proof' && typeof report.seat.lifecycleUid === 'string', 'real no-sign-in seat join required');
  return { acceptance: true, routes: 3, checks: report.checks.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'usage: automatic-update-two-homes-evidence.mjs <result.json>');
  console.log(JSON.stringify(verifyTwoHomeUpgrade(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
}
