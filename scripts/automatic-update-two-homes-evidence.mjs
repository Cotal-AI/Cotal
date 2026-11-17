import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fail closed on incomplete two-home evidence, including unreachable later routes. */
export function verifyTwoHomeUpgrade(report) {
  assert(report?.acceptance === true && report.cleanup === 'both owned stacks stopped', 'two-home workflow must finish with confirmed cleanup');
  assert(Array.isArray(report.checks) && report.checks.length >= 60 && report.checks.every(check => check.passed === true), 'all two-home checks must be present and passing');
  assert(report.old?.version && report.target?.version && report.old.version !== report.target.version, 'distinct old and target releases required');
  for (const route of ['up', 'launch', 'old-manager']) {
    const calls = report.calls.filter(call => call.route === route);
    for (const label of ['install old closure', route === 'old-manager' ? 'old Manager candidate install setup' : 'self update shared installation', 'updated home version', 'stale home version before command', 'final owned stack down'])
      assert(calls.some(call => call.label === label && call.code === 0 && call.signal === null), `${route}: missing successful ${label}`);
    const stale = calls.find(call => call.label === 'stale home version before command');
    assert(stale.stdout.startsWith(`cotal-ai ${report.target.version}\n`) && !stale.stdout.includes('update --self'), `${route}: wrong stale-home version or remedy`);
    const inventory = (output, version) => ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
    assert(inventory(stale.stdout, report.old.version), `${route}: stale home must carry every old built-in`);
    const updatedHome = calls.find(call => call.label === 'updated home version');
    assert(inventory(updatedHome.stdout, report.target.version) && !updatedHome.stdout.includes('Reconciliation pending'), `${route}: updated A home is not reconciled`);
    if (route !== 'old-manager') {
      const launch = calls.find(call => call.label === (route === 'up' ? 'ordinary next up' : 'ordinary next agent launch'));
      assert(launch?.code === 0 && launch.signal === null, `${route}: ordinary command did not complete`);
      const current = calls.find(call => call.label === 'home version after ordinary command');
      assert(current?.code === 0 && inventory(current.stdout, report.target.version) && !current.stdout.includes('Reconciliation pending'), `${route}: home remains pending or skewed`);
    } else {
      const refusal = calls.find(call => call.label === 'old Manager exclusion');
      assert(refusal && refusal.code !== 0 && `${refusal.stdout}${refusal.stderr}`.includes('LIFECYCLE_BLOCKED'), 'old Manager must block automatic migration');
      assert(calls.some(call => call.label === 'old Manager remains answering' && call.code === 0), 'old Manager must remain answering');
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
