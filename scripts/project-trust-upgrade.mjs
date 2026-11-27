import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from './upgrade-matrix-plan.mjs';

const FIRST_TRUST_RELEASE = '0.183.0';

export const EXPECTED_PROJECT_TRUST_ENV = 'forwarded-project-env-10672';
export const EXPECTED_PROJECT_TRUST_OPTION = 'default';
export const EXPECTED_PROJECT_TRUST_MCP = 'MCP ran';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

// The product builds the command in trustProjectCommand, then displayProjectTrustFailure swaps the
// leading `cotal` for the launcher on PATH. An npm install on Windows resolves that to cotal.cmd.
export function expectedTrustRemedy(canonicalRoot, platform = process.platform) {
  const launcher = platform === 'win32' ? 'cotal.cmd' : 'cotal';
  const command = /^[A-Za-z0-9_./:-]+$/.test(canonicalRoot) && !canonicalRoot.startsWith('-')
    ? `cotal trust ${canonicalRoot}`
    : /^[A-Za-z0-9_./:\\ -]+$/.test(canonicalRoot) && !/\\\\|\\$/.test(canonicalRoot)
      ? `cotal trust -- "${canonicalRoot}"`
      : `cotal trust --hex ${Buffer.from(canonicalRoot, 'utf8').toString('hex')}`;
  return `${launcher}${command.slice('cotal'.length)}`;
}

export function buildStandinClaude(binDir, platform = process.platform) {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const probeScript = join(binDir, 'probe-mcp.cjs');
  writeFileSync(probeScript, [
    'const fs = require("node:fs");',
    `fs.appendFileSync(process.argv[2], ${JSON.stringify(EXPECTED_PROJECT_TRUST_MCP + '\n')});`,
  ].join('\n') + '\n', { mode: 0o600 });

  const hostScript = join(binDir, 'standin-claude.cjs');
  writeFileSync(hostScript, [
    'const fs = require("node:fs");',
    'const { join } = require("node:path");',
    'const { spawn, spawnSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("2.1.330 (Claude Code)"); process.exit(0); }',
    'if (args[0] === "plugin") { console.log("[]"); process.exit(0); }',
    'const arg = (name) => {',
    '  const idx = args.indexOf(name);',
    '  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "<missing>";',
    '};',
    'const report = process.env.TRUST_PROBE_LOG;',
    'if (!report) throw new Error("missing TRUST_PROBE_LOG");',
    'const raw = arg("--mcp-config");',
    'const cfg = raw === "<missing>" ? {} : JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw);',
    'const servers = cfg.mcpServers || {};',
    'const probe = servers.trustProbe;',
    'if (probe && probe.command) {',
    '  const probeArgs = (probe.args || []).map((arg) => arg === "$TRUST_PROBE_LOG" ? report : arg);',
    '  const res = spawnSync(probe.command, probeArgs, { stdio: "inherit", windowsHide: true });',
    '  if (res.status !== 0) process.exit(res.status || 1);',
    '}',
    'const record = {',
    '  mode: process.env.TRUST_LAUNCH_MODE || "foreground",',
    '  env: process.env.TRUST_MATRIX_ENV ?? "<absent>",',
    '  permissionMode: arg("--permission-mode"),',
    '  mcpServers: Object.keys(servers).sort(),',
    '  probe: fs.existsSync(report) ? fs.readFileSync(report, "utf8").trim() : "<missing>",',
    '};',
    'fs.writeFileSync(report, JSON.stringify(record) + "\\n", { mode: 0o600 });',
    'if (process.env.TRUST_LAUNCH_MODE === "managed") {',
    '  let seat = null;',
    '  if (servers.cotal && servers.cotal.command) {',
    '    seat = spawn(servers.cotal.command, servers.cotal.args || [], {',
    '      env: { ...process.env, ...(servers.cotal.env || {}) },',
    '      stdio: ["pipe", "pipe", "pipe"],',
    '      windowsHide: true,',
    '    });',
    '    seat.on("error", () => {});',
    '    const seatPid = join(process.cwd(), ".cotal", "standin-seat.pid");',
    '    fs.mkdirSync(join(process.cwd(), ".cotal"), { recursive: true });',
    '    fs.writeFileSync(seatPid, String(seat.pid) + "\\n", { mode: 0o600 });',
    '  }',
    '  console.log("? for shortcuts");',
    '  const keepAlive = setInterval(() => {}, 1000);',
    '  const finish = () => {',
    '    clearInterval(keepAlive);',
    '    if (seat && !seat.killed) { try { seat.kill(); } catch {} }',
    '    process.exit(0);',
    '  };',
    '  process.on("SIGINT", finish);',
    '  process.on("SIGTERM", finish);',
    '}',
  ].join('\n') + '\n', { mode: 0o600 });

  if (platform === 'win32') {
    const framework = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET\\Framework64\\v4.0.30319');
    const csc = join(framework, 'csc.exe');
    assert(existsSync(csc), `Windows C# compiler absent: ${csc}`);
    const csSource = join(binDir, 'claude-shim.cs');
    const exePath = join(binDir, 'claude.exe');
    const escapeCs = value => JSON.stringify(String(value));
    writeFileSync(csSource, [
      'using System;',
      'using System.Diagnostics;',
      'using System.Text;',
      'class Program {',
      '  static string Quote(string arg) {',
      '    if (arg.Length > 0 && arg.IndexOfAny(new char[] { \' \', \'\\t\', \'\\n\', \'\\v\', \'"\' }) < 0) return arg;',
      '    var sb = new StringBuilder(\'"\');',
      '    int bs = 0;',
      '    foreach (char c in arg) {',
      '      if (c == \'\\\\\') bs++;',
      '      else if (c == \'"\') { sb.Append(\'\\\\\', bs * 2 + 1); sb.Append(\'"\'); bs = 0; }',
      '      else { if (bs > 0) { sb.Append(\'\\\\\', bs); bs = 0; } sb.Append(c); }',
      '    }',
      '    if (bs > 0) sb.Append(\'\\\\\', bs * 2);',
      '    sb.Append(\'"\');',
      '    return sb.ToString();',
      '  }',
      '  static int Main(string[] args) {',
      '    var sb = new StringBuilder();',
      `    sb.Append(Quote(${escapeCs(hostScript)}));`,
      '    foreach (string a in args) { sb.Append(\' \'); sb.Append(Quote(a)); }',
      '    var psi = new ProcessStartInfo {',
      `      FileName = ${escapeCs(process.execPath)},`,
      '      Arguments = sb.ToString(),',
      '      UseShellExecute = false,',
      '    };',
      '    using (var p = Process.Start(psi)) {',
      '      p.WaitForExit();',
      '      return p.ExitCode;',
      '    }',
      '  }',
      '}',
    ].join('\r\n') + '\r\n', { mode: 0o600 });
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${exePath}`, csSource], { stdio: 'pipe', windowsHide: true });
    assert(existsSync(exePath), 'compiled Windows claude.exe missing');
    return { binDir, executable: exePath, probeScript };
  }

  const executable = join(binDir, 'claude');
  writeFileSync(executable, `#!${process.execPath}\nrequire(${JSON.stringify(hostScript)});\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { binDir, executable, probeScript };
}

function writeTrustedProjectFiles(projectDir, probeScript) {
  mkdirSync(join(projectDir, '.cotal', 'agents'), { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, '.cotal', 'agents', 'probe.md'), [
    '---',
    'name: probe',
    'role: worker',
    'model: claude-opus-5-5',
    'launchOptions:',
    `  permission-mode: ${EXPECTED_PROJECT_TRUST_OPTION}`,
    '---',
    'Record the launch settings.',
  ].join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(projectDir, '.cotal', 'agents', 'plain.md'), [
    '---',
    'name: plain',
    'role: worker',
    'model: claude-opus-5-5',
    '---',
    'Record config-only settings.',
  ].join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(projectDir, '.cotal', 'config.json'), JSON.stringify({
    spawn: { env: ['TRUST_MATRIX_ENV', 'TRUST_PROBE_LOG', 'TRUST_LAUNCH_MODE'] },
    connectors: {
      claude: {
        mcpServers: {
          trustProbe: { command: process.execPath, args: [probeScript, '$TRUST_PROBE_LOG'] },
        },
      },
    },
  }, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
    mcpServers: { cotal: { command: 'cotal', args: [] } },
  }, null, 2) + '\n', { mode: 0o600 });
}

// The connector binds tmpdir()/cotal-ctl-<22>/ctl.sock (controlEndpoint in
// extensions/connector-core/src/runtime.ts). The cell sets TMPDIR to
// join(root, 'tmp') and every profile reuses that directory, so the socket is
// that temp directory plus the 22-character id and ctl.sock. sun_path holds 108
// on Linux and 104 on macOS. The hosted roots that produced the first evidence
// are 35 bytes on Linux and 36 on macOS, so the macOS socket is 82.
export const SUN_PATH_LIMIT_BYTES = { linux: 108, darwin: 104 };
export const HOSTED_CELL_ROOT_BYTES = { linux: 35, darwin: 36 };
const CONTROL_SOCKET_ID_BYTES = 22;
const CONTROL_SOCKET_NAME = 'ctl.sock';

export function cellRootLikeSafeRoot(parent, leaf) {
  return join(parent, `cell-${leaf}`);
}

export function cellTempDirectory(cellRoot) {
  return join(cellRoot, 'tmp');
}

export function cellControlSocket(cellRoot) {
  const temp = cellTempDirectory(cellRoot);
  return join(temp, `cotal-ctl-${'a'.repeat(CONTROL_SOCKET_ID_BYTES)}`, CONTROL_SOCKET_NAME);
}

function buildIsolatedProfile(baseEnv, profileRoot, binDir, tmp) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) if (key.startsWith('COTAL_') && key !== 'COTAL_ALLOW_CHECKOUT_SEED') delete env[key];
  const home = join(profileRoot, 'home');
  const cotalHome = join(profileRoot, 'state');
  const xdgConfig = join(profileRoot, 'config');
  const xdgData = join(profileRoot, 'data');
  const xdgCache = join(profileRoot, 'cache');
  const xdgState = join(profileRoot, 'xdg-state');
  const runtimeDir = join(profileRoot, 'runtime');
  const localAppData = join(home, 'AppData', 'Local');
  const appData = join(home, 'AppData', 'Roaming');
  for (const dir of [profileRoot, home, cotalHome, xdgConfig, xdgData, xdgCache, xdgState, runtimeDir, tmp, localAppData, appData]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ''}`;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    COTAL_HOME: cotalHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    XDG_RUNTIME_DIR: runtimeDir,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    COTAL_TELEMETRY: 'off',
    COTAL_NO_PROMPT: '1',
    COTAL_NO_UPDATE_CHECK: '1',
    DO_NOT_TRACK: '1',
    NO_COLOR: '1',
    TRUST_MATRIX_ENV: EXPECTED_PROJECT_TRUST_ENV,
  });
  return {
    env,
    home,
    cotalHome,
    configDir: join(xdgConfig, 'cotal'),
    seedPath: join(cotalHome, 'trusted-projects-seed.json'),
    storePath: join(xdgConfig, 'cotal', 'trusted-projects.json'),
  };
}

export function validProjectTrustLaunchRecord(record, expectedMode = 'foreground') {
  return Boolean(record)
    && record.mode === expectedMode
    && record.env === EXPECTED_PROJECT_TRUST_ENV
    && record.permissionMode === EXPECTED_PROJECT_TRUST_OPTION
    && Array.isArray(record.mcpServers)
    && record.mcpServers.includes('cotal')
    && record.mcpServers.includes('trustProbe')
    && record.probe === EXPECTED_PROJECT_TRUST_MCP;
}

export function validProjectTrustRefusalRecord(refusal, platform = process.platform) {
  return Boolean(refusal)
    && typeof refusal.canonicalRoot === 'string' && refusal.canonicalRoot.length > 0
    && typeof refusal.expectedRemedy === 'string' && refusal.expectedRemedy === expectedTrustRemedy(refusal.canonicalRoot, platform)
    && Number.isInteger(refusal.probeExit) && refusal.probeExit !== 0
    && Number.isInteger(refusal.plainExit) && refusal.plainExit !== 0
    && typeof refusal.probeOutput === 'string' && refusal.probeOutput.includes(refusal.expectedRemedy) && refusal.probeOutput.includes(refusal.canonicalRoot)
    && typeof refusal.plainOutput === 'string' && refusal.plainOutput.includes(refusal.expectedRemedy) && refusal.plainOutput.includes(refusal.canonicalRoot)
    && refusal.probeLogCreated === false
    && refusal.plainLogCreated === false;
}

function trustSnapshot(seedPath, storePath) {
  if (!existsSync(seedPath) || !existsSync(storePath)) return null;
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const roots = [...store.roots].sort();
  assert(seed.completedAt !== undefined && roots.length > 0, 'a present trust seed must be complete and name roots');
  return { seed, roots };
}

function sameRoots(snapshot, seedPath, storePath) {
  const again = trustSnapshot(seedPath, storePath);
  return again !== null
    && again.seed.completedAt === snapshot.seed.completedAt
    && again.seed.attemptedAt === snapshot.seed.attemptedAt
    && again.roots.length === snapshot.roots.length
    && again.roots.every((root, index) => root === snapshot.roots[index]);
}

function assertTrustProfile(data, name, sourceAlreadyTrusted, absentKey, recordedKey) {
  const section = data[name];
  assert.equal(section?.[absentKey], !sourceAlreadyTrusted);
  assert.equal(section?.[recordedKey], true);
  assert.equal(section?.trustUnchanged, sourceAlreadyTrusted ? true : undefined);
  assert(Array.isArray(section?.trustedRoots) && section.trustedRoots.includes(section.canonicalRoot), `${name} root missing from trusted store`);
  assert(validProjectTrustLaunchRecord(section?.foreground, 'foreground'), `invalid ${name} launch`);
}

const PROJECT_TRUST_SCENARIOS = ['project-trust-migration', 'project-trust-migration-0.182.1'];
const PINNED_TRUST_SOURCE = '0.182.1';

export function verifyProjectTrustEvidence({ report, cell, output }) {
  assert(PROJECT_TRUST_SCENARIOS.includes(cell.scenario), `unexpected project trust scenario ${cell.scenario}`);
  assert(['linux', 'darwin', 'win32'].includes(cell.platform));
  assert.equal(report.platform, cell.platform);
  const meta = report.projectTrustMigration;
  assert(meta && typeof meta === 'object', 'missing projectTrustMigration summary on report');
  assert.equal(typeof meta.artifact, 'string');
  assert.match(meta.sha256 ?? '', /^[a-f0-9]{64}$/);
  const raw = readFileSync(join(output, meta.artifact));
  assert.equal(raw.length, meta.bytes);
  assert.equal(digest(raw), meta.sha256, 'project-trust-migration artifact hash mismatch');
  const data = JSON.parse(raw.toString('utf8'));
  assert.equal(data.platform, cell.platform);
  assert.equal(data.sourceVersion, cell.sourceVersion);
  assert.equal(data.targetVersion, cell.targetVersion);

  const updateIndex = report.calls.findIndex(call => call.label === 'upgrade under test' && call.exit === 0);
  assert(updateIndex > 0, 'missing successful upgrade under test call');
  const preLabels = [
    'project-trust pre-update status-first spawn',
    'project-trust pre-update spawn-first spawn',
    'project-trust pre-update symlink spawn',
  ];
  for (const label of preLabels) {
    const idx = report.calls.findIndex(call => call.label === label && call.exit === 0);
    assert(idx >= 0 && idx < updateIndex, `missing pre-update call before upgrade: ${label}`);
  }
  const postLabels = [
    'project-trust status-first status',
    'project-trust status-first foreground spawn',
    'project-trust status-first managed spawn',
    'project-trust spawn-first foreground spawn',
    'project-trust prepared-status-first status',
    'project-trust prepared-status-first foreground spawn',
    'project-trust prepared-up-first stack up',
    'project-trust prepared-up-first foreground spawn',
    'project-trust symlink foreground spawn',
  ];
  for (const label of postLabels) {
    const idx = report.calls.findIndex(call => call.label === label && call.exit === 0);
    assert(idx > updateIndex, `missing post-update call after upgrade: ${label}`);
  }
  const statusIdx = report.calls.findIndex(call => call.label === 'project-trust status-first status' && call.exit === 0);
  const statusFgIdx = report.calls.findIndex(call => call.label === 'project-trust status-first foreground spawn' && call.exit === 0);
  assert(statusIdx < statusFgIdx, 'status-first status must precede status-first spawn');

  // Verify spawn-first and symlink profiles never ran status, space add/create, or up between upgrade and their first spawn.
  const spawnFirstIdx = report.calls.findIndex(call => call.label === 'project-trust spawn-first foreground spawn' && call.exit === 0);
  const spawnFirstHome = data.spawnFirst?.profileHome;
  assert(typeof spawnFirstHome === 'string' && spawnFirstHome.length > 0, 'missing spawnFirst profileHome');
  const interveningSpawnFirst = report.calls.slice(updateIndex + 1, spawnFirstIdx).filter(call => call.home === spawnFirstHome);
  assert(
    interveningSpawnFirst.every(call => Array.isArray(call.argv) && (call.argv.includes('--version') || (call.argv.includes('ext') && call.argv.includes('seed')))),
    'spawn-first profile ran a trust-migrating command before spawn',
  );

  const symlinkSpawnIdx = report.calls.findIndex(call => call.label === 'project-trust symlink foreground spawn' && call.exit === 0);
  const symlinkHome = data.symlink?.profileHome;
  assert(typeof symlinkHome === 'string' && symlinkHome.length > 0, 'missing symlink profileHome');
  const interveningSymlink = report.calls.slice(updateIndex + 1, symlinkSpawnIdx).filter(call => call.home === symlinkHome);
  assert(
    interveningSymlink.every(call => Array.isArray(call.argv) && (call.argv.includes('--version') || (call.argv.includes('ext') && call.argv.includes('seed')))),
    'symlink profile ran a trust-migrating command before spawn',
  );

  assert(validProjectTrustLaunchRecord(data.preUpdate?.statusFirst, 'foreground'), 'invalid pre-update status-first launch');
  assert(validProjectTrustLaunchRecord(data.preUpdate?.spawnFirst, 'foreground'), 'invalid pre-update spawn-first launch');
  assert(validProjectTrustLaunchRecord(data.preUpdate?.symlink, 'foreground'), 'invalid pre-update symlink launch');
  const sourceAlreadyTrusted = data.trustCase === 'source-already-trusted';
  assert(['source-without-trust', 'source-already-trusted'].includes(data.trustCase), 'the cell must name which trust case it ran');
  if (cell.scenario === 'project-trust-migration-0.182.1') {
    assert.equal(data.sourceVersion, PINNED_TRUST_SOURCE, 'the pinned cell must migrate from 0.182.1');
    assert.equal(data.trustCase, 'source-without-trust', 'the pinned cell must be the source without trust');
    assert.equal(cell.sourceVersion, PINNED_TRUST_SOURCE);
  } else if (data.trustCase === 'source-without-trust') {
    assert.notEqual(data.sourceVersion, PINNED_TRUST_SOURCE, '0.182.1 evidence belongs to the pinned cell');
  }
  assert.equal(data.preUpdate?.seedAbsentBeforeUpdate, !sourceAlreadyTrusted);
  assert.equal(data.preUpdate?.trustUnchanged, sourceAlreadyTrusted ? true : undefined);

  assert.equal(data.statusFirst?.seedAbsentAfterUpdateBeforeStatus, !sourceAlreadyTrusted);
  assert.equal(data.statusFirst?.seedRecordedByStatus, true);
  assert.equal(data.statusFirst?.trustUnchanged, sourceAlreadyTrusted ? true : undefined);
  assert(Array.isArray(data.statusFirst?.trustedRoots) && data.statusFirst.trustedRoots.includes(data.statusFirst.canonicalRoot), 'status-first root missing from trusted store');
  assert(!data.statusFirst.trustedRoots.includes(data.refusals?.legacyUnregisteredWithPeers?.canonicalRoot), 'unregistered legacy root was seeded');
  assert(validProjectTrustLaunchRecord(data.statusFirst?.foreground, 'foreground'), 'invalid post-update status-first foreground launch');
  assert(validProjectTrustLaunchRecord(data.statusFirst?.managed, 'managed'), 'invalid post-update background Manager launch');
  assert.equal(data.statusFirst?.managedSeatJoined, true, 'background Manager seat did not join');

  assertTrustProfile(data, 'spawnFirst', sourceAlreadyTrusted, 'seedAbsentBeforeSpawn', 'seedRecordedBySpawn');
  assert.equal(data.spawnFirst?.storeAbsentBeforeSpawn, !sourceAlreadyTrusted);
  assertTrustProfile(data, 'preparedStatusFirst', sourceAlreadyTrusted, 'seedAbsentBeforeStatus', 'seedRecordedByStatus');
  assertTrustProfile(data, 'preparedUpFirst', sourceAlreadyTrusted, 'seedAbsentBeforeUp', 'seedRecordedByUp');

  assert.equal(data.symlink?.seedAbsentBeforeSpawn, !sourceAlreadyTrusted);
  assert.equal(data.symlink?.trustUnchanged, sourceAlreadyTrusted ? true : undefined);
  assert.notEqual(data.symlink?.linkPath, data.symlink?.canonicalRoot, 'symlink entry must differ from canonical target');
  assert(Array.isArray(data.symlink?.trustedRoots) && data.symlink.trustedRoots.includes(data.symlink.canonicalRoot), 'canonical symlink target missing from trusted store');
  assert(!data.symlink.trustedRoots.includes(data.symlink.linkPath), 'non-canonical symlink spelling must not be stored');
  assert(validProjectTrustLaunchRecord(data.symlink?.foreground, 'foreground'), 'invalid post-update symlink launch');
  const spellings = data.preUpdate?.spellings;
  if (cell.platform === 'win32') {
    assert.equal(spellings?.platform, 'win32');
    for (const name of ['driveLower', 'leafUpper', 'trailingSeparator', 'forwardSlash', 'shortName', 'windowsSymlink']) {
      const entry = spellings.spellings?.[name];
      assert(entry, `missing ${name} path spelling`);
      assert(entry.ran === true || typeof entry.reason === 'string' && entry.reason.length > 0, `${name} neither ran nor said why`);
      if (entry.ran) assert.equal(entry.canonical, spellings.canonical, `${name} resolved to a different root`);
    }
  } else {
    assert.equal(typeof spellings?.notRun, 'string');
  }

  assert(validProjectTrustRefusalRecord(data.refusals?.legacyUnregisteredWithPeers, cell.platform), 'invalid legacy unregistered refusal with peers');
  assert(validProjectTrustRefusalRecord(data.refusals?.postUpdateCreated, cell.platform), 'invalid post-update new project refusal');
  assert(validProjectTrustRefusalRecord(data.refusals?.legacyUnregisteredEmptyHome, cell.platform), 'invalid legacy unregistered refusal in empty home');
  assert.equal(data.cleanup?.stacksStopped, true, 'owned project-trust stacks were not confirmed stopped');

  return { 'project-trust-migrated': true };
}

function cliHelpers({ cli, launcher, call, options }) {
  const layout = options.layout ?? 'npm';
  const invokeCli = (label, argv, scope) => layout === 'installer'
    ? call(label, launcher, argv, undefined, scope)
    : call(label, process.execPath, [cli, ...argv], undefined, scope);
  const ok = (result, label) => {
    assert.equal(result.exit, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.timeout, false);
    return result;
  };
  return { invokeCli, ok };
}

async function buildProjectTrustWorkspace({ env, root, pkg, call, ok, invokeCli }) {
  const workRoot = join(root, 'project-trust');
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const standin = buildStandinClaude(join(workRoot, 'bin'), process.platform);

  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const probeEnv = {
    ...env,
    [pathKey]: `${standin.binDir}${delimiter}${env[pathKey] ?? ''}`,
    TRUST_MATRIX_ENV: EXPECTED_PROJECT_TRUST_ENV,
  };

  // The cell already sets TMPDIR to cellTempDirectory(root). A profile temp
  // directory under the cell root makes the control socket longer than sun_path,
  // so every profile uses that same directory.
  const cellTmp = cellTempDirectory(root);
  const profile = (name) => buildIsolatedProfile(probeEnv, join(workRoot, 'profiles', name), standin.binDir, cellTmp);
  const profiles = {
    primary: profile('primary'),
    spawnFirst: profile('spawn-first'),
    preparedStatusFirst: profile('prepared-status-first'),
    preparedUpFirst: profile('prepared-up-first'),
    symlink: profile('symlink'),
    emptyHome: profile('empty-home'),
    brokerOnly: profile('broker-only'),
  };

  const projectsDir = join(workRoot, 'projects');
  const projects = {
    statusFirst: join(projectsDir, 'status-first-registered'),
    spawnFirst: join(projectsDir, 'spawn-first-registered'),
    preparedStatusFirst: join(projectsDir, 'prepared-status-first'),
    preparedUpFirst: join(projectsDir, 'prepared-up-first'),
    symlinkReal: join(projectsDir, 'symlink-real'),
    symlinkEntry: join(projectsDir, 'symlink-entry'),
    legacyUnregPeers: join(projectsDir, 'legacy-unreg-with-peers'),
    legacyUnregEmpty: join(projectsDir, 'legacy-unreg-empty-home'),
    postUpdate: join(projectsDir, 'post-update-created'),
    brokerHost: join(workRoot, 'broker-host'),
  };
  for (const [key, dir] of Object.entries(projects)) {
    if (key === 'symlinkEntry' || key === 'postUpdate') continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  mkdirSync(join(projects.brokerHost, '.cotal'), { recursive: true, mode: 0o700 });

  for (const dir of [
    projects.statusFirst,
    projects.spawnFirst,
    projects.preparedStatusFirst,
    projects.preparedUpFirst,
    projects.symlinkReal,
    projects.legacyUnregPeers,
    projects.legacyUnregEmpty,
  ]) {
    writeTrustedProjectFiles(dir, standin.probeScript);
  }
  symlinkSync(projects.symlinkReal, projects.symlinkEntry, process.platform === 'win32' ? 'junction' : 'dir');

  if (process.platform === 'win32') {
    const coreHref = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
    const dirsToHarden = [
      workRoot,
      projectsDir,
      projects.brokerHost,
      ...Object.values(profiles).flatMap(p => [p.home, p.cotalHome, p.configDir]),
      projects.statusFirst,
      projects.spawnFirst,
      projects.preparedStatusFirst,
      projects.preparedUpFirst,
      projects.symlinkReal,
      projects.legacyUnregPeers,
      projects.legacyUnregEmpty,
    ];
    const script = `const {mkSecretDir}=await import(${JSON.stringify(coreHref)});for(const d of ${JSON.stringify(dirsToHarden)})mkSecretDir(d);`;
    ok(await call('harden project-trust directories', process.execPath, ['--input-type=module', '-e', script]), 'Windows project-trust ACL hardening');
  }

  for (const [name, profile] of Object.entries(profiles)) {
    ok(await invokeCli(`seed isolated profile ${name}`, ['ext', 'seed'], { cwd: workRoot, env: profile.env }), `seed ${name}`);
  }
  return { workRoot, standin, profiles, projects };
}

async function windowsPathSpellings(projectDir) {
  const canonical = realpathSync.native(projectDir);
  if (process.platform !== 'win32') {
    const skipped = { platform: process.platform, notRun: 'path spellings beyond the symlink run on Windows only' };
    console.log(`project-trust path spellings skipped: ${skipped.notRun}`);
    return skipped;
  }
  const drive = canonical.slice(0, 1);
  const rest = canonical.slice(1);
  const leaf = canonical.slice(canonical.lastIndexOf('\\') + 1);
  const spellings = {
    driveLower: `${drive.toLowerCase()}${rest}`,
    leafUpper: `${canonical.slice(0, -leaf.length)}${leaf.toUpperCase()}`,
    trailingSeparator: `${canonical}\\`,
    forwardSlash: canonical.replaceAll('\\', '/'),
  };
  const result = {};
  for (const [name, spelling] of Object.entries(spellings)) {
    try { result[name] = { spelling, canonical: realpathSync.native(spelling), ran: true }; }
    catch (error) { result[name] = { spelling, ran: false, reason: error.message }; }
  }
  result.shortName = await shortNameSpelling(canonical);
  result.windowsSymlink = await windowsSymlinkSpelling(canonical);
  for (const [name, entry] of Object.entries(result)) {
    if (entry.ran) assert.equal(entry.canonical, canonical, `${entry.spelling} resolved to a different root`);
    else console.log(`project-trust path spelling skipped: ${name}: ${entry.reason}`);
  }
  return { platform: 'win32', canonical, spellings: result };
}

export async function shortNameSpelling(canonical, run = execFileSync) {
  try {
    // cmd receives this as one argument. Quotes inside it become part of the
    // path, so the path is left bare: a cell root has no spaces.
    const short = run('cmd', ['/c', `for %I in (${canonical}) do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim();
    if (!short || short.toLowerCase() === canonical.toLowerCase()) return { ran: false, reason: `no 8.3 short name for ${canonical}` };
    return { spelling: short, canonical: realpathSync.native(short), ran: true };
  } catch (error) { return { ran: false, reason: error.message }; }
}

function windowsSymlinkSpelling(canonical) {
  const link = `${canonical}-link`;
  try {
    symlinkSync(canonical, link, 'dir');
    return { spelling: link, canonical: realpathSync.native(link), ran: true };
  } catch (error) { return { spelling: link, ran: false, reason: error.message }; }
}

export function recordedPids(cwd) {
  const dir = join(cwd, '.cotal');
  if (!existsSync(dir)) return [];
  const pids = [];
  for (const name of readdirSync(dir)) {
    if (!/^(nats|manager\.[0-9a-f]+|auth-service\.[0-9a-f]+|delivery\.[0-9a-f]+|standin-seat)\.pid$/.test(name)) continue;
    const first = readFileSync(join(dir, name), 'utf8').trim().split(/\s+/)[0];
    const pid = Number(first);
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

function pidGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export async function waitUntilGone(pids, alive = pidGone, wait = ms => new Promise(done => setTimeout(done, ms)), now = Date.now) {
  const pending = new Set(pids);
  const deadline = now() + 15_000;
  while (pending.size > 0 && now() < deadline) {
    for (const pid of pending) if (alive(pid)) pending.delete(pid);
    if (pending.size > 0) await wait(200);
  }
  assert.equal(pending.size, 0, `owned processes still running: ${[...pending].join(', ')}`);
}

function stackControls(invokeCli, ok) {
  const activeStacks = [];
  const startOpenStack = async (label, cwd, space, runEnv, { server, withManager = false } = {}) => {
    const chosenServer = server ?? `nats://127.0.0.1:${await freeLoopbackPort()}`;
    const args = ['up', '--space', space, '--open', '--server', chosenServer, '--detach', ...(withManager ? [] : ['--no-manager'])];
    ok(await invokeCli(label, args, { cwd, env: runEnv }), label);
    const entry = { cwd, space, env: runEnv, stopped: false, withAgents: withManager };
    activeStacks.push(entry);
    return { server: chosenServer, entry };
  };
  const stopOpenStack = async (label, stack) => {
    if (stack.stopped) return;
    // A broker-only stack is the space recorded at its own root. 0.182.1 stops
    // that with bare `cotal down`; current also accepts it, and rejects
    // --with-agents together with --space. A stack that started a manager names
    // its space and stops its agents. `down` returns before the pids exit, so the
    // recorded pids are read first and the stop is not done until they are gone.
    const pids = recordedPids(stack.cwd);
    const argv = stack.withAgents ? ['down', '--with-agents', '--yes'] : ['down', '--yes'];
    ok(await invokeCli(label, argv, { cwd: stack.cwd, env: stack.env }), label);
    await waitUntilGone(pids);
    stack.stopped = true;
  };
  return { activeStacks, startOpenStack, stopOpenStack };
}

const runForegroundProbe = async (invokeCli, ok, label, cwd, space, baseRunEnv, logPath = join(cwd, 'probe.log')) => {
  rmSync(logPath, { force: true });
  const runEnv = { ...baseRunEnv, TRUST_PROBE_LOG: logPath, TRUST_LAUNCH_MODE: 'foreground' };
  ok(await invokeCli(label, ['spawn', '--foreground', '--file', '.cotal/agents/probe.md', '--space', space, '--agent', 'claude', '--no-events'], { cwd, env: runEnv }), label);
  assert(existsSync(logPath), `${label}: stand-in claude did not write ${logPath}`);
  return JSON.parse(readFileSync(logPath, 'utf8').trim());
};

const runRefusalCheck = async (invokeCli, cwd, space, baseRunEnv, prefixLabel) => {
  const canonical = realpathSync.native(cwd);
  const expectedRemedy = expectedTrustRemedy(canonical, process.platform);
  const logPath = join(canonical, 'probe.log');
  rmSync(logPath, { force: true });
  const probeEnv = { ...baseRunEnv, TRUST_PROBE_LOG: logPath, TRUST_LAUNCH_MODE: 'foreground' };
  const probeRes = await invokeCli(`${prefixLabel} probe refusal`, ['spawn', '--foreground', '--file', '.cotal/agents/probe.md', '--space', space, '--agent', 'claude', '--no-events'], { cwd, env: probeEnv });
  const probeLogCreated = existsSync(logPath);
  rmSync(logPath, { force: true });
  const plainRes = await invokeCli(`${prefixLabel} plain refusal`, ['spawn', '--foreground', '--file', '.cotal/agents/plain.md', '--space', space, '--agent', 'claude', '--no-events'], { cwd, env: probeEnv });
  return {
    canonicalRoot: canonical,
    expectedRemedy,
    probeExit: probeRes.exit,
    probeOutput: `${probeRes.stdout}${probeRes.stderr}`,
    probeLogCreated,
    plainExit: plainRes.exit,
    plainOutput: `${plainRes.stdout}${plainRes.stderr}`,
    plainLogCreated: existsSync(logPath),
  };
};

export async function prepareProjectTrustMigration(context) {
  const { env, root, pkg, call, check, report, output } = context;
  const { invokeCli, ok } = cliHelpers(context);
  const { workRoot, standin, profiles, projects } = await buildProjectTrustWorkspace({ env, root, pkg, call, ok, invokeCli });
  const sharedServer = `nats://127.0.0.1:${await freeLoopbackPort()}`;
  const { activeStacks, startOpenStack, stopOpenStack } = stackControls(invokeCli, ok);
  const probe = (label, cwd, space, runEnv, logPath) => runForegroundProbe(invokeCli, ok, label, cwd, space, runEnv, logPath);
  const refusal = (label, cwd, space, runEnv) => runRefusalCheck(invokeCli, cwd, space, runEnv, label);

  let allStacksStopped = false;
  const cleanup = async () => {
    const failures = [];
    for (const stack of [...activeStacks].reverse()) {
      if (stack.stopped) continue;
      const argv = stack.withAgents ? ['down', '--with-agents', '--yes'] : ['down', '--yes'];
      const pids = recordedPids(stack.cwd);
      const result = await invokeCli(`project-trust cleanup ${stack.space}`, argv, { cwd: stack.cwd, env: stack.env });
      if (result.exit === 0 && result.signal === null && result.timeout === false) {
        try {
          await waitUntilGone(pids);
          stack.stopped = true;
        } catch (error) {
          failures.push(`${stack.space} still running: ${error.message}`);
        }
      } else failures.push(`${stack.space} exit ${result.exit}`);
    }
    allStacksStopped = activeStacks.every(stack => stack.stopped);
    assert(allStacksStopped, `owned project-trust stacks still running: ${failures.join(', ')}`);
  };
  context.adoptCleanup?.(cleanup);

  // Name the broker after its folder so bare `cotal down` matches the space both
  // 0.182.1 and current record at that root.
  const preBroker = await startOpenStack('project-trust pre-update broker up', projects.brokerHost, 'broker-host', profiles.brokerOnly.env, { server: sharedServer, withManager: false });

  const primarySeedPath = profiles.primary.seedPath;
  const primaryStorePath = profiles.primary.storePath;

  ok(await invokeCli('project-trust register status-first', ['space', 'add', 'registered', '--root', projects.statusFirst, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.statusFirst, env: profiles.primary.env }), 'register status-first');
  ok(await invokeCli('project-trust register spawn-first', ['space', 'add', 'registered', '--root', projects.spawnFirst, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.spawnFirst, env: profiles.spawnFirst.env }), 'register spawn-first');
  ok(await invokeCli('project-trust prepare status-first space', ['space', 'create', 'prepared', '--root', projects.preparedStatusFirst], { cwd: projects.preparedStatusFirst, env: profiles.preparedStatusFirst.env }), 'prepare status-first');
  ok(await invokeCli('project-trust prepare up-first space', ['space', 'create', 'prepared', '--root', projects.preparedUpFirst], { cwd: projects.preparedUpFirst, env: profiles.preparedUpFirst.env }), 'prepare up-first');
  ok(await invokeCli('project-trust register symlink space', ['space', 'add', 'linked', '--root', projects.symlinkEntry, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.symlinkEntry, env: profiles.symlink.env }), 'register symlink');

  const sourceAlreadyTrusted = compareVersions(report.source, FIRST_TRUST_RELEASE) >= 0;
  if (sourceAlreadyTrusted) {
    const trusted = [
      ['status-first', projects.statusFirst, profiles.primary],
      ['spawn-first', projects.spawnFirst, profiles.spawnFirst],
      ['prepared-status-first', projects.preparedStatusFirst, profiles.preparedStatusFirst],
      ['prepared-up-first', projects.preparedUpFirst, profiles.preparedUpFirst],
      ['symlink', projects.symlinkReal, profiles.symlink],
    ];
    for (const [name, dir, profile] of trusted) {
      ok(await invokeCli(`project-trust record ${name}`, ['trust', dir], { cwd: dir, env: profile.env }), `record ${name}`);
    }
  }

  const preStatusFirst = await probe('project-trust pre-update status-first spawn', projects.statusFirst, 'registered', profiles.primary.env);
  const preSpawnFirst = await probe('project-trust pre-update spawn-first spawn', projects.spawnFirst, 'registered', profiles.spawnFirst.env);
  const preSymlink = await probe('project-trust pre-update symlink spawn', projects.symlinkEntry, 'linked', profiles.symlink.env, join(projects.symlinkReal, 'probe.log'));
  const spellings = await windowsPathSpellings(projects.statusFirst);

  await stopOpenStack('project-trust pre-update broker down', preBroker.entry);

  const primaryBefore = trustSnapshot(primarySeedPath, primaryStorePath);
  const profileBefore = Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, trustSnapshot(profile.seedPath, profile.storePath)]));
  // primaryBefore is the same home as profiles.primary. Count homes, not both copies.
  const recorded = Object.values(profileBefore).filter(Boolean).length;
  const recordedHomes = sourceAlreadyTrusted ? 5 : 0;
  assert.equal(recorded, recordedHomes, sourceAlreadyTrusted
    ? 'a source with project trust must have recorded every home the user trusted before the update'
    : 'a source without project trust must not have recorded trust before the update');
  console.log(`project-trust case: ${sourceAlreadyTrusted ? 'source-already-trusted' : 'source-without-trust'} (source ${report.source})`);

  const evidence = {
    platform: process.platform,
    sourceVersion: report.source,
    targetVersion: null,
    trustCase: sourceAlreadyTrusted ? 'source-already-trusted' : 'source-without-trust',
    preUpdate: {
      seedAbsentBeforeUpdate: !sourceAlreadyTrusted,
      ...(sourceAlreadyTrusted ? { trustUnchanged: true } : {}),
      statusFirst: preStatusFirst,
      spawnFirst: preSpawnFirst,
      symlink: preSymlink,
      spellings,
    },
  };

  return Object.assign(cleanup, {
    afterUpdate: update => verifyProjectTrustAfterUpdate(update, {
      env, pkg, call, check, report, output, workRoot, standin, profiles, projects,
      sharedServer, activeStacks, startOpenStack, stopOpenStack, probe, refusal,
      invokeCli, ok, primarySeedPath, primaryStorePath, primaryBefore, profileBefore, sourceAlreadyTrusted, cleanup, evidence,
      stacksStopped: () => allStacksStopped,
    }),
  });
}

async function collectProjectTrustRefusals({ env, pkg, call, ok, invokeCli, refusal, standin, profiles, projects, sharedServer, reconcileConnectorsOnly }) {
  // A folder that already carried a .cotal but had no space registered or prepared before the update.
  ok(await invokeCli('project-trust register legacy unreg peers', ['space', 'add', 'unreg', '--root', projects.legacyUnregPeers, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.legacyUnregPeers, env: profiles.primary.env }), 'register legacy unreg peers');
  const legacyUnregisteredWithPeers = await refusal('project-trust legacy unreg peers', projects.legacyUnregPeers, 'unreg', profiles.primary.env);

  // A project created after the update.
  mkdirSync(projects.postUpdate, { recursive: true, mode: 0o700 });
  writeTrustedProjectFiles(projects.postUpdate, standin.probeScript);
  if (process.platform === 'win32') {
    const coreHref = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
    ok(await call('harden post-update project directory', process.execPath, ['--input-type=module', '-e', `const {mkSecretDir}=await import(${JSON.stringify(coreHref)});mkSecretDir(${JSON.stringify(projects.postUpdate)});`]), 'Windows post-update ACL hardening');
  }
  ok(await invokeCli('project-trust register post-update project', ['space', 'add', 'postnew', '--root', projects.postUpdate, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.postUpdate, env: profiles.primary.env }), 'register post-update');
  const postUpdateCreated = await refusal('project-trust post-update created', projects.postUpdate, 'postnew', profiles.primary.env);

  // The same pre-existing folder in a home that had no spaces at all before the update.
  await reconcileConnectorsOnly('empty-home', profiles.emptyHome);
  ok(await invokeCli('project-trust empty-home space create', ['space', 'create', 'unregempty', '--root', projects.legacyUnregEmpty], { cwd: projects.legacyUnregEmpty, env: profiles.emptyHome.env }), 'empty-home space create');
  ok(await invokeCli('project-trust empty-home space add', ['space', 'add', 'unregempty2', '--root', projects.legacyUnregEmpty, '--server', sharedServer, '--mode', 'open', '--force', '--yes'], { cwd: projects.legacyUnregEmpty, env: profiles.emptyHome.env }), 'empty-home space add');
  const legacyUnregisteredEmptyHome = await refusal('project-trust legacy unreg empty-home', projects.legacyUnregEmpty, 'unregempty2', profiles.emptyHome.env);
  return { legacyUnregisteredWithPeers, postUpdateCreated, legacyUnregisteredEmptyHome };
}

async function runManagedProbe({ invokeCli, ok, projects, profiles, startOpenStack, stopOpenStack }) {
  ok(await invokeCli('project-trust forget manual status-first space', ['space', 'forget', 'registered'], { cwd: projects.statusFirst, env: profiles.primary.env }), 'forget manual status-first');
  const managedLogPath = join(projects.statusFirst, 'managed-probe.log');
  rmSync(managedLogPath, { force: true });
  const managerEnv = { ...profiles.primary.env, TRUST_PROBE_LOG: managedLogPath, TRUST_LAUNCH_MODE: 'managed' };
  const managedStack = await startOpenStack('project-trust start background Manager stack', projects.statusFirst, 'status-first-registered', managerEnv, { withManager: true });
  rmSync(managedLogPath, { force: true });
  ok(await invokeCli('project-trust status-first managed spawn', ['spawn', '--detach', 'probe', '--name', 'trust_mgr_worker', '--space', 'status-first-registered', '--agent', 'claude', '--no-events'], { cwd: projects.statusFirst, env: managerEnv }), 'managed spawn');
  const managedDeadline = Date.now() + 30_000;
  while (!existsSync(managedLogPath) && Date.now() < managedDeadline) await new Promise(done => setTimeout(done, 250));
  assert(existsSync(managedLogPath), 'background Manager launch wrote no probe log');
  const psAfterManaged = ok(await invokeCli('project-trust status-first ps', ['ps', '--space', 'status-first-registered', '--json'], { cwd: projects.statusFirst, env: managerEnv }), 'ps after managed spawn');
  const psData = JSON.parse(psAfterManaged.stdout).result;
  const seatJoined = psData?.kind === 'seats' && Array.isArray(psData.items) && psData.items.some(item => item.name === 'trust_mgr_worker');
  const record = JSON.parse(readFileSync(managedLogPath, 'utf8').trim());
  await stopOpenStack('project-trust stop background Manager stack', managedStack.entry);
  return { record, seatJoined };
}

async function verifyProjectTrustAfterUpdate(update, ctx) {
  const {
    env, pkg, call, check, report, output, workRoot, standin, profiles, projects,
    sharedServer, startOpenStack, stopOpenStack, probe, refusal, invokeCli, ok,
    primarySeedPath, primaryStorePath, primaryBefore, profileBefore, sourceAlreadyTrusted, cleanup, evidence, stacksStopped,
  } = ctx;
  assert.equal(update.exit, 0, 'upgrade under test must exit 0 before project-trust verification');
  evidence.targetVersion = report.target;

      // Restart the shared broker on the exact same port in the isolated brokerOnly profile so
      // spawn-first and symlink profiles can run `cotal spawn` as their very first post-update command.
      const postBroker = await startOpenStack('project-trust post-update broker up', projects.brokerHost, 'broker-host', profiles.brokerOnly.env, { server: sharedServer, withManager: false });

      // 3a + 6: status-first in primary home, followed by foreground spawn AND background Manager detached spawn.
      const seedAbsentAfterUpdateBeforeStatus = !existsSync(primarySeedPath) && !existsSync(primaryStorePath);
      ok(await invokeCli('project-trust status-first status', ['status', '--plain'], { cwd: projects.statusFirst, env: profiles.primary.env }), 'status-first status');
      const seedRecordedByStatus = existsSync(primarySeedPath) && existsSync(primaryStorePath);
      const statusFirstRoots = seedRecordedByStatus ? JSON.parse(readFileSync(primaryStorePath, 'utf8')).roots : [];
      const postStatusFirstFg = await probe('project-trust status-first foreground spawn', projects.statusFirst, 'registered', profiles.primary.env);
      const managed = await runManagedProbe({ invokeCli, ok, projects, profiles, startOpenStack, stopOpenStack });

      evidence.statusFirst = {
        canonicalRoot: realpathSync.native(projects.statusFirst),
        seedAbsentAfterUpdateBeforeStatus,
        seedRecordedByStatus,
        ...(sourceAlreadyTrusted ? { trustUnchanged: sameRoots(primaryBefore, primarySeedPath, primaryStorePath) } : {}),
        trustedRoots: statusFirstRoots,
        foreground: postStatusFirstFg,
        managed: managed.record,
        managedSeatJoined: managed.seatJoined,
      };

      const reconcileConnectorsOnly = async (name, profile) => {
        const ver = ok(await invokeCli(`project-trust ${name} version`, ['--version'], { cwd: workRoot, env: profile.env }), `${name} version`);
        if (ver.stdout.includes('Reconciliation pending') || !existsSync(join(profile.configDir, 'extensions', 'extensions.json'))) {
          ok(await invokeCli(`project-trust ${name} ext seed`, ['ext', 'seed'], { cwd: workRoot, env: profile.env }), `${name} ext seed`);
        }
      };

      // 3b: spawn-first without prior status, up, or space registration.
      await reconcileConnectorsOnly('spawn-first', profiles.spawnFirst);
      const spawnFirstSeedAbsent = !existsSync(profiles.spawnFirst.seedPath);
      const spawnFirstStoreAbsent = !existsSync(profiles.spawnFirst.storePath);
      const postSpawnFirst = await probe('project-trust spawn-first foreground spawn', projects.spawnFirst, 'registered', profiles.spawnFirst.env);
      const spawnFirstSeedRecorded = existsSync(profiles.spawnFirst.seedPath) && existsSync(profiles.spawnFirst.storePath);
      evidence.spawnFirst = {
        profileHome: profiles.spawnFirst.home,
        canonicalRoot: realpathSync.native(projects.spawnFirst),
        seedAbsentBeforeSpawn: spawnFirstSeedAbsent,
        storeAbsentBeforeSpawn: spawnFirstStoreAbsent,
        seedRecordedBySpawn: spawnFirstSeedRecorded,
        ...(sourceAlreadyTrusted ? { trustUnchanged: sameRoots(profileBefore.spawnFirst, profiles.spawnFirst.seedPath, profiles.spawnFirst.storePath) } : {}),
        trustedRoots: spawnFirstSeedRecorded ? JSON.parse(readFileSync(profiles.spawnFirst.storePath, 'utf8')).roots : [],
        foreground: postSpawnFirst,
      };

      // 4a (status-first): prepared space that was never started before the update.
      await reconcileConnectorsOnly('prepared-status-first', profiles.preparedStatusFirst);
      const prepStatusSeedAbsent = !existsSync(profiles.preparedStatusFirst.seedPath) && !existsSync(profiles.preparedStatusFirst.storePath);
      ok(await invokeCli('project-trust prepared-status-first status', ['status', '--plain'], { cwd: projects.preparedStatusFirst, env: profiles.preparedStatusFirst.env }), 'prepared-status-first status');
      const prepStatusSeedRecorded = existsSync(profiles.preparedStatusFirst.seedPath) && existsSync(profiles.preparedStatusFirst.storePath);
      const prepStatusStack = await startOpenStack('project-trust prepared-status-first stack up', projects.preparedStatusFirst, 'prepared', profiles.preparedStatusFirst.env, { withManager: false });
      const postPrepStatusFg = await probe('project-trust prepared-status-first foreground spawn', projects.preparedStatusFirst, 'prepared', profiles.preparedStatusFirst.env);
      await stopOpenStack('project-trust prepared-status-first stack down', prepStatusStack.entry);
      evidence.preparedStatusFirst = {
        canonicalRoot: realpathSync.native(projects.preparedStatusFirst),
        seedAbsentBeforeStatus: prepStatusSeedAbsent,
        seedRecordedByStatus: prepStatusSeedRecorded,
        ...(sourceAlreadyTrusted ? { trustUnchanged: sameRoots(profileBefore.preparedStatusFirst, profiles.preparedStatusFirst.seedPath, profiles.preparedStatusFirst.storePath) } : {}),
        trustedRoots: prepStatusSeedRecorded ? JSON.parse(readFileSync(profiles.preparedStatusFirst.storePath, 'utf8')).roots : [],
        foreground: postPrepStatusFg,
      };

      // 4a (up-first): prepared space that was never started before the update, started directly with `cotal up` post-update.
      await reconcileConnectorsOnly('prepared-up-first', profiles.preparedUpFirst);
      const prepUpSeedAbsent = !existsSync(profiles.preparedUpFirst.seedPath) && !existsSync(profiles.preparedUpFirst.storePath);
      const prepUpStack = await startOpenStack('project-trust prepared-up-first stack up', projects.preparedUpFirst, 'prepared', profiles.preparedUpFirst.env, { withManager: false });
      const prepUpSeedRecorded = existsSync(profiles.preparedUpFirst.seedPath) && existsSync(profiles.preparedUpFirst.storePath);
      const postPrepUpFg = await probe('project-trust prepared-up-first foreground spawn', projects.preparedUpFirst, 'prepared', profiles.preparedUpFirst.env);
      await stopOpenStack('project-trust prepared-up-first stack down', prepUpStack.entry);
      evidence.preparedUpFirst = {
        canonicalRoot: realpathSync.native(projects.preparedUpFirst),
        seedAbsentBeforeUp: prepUpSeedAbsent,
        seedRecordedByUp: prepUpSeedRecorded,
        ...(sourceAlreadyTrusted ? { trustUnchanged: sameRoots(profileBefore.preparedUpFirst, profiles.preparedUpFirst.seedPath, profiles.preparedUpFirst.storePath) } : {}),
        trustedRoots: prepUpSeedRecorded ? JSON.parse(readFileSync(profiles.preparedUpFirst.storePath, 'utf8')).roots : [],
        foreground: postPrepUpFg,
      };

      // 4b: project reached through a symbolic link / Windows junction.
      await reconcileConnectorsOnly('symlink', profiles.symlink);
      const symlinkSeedAbsent = !existsSync(profiles.symlink.seedPath) && !existsSync(profiles.symlink.storePath);
      const postSymlinkFg = await probe('project-trust symlink foreground spawn', projects.symlinkEntry, 'linked', profiles.symlink.env, join(projects.symlinkReal, 'probe.log'));
      const symlinkSeedRecorded = existsSync(profiles.symlink.seedPath) && existsSync(profiles.symlink.storePath);
      evidence.symlink = {
        profileHome: profiles.symlink.home,
        linkPath: projects.symlinkEntry,
        canonicalRoot: realpathSync.native(projects.symlinkReal),
        seedAbsentBeforeSpawn: symlinkSeedAbsent,
        ...(sourceAlreadyTrusted ? { trustUnchanged: sameRoots(profileBefore.symlink, profiles.symlink.seedPath, profiles.symlink.storePath) } : {}),
        trustedRoots: symlinkSeedRecorded ? JSON.parse(readFileSync(profiles.symlink.storePath, 'utf8')).roots : [],
        foreground: postSymlinkFg,
      };

      evidence.refusals = await collectProjectTrustRefusals({ env, pkg, call, ok, invokeCli, refusal, standin, profiles, projects, sharedServer, reconcileConnectorsOnly });

      await stopOpenStack('project-trust post-update broker down', postBroker.entry);
      await cleanup();
      evidence.cleanup = { stacksStopped: stacksStopped() };

      const artifact = `${report.id}-project-trust-migration.json`;
      const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      writeFileSync(join(output, artifact), bytes, { mode: 0o600 });
      report.projectTrustMigration = {
        artifact,
        bytes: bytes.length,
        sha256: digest(bytes),
      };

      const verified = verifyProjectTrustEvidence({
        report,
        cell: { scenario: report.source === PINNED_TRUST_SOURCE ? 'project-trust-migration-0.182.1' : 'project-trust-migration', platform: process.platform, sourceVersion: report.source, targetVersion: report.target },
        output,
      });
      check('existing project trust migrates and untrusted projects still refuse', verified['project-trust-migrated'] === true, report.projectTrustMigration);
}
