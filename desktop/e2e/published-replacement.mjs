import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.ok(['darwin', 'win32'].includes(process.platform));
const mode = process.env.DESKTOP_REPLACEMENT_MODE;
assert.ok(['window-open', 'service-only'].includes(mode));
assert.ok(process.env.RUNNER_TEMP);
process.umask(0o077);
const here = dirname(fileURLToPath(import.meta.url));
const output = join(process.env.RUNNER_TEMP, 'desktop-replacement');
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
env.DO_NOT_TRACK = '1';
const ps = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined;
const appRoot = process.platform === 'darwin' ? '/Applications/Cotal.app' : join(process.env.LOCALAPPDATA, 'Cotal');
const binary = join(appRoot, process.platform === 'darwin' ? 'Contents/MacOS/cotal-desktop' : 'cotal-desktop.exe');
const node = join(appRoot, process.platform === 'darwin' ? 'Contents/MacOS/cotal-node' : 'node.exe');
const runtime = join(appRoot, process.platform === 'darwin' ? 'Contents/Resources/runtime' : 'runtime');
const cli = join(runtime, 'dist/cotal.js');
const report = { schema: 1, mode, platform: process.platform, arch: process.arch, appRoot, startedAt: new Date().toISOString(), calls: [], samples: [], cleanup: 'not-started' };
let installed = false, serviceAttempted = false, installerUnknown = false, windowOutstanding = false, app;
const mounts = [];
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
async function run(file, args, timeout = 120_000) {
  const startedAt = new Date().toISOString();
  return new Promise(resolveRun => {
    execFile(file, args, { env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const result = { startedAt, completedAt: new Date().toISOString(), code: error ? typeof error.code === 'number' ? error.code : null : 0,
        signal: error?.signal ?? null, killed: error?.killed ?? false, error: error?.message, stdout, stderr };
      resolveRun(result);
    });
  });
}
async function required(file, args, timeout) {
  const result = await run(file, args, timeout);
  assert.equal(result.code, 0, `${file}: ${result.stderr || result.error}`);
  assert.equal(result.signal, null);
  return result.stdout;
}
async function daemon(verb, ...flags) {
  const result = await run(node, [cli, 'daemon', verb, '--json', ...flags]);
  let body;
  try { body = JSON.parse(result.stdout); } catch { /* Preserve failed command without inferring a result. */ }
  const row = { verb, ...result, body };
  report.calls.push(row); save();
  return row;
}
async function kernelBirth(pid) {
  if (process.platform === 'darwin') {
    const result = await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }
  const result = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}
async function waitStatus(expected, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await daemon('status');
    if (last.code === 0 && (!expected || last.body?.result?.version === expected)) return last.body.result;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error(`Service did not answer ${expected ?? ''}: ${JSON.stringify(last?.body ?? last?.error)}`);
}
async function download(version) {
  const suffix = process.platform === 'darwin' ? 'aarch64.dmg' : 'x64-setup.exe';
  const name = `Cotal_${version}_${suffix}`;
  const meta = await fetch(`https://api.github.com/repos/Cotal-AI/Cotal/releases/tags/v${version}`, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/vnd.github+json' } });
  assert.equal(meta.status, 200);
  const release = await meta.json();
  assert.equal(release.draft, false); assert.equal(release.tag_name, `v${version}`);
  const asset = release.assets.find(asset => asset.name === name);
  assert.ok(asset?.digest?.startsWith('sha256:'), 'published asset must expose its digest');
  assert.equal(asset.browser_download_url, `https://github.com/Cotal-AI/Cotal/releases/download/v${version}/${name}`);
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200); assert.ok(response.body);
  const path = join(process.env.RUNNER_TEMP, name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  const bytes = readFileSync(path);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.digest.slice(7));
  report[`asset${version}`] = { name, size: bytes.length, digest: asset.digest, id: asset.id };
  save(); return path;
}
async function install(path, replacing = false) {
  if (process.platform === 'win32') {
    const result = await run(path, ['/S'], 180_000);
    if (result.code === null || result.signal || result.killed) installerUnknown = true;
    report[replacing ? 'replacement' : 'initialInstall'] = result; save();
    return result;
  }
  const mount = join(process.env.RUNNER_TEMP, replacing ? 'dmg-next' : 'dmg-previous');
  mkdirSync(mount); mounts.push(mount);
  await required('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path]);
  const source = join(mount, 'Cotal.app');
  assert.ok(existsSync(source));
  // Finder's replace operation is the same copy action the mounted DMG offers a person.
  const result = replacing ? await run('/usr/bin/osascript', ['-e', `tell application "Finder" to duplicate POSIX file ${JSON.stringify(source)} to POSIX file "/Applications" with replacing`], 120_000)
    : await run('/usr/bin/ditto', [source, appRoot]);
  if (result.code === null || result.signal || result.killed) installerUnknown = true;
  report[replacing ? 'replacement' : 'initialInstall'] = result; save(); return result;
}
function inventory(root = appRoot) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const stat = statSync(path);
        files.push({ file: relative(root, path), bytes: stat.size, dev: stat.dev, ino: stat.ino,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    }
  };
  visit(root); return files;
}
async function observe(pid, label) {
  const row = { label, at: new Date().toISOString(), pid };
  if (process.platform === 'darwin') {
    // -Fn emits names only, never COMMAND or process arguments.
    row.files = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn']);
    row.bundledFiles = [...new Set(row.files.stdout.split('\n').filter(line => line.startsWith(`n${appRoot}/`)).map(line => line.slice(1)))];
    row.birth = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim();
    assert.equal(row.files.code, 0, 'owned service open-file query completed');
    assert.ok(row.birth, 'owned service lifetime remains observable');
    row.executable = (await run('/bin/ps', ['-p', String(pid), '-o', 'comm='])).stdout.trim();
  } else {
    assert.ok(process.env.DESKTOP_MEASURE_HANDLE);
    row.handles = await run(process.env.DESKTOP_MEASURE_HANDLE, ['-accepteula', '-nobanner', '-v', '-p', String(pid)]);
    assert.equal(row.handles.code, 0, 'owned service handle query completed');
    row.native = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(here, 'replacement-windows-observe.ps1'), '-TargetPid', String(pid), '-Output', join(output, `${label}.png`)]);
    try { row.process = JSON.parse(row.native.stdout); } catch { row.process = null; }
    assert.ok(row.process, `owned ${label} PID observation must complete`);
    row.bundledModules = row.process.modules.filter(file => file.toLowerCase().startsWith(appRoot.toLowerCase()));
  }
  report.samples.push(row); save(); return row;
}
async function window(label) {
  if (!app?.pid || app.exitCode !== null || app.signalCode !== null) {
    const screenshot = process.platform === 'darwin' ? await run('/usr/sbin/screencapture', ['-x', join(output, `${label}.png`)]) : null;
    report.samples.push({ label, window: 'not-running', screenshot }); save(); return;
  }
  if (process.platform === 'darwin') {
    const helper = join(here, 'macos-driver.swift');
    const tree = await run('/usr/bin/swift', [helper, String(app.pid), 'ax-dump']);
    const shot = await run('/usr/sbin/screencapture', ['-x', join(output, `${label}.png`)]);
    if (tree.code !== 0 || shot.code !== 0) { report.windowObservationIncomplete = true; process.exitCode = 1; }
    report.samples.push({ label, pid: app.pid, tree, screenshot: shot });
  } else await observe(app.pid, label);
  save();
}
async function openApp() {
  assert.ok(!app || app.exitCode !== null || app.signalCode !== null, 'owned previous app must exit before reopening');
  app = spawn(binary, [], { env, stdio: 'ignore', windowsHide: false });
  let error; app.once('error', value => { error = value; });
  await delay(5000); assert.ifError(error);
  assert.ok(app.pid && app.exitCode === null && app.signalCode === null, 'published window process stays alive');
}
async function closeApp() {
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  let quit;
  if (process.platform === 'darwin') quit = await run('/usr/bin/swift', [join(here, 'macos-driver.swift'), String(app.pid), 'quit']);
  else quit = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(here, 'lifecycle-windows.ps1'), '-Binary', binary, '-Action', 'quit', '-AppPid', String(app.pid)]);
  report.samples.push({ label: 'native-quit', pid: app.pid, result: quit }); save();
  const deadline = Date.now() + 15_000;
  while (app.exitCode === null && app.signalCode === null && Date.now() < deadline) await delay(250);
  if (app.exitCode === null && app.signalCode === null) {
    // Only the child this harness launched, never the service or another same-name process.
    const exited = new Promise(resolveExit => app.once('exit', resolveExit));
    app.kill();
    const stopped = await Promise.race([exited.then(() => true), delay(15_000).then(() => false)]);
    windowOutstanding = !stopped;
    throw new Error('Published native Quit did not exit. Owned test window stopped for cleanup, not counted as successful reopen.');
  }
}
try {
  assert.ok(!existsSync(appRoot), 'disposable runner must not already have Cotal installed');
  const previous = await download('0.164.6'), next = await download('0.164.7');
  installed = true;
  const initial = await install(previous);
  assert.equal(initial.code, 0, 'published N installer succeeds');
  assert.ok(existsSync(binary) && existsSync(node) && existsSync(cli), 'installed bundle is complete');
  // Do not import installed native modules into this harness: that would add a second file locker.
  const plan = await daemon('install', '--dry-run');
  assert.equal(plan.code, 0); assert.equal(plan.body.result.state, 'would-install');
  serviceAttempted = true;
  const installation = plan.body.result;
  report.installation = { ...installation, unitSourceSha256: existsSync(installation.unitPath ?? '') ? createHash('sha256').update(readFileSync(installation.unitPath)).digest('hex') : null };
  const start = await daemon('install'); assert.equal(start.code, 0);
  const before = await waitStatus('0.164.6');
  const beforeBirth = await kernelBirth(before.pid);
  report.before = { status: before, birth: beforeBirth };
  assert.ok(beforeBirth, 'daemon kernel lifetime is pinned');
  const beforeFiles = await observe(before.pid, 'service-before');
  if (process.platform === 'darwin') assert.ok(beforeFiles.bundledFiles.some(file => file === node), 'service has the installed bundled Node open');
  else assert.equal(resolve(beforeFiles.process.path).toLowerCase(), resolve(node).toLowerCase(), 'service uses installed Node');
  const oldInventory = inventory(); writeFileSync(join(output, 'files-before.json'), JSON.stringify(oldInventory));
  if (mode === 'window-open') { await openApp(); await window('window-before'); }
  let replacementFinished = false;
  const replacement = install(next, true).finally(() => { replacementFinished = true; });
  await delay(2000);
  if (!replacementFinished) {
    await window('window-during');
    if (mode === 'service-only' && process.platform === 'win32') await observe(before.pid, 'installer-during').catch(error => { report.installerDuringObservation = String(error); });
  }
  const replaced = await replacement;
  report.sameServiceLifetime = await kernelBirth(before.pid) === beforeBirth;
  report.afterReplacementStatus = await daemon('status');
  await observe(before.pid, 'service-after').catch(error => { report.serviceAfterObservation = String(error); });
  await window('window-after');
  const newInventory = inventory(); writeFileSync(join(output, 'files-after.json'), JSON.stringify(newInventory));
  const byName = new Map(newInventory.map(row => [row.file, row]));
  report.fileChanges = oldInventory.map(row => ({ file: row.file, before: row.sha256, after: byName.get(row.file)?.sha256,
    state: !byName.has(row.file) ? 'removed' : byName.get(row.file).sha256 !== row.sha256 ? 'replaced-content' : byName.get(row.file).ino !== row.ino ? 'replaced-same-content' : 'left' }));
  report.replacementCompleted = replaced.code === 0;
  report.installedVersion = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
  const settleDeadline = Date.now() + 30_000;
  while (Date.now() < settleDeadline) {
    const sample = await daemon('status');
    report.samples.push({ label: 'post-replacement-status', at: new Date().toISOString(), code: sample.code, result: sample.body?.result, error: sample.body?.error });
    if (sample.body?.result?.version === '0.164.7') break;
    await delay(5000);
  }
  await closeApp(); await openApp(); await window('window-reopened');
  report.afterReopenStatus = await daemon('status');
  report.sameServiceLifetimeAfterReopen = await kernelBirth(before.pid) === beforeBirth;
  report.recoveredByReopen = report.afterReopenStatus.code === 0 && report.afterReopenStatus.body?.result?.version === '0.164.7';
  report.requiredStockCommand = null;
  if (!report.recoveredByReopen && report.replacementCompleted && !installerUnknown) {
    report.stockRecoveryStart = await daemon('start');
    report.afterStockStart = await daemon('status');
    if (report.afterStockStart.body?.result?.version === '0.164.7') report.requiredStockCommand = 'cotal daemon start';
    else {
      report.stockRecoveryRemove = await daemon('uninstall', '--yes');
      assert.equal(report.stockRecoveryRemove.code, 0, 'stock removal authorizes recovery after recorded reopen failure');
      report.stockRecoveryInstall = await daemon('install');
      assert.equal(report.stockRecoveryInstall.code, 0);
      report.afterStockRecovery = await waitStatus('0.164.7');
      report.requiredStockCommand = 'cotal daemon uninstall --yes, then cotal daemon install';
    }
  } else if (!report.recoveredByReopen) report.requiredStockCommand = 'replacement refused or outcome unknown; no recovery mutation attempted';
  // Native package/loopback input is absent. Neither published app nor this harness signs in.
  report.noSignIn = true;
  report.outcome = report.windowObservationIncomplete ? 'incomplete-window-observation' : 'measured';
} catch (error) { report.outcome = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  report.cleanup = 'started'; save();
  try { await closeApp(); } catch (error) { report.windowCleanupError = String(error); process.exitCode = 1; }
  try {
    assert.ok(!installerUnknown && !windowOutstanding, 'unknown installer/window ownership retained for runner disposal, no cleanup races');
    if (serviceAttempted && existsSync(cli)) {
      const plan = await daemon('uninstall', '--dry-run'); assert.equal(plan.code, 0, 'stock removal must authorize its installation');
      const removed = await daemon('uninstall', '--yes'); assert.equal(removed.code, 0); assert.equal(removed.body.result.state, 'removed');
      const absent = await daemon('status'); assert.equal(absent.code, 2); assert.equal(absent.body?.error?.cause?.code, 'NOT_RUNNING');
      const nativeAbsent = await daemon('install', '--dry-run'); assert.equal(nativeAbsent.code, 0); assert.equal(nativeAbsent.body.result.state, 'would-install');
      report.cleanup = 'service-absence-verified';
    }
    if (existsSync(appRoot) && installed && (!serviceAttempted || report.cleanup === 'service-absence-verified')) {
      if (process.platform === 'darwin') {
        // A never-reused disposable runner, proven owned installation, no remaining service/window.
        const removal = await run('/bin/rm', ['-rf', appRoot]); assert.equal(removal.code, 0);
      } else {
        const uninstaller = readdirSync(appRoot).filter(name => /^uninstall.*\.exe$/i.test(name)); assert.equal(uninstaller.length, 1);
        const removal = await run(join(appRoot, uninstaller[0]), ['/S'], 120_000); assert.equal(removal.code, 0);
        const deadline = Date.now() + 30_000;
        while (existsSync(binary) && Date.now() < deadline) await delay(500);
        assert.ok(!existsSync(binary));
      }
      report.cleanup = 'service-and-app-removed';
    }
  } catch (error) { report.cleanup = 'failed-retained-for-runner-disposal'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1; }
  for (const mount of mounts.reverse()) {
    const result = await run('/usr/bin/hdiutil', ['detach', mount]);
    report.samples.push({ label: 'detach-owned-dmg', mount, result });
    if (result.code !== 0) { report.mountCleanup = 'failed'; process.exitCode = 1; }
  }
  report.completedAt = new Date().toISOString(); save();
}
