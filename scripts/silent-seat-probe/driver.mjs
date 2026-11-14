import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { observeAfterStop, retainProcess } from './process-observation.mjs';

assert.equal(process.platform, 'win32', 'Windows-only measurement, not a Linux simulation');
const [rootArg, evidenceArg, mode] = process.argv.slice(2);
assert(rootArg && evidenceArg && ['silent', 'output'].includes(mode), 'usage: driver <repo> <evidence> silent|output');
const root = resolve(rootArg);
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(evidence, `${mode}-`));
const home = join(dir, 'home');
const ws = join(dir, 'workspace');
mkdirSync(home, { recursive: true });
mkdirSync(join(ws, '.cotal', 'agents'), { recursive: true });
for (const key of Object.keys(process.env)) {
  if (/^COTAL_/i.test(key)) delete process.env[key];
}
Object.assign(process.env, { COTAL_HOME: home, COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', XDG_CONFIG_HOME: join(home, 'xdg') });
const load = (path) => import(pathToFileURL(join(root, path)).href);
const corePath = join(root, 'packages/core/dist/index.js');
const bindingPath = join(root, 'packages/workspace/dist/win32-process.js');
const core = await load('packages/core/dist/index.js');
const workspace = await load('packages/workspace/dist/index.js');
const { Manager } = await load('implementations/manager/dist/manager.js');
const { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } = await load('packages/smoke-kit/src/index.ts');
const { bootDeliveryDaemon } = await load('implementations/manager/smoke/_boot-delivery.ts');
const require = createRequire(join(root, 'package.json'));
const tsxCli = require.resolve('tsx/cli');
const binding = workspace.win32ProcessBinding();
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `silentstop-${randomUUID().slice(0, 8)}`;
const auth = await core.createSpaceAuth(space);
workspace.saveSpaceAuth(workspace.authDir(ws), auth);
writeFileSync(join(ws, '.cotal', 'agents', 'stopfixture.md'), '---\nname: stopfixture\n---\n');
const store = join(dir, SMOKE_BROKER_TOKEN);
mkdirSync(store);
const config = join(store, 'server.conf');
writeFileSync(config, core.serverConfig(auth, [auth], { transport: { kind: 'plaintext' }, port, storeDir: join(store, 'js') }));
const broker = spawn('nats-server', ['-c', config], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
broker.stderr.on('data', (data) => appendFileSync(join(dir, 'broker.log'), data));
const releaseBroker = teardownOnSignal(broker, store);
const marker = join(dir, 'seat.json');
const release = join(dir, 'release');
const childPath = join(import.meta.dirname, 'silent-child.mjs');
const shim = join(dir, 'seat.cmd');
const quoted = (text) => { assert(!/["%\r\n]/.test(text), 'unsupported fixture path character'); return `"${text}"`; };
writeFileSync(shim, `@echo off\r\n${mode === 'output' ? 'echo COTAL_STOP_READY\r\n' : ''}${[process.execPath, childPath, 'seat', marker, corePath, bindingPath, release].map(quoted).join(' ')} 1>${quoted(join(dir, 'seat.log'))} 2>&1\r\n`);
core.registry.register({
  kind: 'connector', name: 'silent-stop-fixture', requires: ['node'],
  buildLaunch(o) {
    const env = { ...process.env, COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_ID: o.id, COTAL_NAME: o.name };
    assert(o.creds, 'static fixture credentials required');
    env.COTAL_CREDS = o.creds;
    if (o.lifecycleUid) env.COTAL_LIFECYCLE_UID = o.lifecycleUid;
    return { command: shim, args: [], env };
  },
});
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (...args) => {
  appendFileSync(join(dir, 'manager.log'), args[0]);
  return originalStderrWrite(...args);
};
const mgr = new Manager({ space, servers, workspaceRoot: ws, runtime: 'pty' });
const retained = [];
let delivery;
let handle;
let terminalBytes = 0;
let unsubscribe;
const result = { mode, space, dir, sourceHead: process.env.GITHUB_SHA ?? null, observations: [], cleanup: [] };
const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
const until = async (predicate, description, ms = 60000) => {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error(`fixture setup did not reach ${description}`);
};
async function cotal(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(root, 'bin/cotal.ts'), ...args], {
      cwd: ws, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exit, signal) => { clearTimeout(timer); resolveRun({ args, exit, signal, timedOut, stdout, stderr }); });
  });
}
try {
  await until(() => core.isReachable(servers), 'broker');
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), 'provisioner') });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(ws).identity });
  workspace.recordMesh({ space, server: servers, root: ws, mode: 'auth', ts: new Date().toISOString() });
  await mgr.start();
  // Transparent instance-local observer. The unmodified runtime performs every launch and stop.
  const runtime = mgr.runtime;
  assert(runtime && typeof runtime.spawn === 'function', 'Manager runtime observer seam unavailable');
  const originalSpawn = runtime.spawn.bind(runtime);
  runtime.spawn = (...args) => {
    handle = originalSpawn(...args);
    unsubscribe = handle.attach().onData((data) => { terminalBytes += data.length; appendFileSync(join(dir, 'terminal.bin'), data); });
    return handle;
  };
  result.spawn = await mgr.startAgent({ name: 'stopfixture', agent: 'silent-stop-fixture', cwd: ws, events: false });
  save();
  assert.equal(result.spawn.ok, true, JSON.stringify(result.spawn));
  await until(() => existsSync(marker) && existsSync(`${marker}.descendant`) && handle?.pid > 0, 'seat and descendant identity markers');
  const identities = [
    { role: 'root', pid: handle.pid, token: binding.creationToken(handle.pid) },
    JSON.parse(readFileSync(marker, 'utf8')),
    JSON.parse(readFileSync(`${marker}.descendant`, 'utf8')),
  ];
  for (const identity of identities) retained.push(retainProcess(binding, identity));
  result.before = retained.map((pin) => pin.observe());
  assert(result.before.every((row) => !row.exited), 'fixture processes must all be alive before stop');
  await delay(500);
  result.terminalBytesBeforeStop = terminalBytes;
  assert(mode === 'silent' ? terminalBytes === 0 : terminalBytes > 0, 'terminal output control mismatch');
  result.stop = await cotal(['stop', 'stopfixture', '--space', space, '--on', mgr.managerInstanceId]);
  const completed = performance.now();
  save();
  assert(!result.stop.timedOut && !result.stop.signal && result.stop.exit !== null, 'stop fixture failed to complete normally');
  await observeAfterStop(retained, completed, (row) => { result.observations.push(row); save(); });
  result.terminalBytesAfterStop = terminalBytes;
  result.runtime = { status: handle.status(), exit: handle.exitInfo?.() ?? null };
  result.preservation = await mgr.preparePreservation(randomUUID());
  result.productStopEndedTree = result.observations.at(-1).processes.every((row) => row.exited);
  save();
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
  save();
} finally {
  // This explicit fixture-only release happens AFTER product observations, even on red.
  writeFileSync(release, 'release-owned-fixture');
  for (const pin of retained) {
    try { await until(() => pin.observe().exited, `cleanup of owned ${pin.identity.role}`, 10000); result.cleanup.push({ ...pin.observe(), via: 'fixture-release' }); }
    catch (error) { result.cleanup.push({ identity: pin.identity, error: String(error) }); process.exitCode = 1; }
  }
  unsubscribe?.();
  try { await mgr.stop(); } catch (error) { result.managerCleanupError = String(error); process.exitCode = 1; }
  await delivery?.stop();
  await killAndAwaitExit(broker);
  if (broker.exitCode !== null || broker.signalCode !== null) releaseBroker();
  else { result.brokerCleanupError = 'broker exit was not proved; ownership registration retained'; process.exitCode = 1; }
  for (const pin of retained) pin.close();
  process.stderr.write = originalStderrWrite;
  save();
}
console.log(JSON.stringify({ dir, productStopEndedTree: result.productStopEndedTree, error: result.error ?? null }));
