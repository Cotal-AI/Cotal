/** Measure a released app's deleted-bundle service on a disposable macOS runner. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REF, 'refs/heads/measure/mac-app-deleted-daemon');
const root = join(process.env.RUNNER_TEMP, 'mac-app-deleted-daemon');
const output = join(root, 'evidence');
mkdirSync(output, { recursive: true, mode: 0o700 });
const app = '/Applications/Cotal.app';
const cotalHome = join(homedir(), '.cotal');
const domain = `gui/${process.getuid()}`;
const target = `${domain}/ai.cotal.daemon`;
const report = { schema: 1, source: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), calls: [], snapshots: [], outcome: 'incomplete' };
const save = () => writeFileSync(join(output, 'result.json'), publicText(JSON.stringify(report, null, 2)));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'npm_config_before', 'NPM_CONFIG_BEFORE'].includes(key)));
Object.assign(env, { DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1', COTAL_HOME: cotalHome, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(homedir(), '.config'), XDG_CACHE_HOME: join(homedir(), '.cache') });
for (const dir of [root, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const project = join(root, 'project');
mkdirSync(project, { mode: 0o700 });
let sequence = 0;
function publicText(value) {
  return String(value).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted>')
    .replace(/(Bearer\s+)[^\s"\\]+/gi, '$1<redacted>')
    .replace(/("(?:token|accessToken|refreshToken|accessBearer|renewalProof|sentinelCreds|password)"\s*:\s*")[^"]*/gi, '$1<redacted>')
    .replace(/-----BEGIN[^\n]*(?:NKEY|CREDS|PRIVATE KEY|JWT|SEED)[\s\S]*?-----END[^\n]*-----/g, '<redacted credentials>')
    .replace(/\bS[UA][A-Z2-7]{56}\b/g, '<redacted seed>')
    .replace(/(https?:\/\/)[^/\s@]+@/g, '$1<redacted>@')
    .replace(/(https?:\/\/[^\s"#]+)#[^\s"]+/g, '$1#<redacted>')
    .replace(/update-participant-private-test-session/g, '<redacted>')
    .replace(/([?&](?:token|code|key|secret)=)[^&\s"]+/gi, '$1<redacted>');
}
async function call(label, file, args, { input, timeout = 180000, callEnv = env, cwd = project } = {}) {
  const row = { label, executable: file, argv: args, startedAt: new Date().toISOString(), timeoutMs: timeout };
  const result = await new Promise(resolveCall => {
    let stdout = '', stderr = '', timedOut = false, error;
    const child = spawn(file, args, { env: callEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    const force = setTimeout(() => child.kill('SIGKILL'), timeout + 10000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', value => { error = value.message; });
    child.on('close', (exit, signal) => { clearTimeout(timer); clearTimeout(force); resolveCall({ exit, signal, timedOut, stdout, stderr, ...(error ? { error } : {}) }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  Object.assign(row, result, { stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'), stderrSha256: createHash('sha256').update(result.stderr).digest('hex'), stdout: publicText(result.stdout), stderr: publicText(result.stderr), finishedAt: new Date().toISOString() });
  report.calls.push(row);
  writeFileSync(join(output, `${String(++sequence).padStart(3, '0')}.json`), publicText(JSON.stringify(row, null, 2)));
  save();
  console.log(`${label}: exit ${result.exit}, signal ${result.signal}, timeout ${result.timedOut}`);
  return row;
}
function ok(row) { assert.equal(row.timedOut, false, row.label); assert.equal(row.signal, null, row.label); assert.equal(row.exit, 0, `${row.label}: ${row.stderr}`); return row; }
function body(row) { return JSON.parse(ok(row).stdout).result; }
const npm = (label, args, options) => call(label, process.env.NPM_BIN, args, options);
async function installArchive(label, version, prefix, callEnv = env) {
  const metadata = JSON.parse(ok(await npm(`${label} archive metadata`, ['view', `cotal-ai@${version}`, 'dist', '--json'])).stdout);
  assert.match(metadata.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  const packed = JSON.parse(ok(await npm(`${label} verified download`, ['pack', `cotal-ai@${version}`, '--pack-destination', root, '--json'])).stdout);
  assert.equal(packed.length, 1);
  assert.match(packed[0].filename, /^cotal-ai-[0-9.]+\.tgz$/);
  const archive = join(root, packed[0].filename);
  assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, metadata.integrity);
  report[`${label}Archive`] = { version, ...metadata, archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
  ok(await npm(`${label} official CLI install`, ['install', '--global', '--prefix', prefix, archive], { callEnv, timeout: 600000 }));
}
const bundledNode = join(app, 'Contents/MacOS/cotal-node');
const bundledEntry = join(app, 'Contents/Resources/runtime/dist/cotal.js');
const bundled = (label, args, options) => call(label, bundledNode, [bundledEntry, ...args], options);
const oldPrefix = join(root, 'old-cli');
const freshPrefix = join(root, 'fresh-cli');
const oldEntry = join(oldPrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
const freshEntry = join(freshPrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
const old = (label, args) => call(label, process.execPath, [oldEntry, ...args]);
const fresh = (label, args) => call(label, process.execPath, [freshEntry, ...args]);
let closeParticipant;
let serviceOwnership;
let copiedApp;
async function deleteOwnedApp() {
  assert(copiedApp, 'no copied app identity');
  const current = statSync(app);
  assert.equal(current.dev, copiedApp.dev);
  assert.equal(current.ino, copiedApp.ino);
  ok(await call('verify copied bundle before removal', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]));
  const retired = join(root, 'retired-owned-app');
  assert(!existsSync(retired));
  renameSync(app, retired);
  const held = statSync(retired);
  assert.equal(held.dev, copiedApp.dev);
  assert.equal(held.ino, copiedApp.ino);
  rmSync(retired, { recursive: true });
}
let heldProcesses = [];
let mounted = false;
const mount = join(root, 'mounted');
const plist = join(homedir(), 'Library/LaunchAgents/ai.cotal.daemon.plist');
async function identity(pid, stage) {
  assert(Number.isSafeInteger(pid) && pid > 1);
  return { pid, process: await call(`${stage} process identity ${pid}`, '/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,comm=']), textFiles: await call(`${stage} executable files ${pid}`, '/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']) };
}
async function ownedService() {
  assert(serviceOwnership, 'no verified service ownership');
  const receipt = JSON.parse(readFileSync(serviceOwnership.receiptPath, 'utf8'));
  assert.equal(receipt.unit, 'ai.cotal.daemon');
  assert.equal(receipt.unitPath, plist);
  assert.equal(receipt.unitSha256, serviceOwnership.sha256);
  assert.equal(createHash('sha256').update(readFileSync(plist)).digest('hex'), serviceOwnership.sha256);
  assert.equal(createHash('sha256').update(readFileSync(serviceOwnership.receiptPath)).digest('hex'), serviceOwnership.receiptSha256);
}
async function nativeAction(label, args) { await ownedService(); return call(label, '/bin/launchctl', [...args, target]); }
async function snapshot(stage, daemonPid, managerPid) {
  const row = { stage, processScope: 'original pinned lifetimes, not a census of replacement processes', at: new Date().toISOString(), appExists: existsSync(app), programExists: existsSync(bundledNode), launchctl: await call(`${stage} launchctl print`, '/bin/launchctl', ['print', target]), daemon: await identity(daemonPid, stage), manager: await identity(managerPid, stage), status: await old(`${stage} cotal status`, ['status']), daemonStatus: await old(`${stage} daemon status`, ['daemon', 'status', '--json']), ps: await old(`${stage} cotal ps`, ['ps', '--space', report.participant.space, '--json']) };
  report.snapshots.push(row); save(); return row;
}
try {
  assert(!existsSync(app), 'refuse to replace an existing app');
  assert(!existsSync(cotalHome), 'fixture requires a fresh disposable account');
  assert(!existsSync(plist), 'refuse to replace a LaunchAgent');
  const absent = await call('preflight service absent', '/bin/launchctl', ['print', target]);
  assert.notEqual(absent.exit, 0, 'refuse to touch an existing loaded service');
  const metadata = await fetch('https://api.github.com/repos/Cotal-AI/Cotal/releases/tags/v0.164.16', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
  assert(metadata.ok, `release metadata HTTP ${metadata.status}`);
  const release = await metadata.json();
  const assets = release.assets.filter(asset => asset.name === 'Cotal_0.164.16_aarch64.dmg');
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  report.release = { tag: release.tag_name, assetId: asset.id, name: asset.name, digest: asset.digest, url: asset.browser_download_url };
  const dmg = join(root, asset.name);
  ok(await call('download released app', '/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--output', dmg, asset.browser_download_url]));
  assert.equal(createHash('sha256').update(readFileSync(dmg)).digest('hex'), asset.digest.slice(7));
  mkdirSync(mount, { mode: 0o700 });
  ok(await call('mount released app', '/usr/bin/hdiutil', ['attach', dmg, '-mountpoint', mount, '-nobrowse', '-readonly'])); mounted = true;
  ok(await call('install released app', '/usr/bin/ditto', [join(mount, 'Cotal.app'), app])); copiedApp = { dev: statSync(app).dev, ino: statSync(app).ino };
  ok(await call('detach released image', '/usr/bin/hdiutil', ['detach', mount])); mounted = false;
  ok(await call('verify released signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]));
  assert(existsSync(bundledNode) && existsSync(bundledEntry));
  report.bundledVersion = ok(await bundled('released bundled version', ['--version'])).stdout;
  assert.match(report.bundledVersion, /0\.164\.16/);
  const cutoff = { ...env, npm_config_before: '2026-11-16T19:38:00.000Z' };
  await installArchive('historical', '0.164.16', oldPrefix, cutoff);
  mkdirSync(cotalHome, { mode: 0o700 });
  const { prepareUpdateParticipant } = await import(pathToFileURL(resolve('implementations/auth/smoke/update-participant.fixture.ts')).href);
  closeParticipant = await prepareUpdateParticipant({ env, project, cotalHome, report });
  const install = await bundled('app shipped install operation', ['daemon', 'desktop'], { input: '{"op":"install"}\n' });
  const frames = ok(install).stdout.trim().split('\n').map(line => JSON.parse(line));
  assert(frames.some(frame => frame.event === 'result' && frame.ok && frame.result.installed));
  const source = readFileSync(plist, 'utf8');
  const receiptPath = join(cotalHome, 'daemon/service-unit.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.unit, 'ai.cotal.daemon');
  assert.equal(receipt.unitPath, plist);
  assert.equal(receipt.unitSha256, createHash('sha256').update(source).digest('hex'));
  serviceOwnership = { receiptPath, receiptSha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex'), sha256: receipt.unitSha256 };
  const installStatus = frames.find(frame => frame.event === 'result').result.status;
  heldProcesses.push(await identity(installStatus.pid, 'installed daemon'));
  assert(source.includes(bundledNode), 'service program must name the installed app runtime');
  report.service = { target, plist, sha256: createHash('sha256').update(source).digest('hex'), source };
  writeFileSync(join(output, 'service.plist'), source);
  const connector = join(root, 'connector');
  mkdirSync(connector, { mode: 0o700 });
  writeFileSync(join(connector, 'package.json'), JSON.stringify({ name: 'deleted-app-fixture', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
  writeFileSync(join(connector, 'index.js'), "import {registry} from '@cotal-ai/core';registry.register({kind:'connector',name:'deleted-app-fixture',requires:['node'],buildLaunch(){throw Error('this measurement launches no seats')}});\n");
  ok(await bundled('register local available connector', ['ext', 'add', connector]));
  const setup = body(await bundled('host real Manager through app runtime', ['daemon', 'setup', '--space', report.participant.space, '--json']));
  assert.equal(setup.manager.state, 'answering');
  heldProcesses.push(await identity(setup.manager.pid, 'installed Manager'));
  const before = body(await bundled('baseline daemon status', ['daemon', 'status', '--json']));
  const manager = before.managers.find(row => row.instanceId === setup.manager.instanceId);
  assert.equal(manager.state, 'answering');
  const baseline = await snapshot('before-delete', before.pid, manager.pid);
  for (const row of [baseline.daemon, baseline.manager]) ok(row.process);
  assert.equal(createHash('sha256').update(readFileSync(plist)).digest('hex'), report.service.sha256);
  await deleteOwnedApp();
  assert(!existsSync(app));
  await delay(3000);
  await snapshot('after-delete', before.pid, manager.pid);
  await old('old CLI plain self update after deletion', ['update', '--self']);
  await snapshot('after-old-update', before.pid, manager.pid);
  const latestVersion = JSON.parse(ok(await npm('resolve fresh exact version', ['view', 'cotal-ai@latest', 'version', '--json'])).stdout);
  assert.match(latestVersion, /^\d+\.\d+\.\d+$/);
  await installArchive('fresh', latestVersion, freshPrefix);
  await fresh('fresh CLI version', ['--version']);
  await fresh('fresh CLI daemon status before recovery', ['daemon', 'status', '--json']);
  await fresh('fresh CLI plain self update without app', ['update', '--self']);
  await nativeAction('restart missing-program service', ['kickstart', '-k']);
  await delay(15000);
  await snapshot('after-launchd-restart', before.pid, manager.pid);
  report.replacementCensus = await call('post-restart process census without arguments', '/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm=']);
  await nativeAction('owned bootout recovery', ['bootout']);
  await fresh('fresh CLI plain self update after bootout', ['update', '--self']);
  await fresh('fresh CLI daemon status after bootout', ['daemon', 'status', '--json']);
  report.outcome = 'measured';
} catch (error) {
  report.outcome = 'blocked'; report.error = publicText(error.stack ?? error); process.exitCode = 1;
} finally {
  if (serviceOwnership) {
    try {
      await nativeAction('cleanup exact service bootout', ['bootout']);
      report.cleanupService = await call('cleanup service absence', '/bin/launchctl', ['print', target]);
      if (report.cleanupService.exit === 0) process.exitCode = 1;
    } catch (error) { report.cleanupOwnershipError = publicText(error); process.exitCode = 1; }
  } else {
    try {
      const loaded = await call('unconfirmed install service observation', '/bin/launchctl', ['print', target]);
      report.cleanupUnknownService = existsSync(plist) || existsSync(join(cotalHome, 'daemon/service-unit.json')) || loaded.exit !== 113;
      if (report.cleanupUnknownService) process.exitCode = 1;
    } catch (error) { report.cleanupUnknownService = true; report.cleanupUnknownError = publicText(error); process.exitCode = 1; }
  }
  try {
    for (const held of heldProcesses) {
    const current = await call(`cleanup pinned process ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
    if (current.exit === 0 && current.stdout === held.process.stdout) {
      try { process.kill(held.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') { report.cleanupSignalError = publicText(error); process.exitCode = 1; } }
      for (let attempt = 0; attempt < 50; attempt++) {
        const remaining = await call(`cleanup process exit ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
        if (remaining.exit !== 0 || remaining.stdout !== held.process.stdout) break;
        await delay(200);
        if (attempt === 49) { report.cleanupOutstanding = held.pid; process.exitCode = 1; }
      }
    }
    }
  } catch (error) { report.cleanupProcessError = publicText(error); process.exitCode = 1; }
  try {
    report.cleanupProcessCensus = await call('final process census without arguments', '/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm=']);
    report.cleanupBundleProcessRows = report.cleanupProcessCensus.stdout.split('\n').filter(line => line.includes(`${app}/`));
    if (report.cleanupBundleProcessRows.length || report.cleanupProcessCensus.exit !== 0) { report.cleanupUnresolvedProcesses = true; process.exitCode = 1; }
  }
  catch (error) { report.cleanupCensusError = publicText(error); process.exitCode = 1; }
  try { await closeParticipant?.(); }
  catch (error) { report.cleanupParticipantError = publicText(error); process.exitCode = 1; }
  try { if (mounted) await call('cleanup image detach', '/usr/bin/hdiutil', ['detach', mount]); }
  finally {
    try {
      if (copiedApp && existsSync(app) && !report.cleanupUnknownService && !report.cleanupOwnershipError) await deleteOwnedApp();
    } catch (error) { report.cleanupAppError = publicText(error); process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); save();
    let secrets = false;
    for (const file of readdirSync(output)) {
      const text = readFileSync(join(output, file), 'utf8');
      if (/\bS[UA][A-Z2-7]{56}\b|eyJ[A-Za-z0-9_-]{8,}\.|-----BEGIN[^\n]*(?:JWT|SEED|PRIVATE KEY)|update-participant-private-test-session/.test(text)) secrets = true;
    }
    if (!secrets) writeFileSync(join(root, 'upload-safe'), 'Evidence secret scan passed.\n');
    else { report.artifactRefused = true; process.exitCode = 1; save(); }
  }
}
