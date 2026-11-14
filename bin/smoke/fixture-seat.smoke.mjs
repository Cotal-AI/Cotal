/** Real portable fixture self-check through the stock foreground daemon, Manager and PTY. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureSpace } from './_fixture-space.mjs';
import { installFixtureSeat } from './_fixture-seat.mjs';
const root = mkdtempSync(join(tmpdir(), 'seat-fixture-'));
for (const [key, name] of Object.entries({ COTAL_HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_RUNTIME_DIR: 'run' })) { process.env[key] = join(root, name); mkdirSync(process.env[key], { mode: 0o700 }); }
const runtime = resolve('bin');
const env = { ...process.env, COTAL_SKIP_CONNECTOR_SEED: '1' };
const fixture = await createFixtureSpace({ root, machineHome: process.env.COTAL_HOME, runtime, node: process.execPath, env });
let daemon, seat, manager;
try {
  seat = await installFixtureSeat({ root, runtime, node: process.execPath, env, cwd: fixture.participant, space: fixture.space });
  daemon = spawn(process.execPath, [join(runtime, 'dist/cotal.js'), 'daemon', 'serve'], { env, cwd: fixture.participant, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(root, 'owned-daemon.json'), JSON.stringify({ pid: daemon.pid }));
  let log = ''; daemon.stderr.on('data', bytes => { log += bytes; });
  const until = Date.now() + 60_000;
  do {
    try { manager = await fixture.startManager(); break; } catch (error) { if (Date.now() >= until) throw new Error(`${error.message}\n${log}`); await delay(500); }
  } while (Date.now() < until);
  assert.ok(manager?.instanceId);
  const started = await seat.spawn(manager.instanceId);
  assert.ok(started.pid > 0);
  process.kill(started.pid, 0);
  console.log('PASS actual portable fixture starts a joined endpoint in the stock hosted Manager PTY');
} finally {
  let cleanupError;
  try { if (seat && manager) await seat.stop(manager.instanceId); } catch (error) { cleanupError = error; }
  try {
    if (daemon?.exitCode === null) { const ended = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGTERM'); await ended; }
  } finally { await fixture.close(); }
  writeFileSync(join(root, 'cleanup-complete'), 'complete');
  if (cleanupError) throw cleanupError;
}
