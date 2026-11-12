import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = fileURLToPath(import.meta.url);
const repo = resolve(dirname(here), '../..');
const checkpoint = 'service-recovery-complete';
const phaseFlag = '--desktop-service-phase';
const requestTimeout = 5_000;

/** Keep the live authority, native driver and receipt owner in the same fixture process. */
export async function windowsJourneyCheckpoint(phase) {
  if (!process.argv.includes(phaseFlag)) return;
  assert.equal(process.platform, 'win32', 'split desktop journey is Windows only');
  assert.equal(phase, checkpoint);
  assert.equal(typeof process.send, 'function', 'split desktop journey requires private IPC');
  await waitForResume(process, phase);
}

export function waitForResume(channel, phase, timeoutMs = 90_000) {
  assert.equal(phase, checkpoint);
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      channel.off('message', message);
      channel.off('disconnect', disconnected);
      if (error) reject(error); else resolve();
    };
    const message = row => {
      if (row?.kind === 'resume' && row.phase === phase) finish();
      else if (row?.kind === 'cancel') finish(new Error('Windows journey cancelled, running fixture cleanup'));
    };
    const disconnected = () => finish(new Error('Windows journey controller disconnected, running fixture cleanup'));
    const timer = setTimeout(() => finish(new Error('Windows journey checkpoint expired, running fixture cleanup')), timeoutMs);
    channel.on('message', message);
    channel.once('disconnect', disconnected);
    channel.send({ kind: 'checkpoint', phase });
  });
}

/** A closed transition set prevents replay from starting another fixture or skipping a phase. */
export function transition(state, action) {
  if (action === 'cancel' && state !== 'done') return 'cancelling';
  if (state === 'service-recovery' && action === checkpoint) return 'paused';
  if (state === 'paused' && action === 'resume') return 'service-tail';
  if (state === 'service-tail' && action === 'account') return 'account';
  throw new Error(`Invalid Windows journey transition: ${state} / ${action}`);
}

export async function requestState(state, action) {
  assert.deepEqual(Object.keys(state).sort(), ['pid', 'port', 'schema', 'token']);
  assert.equal(state.schema, 1);
  assert.ok(Number.isInteger(state.pid) && state.pid > 0);
  assert.ok(Number.isInteger(state.port) && state.port > 0 && state.port < 65536);
  assert.match(state.token, /^[a-f0-9]{64}$/);
  assert.ok(['status', 'resume', 'cancel'].includes(action));
  const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(requestTimeout),
  });
  assert.equal(response.status, 200, `Windows journey controller refused ${action}`);
  return response.json();
}

export function privateChildEnv(directory, inherited = process.env) {
  return { ...inherited, HOME: join(directory, 'home'), COTAL_HOME: join(directory, 'cotal'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_RUNTIME_DIR: join(directory, 'runtime') };
}

export async function runController(directory, output, { spawnFixture = spawn, retainMs = 10_000 } = {}) {
  const { mkSecretDir, writeSecretFileAtomic } = await import('@cotal-ai/core');
  mkSecretDir(directory);
  const token = randomBytes(32).toString('hex');
  let state = 'service-recovery', code = null, child, cancelled = false;
  let phaseStarted = Date.now();
  const timings = join(output, 'windows-journey-phases.jsonl');
  const record = (kind, detail = {}) => appendFileSync(timings, `${JSON.stringify({ schema: 1, at: new Date().toISOString(), phase: state, elapsedMs: Date.now() - phaseStarted, kind, ...detail })}\n`);
  const move = action => { const next = transition(state, action); record('complete'); state = next; phaseStarted = Date.now(); record('start'); };
  const cancel = () => {
    if (state === 'done' || cancelled) return;
    cancelled = true;
    move('cancel');
    if (child?.connected) child.send({ kind: 'cancel' });
    // Do not kill the fixture or a native service. Its original finally owns uninstall/PATH cleanup.
  };
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(403); res.end(); return;
    }
    try {
      if (req.url === '/resume') {
        move('resume');
        assert.ok(child?.connected, 'fixture IPC disconnected');
        child.send({ kind: 'resume', phase: checkpoint });
      } else if (req.url === '/cancel') cancel();
      else assert.equal(req.url, '/status');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ schema: 1, state, code, cancelled }));
    } catch {
      res.writeHead(409); res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  writeSecretFileAtomic(join(directory, 'controller.json'), JSON.stringify({ schema: 1, pid: process.pid, port: server.address().port, token }));
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  const run = flags => new Promise((resolve, reject) => {
    const env = privateChildEnv(join(directory, state === 'account' ? 'outer-account' : 'outer-service'));
    for (const key of ['HOME', 'COTAL_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) mkSecretDir(env[key]);
    child = spawnFixture(process.execPath, ['--import', 'tsx', 'bin/smoke/daemon-service-connect.smoke.ts', '--desktop-window', '--keep-fixture', ...flags], {
      cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    });
    child.on('message', row => {
      try {
        assert.deepEqual(row, { kind: 'checkpoint', phase: checkpoint });
        if (cancelled) child.send({ kind: 'cancel' }); else move(checkpoint);
      } catch (error) { record('protocol-error', { error: String(error) }); cancel(); }
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ code: exitCode ?? 1, signal }));
  });
  record('start');
  try {
    let result = await run([phaseFlag]);
    record('fixture-exit', result);
    assert.equal(result.code, 0, 'per-space fixture failed, account fixture not started');
    assert.equal(state, 'service-tail', 'per-space fixture exited without checkpoint continuation');
    assert.equal(cancelled, false, 'journey cancelled');
    move('account');
    result = await run(['--desktop-account']);
    record('fixture-exit', result);
    assert.equal(cancelled, false, 'journey cancelled during account lifecycle');
    code = result.code;
  } catch (error) {
    code = 1;
    record('failed', { error: String(error) });
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    record('complete', { code });
    state = 'done';
    writeSecretFileAtomic(join(directory, 'result.json'), JSON.stringify({ schema: 1, state, code, cancelled }));
    // Leave the terminal response available to the waiting step before releasing the listener.
    setTimeout(() => server.close(), retainMs);
  }
}

async function command(action, directory, output) {
  assert.equal(process.platform, 'win32', 'Windows journey controller requires Windows');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'requires disposable hosted runner');
  assert.ok(directory && output);
  const { relative, isAbsolute } = await import('node:path');
  const privateRelative = relative(resolve(output), resolve(directory));
  assert.ok(privateRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(privateRelative), 'private controller state must be outside uploaded observations');
  // Fence import-time workspace/update code before loading any repo package. Keep the real
  // Windows known folders intact for GUI shell APIs. Core hardens these directories next.
  Object.assign(process.env, privateChildEnv(join(directory, 'outer-controller')));
  for (const key of ['HOME', 'COTAL_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) mkdirSync(process.env[key], { recursive: true, mode: 0o700 });
  const { mkSecretDir } = await import('@cotal-ai/core');
  mkSecretDir(directory);
  for (const key of ['HOME', 'COTAL_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) mkSecretDir(process.env[key]);
  mkSecretDir(output);
  const stateFile = join(directory, 'controller.json');
  const resultFile = join(directory, 'result.json');
  if (action === 'run') return runController(directory, output);
  assert.ok(['start', 'resume', 'cancel'].includes(action));
  if (action === 'start') {
    assert.ok(!existsSync(stateFile) && !existsSync(resultFile), 'refuse stale controller state');
    const log = openSync(join(output, 'suite.log'), 'ax', 0o600);
    try {
      const controller = spawn(process.execPath, [here, 'run', directory, output], {
        cwd: repo, detached: true, stdio: ['ignore', log, log], windowsHide: true,
      });
      await new Promise((resolve, reject) => { controller.once('spawn', resolve); controller.once('error', reject); });
      controller.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + (action === 'cancel' ? 85_000 : 600_000);
  let activated = false;
  try {
    while (Date.now() < deadline) {
      if (existsSync(resultFile)) {
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        assert.equal(result.schema, 1);
        assert.equal(result.code, 0, 'Windows journey failed, see suite and phase logs');
        assert.notEqual(action, 'start', 'fixture completed without holding the checkpoint');
        return;
      }
      if (!existsSync(stateFile)) { await delay(250); continue; }
      const controller = JSON.parse(readFileSync(stateFile, 'utf8'));
      const row = await requestState(controller, !activated && action !== 'start' ? action : 'status');
      activated = true;
      if (action === 'start' && row.state === 'paused') return;
      if (row.state === 'done') {
        assert.notEqual(action, 'start', 'fixture completed without holding the checkpoint');
        assert.equal(row.code, 0, 'Windows journey failed, see suite and phase logs');
        return;
      }
      await delay(500);
    }
    throw new Error(`Windows journey ${action} exceeded its bounded wait, cleanup not yet proven`);
  } catch (error) {
    if (action !== 'cancel' && existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        await requestState(state, 'cancel');
        const cleanupDeadline = Date.now() + 85_000;
        while (!existsSync(resultFile) && Date.now() < cleanupDeadline) await delay(500);
        console.error(existsSync(resultFile) ? 'Windows journey fixture exited after cancellation. Inspect cleanup assertions.' : 'Windows journey cleanup-outstanding: fixture owner remains live, cleanup not proven.');
      } catch { console.error('Windows journey cleanup-outstanding: controller unreachable, cleanup not proven.'); }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  command(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
