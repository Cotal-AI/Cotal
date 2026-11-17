import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The caller reserves a fresh 0700 scratch directory for this invocation alone. This script
// atomically claims it and retains the small fixture/receipt as evidence, never deletes it.
const [repoArg, scratchArg, phase = 'uid'] = process.argv.slice(2);
assert(repoArg && scratchArg, 'usage: repro-darwin-peer-close.mts <repo> <exclusive-private-scratch>');
assert(phase === 'uid' || phase === 'pid', 'phase must be uid or pid');
const repo = resolve(repoArg), scratch = resolve(scratchArg);
const parent = lstatSync(scratch);
assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.geteuid!() && (parent.mode & 0o777) === 0o700);
mkdirSync(join(scratch, 'reservation'), { mode: 0o700 });
writeFileSync(join(scratch, 'reservation/owner.json'), JSON.stringify({ pid: process.pid, purpose: 'peer-close-repro', retention: 'caller owns evidence cleanup after all processes exit' }), { flag: 'wx', mode: 0o600 });
let child: ChildProcess | undefined;
let childClosed = false;
let spawnError: Error | undefined;
let closePromise: Promise<void> | undefined;
let root: string | undefined;
try {
  root = mkdtempSync(join(scratch, 'peer-'));
  chmodSync(root, 0o700);
  for (const key of Object.keys(process.env)) if (key.startsWith('COTAL_')) delete process.env[key];
  for (const name of ['home', 'config', 'runtime', 'state']) mkdirSync(join(root, name), { mode: 0o700 });
  Object.assign(process.env, { HOME: join(root, 'home'), COTAL_HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: join(root, 'runtime'), DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', COTAL_SKIP_CONNECTOR_SEED: '1' });
  const require = createRequire(join(repo, 'bin/daemon/client.ts'));
  const seatEntry = fileURLToPath(execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', 'console.log(import.meta.resolve("@cotal-ai/seat", process.argv[1]))', pathToFileURL(join(repo, 'bin/daemon/client.ts')).href], { encoding: 'utf8' }).trim());
  const nativePath = join(dirname(seatEntry), '..', 'build', 'Release', `${process.platform}-${process.arch}`, 'peercred.node');
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const identity = {
    head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    clientSHA256: hash(join(repo, 'bin/daemon/client.ts')),
    endpointSHA256: hash(join(repo, 'bin/daemon/endpoint.ts')),
    seatEntry, seatEntrySHA256: hash(seatEntry),
    hostSHA256: hash(join(dirname(seatEntry), 'host.js')),
    nativeLoaderSHA256: hash(join(dirname(seatEntry), 'peercred.js')),
    nativePath, nativeSHA256: hash(nativePath),
  };
  writeFileSync(join(root, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { ClosedPeerRefusal, openVerified } = await import(pathToFileURL(join(repo, 'bin/daemon/client.ts')).href);
  const { defaultPeerUid, defaultPeerPid, assertSocketPathFits } = await import(pathToFileURL(join(repo, 'bin/daemon/endpoint.ts')).href);
  const paths = { dir: join(root, 'runtime'), socket: join(root, 'runtime/d.sock'), state: join(root, 'state'), lock: join(root, 'state/daemon.lock') };
  assertSocketPathFits(paths.socket);
  assert(process.platform === 'darwin' || process.platform === 'linux', 'requires a native Unix socket host');
  const closed = join(root, 'closed.json'), ready = join(root, 'ready'), release = join(root, 'release');
  // Independent listener seals receipt after accepted socket close and listener close callbacks.
  // Its bytes count is server-observed only, not proof of attempted client writes.
  const code = `const fs=require('fs'),net=require('net');let bytes=0;const server=net.createServer(s=>{s.on('data',b=>bytes+=b.length);s.once('close',()=>server.close(()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,bytes,closedAt:new Date().toISOString()}),{flag:'wx'})));if(process.argv[4]==='pid'){const t=setInterval(()=>{if(fs.existsSync(process.argv[5])){clearInterval(t);s.destroy()}},2)}else s.destroy()});server.listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);fs.writeFileSync(process.argv[3],'ready',{flag:'wx'})});setTimeout(()=>process.exit(91),10000).unref();`;
  child = spawn(process.execPath, ['-e', code, paths.socket, closed, ready, phase, release], { stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('error', error => { spawnError = error; });
  closePromise = new Promise<void>(resolveClose => child!.once('close', () => { childClosed = true; resolveClose(); }));
  const startDeadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    if (spawnError) throw spawnError;
    assert(Date.now() < startDeadline && !childClosed, 'listener did not become ready');
    await new Promise(r => setTimeout(r, 10));
  }
  let nativeReadReturned = false;
  let uidReadReturned = false;
  let failure: unknown;
  try {
    const afterClose = (socket: import('node:net').Socket): number => {
      // The existing test seam only schedules the stock native reader after the real close.
      // No native result, error or credential is injected.
      const deadline = Date.now() + 3000;
      while (!existsSync(closed)) {
        assert(Date.now() < deadline, 'listener close receipt missing');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const value = phase === 'uid' ? defaultPeerUid(socket) : defaultPeerPid(socket);
      nativeReadReturned = true;
      return value;
    };
    const sock = await openVerified({ paths, timeoutMs: 1000, ...(phase === 'uid'
      ? { peerUid: afterClose }
      : { peerUid: (socket: import('node:net').Socket) => {
        const uid = defaultPeerUid(socket);
        uidReadReturned = true;
        writeFileSync(release, 'close', { flag: 'wx', mode: 0o600 });
        return uid;
      }, peerPid: afterClose }) });
    sock.destroy();
  } catch (error) { failure = error; }
  await boundedClose(closePromise, 5000);
  if (spawnError) throw spawnError;
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  const receipt = JSON.parse(readFileSync(closed, 'utf8'));
  assert.equal(receipt.bytes, 0);
  assert.equal(existsSync(paths.socket), false);
  if (phase === 'pid') assert.equal(uidReadReturned, true, 'the first real uid read must finish before the second-read close');
  if (process.platform === 'darwin') {
    assert.equal(nativeReadReturned, false);
    assert(failure instanceof Error && failure instanceof ClosedPeerRefusal && (failure as Error & { code?: string }).code === 'PEER_UID_MISMATCH' && failure.message.includes('Socket is not connected'), 'closed Darwin peer remains refused with a typed stopping observation');
  } else {
    assert.equal(nativeReadReturned, true, 'Linux control must actually read native peer credentials');
    assert(failure instanceof Error && (failure as Error & { code?: string }).code === 'PEER_NOT_LOCK_OWNER', 'Linux control requires the expected lifetime-owner refusal');
  }
  assert.equal(hash(nativePath), identity.nativeSHA256);
  assert(require.cache[nativePath], 'the pinned native helper must have actually loaded');
  const outcome = { accepted: true, phase, identity, platform: process.platform, node: process.version, repo, fixture: root, listener: receipt, nativeReadReturned, scope: process.platform === 'darwin' ? 'native Darwin closed peer remains refused' : 'Linux scheduling control only, not Darwin acceptance', error: { name: (failure as Error).name, code: (failure as Error & { code?: string }).code, message: (failure as Error).message } };
  writeFileSync(join(root, 'outcome.json'), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(outcome, null, 2));
} finally {
  if (child && !childClosed && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const killed = child.kill('SIGKILL');
    if (!killed && !spawnError) throw new Error('owned listener termination could not be submitted, fixture retained');
  }
  if (closePromise && !childClosed) await boundedClose(closePromise, 5000);
  console.log(JSON.stringify({ fixtureRetained: root ?? scratch, childClosed, cleanupOwner: 'caller', releaseCondition: 'all invocation processes terminal and exclusive reservation retained through deletion' }));
}

async function boundedClose(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned listener close was not confirmed, fixture retained')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
