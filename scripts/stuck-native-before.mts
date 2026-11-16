import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Recovery measurement only. Run once per route on a fresh disposable native runner, never the laptop.
// node --import tsx stuck-native-before.mts REPO ROOT BASE_A BASE_B FIXED npm|installer
const [repo, root, baseA, baseB, fixed, route] = process.argv.slice(2);
assert(['linux', 'darwin'].includes(process.platform) && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'requires admitted disposable GitHub-hosted POSIX runner');
assert(repo && root && process.env.RUNNER_TEMP && resolve(root).startsWith(resolve(process.env.RUNNER_TEMP) + '/'), 'private runner temp root required');
assert(route === 'npm' || route === 'installer', 'one route per fresh runner');
assert(!existsSync(root), 'fresh before-state required');
process.umask(0o077);
mkdirSync(root, { mode: 0o700 });
const report: any = { kind: 'official18-owned-native-recovery', platform: process.platform, route, startedAt: new Date().toISOString(), calls: [], observations: [], harnessSource: process.env.GITHUB_SHA };
const save = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const guard = () => { const d = statfsSync(root); assert(d.bavail * d.bsize >= 25769803776, 'STOP: less than 24 GiB before install or install-capable command'); };
const env: any = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('COTAL_')) delete env[key];
// The runner account is disposable. Its native supervisor retains its real HOME and runtime.
const home = homedir(), prefix = join(root, 'prefix'), project = join(root, 'project');
assert(!existsSync(join(home, '.cotal')) && !existsSync(join(home, '.config/cotal')), 'runner must start with no Cotal state or config, never hash a foreign profile');
Object.assign(env, { HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache'), npm_config_prefix: prefix, DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1' });
for (const dir of [project, env.TMPDIR, prefix]) mkdirSync(dir, { mode: 0o700 });
for (const key of Object.keys(process.env)) if (key.startsWith('COTAL_')) delete process.env[key];
Object.assign(process.env, env);
process.chdir(project);
const load = (path: string) => import(pathToFileURL(path).href);
const { candidatePairRegistry } = await load(join(repo, 'scripts/candidate-pair-registry.mjs'));
const { candidateRegistry } = await load(join(repo, 'scripts/automatic-update-platform-baseline.mjs'));
const { prepareUpdateParticipant } = await load(join(repo, 'implementations/auth/smoke/update-participant.fixture.ts'));
const cli = join(prefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
let birth: (pid: number) => string | undefined = () => { throw new Error('native process birth helper not loaded'); };
const identity = (pid: number) => { const start = birth(pid); assert(start && pid > 1, 'process birth required'); return { pid, start }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active: any, registry: any, closeParticipant: any, receipt: any, queryDaemon: any, managerViaDaemon: any, paths: any;
let installed = false, originalNpm: Buffer | undefined, writtenNpm: Buffer | undefined;
const npmrc = join(home, '.npmrc');
const children = new Set<any>();
function launch(label: string, file: string, argv: string[], extra: any = {}) {
  const row: any = { label, file, argv, stdout: '', stderr: '', exit: null, signal: null, timeout: false };
  report.calls.push(row);
  const child = spawn(file, argv, { cwd: project, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', bytes => { row.stdout += bytes; });
  child.stderr.on('data', bytes => { row.stderr += bytes; });
  const done = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (exit, signal) => { Object.assign(row, { exit, signal }); children.delete(child); save(); resolve(row); }); });
  return { child, row, done };
}
async function call(label: string, file: string, argv: string[], timeout = 240000, extra: any = {}) {
  const job = launch(label, file, argv, extra);
  const timer = setTimeout(() => { job.row.timeout = true; job.child.kill('SIGKILL'); }, timeout);
  try { return await job.done; } finally { clearTimeout(timer); }
}
const cotal = (label: string, argv: string[], timeout?: number) => call(label, process.execPath, [cli, ...argv], timeout);
const ok = (row: any) => { assert.equal(row.exit, 0, row.stderr + row.stdout); assert(!row.signal && !row.timeout); return row; };
function hashes(directory: string): any[] {
  if (!existsSync(directory)) return [];
  const rows: any[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...hashes(path));
    else if (entry.isFile()) rows.push({ path, sha256: hash(readFileSync(path)) });
  }
  return rows;
}
async function observe(label: string) {
  const reply = await queryDaemon({ paths }); assert(reply.ok, 'daemon observation must answer');
  const d = reply.result;
  const row = { label, at: new Date().toISOString(), daemon: { ...identity(d.pid), version: d.version, state: d.state }, managers: (d.managers ?? []).map((m: any) => ({ space: m.space, state: m.state, instanceId: m.instanceId, ...(m.pid ? identity(m.pid) : {}) })), fence: d.update?.restartEvidence };
  report.observations.push(row); save(); return row;
}
async function verifyNative(pid: number, stage: string) {
  assert.equal(hash(readFileSync(receipt.unitPath)), receipt.unitSha256, 'recorded service source must stay unchanged');
  if (process.platform === 'linux') {
    const native = ok(await call(`native supervisor identity ${stage}`, 'systemctl', ['--user', 'show', receipt.unit, '--property=MainPID,ControlGroup,ActiveState,UnitFileState']));
    assert(native.stdout.includes(`MainPID=${pid}\n`) && native.stdout.includes('ActiveState=active') && native.stdout.includes('UnitFileState=enabled'), 'systemd must own the observed daemon');
  } else {
    const { launchAgentService } = await load(join(prefix, 'lib/node_modules/cotal-ai/dist/daemon/install-darwin.js'));
    const { nativeRun } = await load(join(prefix, 'lib/node_modules/cotal-ai/dist/daemon/install-native-run.js'));
    const service = launchAgentService(nativeRun);
    service.check(receipt); assert.equal(service.isEnabled(receipt), true, 'verified loaded LaunchAgent must be enabled');
    const native = ok(await call(`launchd supervisor identity ${stage}`, '/bin/launchctl', ['print', `gui/${process.getuid!()}/${receipt.unit}`]));
    const ids = [...native.stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)].map(match => Number(match[1]));
    assert.deepEqual(ids, [pid], 'actual launchd PID must equal the authenticated daemon PID');
  }
}
async function installSeatFixture() {
  const fixture = join(root, 'recovery-seat'); mkdirSync(fixture, { mode: 0o700 });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'cotal-recovery-seat', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
  writeFileSync(join(fixture, 'seat.mjs'), `import{CotalEndpoint}from'@cotal-ai/core';import{readFileSync,writeFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env,cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(err,out)=>err?reject(err):resolve(out.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent',meta:{'ai.cotal.manager.instance':e.COTAL_MANAGER_INSTANCE}},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(e.COTAL_RECOVERY_READY,JSON.stringify({pid:process.pid,name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID}),{mode:0o600});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));setInterval(()=>{},1000);`);
  writeFileSync(join(fixture, 'index.js'), `import{registry}from'@cotal-ai/core';import{fileURLToPath}from'node:url';registry.register({kind:'connector',name:'recovery-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_RECOVERY_READY:${JSON.stringify(join(root, 'seat-ready.json'))},COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
  guard(); ok(await cotal('register real recovery seat', ['ext', 'add', fixture]));
}
try {
  report.inputs = [baseA, baseB, fixed].map((directory, index) => {
    const bytes = readFileSync(join(directory, 'manifest.json')), manifest = JSON.parse(bytes.toString());
    assert.equal(manifest.source, index < 2 ? process.env.LEGACY_SOURCE : process.env.FIXED_SOURCE);
    assert.equal(manifest.packages.length, 24);
    return { source: manifest.source, manifestSha256: hash(bytes), versions: [...new Set(manifest.packages.map((p: any) => p.version))] };
  });
  guard();
  report.officialDist = JSON.parse(ok(await call('official18 dist', 'npm', ['view', 'cotal-ai@0.164.18', 'dist', '--json', '--registry=https://registry.npmjs.org/'])).stdout);
  assert.match(report.officialDist.integrity, /^sha512-/);
  guard();
  ok(await call('install official18', 'npm', ['install', '-g', '--prefix', prefix, 'cotal-ai@0.164.18', '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund']));
  report.officialManifestSha256 = hash(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/package.json')));
  assert.equal(JSON.parse(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version, '0.164.18');
  const archiveResponse = await fetch(report.officialDist.tarball); assert(archiveResponse.ok, 'public archive fetch must succeed');
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), report.officialDist.integrity, 'official archive must match registry SRI');
  const archivePath = join(root, 'official18.tgz'); writeFileSync(archivePath, archive, { mode: 0o600 });
  report.officialFiles = ['dist/daemon/execution-preinstall.js', 'dist/daemon/execution-preinstall-client.js', 'dist/cotal.js'].map(file => {
    const published = execFileSync('tar', ['-xOf', archivePath, 'package/' + file], { timeout: 10000 });
    assert.equal(hash(readFileSync(join(prefix, 'lib/node_modules/cotal-ai', file))), hash(published), 'old side must equal integrity-bound public archive');
    return { file, sha256: hash(published) };
  });
  ({ processBirth: birth } = await load(join(prefix, 'lib/node_modules/cotal-ai/dist/daemon/lifetime.js')));
  guard(); ok(await cotal('seed official18', ['ext', 'seed', '--repair']));
  closeParticipant = await prepareUpdateParticipant({ env, project, cotalHome: env.COTAL_HOME, report });
  await installSeatFixture();
  ({ queryDaemon, managerViaDaemon } = await load(join(prefix, 'lib/node_modules/cotal-ai/dist/daemon/client.js')));
  const { daemonPaths } = await load(join(prefix, 'lib/node_modules/cotal-ai/dist/daemon/endpoint.js')); paths = daemonPaths();
  const plan = JSON.parse(ok(await cotal('native install plan', ['daemon', 'install', '--dry-run', '--json'])).stdout).result;
  assert.equal(plan.state, 'would-install'); assert(!existsSync(join(paths.state, 'service-unit.json')), 'no existing service receipt');
  ok(await cotal('disable automatic updates', ['update', '--auto', 'off']));
  installed = true; ok(await cotal('install owned native service', ['daemon', 'install', '--json']));
  receipt = JSON.parse(readFileSync(join(paths.state, 'service-unit.json'), 'utf8'));
  assert.equal(receipt.unit, plan.unit); assert.equal(hash(readFileSync(receipt.unitPath)), receipt.unitSha256);
  report.native = { unit: receipt.unit, unitPath: receipt.unitPath, unitSha256: receipt.unitSha256 };
  let daemon: any;
  for (let i = 0; i < 100; i++) { try { const r = await queryDaemon({ paths }); if (r.ok && r.result.state === 'ready') { daemon = r.result; break; } } catch {} await pause(250); }
  assert(daemon?.pid && daemon.version === '0.164.18');
  await verifyNative(daemon.pid, 'before');
  const manager = await managerViaDaemon({ paths }, { op: 'manager-start', space: report.participant.space });
  assert.equal(manager.state, 'answering'); report.beforeManager = { ...identity(manager.pid), instanceId: manager.instanceId };
  if (process.platform === 'linux') {
    report.nativeCgroups = { daemon: readFileSync(`/proc/${daemon.pid}/cgroup`, 'utf8'), manager: readFileSync(`/proc/${manager.pid}/cgroup`, 'utf8') };
    assert.equal(report.nativeCgroups.daemon, report.nativeCgroups.manager, 'old Manager must be a child of this native service group');
  } else {
    const parent = ok(await call('native Manager parent', '/bin/ps', ['-o', 'ppid=', '-p', String(manager.pid)]));
    assert.equal(Number(parent.stdout.trim()), daemon.pid, 'old Manager must belong to the observed launchd daemon');
  }
  registry = await candidatePairRegistry(baseA, baseB); registry.activateTarget();
  env.npm_config_registry = registry.url; process.env.npm_config_registry = registry.url;
  guard(); active = launch('official updater fence producer', process.execPath, [cli, 'update', '--self', '--space', report.participant.space]);
  let paused = false;
  active.child.stdout.on('data', () => { if (!paused && active.row.stdout.includes('Saving update recovery snapshot')) { paused = active.child.kill('SIGSTOP'); } });
  for (let i = 0; i < 1800 && !paused && active.child.exitCode === null; i++) await pause(100);
  assert(paused, 'official public updater must reach real pre-replacement snapshot boundary');
  const fenced = await observe('official18 prepared before kill');
  assert(fenced.fence?.prepared && fenced.fence.managers.every((m: any) => m.fenced && m.seats === 0));
  active.child.kill('SIGKILL'); await active.done; active = undefined;
  report.before = await observe('official18 fenced owner dead');
  report.oldPublicPs = await cotal('old public ps refusal', ['ps', '--space', report.participant.space, '--json']);
  assert(report.oldPublicPs.exit !== 0 && /preserving/.test(report.oldPublicPs.stdout + report.oldPublicPs.stderr), 'name the expected old Manager refusal');
  report.hashesBefore = { state: hashes(env.COTAL_HOME), config: hashes(join(env.XDG_CONFIG_HOME, 'cotal')) };
  report.baselineRegistryRequests = await registry.close(); registry = await candidateRegistry(fixed, 'B', 'https://registry.npmjs.org/');
  report.fixedCandidate = registry.identity; report.target = registry.identity.version;
  env.npm_config_registry = registry.url; process.env.npm_config_registry = registry.url;
  originalNpm = existsSync(npmrc) ? readFileSync(npmrc) : undefined;
  writtenNpm = Buffer.concat([originalNpm ?? Buffer.alloc(0), Buffer.from(`\nregistry=${registry.url}\n`)]); writeFileSync(npmrc, writtenNpm, { mode: 0o600 });
  guard();
  if (route === 'npm') report.replacement = ok(await call('plain npm replacement', 'npm', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.target}`, '--registry', registry.url, '--no-audit', '--no-fund']));
  else {
    const installer = join(fixed, 'installer.sh'), receipt = JSON.parse(readFileSync(join(fixed, 'installer.json'), 'utf8'));
    assert.equal(hash(readFileSync(installer)), receipt.sha256); assert.equal(receipt.source, registry.identity.source);
    report.installer = receipt;
    report.replacement = await call('source-bound installer rerun', 'sh', [installer, '--version', report.target, '--no-setup', '--no-modify-path'], 300000, { COTAL_INSTALL_DIR: prefix, COTAL_BIN_DIR: join(root, 'bin') });
  }
  report.version = await cotal('public new software version', ['--version']);
  assert(report.version.exit === 0 && report.version.stdout.startsWith(`cotal-ai ${report.target}\n`), 'new software must really be selected');
  if (route === 'npm') { guard(); report.self = await cotal('new public self update', ['update', '--self', '--space', report.participant.space]); }
  report.after = await observe('after public replacement and reconcile');
  report.publicPsAfter = await cotal('new public ps after recovery', ['ps', '--space', report.participant.space, '--json']);
  report.hashesAfter = { state: hashes(env.COTAL_HOME), config: hashes(join(env.XDG_CONFIG_HOME, 'cotal')) };
  const afterHashes = new Map(report.hashesAfter.state.map((row: any) => [row.path, row.sha256]));
  const durable = report.hashesBefore.state.filter((row: any) => /\/(manager-host|idp-sessions|service-unit|computer)\.json$/.test(row.path));
  assert(durable.some((row: any) => row.path.endsWith('/manager-host.json')) && durable.some((row: any) => row.path.endsWith('/idp-sessions.json')), 'hosting intent and session hashes must be recorded');
  for (const row of durable) assert.equal(afterHashes.get(row.path), row.sha256, 'recovery must preserve recorded hosting/account/session/service state');
  report.preservedState = durable;
  ok(report.replacement); if (report.self) ok(report.self); ok(report.publicPsAfter);
  assert.equal(report.after.daemon.version, report.target);
  const restored = report.after.managers.find((m: any) => m.space === report.participant.space);
  assert.equal(restored?.state, 'answering'); assert.equal(report.after.fence?.prepared, false);
  report.oldChildrenBeforeTeardown = { daemonAlive: birth(report.before.daemon.pid) === report.before.daemon.start, managerAlive: birth(report.beforeManager.pid) === report.beforeManager.start };
  assert.deepEqual(report.oldChildrenBeforeTeardown, { daemonAlive: false, managerAlive: false }, 'old native daemon AND Manager must be gone before teardown');
  await verifyNative(report.after.daemon.pid, 'recovered');
  const name = 'recovered_worker', space = report.participant.space;
  report.spawn = ok(await cotal('spawn on recovered Manager', ['spawn', '--agent', 'recovery-standin', '--on', restored.instanceId, '--name', name, '--detach', '--no-events', '--space', space]));
  for (let i = 0; i < 120 && !existsSync(join(root, 'seat-ready.json')); i++) await pause(250);
  assert(existsSync(join(root, 'seat-ready.json')), 'real recovered authenticated seat must become ready');
  const seat = JSON.parse(readFileSync(join(root, 'seat-ready.json'), 'utf8')); report.seat = { ...seat, ...identity(seat.pid) };
  report.work = JSON.parse(ok(await cotal('public recovered seat inventory', ['ps', '--on', restored.instanceId, '--space', space, '--json'])).stdout).result;
  assert(report.work.items.some((row: any) => row.name === name), 'spawned seat must be publicly listed');
  report.stop = ok(await cotal('stop on recovered Manager', ['stop', '--name', name, '--on', restored.instanceId, '--space', space]));
  for (let i = 0; i < 100 && birth(seat.pid) === report.seat.start; i++) await pause(100);
  report.seatStopped = birth(seat.pid) !== report.seat.start; assert.equal(report.seatStopped, true, 'stopped seat kernel lifetime must end');
  report.empty = JSON.parse(ok(await cotal('public inventory after recovered stop', ['ps', '--on', restored.instanceId, '--space', space, '--json'])).stdout).result;
  assert.equal(report.empty.items.length, 0);
  guard(); report.nextSelf = ok(await cotal('second public self update after recovery', ['update', '--self', '--space', space]));
  report.final = await observe('after recovered lifecycle and second self');
  assert.equal(report.final.daemon.version, report.target); assert.equal(report.final.managers.find((m: any) => m.space === space)?.state, 'answering');
  report.outcome = 'recovered: fixed native daemon and Manager, old lifetimes gone, real spawn/stop and subsequent public self update succeeded';
} catch (error: any) { report.error = error.stack; report.outcome ??= 'setup or observation failure, not accepted reproduction'; process.exitCode = 1; }
finally {
  if (active) { active.child.kill('SIGKILL'); await active.done; }
  // Native fixture lifetime ends only through the recorded service. Never kill by name.
  if (installed && receipt) {
    try { assert.equal(hash(readFileSync(receipt.unitPath)), receipt.unitSha256); report.cleanup = await cotal('remove owned disposable native fixture', ['daemon', 'uninstall', '--yes', '--json'], 120000); ok(report.cleanup); assert(!existsSync(receipt.unitPath)); }
    catch (error: any) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  if (report.beforeManager) report.oldManagerAliveAfterCleanup = birth(report.beforeManager.pid) === report.beforeManager.start;
  if (report.oldManagerAliveAfterCleanup) { report.cleanupError ??= 'owned old Manager remains after native cleanup'; process.exitCode = 1; }
  if (closeParticipant) { try { await closeParticipant(); } catch (error: any) { report.participantCleanupError = error.message; process.exitCode = 1; } }
  if (writtenNpm) { try { assert.deepEqual(readFileSync(npmrc), writtenNpm); if (originalNpm) writeFileSync(npmrc, originalNpm); /* Disposable runner teardown owns an initially absent npmrc. */ } catch (error: any) { report.npmConfigCleanupError = error.message; process.exitCode = 1; } }
  if (registry) { try { report.registryRequests = await registry.close(); } catch (error: any) { report.registryCleanupError = error.message; process.exitCode = 1; } }
  report.finishedAt = new Date().toISOString(); report.retentionOwner = 'disposable runner teardown'; save();
  console.log(JSON.stringify({ outcome: report.outcome, error: report.error, cleanupError: report.cleanupError, root }));
}
