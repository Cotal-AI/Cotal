import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument } from 'yaml';
import { privateChildEnv, requestState, runController, transition, waitForResume, windowsJourneyCheckpoint } from './windows-journey.mjs';

const workflow = parseDocument(readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8'));

test('workflow has two 12-minute Windows phases and retains other platform checks', () => {
  assert.deepEqual(workflow.errors, []);
  const job = workflow.toJS().jobs['native-build'];
  assert.equal(job['timeout-minutes'], 150, 'job includes the separately bounded PowerShell diagnostic');
  const steps = job.steps;
  const phases = steps.filter(step => /windows-journey.mjs (start|resume)/.test(step.run ?? ''));
  assert.equal(phases.length, 2);
  assert.equal(phases[0].env?.COTAL_DAEMON_SMOKE_TMP, '${{ runner.temp }}', 'private fixture scratch must avoid the longer profile temp prefix');
  assert.deepEqual(phases.map(step => step['timeout-minutes']), [12, 12]);
  assert.ok(phases.every(step => step.if === "runner.os == 'Windows'"));
  assert.ok(phases.every(step => step.run.includes('desktop-windows-journey') && step.run.includes('desktop-e2e')));
  const cleanup = steps.find(step => step.run?.includes('windows-journey.mjs cancel'));
  assert.equal(cleanup.if, "always() && runner.os == 'Windows'");
  const service = steps.find(step => step.name === 'Real-window onboarding, recovery and app-installed service lifecycle');
  assert.equal(service.if, "runner.os == 'Linux'");
  assert.equal(service['timeout-minutes'], 12);
  const account = steps.find(step => step.name === 'Connected account Ready, native Settings and login-command lifecycle');
  assert.equal(account.if, "runner.os != 'Windows'");
  assert.equal(account['timeout-minutes'], 15);
  for (const step of [service, account]) {
    assert.ok(step.run.indexOf('export HOME=') < step.run.indexOf('pnpm exec tsx'));
    assert.match(step.run, /XDG_STATE_HOME=/);
  }
  const nativePeer = steps.find(step => step.name === 'Verify Windows stock peer identity observation');
  assert.equal(nativePeer.if, "runner.os == 'Windows'");
  assert.match(nativePeer.run, /windows-peer-trace-native.test.mjs/);
  assert.ok(nativePeer.run.indexOf('SetEnvironmentVariable') < nativePeer.run.indexOf('node --test'));
  const signature = steps.find(step => step.name === 'Verify the macOS bundle signature seals the whole app');
  assert.match(signature.run, /codesign --verify --deep --strict/);
  assert.match(signature.run, /com.apple.quarantine/);
  const artifacts = steps.filter(step => step.uses?.startsWith('actions/upload-artifact'));
  assert.ok(artifacts.every(step => !step.with.path.includes('desktop-windows-journey')));
});

test('short scratch parent survives private environments while the fixture still creates unique roots', () => {
  const inherited = { COTAL_DAEMON_SMOKE_TMP: 'D:\\a\\_temp', USERPROFILE: 'C:\\Users\\runner' };
  const controller = privateChildEnv('/private/controller', inherited);
  for (const phase of ['outer-service', 'outer-account']) {
    const child = privateChildEnv(`/private/${phase}`, controller);
    assert.equal(child.COTAL_DAEMON_SMOKE_TMP, inherited.COTAL_DAEMON_SMOKE_TMP);
    assert.equal(child.USERPROFILE, inherited.USERPROFILE);
    assert.equal(child.HOME, join(`/private/${phase}`, 'home'));
  }
  const fixture = readFileSync(new URL('../../bin/smoke/daemon-service-connect.smoke.ts', import.meta.url), 'utf8');
  assert.match(fixture, /const scratchParent = process\.env\.COTAL_DAEMON_SMOKE_TMP \?\? tmpdir\(\)/);
  assert.match(fixture, /const root = realpathSync\(mkdtempSync\(join\(scratchParent, [^\n]+"cdr-"\)\)\)/);
});

test('real firstRun pauses after kernel recovery and preserves all tail and cleanup assertions', () => {
  const source = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ windowsJourneyCheckpoint \} from ["']\.\/windows-journey\.mjs["']/);
  const recovery = source.indexOf('await proveWindowsRestart(true)');
  const checkpoint = source.indexOf("await windowsJourneyCheckpoint('service-recovery-complete')");
  const doubleQuoted = source.indexOf('await windowsJourneyCheckpoint("service-recovery-complete")');
  const gate = checkpoint === -1 ? doubleQuoted : checkpoint;
  assert.ok(recovery > 0 && gate > recovery && gate < source.indexOf('await installApplication()', recovery));
  for (const retained of [
    'deep link prefills public coordinates without approval or connect', 'sign-in cannot connect',
    'cleanup removes app-installed service', 'native supervisor reports app service absent',
    'cleanup restores original account User PATH', 'account sign-in registers this computer without enabling a space',
    'native login command relaunch keeps connected window hidden', 'processBirth(lifetime.pid)',
    'setup preserves the owned installation source and receipt', 'real Windows native profile',
  ]) assert.ok(source.includes(retained), retained);
});

test('only the service recovery checkpoint admits a continuation, with no replay', () => {
  assert.equal(transition('service-recovery', 'service-recovery-complete'), 'paused');
  assert.equal(transition('paused', 'resume'), 'service-tail');
  assert.equal(transition('service-tail', 'account'), 'account');
  assert.equal(transition('paused', 'cancel'), 'cancelling');
  for (const [state, action] of [['service-recovery', 'resume'], ['service-tail', 'resume'], ['paused', 'account'], ['done', 'cancel']]) {
    assert.throws(() => transition(state, action), /Invalid Windows journey transition/);
  }
});

test('checkpoint waits, cancel/disconnect/watchdog reject through normal finally', async () => {
  for (const outcome of ['resume', 'cancel', 'disconnect', 'timeout']) {
    const channel = new EventEmitter();
    let sent;
    channel.send = row => { sent = row; };
    let cleaned = false;
    const result = (async () => {
      try { await waitForResume(channel, 'service-recovery-complete', 20); }
      finally { cleaned = true; }
    })();
    assert.deepEqual(sent, { kind: 'checkpoint', phase: 'service-recovery-complete' });
    if (outcome === 'resume') channel.emit('message', { kind: outcome, phase: 'service-recovery-complete' });
    else if (outcome === 'cancel') channel.emit('message', { kind: outcome });
    else if (outcome === 'disconnect') channel.emit('disconnect');
    if (outcome === 'resume') await result;
    else await assert.rejects(result, /running fixture cleanup/);
    assert.equal(cleaned, true);
    assert.equal(channel.listenerCount('message'), 0);
    assert.equal(channel.listenerCount('disconnect'), 0);
  }
  await windowsJourneyCheckpoint('service-recovery-complete'); // Unsplit Linux/macOS entrypoints stay unchanged.
});

async function controllerFixture(t, { cancel = false, failService = false, failAccount = false, cancelAccount = false, cell } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'journey-contract-'));
  const directory = join(root, 'private'), output = join(root, 'observations');
  mkdirSync(output);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launches = [], events = [];
  let reachCheckpoint;
  const spawnFixture = (_node, args, options) => {
    launches.push(args);
    assert.equal(options.stdio[3], 'ipc');
    for (const key of ['HOME', 'COTAL_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) assert.ok(options.env[key].startsWith(directory));
    assert.equal(options.env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(options.env.APPDATA, process.env.APPDATA);
    assert.equal(options.env.LOCALAPPDATA, process.env.LOCALAPPDATA);
    assert.equal(options.env.COTAL_DAEMON_SMOKE_TMP, process.env.COTAL_DAEMON_SMOKE_TMP);
    const channel = new EventEmitter();
    channel.connected = true;
    channel.pid = 12345;
    channel.send = row => {
      events.push(row.kind);
      channel.emit('message', { kind: 'progress', phase: 'cleanup-driver-close', status: 'start' });
      setImmediate(() => {
        channel.emit('message', { kind: 'progress', phase: 'cleanup-driver-close', status: 'complete' });
        events.push('service-cleanup');
        channel.emit('exit', row.kind === 'cancel' || failService ? 1 : 0, null);
      });
    };
    if (args.includes('--desktop-account')) setImmediate(() => {
      events.push('account-start');
      assert.ok(events.includes('service-cleanup'));
      if (!cancelAccount) channel.emit('exit', failAccount ? 1 : 0, null);
    });
    else reachCheckpoint = () => {
      channel.emit('message', { kind: 'progress', phase: 'recovery-settled', status: 'start' });
      channel.emit('message', { kind: 'progress', phase: 'recovery-progress-read', status: 'start' });
      channel.emit('message', { kind: 'progress', phase: 'recovery-progress-read', status: 'complete' });
      channel.emit('message', { kind: 'checkpoint', phase: 'service-recovery-complete' });
    };
    return channel;
  };
  const running = runController(directory, output, { spawnFixture, retainMs: 5, cell });
  const stateFile = join(directory, 'controller.json');
  let state;
  for (let n = 0; n < 100; n++) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); break; } catch { await delay(5); }
  }
  assert.ok(state, 'controller publishes protected state');
  assert.deepEqual(Object.keys(state).sort(), ['pid', 'port', 'schema', 'token']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  }
  await assert.rejects(requestState(state, 'resume'), /refused/);
  await assert.rejects(requestState(state, 'unknown'));
  assert.equal((await requestState(state, 'status')).state, 'service-recovery');
  reachCheckpoint();
  const paused = await requestState(state, 'status');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.ownership.fixturePid, 12345);
  assert.equal(paused.ownership.cleanupStarted, false);
  assert.deepEqual(paused.ownership.waitingOn.map(row => row.phase), ['recovery-settled']);
  const live = readFileSync(join(output, 'windows-journey-phases.jsonl'), 'utf8');
  assert.match(live, /recovery-settled/, 'wait evidence is durable before fixture exit');
  await assert.rejects(requestState({ ...state, token: '0'.repeat(64) }, 'resume'), /refused/);
  await assert.rejects(requestState({ ...state, fixtureSecret: 'not accepted' }, 'resume'));
  await requestState(state, cancel ? 'cancel' : 'resume');
  if (cancelAccount) {
    for (let n = 0; n < 100 && (await requestState(state, 'status')).state !== 'account'; n++) await delay(5);
    await requestState(state, 'cancel');
  }
  await running;
  const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  const records = readFileSync(join(output, 'windows-journey-phases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.every(row => row.schema === 1 && Number.isFinite(Date.parse(row.at)) && row.elapsedMs >= 0));
  assert.ok(!JSON.stringify(records).includes(state.token));
  return { result, launches, events, records };
}

test('controller preserves live owner and waits for service cleanup before account, retaining phase timings', async t => {
  const proof = await controllerFixture(t);
  assert.equal(proof.result.code, 0);
  assert.equal(proof.launches.length, 2);
  assert.ok(proof.launches[0].includes('--desktop-service-phase'));
  assert.ok(proof.launches[1].includes('--desktop-account'));
  assert.ok(!proof.launches[1].includes('--desktop-service-phase'));
  assert.deepEqual(proof.records.filter(row => row.kind === 'start').map(row => row.phase), ['service-recovery', 'paused', 'service-tail', 'account']);
});

for (const cell of ['before-poll', 'after-poll']) {
  test(`diagnostic ${cell} only runs the service fixture and retains its receipt`, async t => {
    const proof = await controllerFixture(t, { cell });
    assert.equal(proof.result.code, 0);
    assert.equal(proof.launches.length, 1);
    assert.ok(proof.launches[0].includes(`--desktop-recovery-cell=${cell}`));
    assert.ok(proof.records.some(row => row.kind === 'diagnostic-cell-complete' && row.cell === cell));
  });
}

test('unknown diagnostic cell rejects before starting any fixture', async () => {
  await assert.rejects(runController('unused', 'unused', { cell: 'unknown', spawnFixture: () => assert.fail('must not spawn') }), /unknown Windows recovery diagnostic cell/);
});

for (const failure of ['cancel', 'failService', 'failAccount', 'cancelAccount']) {
  test(`controller retains nonzero ${failure} and does not start account after cancelled/failed service`, async t => {
    const proof = await controllerFixture(t, { [failure]: true });
    assert.equal(proof.result.code, 1);
    assert.equal(proof.launches.length, ['failAccount', 'cancelAccount'].includes(failure) ? 2 : 1);
    assert.ok(proof.events.includes('service-cleanup'));
    assert.ok(proof.records.some(row => row.kind === 'fixture-progress' && row.cleanupStarted));
    if (failure === 'cancel') {
      const receipt = proof.records.find(row => row.kind === 'cancel-wait');
      assert.equal(receipt.cleanupStarted, false, 'cancel does not claim finally has started');
      assert.deepEqual(receipt.waitingOn.map(row => row.phase), ['recovery-settled']);
    }
  });
}
