/** Public-package import checks; the native driver supplies owned inherited descriptors. */
import assert from 'node:assert/strict';
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importProcess, processStartToken } from '../dist/index.js';
const [root, mode, rawFd, rawThreadFd] = process.argv.slice(2);
const fd = Number(rawFd), receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
const checks = [], check = (name, value) => { assert.ok(value, name); checks.push(name); };
const refuse = (name, run, pattern) => { assert.throws(run, pattern); checks.push(name); };
const before = readdirSync('/proc/self/fd').length;
for (let i = 0; i < 16; i++) refuse('wrong object refused ' + i, () => importProcess(fd, { ...receipt, kernel: { ...receipt.kernel, inode: '1' } }), /kernel process identity mismatch/);
check('rejected imports release duplicated descriptors', readdirSync('/proc/self/fd').length === before);
refuse('wrong boot refused', () => importProcess(fd, { ...receipt, identity: { ...receipt.identity, boot: 'wrong' } }), /invalid recorded process identity/);
refuse('wrong UID refused', () => importProcess(fd, { ...receipt, identity: { ...receipt.identity, uid: process.getuid() + 1 } }), /invalid recorded process identity/);
refuse('invalid inode refused', () => importProcess(fd, { ...receipt, kernel: { ...receipt.kernel, inode: '18446744073709551616' } }), /invalid recorded kernel identity/);
refuse('invalid descriptor refused', () => importProcess(-1, receipt), /integer in range/);
const ordinary = openSync('/dev/null', 'r');
try { refuse('non-pidfd refused', () => importProcess(ordinary, receipt), /Bad file descriptor/); }
finally { closeSync(ordinary); }
let handle = importProcess(fd, receipt);
try {
  check('kernel identity matches receipt', JSON.stringify(handle.kernel) === JSON.stringify(receipt.kernel));
  check('metadata is frozen', Object.isFrozen(handle.kernel) && Object.isFrozen(handle.identity));
  if (mode === 'live') {
    check('live import is not exited', !handle.hasExited());
    for (const [key, value] of [['pid', receipt.identity.pid + 1], ['birth', '0'], ['namespace', 'pid:[1]']]) {
      refuse('live identity mismatch ' + key, () => importProcess(fd, { ...receipt, identity: { ...receipt.identity, [key]: value } }), /process identity mismatch/);
    }
    refuse('thread-only pidfd refused', () => importProcess(Number(rawThreadFd), receipt), /thread-only pidfds/);
    const retained = handle.retain();
    handle.close();
    refuse('closed original refuses observation', () => handle.hasExited(), /closed/);
    check('retained copy remains live', !retained.hasExited());
    check('import did not consume caller descriptor', fstatSync(fd).ino > 0);
    closeSync(fd); handle = retained;
    check('retained copy survives borrowed descriptor close', !handle.hasExited());
    const abort = new AbortController(), cancelled = handle.waitForExit({ signal: abort.signal });
    abort.abort(); await assert.rejects(cancelled); checks.push('imported wait cancellation rejects');
    check('cancellation leaves process alive', !handle.hasExited());
    const exited = handle.waitForExit({ signal: AbortSignal.timeout(5000) });
    handle.signal('SIGKILL'); await exited;
    check('imported kernel event wait observes actual exit', handle.hasExited());
  } else {
    check('activation belongs to current PID', Number(process.env.LISTEN_PID) === process.pid);
    check('one named activation handle', process.env.LISTEN_FDS === '1' && process.env.LISTEN_FDNAMES === 'namespace');
    check('retained exited object imported', handle.hasExited());
    await handle.waitForExit(); checks.push('exited import wait completes');
    refuse('exited handle refuses signalling', () => handle.signal('SIGTERM'), /identity unavailable after exit/);
    closeSync(fd);
  }
  const exitedCopy = handle.retain();
  try { check('exited opaque copy preserves kernel evidence', exitedCopy.hasExited()); }
  finally { exitedCopy.close(); }
} finally { handle.close(); }
writeFileSync(join(root, mode + '-node.json'), JSON.stringify({ mode, owner: { pid: process.pid, birth: processStartToken(process.pid) }, checks }, null, 2), { mode: 0o600, flag: 'wx' });
console.log(`${mode}: ${checks.length} imported-process checks`);
