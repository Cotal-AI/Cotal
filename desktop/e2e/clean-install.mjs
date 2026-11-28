import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, tmpdir, userInfo } from 'node:os';
import { Console } from 'node:console';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { startFixtureAuthority } from '../../bin/smoke/_fixture-space.mjs';

const exec = promisify(execFile);
const e2e = dirname(fileURLToPath(import.meta.url));
const test = resolve(e2e, '../test');
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const [candidate, oldPath, broker] = process.argv.slice(2);
const old = oldPath === '-' ? '' : oldPath;
assert.ok(process.env.DESKTOP_DISPOSABLE === '1' && candidate && broker, 'Use a disposable native release test session.');
const root = mkdtempSync(join(tmpdir(), 'desktop-acceptance-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|LANG|LC_.*|XDG_.*|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|GTK_A11Y|SYSTEMROOT|WINDIR|USERPROFILE|USERNAME|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
env.DO_NOT_TRACK = '1';
const report = console;
const discard = new Writable({ write(_chunk, _encoding, done) { done(); } });
globalThis.console = new Console(discard);
const app = windows ? join(env.LOCALAPPDATA, 'Cotal', 'cotal-desktop.exe') : mac ? '/Applications/Cotal.app' : '/usr/bin/cotal-desktop';
const config = windows ? join(env.APPDATA, 'Cotal') : join(env.XDG_CONFIG_HOME || join(env.HOME, '.config'), 'cotal');
const seed = join(config, 'seed');
const cursor = join(seed, 'reconcile.cursor.json');
const machine = windows ? join(env.LOCALAPPDATA, 'Cotal') : join(env.HOME, '.cotal');
const clean = '/usr/bin:/bin:/usr/sbin:/sbin';
const run = (program, args, opts = {}) => exec(program, args, { cwd: root, env, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true, ...opts });
const pwsh = windows ? join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : '';
const ps = (script, args) => run(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args]);
const linuxUi = join(e2e, 'clean-install-linux-ui.py');
const redactions = [...new Set([root, env.HOME, env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA, env.USER, env.USERNAME, hostname()].filter(Boolean))].sort((a, b) => b.length - a.length);
function sanitized(text) {
  let result = String(text);
  for (const value of redactions.filter(value => value.length >= 3)) result = result.split(value).join('<private>');
  return result.replace(/\b(?:https?|nats):\/\/[^\s<>()]+/gi, '<address>').replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<address>').replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted>');
}
let passed = 0;
async function step(label, action) {
  try { await action(); report.log(`${++passed} PASS ${label}`); }
  catch (error) {
    report.error(`${passed + 1} FAIL ${label} (${passed} passed): ${sanitized(error.stderr?.trim() || error.message)}`);
    throw new Error('Desktop acceptance failed.');
  }
}
async function until(read, accepts, message, seconds = 45) {
  const end = Date.now() + seconds * 1000;
  do {
    const value = await read().catch(() => undefined);
    if (accepts(value)) return value;
    await delay(500);
  } while (Date.now() < end);
  throw new Error(message);
}
async function install(path) {
  if (mac) {
    const { stdout } = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-plist', path]);
    const volume = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(stdout)?.[1];
    assert.ok(volume, 'The disk image did not mount.');
    try {
      const source = join(volume, 'Cotal.app');
      if (old && path === resolve(old)) {
        const signature = await run('/usr/bin/codesign', ['--display', source]).catch(error => {
          if (!error.stderr?.includes('code object is not signed at all')) throw error;
        });
        if (signature) await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
        else report.log('The published app bundle is unsigned.');
      }
      if (existsSync(app)) rmSync(app, { recursive: true });
      await run('/usr/bin/ditto', [source, app]);
    } finally { await run('/usr/bin/hdiutil', ['detach', volume]); }
  } else if (windows) {
    try { await run(path, ['/S']); }
    catch (error) {
      const receipt = join(env.LOCALAPPDATA, 'CotalSetup', 'message.txt');
      throw new Error(existsSync(receipt) ? readFileSync(receipt, 'utf8').trim() : `Windows Setup exited ${error.code ?? 'without a result'}.`);
    }
  } else {
    const apt = path.endsWith('.deb');
    await run('/usr/bin/sudo', ['-n', apt ? '/usr/bin/apt-get' : '/usr/bin/dnf', '-y', '-q', 'install', path], { timeout: 240_000 });
  }
  assert.ok(existsSync(app), 'The installer did not put Cotal in its expected location.');
}
function packaged() {
  const base = mac ? join(app, 'Contents') : windows ? dirname(app) : '/usr/lib/Cotal';
  const node = mac ? join(base, 'MacOS/cotal-node') : windows ? join(base, 'node.exe') : '/usr/bin/cotal-node';
  const runtime = join(base, mac ? 'Resources/runtime' : 'runtime');
  return { node, runtime, version: JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version };
}
async function ui(operation, ...args) {
  const { stdout } = mac ? await run('/usr/bin/swift', [join(test, 'mac-updater-driver.swift'), app, operation, ...args], { timeout: 12_000 })
    : windows ? await ps(join(test, 'win-updater-driver.ps1'), [app, operation, ...args])
      : await run('/usr/bin/python3', [linuxUi, operation, ...args], { timeout: 12_000 });
  const result = JSON.parse(stdout);
  return operation === 'text' ? result.text ?? result : result;
}
let child, launched = false;
async function launch() {
  const executable = mac ? join(app, 'Contents/MacOS/cotal-desktop') : app;
  child = spawn(executable, [], { cwd: root, env, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  launched = true;
  await until(() => ui('describe'), x => x?.visible === true, 'The installed application did not expose a visible window.');
  if (mac) await until(() => ui('text', 'connection-title'), Boolean, 'This runner cannot inspect the app through Accessibility. Use a clean interactive Mac VM with Accessibility permission.');
}
async function quit() {
  if (!launched) return;
  if (mac || windows) await ui('quit'); else child?.kill();
  if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  await until(() => ui('describe').catch(() => null), x => !x?.visible, 'The old application did not quit.');
  launched = false;
}
// Read-only observation. The GUI alone starts the service and requests connection.
async function service() {
  const { node, runtime } = packaged();
  const result = spawnSync(node, [join(runtime, 'dist/cotal.js'), 'daemon', 'desktop'], { cwd: root, env, input: '{"op":"status"}\n', encoding: 'utf8', timeout: 5000, windowsHide: true });
  const reply = result.stdout?.split('\n').find(line => line.includes('"event":"result"'));
  return reply ? JSON.parse(reply) : undefined;
}
const answering = status => status?.ok && status.result.version === packaged().version && status.result.state === 'ready';
function latestRefusalWrite() {
  const daemon = join(machine, 'daemon');
  if (!existsSync(daemon)) return 0;
  return Math.max(0, ...readdirSync(daemon, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const path = join(daemon, entry.name, 'manager-refusal.json');
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  }));
}
async function refusal() {
  const shown = await ui('text', 'refusal-detail').catch(() => '');
  if (shown) return shown;
  await ui('click', 'details').catch(() => {});
  return (await ui('text', 'refusal-detail').catch(() => '')) || (await ui('text', 'notice').catch(() => ''));
}
async function connect(fixture) {
  await until(() => ui('click', 'dashboard'), Boolean, 'The app did not offer Open dashboard.').catch(async error => { throw new Error(await refusal() || error.message); });
  return await until(service, value => value?.result?.managers?.some(manager => manager.space === fixture.space && ['answering', 'refused'].includes(manager.state)), 'The daemon did not report a Manager outcome.', 120).catch(async error => { throw new Error(await refusal() || error.message); });
}
async function signin(fixture) {
  await until(() => ui('click', 'other-host'), Boolean, 'The app did not offer a custom host.');
  await ui('fill', 'provider', fixture.idpUrl);
  await until(() => ui('click', 'login'), Boolean, 'The app did not accept the loopback sign-in URL.');
}
async function observeClean() {
  assert.ok(!existsSync(app) && !existsSync(machine) && !existsSync(config), 'The session already contains Cotal files.');
  if (windows) assert.equal(existsSync(join(env.LOCALAPPDATA, 'CotalSetup')), false, 'The Windows test account already has Cotal Setup state.');
  if (mac) {
    for (const name of ['Library/LaunchAgents/ai.cotal.daemon.plist', 'Library/Application Support/ai.cotal.desktop', 'Library/Preferences/ai.cotal.desktop.plist']) {
      assert.equal(existsSync(join(env.HOME, name)), false, 'The Mac test account already has Cotal state.');
    }
  }
  if (windows) await ps(join(e2e, 'clean-install-windows-path.ps1'), []);
  else {
    assert.equal(env.PATH, clean);
    const script = 'for name in node nodejs npm npx brew choco winget cotal; do if command -v "$name" >/dev/null; then printf "%s is still resolvable\\n" "$name" >&2; exit 1; fi; done';
    await run('/bin/sh', ['-ec', script]);
    await run(userInfo().shell, ['-ilc', script]);
  }
}

let fixture;
try {
  await step('no external Node, npm, package manager shims or Cotal state', observeClean);
  await step(`install ${old ? 'the published older package' : 'the candidate package'}`, async () => {
    await install(resolve(old || candidate));
    if (old && process.env.OLD_VERSION) assert.equal(packaged().version, process.env.OLD_VERSION, 'The installer did not install the requested older build.');
  });
  await step('open the packaged desktop app', launch);
  await step('start the disposable loopback authority', async () => {
    fixture = await startFixtureAuthority({ root: join(root, 'authority'), brokerBinary: resolve(broker), deviceSignIn: true });
  });
  await step('start the background service through the app', async () => {
    await signin(fixture);
    await until(service, answering, 'The app background service did not answer at the installed version.').catch(async error => { throw new Error(await refusal() || error.message); });
  });
  let status, upgradeStarted;
  if (old) {
    await step('older app records its own missing npm failure', async () => {
      status = await connect(fixture);
      const row = status.result.managers.find(manager => manager.space === fixture.space);
      const recorded = existsSync(cursor) ? JSON.parse(readFileSync(cursor, 'utf8')) : null;
      assert.ok(row?.state === 'refused' && recorded?.failed && /npm.*(?:not found|not on PATH)/i.test(recorded.failed), row?.reason || await refusal() || 'The older installer did not record a missing npm seed failure.');
      report.log(sanitized(row.reason));
    });
    await step('install the candidate over the old package without clearing its state', async () => {
      const previous = packaged().version;
      await quit();
      upgradeStarted = Date.now();
      await install(resolve(candidate));
      assert.notEqual(packaged().version, previous, 'The candidate did not replace the older build.');
      await launch();
    });
    await step('the upgraded background service answers without intervention', async () => {
      await until(service, answering, 'The upgraded background service did not answer at the candidate version.', 120);
    });
  }
  await step('the app reconciles connectors and the hosted Manager answers', async () => {
    if (!old) status = await connect(fixture);
    else status = await until(service, value => answering(value) && value.result.managers?.some(row => row.space === fixture.space && (row.state === 'answering' || (row.state === 'refused' && latestRefusalWrite() >= upgradeStarted))), 'The upgraded app did not resume its Manager.', 120).catch(async error => {
      const current = await service();
      const row = current?.result?.managers?.find(manager => manager.space === fixture.space);
      throw new Error(row?.reason || await refusal() || error.message);
    });
    const row = status.result.managers.find(manager => manager.space === fixture.space);
    if (row.state !== 'answering') throw new Error(row.reason || await refusal() || 'The hosted Manager refused.');
    assert.ok(row.instanceId && row.connectors?.some(connector => connector.agent === 'claude'), 'The answering Manager did not inventory the stock connectors.');
    assert.equal(existsSync(cursor), false, 'A connector reconciliation cursor remained.');
    const stamp = JSON.parse(readFileSync(join(seed, 'stamp.json'), 'utf8'));
    assert.equal(stamp.generation, packaged().version, 'Connector reconciliation did not finish for the installed generation.');
  });
} catch (error) {
  if (error.message !== 'Desktop acceptance failed.') report.error(sanitized(error.message));
  process.exitCode = 1;
} finally {
  await quit().catch(() => {});
  await fixture?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
