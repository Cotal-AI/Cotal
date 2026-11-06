/** Optional native service probe; no ordinary runtime is enabled by these fixtures. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePeerProcess, importProcess, processStartToken, processStatFields, requestProcessStorageRemoval } from '../dist/index.js';
const [root, mode, unit] = process.argv.slice(2), checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const save = (name, value) => { const fd = openSync(join(root, name), 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } const dir = openSync(root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } };
const owner = { pid: process.pid, birth: processStartToken(process.pid) };
if (mode !== 'service') {
  assert.throws(() => requestProcessStorageRemoval('bad\nFDSTORE=1'), /storage name/); checks.push('invalid metadata name refuses');
  let ticks = 0; const timer = setInterval(() => ticks++, 10), start = performance.now();
  try { await assert.rejects(requestProcessStorageRemoval('owned-probe'), mode === 'timeout' ? /acknowledgment unconfirmed/ : /notification unavailable/); checks.push(mode + ' context refuses without fallback'); }
  finally { clearInterval(timer); }
  if (mode === 'timeout') check('JS event loop progressed during bounded barrier', ticks >= 10);
  save(mode + '.json', { owner, checks, ticks, elapsedMs: performance.now() - start });
} else {
  const run = promisify(execFile), env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
  const bus = async (...args) => JSON.parse((await run('/usr/bin/busctl', ['--user', '--timeout=4', '--json=short', ...args], { env, timeout: 6000 })).stdout).data;
  const path = (await bus('call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit))[0];
  const property = (iface, name) => bus('get-property', 'org.freedesktop.systemd1', path, iface, name);
  const scope = async () => ({ unit: await property('org.freedesktop.systemd1.Unit', 'Id'), main: await property('org.freedesktop.systemd1.Service', 'MainPID'), invocation: Buffer.from(await property('org.freedesktop.systemd1.Unit', 'InvocationID')).toString('hex') });
  const rows = async () => (await bus('call', 'org.freedesktop.systemd1', path, 'org.freedesktop.systemd1.Service', 'DumpFileDescriptorStore'))[0];
  const matches = (list, name, k) => list.filter(row => row[0] === name && row[1] === k.mode && row[2] === k.deviceMajor && row[3] === k.deviceMinor && String(row[4]) === k.inode);
  const current = await scope(); check('actual native unit binds this main process', current.unit === unit && current.main === process.pid && /^[a-f0-9]{32}$/.test(current.invocation));
  if (existsSync(join(root, 'attempt.json'))) {
    assert.ok(existsSync(join(root, 'first.json')), 'do not repeat an incomplete first owner');
    const first = JSON.parse(readFileSync(join(root, 'first.json'), 'utf8'));
    check('new native invocation in original unit', current.unit === first.scope.unit && current.invocation !== first.scope.invocation);
    check('activation identifies this process', Number(process.env.LISTEN_PID) === process.pid && process.env.LISTEN_FDS === '1' && process.env.LISTEN_FDNAMES === 'owned');
    const handle = importProcess(3, first.receipt);
    try {
      check('same retained kernel object returned', JSON.stringify(handle.kernel) === JSON.stringify(first.receipt.kernel));
      await handle.waitForExit({ signal: AbortSignal.timeout(8000) }); check('old namespace exit observed', handle.hasExited());
      const before = await rows(); check('owned object still in real store', matches(before, 'owned', handle.kernel).length === 1);
      await requestProcessStorageRemoval('owned'); const after = await rows(); check('exact owned object removed', after.length === 0);
      check('local handle remains valid after store removal', handle.hasExited());
      save('second.json', { owner, scope: current, checks, before, after, kernel: handle.kernel });
    } finally { handle.close(); closeSync(3); }
  } else {
    save('attempt.json', { owner, scope: current });
    const active = [];
    try {
      async function launch(name) {
        const dir = join(root, name); mkdirSync(dir, { mode: 0o700 }); const address = '\0cotal-store-' + randomUUID();
        const server = createServer(); server.listen(address); await once(server, 'listening');
        const connected = once(server, 'connection', { signal: AbortSignal.timeout(10000) });
        const child = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '--pid', '--fork', '--kill-child=SIGKILL', '--mount-proc', '/usr/bin/python3', '-I', join(dirname(fileURLToPath(import.meta.url)), 'process-import-driver.py'), 'gate', dir, address.slice(1)], { env: { PATH: '/usr/bin:/bin', HOME: dir }, stdio: 'ignore' });
        child.on('error', () => {}); const launcher = { pid: child.pid, birth: processStartToken(child.pid) }; save(name + '-launcher.json', launcher);
        const [socket] = await connected; server.close(); const handle = capturePeerProcess(socket); const row = { name, dir, child, socket, handle }; active.push(row);
        check(name + ': peer belongs to original launcher', processStatFields(handle.identity.pid)?.[1] === String(child.pid) && processStartToken(child.pid) === launcher.birth);
        check(name + ': peer is namespace init', /^NSpid:\s+(.+)$/m.exec(readFileSync(`/proc/${handle.identity.pid}/status`, 'utf8'))?.[1].trim().split(/\s+/).at(-1) === '1');
        save(name + '-capture.json', { identity: handle.identity, kernel: handle.kernel }); return row;
      }
      const first = await launch('accepted'), receipt = { identity: first.handle.identity, kernel: first.handle.kernel };
      const retained = first.handle.retain(); const pending = first.handle.requestStorage('owned'); first.handle.close(); first.handle = retained; await pending;
      check('request owns its fd after caller handle closes', !retained.hasExited());
      const stored = await rows(); check('actual storage matches exact object', matches(stored, 'owned', receipt.kernel).length === 1 && stored.length === 1);
      const afterScope = await scope(); check('same native invocation confirmed after request', JSON.stringify(afterScope) === JSON.stringify(current));
      check('application still blocked', !existsSync(join(first.dir, 'admitted.json')));
      save('admission.json', { receipt, scope: current }); first.socket.end('+');
      const deadline = Date.now() + 3000; while (!existsSync(join(first.dir, 'admitted.json')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      check('application ran after durable receipt', existsSync(join(first.dir, 'admitted.json')));
      const extra = await launch('overflow'); await extra.handle.requestStorage('overflow'); const full = await rows();
      check('processed request can be refused by full store', full.length === 1 && matches(full, 'overflow', extra.handle.kernel).length === 0);
      check('full store did not replace original object', matches(full, 'owned', receipt.kernel).length === 1);
      check('overflow application was never admitted', !existsSync(join(extra.dir, 'admitted.json')));
      const extraExit = extra.handle.waitForExit({ signal: AbortSignal.timeout(5000) }); extra.handle.signal('SIGKILL'); await extraExit; extra.socket.destroy();
      check('overflow namespace closed through its pidfd', extra.handle.hasExited());
      await requestProcessStorageRemoval('not-stored'); check('unknown name removal leaves owned object', matches(await rows(), 'owned', receipt.kernel).length === 1);
      save('first.json', { owner, scope: current, receipt, checks, stored, full }); process.kill(process.pid, 'SIGKILL');
    } finally {
      for (const row of active) { row.socket.destroy(); if (!row.handle.hasExited()) row.handle.signal('SIGKILL'); await row.handle.waitForExit({ signal: AbortSignal.timeout(5000) }); row.handle.close(); }
    }
  }
}
console.log(`${mode}: ${checks.length} storage checks`);
