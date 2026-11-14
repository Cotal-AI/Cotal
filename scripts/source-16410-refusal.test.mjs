import test from 'node:test';
import assert from 'node:assert/strict';
import {matchSource16410Refusal, source16410Refusals} from './source-16410-refusal.mjs';

// Deliberately invented fixture text, never a measured product transcript.
const contract = {name: 'synthetic-only', platform: 'linux', layout: 'npm', exit: 7, stdout: 'synthetic refusal\n', stderr: 'synthetic detail\n'};
const input = () => ({platform: 'linux', layout: 'npm', sourceVersion: '0.164.10', update: {exit: 7, signal: null, timeout: false, stdout: contract.stdout, stderr: contract.stderr}});
test('unmeasured platform or layout defaults refuse acceptance', () => {
  assert(Object.isFrozen(source16410Refusals));
  assert.throws(() => matchSource16410Refusal({...input(), platform: 'freebsd'}), /contract missing or duplicated/);
  assert.throws(() => matchSource16410Refusal({...input(), platform: 'win32', layout: 'installer'}), /contract missing or duplicated/);
});
test('injected synthetic contract requires exact streams and normalizes CRLF only', () => {
  assert.deepEqual(matchSource16410Refusal(input(), [contract]), {name: 'synthetic-only', issue: 'https://github.com/Cotal-AI/Cotal/issues/6842', passed: true, rawExit: 7, rawSignal: null, rawTimeout: false});
  const value = input();
  value.update.stdout = value.update.stdout.replaceAll('\n', '\r\n');
  value.update.stderr = value.update.stderr.replaceAll('\n', '\r\n');
  assert.equal(matchSource16410Refusal(value, [contract]).passed, true);
});
for (const [name, change] of [
  ['stdout', v => { v.update.stdout += 'extra'; }],
  ['stderr', v => { v.update.stderr = ''; }],
  ['exit', v => { v.update.exit = 0; }],
  ['signal', v => { v.update.signal = 'SIGTERM'; }],
  ['timeout', v => { v.update.timeout = true; }],
  ['platform', v => { v.platform = 'darwin'; }],
  ['layout', v => { v.layout = 'standalone'; }],
  ['version', v => { v.sourceVersion = '0.164.11'; }],
]) test(`synthetic refusal rejects wrong ${name}`, () => {
  const value = input(); change(value);
  assert.throws(() => matchSource16410Refusal(value, [contract]));
});
// Generated structures exercise the measured contracts, not original native transcripts.
function measuredFixture(row) {
  return {platform: row.platform, layout: row.layout, sourceVersion: '0.164.10', targetVersion: '1.2.3', update: {
    exit: row.exit, signal: row.signal, timeout: row.timeout, elapsedMs: 180000,
    stdout: 'this 0.164.10 process remains loaded until the verified global copy takes over\n'
      + 'machine daemon: waiting up to 120s for Cotal 1.2.3 and its hosted Managers before the continuity check\n'
      + '✓ cotal-ai@1.2.3 installed globally and reconciled\n',
    stderr: row.trailer ?? '',
  }};
}
for (const row of source16410Refusals) {
  test(`generated measured structure matches ${row.platform}/${row.layout}`, () => {
    const value = measuredFixture(row);
    assert.deepEqual(matchSource16410Refusal(value), {name: row.name, issue: 'https://github.com/Cotal-AI/Cotal/issues/6842', passed: true, rawExit: row.exit, rawSignal: row.signal, rawTimeout: row.timeout});
    for (const change of [
      v => { v.targetVersion = '1.2.4'; },
      v => { delete v.targetVersion; },
      v => { v.update.stdout = v.update.stdout.replace('this 0.164.10 process remains loaded until the verified global copy takes over', 'missing'); },
      v => { v.update.stdout = v.update.stdout.replace('✓ cotal-ai@1.2.3 installed globally and reconciled\n', ''); },
      v => { v.update.stdout += '✓ cotal-ai@1.2.3 installed globally and reconciled\n'; },
      v => { v.update.stdout = v.update.stdout.replace('waiting up to 120s', 'waiting up to 121s'); },
      v => { v.update.stderr = 'Request refused\n' + v.update.stderr; },
      v => { v.update.stdout = 'Outcome unconfirmed\n' + v.update.stdout; },
      v => { v.update.exit = 0; },
      v => { v.update.signal = 'SIGKILL'; },
      v => { v.update.timeout = !v.update.timeout; },
    ]) { const changed = structuredClone(value); change(changed); assert.throws(() => matchSource16410Refusal(changed)); }
    if (row.trailer) {
      for (const stderr of [row.trailer + 'extra', row.trailer.replace('Next', 'Changed'), '']) {
        assert.throws(() => matchSource16410Refusal({...value, update: {...value.update, stderr}}));
      }
    } else {
      for (const elapsedMs of [179999, 181001, 180000.5, undefined]) {
        assert.throws(() => matchSource16410Refusal({...value, update: {...value.update, elapsedMs}}));
      }
      assert.equal(matchSource16410Refusal({...value, update: {...value.update, elapsedMs: 181000}}).passed, true);
      assert.throws(() => matchSource16410Refusal({...value, update: {...value.update, stdout: value.update.stdout + 'extra'}}));
    }
  });
}
test('duplicate injected contracts fail closed', () => {
  assert.throws(() => matchSource16410Refusal(input(), [contract, {...contract}]), /duplicated/);
});
