import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { captureDaemonDiagnostics, daemonShowProperties } from './daemon-cell-diagnostics.mjs';

function fixture() {
  const home = mkdtempSync('/var/tmp/upgrade-matrix/daemon-diagnostics-');
  const dirs = Object.fromEntries(['cotalHome', 'daemonHome', 'config', 'output', 'pkg', 'tmp', 'globalRoot'].map(key => [key, join(home, key)]));
  for (const path of Object.values(dirs)) mkdirSync(path, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, COTAL_HOME: dirs.cotalHome, XDG_CONFIG_HOME: dirs.config, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp };
  const calls = [], children = new Set();
  const child = (code, bounds) => new Promise(resolve => {
    const proc = execFile(process.execPath, ['-e', code], { env, cwd: home, encoding: 'utf8', timeout: bounds.timeoutMs, maxBuffer: bounds.maxBuffer, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      children.delete(proc);
      resolve({ exit: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr, error, timedOut: error?.killed === true });
    });
    children.add(proc);
  });
  const options = { ...dirs, home, id: 'cell', stage: 'before-update', startedAt: '2026-11-14T11:00:00.000Z', platform: 'linux', plan: { globalRoot: dirs.globalRoot }, cli: { file: '/private/cotal', args: ['base'] }, timeoutMs: 1000,
    run: async (file, args, bounds) => {
      calls.push({ file, args, bounds });
      return child(file === 'systemctl' ? 'console.log("ActiveState=active\\nEnvironment=DO_NOT_ARCHIVE\\nExecStart=DO_NOT_ARCHIVE")' : file === 'journalctl' ? 'console.log("journal #t=consoleToken eyJabc.def.ghi")' : 'console.log(JSON.stringify({result:{state:"ready",version:"1.2.3",argv:["DO_NOT_ARCHIVE"],credentials:"DO_NOT_ARCHIVE"}}))', bounds);
    } };
  writeFileSync(join(dirs.pkg, 'package.json'), JSON.stringify({ name: 'cotal-ai', version: '1.2.3', credentials: 'DO_NOT_ARCHIVE' }), { mode: 0o600 });
  return { options, calls, children, child, home, ...dirs };
}
const row = (report, kind) => report.observations.find(item => item.kind === kind);

test('pretty JSON sensitive sections suppress nested values and retain following safe lines', async () => {
  const f = fixture();
  const raw = [JSON.stringify({ argv: ['--password', 'CANARY_PRIVATE', { nested: ['CANARY_PRIVATE', 'bracket ] in string'] }], message: 'safe-after-argv' }, null, 2), JSON.stringify({ environment: { TOKEN: 'CANARY_PRIVATE', nested: { array: ['CANARY_PRIVATE'] } }, message: 'safe-after-env' }, null, 2), 'safe-final-marker'].join('\n');
  writeFileSync(join(f.daemonHome, 'daemon.log'), raw, { mode: 0o600 });
  const report = await captureDaemonDiagnostics({ ...f.options, platform: 'darwin' });
  const text = readFileSync(join(f.output, row(report, 'daemon.log').artifact), 'utf8');
  assert(!text.includes('CANARY_PRIVATE'));
  assert(text.includes('safe-after-argv'));
  assert(text.includes('safe-after-env'));
  assert(text.includes('safe-final-marker'));
  assert.equal(f.children.size, 0);
});

test('socket metadata uses recorded generation without making a connection', async () => {
  const f = fixture(), socket = join(f.home, 'daemon.sock');
  let connections = 0;
  const server = createServer(peer => { connections++; peer.destroy(); });
  server.listen(socket);
  await once(server, 'listening');
  try {
    const stat = lstatSync(socket);
    writeFileSync(join(f.daemonHome, 'daemon.lock'), JSON.stringify({ v: 1, pid: process.pid, socket: { path: socket, dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
    const report = await captureDaemonDiagnostics({ ...f.options, platform: 'darwin' });
    assert.equal(row(report, 'socket').state, 'archived');
    assert.equal(connections, 0);
    writeFileSync(join(f.daemonHome, 'daemon.lock'), JSON.stringify({ socket: { path: socket, dev: stat.dev, ino: stat.ino + 1 } }), { mode: 0o600 });
    const changed = await captureDaemonDiagnostics({ ...f.options, platform: 'darwin', stage: 'changed' });
    assert.equal(row(changed, 'socket').state, 'error');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(f.children.size, 0);
});

test('oversized source and output symlink cannot publish, public status still runs', async () => {
  const f = fixture();
  writeFileSync(join(f.daemonHome, 'daemon.log'), Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });
  const report = await captureDaemonDiagnostics(f.options);
  assert.equal(row(report, 'daemon.log').state, 'error');
  const alias = join(f.home, 'output-alias'); symlinkSync(f.output, alias);
  const prior = readdirSync(f.output);
  const escaped = await captureDaemonDiagnostics({ ...f.options, output: alias, stage: 'escape' });
  assert.equal(row(escaped, 'roots').state, 'error');
  assert.equal(row(escaped, 'daemon-status').state, 'error');
  assert.deepEqual(readdirSync(f.output), prior);
  assert.equal(f.calls.length, 6);
  assert.equal(f.children.size, 0);
});

test('before and after collect fixed native observations, private hashes, records and redaction', async () => {
  const f = fixture();
  writeFileSync(join(f.daemonHome, 'daemon.log'), 'console #t=consoleToken eyJabc.def.ghi\nEnvironment=DO_NOT_ARCHIVE\n{"argv":["--password","DO_NOT_ARCHIVE"]}\n{"environment":{"TOKEN":"DO_NOT_ARCHIVE"}}\nAuthorization: Bearer DO_NOT_ARCHIVE\n', { mode: 0o600 });
  writeFileSync(join(f.daemonHome, 'daemon.log.1'), 'older daemon\n', { mode: 0o600 });
  writeFileSync(join(f.daemonHome, 'daemon.lock'), JSON.stringify({ v: 1, pid: 123, start: 'birth', argv: ['DO_NOT_ARCHIVE'] }), { mode: 0o600 });
  writeFileSync(join(f.cotalHome, 'update-recovery.json'), JSON.stringify({ v: 1, phase: 'paused', owner: { pid: 123, start: 'birth', nonce: 'DO_NOT_ARCHIVE' }, credentials: 'DO_NOT_ARCHIVE' }), { mode: 0o600 });
  writeFileSync(join(f.globalRoot, '.cotal-update.lock'), JSON.stringify({ pid: process.pid, ts: 1, nonce: 'DO_NOT_ARCHIVE' }), { mode: 0o600 });
  const verdict = { passed: false, error: new Error('original') };
  for (const stage of ['before-update', 'after-update']) {
    const report = await captureDaemonDiagnostics({ ...f.options, stage, verdict });
    assert.equal(report.verdict, verdict);
    const owner = JSON.parse(readFileSync(join(f.output, row(report, '.cotal-update.lock').artifact), 'utf8'));
    assert.equal(owner.ownerProcess.pid, process.pid);
    assert.match(owner.ownerProcess.start, /^\d+$/);
    assert.equal(row(report, 'daemon-status').state, 'observed');
    assert.equal(row(report, 'installed-version').version, '1.2.3');
    assert.equal(row(report, 'daemon.log.2').state, 'missing');
    assert.equal(row(report, 'kernel-lock').state, 'archived');
    const kernel = JSON.parse(readFileSync(join(f.output, row(report, 'kernel-lock').artifact), 'utf8'));
    assert.equal(kernel.find(item => item.name === 'daemon.lock').state, 'observed');
    for (const item of report.observations.filter(item => item.artifact)) {
      const file = join(f.output, item.artifact), data = readFileSync(file);
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.equal(createHash('sha256').update(data).digest('hex'), item.sha256);
      assert(!data.includes('DO_NOT_ARCHIVE'));
      assert(!data.includes('consoleToken'));
      assert(!data.includes('eyJabc'));
    }
  }
  assert.deepEqual(f.calls[0].args, ['--user', 'show', 'cotal-daemon.service', ...daemonShowProperties.map(key => `--property=${key}`)]);
  assert(f.calls[1].args.includes(f.options.startedAt));
  assert.deepEqual(f.calls[2].args, ['base', 'daemon', 'status', '--json']);
  assert.equal(f.children.size, 0);
});

test('failed and timed-out child observations do not replace verdict or prevent independent status', async () => {
  const f = fixture(), verdict = new Error('raw update timeout');
  const report = await captureDaemonDiagnostics({ ...f.options, timeoutMs: 80, verdict, run: (file, args, bounds) => f.child(file === 'systemctl' ? 'process.exit(7)' : file === 'journalctl' ? 'setTimeout(()=>{},10000)' : 'console.log("{\\"result\\":{\\"state\\":\\"ready\\"}}")', bounds) });
  assert.equal(report.verdict, verdict);
  assert.equal(row(report, 'systemctl-show').state, 'failed');
  assert.equal(row(report, 'systemctl-show').exit, 7);
  assert.equal(row(report, 'journal').state, 'timeout');
  assert.equal(row(report, 'daemon-status').state, 'observed');
  assert.equal(f.children.size, 0);
});

test('symlink files, parent escapes, unsafe files and create-only collisions are explicit', async () => {
  const f = fixture();
  const foreign = join(f.home, 'foreign'); mkdirSync(foreign, { mode: 0o700 });
  writeFileSync(join(foreign, 'daemon.log'), 'FOREIGN_BYTES', { mode: 0o600 });
  symlinkSync(join(foreign, 'daemon.log'), join(f.daemonHome, 'daemon.log'));
  writeFileSync(join(f.daemonHome, 'daemon.log.1'), 'writable', { mode: 0o600 });
  chmodSync(join(f.daemonHome, 'daemon.log.1'), 0o666);
  const first = await captureDaemonDiagnostics(f.options);
  assert.equal(row(first, 'daemon.log').state, 'error');
  assert.equal(row(first, 'daemon.log.1').state, 'error');
  const snapshot = readFileSync(join(f.output, row(first, 'installed-version').artifact));
  const collision = await captureDaemonDiagnostics(f.options);
  assert.equal(row(collision, 'installed-version').error, 'EEXIST');
  assert.deepEqual(readFileSync(join(f.output, row(first, 'installed-version').artifact)), snapshot);
  const alias = join(f.home, 'alias'); symlinkSync(f.daemonHome, alias);
  const parent = await captureDaemonDiagnostics({ ...f.options, daemonHome: alias, stage: 'parent' });
  assert.equal(row(parent, 'roots').state, 'error');
  assert.equal(row(parent, 'daemon.log').state, 'error');
  assert(!readdirSync(f.output).some(name => readFileSync(join(f.output, name), 'utf8').includes('FOREIGN_BYTES')));
  assert.equal(f.children.size, 0);
});

test('macOS and Windows use public status without running service commands; missing runners explicit', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture();
    const report = await captureDaemonDiagnostics({ ...f.options, platform });
    assert.equal(f.calls.length, 1);
    assert.equal(row(report, 'daemon-status').state, 'observed');
    assert.equal(row(report, 'socket').state, platform === 'win32' ? 'unavailable' : 'missing');
    assert.equal(f.children.size, 0);
  }
  const f = fixture();
  const result = await captureDaemonDiagnostics({ ...f.options, run: undefined });
  assert.equal(row(result, 'daemon-status').state, 'error');
  assert.equal(row(result, 'journal').state, 'error');
});
