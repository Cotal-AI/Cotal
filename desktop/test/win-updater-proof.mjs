import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = join(process.env.RUNNER_TEMP, 'win-updater-build');
const out = join(process.env.RUNNER_TEMP, 'win-updater-result');
mkdirSync(out, { recursive: true });
const build = JSON.parse(readFileSync(join(root, 'build-result.json'), 'utf8'));
assert.equal(build.debug, true);
const driver = fileURLToPath(new URL('win-updater-driver.ps1', import.meta.url));
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const installDir = join(process.env.LOCALAPPDATA, 'Cotal');
const setupHome = join(process.env.LOCALAPPDATA, 'CotalSetup');
const appExe = join(installDir, 'cotal-desktop.exe');
const node = join(installDir, 'node.exe');
const runtime = join(installDir, 'runtime');
const cli = join(runtime, 'dist', 'cotal.js');
const rawPathEntries = (process.env.PATH ?? '').split(delimiter).filter(entry => entry !== '');
const inheritedPath = rawPathEntries.filter(entry => isAbsolute(entry));
const droppedPath = rawPathEntries.filter(entry => !isAbsolute(entry));
const env = { ...process.env, PATH: [dirname(node), ...inheritedPath].join(delimiter), COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' };
for (const key of Object.keys(env)) {
  if ((key.startsWith('COTAL_') && key !== 'COTAL_SKIP_CONNECTOR_SEED' && key !== 'COTAL_TELEMETRY') || key.startsWith('TAURI_SIGNING_') || key.toLowerCase() === 'psmodulepath') {
    delete env[key];
  }
}

let mode = 'publication';
let targetHop = 'N1';
const requests = [];
const n1Bytes = readFileSync(join(root, 'N1-setup.exe'));
const n1Signature = readFileSync(join(root, 'N1-setup.exe.sig'), 'utf8').trim();
const n2Bytes = readFileSync(join(root, 'N2-setup.exe'));
const n2Signature = readFileSync(join(root, 'N2-setup.exe.sig'), 'utf8').trim();
const invalidBytes = readFileSync(join(root, 'invalid-install.exe'));
const invalidSignature = readFileSync(join(root, 'invalid-install.exe.sig'), 'utf8').trim();

const server = createServer((req, res) => {
  requests.push({ at: Date.now(), path: req.url, mode, targetHop });
  const version = targetHop === 'N2' ? '0.164.10' : '0.164.9';
  const activeBytes = targetHop === 'N2' ? n2Bytes : n1Bytes;
  const activeSignature = targetHop === 'N2' ? n2Signature : n1Signature;
  if (req.url === '/latest.json') {
    if (mode === 'publication') { res.writeHead(404); res.end(); return; }
    const sig = mode === 'install-error' ? invalidSignature : mode === 'bad-signature' ? activeSignature.slice(0, -8) + 'AAAAAAAA' : activeSignature;
    const entry = { url: 'http://127.0.0.1:43189/update.exe', ...(mode === 'missing-signature' ? {} : { signature: sig }) };
    const manifest = { version, platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry } };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(manifest));
    return;
  }
  if (req.url === '/update.exe') {
    const responseBytes = mode === 'install-error' ? invalidBytes : activeBytes;
    res.setHeader('content-length', responseBytes.length);
    if (mode === 'slow') {
      let offset = 0;
      const timer = setInterval(() => {
        const next = Math.min(activeBytes.length, offset + Math.ceil(activeBytes.length / 40));
        res.write(activeBytes.subarray(offset, next));
        offset = next;
        if (offset === activeBytes.length) { clearInterval(timer); res.end(); }
      }, 500);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (mode === 'interrupted') { res.write(activeBytes.subarray(0, Math.floor(activeBytes.length / 3))); res.destroy(); return; }
    res.end(responseBytes);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise(resolveListen => server.listen(43189, '127.0.0.1', resolveListen));

const records = [];
const record = (name, value) => {
  records.push({ name, at: new Date().toISOString(), value });
  writeFileSync(join(out, 'observations.json'), JSON.stringify(records, null, 2));
};
record('runner PATH filter', { droppedCount: droppedPath.length, dropped: droppedPath });

const run = async (command, args, options = {}) => {
  const result = await execute(command, args, { env, windowsHide: true, timeout: 240_000, maxBuffer: 4 * 1024 * 1024, ...options });
  return result.stdout;
};
const call = async (...args) => {
  let raw;
  try { raw = await run(node, [cli, ...args, '--json']); }
  catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) raw = error.stdout;
    else throw error;
  }
  const envelope = JSON.parse(raw);
  return { ...envelope, ok: envelope.outcome === 'ok' };
};
const ui = async (operation, targetId = '') => {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, '-AppPath', appExe, '-Operation', operation];
  if (targetId) args.push('-TargetId', targetId);
  const result = JSON.parse(await run(ps, args, { timeout: 90_000 }));
  if (operation === 'click' || operation === 'settings' || operation === 'close' || (operation === 'text' && result?.mainScreenWait?.waitedMs > 0)) {
    record(`ui ${[operation, targetId].filter(Boolean).join(' ')}`, result);
  }
  return operation === 'text' ? result.text : result;
};
async function until(name, observe, accept, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { last = await observe(); if (accept(last)) { record(name, last); return last; } }
    catch (error) { last = { error: error.message }; }
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`${name} did not complete: ${JSON.stringify(last)}`);
}
const launchApp = (args = []) => {
  const child = spawn(appExe, args, { env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
};
const quitApp = async name => {
  const current = await ui('describe');
  await ui('quit');
  await until(name, () => { try { process.kill(current.pid, 0); return false; } catch { return true; } }, Boolean, 30_000);
};
const installed = () => JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
const readSetupResult = () => {
  const file = join(setupHome, 'result.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
};

let fixture, seat, manager;
let seatStarted = false;
let serviceInstalled = false;
let appInstalled = false;
let cleanupError;
try {
  assert.equal(existsSync(installDir), false, 'Hosted app destination must be absent');
  await run(join(root, 'N-setup.exe'), ['/S']);
  appInstalled = true;
  assert.equal(installed(), '0.164.8');
  const initial = await call('daemon', 'status');
  record('initial daemon status', initial);
  assert.equal(initial.ok, false, 'Default native service must be absent');
  assert.equal(initial.outcome, 'refused', 'Default native service must be absent');
  assert.equal(initial.error?.code, 'TARGET_UNAVAILABLE', 'Default native service must be absent');
  assert.equal(initial.error?.cause?.code, 'NOT_RUNNING', 'Default native service must be absent');
  const installation = await call('daemon', 'install');
  assert.equal(installation.ok, true, JSON.stringify(installation));
  serviceInstalled = true;
  const before = await until('installed Windows service N', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.8' && reply.result.state === 'ready');
  // Read process birth and start the hosted Manager in short-lived child processes so the
  // test runner never dlopens native .node addons inside the installed runtime directory.
  const processBirth = async pid => {
    const script = `import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(${JSON.stringify(join(runtime, 'dist/daemon/lifetime.js'))}).href); process.stdout.write(String(m.processBirth(${Number(pid)}) ?? ''));`;
    return (await run(node, ['--input-type=module', '-e', script])).trim();
  };
  record('service N kernel lifetime', { pid: before.result.pid, birth: await processBirth(before.result.pid) });

  const fixtureRoot = resolve(process.env.COTAL_WIN_FIXTURE_ROOT ?? '.');
  assert.ok(existsSync(join(fixtureRoot, 'bin/smoke/_fixture-seat.mjs')), 'Shared fixture must exist in the checkout');
  const fixtureHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, windowsHide: true })).stdout.trim();
  assert.match(fixtureHead, /^[a-f0-9]{40}$/);
  record('shared fixture source', { head: fixtureHead });
  const workspace = await import(pathToFileURL(join(fixtureRoot, 'packages/workspace/dist/index.js')).href);
  const { createFixtureSpace } = await import(pathToFileURL(join(fixtureRoot, 'bin/smoke/_fixture-space.mjs')).href);
  const { installFixtureSeat } = await import(pathToFileURL(join(fixtureRoot, 'bin/smoke/_fixture-seat.mjs')).href);
  fixture = await createFixtureSpace({ root: join(root, 'occupied'), machineHome: workspace.homeCotalDir(), runtime, node, env });
  seat = await installFixtureSeat({ root: join(root, 'occupied'), runtime, node, env, cwd: fixture.participant, space: fixture.space });
  const startManagerScript = `
    import { pathToFileURL } from 'node:url';
    const { openVerified, readLine } = await import(pathToFileURL(${JSON.stringify(join(runtime, 'dist/daemon/client.js'))}).href);
    const { daemonPaths } = await import(pathToFileURL(${JSON.stringify(join(runtime, 'dist/daemon/endpoint.js'))}).href);
    const socket = await openVerified({ paths: daemonPaths() });
    try {
      const pending = readLine(socket, 110_000);
      socket.write(JSON.stringify({ v: 1, id: 'fixture-manager-start', op: 'manager-start', space: ${JSON.stringify(fixture.space)} }) + '\\n');
      process.stdout.write(await pending);
    } finally { socket.destroy(); }
  `;
  const managerReply = JSON.parse(await run(node, ['--input-type=module', '-e', startManagerScript]));
  assert.ok(managerReply.ok && managerReply.result?.state === 'answering', JSON.stringify(managerReply));
  manager = managerReply.result;
  await until('fixture Manager ready on service N', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.8' && reply.result.managers?.some(item => item.space === fixture.space && item.state === 'answering' && item.connectors?.some(connector => connector.state === 'available')));

  launchApp();
  const firstApp = await until('visible N app', () => ui('describe'), value => value.visible);
  record('app N kernel lifetime', firstApp);
  await ui('settings');
  await until('initial publication gap', () => ui('text', 'settings-update-summary'), text => text.includes('still being prepared'));
  const initialUi = await ui('dump');
  writeFileSync(join(out, 'app-ui.json'), JSON.stringify(initialUi, null, 2));
  assert.equal(initialUi.nodes.some(item => item.id === 'settings-update-summary' && (item.text ?? item.name ?? '').includes('still being prepared')), true, 'settings-update-summary must appear in app-ui.json with its text');
  mode = 'valid';
  await ui('click', 'check-updates');
  await until('visible candidate remains uninstalled', () => ui('text', 'settings-update-summary'), text => text.includes('0.164.9') && text.includes('Restart to update'));
  assert.equal(installed(), '0.164.8');
  assert.equal(requests.filter(item => item.path === '/update.exe').length, 0, 'A visible app does not download automatically');

  assert.equal((await run(node, [cli, 'update', '--auto', 'off'])).includes('Automatic updates: off'), true);
  await quitApp('N app exited');
  launchApp(['--background']);
  await until('background N app running', () => ui('describe'), value => value.visible === false);
  await delay(5000);
  assert.equal(installed(), '0.164.8');
  assert.equal(requests.filter(item => item.path === '/update.exe').length, 0);
  record('automatic off leaves N and no download', { version: installed() });
  await quitApp('background N app exited');

  mode = 'publication';
  launchApp();
  await until('N visible for download controls', () => ui('describe'), value => value.visible);
  assert.equal((await run(node, [cli, 'update', '--auto', 'on'])).includes('Automatic updates: on'), true);
  await ui('settings');
  mode = 'slow';
  await ui('click', 'check-updates');
  await until('slow candidate', () => ui('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  let count = requests.filter(item => item.path === '/update.exe').length;
  await ui('close');
  await until('hidden slow download started', async () => requests.filter(item => item.path === '/update.exe').length, value => value > count);
  launchApp();
  await until('Open during download immediately shows window', () => ui('describe'), value => value.visible, 15_000);
  assert.equal(installed(), '0.164.8');
  await ui('settings');
  await until('Open during download leaves verified N ready', () => ui('text', 'settings-update-summary'), text => text.includes('downloaded and verified'), 90_000);
  assert.equal(installed(), '0.164.8');
  record('Open during slowed automatic download', { version: installed() });
  await quitApp('N exited after slow download');

  mode = 'publication';
  launchApp();
  await until('N visible before Quit download control', () => ui('describe'), value => value.visible);
  await ui('settings');
  mode = 'slow';
  await ui('click', 'check-updates');
  await until('second slow candidate', () => ui('text', 'settings-update-summary'), text => text.includes('Restart to update'));
  count = requests.filter(item => item.path === '/update.exe').length;
  await ui('close');
  await until('second hidden slow download started', async () => requests.filter(item => item.path === '/update.exe').length, value => value > count);
  await quitApp('Quit during download exits N');
  assert.equal(installed(), '0.164.8');

  mode = 'publication';
  launchApp();
  await until('N reopened for negative controls', () => ui('describe'), value => value.visible);
  await ui('settings');
  for (const control of ['missing-signature', 'bad-signature', 'interrupted', 'install-error']) {
    mode = control;
    const priorRequests = requests.filter(item => item.path === '/latest.json').length;
    await ui('click', 'check-updates');
    await until(`${control} manifest requested`, async () => requests.filter(item => item.path === '/latest.json').length, value => value > priorRequests);
    if (control !== 'missing-signature') {
      await ui('settings');
      await until(`${control} candidate`, () => ui('text', 'settings-update-summary'), text => text.includes('Restart to update'));
      const priorDownloads = requests.filter(item => item.path === '/update.exe').length;
      await ui('click', 'restart-update');
      await until(`${control} native download requested`, async () => requests.filter(item => item.path === '/update.exe').length, value => value > priorDownloads);
    }
    await until(`${control} native refusal`, () => ui('text', 'settings-update-summary'), text => text.includes('failed:'));
    assert.equal(installed(), '0.164.8');
    const healthy = await call('daemon', 'status');
    assert.equal(healthy.ok, true);
    assert.equal(healthy.result.version, '0.164.8');
    record(`${control} preserves running N`, { version: installed(), daemon: healthy.result.pid });
  }

  mode = 'valid';
  await ui('click', 'check-updates');
  await until('valid N1 manifest after controls', () => ui('text', 'settings-update-summary'), text => text.includes('0.164.9') && text.includes('Restart to update'));
  const started = await seat.spawn(manager.instanceId);
  seatStarted = true;
  const seatBirth = await processBirth(started.pid);
  assert.ok(seatBirth, 'Actual PTY child birth must be readable');
  record('real joined PTY seat', { pid: started.pid, birth: seatBirth, name: started.name, manager: manager.instanceId });
  const occupiedDaemon = (await call('daemon', 'status')).result;
  const preOccupiedApp = await ui('describe');
  await ui('settings');
  await until('Restart action before occupied seat test', () => ui('text', 'settings-update-summary'), text => text.includes('Restart to update'));

  // Automatic apply while an agent is running must leave the app running, launch no installer, and show the waiting reason in Settings.
  await ui('close');
  await delay(5000);
  const stillRunningApp = await ui('describe');
  assert.equal(stillRunningApp.pid, preOccupiedApp.pid, 'Automatic apply must not exit the app while an agent is running');
  assert.equal(stillRunningApp.birth, preOccupiedApp.birth, 'Automatic apply must keep the same app lifetime while an agent is running');
  assert.equal(stillRunningApp.visible, false);
  assert.equal(installed(), '0.164.8');
  assert.equal(readSetupResult()?.toVersion === '0.164.9', false, 'Automatic apply must not launch NSIS while an agent is running');
  launchApp();
  await until('N app reopened after occupied automatic wait', () => ui('describe'), value => value.pid === preOccupiedApp.pid && value.visible === true);
  await ui('settings');
  await until('Settings shows automatic waiting reason for occupied seat', () => ui('text', 'settings-update-summary'), text => text.includes('0.164.9') && text.includes('1 agent(s) are running (upgrade_fixture). Automatic update will wait until they finish, or choose Restart to update.'));
  record('occupied seat automatic apply waits without installer handoff', { app: stillRunningApp, daemonPid: occupiedDaemon.pid, seatPid: started.pid });

  // Explicit Restart to update still hands off to NSIS and surfaces the code-20 reason in Settings.
  await ui('click', 'restart-update');

  const occupiedSetup = await until('NSIS setup refuses occupied seat with code 20', async () => readSetupResult(), value => value && value.toVersion === '0.164.9' && value.outcome === 'refused' && value.code === 20);
  assert.equal(occupiedSetup.activeAgents, 1);
  const postOccupiedApp = await until('N app relaunched visible after occupied setup refusal', () => ui('describe'), value => value.visible === true && value.pid !== preOccupiedApp.pid && value.birth !== preOccupiedApp.birth);
  assert.equal(installed(), '0.164.8');
  const postOccupiedDaemon = (await call('daemon', 'status')).result;
  assert.equal(postOccupiedDaemon.pid, occupiedDaemon.pid, 'Service N PID must survive occupied setup refusal');
  assert.equal(await processBirth(started.pid), seatBirth, 'Occupied seat process must survive setup refusal');
  await until('main view shows setup code 20 failure', () => ui('text', 'applied-update'), text => text.includes('Setup code 20:') && text.includes('1 agent(s) are running'));
  await ui('settings');
  await until('Settings shows setup code 20 and reason', () => ui('text', 'settings-update-summary'), text => text.includes('0.164.9') && text.includes('Setup code 20:') && text.includes('1 agent(s) are running. Stop them and choose Retry.'));
  const postOccupiedDump = await ui('dump');
  record('occupied seat refusal verified in Settings', {
    app: postOccupiedApp,
    setup: occupiedSetup,
    daemonPid: postOccupiedDaemon.pid,
    seatPid: started.pid,
    settingsMessage: postOccupiedDump.nodes.find(item => item.id === 'settings-message')?.text ?? '',
    restartButtonVisible: postOccupiedDump.nodes.some(item => item.id === 'restart-update' && !item.offscreen),
    preferenceNode: postOccupiedDump.nodes.find(item => item.id === 'update-preference') ?? null,
  });

  await seat.stop(manager.instanceId);
  seatStarted = false;
  await until('occupied seat cleared in daemon status', () => call('daemon', 'status'), reply => reply.ok && reply.result.agents?.every(row => row.state === 'read' && row.agents.length === 0));

  // Hop 1 (0.164.8 -> 0.164.9): N+1's bundled daemon throws before it binds, so setup restores N.
  await ui('close');
  const hop = await until('Hop 1 setup finished', async () => readSetupResult(), value => value && value.toVersion === '0.164.9' && (value.outcome === 'rolled-back' && value.code === 23 || value.outcome === 'refused'));
  if (hop.outcome === 'refused') {
    const probe = join(out, 'refusal-probe.ps1');
    writeFileSync(probe, [
      "$runtime = Join-Path $env:LOCALAPPDATA 'Cotal\\runtime'",
      "$acl = Get-Acl -LiteralPath $runtime",
      "$first = Get-ChildItem -LiteralPath $runtime -Force | Select-Object -First 1",
      "$entry = if ($first) { Get-Acl -LiteralPath $first.FullName } else { $null }",
      "$readonly = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReadOnly } | Select-Object -ExpandProperty FullName)",
      "$session = [uint32]0; $key = 'cotal-proof-holders-0000000000000'",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProofHolders { [DllImport(\"rstrtmgr.dll\", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint s, uint f, string k); [DllImport(\"rstrtmgr.dll\", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint s, uint n, string[] p, uint a, IntPtr ap, uint sv, string[] sn); [DllImport(\"rstrtmgr.dll\", CharSet=CharSet.Unicode)] public static extern int RmGetList(uint s, out uint need, ref uint count, IntPtr info, out uint reboot); [DllImport(\"rstrtmgr.dll\")] public static extern int RmEndSession(uint s); }'",
      "$started = [ProofHolders]::RmStartSession([ref]$session, 0, $key)",
      "$registered = if ($started -eq 0) { [ProofHolders]::RmRegisterResources($session, 1, @($runtime), 0, [IntPtr]::Zero, 0, @()) } else { $started }",
      "$needed = [uint32]0; $count = [uint32]0; $reboot = [uint32]0",
      "$listed = if ($registered -eq 0) { [ProofHolders]::RmGetList($session, [ref]$needed, [ref]$count, [IntPtr]::Zero, [ref]$reboot) } else { $registered }",
      "if ($started -eq 0) { [void][ProofHolders]::RmEndSession($session) }",
      "[pscustomobject]@{ owner = $acl.Owner; access = @($acl.Access | ForEach-Object { $_.IdentityReference.Value + ' ' + $_.FileSystemRights }); first = $first.FullName; firstOwner = $entry.Owner; readOnly = $readonly; holderQuery = @{ started = $started; registered = $registered; listed = $listed; needed = $needed }; helperSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Depth 4",
    ].join('\n'));
    let folder = 'probe failed';
    try { folder = JSON.parse((await execute(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8' })).stdout); }
    catch (error) { folder = error.message; }
    const version = existsSync(join(runtime, 'package.json')) ? JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version : null;
    const service = await call('daemon', 'status').catch(error => ({ ok: false, message: error.message }));
    record('Hop 1 refusal left this state', { setup: hop, folder, installedVersion: version, service });
  }
  const rolledBack = hop;
  assert.equal(rolledBack.fromVersion, '0.164.8');
  assert.equal(await installed(), '0.164.8');
  const restored = await until('Hop 1 service and Manager ready again on 0.164.8', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.8' && reply.result.state === 'ready');
  const previousGone = !existsSync(join(dirname(installDir), 'CotalSetup-previous'));
  record('Hop 1 rolled back', { setup: rolledBack, servicePid: restored.result.pid, previousRemoved: previousGone });

  launchApp();
  const restoredApp = await until('Hop 1 restored 0.164.8 opens its window', () => ui('describe'), value => value.visible === true);
  const reasonText = await ui('text', 'connection-description');
  assert.match(reasonText, /running again/, 'The restored window shows the rollback reason');
  record('Hop 1 window shows the reason', { pid: restoredApp.pid, reasonText });

  await quitApp('restored 0.164.8 app exited');
  launchApp(['--background']);
  await until('second 0.164.8 background start', () => ui('describe'), value => value.visible === false && value.commandLine.includes('--background'));
  launchApp();
  const secondApp = await until('second 0.164.8 start visible', () => ui('describe'), value => value.visible === true);

  // Hop 2 (0.164.8 -> 0.164.10): the rolled-back version is skipped and a good newer version installs.
  targetHop = 'N2';
  mode = 'valid';
  await ui('settings');
  await ui('click', 'check-updates');
  await until('Hop 2 N2 candidate in restored Settings', () => ui('text', 'settings-update-summary'), text => text.includes('0.164.10') && text.includes('Restart to update'));
  await ui('click', 'restart-update');
  await until('Hop 2 N2 installed on disk', async () => installed(), version => version === '0.164.10');
  const hop2Setup = await until('Hop 2 setup result updated to 0.164.10', async () => readSetupResult(), value => value && value.toVersion === '0.164.10' && value.outcome === 'updated' && value.code === 0);
  assert.equal(hop2Setup.fromVersion, '0.164.8');
  const hop2VisibleApp = await until('Hop 2 relaunched 0.164.10 app opens visible automatically', () => ui('describe'), value => value.pid !== secondApp.pid && value.birth !== secondApp.birth && value.visible === true);
  const hop2Service = await until('Hop 2 service and Manager ready on 0.164.10', () => call('daemon', 'status'), reply => reply.ok && reply.result.version === '0.164.10' && reply.result.state === 'ready' && reply.result.managers?.every(item => item.state === 'answering' && item.connectors?.some(connector => connector.state === 'available')));
  await until('Hop 2 app confirms Updated to Cotal 0.164.10.', () => ui('text', 'applied-update'), text => text === 'Updated to Cotal 0.164.10.');
  record('Hop 2 explicit restart completed', { app: hop2VisibleApp, setup: hop2Setup, servicePid: hop2Service.result.pid });

  assert.equal((await run(node, [cli, '--version'])).trim().includes('0.164.10'), true);
  const inventory = JSON.parse(readFileSync(join(runtime, 'desktop-runtime.json'), 'utf8'));
  assert.equal(inventory.version, '0.164.10');
  for (const file of inventory.files) {
    assert.equal(createHash('sha256').update(readFileSync(join(runtime, file.path))).digest('hex'), file.sha256);
  }
  const seeded = join(runtime, 'seeded-connectors');
  const connectorVersions = {};
  for (const name of readdirSync(seeded)) {
    const file = join(seeded, name, 'package.json');
    if (existsSync(file)) connectorVersions[name] = JSON.parse(readFileSync(file, 'utf8')).version;
  }
  assert.ok(Object.keys(connectorVersions).length >= 6);
  assert.ok(Object.values(connectorVersions).every(version => version === '0.164.10'));
  record('target bundled graph', { version: installed(), connectorVersions, checkedRuntimeFiles: inventory.files.length });

  writeFileSync(join(out, 'result.json'), JSON.stringify({
    schema: 1,
    source: build.source,
    passed: true,
    debug: true,
    realScheduledTask: true,
    realFixturePty: true,
    publication: false,
    hops: ['0.164.8->0.164.9 (rolled-back)', '0.164.8->0.164.10 (good-after-rollback)'],
    controls: [
      'visible-waits',
      'off',
      'open-during-download',
      'quit-during-download',
      'missing-signature',
      'bad-signature',
      'interrupted-download',
      'install-error',
      'occupied-seat-automatic-waits',
      'occupied-seat-code-20',
      'rollback-hop1',
      'rollback-reason-visible',
      'good-n2-after-rollback',
      'target-service-and-manager-ready',
    ],
  }, null, 2));
} catch (error) {
  const failure = { message: error.message, stack: error.stack, observation: error.observation, setupResult: readSetupResult() };
  try {
    const setupCheck = await run(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*installer*.exe' -or $_.Name -like '*setup*.exe' }); $rows = @(); foreach ($p in $procs) { $w = @(); try { $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$p.ProcessId); $els = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond); foreach ($el in $els) { if ($el.Current.Name) { $w += [string]$el.Current.Name } } } catch {} $rows += @{ pid = [int]$p.ProcessId; name = [string]$p.Name; commandLine = [string]$p.CommandLine; texts = $w } }; $rows | ConvertTo-Json -Depth 4 -Compress",
    ]);
    failure.activeSetupProcesses = JSON.parse(setupCheck || '[]');
  } catch (setupDiagError) {
    failure.activeSetupProcessesError = setupDiagError.message;
  }
  try {
    let desc = await ui('describe');
    failure.appBeforeReopen = desc;
    if (!desc.visible) {
      launchApp();
      desc = await until('reopen hidden app after failure', () => ui('describe'), value => value.visible === true, 30_000);
    }
    failure.appAfterReopen = desc;
    await ui('settings');
    const settingsDump = await ui('dump');
    failure.settingsUpdateSummary = settingsDump.nodes.find(item => item.id === 'settings-update-summary')?.text ?? (await ui('text', 'settings-update-summary'));
    failure.settingsMessage = settingsDump.nodes.find(item => item.id === 'settings-message')?.text ?? '';
    failure.settingsLastCheck = settingsDump.nodes.find(item => item.id === 'settings-last-check')?.text ?? '';
    failure.restartButtonVisible = settingsDump.nodes.some(item => item.id === 'restart-update' && !item.offscreen);
    await ui('click', 'open-settings');
    const mainDump = await ui('dump');
    failure.appliedUpdate = mainDump.nodes.find(item => item.id === 'applied-update')?.text ?? '';
    failure.notice = mainDump.nodes.find(item => item.id === 'notice')?.text ?? '';
    record('failure settings diagnostics', {
      appBeforeReopen: failure.appBeforeReopen,
      appAfterReopen: failure.appAfterReopen,
      settingsUpdateSummary: failure.settingsUpdateSummary,
      settingsMessage: failure.settingsMessage,
      settingsLastCheck: failure.settingsLastCheck,
      restartButtonVisible: failure.restartButtonVisible,
      appliedUpdate: failure.appliedUpdate,
      notice: failure.notice,
    });
    writeFileSync(join(out, 'app-ui.json'), JSON.stringify({ settingsView: settingsDump, mainView: mainDump }, null, 2));
  } catch (diagnostic) {
    failure.uiDiagnosticError = diagnostic.message;
    writeFileSync(join(out, 'app-ui-error.txt'), diagnostic.message);
  }
  writeFileSync(join(out, 'failure.json'), JSON.stringify(failure, null, 2));
  throw error;
} finally {
  for (const file of ['helper.log', 'service-update.json', 'result.json', 'holders.json', 'runtime-read.jsonl', 'message.txt']) {
    const path = join(setupHome, file);
    if (existsSync(path)) writeFileSync(join(out, `setup-${file}`), readFileSync(path));
  }
  const appConfigDir = process.env.APPDATA ? join(process.env.APPDATA, 'ai.cotal.desktop') : '';
  for (const file of ['desktop-update.json', 'desktop-apply.json', 'presence.json']) {
    const path = appConfigDir ? join(appConfigDir, file) : '';
    if (path && existsSync(path)) writeFileSync(join(out, `config-${file}`), readFileSync(path));
  }
  let seatCleanup = 'not started';
  try {
    if (seatStarted && seat && manager) {
      await seat.stop(manager.instanceId);
      seatStarted = false;
      seatCleanup = 'stopped';
    }
  } catch (error) {
    seatCleanup = `failed: ${error.message}`;
    cleanupError = error;
  }
  try { await ui('quit'); } catch (error) { record('app quit observation', { reason: error.message }); }
  try {
    await run(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Cotal*installer*.exe' -or $_.Name -like 'N*-setup.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ]);
  } catch { /* best-effort cleanup of any stalled setup process */ }
  try {
    if (serviceInstalled) {
      const removed = await call('daemon', 'uninstall', '--yes');
      assert.equal(removed.ok, true, JSON.stringify(removed));
    }
  } catch (error) { cleanupError ??= error; }
  try {
    if (appInstalled && existsSync(join(installDir, 'uninstall.exe'))) {
      await run(join(installDir, 'uninstall.exe'), ['/S', `_?=${installDir}`]);
    }
  } catch (error) { cleanupError ??= error; }
  try { await fixture?.close(); } catch (error) { cleanupError ??= error; }
  await new Promise(resolveClose => server.close(resolveClose));
  writeFileSync(join(out, 'requests.json'), JSON.stringify(requests, null, 2));
  writeFileSync(join(out, 'cleanup.json'), JSON.stringify({ confirmed: !cleanupError, seat: seatCleanup, reason: cleanupError?.message }, null, 2));
  if (cleanupError) throw cleanupError;
}
