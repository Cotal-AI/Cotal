import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EXPECTED_PROJECT_TRUST_ENV,
  EXPECTED_PROJECT_TRUST_MCP,
  EXPECTED_PROJECT_TRUST_OPTION,
  buildStandinClaude,
  expectedTrustRemedy,
  validProjectTrustLaunchRecord,
  validProjectTrustRefusalRecord,
  verifyProjectTrustEvidence,
  SUN_PATH_LIMIT_BYTES,
  HOSTED_CELL_ROOT_BYTES,
  cellControlSocket,
  cellRootLikeSafeRoot,
  cellTempDirectory,
  shortNameSpelling,
  recordedPids,
  waitUntilGone,
} from './project-trust-upgrade.mjs';
import { planRelease, verifyResults } from './upgrade-matrix-plan.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function makeLaunchRecord(mode = 'foreground') {
  return {
    mode,
    env: EXPECTED_PROJECT_TRUST_ENV,
    permissionMode: EXPECTED_PROJECT_TRUST_OPTION,
    mcpServers: ['cotal', 'trustProbe'],
    probe: EXPECTED_PROJECT_TRUST_MCP,
  };
}

function makeRefusalRecord(canonicalRoot, platform) {
  const expectedRemedy = expectedTrustRemedy(canonicalRoot, platform);
  return {
    canonicalRoot,
    expectedRemedy,
    probeExit: 1,
    probeOutput: `project trust refused at ${canonicalRoot}; run \`${expectedRemedy}\``,
    probeLogCreated: false,
    plainExit: 1,
    plainOutput: `project config refused at ${canonicalRoot}; run \`${expectedRemedy}\``,
    plainLogCreated: false,
  };
}

function makeFixture(platform = 'linux', scenario = 'project-trust-migration') {
  const pinned = scenario === 'project-trust-migration-0.182.1';
  const output = mkdtempSync(join(tmpdir(), 'project-trust-evidence-'));
  const rootPrefix = platform === 'win32' ? 'C:\\runner\\work\\projects\\' : '/private/cell/projects/';
  const roots = {
    statusFirst: `${rootPrefix}status-first-registered`,
    spawnFirst: `${rootPrefix}spawn-first-registered`,
    prepStatus: `${rootPrefix}prepared-status-first`,
    prepUp: `${rootPrefix}prepared-up-first`,
    symlinkReal: `${rootPrefix}symlink-real`,
    symlinkLink: `${rootPrefix}symlink-entry`,
    unregPeers: `${rootPrefix}legacy-unreg-with-peers`,
    postUpdate: `${rootPrefix}post-update-created`,
    unregEmpty: `${rootPrefix}legacy-unreg-empty-home`,
  };
  const spawnFirstHome = `${rootPrefix}profiles-spawn-first`;
  const symlinkHome = `${rootPrefix}profiles-symlink`;
  const evidence = {
    platform,
    sourceVersion: pinned ? '0.182.1' : '0.183.0',
    targetVersion: pinned ? '0.183.0' : '0.184.0',
    trustCase: pinned ? 'source-without-trust' : 'source-already-trusted',
    preUpdate: {
      seedAbsentBeforeUpdate: pinned,
      ...(pinned ? {} : { trustUnchanged: true }),
      statusFirst: makeLaunchRecord('foreground'),
      spawnFirst: makeLaunchRecord('foreground'),
      symlink: makeLaunchRecord('foreground'),
      spellings: platform === 'win32'
        ? { platform, canonical: roots.statusFirst, spellings: Object.fromEntries(['driveLower', 'leafUpper', 'trailingSeparator', 'forwardSlash', 'shortName', 'windowsSymlink'].map(name => [name, { ran: true, canonical: roots.statusFirst }])) }
        : { platform, notRun: 'path spellings beyond the symlink run on Windows only' },
    },
    statusFirst: {
      canonicalRoot: roots.statusFirst,
      seedAbsentAfterUpdateBeforeStatus: pinned,
      seedRecordedByStatus: true,
      ...(pinned ? {} : { trustUnchanged: true }),
      trustedRoots: [roots.statusFirst],
      foreground: makeLaunchRecord('foreground'),
      managed: makeLaunchRecord('managed'),
      managedSeatJoined: true,
    },
    spawnFirst: {
      profileHome: spawnFirstHome,
      canonicalRoot: roots.spawnFirst,
      seedAbsentBeforeSpawn: pinned,
      storeAbsentBeforeSpawn: pinned,
      seedRecordedBySpawn: true,
      ...(pinned ? {} : { trustUnchanged: true }),
      trustedRoots: [roots.spawnFirst],
      foreground: makeLaunchRecord('foreground'),
    },
    preparedStatusFirst: {
      canonicalRoot: roots.prepStatus,
      seedAbsentBeforeStatus: pinned,
      seedRecordedByStatus: true,
      ...(pinned ? {} : { trustUnchanged: true }),
      trustedRoots: [roots.prepStatus],
      foreground: makeLaunchRecord('foreground'),
    },
    preparedUpFirst: {
      canonicalRoot: roots.prepUp,
      seedAbsentBeforeUp: pinned,
      seedRecordedByUp: true,
      ...(pinned ? {} : { trustUnchanged: true }),
      trustedRoots: [roots.prepUp],
      foreground: makeLaunchRecord('foreground'),
    },
    symlink: {
      profileHome: symlinkHome,
      linkPath: roots.symlinkLink,
      canonicalRoot: roots.symlinkReal,
      seedAbsentBeforeSpawn: pinned,
      ...(pinned ? {} : { trustUnchanged: true }),
      trustedRoots: [roots.symlinkReal],
      foreground: makeLaunchRecord('foreground'),
    },
    refusals: {
      legacyUnregisteredWithPeers: makeRefusalRecord(roots.unregPeers, platform),
      postUpdateCreated: makeRefusalRecord(roots.postUpdate, platform),
      legacyUnregisteredEmptyHome: makeRefusalRecord(roots.unregEmpty, platform),
    },
    cleanup: { stacksStopped: true },
  };

  const call = (label, argv = [], home = undefined) => ({ label, argv, ...(home ? { home } : {}), exit: 0, signal: null, timeout: false });
  const calls = [
    call('install published source', ['install', '-g', 'cotal-ai@0.182.1']),
    call('project-trust pre-update status-first spawn', ['spawn', '--foreground']),
    call('project-trust pre-update spawn-first spawn', ['spawn', '--foreground'], spawnFirstHome),
    call('project-trust pre-update symlink spawn', ['spawn', '--foreground'], symlinkHome),
    call('upgrade under test', ['update', '--self']),
    call('project-trust status-first status', ['status', '--plain']),
    call('project-trust status-first foreground spawn', ['spawn', '--foreground']),
    call('project-trust status-first managed spawn', ['spawn', '--detach']),
    call('project-trust spawn-first version', ['--version'], spawnFirstHome),
    call('project-trust spawn-first ext seed', ['ext', 'seed'], spawnFirstHome),
    call('project-trust spawn-first foreground spawn', ['spawn', '--foreground'], spawnFirstHome),
    call('project-trust prepared-status-first status', ['status', '--plain']),
    call('project-trust prepared-status-first foreground spawn', ['spawn', '--foreground']),
    call('project-trust prepared-up-first stack up', ['up', '--space', 'prepared']),
    call('project-trust prepared-up-first foreground spawn', ['spawn', '--foreground']),
    call('project-trust symlink version', ['--version'], symlinkHome),
    call('project-trust symlink foreground spawn', ['spawn', '--foreground'], symlinkHome),
  ];

  const artifact = `candidate-B-${platform}-${pinned ? '0.182.1' : '0.183.0'}-npm-configured-self-${scenario}.json`;
  const writeArtifact = value => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    writeFileSync(join(output, artifact), bytes, { mode: 0o600 });
    return { artifact, bytes: bytes.length, sha256: digest(bytes) };
  };
  const projectTrustMigration = writeArtifact(evidence);
  const cell = { scenario, platform, sourceVersion: evidence.sourceVersion, targetVersion: evidence.targetVersion };
  const report = { id: `candidate-B-${platform}-${evidence.sourceVersion}-npm-configured-self`, platform, calls, projectTrustMigration };
  return { output, evidence, report, cell, writeArtifact };
}

test('expectedTrustRemedy matches the product quoting and the launcher on PATH', () => {
  assert.equal(expectedTrustRemedy('/var/tmp/project-a', 'linux'), 'cotal trust /var/tmp/project-a');
  assert.equal(expectedTrustRemedy('C:\\Users\\runneradmin\\project space', 'linux'), 'cotal trust -- "C:\\Users\\runneradmin\\project space"');
  const special = '/var/tmp/project$HOME!';
  assert.equal(expectedTrustRemedy(special, 'linux'), `cotal trust --hex ${Buffer.from(special).toString('hex')}`);
  assert.equal(expectedTrustRemedy('/var/tmp/project-a', 'win32'), 'cotal.cmd trust /var/tmp/project-a');
  assert.equal(expectedTrustRemedy('C:\\Users\\runneradmin\\project space', 'win32'), 'cotal.cmd trust -- "C:\\Users\\runneradmin\\project space"');
  assert.equal(expectedTrustRemedy(special, 'win32'), `cotal.cmd trust --hex ${Buffer.from(special).toString('hex')}`);
});

test('stand-in claude records env, launchOptions and MCP execution cleanly', () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'standin-claude-'));
  try {
    const standin = buildStandinClaude(join(root, 'bin'), 'linux');
    const ver = execFileSync(standin.executable, ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(ver, '2.1.330 (Claude Code)');
    const plugins = execFileSync(standin.executable, ['plugin', 'list', '--json'], { encoding: 'utf8' }).trim();
    assert.equal(plugins, '[]');
    const probeLog = join(root, 'probe.log');
    const mcpCfg = join(root, 'mcp.json');
    writeFileSync(mcpCfg, JSON.stringify({
      mcpServers: {
        cotal: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        trustProbe: { command: process.execPath, args: [standin.probeScript, '$TRUST_PROBE_LOG'] },
      },
    }));
    execFileSync(standin.executable, ['--mcp-config', mcpCfg, '--permission-mode', EXPECTED_PROJECT_TRUST_OPTION], {
      env: { ...process.env, TRUST_PROBE_LOG: probeLog, TRUST_MATRIX_ENV: EXPECTED_PROJECT_TRUST_ENV, TRUST_LAUNCH_MODE: 'foreground' },
      stdio: 'pipe',
    });
    const record = JSON.parse(readFileSync(probeLog, 'utf8').trim());
    assert(validProjectTrustLaunchRecord(record, 'foreground'));
    assert(!validProjectTrustLaunchRecord({ ...record, env: '<absent>' }, 'foreground'));
    assert(!validProjectTrustLaunchRecord({ ...record, permissionMode: '<missing>' }, 'foreground'));
    assert(!validProjectTrustLaunchRecord({ ...record, probe: '<missing>' }, 'foreground'));
    const managedLog = join(root, 'managed-probe.log');
    const broken = { mcpServers: { trustProbe: { command: process.execPath, args: ['-e', 'process.exit(1)'] } } };
    assert.throws(() => execFileSync(standin.executable, ['--mcp-config', JSON.stringify(broken), '--permission-mode', EXPECTED_PROJECT_TRUST_OPTION], {
      env: { ...process.env, TRUST_PROBE_LOG: managedLog, TRUST_MATRIX_ENV: EXPECTED_PROJECT_TRUST_ENV, TRUST_LAUNCH_MODE: 'foreground' },
      stdio: 'pipe',
    }));
    assert.equal(existsSync(managedLog), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyProjectTrustEvidence accepts complete cross-platform evidence and rejects any weakened check', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const scenario of ['project-trust-migration', 'project-trust-migration-0.182.1']) {
      const fx = makeFixture(platform, scenario);
      try {
        assert.deepEqual(verifyProjectTrustEvidence(fx), { 'project-trust-migrated': true });
      } finally {
        rmSync(fx.output, { recursive: true, force: true });
      }
    }
  }

  const swapped = makeFixture('linux', 'project-trust-migration-0.182.1');
  try {
    swapped.cell.scenario = 'project-trust-migration';
    assert.throws(() => verifyProjectTrustEvidence(swapped), /belongs to the pinned cell/);
    swapped.cell.scenario = 'project-trust-migration-0.182.1';
    swapped.evidence.trustCase = 'source-already-trusted';
    swapped.report.projectTrustMigration = swapped.writeArtifact(swapped.evidence);
    assert.throws(() => verifyProjectTrustEvidence(swapped), /source without trust/);
  } finally {
    rmSync(swapped.output, { recursive: true, force: true });
  }

  const corruptions = [
    fx => { fx.evidence.preUpdate.seedAbsentBeforeUpdate = false; },
    fx => { fx.evidence.preUpdate.statusFirst.env = '<absent>'; },
    fx => { fx.evidence.statusFirst.seedAbsentAfterUpdateBeforeStatus = false; },
    fx => { fx.evidence.statusFirst.foreground.permissionMode = '<missing>'; },
    fx => { fx.evidence.statusFirst.managed.probe = '<missing>'; },
    fx => { fx.evidence.statusFirst.managedSeatJoined = false; },
    fx => { fx.evidence.statusFirst.trustedRoots.push(fx.evidence.refusals.legacyUnregisteredWithPeers.canonicalRoot); },
    fx => { fx.evidence.spawnFirst.seedAbsentBeforeSpawn = false; },
    fx => { fx.evidence.spawnFirst.storeAbsentBeforeSpawn = false; },
    fx => { fx.evidence.spawnFirst.foreground.mcpServers = ['cotal']; },
    fx => { fx.evidence.preparedStatusFirst.seedRecordedByStatus = false; },
    fx => { fx.evidence.preparedUpFirst.seedRecordedByUp = false; },
    fx => { fx.evidence.symlink.trustedRoots = [fx.evidence.symlink.linkPath]; },
    fx => { fx.evidence.refusals.legacyUnregisteredWithPeers.probeExit = 0; },
    fx => { fx.evidence.refusals.legacyUnregisteredWithPeers.plainLogCreated = true; },
    fx => { fx.evidence.refusals.postUpdateCreated.probeOutput = 'refused without remedy'; },
    fx => { fx.evidence.refusals.legacyUnregisteredEmptyHome.plainExit = 0; },
    fx => { fx.evidence.cleanup.stacksStopped = false; },
    fx => {
      const idx = fx.report.calls.findIndex(c => c.label === 'project-trust spawn-first foreground spawn');
      fx.report.calls.splice(idx, 0, { label: 'intervening status', argv: ['status'], home: fx.evidence.spawnFirst.profileHome, exit: 0 });
    },
    fx => {
      const s = fx.report.calls.findIndex(c => c.label === 'project-trust status-first status');
      const f = fx.report.calls.findIndex(c => c.label === 'project-trust status-first foreground spawn');
      [fx.report.calls[s], fx.report.calls[f]] = [fx.report.calls[f], fx.report.calls[s]];
    },
  ];

  for (const corrupt of corruptions) {
    const fx = makeFixture('linux', 'project-trust-migration-0.182.1');
    try {
      corrupt(fx);
      fx.report.projectTrustMigration = fx.writeArtifact(fx.evidence);
      assert.throws(() => verifyProjectTrustEvidence(fx));
    } finally {
      rmSync(fx.output, { recursive: true, force: true });
    }
  }

  const tampered = makeFixture('darwin');
  try {
    writeFileSync(join(tampered.output, tampered.report.projectTrustMigration.artifact), '{"tampered":true}\n');
    assert.throws(() => verifyProjectTrustEvidence(tampered));
  } finally {
    rmSync(tampered.output, { recursive: true, force: true });
  }

  const trusted = makeFixture('linux', 'project-trust-migration');
  try {
    assert.deepEqual(verifyProjectTrustEvidence(trusted), { 'project-trust-migrated': true });
    trusted.evidence.statusFirst.trustUnchanged = false;
    trusted.report.projectTrustMigration = trusted.writeArtifact(trusted.evidence);
    assert.throws(() => verifyProjectTrustEvidence(trusted));
  } finally {
    rmSync(trusted.output, { recursive: true, force: true });
  }
});

test('the control socket follows the cell temp directory and stays under the hosted limit', () => {
  const parents = { linux: '/home/runner/work/_temp', darwin: '/Users/runner/work/_temp' };
  const leaf = 'rG0DwP';
  for (const [platform, limit] of Object.entries(SUN_PATH_LIMIT_BYTES)) {
    const root = cellRootLikeSafeRoot(parents[platform], leaf);
    assert.equal(root, `${parents[platform]}/cell-${leaf}`);
    assert.equal(Buffer.byteLength(root), HOSTED_CELL_ROOT_BYTES[platform]);
    const temp = cellTempDirectory(root);
    assert.equal(temp, `${root}/tmp`);
    const socket = cellControlSocket(root);
    assert.equal(socket, `${temp}/cotal-ctl-${'a'.repeat(22)}/ctl.sock`);
    const bytes = Buffer.byteLength(socket);
    assert(bytes <= limit, `${platform} hosted socket is ${bytes}, over ${limit}`);
  }
  const darwin = cellRootLikeSafeRoot(parents.darwin, leaf);
  assert.equal(SUN_PATH_LIMIT_BYTES.darwin - Buffer.byteLength(cellControlSocket(darwin)), 22);
  const perProfile = `${cellRootLikeSafeRoot(parents.linux, leaf)}/project-trust/profiles/primary`;
  assert(Buffer.byteLength(cellControlSocket(perProfile)) > SUN_PATH_LIMIT_BYTES.linux, 'a per-profile temp would exceed the limit');
});

test('the 8.3 short name is asked for without quotes around the path', async () => {
  const canonical = 'D:\\a\\_temp\\cell-wy2qla\\status-first-registered';
  const seen = [];
  const resolved = await shortNameSpelling(canonical, (file, args) => {
    seen.push([file, args]);
    return 'D:\\a\\_temp\\CELL-W~1\\STATUS~1\n';
  });
  assert.deepEqual(seen, [['cmd', ['/c', `for %I in (${canonical}) do @echo %~sI`]]]);
  assert.equal(seen[0][1][1].includes('"'), false);
  assert.equal(resolved.ran, false);
  assert.match(resolved.reason, /ENOENT|no 8\.3 short name/);
});

test('cleanup reads the seat pid the stand-in records in the space root', () => {
  const root = mkdtempSync(join(tmpdir(), 'standin-seat-'));
  try {
    mkdirSync(join(root, '.cotal'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, '.cotal', 'standin-seat.pid'), '4321\n', { mode: 0o600 });
    writeFileSync(join(root, '.cotal', 'manager.ab12.pid'), '4322 1\n', { mode: 0o600 });
    writeFileSync(join(root, '.cotal', 'other.pid'), '9999\n', { mode: 0o600 });
    assert.deepEqual(recordedPids(root).sort(), [4321, 4322]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup is not done while a recorded process is still alive', async () => {
  let checks = 0;
  let clock = 0;
  await assert.rejects(
    () => waitUntilGone([4321], () => { checks += 1; return false; }, () => { clock += 200; return Promise.resolve(); }, () => clock),
    /owned processes still running: 4321/,
  );
  assert(checks > 1, 'the wait retried instead of trusting the stop command');
  let seen = false;
  clock = 0;
  await waitUntilGone([4321], () => { const gone = seen; seen = true; return gone; }, () => { clock += 200; return Promise.resolve(); }, () => clock);
});

test('both phases require Linux, macOS and Windows project-trust-migration cells', () => {
  for (const phase of ['candidate', 'published']) {
    const plan = planRelease(
      { inputs: { phase, source_sha: 'a'.repeat(40), target_version: '0.183.0', profile: 'bounded' } },
      { eventName: 'workflow_dispatch', sourceVersion: '0.182.1' },
    );
    const cells = plan.cells.filter(c => c.scenario === 'project-trust-migration' || c.scenario === 'project-trust-migration-0.182.1');
    assert.deepEqual(cells.filter(c => c.scenario === 'project-trust-migration').map(c => c.platform), ['linux', 'darwin', 'win32']);
    assert.deepEqual(cells.filter(c => c.pinnedTrustSource).map(c => [c.platform, c.sourceVersion]), [['linux', '0.182.1'], ['darwin', '0.182.1'], ['win32', '0.182.1']]);
    for (const cell of cells) {
      assert.equal(cell.channel, 'npm');
      assert.equal(cell.required, true);
      assert(cell.requiredAssertions.includes('project-trust-migrated'));
      const good = plan.cells.filter(c => c.required).map(c => ({
        id: c.id,
        status: 'passed',
        assertions: Object.fromEntries(c.requiredAssertions.map(a => [a, true])),
      }));
      assert.equal(verifyResults(plan.cells, good).acceptance, true);
      delete good.find(r => r.id === cell.id).assertions['project-trust-migrated'];
      assert.equal(verifyResults(plan.cells, good).acceptance, false);
    }
  }
});
