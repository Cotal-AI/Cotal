import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureDaemonDiagnostics } from './daemon-cell-diagnostics.mjs';
import { evaluateManualDaemonState } from './daemon-manual-acceptance.mjs';

async function fixture(t, { platform = 'linux', status = {}, recovery, lock } = {}) {
  const priorSystemRoot = process.env.SystemRoot;
  if (platform === 'win32') process.env.SystemRoot = 'C:\\Windows';
  t.after(() => { if (priorSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = priorSystemRoot; });
  assert.equal(process.platform, 'linux', 'these filesystem fixtures require the Linux host');
  mkdirSync('/var/tmp/upgrade-matrix', { recursive: true, mode: 0o700 });
  const home = mkdtempSync('/var/tmp/upgrade-matrix/manual-');
  const dirs = Object.fromEntries(['output', 'cotalHome', 'daemonHome', 'config', 'pkg', 'globalRoot', 'tmp'].map(key => [key, join(home, key)]));
  for (const directory of Object.values(dirs)) mkdirSync(directory, { mode: 0o700 });
  const children = new Set();
  const server = createServer(peer => { peer.destroy(); });
  server.listen(join(home, 'daemon.sock'));
  await once(server, 'listening');
  t.after(async () => {
    assert.equal(children.size, 0, 'all real runner children reaped');
    await new Promise(resolve => server.close(resolve));
    // Retain the private fixture directory. Deletion requires an ownership barrier.
  });
  const socket = lstatSync(join(home, 'daemon.sock'));
  const processStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(join(dirs.pkg, 'package.json'), { name: 'cotal-ai', version: '1.2.3' });
  write(join(dirs.daemonHome, 'daemon.lock'), { pid: process.pid, start, socket: { path: join(home, 'daemon.sock'), dev: socket.dev, ino: socket.ino } });
  if (recovery) write(join(dirs.cotalHome, 'update-recovery.json'), recovery);
  if (lock) write(join(dirs.globalRoot, '.cotal-update.lock'), lock === 'live' ? { pid: process.pid, start } : lock);
  const child = (value, bounds, exit = 0) => new Promise(resolve => {
    const proc = execFile(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify(value))});process.exitCode=${exit}`], { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, COTAL_HOME: dirs.cotalHome, XDG_CONFIG_HOME: dirs.config, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp }, timeout: bounds.timeoutMs, maxBuffer: bounds.maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      children.delete(proc);
      resolve({ exit: error ? error.code : 0, stdout, stderr });
    });
    children.add(proc);
  });
  const diagnostics = await captureDaemonDiagnostics({ ...dirs, home, platform, id: 'manual', stage: 'after-update', startedAt: new Date().toISOString(), plan: { globalRoot: dirs.globalRoot, unit: platform === 'darwin' ? 'ai.cotal.daemon' : platform === 'win32' ? 'cotal-daemon-S-1-5-21-1234' : 'cotal-daemon.service' },
    run: (file, args, bounds) => {
      const stdout = file === 'systemctl' ? `LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=${process.pid}\n`
 : file === '/bin/launchctl' ? args[0] === 'print-disabled' ? 'disabled services = {\n}\n' : `state = running\npid = ${process.pid}\nlast exit code = 0\n`
          : JSON.stringify({ Name: 'Cotal machine daemon', State: 'Running', Enabled: true, LastResult: 0 });
      return new Promise(resolve => {
        const proc = execFile(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)})`], { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, COTAL_HOME: dirs.cotalHome, XDG_CONFIG_HOME: dirs.config, TMPDIR: dirs.tmp }, timeout: bounds.timeoutMs, maxBuffer: bounds.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => { children.delete(proc); resolve({ exit: error ? error.code : 0, stdout, stderr }); });
        children.add(proc);
      });
    }, daemonStatus: bounds => child({ result: { state: 'ready', pid: process.pid, version: '1.2.3', ...status } }, bounds, status.dead ? 1 : 0) });
  const args = { diagnostics, output: dirs.output, target: '1.2.3', platform };
  return { args, diagnostics, dirs, evaluate: () => evaluateManualDaemonState(args) };
}

test('real capture artifacts and reaped child runner support independent passing state', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.diagnostics);
  assert.equal(f.evaluate().passed, true, JSON.stringify(f.evaluate()));
  assert.equal(JSON.stringify(f.diagnostics), before, 'raw diagnostics preserved');
});
for (const [name, options] of [
  ['paused recovery despite correct target', { recovery: { phase: 'paused', installed: '1.2.3' } }],
  ['unusable recovery', { recovery: { phase: 'unusable' } }],
  ['live update owner', { lock: 'live' }],
  ['unknown update owner', { lock: { pid: process.pid } }],
  ['dead public endpoint', { status: { dead: true } }],
  ['old running version', { status: { version: '1.2.2' } }],
  ['non-ready public endpoint', { status: { state: 'stopped' } }],
]) test(name, async t => { const f = await fixture(t, options); assert.equal(f.evaluate().passed, false); });

test('missing, unreadable and duplicate observations fail closed', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.diagnostics);
  for (const change of [
    d => { d.observations = d.observations.filter(r => r.kind !== 'daemon-status'); },
    d => { d.observations.find(r => r.kind === 'update-recovery.json').state = 'error'; },
    d => { d.observations.find(r => r.kind === '.cotal-update-child').state = 'error'; },
    d => { d.observations.push(d.observations.find(r => r.kind === 'socket')); },
    d => { d.capturedAt = undefined; },
    d => { d.stage = 'before-update'; },
    d => { d.observations.find(r => r.kind === 'socket').state = 'missing'; },
    d => { d.observations.find(r => r.kind === 'installed-version').sha256 = '0'.repeat(64); },
    d => { d.observations.find(r => r.kind === 'daemon-status').artifact = '../escape.txt'; },
  ]) {
    f.args.diagnostics = structuredClone(original);
    change(f.args.diagnostics);
    assert.equal(f.evaluate().passed, false);
  }
});

test('ready target listener cannot substitute for an active native supervisor', async t => {
  const f = await fixture(t);
  assert.equal(f.evaluate().passed, true);
  const supervisor = f.diagnostics.observations.find(row => row.kind === 'systemctl-show');
  supervisor.state = 'failed';
  assert.equal(f.evaluate().passed, false);
  supervisor.state = 'observed';
  const path = join(f.dirs.output, supervisor.artifact);
  const original = JSON.parse(readFileSync(path));
  for (const [before, after] of [['ActiveState=active', 'ActiveState=inactive'], ['UnitFileState=enabled', 'UnitFileState=disabled'], [`MainPID=${process.pid}`, 'MainPID=1']]) {
    const command = { ...original, stdout: original.stdout.replace(before, after) };
    const bytes = Buffer.from(JSON.stringify(command));
    writeFileSync(path, bytes, { mode: 0o600 });
    supervisor.bytes = bytes.length;
    supervisor.sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(f.evaluate().passed, false);
  }
});

test('tampered artifacts and symlink roots fail without following private paths', async t => {
  const f = await fixture(t);
  const row = f.diagnostics.observations.find(r => r.kind === 'daemon-status');
  writeFileSync(join(f.dirs.output, row.artifact), '{}', { mode: 0o600 });
  assert.equal(f.evaluate().passed, false);
  symlinkSync(f.dirs.output, join(f.dirs.cotalHome, 'alias'));
  f.args.output = join(f.dirs.cotalHome, 'alias');
  assert.equal(f.evaluate().passed, false);
});

test('Windows pipe limitation is explicit and public peer still required', async t => {
  const f = await fixture(t, { platform: 'win32' });
  assert.equal(f.evaluate().passed, true, JSON.stringify(f.evaluate()));
  assert.match(f.evaluate().checks.find(r => r.name === 'daemon endpoint evidence').detail, /named-pipe/);
  f.diagnostics.observations.find(r => r.kind === 'socket').reason = '';
  assert.equal(f.evaluate().passed, false);
});

test('Darwin archived socket generation matches public peer lifetime owner', async t => {
  const f = await fixture(t, { platform: 'darwin' });
  assert.equal(f.evaluate().passed, true, JSON.stringify(f.evaluate()));
});
