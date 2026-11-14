import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = join(process.env.RUNNER_TEMP, 'mac-updater-build');
const hiddenApply = process.argv[2] === 'hidden';
const out = join(process.env.RUNNER_TEMP, 'mac-updater-result');
mkdirSync(out, { mode: 0o700, recursive: true });
const build = JSON.parse(readFileSync(join(root, 'build-result.json'), 'utf8'));
assert.equal(build.debug, true);
const driver = fileURLToPath(new URL('mac-updater-driver.swift', import.meta.url));
const app = '/Applications/Cotal.app';
const node = join(app, 'Contents/MacOS/cotal-node');
const runtime = join(app, 'Contents/Resources/runtime');
const cli = join(runtime, 'dist/cotal.js');
const env = { ...process.env, DO_NOT_TRACK: '1' };
for (const key of Object.keys(env)) if (key.startsWith('COTAL_') || key.startsWith('TAURI_SIGNING_')) delete env[key];
let mode = 'publication';
const requests = [];
const bytes = readFileSync(join(root, 'target.app.tar.gz'));
const signature = readFileSync(join(root, 'target.app.tar.gz.sig'), 'utf8').trim();
const invalidBytes = readFileSync(join(root, 'invalid-install.tar.gz'));
const invalidSignature = readFileSync(join(root, 'invalid-install.tar.gz.sig'), 'utf8').trim();
const server = createServer((req, res) => {
  requests.push({ at: Date.now(), path: req.url, mode });
  if (req.url === '/latest.json') {
    if (mode === 'publication') { res.writeHead(404); res.end(); return; }
    const manifest = { version: '0.164.9', platforms: { [`darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`]: { url: 'http://127.0.0.1:43189/update.tar.gz', ...(mode === 'missing-signature' ? {} : { signature: mode === 'install-error' ? invalidSignature : mode === 'bad-signature' ? signature.slice(0, -8) + 'AAAAAAAA' : signature }) } } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return;
  }
  if (req.url === '/update.tar.gz') {
    const responseBytes = mode === 'install-error' ? invalidBytes : bytes;
    res.setHeader('content-length', responseBytes.length);
    if (mode === 'slow') {
      let offset = 0;
      const timer = setInterval(() => {
        const next = Math.min(bytes.length, offset + Math.ceil(bytes.length / 40));
        res.write(bytes.subarray(offset, next)); offset = next;
        if (offset === bytes.length) { clearInterval(timer); res.end(); }
      }, 500);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (mode === 'interrupted') { res.write(bytes.subarray(0, Math.floor(bytes.length / 3))); res.destroy(); return; }
    res.end(responseBytes); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(43189, '127.0.0.1', resolve));
const records = [];
const record = (name, value) => { records.push({ name, at: new Date().toISOString(), value }); writeFileSync(join(out, 'observations.json'), JSON.stringify(records, null, 2)); };
const run = async (command, args, options = {}) => {
  const result = await execute(command, args, { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options });
  return result.stdout;
};
const call = async (...args) => {
  try { return JSON.parse(await run(node, [cli, ...args, '--json'])); }
  catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
};
const ax = async (operation, ...args) => JSON.parse(await run('/usr/bin/swift', [driver, app, operation, ...args], { timeout: 30_000 }));
async function until(name, observe, accept, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { last = await observe(); if (accept(last)) { record(name, last); return last; } }
    catch (error) { last = { error: error.message }; }
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`${name} did not complete: ${JSON.stringify(last)}`);
}
const installed = () => JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
let fixture, seat, manager;
let serviceInstalled = false;
let cleanupError;
try {
  assert.equal(existsSync(app), false, 'Hosted app destination must be absent');
  await run('/usr/bin/tar', ['-xzf', join(root, 'N.app.tar.gz'), '-C', '/Applications']);
  assert.equal(installed(), '0.164.8');
  const initial = await call('daemon', 'status');
  assert.equal(initial.error?.code, 'NOT_RUNNING', 'Default native service must be absent');
  const installation = await call('daemon', 'install'); assert.equal(installation.ok, true, JSON.stringify(installation)); serviceInstalled = true;
  const before = await until('installed launchd service N', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.8');
  const lifetime = await import(pathToFileURL(join(runtime, 'dist/daemon/lifetime.js')).href);
  record('service N kernel lifetime', { pid: before.result.pid, birth: lifetime.processBirth(before.result.pid) });
  await run('/usr/bin/open', ['-n', app]);
  const firstApp = await until('visible N app', () => ax('describe'), value => value.visible);
  record('app N kernel lifetime', { ...firstApp, birth: lifetime.processBirth(firstApp.pid) });
  await ax('settings');
  await until('initial publication gap', () => ax('text', 'settings-update-summary'), text => text.includes('still being prepared'));
  mode = 'valid';
  await ax('click', 'check-updates');
  await until('visible candidate remains uninstalled', () => ax('text', 'settings-update-summary'), text => text.includes('0.164.9') && text.includes('Restart to update'));
  assert.equal(installed(), '0.164.8');
  assert.equal(requests.filter(item => item.path === '/update.tar.gz').length, 0, 'A visible app does not repeatedly download');
  // Exercise shared preference through the actual public CLI, not a private settings fixture.
  assert.equal((await call('update', '--auto', 'off')).ok, true);
  await ax('quit');
  await until('N app exited', () => { try { process.kill(firstApp.pid, 0); return false; } catch { return true; } }, Boolean, 30_000);
  await run('/usr/bin/open', ['-n', app, '--args', '--background']);
  await delay(5000);
  assert.equal(installed(), '0.164.8');
  assert.equal(requests.filter(item => item.path === '/update.tar.gz').length, 0);
  record('automatic off leaves N and no download', { version: installed() });
  await ax('quit'); await delay(1500);
  mode = 'publication';
  await run('/usr/bin/open', ['-n', app]);
  await until('N visible for invalid input controls', () => ax('describe'), value => value.visible);
  assert.equal((await call('update', '--auto', 'on')).ok, true);
  await ax('settings');
  mode = 'slow';
  await ax('click', 'check-updates');
  await until('slow candidate', () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  let count = requests.filter(item => item.path === '/update.tar.gz').length;
  await ax('close');
  await until('hidden slow download started', async () => requests.filter(item => item.path === '/update.tar.gz').length, value => value > count);
  await run('/usr/bin/open', [app]);
  await until('Open during download immediately shows window', () => ax('describe'), value => value.visible, 10_000);
  assert.equal(installed(), '0.164.8');
  await ax('settings');
  await until('Open during download leaves verified N ready', () => ax('text', 'settings-update-summary'), text => text.includes('downloaded and verified'), 60_000);
  assert.equal(installed(), '0.164.8');
  record('Open during slowed automatic download', { version: installed() });
  await ax('quit'); await delay(1500);
  mode = 'publication';
  await run('/usr/bin/open', ['-n', app]);
  await until('N visible before Quit download control', () => ax('describe'), value => value.visible);
  await ax('settings');
  mode = 'slow'; await ax('click', 'check-updates');
  await until('second slow candidate', () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  count = requests.filter(item => item.path === '/update.tar.gz').length;
  await ax('close');
  await until('second hidden slow download started', async () => requests.filter(item => item.path === '/update.tar.gz').length, value => value > count);
  const downloading = await ax('describe');
  await ax('quit');
  await until('Quit during download exits N', () => { try { process.kill(downloading.pid, 0); return false; } catch { return true; } }, Boolean, 10_000);
  assert.equal(installed(), '0.164.8');
  mode = 'publication'; await run('/usr/bin/open', ['-n', app]);
  await until('N reopened after cancelled download', () => ax('describe'), value => value.visible);
  await ax('settings'); mode = 'valid'; await ax('click', 'check-updates');
  await until('candidate for permission control', () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  chmodSync(app, 0o500);
  try {
    await ax('close');
    await until('hidden permission refusal leaves N ready', async () => {
      // UI is opened only after the native automatic attempt has had time to complete.
      await delay(2000);
      const hidden = await ax('describe'); assert.equal(hidden.authorizationPrompt, false, 'Hidden automatic replacement must not show an authorization prompt');
      record('hidden permission observation', hidden);
      await run('/usr/bin/open', [app]); await ax('settings');
      return ax('text', 'settings-update-summary');
    }, text => text.includes('administrator permission'), 60_000);
    assert.equal(installed(), '0.164.8');
    record('unwritable automatic apply refused without authorization', { version: installed() });
  } finally { chmodSync(app, 0o755); }
  for (const control of ['missing-signature', 'bad-signature', 'interrupted', 'install-error']) {
    mode = control;
    const priorRequests = requests.filter(item => item.path === '/latest.json').length;
    await ax('click', 'check-updates');
    await until(`${control} manifest requested`, async () => requests.filter(item => item.path === '/latest.json').length, count => count > priorRequests);
    if (control !== 'missing-signature') {
      await ax('settings');
      await until(`${control} candidate`, () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
      const priorDownloads = requests.filter(item => item.path === '/update.tar.gz').length;
      await ax('click', 'restart-update');
      await until(`${control} native download requested`, async () => requests.filter(item => item.path === '/update.tar.gz').length, count => count > priorDownloads);
    }
    await until(`${control} native refusal`, () => ax('text', 'settings-update-summary'), text => text.includes('failed:'));
    assert.equal(installed(), '0.164.8');
    const healthy = await call('daemon', 'status');
    assert.equal(healthy.ok, true); assert.equal(healthy.result.version, '0.164.8');
    record(`${control} preserves running N`, { version: installed(), daemon: healthy.result.pid });
  }
  mode = 'valid';
  await ax('click', 'check-updates');
  await until('valid manifest after controls', () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  assert.equal((await call('daemon', 'uninstall', '--yes')).ok, true);
  serviceInstalled = false;
  // A real shared fixture is imported unchanged from its reviewed source checkout.
  assert.ok(process.env.COTAL_MAC_FIXTURE_ROOT, 'A reviewed shared-fixture checkout is required');
  const fixtureRoot = resolve(process.env.COTAL_MAC_FIXTURE_ROOT);
  assert.ok(fixtureRoot && existsSync(join(fixtureRoot, 'bin/smoke/_fixture-seat.mjs')), 'Shared fixture must exist at an explicit reviewed head');
  const fixtureHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot })).stdout.trim();
  assert.match(fixtureHead, /^[a-f0-9]{40}$/);
  record('shared fixture source', { head: fixtureHead });
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, 'Run hosted proof through pnpm exec tsx');
  await execute(process.execPath, [pnpm, '--workspace-concurrency=2', '--filter', 'cotal-ai...', 'build'], { cwd: fixtureRoot, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  const workspace = await import(pathToFileURL(join(runtime, 'node_modules/@cotal-ai/workspace/dist/index.js')).href);
  const { createFixtureSpace } = await import(pathToFileURL(join(fixtureRoot, 'bin/smoke/_fixture-space.mjs')).href);
  const { installFixtureSeat } = await import(pathToFileURL(join(fixtureRoot, 'bin/smoke/_fixture-seat.mjs')).href);
  assert.equal((await call('daemon', 'install')).ok, true); serviceInstalled = true;
  fixture = await createFixtureSpace({ root: join(root, 'occupied'), machineHome: workspace.homeCotalDir(), runtime, node, env });
  seat = await installFixtureSeat({ root: join(root, 'occupied'), runtime, node, env, cwd: fixture.participant, space: fixture.space });
  manager = await fixture.startManager();
  const started = await seat.spawn(manager.instanceId); // A refusal here is a prerequisite failure, never a substituted seat.
  const seatBirth = lifetime.processBirth(started.pid);
  assert.ok(seatBirth, 'Actual PTY child birth must be readable');
  record('real joined PTY seat', { pid: started.pid, birth: seatBirth, name: started.name, manager: manager.instanceId });
  const occupiedDaemon = (await call('daemon', 'status')).result;
  await ax('settings');
  await until('Restart action', () => ax('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  if (hiddenApply) await ax('close');
  else await ax('click', 'restart-update');
  await until('target app bundle replaced', async () => installed(), version => version === '0.164.9');
  const held = await until('real launchd watcher holds old occupied service', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.8' && reply.result.generation?.waiting?.includes('seat'));
  assert.equal(held.result.pid, occupiedDaemon.pid);
  assert.equal(lifetime.processBirth(started.pid), seatBirth);
  record('seat survives bundle replacement', { pid: started.pid, birth: seatBirth, daemon: held.result.pid, generation: held.result.generation });
  await until('target app restored visibility', () => ax('describe'), value => value.visible === !hiddenApply && value.pid !== firstApp.pid);
  if (hiddenApply) { await run('/usr/bin/open', [app]); await until('target shown after requested reopen', () => ax('describe'), value => value.visible); }
  await seat.stop(manager.instanceId); seat = undefined;
  await until('target service and ready Manager', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.9' && reply.result.managers?.every(item => item.state === 'answering' && item.connectors?.some(connector => connector.state === 'available')));
  await until('app confirms updated target', () => ax('text', 'applied-update'), text => text === 'Updated to Cotal 0.164.9.');
  await ax('quit'); await delay(1500);
  await run('/usr/bin/open', ['-n', app]);
  await until('second target start visible', () => ax('describe'), value => value.visible);
  const secondResult = await ax('dump');
  assert.ok(!secondResult.nodes.some(item => item.text.includes('Updated to Cotal 0.164.9.')), 'The result line is first-session only');
  record('second start result retired', { version: installed() });
  assert.equal((await run(node, [cli, '--version'])).trim().includes('0.164.9'), true);
  const inventory = JSON.parse(readFileSync(join(runtime, 'desktop-runtime.json'), 'utf8'));
  for (const file of inventory.files) assert.equal(createHash('sha256').update(readFileSync(join(runtime, file.path))).digest('hex'), file.sha256);
  const seeded = join(runtime, 'seeded-connectors');
  const connectorVersions = {};
  for (const name of readdirSync(seeded)) {
    const file = join(seeded, name, 'package.json');
    if (existsSync(file)) connectorVersions[name] = JSON.parse(readFileSync(file, 'utf8')).version;
  }
  assert.ok(Object.keys(connectorVersions).length >= 6);
  assert.ok(Object.values(connectorVersions).every(version => version === '0.164.9'));
  record('target bundled graph', { version: installed(), connectorVersions, checkedRuntimeFiles: inventory.files.length });
  writeFileSync(join(out, 'result.json'), JSON.stringify({ schema: 1, source: build.source, passed: true, debug: true, realLaunchd: true, realFixturePty: true, publication: false, applyMode: hiddenApply ? 'hidden-automatic' : 'explicit', controls: ['visible-waits', 'off', 'open-during-download', 'quit-during-download', 'hidden-permission-refusal', 'second-start-result-retired', 'missing-signature', 'bad-signature', 'interrupted-download', 'install-error', 'explicit-restart', 'occupied-seat', 'target-service-ready'] }, null, 2));
} catch (error) {
  writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, observation: error.observation }, null, 2));
  try { writeFileSync(join(out, 'app-ax.json'), JSON.stringify(await ax('dump'), null, 2)); } catch (diagnostic) { writeFileSync(join(out, 'app-ax-error.txt'), diagnostic.message); }
  throw error;
} finally {
  try { if (seat && manager) await seat.stop(manager.instanceId); } catch (error) { cleanupError = error; }
  try { await ax('quit'); } catch (error) { record('app quit observation', { reason: error.message }); }
  try { if (serviceInstalled) { const removed = await call('daemon', 'uninstall', '--yes'); assert.equal(removed.ok, true, JSON.stringify(removed)); } } catch (error) { cleanupError ??= error; }
  try { await fixture?.close(); } catch (error) { cleanupError ??= error; }
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(out, 'requests.json'), JSON.stringify(requests, null, 2));
  writeFileSync(join(out, 'cleanup.json'), JSON.stringify({ confirmed: !cleanupError, reason: cleanupError?.message }, null, 2));
  if (cleanupError) throw cleanupError;
}
