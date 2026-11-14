import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, rawRoot, targetVersion] = process.argv.slice(2);
if (process.platform !== 'win32' || !['prepare', 'finish', 'abort'].includes(mode) || !rawRoot || !/^\d+\.\d+\.\d+$/.test(targetVersion ?? '')) throw new Error('Unsupported installer service invocation.');
const root = resolve(rawRoot);
for (const key of Object.keys(process.env)) if (key.startsWith('COTAL_')) delete process.env[key];
process.env.COTAL_SKIP_CONNECTOR_SEED = '1';
process.env.COTAL_TELEMETRY = 'off';
const directory = join(process.env.LOCALAPPDATA, 'CotalSetup');
mkdirSync(directory, { recursive: true });
const stateFile = join(directory, 'service-update.json');
const resultFile = join(directory, 'result.json');
const messageFile = join(directory, 'message.txt');
const script = fileURLToPath(new URL('service-task.ps1', import.meta.url));
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = { ...process.env, COTAL_SETUP_ROOT: root, COTAL_SETUP_VERSION: targetVersion };
const write = (file, value) => { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(value)}\n`); renameSync(temp, file); };
const task = action => {
  try { return JSON.parse(execFileSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })); }
  catch (error) { throw new Error(`The owned task could not complete ${action}: ${String(error.stderr ?? error.message).trim()}`); }
};
let state;
let socket;
let modules;
let prepared = false;
let committed = false;
let paused = false;
function outcome(code, message, name = code === 0 ? 'updated' : 'refused', activeAgents = 0) {
  message = message.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 1800);
  write(resultFile, { schema: 1, outcome: name, code, message, activeAgents, fromVersion: state?.oldVersion ?? null, toVersion: targetVersion, completedAt: new Date().toISOString() });
  writeFileSync(messageFile, `${message}\r\n`);
  process.stdout.write(`${message}\n`);
  process.exitCode = code;
}
async function load() {
  process.argv = [process.execPath, join(root, 'runtime', 'dist', 'cotal.js')];
  process.execArgv = [];
  const get = name => import(pathToFileURL(join(root, 'runtime', 'dist', 'daemon', `${name}.js`)).href);
  const [endpoint, client, lifetime] = await Promise.all(['endpoint', 'client', 'lifetime'].map(get));
  return modules = { endpoint, client, lifetime, paths: endpoint.daemonPaths() };
}
async function request(op, commit = false) {
  const id = randomUUID().replaceAll('-', '');
  const pending = modules.client.readLine(socket, op === 'daemon-stop' && !commit ? 70_000 : 25_000);
  socket.write(`${JSON.stringify({ v: 1, id, op, ...(commit ? { commit: true } : {}) })}\n`);
  const response = JSON.parse(await pending);
  if (response.v !== 1 || response.id !== id || typeof response.ok !== 'boolean' || response.event) throw new Error('The pinned service returned an invalid reply.');
  if (!response.ok) {
    const error = new Error(response.error?.message ?? 'The service refused setup.');
    error.code = response.error?.code;
    throw error;
  }
  return response.result;
}
async function absent() {
  try { const probe = await modules.client.openVerified({ paths: modules.paths, timeoutMs: 1000 }); probe.destroy(); return false; }
  catch (error) { if (error instanceof modules.endpoint.EndpointRefusal && error.code === 'NOT_RUNNING') return true; throw error; }
}
async function waitDead() {
  const deadline = Date.now() + 130_000;
  do {
    // Never connect to a closing listener whose lifetime record may already be empty.
    if (modules.lifetime.processBirth(state.oldPid) !== state.oldBirth && await absent()) {
      const native = task('inspect');
      if (!native.enabled && native.instances === 0) return;
    }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('The old service did not confirm shutdown within 130 seconds. Run cotal daemon start before retrying setup.');
}
function census(servicePid) {
  const rows = task('census').processes;
  const service = rows.find(row => row.pid === servicePid);
  const launcher = service && rows.find(row => row.pid === service.parentPid && row.path.toLowerCase() === join(root, 'cotal-desktop.exe').toLowerCase());
  const allowed = new Set([process.pid, servicePid, launcher?.pid]);
  // GUI launchers and their bounded bridge children belong to the app tree.
  for (const row of rows) if (row.path.toLowerCase() === join(root, 'cotal-desktop.exe').toLowerCase()) allowed.add(row.pid);
  let changed;
  do {
    changed = false;
    for (const row of rows) if (allowed.has(row.parentPid) && !allowed.has(row.pid)) { allowed.add(row.pid); changed = true; }
  } while (changed);
  const foreign = rows.filter(row => !allowed.has(row.pid));
  if (foreign.length) throw new Error(`Close programs using this installation before retrying: ${foreign.map(row => `${row.name} (${row.pid})`).join(', ')}. No files were replaced.`);
}
async function finish(rollback = false) {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (state.schema !== 1 || state.installPath !== root || state.targetVersion !== targetVersion || !['preparing', 'copying', 'ready'].includes(state.phase)) throw new Error('The setup handover is missing, invalid or belongs to another installation. Run the installer again.');
  const native = task('inspect');
  if (Boolean(native.installed) !== state.installed || state.installed && native.receiptDigest !== state.receiptDigest) throw new Error('The owned installation changed during setup. No task was started.');
  const version = JSON.parse(readFileSync(join(root, 'runtime', 'package.json'), 'utf8')).version;
  if (version !== (rollback ? state.oldVersion : targetVersion)) throw new Error('The installed version does not match the setup handover. Run the installer again.');
  if (!rollback) {
    const manifest = JSON.parse(readFileSync(join(root, 'runtime', 'desktop-runtime.json'), 'utf8'));
    if (manifest.version !== targetVersion || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('The replacement runtime inventory is invalid. Run the installer again.');
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || file.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('The replacement runtime inventory contains an invalid path or digest.');
      const bytes = readFileSync(join(root, 'runtime', file.path));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`The replacement runtime is incomplete at ${file.path}. Run the installer again.`);
    }
  }
  state.phase = 'ready';
  write(stateFile, state);
  if (state.installed && state.taskEnabled) task('enable');
  if (state.running) {
    task('start');
    await load();
    const deadline = Date.now() + 60_000;
    do {
      try {
        const reply = await modules.client.queryDaemon({ paths: modules.paths, timeoutMs: 1000 });
        if (reply.ok && reply.result.version === version && reply.result.state === 'ready') {
          rmSync(stateFile);
          outcome(0, rollback ? 'Setup cancelled. The previous background service is running.' : `Cotal ${version} is installed and its background service is running.`, rollback ? 'cancelled' : 'updated');
          return;
        }
      } catch (error) {
        if (!(error instanceof modules.endpoint.EndpointRefusal && error.code === 'NOT_RUNNING')) throw error;
      }
      await delay(500);
    } while (Date.now() < deadline);
    rmSync(stateFile);
    outcome(23, `Cotal ${version} is installed and service startup was requested, but readiness was not confirmed within 60 seconds. Check cotal daemon status.`, 'started-unconfirmed');
    return;
  }
  rmSync(stateFile);
  outcome(0, state.foreign ? `Cotal ${version} is installed. The service from another installation was left unchanged.` : state.installed ? `Cotal ${version} is installed. The background service remains stopped.` : `Cotal ${version} is installed. No background service was installed.`);
}
try {
  if (mode === 'finish' || mode === 'abort') {
    if (mode === 'abort' && !existsSync(stateFile)) { outcome(0, 'Setup cancelled. No service state changed.', 'cancelled'); }
    else await finish(mode === 'abort');
  } else {
    if (existsSync(stateFile)) throw new Error('An interrupted setup must be recovered by the installer before loading installed commands.');
    const native = task('inspect');
    const oldVersion = existsSync(join(root, 'runtime', 'package.json')) ? JSON.parse(readFileSync(join(root, 'runtime', 'package.json'), 'utf8')).version : null;
    state = { schema: 1, installPath: root, targetVersion, oldVersion, installed: native.installed, foreign: native.foreign ?? false, receiptDigest: native.receiptDigest ?? null, taskEnabled: native.enabled ?? false, running: false, phase: 'preparing' };
    if (native.installed) {
      await load();

      try { socket = await modules.client.openVerified({ paths: modules.paths }); }
      catch (error) { if (!(error instanceof modules.endpoint.EndpointRefusal && error.code === 'NOT_RUNNING')) throw error; }
      socket?.on('error', () => {});
      if (socket) {
        const status = await request('status');
        state.oldVersion = status.version;
        state.oldPid = status.pid;
        state.oldBirth = modules.lifetime.processBirth(status.pid);
        if (!state.oldBirth || !native.enabled) throw new Error('The service lifetime or enabled state could not be confirmed.');
        census(status.pid);
        prepared = true;
        await request('managers-prepare-restart');
        // Unsupported old versions refuse rather than substituting task termination.
        await request('daemon-stop');
        state.running = true;
      } else {
        census();
        if (native.instances !== 0) throw new Error('A native service instance exists without a readable listener. Run cotal daemon start and retry setup.');
      }
      write(stateFile, state);
      paused = true;
      task('disable');
      if (socket) {
        committed = true;
        await request('daemon-stop', true);
        socket.destroy(); socket = undefined;
        await waitDead();
      }
    } else census();
    state.phase = 'copying';
    write(stateFile, state);
    process.stdout.write('Background service prepared. Setup can replace the files.\n');
  }
} catch (error) {
  const active = error.code === 'SEATS_ACTIVE' ? Number(/holds (\d+) active seat/.exec(error.message)?.[1] ?? 1) : 0;
  let recovery = '';
  try {
    if (prepared && !committed && socket) await request('managers-abort-restart');
    if (paused && !committed && state.taskEnabled) task('enable');
    if (!committed && state?.phase === 'preparing') rmSync(stateFile, { force: true });
    if (committed && mode === 'prepare') { await waitDead(); await finish(true); recovery = ' The previous service was restored.'; }
  } catch (rollback) { recovery = ` Recovery was not confirmed: ${rollback.message}. Run the installer again.`; }
  const unsupported = error.code === 'UNKNOWN_OP' ? ' This older service has no graceful stop request. After stopping its agents, run cotal daemon uninstall --yes with the old installed CLI, then run setup again.' : '';
  outcome(active ? 20 : committed ? 22 : 21, `${active ? `${active} agent(s) are running. Stop them and choose Retry. ` : ''}${error.message}${unsupported}${recovery}`,'refused',active);
} finally { socket?.destroy(); }
