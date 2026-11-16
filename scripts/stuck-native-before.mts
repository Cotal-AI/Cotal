import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// BEFORE ONLY. Run once on each fresh disposable Linux runner, never on the laptop.
// node --import tsx stuck-native-before.mts REPO ROOT BASE_A BASE_B FIXED npm|installer
const [repo, root, baseA, baseB, fixed, route] = process.argv.slice(2);
assert(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'requires admitted disposable GitHub-hosted Linux');
assert(repo && root && process.env.RUNNER_TEMP && resolve(root).startsWith(resolve(process.env.RUNNER_TEMP) + '/'), 'private runner temp root required');
assert(route === 'npm' || route === 'installer', 'one route per fresh runner');
assert(!existsSync(root), 'fresh before-state required');
process.umask(0o077);
mkdirSync(root, { mode: 0o700 });
const report: any = { kind: 'official18-owned-native-before-proof', route, startedAt: new Date().toISOString(), calls: [], observations: [], harnessSource: process.env.GITHUB_SHA };
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
const birth = (pid: number) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]; } catch { return undefined; } };
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
  guard(); ok(await cotal('seed official18', ['ext', 'seed', '--repair']));
  closeParticipant = await prepareUpdateParticipant({ env, project, cotalHome: env.COTAL_HOME, report });
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
  const native = ok(await call('native supervisor identity', 'systemctl', ['--user', 'show', receipt.unit, '--property=MainPID,ControlGroup,ActiveState,UnitFileState']));
  assert(native.stdout.includes(`MainPID=${daemon.pid}\n`) && native.stdout.includes('ActiveState=active') && native.stdout.includes('UnitFileState=enabled'), 'supervisor must own the observed daemon');
  const manager = await managerViaDaemon({ paths }, { op: 'manager-start', space: report.participant.space });
  assert.equal(manager.state, 'answering'); report.beforeManager = { ...identity(manager.pid), instanceId: manager.instanceId };
  report.nativeCgroups = { daemon: readFileSync(`/proc/${daemon.pid}/cgroup`, 'utf8'), manager: readFileSync(`/proc/${manager.pid}/cgroup`, 'utf8') };
  assert.equal(report.nativeCgroups.daemon, report.nativeCgroups.manager, 'old Manager must be a child of this native service group');
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
  report.publicPsAfter = await cotal('new public ps against old Manager', ['ps', '--space', report.participant.space, '--json']);
  report.hashesAfter = { state: hashes(env.COTAL_HOME), config: hashes(join(env.XDG_CONFIG_HOME, 'cotal')) };
  assert.equal(report.after.daemon.pid, report.before.daemon.pid); assert.equal(report.after.daemon.start, report.before.daemon.start);
  assert.equal(birth(report.beforeManager.pid), report.beforeManager.start);
  assert(report.publicPsAfter.exit !== 0 && /preserving/.test(report.publicPsAfter.stdout + report.publicPsAfter.stderr), 'expected before-proof: new software installed, exact old Manager still refuses ps in preserving mode');
  report.outcome = 'reproduced: newer software installed, same owned native daemon and old Manager remain fenced, public ps refuses';
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
