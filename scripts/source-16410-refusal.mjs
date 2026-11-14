import assert from 'node:assert/strict';

const linux = 'Request refused\n  the updated daemon did not restore its hosted Managers before the deadline\n  Outcome: refused\n  Code:    LIFECYCLE_BLOCKED\n\nNext\n  read `cotal daemon status` and the recorded daemon user service\n';
const windows = 'Outcome unconfirmed\n  Windows daemon restart failed during waiting for a fresh daemon to answer (up to 60s): replacement version or protocol did not match; ownership is ambiguous; the task was not enabled (the daemon lifetime is still held; uninstall retained its source and receipt); the generation fence, source and receipt were retained\n  Outcome: unknown\n  Code:    OPERATION_UNKNOWN\n\nNext\n  inspect `cotal daemon status` and the recorded task in Task Scheduler, then run setup again. Do not clear a restart fence through a replacement connection\n';

// Measured in run43619555017, not inferred from a different platform's error.
export const source16410Refusals = Object.freeze([
  ...['npm','installer'].map(layout => Object.freeze({name:'source-0.164.10-linux-postlude-lifecycle-blocked',platform:'linux',layout,exit:2,signal:null,timeout:false,trailer:linux})),
  ...['npm','installer'].map(layout => Object.freeze({name:'source-0.164.10-darwin-postlude-command-deadline',platform:'darwin',layout,exit:null,signal:'SIGTERM',timeout:true,deadlineMs:180000,trailer:null})),
  // Also measured in the paired Darwin original at Ainstalled (exit 2, no signal or timeout).
  ...['npm','installer'].map(layout => Object.freeze({name:'source-0.164.10-darwin-postlude-lifecycle-blocked',platform:'darwin',layout,exit:2,signal:null,timeout:false,trailer:linux})),
  Object.freeze({name:'source-0.164.10-win32-postlude-operation-unknown',platform:'win32',layout:'npm',exit:3,signal:null,timeout:false,trailer:windows}),
]);
const normalize = text => text.replaceAll('\r\n','\n');

/** Match the measured terminal failure, never variable reconciliation progress as a wildcard error. */
export function matchSource16410Refusal({platform, layout, sourceVersion, targetVersion, update}, contracts = source16410Refusals) {
  assert.equal(sourceVersion, '0.164.10');
  const matches = contracts.filter(row => row.platform === platform && row.layout === layout
    && row.exit === update.exit && (row.signal ?? null) === update.signal
    && (row.timeout ?? false) === update.timeout);
  assert.equal(matches.length, 1, 'measured source-0.164.10 refusal contract missing or duplicated');
  const contract = matches[0];
  assert.equal(update.exit, contract.exit);
  assert.equal(update.signal, contract.signal ?? null);
  assert.equal(update.timeout, contract.timeout ?? false);
  const stdout = normalize(update.stdout), stderr = normalize(update.stderr);
  if (Object.hasOwn(contract,'stdout')) {
    assert.equal(stdout, normalize(contract.stdout));
    assert.equal(stderr, normalize(contract.stderr));
  } else {
    assert.match(targetVersion, /^\d+\.\d+\.\d+$/);
    const completed = `✓ cotal-ai@${targetVersion} installed globally and reconciled\n`;
    assert.equal(stdout.split(completed).length, 2, 'target reconciliation completion must occur once');
    assert(stdout.includes('this 0.164.10 process remains loaded until the verified global copy takes over'), 'original loaded source identity missing');
    assert(stdout.includes(`machine daemon: waiting up to 120s for Cotal ${targetVersion} and its hosted Managers before the continuity check`), 'measured reconciliation stage missing');
    assert(!/Request refused|Outcome unconfirmed/.test(stdout), 'unexpected terminal failure in stdout');
    if (contract.trailer) {
      const at = stderr.indexOf(contract.trailer);
      assert(at >= 0 && stderr.slice(at) === contract.trailer, 'changed source-0.164.10 terminal refusal');
      assert(!/Request refused|Outcome unconfirmed|\bCode:\s/.test(stderr.slice(0,at)), 'additional failure before measured refusal');
    } else {
      assert.equal(stdout.slice(stdout.indexOf(completed) + completed.length), '', 'unexpected output after reconciled timeout stage');
      assert(!/Request refused|Outcome unconfirmed|\bCode:\s/.test(stderr), 'unmeasured failure before command deadline');
      assert(Number.isSafeInteger(update.elapsedMs) && update.elapsedMs >= contract.deadlineMs && update.elapsedMs <= contract.deadlineMs + 1000, 'timeout is not the measured 180s command boundary');
    }
  }
  return {name: contract.name, issue:'https://github.com/Cotal-AI/Cotal/issues/6842', passed:true, rawExit:update.exit, rawSignal:update.signal, rawTimeout:update.timeout};
}
