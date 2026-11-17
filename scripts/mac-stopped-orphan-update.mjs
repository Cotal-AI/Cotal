/** Public installer self-update after an owned missing-program LaunchAgent has been stopped. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REF, 'refs/heads/measure/macos-orphan-preinstall');
assert(statfsSync(homedir()).bavail * statfsSync(homedir()).bsize >= 30 * 1024 ** 3, '30 GiB start floor');
const product = resolve(process.env.ORPHAN_PRODUCT_ROOT);
const closure = resolve(process.env.ORPHAN_CANDIDATE);
const root = join(process.env.RUNNER_TEMP, 'stopped-orphan-update');
const output = join(root, 'evidence');
assert(!existsSync(root));
mkdirSync(output, { recursive: true, mode: 0o700 });
const home = join(homedir(), '.cotal');
const app = `/Applications/CotalOrphanMeasurement-${process.env.GITHUB_RUN_ID}.app`;
const prefix = join(root, 'installer');
const bin = join(root, 'bin');
const launcher = join(bin, 'cotal');
const bundlePrefix = join(app, 'Contents/Resources');
const bundleNode = join(app, 'Contents/MacOS/node');
const bundleEntry = join(bundlePrefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
const plist = join(homedir(), 'Library/LaunchAgents/ai.cotal.daemon.plist');
const receiptPath = join(home, 'daemon/service-unit.json');
const label = `gui/${process.getuid()}/ai.cotal.daemon`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { source: process.env.GITHUB_SHA, productSource: process.env.ORPHAN_SOURCE_SHA, scope: 'Public 0.165.1 installer CLI, lane-owned npm closure bundle, not a signed released app; native daemon stopped before bundle deletion', calls: [], outcome: 'incomplete' };
const redact = value => String(value).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted>').replace(/\bS[UA][A-Z2-7]{56}\b/g, '<redacted seed>').replace(/update-participant-private-test-session/g, '<redacted>');
const save = () => writeFileSync(join(output, 'result.json'), redact(JSON.stringify(report, null, 2)));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_REGISTRY'].includes(key)));
Object.assign(env, { COTAL_HOME: home, COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', NO_COLOR: '1', TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(homedir(), '.config'), XDG_CACHE_HOME: join(homedir(), '.cache'), COTAL_INSTALL_DIR: prefix, COTAL_BIN_DIR: bin });
for (const directory of [env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, join(root, 'project')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
let sequence = 0;
async function call(name, file, args, callEnv = env, timeout = 180000) {
  const row = { name, file, args, startedAt: new Date().toISOString() };
  const result = await new Promise(resolveCall => {
    const child = spawn(file, args, { env: callEnv, cwd: join(root, 'project'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    const force = setTimeout(() => child.kill('SIGKILL'), timeout + 10000);
    child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', error => { row.spawnError = error.message; });
    child.once('close', (exit, signal) => { clearTimeout(timer); clearTimeout(force); resolveCall({ exit, signal, timedOut, stdout, stderr }); });
  });
  Object.assign(row, result, { stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr), finishedAt: new Date().toISOString() });
  report.calls.push(row);
  writeFileSync(join(output, `${String(++sequence).padStart(3, '0')}.json`), redact(JSON.stringify(row, null, 2)));
  save();
  console.log(`${name}: exit ${row.exit}, signal ${row.signal}, timeout ${row.timedOut}`);
  return row;
}
function ok(row) { assert.equal(row.timedOut, false, row.name); assert.equal(row.signal, null, row.name); assert.equal(row.exit, 0, `${row.name}: ${row.stderr}`); return row; }
const bundled = (name, args) => call(name, bundleNode, [bundleEntry, ...args]);
let ownership, copied, oldPid, oldBirth, registry, participantClose, manifest;
function owned() {
  assert(ownership);
  assert.equal(hash(readFileSync(plist)), ownership.source);
  assert.equal(hash(readFileSync(receiptPath)), ownership.receipt);
}
async function native(name, operation) { owned(); return call(name, '/bin/launchctl', [operation, label]); }
try {
  assert(!existsSync(home), 'fresh disposable operator home required');
  assert(!existsSync(app) && !existsSync(plist), 'never replace an existing app or service');
  assert.equal((await call('initial exact native absence', '/bin/launchctl', ['print', label])).exit, 113);
  manifest = JSON.parse(readFileSync(join(closure, 'manifest.json'), 'utf8'));
  assert.equal(manifest.source, report.productSource);
  for (const pkg of manifest.packages) assert.equal(hash(readFileSync(join(closure, pkg.archive))), pkg.sha256);
  report.candidate = { source: manifest.source, version: manifest.packages.find(pkg => pkg.name === 'cotal-ai').version, manifestSha256: hash(readFileSync(join(closure, 'manifest.json'))) };
  const installer = join(root, 'public-installer.sh');
  ok(await call('fetch public installer', '/usr/bin/curl', ['--fail', '--location', '--output', installer, 'https://get.cotal.ai']));
  report.installerSha256 = hash(readFileSync(installer));
  ok(await call('public installer 0.165.1', '/bin/sh', [installer, '--version', '0.165.1', '--no-setup', '--no-modify-path'], env, 600000));
  assert.match(ok(await call('public installer version', launcher, ['--version'])).stdout, /^cotal-ai 0\.165\.1\b/);
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true, mode: 0o700 });
  copied = { dev: statSync(app).dev, ino: statSync(app).ino };
  copyFileSync(process.execPath, bundleNode); chmodSync(bundleNode, 0o700);
  ok(await call('install public bundle closure 0.165.1', process.env.NPM_BIN, ['install', '-g', '--prefix', bundlePrefix, 'cotal-ai@0.165.1', '--no-audit', '--no-fund'], env, 600000));
  assert.match(ok(await bundled('public bundle version', ['--version'])).stdout, /^cotal-ai 0\.165\.1\b/);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const { prepareUpdateParticipant } = await import(pathToFileURL(join(product, 'implementations/auth/smoke/update-participant.fixture.ts')).href);
  participantClose = await prepareUpdateParticipant({ env, project: join(root, 'project'), cotalHome: home, report });
  ok(await bundled('install real bundle LaunchAgent', ['daemon', 'install', '--json']));
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.unit, 'ai.cotal.daemon'); assert.equal(receipt.unitPath, plist);
  ownership = { source: hash(readFileSync(plist)), receipt: hash(readFileSync(receiptPath)) };
  assert.equal(receipt.unitSha256, ownership.source);
  assert(readFileSync(plist, 'utf8').includes(bundleNode));
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    const row = await bundled('observe real bundle daemon ready', ['daemon', 'status', '--json']);
    if (row.exit === 0) { status = JSON.parse(row.stdout).result; break; }
    await delay(250);
  }
  assert(status?.pid > 1, 'real old daemon must be running before manual stop');
  oldPid = status.pid;
  oldBirth = ok(await call('pin old daemon process birth', '/bin/ps', ['-p', String(oldPid), '-o', 'pid=,lstart=,comm='])).stdout;
  report.beforeStop = { pid: oldPid, process: oldBirth };
  // Preserve actual sign-in and hosting intent through the post-stop update.
  const connector = join(root, 'available-connector');
  mkdirSync(connector, { mode: 0o700 });
  writeFileSync(join(connector, 'package.json'), JSON.stringify({ name: 'orphan-measurement-fixture', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
  writeFileSync(join(connector, 'index.js'), "import {registry} from '@cotal-ai/core';registry.register({kind:'connector',name:'orphan-measurement-fixture',requires:['node'],buildLaunch(){throw Error('this measurement starts no seats')}});\n");
  ok(await bundled('register available seatless fixture connector', ['ext', 'add', connector]));
  const setup = JSON.parse(ok(await bundled('host real Manager before manual stop', ['daemon', 'setup', '--space', report.participant.space, '--json'])).stdout).result;
  assert.equal(setup.manager.state, 'answering');
  report.manager = { pid: setup.manager.pid, instanceId: setup.manager.instanceId, process: ok(await call('pin old Manager birth', '/bin/ps', ['-p', String(setup.manager.pid), '-o', 'pid=,lstart=,comm='])).stdout };
  const session = join(home, 'idp-sessions.json');
  const sessionBefore = readFileSync(session);
  const { spaceSegment } = await import(pathToFileURL(join(product, 'packages/workspace/dist/index.js')).href);
  const hosting = join(home, 'daemon', spaceSegment(report.participant.space), 'manager-host.json');
  const hostingBefore = readFileSync(hosting);
  ok(await native('manual step bootout exact owned daemon', 'bootout'));
  for (let attempt = 0; attempt < 100; attempt++) {
    const absent = await native('manual step native absence', 'print');
    if (absent.exit === 113) break;
    assert.equal(absent.exit, 0);
    await delay(100);
  }
  assert.equal((await native('manual step final native absence', 'print')).exit, 113);
  assert.equal((await call('manual step daemon process absent', '/bin/ps', ['-p', String(oldPid), '-o', 'pid=,lstart=,comm='])).exit, 1);
  assert.equal((await call('manual step Manager process absent', '/bin/ps', ['-p', String(setup.manager.pid), '-o', 'pid=,lstart=,comm='])).exit, 1);
  const currentApp = statSync(app); assert.equal(currentApp.dev, copied.dev); assert.equal(currentApp.ino, copied.ino);
  rmSync(app, { recursive: true }); copied = undefined;
  assert(!existsSync(bundleNode)); owned();
  report.manualStep = { bootout: true, daemonAbsent: true, managerAbsent: true, programMissing: true, sourceAndReceiptRetained: true };
  const { candidateRegistry } = await import(pathToFileURL(join(product, 'scripts/automatic-update-platform-baseline.mjs')).href);
  registry = await candidateRegistry(closure, 'B', 'https://registry.npmjs.org');
  const updateEnv = { ...env, npm_config_registry: registry.url };
  const update = await call('same public installer CLI update --self after manual step', launcher, ['update', '--self'], updateEnv, 300000);
  report.update = { exit: update.exit, signal: update.signal, timedOut: update.timedOut, stdout: update.stdout, stderr: update.stderr };
  report.signInPreserved = readFileSync(session).equals(sessionBefore);
  report.hostingIntentPreserved = readFileSync(hosting).equals(hostingBefore);
  assert(report.signInPreserved && report.hostingIntentPreserved);
  if (update.exit === 0 && !update.signal && !update.timedOut) {
    const version = ok(await call('public installer version after update', launcher, ['--version'], updateEnv));
    assert.match(version.stdout.split(/\r?\n/, 1)[0], new RegExp(`^cotal-ai ${report.candidate.version.replaceAll('.', '\\.')}\\b`));
    report.outcome = 'update-completed';
  } else {
    report.outcome = 'update-refused-after-manual-step';
    process.exitCode = 1;
  }
} catch (error) { report.outcome = 'setup-or-measurement-failed'; report.error = redact(error.stack ?? error); process.exitCode = 1; }
finally {
  try {
    if (ownership) {
      owned();
      const final = await native('cleanup exact native service observation', 'print');
      if (final.exit === 0) { ok(await native('cleanup exact service bootout', 'bootout')); }
      else assert.equal(final.exit, 113);
      for (let attempt = 0; attempt < 100; attempt++) {
        report.cleanupNative = await native('cleanup final native service absence', 'print');
        if (report.cleanupNative.exit === 113) break;
        assert.equal(report.cleanupNative.exit, 0);
        await delay(100);
      }
      assert.equal(report.cleanupNative.exit, 113);
      for (const pid of [oldPid, report.manager?.pid].filter(Boolean)) {
        const gone = await call(`cleanup pinned process absent ${pid}`, '/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,comm=']);
        assert.equal(gone.exit, 1, 'never remove the owned bundle while one of its pinned processes remains');
      }
    }
    if (copied && existsSync(app)) { const current = statSync(app); assert.equal(current.dev, copied.dev); assert.equal(current.ino, copied.ino); rmSync(app, { recursive: true }); }
  } catch (error) { report.cleanupError = redact(error.stack ?? error); process.exitCode = 1; }
  try { await participantClose?.(); } catch (error) { report.participantCleanupError = redact(error.stack ?? error); process.exitCode = 1; }
  try { if (registry) report.registryRequests = await registry.close(); } catch (error) { report.registryCleanupError = redact(error.stack ?? error); process.exitCode = 1; }
  try {
    const census = ok(await call('final executable census without arguments', '/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm=']));
    report.cleanupOwnedProcessRows = census.stdout.split('\n').filter(line => line.includes(`${app}/`) || line.includes(`${prefix}/`));
    assert.equal(report.cleanupOwnedProcessRows.length, 0, 'owned installer or bundle processes remain after measurement');
  } catch (error) { report.processCleanupError = redact(error.stack ?? error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); save();
  const unsafe = readdirSync(output).some(file => /\bS[UA][A-Z2-7]{56}\b|eyJ[A-Za-z0-9_-]{8,}\.|update-participant-private-test-session/.test(readFileSync(join(output, file), 'utf8')));
  if (!unsafe) writeFileSync(join(root, 'upload-safe'), 'Secret scan passed.\n');
  else { report.artifactRefused = true; process.exitCode = 1; save(); }
}
