import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { statusTiming, isTimedStatus } from './daemon-status-timings.mjs';
import { runDiagnosticCommand } from './automatic-update-platform-baseline.mjs';

// Synthetic only: no installed Cotal, native service, or acceptance claim.
const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? process.env.RUNNER_TEMP ?? process.cwd(), 'status-timing-'));
const events = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
try {
  const scope = { platform: 'darwin', nextHopMode: 'candidate', method: 'self', followOnAction: 'self', argv: ['/installed/cotal.js', 'daemon', 'status', '--json'] };
  assert(isTimedStatus(scope));
  for (const override of [{ platform: 'linux' }, { nextHopMode: 'source-0.164.10' }, { method: 'npm' }, { followOnAction: undefined }, { followOnAction: 'npm' }, { argv: ['update', '--self'] }]) assert(!isTimedStatus({ ...scope, ...override }));
  const fixture = join(root, 'cotal-program.js');
  writeFileSync(fixture, `import net from 'node:net';
const socket = net.connect(process.argv[2]);
socket.on('connect', () => socket.write('synthetic status'));
socket.on('data', () => { console.log(JSON.stringify({ok:true, leaked: Boolean(process.env.COTAL_STATUS_TIMING_FILE), options: process.env.NODE_OPTIONS})); socket.destroy(); });
`);
  const socket = join(root, 'daemon.sock');
  const server = createServer(peer => peer.once('data', () => peer.end('synthetic reply')));
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    const file = join(root, 'success.jsonl');
    const env = { ...process.env, NODE_OPTIONS: '--no-warnings' };
    const timing = statusTiming(file, env);
    assert.equal(env.NODE_OPTIONS, '--no-warnings');
    assert.equal(env.COTAL_STATUS_TIMING_FILE, undefined);
    const result = await runDiagnosticCommand(process.execPath, [fixture, socket], { env: timing.env, timeoutMs: 5000 });
    const evidence = timing.finish(result);
    assert.equal(evidence.error, undefined);
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, leaked: false, options: '--no-warnings' });
    const stages = events(file).map(row => row.stage);
    for (const stage of ['command-start', 'preload-ready', 'cotal-program:load-hook-start', 'cotal-program:load-hook-return', 'daemon-socket-connect-call', 'daemon-socket-first-connect', 'daemon-socket-first-write-call', 'daemon-socket-first-data', 'child-exit', 'command-exit']) assert(stages.includes(stage), stage);
    assert.equal(stages[0], 'command-start');
    assert.equal(stages.at(-1), 'command-exit');
    assert(readFileSync(file).length < 16 * 1024);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const unrelated = createServer(peer => peer.end());
  const unrelatedPath = join(root, 'unrelated.sock');
  await new Promise(resolve => unrelated.listen(unrelatedPath, resolve));
  try {
    const file = join(root, 'unrelated.jsonl');
    const timing = statusTiming(file, process.env);
    const result = await runDiagnosticCommand(process.execPath, ['-e', `require('node:net').connect(process.argv[1]).resume()`, unrelatedPath], { env: timing.env, timeoutMs: 5000 });
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(timing.finish(result).error, undefined);
    assert(!events(file).some(row => row.stage.startsWith('daemon-socket')));
  } finally { await new Promise(resolve => unrelated.close(resolve)); }
  const killedFile = join(root, 'killed.jsonl');
  const killed = statusTiming(killedFile, process.env);
  const result = await runDiagnosticCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: killed.env, timeoutMs: 5000 });
  assert.equal(killed.finish(result).error, undefined);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.timeout, true);
  const stages = events(killedFile).map(row => row.stage);
  assert(stages.includes('preload-ready'));
  assert(!stages.includes('child-exit'));
  assert.equal(stages.at(-1), 'command-exit');
  const missing = statusTiming(join(root, 'missing.jsonl'), process.env);
  assert.match(missing.finish({ exit: null }).error, /did not become ready/);
  assert.throws(() => statusTiming(killedFile, process.env), /EEXIST/);
  console.log('synthetic status timing tests passed (including original 5s SIGKILL bound)');
} finally { rmSync(root, { recursive: true, force: true }); }
