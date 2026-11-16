import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { candidatePairRegistry } from './candidate-pair-registry.mjs';
import { configureCandidateRegistry, runDiagnosticCommand } from './automatic-update-platform-baseline.mjs';
import { inspectInstalledUpdateRoute } from './daemon-cell-diagnostics.mjs';
import { archiveInventory, buildFaultCandidate, hash6385, source6385 } from './6385-fault-candidate.mjs';
import { isMainEntry } from './main-entry.mjs';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export function hostedGuard({ env = process.env, platform = process.platform, uid = process.getuid?.(), home = homedir(), os = readFileSync('/etc/os-release', 'utf8') } = {}) {
  assert(platform === 'linux' && uid > 0, 'requires nonroot Linux');
  assert(/^ID=ubuntu$/m.test(os), 'requires hosted Ubuntu');
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted', 'requires disposable GitHub-hosted runner, never a laptop or self-hosted runner');
  assert(env.RUNNER_TEMP && env.XDG_RUNTIME_DIR === `/run/user/${uid}`, 'requires dedicated user manager runtime');
  assert(home !== '/' && lstatSync(home).isDirectory() && !lstatSync(home).isSymbolicLink(), 'requires real dedicated user home');
  for (const key of Object.keys(env)) assert(!key.startsWith('COTAL_'), `refuse inherited ${key}`);
}
export function ageSchedulerClocks(check, attempt, target, now = Date.now()) {
  assert.equal(check.latest, target, 'scheduler must learn C before aging clocks');
  assert(Number.isFinite(check.firstSeenAt), 'real firstSeenAt required');
  const aged = now - 25 * 3600000;
  return { check: { ...check, checkedAt: aged, firstSeenAt: aged, attemptedAt: aged }, ...(attempt ? { attempt: { ...attempt, next: aged } } : {}) };
}
export function readRecords(home, config) {
  const records = {};
  for (const name of ['update-check.json', 'update-attempt.json', 'update-recovery.json', 'update-attempt.log', 'daemon/service-unit.json', 'daemon/daemon.log']) {
    const file = join(home, name);
    records[name] = existsSync(file) ? { exists: true, sha256: hash6385(readFileSync(file)), text: readFileSync(file, 'utf8') } : { exists: false };
  }
  records.snapshots = existsSync(config) ? readdirSync(config).filter(name => name.startsWith('.update-snapshot-')).map(name => ({ name, exists: true, directory: lstatSync(join(config, name)).isDirectory() })) : [];
  const recovery = records['update-recovery.json'];
  if (recovery.exists) {
    const path = JSON.parse(recovery.text).snapshot;
    records.recoverySnapshot = { path, exists: typeof path === 'string' && existsSync(path) };
  }
  return records;
}
export async function verifyClosure(directory, version) {
  const manifest = json(join(directory, 'manifest.json'));
  assert.equal(manifest.source, source6385, 'only approved source accepted');
  assert(Array.isArray(manifest.prepublishOnly) && manifest.prepublishOnly.length, 'normal guarded pack required');
  for (const pkg of manifest.packages) {
    assert.equal(pkg.version, version);
    assert.match(pkg.archive, /^[^/\\]+\.tgz$/);
    const archive = join(directory, pkg.archive);
    assert.equal(hash6385(readFileSync(archive)), pkg.sha256);
    assert.deepEqual(await archiveInventory(archive), pkg.files);
  }
  return manifest;
}

export async function reproduce6385(options) {
  assert.deepEqual(Object.keys(options).sort(), ['candidate', 'candidate-next', 'fault', 'output']);
  assert(['exit', 'hang'].includes(options.fault));
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const report = { schema: 1, source: source6385, fault: options.fault, tier: 'synthetic package fault, real native scheduler', startedAt: new Date().toISOString(), calls: [], observations: [] };
  const reportFile = join(output, 'report.json');
  let registry, restoreRegistry, owned, receipt, env, cli, project;
  const persist = () => save(reportFile, report);
  async function run(file, argv, timeoutMs = 15000) {
    const result = await runDiagnosticCommand(file, argv, { cwd: project, env, timeoutMs });
    report.calls.push({ file, argv, ...result }); persist();
    return result;
  }
  const cotal = argv => run(process.execPath, [cli, ...argv]);
  const ok = result => { assert.equal(result.exit, 0, JSON.stringify(result)); assert(!result.timeout); return result; };
  try {
    hostedGuard();
    const home = realpathSync(homedir());
    const cotalHome = join(home, '.cotal'), config = join(home, '.config/cotal');
    assert(!existsSync(cotalHome) && !existsSync(config), 'dedicated fresh account required before mutation');
    ok(await run('systemctl', ['--user', '--no-ask-password', '--no-pager', 'show', '--property=Version']));
    const source = await verifyClosure(resolve(options.candidate), '0.164.18');
    const target = await verifyClosure(resolve(options['candidate-next']), '0.164.1018');
    assert(!source.testFault && !target.testFault, 'inputs must be unmodified normal guarded candidates');
    report.inputManifests = { B: hash6385(readFileSync(join(options.candidate, 'manifest.json'))), C: hash6385(readFileSync(join(options['candidate-next'], 'manifest.json'))) };
    report.faultCandidate = await buildFaultCandidate(options['candidate-next'], join(output, 'fault-candidate'), options.fault);
    const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'repro-6385-'));
    assert.equal(lstatSync(root).mode & 0o777, 0o700, 'private harness root required');
    report.root = root;
    const prefix = join(root, 'prefix'); project = join(root, 'project');
    mkdirSync(project, { mode: 0o700 });
    env = { ...process.env, HOME: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), NO_COLOR: '1', DO_NOT_TRACK: '1' };
    registry = await candidatePairRegistry(resolve(options.candidate), join(output, 'fault-candidate'));
    report.registry = registry.identity;
    env.npm_config_registry = registry.url;
    restoreRegistry = configureCandidateRegistry(home, registry.url);
    ok(await run('npm', ['install', '-g', '--prefix', prefix, 'cotal-ai@0.164.18', '--no-audit', '--no-fund'], 600000));
    const pkg = join(prefix, 'lib/node_modules/cotal-ai');
    cli = join(pkg, 'dist/cotal.js');
    env.PATH = `${join(prefix, 'bin')}:${env.PATH}`;
    ok(await cotal(['ext', 'seed']));
    ok(await cotal(['update', '--auto', 'on']));
    const plan = JSON.parse(ok(await cotal(['daemon', 'install', '--dry-run', '--json'])).stdout).result;
    assert.equal(plan.state, 'would-install');
    assert(plan.unitPath && !existsSync(plan.unitPath), 'must own a new native service');
    report.plan = plan;
    // Set ownership before install so a partial native installation also reaches uninstall.
    owned = true;
    registry.activateTarget();
    report.targetActivatedAt = Date.now(); persist();
    ok(await cotal(['daemon', 'install', '--json']));
    const daemonHome = plan.daemonHome ?? join(cotalHome, 'daemon');
    receipt = json(join(daemonHome, 'service-unit.json'));
    assert.equal(receipt.unit, plan.unit);
    assert.equal(receipt.unitSha256, hash6385(readFileSync(plan.unitPath)));
    report.receipt = receipt;
    async function snapshot(stage, commands = false) {
      // Persist filesystem evidence before invoking any CLI that might reconcile recovery.
      const observation = { stage, at: Date.now(), records: readRecords(cotalHome, config) };
      const store = join(prefix, 'lib/node_modules/.cotal-generations');
      observation.executionJournals = existsSync(store) ? readdirSync(store).filter(name => name.startsWith('.transaction-')).map(name => {
        const file = join(store, name, 'execution.json');
        return { path: file, exists: existsSync(file), ...(existsSync(file) ? { sha256: hash6385(readFileSync(file)), text: readFileSync(file, 'utf8') } : {}) };
      }) : [];
      try { observation.installed = inspectInstalledUpdateRoute(pkg, 'linux'); }
      catch (error) { observation.installedError = error.message; }
      report.observations.push(observation); persist();
      observation.unit = await run('systemctl', ['--user', '--no-ask-password', '--no-pager', 'show', receipt.unit, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainCode,ExecMainStatus,NRestarts']);
      observation.journal = await run('journalctl', ['--user', '--no-pager', '-u', receipt.unit, '--since', report.startedAt, '-n', '150']);
      observation.mainPid = Number(/^MainPID=(\d+)$/m.exec(observation.unit.stdout)?.[1]);
      observation.daemon = await cotal(['daemon', 'status', '--json']);
      if (commands) {
        observation.status = await cotal(['status']);
        observation.update = await cotal(['update']);
      }
      persist(); return observation;
    }
    const readyDeadline = Date.now() + 120000;
    let before;
    while (Date.now() < readyDeadline) {
      const status = await cotal(['daemon', 'status', '--json']);
      if (status.exit === 0) {
        const value = JSON.parse(status.stdout).result;
        if (value.state === 'ready' && value.version === '0.164.18' && value.update?.automatic === true) { before = value; break; }
      }
      await delay(2000);
    }
    assert(before, 'B native scheduler must be ready and eligible');
    report.daemonBefore = before;
    // Only the daemon's real scheduler learns latest. No check RPC or daemon restart.
    const learningDeadline = Date.now() + 180000;
    let learned;
    while (Date.now() < learningDeadline) {
      if (existsSync(join(cotalHome, 'update-check.json'))) {
        const check = json(join(cotalHome, 'update-check.json'));
        if (check.latest === registry.identity.targetVersion) { learned = check; break; }
      }
      await delay(2000);
    }
    assert(learned, 'normal scheduler must learn C');
    const learnedStatus = JSON.parse(ok(await cotal(['daemon', 'status', '--json'])).stdout).result;
    assert.equal(learnedStatus.pid, before.pid, 'no restart allowed before trigger');
    report.learned = learned;
    await snapshot('before-clock-aging');
    const attemptFile = join(cotalHome, 'update-attempt.json');
    const aged = ageSchedulerClocks(learned, existsSync(attemptFile) ? json(attemptFile) : undefined, registry.identity.targetVersion);
    report.clockChange = aged; persist();
    save(join(cotalHome, 'update-check.json'), aged.check);
    if (aged.attempt) save(attemptFile, aged.attempt);
    const deadline = Date.now() + 360000;
    report.observationDeadline = deadline;
    let successAt;
    while (Date.now() < deadline) {
      const observation = await snapshot('scheduler-observation');
      const attempt = observation.records['update-attempt.json'];
      if (attempt.exists && /^(?:repaired and )?updated to 0\.164\.1018$/.test(JSON.parse(attempt.text).result)) successAt ??= Date.now();
      // Observe genuine failure/hang for a full minute after the updater records success.
      if (successAt && Date.now() - successAt >= 60000) break;
      await delay(5000);
    }
    report.successRecordedAt = successAt;
    const final = await snapshot('after-scheduler-before-update-command', true);
    await snapshot('after-manual-update-command');
    report.schedulerRecordedSuccess = Boolean(successAt);
    report.targetSelected = final.installed?.selectedCliVersion === registry.identity.targetVersion;
    let daemon;
    try { daemon = JSON.parse(final.daemon.stdout).result; } catch { /* raw refusal retained */ }
    report.targetReady = daemon?.state === 'ready' && daemon?.version === registry.identity.targetVersion;
    const afterSuccess = report.observations.filter(row => row.at >= successAt);
    report.faultObserved = options.fault === 'hang'
      ? afterSuccess.filter(row => row.mainPid > 1 && row.daemon?.exit !== 0 && row.journal?.stdout.includes('6385 test-package hang reached before serveDaemon')).length >= 2
      : afterSuccess.some(row => row.journal?.stdout.includes('6385 test-package exit reached before serveDaemon') && (/ExecMainStatus=86(?:\n|$)/.test(row.unit?.stdout ?? '') || /status=86/.test(row.journal?.stdout ?? '')));
    report.reproduced = report.schedulerRecordedSuccess && report.targetSelected && !report.targetReady && report.faultObserved;
    report.result = report.reproduced ? 'reproduced' : 'not-reproduced';
  } catch (error) {
    report.result = 'blocked'; report.error = error.stack;
  } finally {
    persist();
    if (owned && cli) {
      try {
        if (receipt) {
          const current = json(join(report.plan.daemonHome ?? join(homedir(), '.cotal/daemon'), 'service-unit.json'));
          assert.equal(current.unit, receipt.unit);
          assert.equal(current.unitPath, receipt.unitPath);
          assert.equal(hash6385(readFileSync(current.unitPath)), current.unitSha256);
        }
        report.uninstall = await run(process.execPath, [cli, 'daemon', 'uninstall', '--yes', '--json'], 180000);
        ok(report.uninstall);
        assert(!existsSync(report.plan.unitPath), 'native unit must be removed');
        report.cleanup = 'native uninstall confirmed';
      } catch (error) { report.cleanupError = error.message; }
    }
    if (restoreRegistry) { try { restoreRegistry(); } catch (error) { report.registryRestoreError = error.message; } }
    if (registry) report.registryRequests = await registry.close();
    report.finishedAt = new Date().toISOString(); persist();
    writeFileSync(join(output, 'report.sha256'), `${hash6385(readFileSync(reportFile))}  report.json\n`);
  }
  return report;
}

if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2), options = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert(argv[i].startsWith('--') && argv[i + 1], 'use --name value');
    assert(!Object.hasOwn(options, argv[i].slice(2)), 'duplicate option');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const report = await reproduce6385(options);
  console.log(JSON.stringify({ result: report.result, cleanup: report.cleanup, output: resolve(options.output) }));
  process.exitCode = report.reproduced && report.cleanup === 'native uninstall confirmed' && !report.registryRestoreError ? 0 : 1;
}
