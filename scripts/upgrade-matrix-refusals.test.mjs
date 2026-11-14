import assert from 'node:assert/strict';
import {knownRefusals, knownRefusalFor, matchKnownRefusal} from './upgrade-matrix-refusals.mjs';
import test from 'node:test';

// Small exact transcript samples from the public refusals:
// https://github.com/Cotal-AI/Cotal/issues/6802
// https://github.com/Cotal-AI/Cotal/issues/6785
// https://github.com/Cotal-AI/Cotal/issues/6747
const transcripts = [
  ['  upgrade-proof: reading local Manager sdz0a0f5fxj1ct3pzd181eaqvdozem1 (pid 2699)\n' +
   '! legacy manager custody: PTY continuity is impossible; this update is not a hot update\n' +
   '  Manager sdz0a0f5fxj1ct3pzd181eaqvdozem1 in space "upgrade-proof": 1 seats\n' +
   '  upgrade-proof-worker: drain-only\n' +
   "  Cannot determine this Manager's original hosting command. Obtain its exact stop and start commands before stopping it; do not infer a service instance from its Manager identity.\n" +
   '  Next: stop this Manager through its original host, ending any seats listed above; run `cotal update --self`, then restart through that host with the original start command. This is a cold update, including for a Manager with 0 seats.\n', ''],
  ['  update-participant-a-1794633286189: a manager for this mesh runs on this machine; reading its custody\n',
   '✗ running manager continuity check: ✗ signed in, but the exchange for actor "cli" (view "manager-caller") was refused: manager-caller selection found no manager candidate for owner u_wdhhojionrz2rav4mearesx4ou\n'],
  ['', 'Outcome unconfirmed\n  invalid update snapshot directory\n  Outcome: unknown\n  Code:    OPERATION_UNKNOWN\n'],
];
// Explicit synthetic safety evidence, not a claim that historical cleanup succeeded.
function fixture(index) {
  const entry = knownRefusals[index];
  const cell = {id: entry.id, phase: 'candidate', sourceVersion: '0.164.6'};
  const update = {exit: index === 2 ? 3 : 1, signal: null, timeout: false,
    stdout: transcripts[index][0], stderr: transcripts[index][1]};
  const report = {source: cell.sourceVersion, sourceRequested: cell.sourceVersion, result: 'failed', update,
    assertions: [...entry.failedAssertions.map(name => ({name, passed: false,
      ...(name === 'upgrade exits successfully' ? {observed: structuredClone(update)} : {})})),
    ...entry.requiredAssertions.map(name => ({name, passed: true}))]};
  report.cleanupSafety = {passed: true};
  if (index === 1) report.participant = {remote: true, localManagerStarted: false,
    space: 'update-participant-a-1794633286189', owner: 'u_wdhhojionrz2rav4mearesx4ou'};
  if (index === 0) {
    report.managerHost = {space: 'upgrade-proof', mode: 'standalone'};
    report.agentHost = 'standalone';
  }
  report.extensionsBefore = [{pkg: '@cotal-ai/core', version: cell.sourceVersion}];
  report.extensionsAfter = structuredClone(report.extensionsBefore);
  report.assertions.find(a => a.name === 'CLI version is target').observed = cell.sourceVersion;
  return {cell, report};
}
function changeCommand(report, key, value) {
  report.update[key] = value;
  report.assertions.find(a => a.name === 'upgrade exits successfully').observed[key] = value;
}
for (let i = 0; i < knownRefusals.length; i++) {
  test(`${knownRefusals[i].id}: exact refusal remains raw red`, () => {
    const {cell, report} = fixture(i), before = JSON.stringify(report);
    assert.equal(matchKnownRefusal(cell, report), knownRefusals[i]);
    assert.equal(JSON.stringify(report), before);
    assert.equal(matchKnownRefusal({...cell, phase: 'published'}, report), knownRefusals[i]);
    assert.throws(() => matchKnownRefusal({...cell, phase: 'published'}, {...report, result: 'passed'}), /remove the known-refusal entry/);
    for (const field of ['stdout', 'stderr']) changeCommand(report, field, report.update[field].replaceAll('\n', '\r\n'));
    assert.equal(matchKnownRefusal(cell, report), knownRefusals[i]);
  });
  test(`${knownRefusals[i].id}: changed and unsafe evidence rejected`, () => {
    const rejects = mutate => {
      const {cell, report} = fixture(i);
      mutate(report, cell);
      assert.throws(() => matchKnownRefusal(cell, report));
    };
    rejects(r => {r.result = 'passed';});
    rejects(r => {r.result = 'unknown';});
    rejects(r => {r.source = '0.164.5';});
    rejects(r => {delete r.cleanupSafety;});
    rejects(r => {r.cleanupSafety.passed = false;});
    rejects(r => {r.cleanupSafety.passed = 'true';});
    rejects(r => {r.error = 'unexpected failure';});
    rejects(r => {r.cleanupFailure = 'down failed';});
    if (i === 1) {
      rejects(r => {delete r.participant;});
      rejects(r => {r.participant.remote = false;});
      rejects(r => {r.participant.localManagerStarted = true;});
      rejects(r => {delete r.participant.space;});
      rejects(r => {delete r.participant.owner;});
      rejects(r => {r.participant.owner = 'u_other';});
      rejects(r => {r.participant.space = 'other';});
    }
    if (i === 0) {
      rejects(r => {delete r.managerHost;});
      rejects(r => {delete r.managerHost.space;});
      rejects(r => {delete r.managerHost.mode;});
      rejects(r => {delete r.agentHost;});
      rejects(r => {r.agentHost = 'daemon';});
      rejects(r => {r.managerHost.mode = 'daemon-hosted';});
      rejects(r => {r.managerHost.space = 'other';});
    }
    rejects(r => {r.extensionsAfter[0].version = '0.164.7';});
    rejects(r => {r.extensionsBefore = null;});
    rejects(r => {r.assertions.find(a => a.name === 'CLI version is target').observed = '0.164.7';});
    rejects(r => {r.assertions.push({name: 'unexpected failure', passed: false});});
    rejects(r => {r.assertions.push(r.assertions[0]);});
    rejects(r => {r.assertions[0].passed = 'false';});
    rejects(r => {r.assertions.pop();});
    rejects(r => changeCommand(r, 'exit', 99));
    rejects(r => changeCommand(r, 'timeout', true));
    rejects(r => changeCommand(r, 'signal', 'SIGTERM'));
    rejects(r => changeCommand(r, 'stdout', r.update.stdout + 'extra\n'));
    rejects(r => changeCommand(r, 'stderr', r.update.stderr + 'extra\n'));
    rejects(r => {r.update.stdout += 'unshared evidence';});
    for (const name of knownRefusals[i].requiredAssertions) {
      rejects(r => {r.assertions.find(a => a.name === name).passed = false;});
    }
  });
}
test('exact coordinates, phase, source range and explicit future retirement', () => {
  const {cell, report} = fixture(0);
  for (const id of ['linux-npm-agent-stop-consent', 'linux-npm-fresh', 'darwin-npm-standalone-stop-consent']) {
    assert.equal(matchKnownRefusal({...cell, id}, report), null);
  }
  assert.equal(knownRefusalFor({...cell, phase: 'published'}), knownRefusals[0]);
  assert.equal(knownRefusalFor({...cell, phase: 'unlisted'}), null);
  assert.equal(knownRefusalFor({...cell, sourceVersion: '1.0.0'}), knownRefusals[0]);
  assert.equal(knownRefusalFor({...cell, id: 'linux-npm-fresh', sourceVersion: '1.0.0'}), null);
  assert.equal(knownRefusalFor({...cell, sourceVersion: '0.164.5'}), null);
  assert.equal(knownRefusalFor({...cell, sourceVersion: '0.164.7'}), knownRefusals[0]);
  assert.equal(knownRefusalFor({...fixture(1).cell, sourceVersion: '0.164.7'}), null);
  assert.equal(knownRefusalFor({...fixture(2).cell, sourceVersion: '0.164.7'}), knownRefusals[2]);
  assert.equal(knownRefusalFor({...fixture(2).cell, phase: 'published', sourceVersion: '0.164.5'}), knownRefusals[2]);
  assert.equal(knownRefusalFor({...fixture(0).cell, phase: 'published', sourceVersion: '0.164.5'}), null);
  const hypothetical = [{...knownRefusals[2], fixedIn: '0.999.0'}];
  assert.equal(knownRefusalFor({...fixture(2).cell, sourceVersion: '0.999.0'}, hypothetical), null);
  assert.throws(() => knownRefusalFor({...cell, sourceVersion: 'latest'}));
  assert.throws(() => knownRefusalFor(cell, [knownRefusals[0], knownRefusals[0]]));
});
test('typed substitutions have no free text wildcard and repeated identity stays equal', () => {
  const {cell, report} = fixture(0);
  report.managerHost.space = 'owned-test';
  changeCommand(report, 'stdout', report.update.stdout.replaceAll('upgrade-proof', 'owned-test').replaceAll('2699', '4123'));
  assert.equal(matchKnownRefusal(cell, report), knownRefusals[0]);
  changeCommand(report, 'stdout', report.update.stdout.replace('pid 4123', 'pid unknown'));
  assert.throws(() => matchKnownRefusal(cell, report));
  const mismatch = fixture(0);
  changeCommand(mismatch.report, 'stdout', mismatch.report.update.stdout.replace('in space "upgrade-proof"', 'in space "other"'));
  assert.throws(() => matchKnownRefusal(mismatch.cell, mismatch.report));
});
