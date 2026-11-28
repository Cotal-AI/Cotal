import strictAssert from 'node:assert/strict';
import { countedAssert, emitSentinel } from './sentinel.mjs';
const { assert, cells } = countedAssert(strictAssert);
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
for (const key of Object.keys(process.env)) if (key.startsWith('COTAL_')) delete process.env[key];
const repo = fileURLToPath(new URL('../../', import.meta.url));
const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const originalEnv = { ...process.env }, originalCwd = process.cwd();
const terminal = process.argv.includes('--terminal-output');
for (const scenario of terminal ? ['terminal'] : process.argv.includes('--release-hold') ? ['release-hold'] : process.argv.includes('--legacy-unit-rollback') ? ['legacy-unit-rollback'] : ['retry', 'rollback', 'paused', 'preflight', 'notarget-manual', 'notarget-auto', 'closure-auto', 'release-hold', ...(process.platform === 'linux' ? ['legacy-unit-rollback'] : [])]) {
 const root = mkdtempSync(join(tmpdir(), 'autoupd-repair-'));
 const home = join(root, 'home'), prefix = join(root, 'prefix');
 for (const dir of [home, prefix, join(root, 'config/cotal'), join(root, '.cotal'), join(root, 'payload/package/dist')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
 const notarget = scenario.startsWith('notarget');
 const closure = scenario === 'closure-auto';
 const releaseHold = scenario === 'release-hold';
 const legacyUnitRollback = scenario === 'legacy-unit-rollback';
 const first = legacyUnitRollback ? '0.183.1000' : '99.0.0', second = '99.0.1', hour = 3_600_000;
 const baseVersion = legacyUnitRollback ? '0.183.0' : previous;
 const archives = {};
 if (legacyUnitRollback) {
  const fixtureDir = join(root, 'upgrade-fixture');
  const built = spawnSync(process.execPath, [join(repo, 'bin/smoke/build-daemon-upgrade-fixture.mjs'), fixtureDir, '--workspace-source'], { cwd: repo, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const reversionTree = (dir, ver) => {
   const rootPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
   rootPkg.version = ver;
   for (const k of Object.keys(rootPkg.dependencies ?? {})) if (k.startsWith('@cotal-ai/')) rootPkg.dependencies[k] = ver;
   writeFileSync(join(dir, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');
   for (const entry of readdirSync(join(dir, 'seeded-connectors'), { withFileTypes: true })) {
    const p = join(dir, 'seeded-connectors', entry.name, 'package.json');
    if (entry.isDirectory() && existsSync(p)) { const c = JSON.parse(readFileSync(p, 'utf8')); c.version = ver; writeFileSync(p, JSON.stringify(c, null, 2) + '\n'); }
   }
   const walkFirstParty = nm => {
    const scopeDir = join(nm, '@cotal-ai');
    if (!existsSync(scopeDir)) return;
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
     if (!entry.isDirectory()) continue;
     const pkgRoot = join(scopeDir, entry.name), mf = join(pkgRoot, 'package.json');
     if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, 'utf8'));
      m.version = ver;
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
       for (const k of Object.keys(m[field] ?? {})) if (k.startsWith('@cotal-ai/')) m[field][k] = ver;
      }
      writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
     }
     if (existsSync(join(pkgRoot, 'node_modules'))) walkFirstParty(join(pkgRoot, 'node_modules'));
    }
   };
   walkFirstParty(join(dir, 'node_modules'));
  };
  const candDir = join(fixtureDir, 'hoisted-fix2-0.151.3');
  reversionTree(candDir, first);
  assert.equal(readFileSync(join(candDir, 'dist/daemon/update-entry.js'), 'utf8').includes('reconcileInstalledLinuxPolicy'), true);
  assert.equal(spawnSync('npm', ['pack', '--ignore-scripts', '--offline', '--pack-destination', fixtureDir], { cwd: candDir, encoding: 'utf8' }).status, 0);
  archives[first] = readFileSync(join(fixtureDir, `cotal-ai-${first}.tgz`));
  // Assemble an offline pre-OOMPolicy baseline release over the local workspace dependency closure.
  const relDir = join(fixtureDir, 'hoisted-fix2-0.151.2');
  reversionTree(relDir, baseVersion);
  const baseInstall = join(relDir, 'dist/daemon/install.js');
  writeFileSync(baseInstall, readFileSync(baseInstall, 'utf8').replace("'OOMPolicy=continue',", ''));
  const baseUpdate = join(relDir, 'dist/daemon/update-entry.js');
  writeFileSync(baseUpdate, readFileSync(baseUpdate, 'utf8')
   .replace(/function reconcileInstalledLinuxPolicy\(\)\s*\{[\s\S]*?\n\}\n/, '')
   .replace(/\s*reconcileInstalledLinuxPolicy\(\);\n/, '\n'));
  assert.equal(readFileSync(baseUpdate, 'utf8').includes('reconcileInstalledLinuxPolicy'), false, 'baseline release must not contain candidate OOMPolicy step');
  assert.equal(spawnSync('npm', ['pack', '--ignore-scripts', '--offline', '--pack-destination', fixtureDir], { cwd: relDir, encoding: 'utf8' }).status, 0);
  archives[baseVersion] = readFileSync(join(fixtureDir, `cotal-ai-${baseVersion}.tgz`));
 } else {
  for (const version of [first, previous, ...(releaseHold ? [second] : [])]) {
   writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' } }));
   const code = version === previous
    ? (scenario === 'paused' ? 'process.exit(43)' : 'console.log("previous reconciled")')
    : notarget || closure || terminal || releaseHold
     ? 'console.log("release reconciled")'
     : scenario === 'retry'
      ? `const fs=require('node:fs');const p=${JSON.stringify(join(root, 'once'))};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(42)}console.log('retry reconciled')`
      : 'process.exit(42)';
   writeFileSync(join(root, 'payload/package/dist/cotal.js'), '#!/usr/bin/env node\n' + code + '\n', { mode: 0o755 });
   assert.equal(spawnSync('tar', ['-czf', join(root, version + '.tgz'), '-C', join(root, 'payload'), 'package']).status, 0);
   archives[version] = readFileSync(join(root, version + '.tgz'));
  }
 }
 let origin, missing = false, arriving = notarget, armed = false, latest = first;
 const fetchedArchives = [];
 const server = createServer((req, res) => {
  if (closure && decodeURIComponent(req.url ?? '').includes('@cotal-ai/')) return res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  if (req.url?.endsWith('.tgz')) {
   const version = req.url.slice(1, -4);
   fetchedArchives.push(version);
   if (scenario === 'preflight' && version === '99.0.0') return res.writeHead(503).end();
   if (armed && arriving && version === previous) missing = true;
   return res.end(archives[version]);
  }
  const versions = Object.fromEntries(Object.entries(archives).map(([version, bytes]) => [version, { name: 'cotal-ai', version, ...(terminal ? { deprecated: 'terminal warning fixture' } : {}), bin: { cotal: 'dist/cotal.js' }, dist: { tarball: `${origin}/${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } }]));
  if (missing) delete versions['99.0.0'];
  res.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest }, versions }));
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 origin = 'http://127.0.0.1:' + server.address().port;
 const env = { ...Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !key.startsWith('COTAL_'))), HOME: home, XDG_CONFIG_HOME: join(root, 'config'), COTAL_HOME: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_registry: origin, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off' };
 async function run(file, args) {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => output += bytes);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, output };
 }
 const command = () => run(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
 const installedVersion = () => JSON.parse(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version;
 const recovery = () => JSON.parse(readFileSync(join(home, 'update-recovery.json'), 'utf8'));
 let updater;
 try {
  if (terminal) {
   const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
   const record = async (label, argv) => {
    const result = await run('script', ['-q', '-e', '-c', argv.map(quote).join(' '), '/dev/null']);
    console.log(label + ':', result.code, JSON.stringify(result.output));
    assert.equal(result.code, 0, result.output);
    const plain = result.output.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /npm warn deprecated cotal-ai@99\.0\.0: terminal warning fixture/);
    return plain;
   };
   await record('BEFORE INHERITED NPM TERMINAL', ['npm', 'install', '-g', 'cotal-ai@99.0.0']);
   const after = await record('AFTER UPDATE TERMINAL', [process.execPath, join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
   assert.match(after, /installed globally and reconciled/);
   assert.doesNotMatch(after, /"(?:added|removed|changed|audited|funding|error)"\s*:/, 'npm JSON stays captured');
   assert.equal(installedVersion(), '99.0.0');
  } else if (notarget || closure || releaseHold) {
   const initial = await run('npm', ['install', '-g', `cotal-ai@${previous}`]);
   assert.equal(initial.code, 0, initial.output);
   const installedPath = join(prefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
   const before = readFileSync(installedPath, 'utf8');
   // A marker absent from the archive detects an unnecessary rollback reinstall.
   writeFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'unchanged');
   armed = true;
   if (scenario === 'notarget-auto' || closure || releaseHold) {
    if (closure) {
     const dir = join(root, 'config/cotal/extensions');
     mkdirSync(dir, { recursive: true, mode: 0o700 });
     writeFileSync(join(dir, 'extensions.json'), JSON.stringify({ extensions: [{ pkg: '@cotal-ai/closure-fixture', version: previous, spec: `@cotal-ai/closure-fixture@${previous}`, commands: [] }] }));
    }
    Object.assign(process.env, env);
    process.chdir(root);
    const attempt = join(home, 'update-attempt.json');
    const cache = join(home, 'update-check.json');
    writeFileSync(attempt, JSON.stringify({ version: first, failures: 1, result: 'due', next: 0 }));
    if (!releaseHold) writeFileSync(cache, JSON.stringify({ v: 1, latest: first, attemptedAt: Date.now(), checkedAt: Date.now(), firstSeenAt: Date.now() - hour - 1000 }));
    const { automaticUpdates } = await import('../dist/daemon/auto-update.js');
    updater = automaticUpdates({ version: previous, eligible: () => true, prepare: async () => {}, abort: async () => {}, report: () => {} });
    async function settled(expected, version = first) {
     const deadline = Date.now() + 90000;
     while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = JSON.parse(readFileSync(attempt, 'utf8'));
      if (!updater.updating() && (releaseHold ? state.version === version : true) && state.result.includes(expected)) return state;
     }
     throw new Error(`scheduler did not settle: ${readFileSync(attempt, 'utf8')}`);
    }
    if (releaseHold) {
     assert.equal((await updater.check()).latest, first);
     const checked = JSON.parse(readFileSync(cache, 'utf8'));
     // Age the first observation so its hold expires on the second scheduler tick.
     writeFileSync(cache, JSON.stringify({ ...checked, firstSeenAt: Date.now() - hour + 45_000 }));
     await settled('waiting for release hold');
     const beforeSwitch = fetchedArchives.length;
     latest = second;
     const held = await settled('waiting for release hold', second);
     const observed = JSON.parse(readFileSync(cache, 'utf8'));
     assert.equal(fetchedArchives.length, beforeSwitch, 'the changed tag does not fetch an archive');
     assert.equal(installedVersion(), previous);
     assert.equal(readFileSync(installedPath, 'utf8'), before);
     assert.equal(held.failures, 0, 'the previous target does not spend the new target’s failure budget');
     assert.equal(held.next, observed.firstSeenAt + hour);
     assert.deepEqual([updater.status().latest, updater.status().lastResult, updater.status().nextAttempt], [second, 'waiting for release hold', new Date(held.next).toISOString()]);
     console.log('RELEASE HELD:', JSON.stringify(updater.status()));
     writeFileSync(cache, JSON.stringify({ ...observed, firstSeenAt: Date.now() - hour }));
     writeFileSync(attempt, JSON.stringify({ ...held, next: 0 }));
     await settled(`updated to ${second}`, second);
     assert.equal(installedVersion(), second, 'the same tag installs when its own hold ends');
     assert.equal(updater.status().latest, second);
     console.log('RELEASE INSTALLED:', JSON.stringify(updater.status()));
     continue;
    }
    const started = Date.now();
    const deferred = await settled(closure ? 'waiting for registry or extension closure availability' : 'not available yet');
    console.log('SCHEDULER DEFERRED:', JSON.stringify(deferred));
    assert.equal(deferred.failures, 1, 'registry lag preserves the prior failure budget');
    if (closure) {
     console.log('CLOSURE BEFORE:', JSON.stringify({ version: '99.0.0', failures: 1, next: 0 }));
     console.log('CLOSURE AFTER:', JSON.stringify(deferred));
     const log = readFileSync(join(home, 'update-attempt.log'), 'utf8');
     console.log('CLOSURE LOG:', log.trim());
     assert.match(log, /update preflight failed: installed extension dependency closure is unavailable:[\s\S]*npm error code E404/);
     assert.match(log, /No global install was attempted\./);
     assert.ok(deferred.next >= started + 3600000 && deferred.next <= Date.now() + 3600000, 'closure retry is one hour later');
     assert.equal(existsSync(join(home, 'update-recovery.json')), false, 'preflight creates no recovery record');
     assert.equal(updater.status().automatic, true);
     assert.equal(installedVersion(), previous);
     assert.equal(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'utf8'), 'unchanged');
     const manual = await command();
     assert.equal(manual.code, 1, manual.output);
     assert.match(manual.output, /update preflight failed: installed extension dependency closure is unavailable:[\s\S]*npm error code E404/);
     assert.match(manual.output, /No global install was attempted\./);
     continue;
    }
    assert.match(deferred.result, /release is still arriving.*next update check/);
    assert.ok(deferred.next > Date.now());
    assert.equal(updater.status().automatic, true);
    assert.equal(installedVersion(), previous);
    assert.equal(readFileSync(installedPath, 'utf8'), before);
    assert.equal(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'utf8'), 'unchanged');
    assert.equal(recovery(), null);
    const log = readFileSync(join(home, 'update-attempt.log'), 'utf8');
    assert.doesNotMatch(log, /install failed|Update failed|Restoring verified/);
    arriving = missing = false;
    writeFileSync(attempt, JSON.stringify({ ...deferred, result: 'due', next: 0 }));
    updater.status();
    const completed = await settled('updated to 99.0.0');
    assert.equal(completed.failures, 0);
    assert.equal(installedVersion(), '99.0.0');
    assert.equal(recovery(), null);
   } else {
    const deferred = await command();
    console.log('MANUAL DEFERRED:', deferred.code, deferred.output.trim());
    assert.equal(deferred.code, 0, deferred.output);
    assert.match(deferred.output, /not available yet.*release is still arriving.*next update check/);
    assert.doesNotMatch(deferred.output, /install failed|Update failed|Restoring verified/);
    assert.equal(installedVersion(), previous);
    assert.equal(readFileSync(installedPath, 'utf8'), before);
    assert.equal(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'utf8'), 'unchanged');
    assert.equal(recovery(), null);
    arriving = missing = false;
    const completed = await command();
    assert.equal(completed.code, 0, completed.output);
    assert.equal(installedVersion(), '99.0.0');
    assert.equal(recovery(), null);
   }
  } else if (legacyUnitRollback) {
   const runtime = join(root, 'rt'), native = join(root, 'native');
   mkdirSync(runtime, { mode: 0o700 });
   mkdirSync(native, { mode: 0o700 });
   env.XDG_RUNTIME_DIR = runtime;
   env.PATH = `${native}:${env.PATH}`;
   const initial = await run('npm', ['install', '-g', `cotal-ai@${baseVersion}`]);
   assert.equal(initial.code, 0, initial.output);
   const installedPkg = join(prefix, 'lib/node_modules/cotal-ai');
   const installedEntry = join(installedPkg, 'dist/cotal.js');
   const daemonPidFile = join(root, 'daemon.pid');
   const unitDir = join(root, 'config/systemd/user');
   mkdirSync(unitDir, { recursive: true, mode: 0o700 });
   const unitPath = join(unitDir, 'cotal-daemon.service');
   const legacyUnit = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=notify\nNotifyAccess=all\nTimeoutStartSec=60\nEnvironment=PATH="${env.PATH}"\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${installedEntry}" daemon serve\nRestart=always\nRestartSec=2\nTimeoutStopSec=90\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n`;
   writeFileSync(unitPath, legacyUnit, { mode: 0o600 });
   mkdirSync(join(home, 'daemon'), { recursive: true, mode: 0o700 });
   const receiptPath = join(home, 'daemon/service-unit.json');
   const legacySha = createHash('sha256').update(legacyUnit).digest('hex');
   const originalReceipt = JSON.stringify({ v: 1, mechanism: 'systemd-user', unit: 'cotal-daemon.service', unitPath, unitSha256: legacySha, installedAt: new Date().toISOString() });
   writeFileSync(receiptPath, originalReceipt + '\n', { mode: 0o600 });
   const daemonEnv = { ...env, COTAL_DAEMON_NATIVE_SERVICE: '1' };
   const scopesFile = join(root, 'scopes.json');
   writeFileSync(scopesFile, '[]\n', { mode: 0o600 });
   const storeDir = join(prefix, 'lib/.cotal-generations');
   const cgroupPreload = join(root, 'cgroup-preload.mjs');
   writeFileSync(cgroupPreload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const origReadFileSync = fs.readFileSync;
const scopesFile = ${JSON.stringify(scopesFile)};
function ppidOf(pid) {
  try {
    const stat = origReadFileSync('/proc/' + pid + '/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { return 0; }
}
fs.readFileSync = function(path, ...rest) {
  const m = /^\\/proc\\/(\\d+)\\/cgroup$/.exec(String(path));
  if (m) {
    const pid = Number(m[1]), ppid = ppidOf(pid);
    const scopes = JSON.parse(origReadFileSync(scopesFile, 'utf8')).filter(e => e.op === 'StartTransientUnit');
    const hit = scopes.findLast(e => e.pids.includes(pid) || e.pids.includes(ppid));
    const text = hit ? '0::/user.slice/' + hit.scope + '\\n' : '0::/user.slice/cotal-daemon.service\\n';
    return rest[0] ? text : Buffer.from(text);
  }
  return origReadFileSync.call(this, path, ...rest);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
   writeFileSync(join(native, 'systemctl'), `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const scopesFile = ${JSON.stringify(scopesFile)};
const storeDir = ${JSON.stringify(storeDir)};
const recordEvent = ev => { const list = JSON.parse(fs.readFileSync(scopesFile, 'utf8')); list.push(ev); fs.writeFileSync(scopesFile, JSON.stringify(list) + '\\n'); };
const ppidOf = pid => { try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); } catch { return 0; } };
if (args.join(' ') === '--user show-environment') { console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, 'config')}`)}); process.exit(0); }
if (args.includes('show')) {
 const unit = args[args.indexOf('show') + 1];
 if (unit && unit.endsWith('.scope')) {
  const list = JSON.parse(fs.readFileSync(scopesFile, 'utf8'));
  const entry = list.findLast(e => e.op === 'StartTransientUnit' && e.scope === unit);
  if (!entry) process.exit(89);
  const activeGen = fs.existsSync(storeDir) && fs.readdirSync(storeDir).some(name => name.startsWith('.active-'));
  const fields = { Description: entry.description, Transient: 'yes', ActiveState: 'active', ControlGroup: '/user.slice/' + unit, Job: '0' };
  const propArg = args.find(x => x.startsWith('--property='));
  recordEvent({ op: 'scope-show', scope: unit, prop: propArg ? propArg.slice(11) : '', callerPid: ppidOf(process.pid), activeGeneration: activeGen });
  if (args.includes('--value') && propArg) { console.log(fields[propArg.slice(11)] ?? ''); process.exit(0); }
  for (const f of args.filter(x => x.startsWith('--property='))) console.log(f.slice(11) + '=' + (fields[f.slice(11)] ?? ''));
  process.exit(0);
 }
 if (unit === '*') {
  console.log('Id=cotal-daemon.service\\nNeedDaemonReload=no\\n\\nId=other.service\\nNeedDaemonReload=no');
  process.exit(0);
 }
 if (unit === 'cotal-daemon.service') {
  const pid = fs.existsSync(${JSON.stringify(daemonPidFile)}) ? fs.readFileSync(${JSON.stringify(daemonPidFile)}, 'utf8').trim() : '0';
  const live = pid !== '0' && (() => { try { process.kill(Number(pid), 0); return true; } catch { return false; } })();
  if (args.includes('--value') && args.includes('--property=UnitFileState')) { console.log('enabled'); process.exit(0); }
  const fields = { Id: 'cotal-daemon.service', LoadState: 'loaded', FragmentPath: ${JSON.stringify(unitPath)}, DropInPaths: '', NeedDaemonReload: 'no', OOMPolicy: 'stop', ControlGroup: '/user.slice/cotal-daemon.service', Transient: 'no', MainPID: live ? pid : '0', ControlPID: '0', ActiveState: live ? 'active' : 'inactive', SubState: live ? 'running' : 'dead', UnitFileState: 'enabled', InvocationID: live ? '1'.repeat(32) : '', WorkingDirectory: '', Job: '0' };
  const propArg = args.find(x => x.startsWith('--property='));
  if (args.includes('--value') && propArg) { console.log(fields[propArg.slice(11)] ?? ''); process.exit(0); }
  for (const f of args.filter(x => x.startsWith('--property='))) console.log(f.slice(11) + '=' + (fields[f.slice(11)] ?? ''));
  process.exit(0);
 }
}
if (args.includes('daemon-reload')) { recordEvent({ op: 'daemon-reload' }); process.exit(0); }
if (args.includes('stop')) {
 const oldPid = fs.existsSync(${JSON.stringify(daemonPidFile)}) ? Number(fs.readFileSync(${JSON.stringify(daemonPidFile)}, 'utf8').trim()) : 0;
 if (oldPid > 0) {
  try { process.kill(oldPid, 'SIGTERM'); } catch {}
  const until = Date.now() + 5000;
  while (Date.now() < until) { try { process.kill(oldPid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { break; } }
 }
 fs.writeFileSync(${JSON.stringify(daemonPidFile)}, '0');
 process.exit(0);
}
if (args.includes('start')) {
 // Fail native start when target candidate generation (0.183.1000) is active; succeed once rolled back to baseline.
 const active = fs.existsSync(storeDir) && fs.readdirSync(storeDir).some(name => name.startsWith('.active-'));
 if (active) { console.error('target 0.183.1000 native start failed'); process.exit(99); }
 const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(installedEntry)}, 'daemon', 'serve'], { cwd: ${JSON.stringify(root)}, env: ${JSON.stringify(daemonEnv)}, detached: true, stdio: 'ignore' });
 fs.writeFileSync(${JSON.stringify(daemonPidFile)}, String(child.pid));
 child.unref();
 process.exit(0);
}
process.exit(99);
`, { mode: 0o700 });
   writeFileSync(join(native, 'busctl'), `#!${process.execPath}
const fs = require('node:fs');
const idx = process.argv.indexOf('StartTransientUnit');
if (idx !== -1) {
 const scope = process.argv[idx + 2], description = process.argv[idx + 7];
 const pids = [Number(process.argv[idx + 11]), Number(process.argv[idx + 12])];
 const list = JSON.parse(fs.readFileSync(${JSON.stringify(scopesFile)}, 'utf8'));
 list.push({ op: 'StartTransientUnit', scope, description, pids });
 fs.writeFileSync(${JSON.stringify(scopesFile)}, JSON.stringify(list) + '\\n');
 console.log('o "/org/freedesktop/systemd1/job/1"');
 process.exit(0);
}
if (process.argv.slice(-3).join(' ') !== 'ExecStartEx ExecStopEx ExecStopPostEx') process.exit(99);
const pid = fs.existsSync(${JSON.stringify(daemonPidFile)}) ? Number(fs.readFileSync(${JSON.stringify(daemonPidFile)}, 'utf8').trim()) : 0;
const argv = [${JSON.stringify(process.execPath)}, ${JSON.stringify(installedEntry)}, 'daemon', 'serve'];
for (const data of [[[argv[0], argv, [], 0, 0, 0, 0, pid, 0, 0]], [], []]) console.log(JSON.stringify({ type: 'a(sasasttttuii)', data }));
`, { mode: 0o700 });
   const seedDir = join(root, 'config/cotal/seed');
   mkdirSync(seedDir, { recursive: true, mode: 0o700 });
   for (const file of ['authority.json', 'authority.bak.json']) writeFileSync(join(seedDir, file), JSON.stringify({ everSeeded: ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web'] }), { mode: 0o600 });
   writeFileSync(join(seedDir, 'witness.json'), JSON.stringify({ initialized: true, firstGeneration: baseVersion }), { mode: 0o600 });
   writeFileSync(join(seedDir, 'stamp.json'), JSON.stringify({ generation: baseVersion }), { mode: 0o600 });
   writeFileSync(join(home, 'update-settings.json'), JSON.stringify({ v: 1, auto: true, notify: true }), { mode: 0o600 });
   writeFileSync(join(home, 'update-attempt.json'), JSON.stringify({ version: first, failures: 0, result: 'due', next: Date.now() + hour }), { mode: 0o600 });
   writeFileSync(join(home, 'update-check.json'), JSON.stringify({ v: 1, latest: first, attemptedAt: Date.now(), checkedAt: Date.now(), firstSeenAt: Date.now() - hour - 1000 }), { mode: 0o600 });
   const daemon = spawn(process.execPath, [installedEntry, 'daemon', 'serve'], { cwd: root, env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
   writeFileSync(daemonPidFile, String(daemon.pid), { mode: 0o600 });
   let daemonOut = '';
   daemon.stdout.on('data', b => daemonOut += b);
   daemon.stderr.on('data', b => daemonOut += b);
   try {
    for (let i = 0; i < 100; i++) {
     if (daemonOut.includes('daemon ready at') && daemonOut.includes('native ownership owned: verified')) break;
     if (daemon.exitCode !== null) throw new Error(`daemon exited early: ${daemonOut}`);
     await new Promise(r => setTimeout(r, 100));
    }
    assert.match(daemonOut, /native ownership owned: verified/);
    // Drive the automatic update child the way auto-update.ts spawns it (COTAL_AUTO_UPDATE=1, COTAL_NO_UPDATE_CHECK=1).
    const autoEnv = { ...env, COTAL_NO_UPDATE_CHECK: '1', COTAL_AUTO_UPDATE: '1', NODE_OPTIONS: `--import=${pathToFileURL(cgroupPreload).href}` };
    const autoRun = await new Promise((resolve, reject) => {
     const c = spawn(process.execPath, [installedEntry, 'update', '--self'], { cwd: root, env: autoEnv, stdio: ['ignore', 'pipe', 'pipe'] });
     let out = '';
     c.stdout.on('data', b => out += b);
     c.stderr.on('data', b => out += b);
     c.once('error', reject);
     c.once('close', code => resolve({ code, output: out }));
    });
    assert.notEqual(autoRun.code, 0, autoRun.output);
    const custodyMatch = /automatic update custody: parent (\d+) and child (\d+) in (cotal-update-[0-9a-f]{32}\.scope)/.exec(autoRun.output);
    assert.ok(custodyMatch, autoRun.output);
    const [, , initialChildPid, adoptedScope] = custodyMatch;
    const scopeEvents = JSON.parse(readFileSync(scopesFile, 'utf8'));
    const starts = scopeEvents.filter(e => e.op === 'StartTransientUnit');
    assert.equal(starts.length, 1, JSON.stringify(scopeEvents));
    assert.equal(starts[0].scope, adoptedScope);
    const rollbackScopeReuses = scopeEvents.filter(e => e.op === 'scope-show' && e.scope === adoptedScope && String(e.callerPid) !== initialChildPid && e.activeGeneration === false);
    assert.ok(rollbackScopeReuses.length > 0, `rollback child did not reuse ${adoptedScope}: ${JSON.stringify(scopeEvents)}`);
    assert.equal(scopeEvents.some(e => e.op === 'daemon-reload'), false, JSON.stringify(scopeEvents));
    assert.ok(autoRun.output.includes(`Restoring verified cotal-ai@${baseVersion}`), autoRun.output);
    assert.equal(recovery(), null, autoRun.output);
    assert.equal(installedVersion(), baseVersion);
    // Legacy unit and receipt must remain untouched so the rolled-back baseline daemon still sees an owned unit and keeps automatic updates enabled.
    assert.equal(readFileSync(unitPath, 'utf8'), legacyUnit);
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).unitSha256, legacySha);
    let parsedStatus;
    for (let i = 0; i < 60; i++) {
     const statusAfter = await run(process.execPath, [installedEntry, 'daemon', 'status', '--json']);
     if (statusAfter.code === 0) {
      parsedStatus = JSON.parse(statusAfter.output);
      if (parsedStatus.result?.update?.lastResult !== 'verifying native service ownership') break;
     }
     await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(parsedStatus, 'rolled-back daemon did not answer daemon status');
    assert.equal(parsedStatus.result.version, baseVersion);
    assert.equal(parsedStatus.result.update.automatic, true, JSON.stringify(parsedStatus.result.update));
    console.log('LEGACY UNIT ROLLBACK PRESERVED AUTO UPDATE:', JSON.stringify({ scope: adoptedScope, rollbackReuses: rollbackScopeReuses.length, update: parsedStatus.result.update }));
   } finally {
    const stopAndWaitGone = async pid => {
     if (!(pid > 0)) return;
     try { process.kill(pid, 'SIGTERM'); } catch { return; }
     for (let i = 0; i < 80; i++) {
      try { process.kill(pid, 0); if (i === 40) process.kill(pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 50)); }
      catch { return; }
     }
    };
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise(r => daemon.once('close', r)); }
    await stopAndWaitGone(daemon.pid);
    if (existsSync(daemonPidFile)) await stopAndWaitGone(Number(readFileSync(daemonPidFile, 'utf8').trim()));
   }
  } else {
   const { code, output } = await command();
   assert.equal(code, scenario === 'retry' ? 0 : scenario === 'preflight' ? 1 : 42, output);
   if (scenario === 'preflight') assert.equal(existsSync(join(prefix, 'lib/node_modules/cotal-ai')), false, output);
   else {
    assert.equal(installedVersion(), scenario === 'retry' ? '99.0.0' : previous, output);
    if (scenario === 'paused') { assert.equal(recovery().phase, 'paused'); assert.match(output, /Automatic updates are paused/); }
    else assert.equal(recovery(), null);
   }
  }
 } finally {
  await updater?.close();
  await new Promise(resolve => server.close(resolve));
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
 }
}
emitSentinel({ passed: cells(), failed: 0 });
