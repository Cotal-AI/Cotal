/** Measure a released app's deleted-bundle service on a disposable macOS runner. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, realpathSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert(['refs/heads/main', 'refs/heads/measure/mac-app-deleted-daemon', 'refs/heads/fix/macos-deleted-app-service', 'refs/heads/fix/macos-missing-program-postcut', 'refs/heads/measure/macos-preserving-self-update'].includes(process.env.GITHUB_REF));
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
  const historicalBefore = preserving && version === '0.163.2' ? '2026-11-12T21:09:39.000Z' : undefined;
  if (historicalBefore) callEnv = { ...callEnv, npm_config_before: historicalBefore };
  const official = preserving ? ['--registry=https://registry.npmjs.org/'] : [];
  const metadata = JSON.parse(ok(await npm(`${label} archive metadata`, ['view', `cotal-ai@${version}`, 'dist', '--json', ...official])).stdout);
  assert.match(metadata.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  const packed = JSON.parse(ok(await npm(`${label} verified download`, ['pack', `cotal-ai@${version}`, '--pack-destination', root, '--json', ...official])).stdout);
  assert.equal(packed.length, 1);
  assert.match(packed[0].filename, /^cotal-ai-[0-9.]+\.tgz$/);
  const archive = join(root, packed[0].filename);
  assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, metadata.integrity);
  report[`${label}Archive`] = { version, ...metadata, archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
  ok(await npm(`${label} official CLI install`, ['install', '--global', '--prefix', prefix, archive, ...official], { callEnv, timeout: 600000 }));
  if (historicalBefore) {
    const runtime = join(prefix, 'lib/node_modules/cotal-ai');
    const nkeys = JSON.parse(readFileSync(join(runtime, 'node_modules/@nats-io/nkeys/package.json'), 'utf8'));
    assert.equal(nkeys.version, '2.0.3', 'historical runtime must retain the release-time nkeys dependency');
    report[`${label}Archive`].dependencyResolution = { before: historicalBefore, nkeys: nkeys.version, reason: 'Release-time dependency closure; current nkeys 2.1.0 exports reject this historical core deep import.' };
  }
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
let candidateEntry = process.env.DESKTOP_REPAIR_CLI;
const repairCommand = process.env.DESKTOP_REPAIR_COMMAND ?? 'status';
const preserving = repairCommand === 'preserving-self-update';
const selfUpdate = repairCommand === 'self-update' || preserving;
assert(['preserving-self-update', 'status', 'install', 'disabled', 'unreadable-source', 'self-update', 'unreadable-manager', 'occupied-manager', 'crash-prepared', 'crash-published', 'crash-prepared-mismatch', 'crash-prepared-concurrent', 'crash-prepared-changed-source'].includes(repairCommand), 'unsupported repair entry command');
if (!candidateEntry && !selfUpdate && !repairCommand.startsWith('crash-')) assert.equal(repairCommand, 'status', 'entry-command proof requires a candidate');
if (repairCommand.startsWith('crash-')) assert(process.env.DESKTOP_REPAIR_SOURCE_CLOSURE, 'crash proof requires a real guarded installed source closure');
if (selfUpdate) assert(process.env.DESKTOP_REPAIR_SOURCE_CLOSURE && process.env.DESKTOP_REPAIR_TARGET_CLOSURE, 'self-update proof requires two real guarded installed package closures');
report.repairCommand = repairCommand;
let candidateEnv = env;
const candidate = (label, args) => call(label, process.execPath, [candidateEntry, ...args], { callEnv: candidateEnv });
let candidateRegistry;
let mismatchedEntry;
let closeParticipant;
let serviceOwnership;
let copiedApp;
let disabledOverrideChanged = false;
let occupiedSeat;
let occupiedInstance;
const occupiedName = 'repair_occupied_worker';
async function readDisabled(label) {
  const read = ok(await call(label, '/bin/launchctl', ['print-disabled', domain]));
  const block = /^\s*disabled services = \{([\s\S]*)\}\s*$/.exec(read.stdout);
  assert(block, 'native disabled policy must be readable');
  const matches = block[1].split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const entry = /^"([^"\r\n]+)" => (true|false|disabled|enabled)$/.exec(line);
    assert(entry, 'native disabled policy must parse without guessing');
    return entry;
  }).filter(entry => entry[1] === 'ai.cotal.daemon');
  assert.equal(matches.length, 1, 'fixture-owned label must have one explicit disabled override');
  return ['true', 'disabled'].includes(matches[0][2]);
}
async function deleteOwnedApp() {
  assert(copiedApp, 'no copied app identity');
  const current = statSync(app);
  assert.equal(current.dev, copiedApp.dev);
  assert.equal(current.ino, copiedApp.ino);
  if (preserving) verifyAppShape();
  else ok(await call('verify copied bundle before removal', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]));
  const retired = `/Applications/.cotal-measure-retired-${process.env.GITHUB_RUN_ID}.app`;
  assert(!existsSync(retired));
  renameSync(app, retired);
  const held = statSync(retired);
  assert.equal(held.dev, copiedApp.dev);
  assert.equal(held.ino, copiedApp.ino);
  rmSync(retired, { recursive: true });
}
let appShapeFiles;
function verifyAppShape() {
  assert(appShapeFiles, 'app-shaped provenance must be recorded');
  for (const file of appShapeFiles) {
    assert(realpathSync(file.path).startsWith(`${app}/`), 'app-shaped files must remain inside their owned tree');
    const current = statSync(file.path);
    assert.equal(current.dev, file.dev);
    assert.equal(current.ino, file.ino);
    assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'), file.sha256);
  }
}
let heldProcesses = [];
let mounted = false;
const mount = join(root, 'mounted');
const plist = join(homedir(), 'Library/LaunchAgents/ai.cotal.daemon.plist');
const { processBirth } = await import(pathToFileURL(resolve('bin/dist/daemon/lifetime.js')).href);
async function identity(pid, stage) {
  assert(Number.isSafeInteger(pid) && pid > 1);
  const birth = processBirth(pid);
  const process = await call(`${stage} process identity ${pid}`, '/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,comm=']);
  const textFiles = await call(`${stage} executable files ${pid}`, '/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  assert.equal(processBirth(pid), birth, 'native lifetime changed during identity observation');
  return { pid, birth, process, textFiles };
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
  assert.equal(absent.exit, 113, 'service absence must be confirmed, not an unreadable GUI domain');
  if (preserving) {
    // v0.163.2 has no signed app asset. This is an attributed npm runtime, not a signed app.
    const prefix = join(root, 'app-runtime-download');
    await installArchive('app-shaped historical runtime', '0.163.2', prefix);
    mkdirSync(join(app, 'Contents/Resources'), { recursive: true, mode: 0o700 });
    mkdirSync(join(app, 'Contents/MacOS'), { mode: 0o700 });
    copiedApp = { dev: statSync(app).dev, ino: statSync(app).ino };
    renameSync(join(prefix, 'lib/node_modules/cotal-ai'), join(app, 'Contents/Resources/runtime'));
    copyFileSync(process.execPath, bundledNode);
    chmodSync(bundledNode, 0o700);
    const census = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      assert(realpathSync(path).startsWith(`${app}/`), `app-shaped runtime must not escape its owned tree: ${path}`);
      return entry.isDirectory() ? census(path) : [path];
    });
    appShapeFiles = census(app).map(path => {
      const { dev, ino } = statSync(path);
      return { path, dev, ino, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    });
    report.appShape = { provenance: 'Official integrity-verified npm cotal-ai@0.163.2 runtime and copied runner Node executable. No signed app claim.', nodeSource: process.execPath, files: appShapeFiles };
    verifyAppShape();
  } else {
  // Public release metadata was independently read before this measurement was dispatched.
  const asset = { id: 751469545, name: 'Cotal_0.164.16_aarch64.dmg', digest: 'sha256:ca71e976fb5dd067cbb6cf275099a58798cc5c21b1b0958536cb4bcdd8f1cc8b', browser_download_url: 'https://github.com/Cotal-AI/Cotal/releases/download/v0.164.16/Cotal_0.164.16_aarch64.dmg' };
  report.release = { tag: 'v0.164.16', assetId: asset.id, name: asset.name, digest: asset.digest, url: asset.browser_download_url };
  const dmg = join(root, asset.name);
  ok(await call('download released app', '/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--output', dmg, asset.browser_download_url]));
  assert.equal(createHash('sha256').update(readFileSync(dmg)).digest('hex'), asset.digest.slice(7));
  mkdirSync(mount, { mode: 0o700 });
  ok(await call('mount released app', '/usr/bin/hdiutil', ['attach', dmg, '-mountpoint', mount, '-nobrowse', '-readonly'])); mounted = true;
  ok(await call('install released app', '/usr/bin/ditto', [join(mount, 'Cotal.app'), app])); copiedApp = { dev: statSync(app).dev, ino: statSync(app).ino };
  ok(await call('detach released image', '/usr/bin/hdiutil', ['detach', mount])); mounted = false;
  ok(await call('verify released signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]));
  }
  assert(existsSync(bundledNode) && existsSync(bundledEntry));
  report.bundledVersion = ok(await bundled('released bundled version', ['--version'])).stdout;
  assert.match(report.bundledVersion, preserving ? /0\.163\.2/ : /0\.164\.16/);
  const cutoff = { ...env, npm_config_before: '2026-11-16T19:38:00.000Z' };
  await installArchive('historical', preserving ? '0.163.2' : '0.164.16', oldPrefix, preserving ? env : cutoff);
  if (preserving) await installArchive('published floor', '0.167.0', freshPrefix);
  if (selfUpdate) {
    const { candidatePairRegistry } = await import(pathToFileURL(resolve('scripts/candidate-pair-registry.mjs')).href);
    candidateRegistry = await candidatePairRegistry(resolve(process.env.DESKTOP_REPAIR_SOURCE_CLOSURE), resolve(process.env.DESKTOP_REPAIR_TARGET_CLOSURE));
    assert.equal(candidateRegistry.identity.source, process.env.GITHUB_SHA, 'both guarded closures must bind to this exact product source');
    report.selfUpdatePair = candidateRegistry.identity;
    candidateEnv = { ...env, npm_config_registry: candidateRegistry.url };
    const installedPrefix = join(root, 'candidate-install');
    candidateEnv = { ...candidateEnv, npm_config_prefix: installedPrefix };
    ok(await npm('install real candidate A before app deletion', ['install', '--global', '--prefix', installedPrefix, `cotal-ai@${candidateRegistry.identity.sourceVersion}`, '--no-audit', '--no-fund'], { callEnv: candidateEnv, timeout: 600000 }));
    candidateEntry = join(installedPrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
    assert.equal(JSON.parse(readFileSync(join(installedPrefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version, candidateRegistry.identity.sourceVersion);
  }
  if (repairCommand.startsWith('crash-')) {
    const { candidateRegistry: openCandidateRegistry } = await import(pathToFileURL(resolve('scripts/automatic-update-platform-baseline.mjs')).href);
    candidateRegistry = await openCandidateRegistry(resolve(process.env.DESKTOP_REPAIR_SOURCE_CLOSURE), 'A', 'https://registry.npmjs.org/');
    assert.equal(candidateRegistry.identity.source, process.env.GITHUB_SHA, 'guarded crash closure must bind this exact source');
    report.installedCrashCandidate = candidateRegistry.identity;
    const installedPrefix = join(root, 'candidate-install');
    candidateEnv = { ...env, npm_config_registry: candidateRegistry.url, npm_config_prefix: installedPrefix };
    ok(await npm('install real guarded candidate before crash measurement', ['install', '--global', '--prefix', installedPrefix, `cotal-ai@${candidateRegistry.identity.version}`, '--no-audit', '--no-fund'], { callEnv: candidateEnv, timeout: 600000 }));
    candidateEntry = join(installedPrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
    assert.equal(JSON.parse(readFileSync(join(installedPrefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version, candidateRegistry.identity.version);
    if (repairCommand === 'crash-prepared-mismatch') {
      const differentPrefix = join(root, 'different-candidate-install');
      ok(await npm('install same guarded closure at distinct repair destination', ['install', '--global', '--prefix', differentPrefix, `cotal-ai@${candidateRegistry.identity.version}`, '--no-audit', '--no-fund'], { callEnv: { ...candidateEnv, npm_config_prefix: differentPrefix }, timeout: 600000 }));
      mismatchedEntry = join(differentPrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
      assert.notEqual(mismatchedEntry, candidateEntry);
      assert.equal(JSON.parse(readFileSync(join(differentPrefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version, candidateRegistry.identity.version);
      assert.equal(createHash('sha256').update(readFileSync(mismatchedEntry)).digest('hex'), createHash('sha256').update(readFileSync(candidateEntry)).digest('hex'), 'only installed destination differs, not entry bytes or version');
    }
  }
  mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
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
  if (['occupied-manager', 'unreadable-manager'].includes(repairCommand)) {
    const core = pathToFileURL(join(oldPrefix, 'lib/node_modules/cotal-ai/node_modules/@cotal-ai/core/dist/index.js')).href;
    const seat = join(connector, 'seat.mjs');
    const seatReceipt = join(connector, 'seat-process.json');
    writeFileSync(seat, `import{CotalEndpoint}from${JSON.stringify(core)};import{readFileSync,writeFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env;const cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(error,stdout)=>error?reject(error):resolve(stdout.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();writeFileSync(${JSON.stringify(seatReceipt)},JSON.stringify({pid:process.pid,lifecycleUid:e.COTAL_LIFECYCLE_UID,name:e.COTAL_NAME}),{mode:0o600});setInterval(()=>{},1000);for(const s of['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`);
    writeFileSync(join(connector, 'index.js'), `import{registry}from'@cotal-ai/core';registry.register({kind:'connector',name:'deleted-app-fixture',requires:['node'],buildLaunch:o=>{if(!o.userAuth)throw Error('occupied proof requires actual user-auth launch');return{command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}}}});`);
  } else {
    writeFileSync(join(connector, 'index.js'), "import {registry} from '@cotal-ai/core';registry.register({kind:'connector',name:'deleted-app-fixture',requires:['node'],buildLaunch(){throw Error('this measurement launches no seats')}});\n");
  }
  ok(await bundled('register local available connector', ['ext', 'add', connector]));
  const setup = body(await bundled('host real Manager through app runtime', ['daemon', 'setup', '--space', report.participant.space, '--json']));
  assert.equal(setup.manager.state, 'answering');
  heldProcesses.push(await identity(setup.manager.pid, 'installed Manager'));
  if (repairCommand === 'occupied-manager') {
    occupiedInstance = setup.manager.instanceId;
    ok(await bundled('spawn real owned occupied proof seat', ['spawn', '--agent', 'deleted-app-fixture', '--on', occupiedInstance, '--name', occupiedName, '--detach', '--no-events', '--space', report.participant.space]));
    const receiptFile = join(connector, 'seat-process.json');
    const until = Date.now() + 20000;
    while (!existsSync(receiptFile) && Date.now() < until) await delay(100);
    const launched = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(launched.name, occupiedName);
    assert(typeof launched.lifecycleUid === 'string' && launched.lifecycleUid.length > 0);
    occupiedSeat = { ...await identity(launched.pid, 'owned occupied proof seat'), lifecycleUid: launched.lifecycleUid };
    assert(occupiedSeat.birth);
    report.occupiedSeatBefore = { pid: occupiedSeat.pid, birth: occupiedSeat.birth, lifecycleUid: occupiedSeat.lifecycleUid, instanceId: occupiedInstance };
  }
  const before = body(await bundled('baseline daemon status', ['daemon', 'status', '--json']));
  const manager = before.managers.find(row => row.instanceId === setup.manager.instanceId);
  assert.equal(manager.state, 'answering');
  let preservingProbe;
  const assertPreserving = async label => {
    const row = ok(await call(label, process.execPath, [preservingProbe]));
    const observed = JSON.parse(row.stdout);
    assert.equal(observed.daemon.version, '0.163.2');
    assert.equal(observed.daemon.pid, before.pid);
    const evidence = observed.daemon.update?.restartEvidence;
    assert.equal(evidence?.prepared, true);
    assert.equal(evidence.managers.length, 1);
    assert(evidence.managers.every(row => row.space === report.participant.space && row.seats === 0 && row.fenced === true));
    assert.equal(observed.manager.ok, false);
    assert.match(observed.manager.error ?? '', /manager is in preserving mode/);
    for (const held of heldProcesses) assert.equal(processBirth(held.pid), held.birth);
    return observed;
  };
  if (preserving) {
    const runtime = join(oldPrefix, 'lib/node_modules/cotal-ai');
    const moduleUrl = path => JSON.stringify(pathToFileURL(join(runtime, path)).href);
    const prepare = join(root, 'old-prepare-restart.mjs');
    writeFileSync(prepare, `import{managerViaDaemon}from${moduleUrl('dist/daemon/client.js')};import{daemonPaths}from${moduleUrl('dist/daemon/endpoint.js')};import{processBirth}from${moduleUrl('dist/daemon/lifetime.js')};console.log(JSON.stringify({pid:process.pid,birth:processBirth(process.pid),result:await managerViaDaemon({paths:daemonPaths()},{op:'managers-prepare-restart'})}));`);
    const prepared = JSON.parse(ok(await call('old authenticated short-lived restart preparer', process.execPath, [prepare])).stdout);
    assert(Number.isSafeInteger(prepared.pid) && prepared.pid > 1);
    assert.equal(processBirth(prepared.pid), undefined, 'preparer must exit before repair, not own a live update');
    assert(prepared.birth, 'old preparer must report its own native birth');
    report.preparer = { pid: prepared.pid, birth: prepared.birth, exited: true, exit: 0, result: prepared.result };
    preservingProbe = join(root, 'old-public-preserving-probe.mjs');
    writeFileSync(preservingProbe, `import{queryDaemon}from${moduleUrl('dist/daemon/client.js')};import{daemonPaths}from${moduleUrl('dist/daemon/endpoint.js')};import{resolveControlTarget}from${moduleUrl('node_modules/@cotal-ai/workspace/dist/index.js')};import{askManager}from${moduleUrl('node_modules/@cotal-ai/workspace/dist/control/index.js')};import{withIdpSessionDir}from${moduleUrl('node_modules/@cotal-ai/auth/dist/index.js')};const d=await queryDaemon({paths:daemonPaths()});if(!d.ok)throw Error(JSON.stringify(d));const m=await withIdpSessionDir(${JSON.stringify(cotalHome)},async()=>{const t=await resolveControlTarget({space:${JSON.stringify(report.participant.space)}},'control-caller-privileged',${JSON.stringify(manager.instanceId)},{onRefusal:'throw',readOnly:true});const r=await askManager({versionSkew:t=>t,roster:async()=>[]},${JSON.stringify(report.participant.space)},t.server,'managerStatus',undefined,t.auth,'owner',5000,{instanceId:${JSON.stringify(manager.instanceId)}});return r});console.log(JSON.stringify({daemon:d.result,manager:m}));`);
    report.preservingBeforeDelete = await assertPreserving('old public preserving state before deletion');
  }
  const baseline = await snapshot('before-delete', before.pid, manager.pid);
  for (const row of [baseline.daemon, baseline.manager]) ok(row.process);
  assert.equal(createHash('sha256').update(readFileSync(plist)).digest('hex'), report.service.sha256);
  await deleteOwnedApp();
  assert(!existsSync(app));
  await delay(3000);
  await snapshot('after-delete', before.pid, manager.pid);
  if (candidateEntry) {
    assert(existsSync(candidateEntry), 'source-built deployed candidate entry exists');
    report.candidate = { entry: candidateEntry, version: ok(await candidate('candidate version before repair', ['--version'])).stdout,
      entrySha256: createHash('sha256').update(readFileSync(candidateEntry)).digest('hex') };
    const sessionPath = join(cotalHome, 'idp-sessions.json');
    const stateBefore = readFileSync(sessionPath, 'utf8');
    if (preserving) {
      report.preservingAfterDelete = await assertPreserving('old public preserving state after original paths removed');
      assert(!existsSync(bundledNode) && !existsSync(bundledEntry));
      const { spaceSegment } = await import(pathToFileURL(resolve('packages/workspace/dist/index.js')).href);
      const hostingPath = join(cotalHome, 'daemon', spaceSegment(report.participant.space), 'manager-host.json');
      const protectedFiles = [plist, receiptPath, sessionPath, hostingPath, oldEntry, freshEntry];
      const protectedBytes = protectedFiles.map(file => readFileSync(file));
      const nativeBefore = ok(await call('published floor native before', '/bin/launchctl', ['print', target])).stdout;
      candidateRegistry.activateTarget();
      const refused = await call('published 0.167.0 plain update --self floor refusal', process.execPath, [freshEntry, 'update', '--self'], { callEnv: { ...candidateEnv, npm_config_prefix: freshPrefix } });
      assert(!refused.timedOut && !refused.signal, 'a timeout is not a floor refusal');
      assert.notEqual(refused.exit, 0);
      assert.match(refused.stdout + refused.stderr, /staged pre.?install check refused/i);
      assert.match(refused.stdout + refused.stderr, /manager is in preserving mode; hold age .+; seats 0; update owner /);
      assert.match(refused.stdout + refused.stderr, /No hold was released by this check/);
      assert.match(refused.stdout + refused.stderr, /no installed packages or connector state were changed/i);
      for (const [index, file] of protectedFiles.entries()) assert.deepEqual(readFileSync(file), protectedBytes[index], `published floor changed ${file}`);
      const nativeAfter = ok(await call('published floor native after', '/bin/launchctl', ['print', target])).stdout;
      assert.equal(/^\s*pid = (\d+)\s*$/m.exec(nativeAfter)?.[1], /^\s*pid = (\d+)\s*$/m.exec(nativeBefore)?.[1]);
      report.publishedFloorRefusal = { version: '0.167.0', exit: refused.exit, unchanged: true, floor: 'installed staged preinstall preserving refusal', target: candidateRegistry.identity.targetVersion };
      report.preservingImmediatelyBeforeCandidate = await assertPreserving('old public preserving immediately before candidate update');
    }
    if (repairCommand.startsWith('crash-')) {
      await ownedService();
      const { interruptRepairAtPhase } = await import('./mac-repair-interruption.mjs');
      const { readServiceRepair, assertServiceRepairPair, sourceDigest } = await import(pathToFileURL(resolve('bin/dist/daemon/service-repair.js')).href);
      const coreLockInspector = repairCommand === 'crash-prepared-concurrent' ? await import(pathToFileURL(resolve('packages/core/dist/advisory-lock.js')).href) : undefined;
      const { spaceSegment } = await import(pathToFileURL(resolve('packages/workspace/dist/index.js')).href);
      const hostingPath = join(cotalHome, 'daemon', spaceSegment(report.participant.space), 'manager-host.json');
      const hostingBefore = readFileSync(hostingPath, 'utf8');
      const phase = repairCommand.split('-')[1];
      const version = report.candidate.version.split(/\r?\n/, 1)[0].replace('cotal-ai ', '');
      let verifiedNextSource;
      report.interruptionEvents = [];
      assert.equal(version, report.installedCrashCandidate.version);
      assert(!readServiceRepair(join(cotalHome, 'daemon')), 'no preexisting repair intent can count as this child capture');
      const interrupted = await interruptRepairAtPhase({
        file: process.execPath, args: [candidateEntry, 'daemon', 'install', '--json'], cwd: project, env: candidateEnv,
        phase, birth: processBirth,
        inspect() {
          const intent = readServiceRepair(join(cotalHome, 'daemon'));
          if (!intent) return undefined;
          const actualReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
          const actualSource = readFileSync(plist, 'utf8');
          assertServiceRepairPair(intent, actualReceipt, actualSource);
          assert.deepEqual(intent.receipt, receipt, 'real intent must bind original owned receipt');
          assert.equal(intent.previousSource, source);
          assert.equal(intent.version, version);
          assert.equal(intent.enabled, true);
          assert(!intent.nextSource.includes(`${app}/`));
          assert(intent.nextSource.includes(candidateEntry.replace(/cotal\.js$/, 'daemon-cwd.js')));
          assert.deepEqual(intent.argv, [process.execPath, '--max-semi-space-size=1', candidateEntry, 'daemon', 'serve'], 'real repair destination must match this direct installed CLI invocation');
          if (intent.nextSource !== verifiedNextSource) {
            const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: intent.nextSource, env, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
            assert(!converted.error && !converted.signal && converted.status === 0, 'real next source must parse as a native plist');
            const parsed = JSON.parse(converted.stdout);
            assert.equal(parsed.Program, undefined, 'no separate Program may override the expected executable');
            assert.equal(parsed.Label, receipt.unit);
            assert.deepEqual(parsed.ProgramArguments, [process.execPath, '--max-semi-space-size=1', candidateEntry.replace(/cotal\.js$/, 'daemon-cwd.js'), homedir(), 'daemon', 'serve']);
            verifiedNextSource = intent.nextSource;
          }
          assert(intent.hostedSpaces.includes(report.participant.space));
          if (intent.phase === 'published') {
            assert.equal(actualSource, intent.nextSource);
            assert.equal(actualReceipt.unitSha256, sourceDigest(intent.nextSource));
          }
          return { phase: intent.phase, sourceSha256: sourceDigest(actualSource), receiptSha256: sourceDigest(readFileSync(receiptPath, 'utf8')), sourceState: actualSource === source ? 'previous' : 'next', receiptState: actualReceipt.unitSha256 === receipt.unitSha256 ? 'previous' : 'next', destination: intent.argv, version: intent.version };
        },
        confirmStopped(pid, birth) {
          assert.equal(processBirth(pid), birth, 'public repair child changed before native stop observation');
          const stopped = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { env, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
          assert(!stopped.error && !stopped.signal && stopped.status === 0 && /^T/.test(stopped.stdout.trim()), 'setup miss: public repair child did not confirm suspended state');
          assert.equal(processBirth(pid), birth, 'public repair child changed during native stop observation');
        },
        observeNative() {
          const job = spawnSync('/bin/launchctl', ['print', target], { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
          assert(!job.error && !job.signal && [0, 113].includes(job.status), 'suspended native job must be readable or confirmed absent');
          return { exit: job.status, signal: job.signal, stdout: publicText(job.stdout), stderr: publicText(job.stderr) };
        },
        whileSuspended: repairCommand !== 'crash-prepared-concurrent' ? undefined : ({ pid, birth }) => {
          const lockPath = join(cotalHome, 'daemon/service-repair.lock');
          const held = coreLockInspector.inspectLock(lockPath);
          assert.equal(held.state, 'active');
          assert.equal(held.owner.pid, pid, 'the actual suspended public repair must own the operation lock');
          assert.equal(processBirth(pid), birth);
          const files = [join(cotalHome, 'daemon/service-repair.json'), receiptPath, plist, sessionPath, hostingPath, lockPath];
          const bytes = files.map(file => readFileSync(file));
          const competing = spawnSync(process.execPath, [candidateEntry, 'daemon', 'uninstall', '--yes', '--json'], { cwd: project, env: candidateEnv, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
          report.concurrentRepairAttempt = { exit: competing.status, signal: competing.signal, error: competing.error?.message, stdout: publicText(competing.stdout), stderr: publicText(competing.stderr), repairPid: pid, repairBirth: birth, ownerBefore: held, beforeHashes: bytes.map(value => createHash('sha256').update(value).digest('hex')) };
          save();
          const ownerAfter = coreLockInspector.inspectLock(lockPath);
          const birthAfter = processBirth(pid);
          Object.assign(report.concurrentRepairAttempt, { ownerAfter, birthAfter });
          save();
          const bytesAfter = files.map(file => readFileSync(file));
          report.concurrentRepairAttempt.afterHashes = bytesAfter.map(value => createHash('sha256').update(value).digest('hex'));
          save();
          assert(!competing.error && !competing.signal, 'timeout or killed competing CLI is not a product refusal');
          assert.equal(competing.status, 2);
          const refused = JSON.parse(competing.stdout);
          assert.equal(refused.error?.code, 'CONFLICT');
          assert.match(refused.error?.message ?? '', /unfinished repair/);
          assert.equal(birthAfter, birth, 'competing public uninstall must retain the first repair child');
          assert.deepEqual(ownerAfter, held, 'competing public operation must not replace the real lock owner');
          for (const [index, file] of files.entries()) assert.deepEqual(bytesAfter[index], bytes[index], `competing operation changed ${file}`);
          report.concurrentRepairAttempt.protectedBytesAndOwnerUnchanged = true;
          save();
        },
        record(event) { report.interruptionEvents.push(event); if (event.event === 'cleanup-unconfirmed') report.interruptionCleanupUnconfirmed = true; save(); },
      });
      assert.equal(interrupted.signal, 'SIGKILL');
      assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
      assert.equal(readFileSync(hostingPath, 'utf8'), hostingBefore);
      report.interruptedRepair = { phase, captured: interrupted.captured, retryComplete: false, hostingPath, hostingSha256: sourceDigest(hostingBefore) };
      save();
      if (repairCommand === 'crash-prepared-changed-source') {
        const { withChangedRepairSource } = await import('./mac-repair-source-fault.mjs');
        const intentPath = join(cotalHome, 'daemon/service-repair.json');
        const protectedFiles = [intentPath, receiptPath, sessionPath, hostingPath];
        const protectedBefore = protectedFiles.map(file => readFileSync(file));
        const savedSource = readFileSync(plist, 'utf8');
        const realIntent = readServiceRepair(join(cotalHome, 'daemon'));
        assertServiceRepairPair(realIntent, JSON.parse(protectedBefore[1]), savedSource);
        assert.equal(sourceDigest(savedSource), interrupted.captured.sourceSha256);
        assert.equal(sourceDigest(protectedBefore[1].toString('utf8')), interrupted.captured.receiptSha256);
        const absent = await call('changed-source fault requires native job absent after actual interruption', '/bin/launchctl', ['print', target], { timeout: 5000 });
        assert(!absent.timedOut && !absent.signal && absent.exit === 113, 'setup miss: no source fault while any job remains loaded');
        for (const held of heldProcesses) assert.equal(processBirth(held.pid), undefined, 'setup miss: original daemon or Manager still exists before source fault');
        report.interruptedRepair.sourceFaultEvents = [];
        await withChangedRepairSource({
          file: plist, expected: savedSource,
          verifyAuthority() {
            for (const [index, file] of protectedFiles.entries()) assert.deepEqual(readFileSync(file), protectedBefore[index], 'protected authority changed; no source restoration is allowed');
            const unloaded = spawnSync('/bin/launchctl', ['print', target], { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
            assert(!unloaded.error && !unloaded.signal && unloaded.status === 113, 'no source fault or restoration while native job absence is unconfirmed');
            for (const held of heldProcesses) assert.equal(processBirth(held.pid), undefined, 'no source fault or restoration while original process remains live');
          },
          record(event) {
            report.interruptedRepair.sourceFaultEvents.push(event);
            if (event.event === 'fixture-source-restore-unconfirmed') report.interruptionCleanupUnconfirmed = true;
            save();
          },
          async run(fault) {
            const rejected = await candidate('public repair rejects actual fixture-changed source', ['daemon', 'install', '--json']);
            report.interruptedRepair.changedSourceAttempt = { exit: rejected.exit, protectedBytesUnchanged: false, sourceUnchanged: false, nativeAbsent: false };
            save();
            const nativeAfter = await call('changed-source refusal native absence', '/bin/launchctl', ['print', target], { timeout: 5000 });
            assert(!nativeAfter.timedOut && !nativeAfter.signal && nativeAfter.exit === 113);
            report.interruptedRepair.changedSourceAttempt.nativeAbsent = true;
            assert.equal(readFileSync(plist, 'utf8'), fault, 'rejected repair must not adopt or rewrite the changed source');
            report.interruptedRepair.changedSourceAttempt.sourceUnchanged = true;
            for (const [index, file] of protectedFiles.entries()) assert.deepEqual(readFileSync(file), protectedBefore[index]);
            report.interruptedRepair.changedSourceAttempt.protectedBytesUnchanged = true;
            save();
            assert(!rejected.timedOut && !rejected.signal);
            assert.equal(rejected.exit, 3);
            const failure = JSON.parse(rejected.stdout);
            assert.equal(failure.error?.code, 'OPERATION_UNKNOWN');
            assert.match(failure.error?.message ?? '', /daemon service source changed outside repair/);
          },
        });
        assert.equal(readFileSync(plist, 'utf8'), savedSource);
        report.interruptedRepair.changedSourceRestoredForRetry = true;
        save();
      }
      if (repairCommand === 'crash-prepared-mismatch') {
        assert(mismatchedEntry, 'different destination must be installed before the repair begins');
        const intentPath = join(cotalHome, 'daemon/service-repair.json');
        const beforeMismatch = [intentPath, receiptPath, plist, sessionPath, hostingPath].map(file => readFileSync(file));
        const observedNative = async label => {
          const job = await call(label, '/bin/launchctl', ['print', target], { timeout: 5000 });
          assert(!job.timedOut && !job.signal && [0, 113].includes(job.exit));
          const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(job.stdout)?.[1]) || null;
          const program = /^\s*program = (.+)$/m.exec(job.stdout)?.[1] ?? null;
          if (job.exit === 0) assert(program, 'loaded job executable must be observed, not guessed');
          return { exit: job.exit, pid, birth: pid ? processBirth(pid) : null, program };
        };
        const nativeBefore = await observedNative('interrupted native state before distinct destination refusal');
        const observeOriginals = () => heldProcesses.map(row => {
          const birth = processBirth(row.pid) ?? null;
          return { pid: row.pid, expectedBirth: row.birth, observedBirth: birth, state: birth === null ? 'absent' : birth === row.birth ? 'original' : 'different' };
        });
        const originalBirths = observeOriginals();
        assert(!originalBirths.some(row => row.state === 'different'), 'retained PID names a different lifetime before mismatch request');
        const refused = await call('different installed destination cannot resume real interrupted repair', process.execPath, [mismatchedEntry, 'daemon', 'install', '--json'], { callEnv: candidateEnv });
        const originalsAfter = observeOriginals();
        report.interruptedRepair.destinationAttempt = { exit: refused.exit, originalBirths, originalsAfter };
        save();
        const nativeAfter = await observedNative('interrupted native state after distinct destination refusal');
        Object.assign(report.interruptedRepair.destinationAttempt, { nativeBefore, nativeAfter });
        save();
        const bytesAfter = [intentPath, receiptPath, plist, sessionPath, hostingPath].map(file => readFileSync(file));
        Object.assign(report.interruptedRepair.destinationAttempt, { beforeHashes: beforeMismatch.map(bytes => createHash('sha256').update(bytes).digest('hex')), afterHashes: bytesAfter.map(bytes => createHash('sha256').update(bytes).digest('hex')) });
        save();
        assert(!refused.timedOut && !refused.signal);
        assert.equal(refused.exit, 3, 'current generic repair throw maps to the public unknown outcome');
        const rejection = JSON.parse(refused.stdout);
        assert.equal(rejection.error?.code, 'OPERATION_UNKNOWN');
        assert.match(rejection.error?.message ?? '', /repair must finish from its recorded Cotal installation/);
        for (const [index, file] of [intentPath, receiptPath, plist, sessionPath, hostingPath].entries()) assert.deepEqual(bytesAfter[index], beforeMismatch[index], `distinct destination changed ${file}`);
        assert.deepEqual(nativeAfter, nativeBefore);
        assert.deepEqual(originalsAfter, originalBirths);
        report.interruptedRepair.destinationRefusal = { entry: mismatchedEntry, exit: refused.exit, protectedBytesUnchanged: true, nativeBoundaryObservationsUnchanged: true, originalLifetimeBoundaryStatesUnchanged: true, sameCandidateRetryPending: true };
        save();
      }
    }
    if (selfUpdate) {
      candidateRegistry.activateTarget();
      const update = ok(await candidate('installed candidate update --self repairs missing program first', ['update', '--self']));
      const updateReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const updateSource = readFileSync(plist, 'utf8');
      assert.equal(updateReceipt.unitSha256, createHash('sha256').update(updateSource).digest('hex'));
      assert(!updateSource.includes(`${app}/`), 'public self-update must repair before any candidate daemon status');
      assert(updateSource.includes(candidateEntry.replace(/cotal\.js$/, 'daemon-cwd.js')));
      assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
      serviceOwnership = { receiptPath, receiptSha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex'), sha256: updateReceipt.unitSha256 };
      const job = ok(await nativeAction('self-update repaired native job before status', ['print']));
      const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(job.stdout)?.[1]);
      assert(Number.isSafeInteger(pid) && pid > 1 && pid !== before.pid);
      heldProcesses.push(await identity(pid, 'self-update repaired daemon'));
      const version = ok(await candidate('installed candidate version after self update', ['--version'])).stdout.split(/\r?\n/, 1)[0];
      assert.equal(version, `cotal-ai ${candidateRegistry.identity.targetVersion}`);
      if (preserving) {
        for (const held of heldProcesses.slice(0, 2)) {
          const gone = await call(`preserving self-update retired original lifetime ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
          assert(!gone.timedOut && !gone.signal);
          assert.equal(gone.exit, 1, 'plain self-update must retire originals before fixture cleanup');
          assert.equal(processBirth(held.pid), undefined);
        }
        report.preservingOriginalsRetiredBeforeCleanup = true;
      }
      report.selfUpdateRepairAcceptance = { exit: update.exit, pid, sourceOutsideAppBeforeStatus: true, credentialsPreserved: true, installedTarget: candidateRegistry.identity.targetVersion };
    }
    if (repairCommand === 'occupied-manager') {
      await ownedService();
      assert(occupiedSeat?.birth && occupiedInstance === manager.instanceId);
      const sourceBefore = readFileSync(plist, 'utf8');
      const receiptBefore = readFileSync(receiptPath, 'utf8');
      const seatBefore = body(await old('public original-instance occupied seat before repair', ['ps', '--on', occupiedInstance, '--space', report.participant.space, '--json']));
      assert(seatBefore.items?.some(row => row.name === occupiedName && row.lifecycleUid === occupiedSeat.lifecycleUid), 'public inventory must bind the live owned seat lifecycle');
      const refused = await candidate('occupied real Manager refuses install repair', ['daemon', 'install', '--json']);
      assert.equal(refused.timedOut, false);
      assert.equal(refused.signal, null);
      assert.notEqual(refused.exit, 0);
      assert.match(JSON.parse(refused.stdout).error?.message ?? '', /active seat|repair preparation/i);
      assert.equal(readFileSync(plist, 'utf8'), sourceBefore);
      assert.equal(readFileSync(receiptPath, 'utf8'), receiptBefore);
      assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
      assert(!existsSync(join(cotalHome, 'daemon/service-repair.json')));
      assert.equal(processBirth(occupiedSeat.pid), occupiedSeat.birth, 'refused repair must not stop the live agent');
      const seatAfter = body(await old('public original-instance occupied seat after repair', ['ps', '--on', occupiedInstance, '--space', report.participant.space, '--json']));
      assert(seatAfter.items?.some(row => row.name === occupiedName && row.lifecycleUid === occupiedSeat.lifecycleUid));
      assert(seatAfter.managers?.some(row => row.instanceId === occupiedInstance && row.state === 'answered'));
      await ownedService();
      report.occupiedManagerAcceptance = { repairRefused: true, sourceAndReceiptUnchanged: true, credentialsPreserved: true, sameSeatBirthAndLifecycle: true, originalInstanceAnswered: true, newLifecycleWorkMeasured: false };
    }
    if (repairCommand === 'unreadable-manager') {
      await ownedService();
      const sourceBefore = readFileSync(plist, 'utf8');
      const receiptBefore = readFileSync(receiptPath, 'utf8');
      const managerBefore = heldProcesses.find(row => row.pid === manager.pid);
      assert(managerBefore?.birth, 'only the fixture-retained Manager with a native birth token can be suspended');
      const current = await identity(manager.pid, 'unreadable Manager before suspension');
      assert.equal(current.process.stdout, managerBefore.process.stdout);
      try {
        assert.equal(processBirth(manager.pid), managerBefore.birth, 'native Manager lifetime must match immediately before STOP');
        process.kill(manager.pid, 'SIGSTOP');
        const suspended = ok(await call('confirm original Manager suspended state', '/bin/ps', ['-p', String(manager.pid), '-o', 'stat=']));
        assert.match(suspended.stdout.trim(), /^T/, 'the unreadable fault must actually be active');
        const refused = await candidate('unreadable real Manager refuses install repair', ['daemon', 'install', '--json']);
        assert.equal(refused.timedOut, false, 'fixture timeout is not a repair refusal');
        assert.equal(refused.signal, null);
        assert.notEqual(refused.exit, 0);
        assert.match(JSON.parse(refused.stdout).error?.message ?? '', /Manager|repair preparation/i);
        assert.equal(readFileSync(plist, 'utf8'), sourceBefore);
        assert.equal(readFileSync(receiptPath, 'utf8'), receiptBefore);
        assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
        assert(!existsSync(join(cotalHome, 'daemon/service-repair.json')), 'unreadable Manager cannot authorize native replacement');
        for (const held of heldProcesses) {
          const live = await identity(held.pid, 'unreadable Manager refusal original lifetime');
          assert.equal(live.process.stdout, held.process.stdout);
        }
      } finally {
        // Resume before diagnostic subprocesses: their failure must not leave the owned Manager suspended.
        assert.equal(processBirth(manager.pid), managerBefore.birth, 'native Manager lifetime must match immediately before CONT');
        process.kill(manager.pid, 'SIGCONT');
        const held = await identity(manager.pid, 'original Manager lifetime after resume');
        assert.equal(held.process.stdout, managerBefore.process.stdout, 'never accept a replacement Manager');
      }
      let answered = false;
      const recoveryDeadline = Date.now() + 20000;
      while (Date.now() < recoveryDeadline) {
        const ps = await call('old public client verifies Manager usable after unreadable refusal', process.execPath, [oldEntry, 'ps', '--on', manager.instanceId, '--space', report.participant.space, '--json'], { timeout: Math.max(1, Math.min(5000, recoveryDeadline - Date.now())) });
        if (ps.exit === 0 && !ps.signal && !ps.timedOut) {
          const result = JSON.parse(ps.stdout).result;
          assert.equal(result.kind, 'seats');
          assert(result.managers?.some(row => row.instanceId === manager.instanceId && row.state === 'answered'), 'public control must answer from the original instance');
          assert.equal(processBirth(manager.pid), managerBefore.birth, 'recovery must retain the original Manager lifetime');
          answered = true; break;
        }
        await delay(250);
      }
      assert(answered, 'same Manager must answer instance-pinned public seat inspection after resuming');
      // A public read is not admission proof. Launch and stop an actual owned lifecycle on that same Manager.
      assert.equal(processBirth(manager.pid), managerBefore.birth, 'original Manager must remain pinned immediately before new-work admission');
      occupiedInstance = manager.instanceId;
      const admissionReceipt = join(connector, 'seat-process.json');
      assert(!existsSync(admissionReceipt), 'admission proof must not reuse a prior seat receipt');
      ok(await old('public new lifecycle launch after unreadable repair refusal', ['spawn', '--agent', 'deleted-app-fixture', '--on', occupiedInstance, '--name', occupiedName, '--detach', '--no-events', '--space', report.participant.space]));
      const admissionDeadline = Date.now() + 20000;
      while (!existsSync(admissionReceipt) && Date.now() < admissionDeadline) await delay(100);
      const admitted = JSON.parse(readFileSync(admissionReceipt, 'utf8'));
      assert.equal(admitted.name, occupiedName);
      assert(typeof admitted.lifecycleUid === 'string' && admitted.lifecycleUid.length > 0);
      occupiedSeat = { ...await identity(admitted.pid, 'actual new lifecycle after unreadable refusal'), lifecycleUid: admitted.lifecycleUid };
      assert(occupiedSeat.birth);
      assert.equal(processBirth(manager.pid), managerBefore.birth, 'actual new work must be admitted by the original Manager lifetime');
      const admittedInventory = body(await old('public original Manager confirms actual admitted lifecycle', ['ps', '--on', occupiedInstance, '--space', report.participant.space, '--json']));
      assert(admittedInventory.items?.some(row => row.name === occupiedName && row.lifecycleUid === occupiedSeat.lifecycleUid));
      assert(admittedInventory.managers?.some(row => row.instanceId === occupiedInstance && row.state === 'answered'));
      report.unreadableManagerNewWork = { pid: occupiedSeat.pid, birth: occupiedSeat.birth, lifecycleUid: occupiedSeat.lifecycleUid, instanceId: occupiedInstance, originalManagerBirth: managerBefore.birth, publicLaunchSucceeded: true };
      assert.equal(readFileSync(plist, 'utf8'), sourceBefore);
      assert.equal(readFileSync(receiptPath, 'utf8'), receiptBefore);
      assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
      await ownedService();
      report.unreadableManagerAcceptance = { actualSuspensionObserved: true, repairRefused: true, nativeRecordsUnchanged: true, credentialsPreserved: true, originalLifetimesRetained: true, publicSeatInspectionRecovered: true, lifecycleFenceReleaseMeasured: true };
    }
    if (repairCommand === 'unreadable-source') {
      await ownedService();
      const sourceIdentity = statSync(plist);
      const receiptBefore = readFileSync(receiptPath, 'utf8');
      try {
        chmodSync(plist, 0);
        assert.throws(() => readFileSync(plist), { code: 'EACCES' }, 'real source read must fail, not only have a permission bit');
        const refused = await candidate('unreadable source refuses install repair', ['daemon', 'install', '--json']);
        assert.equal(refused.timedOut, false);
        assert.equal(refused.signal, null);
        assert.equal(refused.exit, 2);
        assert.equal(JSON.parse(refused.stdout).error.code, 'CONFLICT');
        assert.equal(readFileSync(receiptPath, 'utf8'), receiptBefore);
        assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
        assert(!existsSync(join(cotalHome, 'daemon/service-repair.json')), 'unreadable source must not publish repair intent');
        for (const held of heldProcesses) {
          const live = await call(`unreadable source preserves original process ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
          ok(live);
          assert.equal(live.stdout, held.process.stdout, 'refusal must retain the original daemon and Manager lifetimes');
        }
      } finally {
        const current = statSync(plist);
        assert.equal(current.dev, sourceIdentity.dev);
        assert.equal(current.ino, sourceIdentity.ino, 'restore permissions only on the same owned source');
        chmodSync(plist, sourceIdentity.mode & 0o777);
      }
      assert.equal(readFileSync(plist, 'utf8'), source);
      await ownedService();
      report.unreadableSourceAcceptance = { actualReadDenied: true, refusedConflict: true, sourceAndReceiptUnchanged: true, credentialsPreserved: true, originalLifetimesRetained: true, modeRestored: true };
    }
    if (repairCommand === 'disabled') {
      const { spaceSegment } = await import(pathToFileURL(resolve('packages/workspace/dist/index.js')).href);
      const hostingPath = join(cotalHome, 'daemon', spaceSegment(report.participant.space), 'manager-host.json');
      const hostingBefore = readFileSync(hostingPath, 'utf8');
      report.disabledHosting = { path: hostingPath, sha256: createHash('sha256').update(hostingBefore).digest('hex') };
      assert.equal(await readDisabled('record initial enabled override'), false);
      disabledOverrideChanged = true;
      ok(await nativeAction('operator disables exact owned missing-program job', ['disable']));
      assert.equal(await readDisabled('confirm operator disabled override'), true);
    }
    if (repairCommand === 'install' || repairCommand === 'disabled') {
      const installed = body(await candidate('candidate daemon install repairs missing program', ['daemon', 'install', '--json']));
      assert.equal(installed.state, 'repaired', 'install must take its repair branch before any candidate status');
      assert.equal(installed.unit, receipt.unit);
      assert.equal(installed.unitPath, receipt.unitPath);
      const installedSource = readFileSync(plist, 'utf8');
      const installedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.equal(installedReceipt.unitSha256, createHash('sha256').update(installedSource).digest('hex'));
      assert(!installedSource.includes(`${app}/`), 'install must replace the missing program before status can repair it');
      assert(installedSource.includes(candidateEntry.replace(/cotal\.js$/, 'daemon-cwd.js')));
      assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore, 'install repair preserves sign-in bytes');
      serviceOwnership = { receiptPath, receiptSha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex'), sha256: installedReceipt.unitSha256 };
      if (repairCommand === 'disabled') {
        assert.equal(await readDisabled('repair preserves disabled override'), true);
        const absent = await nativeAction('disabled repaired job remains unloaded', ['print']);
        assert.equal(absent.exit, 113, 'disabled repair must not bootstrap a replacement');
        const stopped = await candidate('disabled repaired public status remains stopped', ['daemon', 'status', '--json']);
        assert.equal(stopped.exit, 2);
        assert.equal(JSON.parse(stopped.stdout).error.cause?.code, 'NOT_RUNNING');
        assert.equal(readFileSync(plist, 'utf8'), installedSource);
        assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore);
        assert.equal(createHash('sha256').update(readFileSync(report.disabledHosting.path)).digest('hex'), report.disabledHosting.sha256, 'disabled repair retains its hosted Manager intent');
        assert(!existsSync(join(cotalHome, 'daemon/service-repair.json')), 'completed disabled repair clears its intent');
        for (const held of heldProcesses) {
          const gone = await call(`disabled repair original process gone ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
          assert.equal(gone.exit, 1, 'disabled repair leaves no original daemon or Manager running');
        }
        report.disabledRepairAcceptance = { state: installed.state, sourceOutsideApp: true, credentialsPreserved: true, disabled: true, nativeAbsent: true, publicNotRunning: true };
      } else {
      const installedJob = ok(await nativeAction('install-triggered repaired job before status', ['print']));
      const installedPid = Number(/^\s*pid = (\d+)\s*$/m.exec(installedJob.stdout)?.[1]);
      assert(Number.isSafeInteger(installedPid) && installedPid > 1 && installedPid !== before.pid, 'install itself must start a fresh native job');
      heldProcesses.push(await identity(installedPid, 'install-triggered repaired daemon'));
      report.installRepairAcceptance = { state: installed.state, pid: installedPid, sourceOutsideAppBeforeStatus: true, credentialsPreserved: true };
      }
    }
    if (!['disabled', 'unreadable-source', 'unreadable-manager', 'occupied-manager'].includes(repairCommand)) {
    const repaired = body(await candidate(repairCommand === 'self-update' ? 'candidate status observes self-update-repaired program' : repairCommand === 'install' ? 'candidate status observes install-repaired program' : 'candidate daemon status repairs missing program', ['daemon', 'status', '--json']));
    if (repairCommand.startsWith('crash-')) {
      const { sourceDigest } = await import(pathToFileURL(resolve('bin/dist/daemon/service-repair.js')).href);
      assert.equal(sourceDigest(readFileSync(report.interruptedRepair.hostingPath, 'utf8')), report.interruptedRepair.hostingSha256);
      assert(!existsSync(join(cotalHome, 'daemon/service-repair.json')), 'same-candidate public retry must clear the actual interrupted intent');
    }
    if (selfUpdate) assert.equal(repaired.pid, report.selfUpdateRepairAcceptance.pid, 'status must observe the native lifetime already started by self-update');
    if (repairCommand === 'install') assert.equal(repaired.pid, report.installRepairAcceptance.pid, 'status observes the already repaired native lifetime');
    assert.notEqual(repaired.pid, before.pid, 'repair starts a fresh daemon lifetime');
    assert.equal(repaired.version, selfUpdate ? candidateRegistry.identity.targetVersion : report.candidate.version.split(/\r?\n/)[0].replace('cotal-ai ', ''));
    assert(repaired.managers.some(row => row.space === report.participant.space && row.state === 'answering'));
    assert.equal(readFileSync(sessionPath, 'utf8'), stateBefore, 'repair preserves daemon sign-in bytes');
    const currentReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const currentSource = readFileSync(plist, 'utf8');
    serviceOwnership = { receiptPath, receiptSha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex'), sha256: currentReceipt.unitSha256 };
    assert.equal(currentReceipt.unitSha256, createHash('sha256').update(currentSource).digest('hex'));
    assert(!currentSource.includes(`${app}/`), 'repaired unit no longer points into removed app');
    assert(currentSource.includes(candidateEntry.replace(/cotal\.js$/, 'daemon-cwd.js')));
    heldProcesses.push(await identity(repaired.pid, 'repaired daemon'));
    for (const row of repaired.managers) if (row.pid) heldProcesses.push(await identity(row.pid, 'repaired Manager'));
    if (repairCommand.startsWith('crash-')) {
      const retriedJob = ok(await nativeAction('same-candidate retry exact native job', ['print']));
      assert.equal(Number(/^\s*pid = (\d+)\s*$/m.exec(retriedJob.stdout)?.[1]), repaired.pid);
    }
    const repeated = await candidate('repaired service repeated install remains unchanged', ['daemon', 'install', '--json']);
    assert.equal(repeated.exit, 2, 'baseline repeated install preserves its existing conflict contract');
    assert.equal(JSON.parse(repeated.stdout).error.code, 'CONFLICT');
    assert.equal(readFileSync(plist, 'utf8'), currentSource);
    await nativeAction('restart repaired service', ['kickstart', '-k']);
    await delay(3000);
    const restarted = body(await candidate('repaired daemon answers after native restart', ['daemon', 'status', '--json']));
    assert.notEqual(restarted.pid, repaired.pid);
    heldProcesses.push(await identity(restarted.pid, 'restarted repaired daemon'));
    for (const row of restarted.managers ?? []) if (row.pid) heldProcesses.push(await identity(row.pid, 'restarted repaired Manager'));
    report.repairAcceptance = { freshPid: repaired.pid, restartedPid: restarted.pid, version: restarted.version, programOutsideApp: true, credentialsPreserved: true };
    if (repairCommand.startsWith('crash-')) {
      report.interruptedRepair.retryComplete = true;
      if (report.interruptedRepair.destinationRefusal) report.interruptedRepair.destinationRefusal.sameCandidateRetryPending = false;
    }
    }
    report.outcome = 'repair-measured';
  } else {
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
  }
} catch (error) {
  report.outcome = 'blocked'; report.error = publicText(error.stack ?? error); process.exitCode = 1;
} finally {
  if (occupiedInstance) {
    try {
      assert(occupiedSeat?.birth, 'no seat stop without its captured native lifetime');
      assert.equal(processBirth(occupiedSeat.pid), occupiedSeat.birth, 'no seat stop after native lifetime replacement');
      const inventory = body(await old('verify original occupied lifecycle before fixture cleanup', ['ps', '--on', occupiedInstance, '--space', report.participant.space, '--json']));
      assert(inventory.items?.some(row => row.name === occupiedName && row.lifecycleUid === occupiedSeat.lifecycleUid), 'no seat stop if its public lifecycle changed');
      const stop = await old('stop only fixture-owned occupied seat through original Manager', ['stop', occupiedName, '--on', occupiedInstance, '--space', report.participant.space, '--json']);
      ok(stop);
      if (occupiedSeat) {
        const until = Date.now() + 20000;
        while (processBirth(occupiedSeat.pid) === occupiedSeat.birth && Date.now() < until) await delay(100);
        assert.notEqual(processBirth(occupiedSeat.pid), occupiedSeat.birth, 'owned seat must exit before native Manager cleanup');
      } else {
        throw new Error('occupied launch process identity was not captured; cleanup remains unconfirmed even after public stop');
      }
      report.cleanupOccupiedSeatStopped = true;
    } catch (error) { report.cleanupOccupiedSeatError = publicText(error); process.exitCode = 1; }
  }
  if (serviceOwnership && !report.cleanupOccupiedSeatError && !report.interruptionCleanupUnconfirmed) {
    try {
      await nativeAction('cleanup exact service bootout', ['bootout']);
      for (let attempt = 0; attempt < 50; attempt++) {
        report.cleanupService = await call('cleanup service absence', '/bin/launchctl', ['print', target]);
        if (report.cleanupService.exit === 113) break;
        if (report.cleanupService.exit !== 0) { process.exitCode = 1; break; }
        await delay(200);
      }
      if (report.cleanupService.exit !== 113) process.exitCode = 1;
      if (disabledOverrideChanged && report.cleanupService.exit === 113) {
        ok(await nativeAction('cleanup restore recorded enabled override while job absent', ['enable']));
        assert.equal(await readDisabled('cleanup confirms original enabled override'), false);
        assert.equal((await nativeAction('cleanup enable did not load service', ['print'])).exit, 113);
        report.cleanupDisabledOverrideRestored = true;
      }
    } catch (error) {
      report.cleanupOwnershipError = publicText(error);
      report.cleanupOwnershipUnconfirmed = 'The source or receipt may have changed during a failed repair. No replacement job or process was adopted for cleanup. This cell remains failed, no later cell may run, and disposable runner teardown owns any unknown survivors.';
      report.cleanupUnverifiedNativeObservation = await call('passive exact-label observation after cleanup authority refusal', '/bin/launchctl', ['print', target]);
      process.exitCode = 1;
    }
  } else {
    try {
      const loaded = await call('unconfirmed install service observation', '/bin/launchctl', ['print', target]);
      report.cleanupUnknownService = existsSync(plist) || existsSync(join(cotalHome, 'daemon/service-unit.json')) || loaded.exit !== 113;
      if (report.cleanupUnknownService) process.exitCode = 1;
    } catch (error) { report.cleanupUnknownService = true; report.cleanupUnknownError = publicText(error); process.exitCode = 1; }
  }
  try {
    if (report.cleanupOccupiedSeatError || report.interruptionCleanupUnconfirmed) throw new Error('owned seat or public repair CLI cleanup is unconfirmed; no daemon or Manager process signal is authorized');
    for (const held of heldProcesses) {
    const current = await call(`cleanup pinned process ${held.pid}`, '/bin/ps', ['-p', String(held.pid), '-o', 'pid=,lstart=,comm=']);
    if (current.exit === 0 && current.stdout === held.process.stdout && held.birth && processBirth(held.pid) === held.birth) {
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
  try { if (candidateRegistry) report.selfUpdateRegistryRequests = await candidateRegistry.close(); }
  catch (error) { report.cleanupRegistryError = publicText(error); process.exitCode = 1; }
  try { await closeParticipant?.(); }
  catch (error) { report.cleanupParticipantError = publicText(error); process.exitCode = 1; }
  try { if (mounted) await call('cleanup image detach', '/usr/bin/hdiutil', ['detach', mount]); }
  finally {
    try {
      if (copiedApp && existsSync(app) && !report.cleanupUnknownService && !report.cleanupOwnershipError
        && !report.cleanupOutstanding && !report.cleanupProcessError && !report.cleanupUnresolvedProcesses && !report.cleanupCensusError) await deleteOwnedApp();
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
