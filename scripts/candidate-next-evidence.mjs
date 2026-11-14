import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants, openSync, closeSync, fstatSync, readFileSync,realpathSync} from 'node:fs';
import {join, dirname, relative, resolve, isAbsolute} from 'node:path';
import {findPackageJSON} from 'node:module';
import {pathToFileURL} from 'node:url';
import {evaluateManualDaemonState} from './daemon-manual-acceptance.mjs';
import {matchSource16410Refusal} from './source-16410-refusal.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Bind the installed candidate's actual entry and package bytes before its updater runs. */
export function candidateSourceIdentity({pkg, cli, identity, argv}) {
  const source = identity.sourcePackages.find(row => row.name === 'cotal-ai');
  assert(source?.files, 'source package file hashes missing');
  const manifest = readFileSync(join(pkg, 'package.json'));
  const entry = readFileSync(cli);
  const metadata = JSON.parse(manifest);
  assert.equal(metadata.name, 'cotal-ai');
  assert.equal(metadata.version, identity.sourceVersion);
  assert.equal(hash(manifest), source.files['package.json'], 'installed source manifest differs from packed A');
  assert.equal(hash(entry), source.files['dist/cotal.js'], 'installed source entry differs from packed A');
  assert.deepEqual(argv, [cli, 'update', '--self']);
  const loaded = identity.sourcePackages.find(row => row.name === '@cotal-ai/cli');
  assert(loaded?.files, 'loaded CLI package hashes missing');
  const loadedManifest = findPackageJSON('@cotal-ai/cli/update',pathToFileURL(join(pkg,'package.json')));
  assert(loadedManifest,'loaded CLI package root not found');
  const loadedRoot=realpathSync(dirname(loadedManifest));
  const loadedMetadata=readFileSync(join(loadedRoot,'package.json'));
  const info=JSON.parse(loadedMetadata);
  assert.equal(info.name,'@cotal-ai/cli');
  assert.equal(info.version,identity.sourceVersion);
  assert.equal(hash(loadedMetadata),loaded.files['package.json']);
  const exported=info.exports?.['./update']?.import;
  assert(typeof exported==='string'&&exported.startsWith('./'),'loaded CLI needs its ESM update export');
  const loadedEntry=realpathSync(resolve(loadedRoot,exported));
  const member=relative(loadedRoot,loadedEntry).split('\\').join('/');
  assert(!member.startsWith('../')&&!isAbsolute(member),'loaded CLI export escaped package');
  assert.equal(hash(readFileSync(loadedEntry)),loaded.files[member]);
  return {path: realpathSync(cli), sha256: hash(entry), packageSha256: hash(manifest), name: metadata.name, version: metadata.version, argv,
    loadedCli:{path:realpathSync(loadedEntry),member,sha256:hash(readFileSync(loadedEntry)),packageSha256:hash(loadedMetadata),name:info.name,version:info.version}};
}

/** Reopen the hosted Manager's read-only public replies and bind them to the actual calls. */
export function hostedManagerRestored({evidence, output, target, calls, stage, after, before}) {
  assert(evidence && /^[A-Za-z0-9_-]{1,64}$/.test(evidence.space), 'hosted Manager space missing');
  const {commands, status, seats, space} = evidence;
  assert.match(commands?.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
  const fd = openSync(join(output, commands.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size === commands.bytes && stat.size <= 524288);
    if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
    const bytes = readFileSync(fd);
    assert.equal(hash(bytes), commands.sha256);
    assert.deepEqual(JSON.parse(bytes), {status, seats});
  } finally { closeSync(fd); }
  const daemon = status?.exit === 0 ? JSON.parse(status.stdout).result : undefined;
  const managers = daemon?.managers?.filter(row => row.space === space) ?? [];
  const manager = managers.length === 1 ? managers[0] : undefined;
  const inventory = seats?.exit === 0 ? JSON.parse(seats.stdout).result : undefined;
  for (const [suffix, result, argv] of [
    ['status', status, ['daemon', 'status', '--space', space, '--json']],
    ['seats', seats, ['ps', '--on', manager?.instanceId, '--space', space, '--json']],
  ]) {
    const matching = calls?.filter(call => call.label === `${stage} hosted Manager ${suffix}`);
    assert.equal(matching?.length, 1, 'actual hosted Manager command missing or duplicated');
    const call = matching[0];
    assert(Number.isFinite(Date.parse(call.startedAt)) && Date.parse(call.finishedAt) >= Date.parse(call.startedAt), 'hosted Manager command time bounds missing or reversed');
    assert.deepEqual(call.argv.slice(-argv.length), argv);
    if (after !== undefined) assert(Number.isFinite(Date.parse(call.startedAt)) && Date.parse(call.startedAt) >= Date.parse(after), 'hosted Manager evidence predates its update');
    if (before !== undefined) assert(Number.isFinite(Date.parse(call.finishedAt)) && Date.parse(call.finishedAt) <= Date.parse(before), 'hosted Manager evidence follows the next update');
    for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(call[key], result?.[key], `hosted Manager ${suffix} ${key} differs from actual call`);
  }
  const clean = result => result?.exit === 0 && result.signal === null && result.timeout === false;
  const passed = clean(status) && clean(seats) && daemon?.state === 'ready' && daemon.version === target
    && manager?.state === 'answering' && typeof manager.instanceId === 'string' && manager.instanceId.length > 0
    && inventory?.kind === 'seats' && Array.isArray(inventory.items) && inventory.items.length === 0
    && inventory.managers?.length === 1 && inventory.managers[0].instanceId === manager.instanceId && inventory.managers[0].state === 'answered';
  return {passed, space, instanceId: manager?.instanceId};
}

/** Reopen the between-hop native capture rather than trusting a report's healthy flag. */
export function intermediateWholeMachine({diagnostics, output, target, platform, status, updateCheck, commands}) {
  const finalState = evaluateManualDaemonState({diagnostics: {...diagnostics, stage: 'after-update'}, output, target, platform});
  if (commands) {
    assert.match(commands.artifact, /^[A-Za-z0-9_.-]+\.txt$/);
    const fd = openSync(join(output,commands.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat=fstatSync(fd);
      assert(stat.isFile() && stat.nlink === 1 && stat.size === commands.bytes && stat.size <= 524288);
      if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
      const data=readFileSync(fd);
      assert.equal(hash(data),commands.sha256);
      const archived=JSON.parse(data);
      assert.deepEqual(status,archived.status);
      assert.deepEqual(updateCheck,archived.updateCheck);
    } finally {closeSync(fd);}
  }
  const value = status?.exit === 0 ? JSON.parse(status.stdout).result : undefined;
  const checks = {
    finalState: finalState.passed,
    answeringTarget: value?.state === 'ready' && value.version === target,
    notPaused: typeof value?.update?.lastResult === 'string' && !/paused/i.test(value.update.lastResult),
    generationFenceClear: value?.update?.restartEvidence?.prepared === false,
    publicUpdateCheck: updateCheck?.exit === 0 && updateCheck?.timeout !== true && updateCheck?.signal === null,
  };
  return {passed: Object.values(checks).every(Boolean), checks, finalState, status, updateCheck, ...(commands ? {commands} : {}), fence: value?.update?.restartEvidence ?? {state:'unknown'}};
}

/** Verify the candidate-owned hop and optional measured first-hop refusal in archived evidence. */
export function verifyCandidateNextEvidence({report, cell, output, sourceManifestSha256, targetManifestSha256}) {
  const pair = report.candidateNext;
  assert(pair, 'paired candidate identity missing');
  assert.equal(pair.source, cell.sourceSHA);
  assert.equal(pair.sourceManifestSha256, sourceManifestSha256);
  assert.equal(pair.targetManifestSha256, targetManifestSha256);
  const source = pair.sourcePackages?.find(row => row.name === 'cotal-ai');
  const invocation = report.candidateSourceInvocation;
  assert.equal(invocation?.name, 'cotal-ai');
  assert.equal(invocation.version, pair.sourceVersion);
  assert.equal(invocation.sha256, source?.files?.['dist/cotal.js']);
  assert.equal(invocation.packageSha256, source?.files?.['package.json']);
  const loaded = pair.sourcePackages?.find(row => row.name === '@cotal-ai/cli');
  assert.equal(invocation.loadedCli?.name,'@cotal-ai/cli');
  assert.equal(invocation.loadedCli.version,pair.sourceVersion);
  assert.equal(invocation.loadedCli.packageSha256,loaded?.files?.['package.json']);
  assert.equal(invocation.loadedCli.sha256,loaded?.files?.[invocation.loadedCli.member]);
  assert(Array.isArray(invocation.argv) && invocation.argv.length === 3 && invocation.argv[1] === 'update' && invocation.argv[2] === '--self');
  assert.equal(realpathSync(output), output, 'physical evidence root required');
  const hop = report.nextHop;
  assert.equal(hop?.finalTargetVersion, pair.targetVersion);
  assert.equal(report.target, pair.targetVersion);
  const update = hop.secondHop?.update;
  const label = hop.mode === 'candidate' ? 'upgrade under test' : 'candidate second hop under test';
  const commands = report.calls?.filter(row => row.label === label);
  assert.equal(commands?.length,1,'actual candidate-owned public command missing or duplicated');
  const command = commands[0];
  const argv = command.argv ?? command.args;
  assert(Array.isArray(argv) && argv.at(-2) === 'update' && argv.at(-1) === '--self', 'candidate hop must invoke public update --self');
  assert(argv.includes(invocation.argv[0]) || command.file === invocation.argv[0] || report.layout === 'installer', 'public command does not name installed candidate entry');
  assert.equal(command.exit, update?.exit, 'candidate hop exit differs from actual command');
  assert.equal(command.signal, update?.signal, 'candidate hop signal differs from actual command');
  assert.equal(command.timeout, update?.timeout, 'candidate hop timeout differs from actual command');
  assert.equal(command.stdout,update?.stdout,'candidate hop stdout differs from actual command');
  assert.equal(command.stderr,update?.stderr,'candidate hop stderr differs from actual command');
  const nextHopSuccess = update?.exit === 0 && update.signal === null && update.timeout === false;
  const final = evaluateManualDaemonState({diagnostics: report.daemonDiagnostics?.['after-update'], output, target: pair.targetVersion, platform: cell.platform});
  let firstRefusal = false, intermediateWhole = true;
  if (hop.mode === 'source-0.164.10') {
    assert.equal(report.source, '0.164.10');
    const firstCalls=report.calls.filter(row=>row.label==='upgrade under test');
    assert.equal(firstCalls.length,1,'first public hop missing or duplicated');
    const first=firstCalls[0];
    const firstArgv = cell.scenario === 'agent-stop-consent' ? ['update', '--self', '--stop-agents'] : ['update', '--self'];
    assert(Array.isArray(first.argv));
    assert.deepEqual(first.argv.slice(-firstArgv.length), firstArgv);
    for(const key of ['exit','signal','timeout','stdout','stderr','elapsedMs']) assert.equal(first[key],hop.firstHop?.update?.[key],`first hop ${key} differs from actual command`);
    const captured=Date.parse(report.daemonDiagnostics?.['between-hops']?.capturedAt);
    assert(Number.isFinite(captured) && captured>=Date.parse(first.finishedAt) && Date.parse(command.startedAt)>=captured,'first/middle/second hop order differs from native capture');
    const refusal = matchSource16410Refusal({platform: cell.platform, layout: cell.channel, sourceVersion: report.source, targetVersion: pair.sourceVersion, update: hop.firstHop?.update});
    assert.deepEqual(hop.firstHop?.refusal, refusal, 'first-hop refusal receipt differs from measured contract');
    assert(hop.intermediate?.commands, 'hashed between-hop command evidence missing');
    const middle = intermediateWholeMachine({diagnostics: report.daemonDiagnostics?.['between-hops'], output, target: pair.sourceVersion, platform: cell.platform, status: hop.intermediate?.status, updateCheck: hop.intermediate?.updateCheck, commands: hop.intermediate.commands});
    intermediateWhole = middle.passed;
    firstRefusal = true;
  } else {
    assert.equal(hop.mode, 'candidate');
    assert.equal(report.source, pair.sourceVersion);
  }
  let managerRestored;
  if (cell.scenario === 'agent-stop-consent') {
    assert.equal(hop.mode, 'source-0.164.10');
    assert.equal(report.agentHost, 'daemon');
    assert.equal(report.managerHost?.mode, 'daemon-hosted');
    assert.equal(report.managerHost.space, report.participant?.space);
    for (const evidence of [hop.intermediate?.hostedManager, hop.secondHop?.hostedManager]) assert.equal(evidence?.space, report.managerHost.space);
    const first = report.calls.find(row => row.label === 'upgrade under test');
    assert.equal(first.argv[0], invocation.argv[0], 'hosted chain must retain the same installed entry path');
    const before = report.calls.filter(row => row.label === 'confirm daemon-hosted seat');
    assert.equal(before.length, 1, 'actual initial hosted seat command missing or duplicated');
    const initial = before[0];
    assert.equal(initial.exit, 0);
    assert.equal(initial.signal, null);
    assert.equal(initial.timeout, false);
    assert.equal(initial.stdout, report.agentBefore);
    assert.deepEqual(initial.argv.slice(-6), ['ps', '--on', report.managerHost.instanceId, '--space', report.managerHost.space, '--json']);
    const inventory = JSON.parse(initial.stdout).result;
    assert(inventory?.kind === 'seats' && inventory.items?.length === 1 && inventory.items[0].name === 'upgrade_proof_worker', 'positive pre-update hosted seat proof missing');
    assert(inventory.managers?.length === 1 && inventory.managers[0].instanceId === report.managerHost.instanceId && inventory.managers[0].state === 'answered');
    const between = report.calls.slice(report.calls.indexOf(first) + 1, report.calls.indexOf(command));
    assert.deepEqual(between.map(row => row.label), ['between hops public daemon status', 'between hops public update check', 'between hops hosted Manager status', 'between hops hosted Manager seats'], 'only read-only whole-state observations may occur between hosted hops');
    assert(Date.parse(initial.finishedAt) <= Date.parse(first.startedAt), 'initial hosted seat observation follows the first update');
    assert(Date.parse(first.startedAt) <= Date.parse(first.finishedAt) && Date.parse(command.startedAt) <= Date.parse(command.finishedAt), 'hosted update time bounds missing or reversed');
    let previous = first.finishedAt;
    for (const observation of between) {
      assert(Date.parse(observation.startedAt) >= Date.parse(previous) && Date.parse(observation.finishedAt) >= Date.parse(observation.startedAt), 'between-hop observations are out of order');
      previous = observation.finishedAt;
    }
    assert(Date.parse(previous) <= Date.parse(command.startedAt), 'between-hop observation overlaps second update');
    for (const [observation, result, argv] of [
      [between[0], hop.intermediate.status, ['daemon', 'status', '--json']],
      [between[1], hop.intermediate.updateCheck, ['update', '--check']],
    ]) {
      assert.deepEqual(observation.argv.slice(-argv.length), argv);
      for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(observation[key], result[key], 'between-hop public command differs from its receipt');
    }
    const middle = hostedManagerRestored({evidence: hop.intermediate.hostedManager, output, target: pair.sourceVersion, calls: report.calls, stage: 'between hops', after: first.finishedAt, before: command.startedAt});
    const last = hostedManagerRestored({evidence: hop.secondHop.hostedManager, output, target: pair.targetVersion, calls: report.calls, stage: 'after update', after: command.finishedAt});
    intermediateWhole = intermediateWhole && middle.passed;
    managerRestored = middle.passed && last.passed;
  }
  return {sourceIdentity: true, firstRefusal, intermediateWhole, nextHopSuccess: nextHopSuccess && final.passed && managerRestored !== false, ...(managerRestored === undefined ? {} : {hostedManagerRestored: managerRestored})};
}
