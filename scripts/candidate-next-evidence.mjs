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

/** Return only the retry delay carried by the measured CLI actor rate refusal. */
export function hostedManagerRetryAfter(status, space) {
  assert(status?.exit === 0 && status.signal === null && status.timeout === false, 'hosted Manager status command must complete');
  const managers = JSON.parse(status.stdout).result.managers?.filter(row => row.space === space);
  assert(managers?.length === 1 && managers[0].instanceId, 'hosted Manager identity missing');
  const manager = managers[0];
  if (manager.state === 'answering') return 0;
  assert.equal(manager.state, 'starting', 'hosted Manager must answer without repair before continuing');
  const match = /^(?:✗ )?actor cli of owner [a-z0-9_]+ is over its limit of 60 connects a minute - retry in ([1-9][0-9]*)s - only actor "cli" is limited, not the account's other actors$/.exec(manager.reason ?? '');
  assert(match, 'unmeasured hosted Manager STARTING reason');
  const milliseconds = Number(match[1]) * 1000;
  assert(Number.isSafeInteger(milliseconds), 'invalid rate-limit retry delay');
  return milliseconds;
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
    assert.deepEqual(JSON.parse(bytes), {status, seats, ...(evidence.observations ? {observations: evidence.observations} : {})});
  } finally { closeSync(fd); }
  const daemon = status?.exit === 0 ? JSON.parse(status.stdout).result : undefined;
  const managers = daemon?.managers?.filter(row => row.space === space) ?? [];
  const manager = managers.length === 1 ? managers[0] : undefined;
  const inventory = seats?.exit === 0 ? JSON.parse(seats.stdout).result : undefined;
  const statusCalls = calls?.filter(call => call.label === `${stage} hosted Manager status` || new RegExp(`^${stage} hosted Manager status retry [1-9][0-9]*$`).test(call.label));
  assert(statusCalls?.length > 0, 'actual hosted Manager status missing');
  if (evidence.observations) {
    assert.equal(evidence.timeoutMs, 180000, 'hosted status observation bound changed');
    const window = evidence.observationWindow;
    assert(Number.isFinite(window?.startedAt) && window.deadline === window.startedAt + evidence.timeoutMs);
    assert.equal(statusCalls.length, evidence.observations.length, 'every rate-limited question must be retained');
    assert(Date.parse(statusCalls[0].startedAt) >= window.startedAt && Date.parse(statusCalls[0].startedAt) < window.deadline);
    let previous;
    for (let index = 0; index < statusCalls.length; index++) {
      const call = statusCalls[index], observation = evidence.observations[index];
      assert.equal(call.label, `${stage} hosted Manager status${index ? ` retry ${index}` : ''}`);
      for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(call[key], observation.status[key]);
      assert.deepEqual(call.argv.slice(-5), ['daemon', 'status', '--space', space, '--json']);
      const wait = hostedManagerRetryAfter(observation.status, space);
      assert.equal(observation.retryAfterMs, wait);
      assert(Number.isFinite(observation.observedAt) && observation.observedAt >= Date.parse(call.finishedAt) && observation.observedAt < window.deadline);
      assert(Date.parse(call.startedAt) >= window.startedAt && Date.parse(call.finishedAt) >= Date.parse(call.startedAt));
      if (after !== undefined) assert(Date.parse(call.startedAt) >= Date.parse(after), 'rate-limited observation predates update');
      if (before !== undefined) assert(Date.parse(call.finishedAt) <= Date.parse(before), 'rate-limited observation follows next update');
      if (previous) assert(Date.parse(call.startedAt) >= previous.observedAt + previous.retryAfterMs, 'rate-limited status retried before retry-after');
      assert.equal(wait === 0, index === statusCalls.length - 1, 'only the final Manager observation may answer');
      previous = observation;
    }
    assert.deepEqual(status, evidence.observations.at(-1).status);
  } else assert.equal(statusCalls.length, 1, 'unarchived hosted status retries');
  for (const [suffix, result, argv] of [
    ['status', status, ['daemon', 'status', '--space', space, '--json']],
    ['seats', seats, ['ps', '--on', manager?.instanceId, '--space', space, '--json']],
  ]) {
    const matching = suffix === 'status' ? [statusCalls.at(-1)] : calls?.filter(call => call.label === `${stage} hosted Manager ${suffix}`);
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
export function intermediateWholeMachine({diagnostics, output, target, platform, expectedPackageManagerVersion, status, updateCheck, commands}) {
  const finalState = evaluateManualDaemonState({diagnostics: {...diagnostics, stage: 'after-update'}, output, target, platform, expectedPackageManagerVersion});
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

/** Verify the candidate-owned hop, optional measured first-hop refusal, and optional follow-on C action in archived evidence. */
export function verifyCandidateNextEvidence({report, cell, output, sourceManifestSha256, targetManifestSha256, followOnManifestSha256}) {
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
  const followOnAction = cell.followOnAction ?? hop?.followOn?.action;
  const expectedFinalTarget = followOnAction ? pair.followOnVersion : pair.targetVersion;
  assert.equal(hop?.finalTargetVersion, expectedFinalTarget);
  assert.equal(report.target, expectedFinalTarget);
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
  const expectedFinalPackageManagerVersion = ['npm', 'installer'].includes(followOnAction)
    ? pair.followOnVersion
    : hop.mode === 'source-0.164.10'
      ? report.daemonDiagnostics?.['between-hops']?.observations?.find(row => row.kind === 'installed-version')?.packageManagerRecordVersion ?? pair.sourceVersion
      : pair.sourceVersion;
  const final = (cell.disabledDaemonBeforeUpdate || cell.desktopBesideCli)
    ? {passed: true}
    : evaluateManualDaemonState({diagnostics: report.daemonDiagnostics?.['after-update'], output, target: expectedFinalTarget, platform: cell.platform, expectedPackageManagerVersion: expectedFinalPackageManagerVersion});
  if (['npm', 'installer'].includes(followOnAction)) {
    assert.equal(final.updateRoute, 'in-place', 'manual npm and installer follow-on routes must clear staged generation and finish in-place at C');
    assert.equal(final.packageManagerRecordVersion, pair.followOnVersion);
  }
  let firstRefusal = false, intermediateWhole = true, followOnSuccess, bareManualNpm, stoppedDaemonBeforeUpdate, disabledDaemonBeforeUpdate, stoppedDesktopBesideCli;
  if (cell.stoppedDaemonBeforeUpdate) {
    assert.equal(hop.mode, 'candidate');
    const stopped = report.stoppedDaemonBeforeUpdate;
    assert(stopped?.commands, 'hashed stopped-daemon-before-update command evidence missing');
    assert.match(stopped.commands.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
    const fd = openSync(join(output, stopped.commands.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
    let archivedStopped;
    try {
      const stat = fstatSync(fd);
      assert(stat.isFile() && stat.nlink === 1 && stat.size === stopped.commands.bytes && stat.size <= 524288);
      if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
      const data = readFileSync(fd);
      assert.equal(hash(data), stopped.commands.sha256);
      archivedStopped = JSON.parse(data);
    } finally { closeSync(fd); }
    const stopCalls = report.calls.filter(row => row.label === 'stop native daemon before manual repair');
    const statusCalls = report.calls.filter(row => row.label === 'stopped daemon status before manual repair');
    assert.equal(stopCalls.length, 1, 'stop native daemon call missing or duplicated');
    assert(statusCalls.length >= 1, 'stopped daemon status call missing');
    const stopCall = stopCalls[0], statusCall = statusCalls.at(-1);
    assert(Date.parse(stopCall.finishedAt) >= Date.parse(stopCall.startedAt)
      && Date.parse(statusCall.startedAt) >= Date.parse(stopCall.finishedAt)
      && Date.parse(statusCall.finishedAt) >= Date.parse(statusCall.startedAt)
      && Date.parse(command.startedAt) >= Date.parse(statusCall.finishedAt), 'stopped daemon observation must precede update --self');
    for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) {
      assert.equal(stopCall[key], archivedStopped.stopCommand?.[key], `stop native daemon ${key} differs from actual call`);
      assert.equal(statusCall[key], archivedStopped.statusWhileStopped?.[key], `stopped daemon status ${key} differs from actual call`);
    }
    stoppedDaemonBeforeUpdate = archivedStopped.stopCommand?.exit === 0 && archivedStopped.stopCommand?.signal === null && archivedStopped.stopCommand?.timeout === false
      && archivedStopped.statusWhileStopped?.exit === 2 && archivedStopped.statusWhileStopped?.signal === null && archivedStopped.statusWhileStopped?.timeout === false;
  }
  if (cell.desktopBesideCli) {
    assert.equal(hop.mode, 'candidate');
    assert.equal(cell.platform, 'linux');
    assert.equal(cell.stoppedDaemonBeforeUpdate, true);
    const desktopAfter = report.stoppedDesktopAfterUpdate;
    assert(desktopAfter?.commands, 'hashed stopped-desktop-after-update command evidence missing');
    assert.match(desktopAfter.commands.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
    let archivedDesktopAfter;
    const fd = openSync(join(output, desktopAfter.commands.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      assert(stat.isFile() && stat.nlink === 1 && stat.size === desktopAfter.commands.bytes && stat.size <= 524288);
      if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
      const data = readFileSync(fd);
      assert.equal(hash(data), desktopAfter.commands.sha256);
      archivedDesktopAfter = JSON.parse(data);
    } finally { closeSync(fd); }
    const statusAfterCalls = report.calls.filter(row => row.label === 'native status after');
    const showAfterCalls = report.calls.filter(row => row.label === 'desktop unit show after CLI update');
    assert.equal(statusAfterCalls.length, 1, 'stopped desktop status after call missing or duplicated');
    assert.equal(showAfterCalls.length, 1, 'desktop unit show after call missing or duplicated');
    const statusAfterCall = statusAfterCalls[0], showAfterCall = showAfterCalls[0];
    assert(Date.parse(statusAfterCall.startedAt) >= Date.parse(command.finishedAt)
      && Date.parse(showAfterCall.startedAt) >= Date.parse(statusAfterCall.finishedAt), 'stopped desktop observations must follow update --self');
    for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) {
      assert.equal(statusAfterCall[key], archivedDesktopAfter.status?.[key], `stopped desktop status after ${key} differs from actual call`);
      assert.equal(showAfterCall[key], archivedDesktopAfter.unitShowAfter?.[key], `desktop unit show after ${key} differs from actual call`);
    }
    const desktopEntryPath = report.desktop?.entry;
    assert(typeof desktopEntryPath === 'string' && desktopEntryPath.length > 0 && desktopEntryPath === join(String(report.desktop?.runtime ?? ''), 'dist/cotal.js'), 'recorded desktop entry path missing');
    stoppedDesktopBesideCli = archivedDesktopAfter.status?.exit === 2 && archivedDesktopAfter.status?.signal === null && archivedDesktopAfter.status?.timeout === false
      && archivedDesktopAfter.unitShowAfter?.exit === 0 && archivedDesktopAfter.unitShowAfter?.signal === null && archivedDesktopAfter.unitShowAfter?.timeout === false
      && /ActiveState=inactive/.test(String(archivedDesktopAfter.unitShowAfter?.stdout ?? '')) && /MainPID=0/.test(String(archivedDesktopAfter.unitShowAfter?.stdout ?? ''))
      && String(command.stdout ?? '').includes(`machine daemon: the background service belongs to another Cotal installation (${desktopEntryPath}). This update left it stopped.`)
      && archivedDesktopAfter.updateNamesDesktopOwner === true
      && archivedDesktopAfter.remainsStopped === true;
  }
  if (cell.disabledDaemonBeforeUpdate) {
    assert.equal(hop.mode, 'candidate');
    assert(['linux', 'darwin'].includes(cell.platform));
    const disabledBefore = report.disabledDaemonBeforeUpdate;
    const disabledAfter = report.disabledDaemonAfterUpdate;
    assert(disabledBefore?.commands && disabledAfter?.commands, 'hashed disabled-daemon command evidence missing');
    let archivedBefore, archivedAfter;
    for (const [entry, assign] of [[disabledBefore.commands, v => { archivedBefore = v; }], [disabledAfter.commands, v => { archivedAfter = v; }]]) {
      assert.match(entry.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
      const fd = openSync(join(output, entry.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        assert(stat.isFile() && stat.nlink === 1 && stat.size === entry.bytes && stat.size <= 524288);
        if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
        const data = readFileSync(fd);
        assert.equal(hash(data), entry.sha256);
        assign(JSON.parse(data));
      } finally { closeSync(fd); }
    }
    const disableCalls = report.calls.filter(row => row.label === 'disable native daemon before manual update');
    const stopCalls = report.calls.filter(row => row.label === 'stop native daemon before manual update');
    const statusBeforeCalls = report.calls.filter(row => row.label === 'disabled daemon status before manual update');
    const showBeforeCalls = report.calls.filter(row => row.label === 'disabled unit show before manual update');
    const statusAfterCalls = report.calls.filter(row => row.label === 'native status after');
    const showAfterCalls = report.calls.filter(row => row.label === 'disabled unit show after manual update');
    assert.equal(disableCalls.length, 1, 'disable native daemon call missing or duplicated');
    assert.equal(stopCalls.length, cell.platform === 'darwin' ? 1 : 0, 'darwin disabled cell requires one bootout stop call');
    assert(statusBeforeCalls.length >= 1, 'disabled daemon status before call missing');
    assert.equal(showBeforeCalls.length, 1, 'disabled unit show before call missing or duplicated');
    assert.equal(statusAfterCalls.length, 1, 'disabled daemon status after call missing or duplicated');
    assert.equal(showAfterCalls.length, 1, 'disabled unit show after call missing or duplicated');
    const disableCall = disableCalls[0], stopCall = stopCalls[0], statusBeforeCall = statusBeforeCalls.at(-1), showBeforeCall = showBeforeCalls[0], statusAfterCall = statusAfterCalls[0], showAfterCall = showAfterCalls[0];
    assert(Date.parse(disableCall.finishedAt) >= Date.parse(disableCall.startedAt)
      && (!stopCall || (Date.parse(stopCall.startedAt) >= Date.parse(disableCall.finishedAt) && Date.parse(stopCall.finishedAt) >= Date.parse(stopCall.startedAt)))
      && Date.parse(statusBeforeCall.startedAt) >= Date.parse((stopCall ?? disableCall).finishedAt)
      && Date.parse(showBeforeCall.startedAt) >= Date.parse(statusBeforeCall.finishedAt)
      && Date.parse(command.startedAt) >= Date.parse(showBeforeCall.finishedAt)
      && Date.parse(statusAfterCall.startedAt) >= Date.parse(command.finishedAt)
      && Date.parse(showAfterCall.startedAt) >= Date.parse(statusAfterCall.finishedAt), 'disabled daemon observations must bracket update --self');
    for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) {
      assert.equal(disableCall[key], archivedBefore.disableCommand?.[key], `disable native daemon ${key} differs from actual call`);
      if (stopCall) assert.equal(stopCall[key], archivedBefore.stopCommand?.[key], `stop native daemon ${key} differs from actual call`);
      assert.equal(statusBeforeCall[key], archivedBefore.statusWhileDisabled?.[key], `disabled daemon status before ${key} differs from actual call`);
      assert.equal(showBeforeCall[key], archivedBefore.unitShowBefore?.[key], `disabled unit show before ${key} differs from actual call`);
      assert.equal(statusAfterCall[key], archivedAfter.status?.[key], `disabled daemon status after ${key} differs from actual call`);
      assert.equal(showAfterCall[key], archivedAfter.unitShowAfter?.[key], `disabled unit show after ${key} differs from actual call`);
    }
    const cleanZero = item => item?.exit === 0 && item?.signal === null && item?.timeout === false;
    const stoppedExit = item => item?.exit === 2 && item?.signal === null && item?.timeout === false;
    const unitName = disabledBefore.unit;
    assert(typeof unitName === 'string' && unitName.length > 0, 'disabled unit name missing');
    const inactiveDisabled = text => cell.platform === 'linux'
      ? /ActiveState=inactive/.test(String(text ?? '')) && /UnitFileState=disabled/.test(String(text ?? '')) && /MainPID=0/.test(String(text ?? ''))
      : new RegExp(`"${unitName.replaceAll('.', '\\.')}" => (?:true|disabled)`).test(String(text ?? ''));
    disabledDaemonBeforeUpdate = cleanZero(archivedBefore.disableCommand)
      && (!stopCall || cleanZero(archivedBefore.stopCommand))
      && stoppedExit(archivedBefore.statusWhileDisabled)
      && cleanZero(archivedBefore.unitShowBefore) && inactiveDisabled(archivedBefore.unitShowBefore?.stdout)
      && stoppedExit(archivedAfter.status)
      && cleanZero(archivedAfter.unitShowAfter) && inactiveDisabled(archivedAfter.unitShowAfter?.stdout)
      && String(command.stdout ?? '').includes('service is disabled; not started')
      && archivedAfter.updateReportsDisabledNotStarted === true
      && archivedAfter.remainsDisabledAndStopped === true;
  }
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
    const middle = intermediateWholeMachine({diagnostics: report.daemonDiagnostics?.['between-hops'], output, target: pair.sourceVersion, platform: cell.platform, expectedPackageManagerVersion: '0.164.10', status: hop.intermediate?.status, updateCheck: hop.intermediate?.updateCheck, commands: hop.intermediate.commands});
    intermediateWhole = middle.passed;
    firstRefusal = true;
  } else {
    assert.equal(hop.mode, 'candidate');
    assert.equal(report.source, pair.sourceVersion);
  }
  if (followOnAction) {
    assert.equal(hop.mode, 'candidate');
    assert(['self', 'npm', 'installer'].includes(followOnAction), 'invalid follow-on action');
    assert(followOnManifestSha256, 'follow-on manifest sha256 required');
    assert.equal(pair.followOnManifestSha256, followOnManifestSha256);
    assert.equal(hop.followOn?.action, followOnAction);
    assert.equal(hop.followOn?.targetVersion, pair.followOnVersion);
    assert(hop.intermediate?.commands, 'hashed between-hop command evidence missing');
    const middle = intermediateWholeMachine({diagnostics: report.daemonDiagnostics?.['between-hops'], output, target: pair.targetVersion, platform: cell.platform, expectedPackageManagerVersion: pair.sourceVersion, status: hop.intermediate?.status, updateCheck: hop.intermediate?.updateCheck, commands: hop.intermediate.commands});
    intermediateWhole = middle.passed;
    const captured = Date.parse(report.daemonDiagnostics?.['between-hops']?.capturedAt);
    assert(Number.isFinite(captured) && captured >= Date.parse(command.finishedAt), 'between-hop capture predates first candidate hop');
    const clean = result => result?.exit === 0 && result.signal === null && result.timeout === false;
    if (followOnAction === 'self') {
      const followCalls = report.calls.filter(row => row.label === 'candidate follow-on self update under test');
      assert.equal(followCalls.length, 1, 'follow-on self update call missing or duplicated');
      const followCall = followCalls[0];
      assert(Date.parse(followCall.startedAt) >= captured && Date.parse(followCall.finishedAt) >= Date.parse(followCall.startedAt), 'follow-on self update time bounds invalid');
      assert(Array.isArray(followCall.argv) && followCall.argv.at(-2) === 'update' && followCall.argv.at(-1) === '--self');
      assert(followCall.argv.includes(invocation.argv[0]) || followCall.file === invocation.argv[0]);
      for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(followCall[key], hop.followOn?.update?.[key], `follow-on self ${key} differs from actual command`);
      followOnSuccess = clean(hop.followOn?.update);
    } else if (followOnAction === 'npm') {
      const npmCalls = report.calls.filter(row => row.label === 'manual npm install follow-on target');
      const bareVersionCalls = report.calls.filter(row => row.label === 'bare manual npm CLI version observation');
      const bareStatusCalls = report.calls.filter(row => row.label === 'bare manual npm daemon status' || row.label === 'wait for bare manual npm daemon generation');
      const reconcileCalls = report.calls.filter(row => row.label === 'reconcile manual npm follow-on target');
      assert.equal(npmCalls.length, 1, 'manual npm follow-on install call missing or duplicated');
      assert.equal(bareVersionCalls.length, 1, 'bare manual npm CLI version observation call missing or duplicated');
      assert(bareStatusCalls.length >= 1, 'bare manual npm daemon status call missing');
      assert.equal(reconcileCalls.length, 1, 'manual npm follow-on reconciliation call missing or duplicated');
      const npmCall = npmCalls[0], bareVersionCall = bareVersionCalls[0], bareStatusCall = bareStatusCalls.at(-1), reconcileCall = reconcileCalls[0];
      assert(Date.parse(npmCall.startedAt) >= captured && Date.parse(npmCall.finishedAt) >= Date.parse(npmCall.startedAt), 'manual npm install time bounds invalid');
      assert(Date.parse(bareVersionCall.startedAt) >= Date.parse(npmCall.finishedAt) && Date.parse(bareVersionCall.finishedAt) >= Date.parse(bareVersionCall.startedAt), 'bare manual npm CLI version time bounds invalid');
      assert(Date.parse(bareStatusCalls[0].startedAt) >= Date.parse(bareVersionCall.finishedAt) && Date.parse(bareStatusCall.finishedAt) >= Date.parse(bareStatusCalls[0].startedAt), 'bare manual npm daemon status time bounds invalid');
      assert(Date.parse(reconcileCall.startedAt) >= Date.parse(bareStatusCall.finishedAt) && Date.parse(reconcileCall.finishedAt) >= Date.parse(reconcileCall.startedAt), 'manual npm reconciliation time bounds invalid');
      assert(Array.isArray(npmCall.argv) && npmCall.argv.includes('install') && npmCall.argv.includes('-g') && npmCall.argv.includes(`cotal-ai@${pair.followOnVersion}`));
      assert(Array.isArray(bareVersionCall.argv) && bareVersionCall.argv.at(-1) === '--version');
      assert(bareVersionCall.argv.includes(invocation.argv[0]) || bareVersionCall.file === invocation.argv[0]);
      assert(Array.isArray(reconcileCall.argv) && reconcileCall.argv.at(-2) === 'update' && reconcileCall.argv.at(-1) === '--self');
      assert(reconcileCall.argv.includes(invocation.argv[0]) || reconcileCall.file === invocation.argv[0]);
      const bare = hop.followOn?.bareNpmObservation;
      assert(bare?.commands, 'hashed bare manual npm observation missing');
      assert.match(bare.commands.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
      const fd = openSync(join(output, bare.commands.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
      let archivedBare;
      try {
        const stat = fstatSync(fd);
        assert(stat.isFile() && stat.nlink === 1 && stat.size === bare.commands.bytes && stat.size <= 524288);
        if (process.getuid) assert(stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
        const data = readFileSync(fd);
        assert.equal(hash(data), bare.commands.sha256);
        archivedBare = JSON.parse(data);
      } finally { closeSync(fd); }
      for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) {
        assert.equal(npmCall[key], hop.followOn?.npmInstall?.[key], `manual npm install ${key} differs from actual command`);
        assert.equal(bareVersionCall[key], archivedBare.version?.[key], `bare manual npm version ${key} differs from actual command`);
        assert.equal(bareStatusCall[key], archivedBare.daemonStatus?.[key], `bare manual npm daemon status ${key} differs from actual command`);
        assert.equal(reconcileCall[key], hop.followOn?.update?.[key], `manual npm reconcile ${key} differs from actual command`);
      }
      const bareDaemon = archivedBare.daemonStatus?.exit === 0 ? JSON.parse(archivedBare.daemonStatus.stdout).result : undefined;
      const bareCliHeader = String(archivedBare.version?.stdout ?? '').trim().split(/\r?\n/, 1)[0] === `cotal-ai ${pair.followOnVersion}`;
      const bareRemedy = /Reconciliation pending: Run `cotal update` to reconcile this home's extensions\./.test(String(archivedBare.version?.stdout ?? ''));
      const bareExtensionsOk = Array.isArray(archivedBare.extensions) && archivedBare.extensions.length >= 8 && archivedBare.extensions.every(entry => {
        const installed = archivedBare.installedExtensions?.find(row => row.pkg === entry.pkg);
        if (!installed || installed.version !== entry.version) return false;
        if (entry.version === pair.followOnVersion) return true;
        return entry.version === pair.targetVersion && bareRemedy;
      });
      const bareRuntimesRow = [0, 4].includes(archivedBare.runtimes?.exit) ? JSON.parse(archivedBare.runtimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
      const bareTmuxRefusedOk = [0, 4].includes(archivedBare.runtimes?.exit) && archivedBare.runtimes?.signal === null && archivedBare.runtimes?.timeout === false
        && typeof bareRuntimesRow?.error === 'string'
        && bareRuntimesRow.error.includes(`@cotal-ai/tmux is ${pair.targetVersion} and this cotal is ${pair.followOnVersion} - run \`cotal update --self\` to reconcile this installation`);
      const gateRefusal = archivedBare.launchGateRefusal;
      const gateRefusalOk = gateRefusal?.command?.exit === 1
        && gateRefusal.command.signal === null
        && gateRefusal.command.timeout === false
        && /run `cotal update --self` to reconcile this installation/.test(String(gateRefusal.command.stdout ?? '') + String(gateRefusal.command.stderr ?? ''))
        && Array.isArray(gateRefusal.extensions)
        && gateRefusal.extensions.some(entry => entry.pkg === '@cotal-ai/tmux' && entry.version === pair.targetVersion)
        && Array.isArray(gateRefusal.installedExtensions)
        && gateRefusal.installedExtensions.some(entry => entry.pkg === '@cotal-ai/tmux' && entry.version === pair.targetVersion);
      const gateReconcile = archivedBare.launchGateReconcile;
      const gateReconcileHeader = String(gateReconcile?.version?.stdout ?? '').trim().split(/\r?\n/, 1)[0] === `cotal-ai ${pair.followOnVersion}`;
      const gateTmuxRow = gateReconcile?.runtimes?.exit === 0 ? JSON.parse(gateReconcile.runtimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
      const gateReconcileOk = clean(gateReconcile?.version) && gateReconcileHeader
        && !/Reconciliation pending/.test(String(gateReconcile?.version?.stdout ?? ''))
        && clean(gateReconcile?.runtimes)
        && gateTmuxRow?.state === 'installed' && gateTmuxRow?.package === '@cotal-ai/tmux' && gateTmuxRow?.error === null
        && Array.isArray(gateReconcile?.extensions) && gateReconcile.extensions.length >= 8
        && gateReconcile.extensions.every(entry => entry.version === pair.followOnVersion && gateReconcile.installedExtensions?.find(row => row.pkg === entry.pkg)?.version === pair.followOnVersion);
      const scheduled = archivedBare.scheduledReconcile;
      const scheduledHeader = String(scheduled?.version?.stdout ?? '').trim().split(/\r?\n/, 1)[0] === `cotal-ai ${pair.followOnVersion}`;
      const scheduledTmuxRow = scheduled?.runtimes?.exit === 0 ? JSON.parse(scheduled.runtimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
      const scheduledOk = /Reconciliation pending: Run `cotal update` to reconcile this home's extensions\./.test(String(scheduled?.pendingBefore?.stdout ?? ''))
        && scheduled?.attempt?.version === pair.followOnVersion
        && scheduled?.attempt?.result === `updated to ${pair.followOnVersion}`
        && clean(scheduled?.version) && scheduledHeader
        && !/Reconciliation pending/.test(String(scheduled?.version?.stdout ?? ''))
        && clean(scheduled?.runtimes)
        && scheduledTmuxRow?.state === 'installed' && scheduledTmuxRow?.package === '@cotal-ai/tmux' && scheduledTmuxRow?.error === null
        && Array.isArray(scheduled?.extensions) && scheduled.extensions.length >= 8
        && scheduled.extensions.every(entry => entry.version === pair.followOnVersion && scheduled.installedExtensions?.find(row => row.pkg === entry.pkg)?.version === pair.followOnVersion);
      bareManualNpm = clean(archivedBare.version) && bareCliHeader
        && archivedBare.route?.updateRoute === 'in-place'
        && archivedBare.route?.selectedCliVersion === pair.followOnVersion
        && archivedBare.route?.packageManagerRecordVersion === pair.followOnVersion
        && clean(archivedBare.daemonStatus) && bareDaemon?.state === 'ready' && bareDaemon?.version === pair.followOnVersion
        && archivedBare.recovery === null
        && bareExtensionsOk
        && bareTmuxRefusedOk
        && gateRefusalOk
        && gateReconcileOk
        && scheduledOk;
      followOnSuccess = clean(hop.followOn?.npmInstall) && bareManualNpm && clean(hop.followOn?.update);
    } else {
      assert.equal(report.layout, 'installer');
      const installerCalls = report.calls.filter(row => row.label === 'candidate follow-on source installer');
      assert.equal(installerCalls.length, 1, 'follow-on installer call missing or duplicated');
      const installerCall = installerCalls[0];
      assert(Date.parse(installerCall.startedAt) >= captured && Date.parse(installerCall.finishedAt) >= Date.parse(installerCall.startedAt), 'follow-on installer time bounds invalid');
      assert(Array.isArray(installerCall.argv) && installerCall.argv.includes('--version') && installerCall.argv.includes(pair.followOnVersion));
      assert.equal(report.candidateInstaller?.source, cell.sourceSHA);
      for (const key of ['exit', 'signal', 'timeout', 'stdout', 'stderr']) assert.equal(installerCall[key], hop.followOn?.update?.[key], `follow-on installer ${key} differs from actual command`);
      followOnSuccess = clean(hop.followOn?.update);
    }
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
    const middleLabels = ['between hops public daemon status', 'between hops public update check',
      ...report.calls.filter(row => row.label === 'between hops hosted Manager status' || /^between hops hosted Manager status retry [1-9][0-9]*$/.test(row.label)).map(row => row.label), 'between hops hosted Manager seats'];
    assert.deepEqual(between.map(row => row.label), middleLabels, 'only read-only whole-state observations may occur between hosted hops');
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
  return {sourceIdentity: true, firstRefusal, intermediateWhole, nextHopSuccess: nextHopSuccess && final.passed && managerRestored !== false && followOnSuccess !== false && stoppedDaemonBeforeUpdate !== false && disabledDaemonBeforeUpdate !== false && stoppedDesktopBesideCli !== false, ...(stoppedDaemonBeforeUpdate === undefined ? {} : {stoppedDaemonBeforeUpdate}), ...(disabledDaemonBeforeUpdate === undefined ? {} : {disabledDaemonBeforeUpdate}), ...(stoppedDesktopBesideCli === undefined ? {} : {stoppedDesktopBesideCli}), ...(followOnSuccess === undefined ? {} : {followOnSuccess: followOnSuccess && final.passed}), ...(bareManualNpm === undefined ? {} : {bareManualNpm}), ...(managerRestored === undefined ? {} : {hostedManagerRestored: managerRestored})};
}
