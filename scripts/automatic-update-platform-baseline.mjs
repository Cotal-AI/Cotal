/** Native lifecycle baseline and real published upgrade matrix. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { observeMacHandoff, handoffEvidence } from './mac-transition-observer.mjs';
import { foreignStackEnded } from './foreign-stack-cleanup.mjs';
import { createPreResultKill } from './mac-pre-result-kill.mjs';
import { archiveHostedDiagnostics, writeHostedSeatRecorder } from './hosted-consent-diagnostics.mjs';
import { captureDaemonDiagnostics, inspectInstalledUpdateRoute } from './daemon-cell-diagnostics.mjs';
import { evaluateManualDaemonState } from './daemon-manual-acceptance.mjs';
import { compareVersions } from './upgrade-matrix-plan.mjs';
import { candidateSourceIdentity, hostedManagerRestored, hostedManagerRetryAfter, intermediateWholeMachine } from './candidate-next-evidence.mjs';
export { hostedManagerRetryAfter } from './candidate-next-evidence.mjs';
import { matchSource16410Refusal } from './source-16410-refusal.mjs';
import { matchKnownRefusal } from './upgrade-matrix-refusals.mjs';

export function candidateNextOptions(options, disposable = hosted) {
  const runningDesktop = options['running-desktop-beside-cli'] !== undefined;
  if (runningDesktop) {
    assert.equal(options['running-desktop-beside-cli'], 'true', 'running-desktop-beside-cli accepts only true');
    assert(disposable && process.platform === 'linux' && options.candidate && options['candidate-next'] && options['desktop-runtime'] && options['desktop-node'] && typeof options.prepare === 'function' && options.layout === 'npm' && options.state === 'daemon' && options.method === 'self' && options['next-hop-source'] === 'candidate' && options['stopped-daemon-before-update'] === undefined && options['disabled-daemon-before-update'] === undefined && options['follow-on-action'] === undefined, 'running-desktop-beside-cli requires disposable Linux paired npm daemon self, released desktop Node and real participant preparation without stop, disable or follow-on');
  }
  if (options['candidate-next'] === undefined) {
    if (options['stopped-daemon-before-update'] !== undefined) {
      assert.equal(options['stopped-daemon-before-update'], 'true', 'stopped-daemon-before-update accepts only true');
      assert(disposable && Boolean(options['desktop-runtime']) && options.state === 'daemon' && options.method === 'self', 'stopped-daemon-before-update without candidate-next requires disposable desktop-runtime daemon self');
    }
    assert.equal(options['disabled-daemon-before-update'], undefined, 'disabled-daemon-before-update requires candidate-next');
    return undefined;
  }
  const mode = options['next-hop-source'];
  assert(['candidate', '0.164.10'].includes(mode), 'candidate next source must be explicit');
  assert(['candidate','published'].includes(options['next-hop-phase']), 'candidate next phase must be explicit');
  const followOnAction = options['follow-on-action'];
  if (followOnAction !== undefined) {
    assert(['self', 'npm', 'installer'].includes(followOnAction), 'follow-on-action must be self, npm or installer');
    assert(mode === 'candidate' && options['candidate-follow-on'] && options.state === 'daemon' && options.method === 'self', 'follow-on action requires candidate next hop, daemon state, self method and follow-on closure');
    if (followOnAction === 'installer') assert(options.layout === 'installer' && options['candidate-follow-on-installer'], 'installer follow-on action requires installer layout and follow-on installer script');
    else assert.equal(options.layout, 'npm', 'self and npm follow-on actions require npm layout');
  }
  if (options['stopped-daemon-before-update'] !== undefined) {
    assert.equal(options['stopped-daemon-before-update'], 'true', 'stopped-daemon-before-update accepts only true');
    assert(mode === 'candidate' && options.layout === 'npm' && options.state === 'daemon' && options.method === 'self' && followOnAction === undefined && options['disabled-daemon-before-update'] === undefined, 'stopped-daemon-before-update requires candidate next hop, npm layout, daemon state and self method without follow-on action');
  }
  if (options['desktop-runtime'] !== undefined) {
    assert(mode === 'candidate' && options.layout === 'npm' && options.state === 'daemon' && options.method === 'self' && (options['stopped-daemon-before-update'] === 'true' || runningDesktop) && process.platform === 'linux', 'candidate-next desktop-runtime requires Linux stopped-daemon-before-update or explicit running-desktop-beside-cli');
  }
  if (options['disabled-daemon-before-update'] !== undefined) {
    assert.equal(options['disabled-daemon-before-update'], 'true', 'disabled-daemon-before-update accepts only true');
    assert(mode === 'candidate' && options.layout === 'npm' && options.state === 'daemon' && options.method === 'self' && followOnAction === undefined && options['stopped-daemon-before-update'] === undefined && ['linux', 'darwin'].includes(process.platform), 'disabled-daemon-before-update requires POSIX candidate next hop, npm layout, daemon state and self method without follow-on action');
  }
  const hostedConsent = mode === '0.164.10' && options.state === 'agent' && options.layout === 'npm'
    && options['daemon-hosted-manager'] === 'true' && options['stop-agents'] === 'true'
    && daemonHostedManagerOptions(options, {hosted: disposable});
  assert(disposable && options.candidate && ['npm', 'installer'].includes(options.layout) && (options.state === 'daemon' || hostedConsent) && options.method === 'self', 'candidate next hop requires hosted manual native service and both closures');
  if (mode === 'candidate' && followOnAction !== 'installer') assert.equal(options.layout, 'npm', 'fresh candidate next cells use npm layout');
  if (mode === '0.164.10') assert.equal(options.source, '0.164.10');
  return mode === 'candidate' ? 'candidate' : 'source-0.164.10';
}

export function assertPublishedPairTarget(options, observed, frozen) {
  if (options['candidate-next'] && options['next-hop-phase'] === 'published') assert.equal(observed,frozen,'public target changed before paired published action');
}

export function daemonHostedManagerOptions(options, { hosted: disposable = hosted, platform = process.platform } = {}) {
  if (options['daemon-hosted-manager'] === undefined) return false;
  assert.equal(options['daemon-hosted-manager'], 'true', 'daemon-hosted-manager accepts only true');
  assert(disposable && platform === 'linux' && options.state === 'agent' && (options.method ?? 'self') === 'self' && options['stop-agents'] === 'true', 'daemon-hosted-manager requires hosted Linux agent self with explicit stop-agents consent');
  assert.equal(typeof options.prepare, 'function', 'daemon-hosted-manager requires a real remote participant preparation');
  return true;
}
export function macTransitionSource(source, expectedTarget, kind) {
  return kind === 'transition' && /^\d+\.\d+\.\d+$/.test(source) && /^\d+\.\d+\.\d+$/.test(expectedTarget ?? '')
    && compareVersions(source, '0.164.6') >= 0 && compareVersions(source, expectedTarget) < 0;
}
export function needsSchedulerEligibility({ method, platform, launchdProof, windowsPolicy, policy }) {
  return method === 'scheduler' && ['linux', 'darwin'].includes(platform)
    && launchdProof !== 'off-before-tick' && !windowsPolicy && policy !== 'unsupported-scheduler';
}

export async function waitForSchedulerEligibility(report, readStatus, { now = Date.now, sleep = delay, timeoutMs = 90000, intervalMs = 1000 } = {}) {
  const startedAt = now(), deadline = startedAt + timeoutMs;
  const receipt = report.schedulerEligibility = { startedAt, deadline, source: report.source, observations: [] };
  const observe = (status, exit) => {
    receipt.observations.push({ attempt: receipt.observations.length + 1, observedAt: now(), exit, status });
    return exit === 0 && status?.state === 'ready' && status.version === report.source && status.update?.automatic === true;
  };
  if (observe(report.daemonBefore, 0)) return;
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, deadline - now()));
    if (now() >= deadline) break;
    const result = await readStatus(deadline - now());
    const status = result.exit === 0 ? JSON.parse(result.stdout).result : undefined;
    const eligible = observe(status, result.exit);
    if (status) report.daemonBefore = status;
    if (eligible && now() <= deadline) return;
  }
  assert.fail(`native scheduler eligibility timed out: ${JSON.stringify(receipt)}`);
}

// Read-only diagnostic children have their own bound and never alter the update's outcome.
export function runDiagnosticCommand(file, argv, { cwd, env, timeoutMs = 10000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const startedAt = new Date().toISOString();
  return new Promise(resolveRun => {
    let stdout = '', stderr = '', timeout = false, truncated = false, settled = false;
    const child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const stopOwnedTree = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => { timeout = true; stopOwnedTree(); }, timeoutMs);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ startedAt, finishedAt: new Date().toISOString(), stdout, stderr, timeout, truncated, ...result });
    };
    const collect = (key, bytes) => {
      const remaining = maxBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
      const text = bytes.subarray(0, Math.max(0, remaining)).toString();
      if (key === 'stdout') stdout += text; else stderr += text;
      if (bytes.length > remaining) { truncated = true; stopOwnedTree(); }
    };
    child.stdout.on('data', bytes => collect('stdout', bytes));
    child.stderr.on('data', bytes => collect('stderr', bytes));
    child.once('error', error => finish({ exit: null, signal: null, error: error.message }));
    child.once('close', (exit, signal) => finish({ exit, signal }));
  });
}

/** A rate-limited status question is not a negative Manager observation. */
export async function observeHostedManager({space, timeoutMs, observations, read, now = Date.now, sleep = delay}) {
  const startedAt = now(), deadline = startedAt + timeoutMs;
  for (;;) {
    const status = await read(deadline - now(), observations.length);
    const observation = {status, observedAt: now()};
    observations.push(observation);
    const retryAfterMs = hostedManagerRetryAfter(status, space);
    observation.retryAfterMs = retryAfterMs;
    assert(now() < deadline, 'hosted Manager observation exceeded its original deadline');
    if (retryAfterMs === 0) return {status, observations, startedAt, deadline};
    const nextAt = observation.observedAt + retryAfterMs;
    assert(nextAt < deadline, 'rate-limit retry would exceed the original observation deadline');
    while (now() < nextAt) await sleep(Math.max(1, nextAt - now()));
  }
}

/** Only the explicitly recorded local test fixture may retain its original generation. */
export function extensionVersionChecks({extensions, before, target, fixture, installed}) {
  const prior = fixture && before.filter(entry => entry.pkg === fixture.pkg);
  const owned = fixture?.pkg === 'cotal-upgrade-native-fixture' && prior?.length === 1
    && prior[0].spec === fixture.spec && prior[0].version === fixture.version
    && typeof fixture.spec === 'string' && typeof fixture.path === 'string' && typeof fixture.realpath === 'string'
    && ['package.json', 'index.js', 'seat.mjs', 'record-seat.mjs'].every(name => typeof fixture.files?.[name] === 'string');
  const counts = new Set(extensions.map(entry => entry.pkg)).size === extensions.length
    && (!fixture || owned && extensions.filter(entry => entry.pkg === fixture.pkg).length === 1);
  const isFixture = entry => owned && entry.pkg === fixture.pkg;
  const recorded = counts && extensions.every(entry => isFixture(entry)
    ? entry.spec === fixture.spec && entry.version === fixture.version
    : entry.version === target);
  const packages = counts && extensions.every(entry => {
    const matches = installed.filter(row => row.pkg === entry.pkg);
    if (matches.length !== 1) return false;
    const current = matches[0];
    if (!isFixture(entry)) return current.version === target;
    return entry.spec === fixture.spec && entry.version === fixture.version
      && current.path === fixture.path && current.realpath === fixture.realpath && current.version === fixture.version
      && Object.keys(current.files ?? {}).length === Object.keys(fixture.files).length
      && Object.entries(fixture.files).every(([name, hash]) => current.files?.[name] === hash);
  });
  return {recorded, installed: packages};
}

export const hostedManagerCommand = space => ['daemon', 'setup', '--space', space, '--json'];
export const foreignStackCleanupCommand = 'export HOME=/tmp/foreign-home COTAL_HOME=/tmp/foreign-home/.cotal XDG_CONFIG_HOME=/tmp/foreign-home/config; cd /tmp/project; cotal down --with-agents --yes';

export const sources = ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest'];
export const states = ['fresh', 'configured', 'daemon', 'agent', 'stale-extensions', 'recovery', 'concurrent'];
export const methods = ['self', 'scheduler', 'installer'];
const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const requiresManualStep = output => /run `cotal|run cotal|manual (?:step|intervention)|interrupted update|OPERATION_UNKNOWN|Outcome unconfirmed|needs restoration|refused/i.test(output);
export function completionAdvisory(output) {
  const advisory = [], required = [];
  let completion = false;
  for (const line of output.split('\n')) {
    if (line.trim() === 'Owned shell completion') completion = true;
    if (completion && (line.trim() === 'Owned shell completion' || /^\s*(?:Changed files|Preserved integrations|(?:bash|zsh|fish|powershell):|Startup files were not rewritten\.)/.test(line))) {
      advisory.push(line);
    } else required.push(line);
    if (completion && line.includes('Startup files were not rewritten.')) completion = false;
  }
  return { advisory: advisory.join('\n'), required: required.join('\n') };
}
export const nativeGenerationReady = (result, target) => result?.state === 'ready' && result?.version === target;
export const cliReportsVersion = (output, target) => output.trim().split(/\r?\n/, 1)[0] === `cotal-ai ${target}`;
export const selectedTargets = output => [...new Set([...output.matchAll(/(?:installing cotal-ai@|(?:repaired and )?updated to |updating to )(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gi)].map(match => match[1]))];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function exclusion({ layout, method, state }, platform = process.platform) {
  if (layout === 'installer' && platform === 'win32') return 'No public Windows installer exists.';
  if (method === 'installer' && layout !== 'installer') return 'Installer rerun would change the npm-global installation route.';
  if (method === 'scheduler' && state !== 'daemon') return 'Scheduler rows require the pre-existing automatic daemon state.';
  return undefined;
}
export function verifyDesktopRuntime(directory) {
  const manifest = json(join(directory, 'desktop-runtime.json'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, '0.164.2', 'ownership proof uses approved desktop release');
  for (const file of manifest.files) {
    const path = resolve(directory, file.path);
    assert(path.startsWith(resolve(directory) + '/'), 'desktop inventory path escapes runtime');
    assert.equal(digest(readFileSync(path)), file.sha256, `released desktop runtime bytes changed: ${file.path}`);
  }
  return { version: manifest.version, target: manifest.target, files: manifest.files.length, sha256: digest(readFileSync(join(directory, 'desktop-runtime.json'))) };
}

export function verifyCandidateInstaller(directory, script) {
  const identity = json(join(directory, 'installer.json'));
  const candidate = json(join(directory, 'manifest.json'));
  const result = { path: resolve(script), sha256: digest(readFileSync(script)), source: identity.source };
  assert.match(identity.source, /^[a-f0-9]{40}$/);
  assert.equal(identity.source, candidate.source, 'candidate installer and packed closure source differ');
  assert.equal(result.sha256, identity.sha256, 'candidate installer differs from packed source receipt');
  return result;
}

export function verifyPublishedInstaller(options) {
  assert(!options.candidate && !options['candidate-installer'], 'script override requires published tier');
  assert(options.layout === 'installer' && options.method === 'installer', 'script override requires installer rerun');
  assert.match(options['installer-source'] ?? '', /^[a-f0-9]{40}$/, 'installer source must be an immutable commit');
  assert.match(options['installer-sha256'] ?? '', /^[a-f0-9]{64}$/, 'installer hash must be SHA-256');
  const path = resolve(options['published-installer']);
  const sha256 = digest(readFileSync(path));
  assert.equal(sha256, options['installer-sha256'], 'published installer hash differs from receipt');
  return { path, source: options['installer-source'], sha256 };
}

export const cellExitCode = report => report.expectedRefusal
  ? (report.expectedRefusal.passed && !report.cleanupFailure && report.cleanupSafety?.passed !== false ? 0 : 1)
  : (['passed', 'excluded'].includes(report.result) && report.cleanupSafety?.passed !== false ? 0 : 1);

export function policyCoordinate(kind, { source, state, method, platform, layout = 'npm', candidate, stopAgents }) {
  if (candidate || stopAgents) return false;
  if (kind === 'missing-config') return layout === 'npm' && source === '0.160.7' && platform === 'linux' && state === 'fresh' && method === 'self';
  if (kind === 'legacy-seat') return layout === 'npm' && ['0.160.7', '0.163.5', '0.164.0'].includes(source) && state === 'agent' && method === 'self';
  return kind === 'unsupported-scheduler' && ['0.163.5', '0.164.0'].includes(source) && (platform === 'darwin' && layout === 'installer' || platform === 'win32' && layout === 'npm') && state === 'daemon' && method === 'scheduler';
}

export function policyRefusal(kind, update, config, daemon) {
  if (kind === 'missing-config') return update.exit === 1 && update.stdout === ''
    && update.stderr.trim() === `update snapshot refused: ENOENT: no such file or directory, lstat '${config}'`;
  if (kind === 'unsupported-scheduler') return daemon?.update?.automatic === false
    && daemon.update.lastResult === 'not checked. Automatic installation is available on Linux in this release. Run `cotal update --self` here';
  return kind === 'legacy-seat' && update.exit === 1 && update.stderr === ''
    && update.stdout.includes('! legacy manager custody: PTY continuity is impossible; this update is not a hot update')
    && update.stdout.includes('upgrade-proof-worker: drain-only')
    && (update.stdout.includes('Cannot determine this Manager\'s original hosting command. Obtain its exact stop and start commands before stopping it; do not infer a service instance from its Manager identity.')
      && update.stdout.includes('Next: stop this Manager through its original host, ending any seats listed above; run `cotal update --self`, then restart through that host with the original start command. This is a cold update, including for a Manager with 0 seats.')
      || update.stdout.includes('Next: stop that mesh with `cotal down --space upgrade-proof`, then run this update again; the stop ends the seats above, and the update after it is a cold one'));
}

export function expectedRecoveryRefusal(report) {
  const update = report.update;
  const allowed = ['upgrade exits successfully', 'no paused recovery record', 'no manual step or refusal'];
  return report.result === 'failed' && update?.exit === 1
    && update.stdout.includes('reconciliation did not complete')
    && update.stdout.includes('update --self to finish this update.')
    && update.stderr.includes('OPERATION_UNKNOWN')
    && !/installed in /i.test(update.stdout)
    && allowed.every(name => report.assertions.some(row => row.name === name && !row.passed))
    && report.assertions.filter(row => !row.passed).every(row => allowed.includes(row.name));
}

export function coordinates(platform = process.platform) {
  return sources.flatMap(source => ['npm', 'installer'].flatMap(layout => states.flatMap(state => methods.map(method => {
    const cell = { platform, source, layout, state, method };
    return { ...cell, excluded: exclusion(cell, platform) };
  }))));
}

function args() {
  const result = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(process.argv[i].startsWith('--') && process.argv[i + 1], 'use --name value arguments');
    result[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  return result;
}
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('COTAL_')) delete env[key];
  return { ...env, DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1' };
}
export function configureCandidateRegistry(home, registry) {
  const path = join(home, '.npmrc');
  if (existsSync(path)) assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'candidate npm config must be a regular file');
  const prior = existsSync(path) ? { bytes: readFileSync(path) } : undefined;
  const owned = Buffer.concat([prior?.bytes ?? Buffer.alloc(0), Buffer.from(`\nregistry=${registry}\n`)]);
  writeFileSync(path, owned, { mode: 0o600 });
  return () => {
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'candidate npm config ownership changed');
    assert.deepEqual(readFileSync(path), owned, 'candidate npm config changed during cell');
    if (prior) writeFileSync(path, prior.bytes);
    else unlinkSync(path);
  };
}
export async function policyRegistry(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      requests.push({ at: new Date().toISOString(), method: request.method, path });
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (decodeURIComponent(path) === '/cotal-ai') {
        const body = { name: 'cotal-ai', 'dist-tags': { latest: version }, versions: { [version]: { name: 'cotal-ai', version } } };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      } else { response.writeHead(404).end('policy observation only; no package archive or installation is served'); }
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { await new Promise(done => server.close(done)); return requests; } };
}
function npmCommand() {
  if (process.platform !== 'win32') return ['npm', []];
  const cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  assert(existsSync(cli), `npm CLI missing: ${cli}; no shell fallback`);
  return [process.execPath, [cli]];
}
function safeRoot(output) {
  const parent = hosted ? process.env.RUNNER_TEMP : '/var/tmp/upgrade-matrix';
  assert(parent && (hosted || process.platform === 'linux'), 'local runs require Linux private homes');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!hosted) assert.equal(statSync(parent).mode & 0o777, 0o700, 'private root must be mode 700');
  const disk = statfsSync(parent);
  assert(disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'STOP: less than 20 GiB free before installation');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(parent, 'cell-')));
}

export async function matrixCell(options) {
  const { source = 'latest', state = 'fresh', method = 'self', layout = 'npm' } = options;
  const nextHopMode = candidateNextOptions(options);
  const daemonHostedManager = daemonHostedManagerOptions(options);
  const policy = options['expect-policy-refusal'];
  if (policy) assert(policyCoordinate(policy, { source, state, method, layout, platform: process.platform, candidate: options.candidate, stopAgents: options['stop-agents'] === 'true' }), 'policy expectation requires a reproduced published coordinate');
  assert((sources.includes(source) || /^\d+\.\d+\.\d+$/.test(source)) && states.includes(state) && methods.includes(method) && ['npm', 'installer'].includes(layout), 'unknown matrix coordinate');
  const publishedInstaller = options['published-installer'] ? verifyPublishedInstaller({ ...options, layout, method }) : undefined;
  if (options['expect-recovery-refusal'] === 'true') assert(publishedInstaller && state === 'recovery', 'expected refusal requires a published installer override and recovery state');
  if (options['first-install'] === 'true') assert(publishedInstaller && options['installer-setup'] === 'true' && state === 'fresh' && source === 'latest', 'first install requires latest fresh fixed-script setup');
  const launchdProof = options['launchd-proof'];
  const publishedLaunchd = options['published-launchd'] === 'true';
  const windowsPolicy = options['windows-policy-baseline'] === 'true';
  const expectedTarget = options['expected-target'];
  const foreignSnapshot = options['foreign-config-snapshot'] === 'true';
  const containerManager = options['container-manager'] === 'true';
  if (containerManager) assert(hosted && process.platform === 'linux' && state === 'configured', 'container Manager cell requires disposable hosted Linux configured state');
  if (foreignSnapshot) assert(state === 'recovery' && process.platform === 'linux', 'foreign snapshot cell requires Linux recovery state');
  if (expectedTarget) assert.match(expectedTarget, /^\d+\.\d+\.\d+$/, 'expected target must be a stable published version');
  if (publishedLaunchd) assert(!options.candidate && macTransitionSource(source, expectedTarget, launchdProof), 'published launchd proof requires stable source >=0.164.6 below expected target transition');
  if (launchdProof) assert(hosted && process.platform === 'darwin' && (publishedLaunchd || options.candidate && (options.direction === 'A' || options.direction === 'B' && macTransitionSource(source, expectedTarget, launchdProof))) && state === 'daemon' && method === 'scheduler' && ['transition', 'off-before-tick', 'killed-before-result'].includes(launchdProof), 'launchd proof requires hosted macOS candidate-A, published or published-to-candidate scheduler');
  if (windowsPolicy) assert(hosted && process.platform === 'win32' && !options.candidate && source === '0.164.6' && layout === 'npm' && state === 'daemon' && method === 'scheduler', 'Windows policy baseline requires hosted published 0.164.6 npm daemon scheduler');
  const output = resolve(options.output ?? join(process.env.RUNNER_TEMP ?? '/var/tmp/upgrade-matrix', 'upgrade-evidence'));
  const variant = [options['stale-version'] ? `stale-${options['stale-version']}` : '', options['prior-status'] === 'true' ? 'prior-status' : '', options['desktop-runtime'] ? 'desktop-beside-cli' : '', options['stopped-daemon-before-update'] === 'true' ? 'stopped-daemon' : '', options['disabled-daemon-before-update'] === 'true' ? 'disabled-daemon' : '', options['stop-agents'] === 'true' ? 'stop-agents' : '', daemonHostedManager ? 'daemon-hosted-manager' : '', options['first-install'] === 'true' ? 'first-install' : '', options['follow-on-action'] ? `follow-on-${options['follow-on-action']}` : '', launchdProof ?? '', windowsPolicy ? 'windows-policy' : ''].filter(Boolean).join('-');
  const id = `${nextHopMode ? 'candidate-next-' : options.candidate ? `candidate-${options.direction ?? 'B'}-` : 'published-'}${process.platform}-${source}-${layout}-${state}-${method}${variant ? `-${variant}` : ''}`;
  const report = { tier: nextHopMode ? 'candidate-next (synthetic registry, real native processes)' : options.candidate ? `candidate-${options.direction ?? 'B'} (synthetic registry, real native processes)` : 'published', id, sourceRequested: source, platform: process.platform, layout, state, method, calls: [], assertions: [], startedAt: new Date().toISOString(), harnessSource: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim(), harnessSha256: digest(readFileSync(import.meta.filename)) };
  report.agentHost = state === 'agent' ? daemonHostedManager ? 'daemon' : 'standalone' : undefined;
  const omit = exclusion({ layout, method, state });
  if (omit) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    Object.assign(report, { result: 'excluded', reason: omit });
    save(join(output, `${id}.json`), report);
    console.log(JSON.stringify(report));
    return report;
  }
  assert(hosted || !['daemon', 'agent'].includes(state), 'REFUSED: native services and agent stacks require a disposable hosted runner');
  const root = safeRoot(output);
  const home = hosted && (state === 'daemon' || daemonHostedManager) ? homedir() : join(root, 'home');
  const prefix = layout === 'installer' ? (launchdProof ? join(root, 'installer') : join(home, '.local/share/cotal')) : join(root, 'prefix');
  const project = join(root, 'project');
  for (const dir of [home, project, prefix]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project, '.cotal'), { mode: 0o700 });
  const env = { ...cleanEnvironment(), HOME: home, USERPROFILE: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache') };
  env.TMPDIR = join(root, 'tmp');
  mkdirSync(env.TMPDIR, { mode: 0o700 });
  if (!(hosted && (state === 'daemon' || daemonHostedManager))) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'), XDG_RUNTIME_DIR: join(home, 'runtime'), LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming') });
  if (daemonHostedManager) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config') });
  if (options['desktop-runtime']) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config') });
  if (!hosted) env.COTAL_SKIP_CONNECTOR_SEED = '1';
  report.environment = { hostedDisposable: hosted, privateHome: home.startsWith(root), seedSkipped: env.COTAL_SKIP_CONNECTOR_SEED === '1', registryOverridden: Boolean(options.candidate), nativeServiceRequested: state === 'daemon' || daemonHostedManager, managerHostMode: daemonHostedManager ? 'daemon-hosted' : state === 'agent' ? 'standalone' : 'none' };
  for (const key of ['XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) if (env[key] && env[key].startsWith(root)) mkdirSync(env[key], { recursive: true, mode: 0o700 });
  const cotalHome = env.COTAL_HOME ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA, 'Cotal') : join(home, '.cotal'));
  const config = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cotal') : process.platform === 'win32' ? join(env.APPDATA, 'Cotal') : join(home, '.config/cotal');
  const desktopRuntime = options['desktop-runtime'] ? resolve(options['desktop-runtime']) : undefined;
  const desktopNode = options['desktop-node'] ? resolve(options['desktop-node']) : undefined;
  if (desktopRuntime) assert(hosted && state === 'daemon' && method === 'self' && desktopNode, 'real desktop ownership cell requires disposable runner, daemon state, self method and released bundled Node');
  const desktopInventory = desktopRuntime ? verifyDesktopRuntime(desktopRuntime) : undefined;
  const desktopHash = desktopInventory?.sha256;
  const modules = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  const pkg = join(modules, 'cotal-ai');
  const cli = join(pkg, 'dist/cotal.js');
  const launcher = launchdProof ? join(root, 'bin/cotal') : join(home, '.local/bin/cotal');
  if (launchdProof) {
    env.COTAL_INSTALL_DIR = prefix;
    env.COTAL_BIN_DIR = join(root, 'bin');
    report.environment.installerPrefix = 'per-cell custom prefix; native daemon uses normal runner HOME';
  }
  env.PATH = [dirname(launcher), join(prefix, process.platform === 'win32' ? '' : 'bin'), join(home, '.local/bin'), env.PATH].join(delimiter);
  const [npm, npmPrefix] = npmCommand();
  let uncertain = false, installedService = false, stackStarted = false, plan, receipt, holderPromise, releaseHolder, overlay, restoreRegistry, launchdObserver, offInventory, killControl, finalDaemon, container, compositionCleanup;
  const transcript = [];
  async function captureServiceEvidence(stage) {
    if (!installedService) return;
    report.daemonDiagnostics ??= {};
    try {
      report.daemonDiagnostics[stage] = await captureDaemonDiagnostics({
        cotalHome, daemonHome: report.daemonHome, config, output, id, stage, home, pkg,
        plan: { ...plan, globalRoot: modules },
        socket: process.platform === 'linux' && env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'cotal', 'daemon.sock') : undefined,
        startedAt: report.startedAt, platform: process.platform,
        cli: layout === 'installer' ? { file: launcher, args: [] } : { file: process.execPath, args: [cli] },
        run: (file, argv, bounds) => runDiagnosticCommand(file, argv, { cwd: project, env, timeoutMs: bounds.timeoutMs, maxBytes: bounds.maxBuffer }),
      });
    } catch (error) {
      report.daemonDiagnostics[stage] = { state: 'unreadable', error: error.message, observedAt: new Date().toISOString() };
    }
  }
  async function call(label, file, argv, timeout = callTimeout(label)) {
    if (/install|seed|upgrade under test|candidate second hop under test|candidate follow-on|manual npm/.test(label)) {
      const disk = statfsSync(root);
      assert(disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'STOP: less than 20 GiB free before installation action');
    }
    const startedAt = new Date().toISOString();
    const result = await new Promise(resolveCall => {
      const child = spawn(file, argv, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', timeoutHit = false;
      const timer = setTimeout(() => { timeoutHit = true; child.kill(); }, timeout);
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', error => { clearTimeout(timer); resolveCall({ exit: null, stdout, stderr, error: error.message }); });
      child.once('close', (exit, signal) => { clearTimeout(timer); resolveCall({ exit, signal, stdout, stderr, timeout: timeoutHit }); });
    });
    const finishedAt = new Date().toISOString();
    const entry = { label, file, argv, startedAt, finishedAt, elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt), ...result };
    report.calls.push(entry);
    transcript.push(`$ ${file} ${argv.join(' ')}\n${result.stdout}${result.stderr}\n[exit ${result.exit}]\n`);
    writeFileSync(join(output, `${id}.log`), transcript.join('\n'), { mode: 0o600 });
    if (result.exit === null || result.timeout || result.signal) {
      uncertain = true;
      // Only the authenticated old-source postlude deadline may reach the between-hop proof.
      // It remains uncertain unless that exact contract and the independent whole state pass.
      if (nextHopMode === 'source-0.164.10' && label === 'upgrade under test' && process.platform === 'darwin' && result.exit === null && result.signal === 'SIGTERM' && result.timeout === true) return { ...result, elapsedMs: entry.elapsedMs };
      throw new Error(`${label}: outcome unknown, retained for disposable runner teardown`);
    }
    return result;
  }
  const npmCall = (label, argv) => call(label, npm, [...npmPrefix, ...argv]);
  const cotal = (label, argv, timeout) => layout === 'installer' ? call(label, launcher, argv, timeout) : call(label, process.execPath, [cli, ...argv], timeout);
  const daemon = (label, argv, timeout) => desktopRuntime
    ? call(label, desktopNode, [join(desktopRuntime, 'dist/cotal.js'), ...argv], timeout)
    : cotal(label, argv, timeout);
  function ok(result, label) { assert.equal(result.exit, 0, `${label}: ${result.stdout}${result.stderr}`); return result; }
  function check(name, passed, observed) { report.assertions.push({ name, passed, observed }); }
  async function captureHostedManager(stage, target) {
    const space = report.managerHost.space;
    const observations = [];
    report.managerHost.observations ??= {};
    report.managerHost.observations[stage] = observations;
    const timeoutMs = callTimeout(`${stage} hosted Manager status`);
    const observed = await observeHostedManager({space, timeoutMs, observations,
      read: async (remaining, attempt) => {
        const status = await daemon(`${stage} hosted Manager status${attempt ? ` retry ${attempt}` : ''}`, ['daemon', 'status', '--space', space, '--json'], remaining);
        return status;
      }});
    const status = observed.status;
    const managers = JSON.parse(status.stdout).result.managers.filter(row => row.space === space);
    const seats = await cotal(`${stage} hosted Manager seats`, ['ps', '--on', managers[0].instanceId, '--space', space, '--json']);
    const bytes = Buffer.from(JSON.stringify({status, seats, observations}));
    const commands = {artifact: `${id}-${stage.replaceAll(' ', '-')}-hosted-manager.txt`, bytes: bytes.length, sha256: digest(bytes)};
    writeFileSync(join(output, commands.artifact), bytes, {flag: 'wx', mode: 0o600});
    const evidence = {space, status, seats, commands, observations, timeoutMs, observationWindow: {startedAt: observed.startedAt, deadline: observed.deadline}};
    const verified = hostedManagerRestored({evidence, output, target, calls: report.calls, stage});
    assert(verified.passed, 'hosted Manager must be restored with consented seats ended');
    return evidence;
  }
  async function installer(version, candidateTarget = false) {
    let script, label = 'public installer';
    if (publishedInstaller && (candidateTarget || options['installer-setup'] === 'true')) {
      report.publishedInstaller = verifyPublishedInstaller({ ...options, layout, method });
      script = report.publishedInstaller.path;
      label = 'receipt-bound published installer';
    } else if (candidateTarget === 'follow-on') {
      assert(options['candidate-follow-on'] && options['candidate-follow-on-installer'], 'follow-on installer requires follow-on closure and script');
      script = resolve(options['candidate-follow-on-installer']);
      report.candidateInstaller = verifyCandidateInstaller(resolve(options['candidate-follow-on']), script);
      label = 'candidate follow-on source installer';
    } else if ((candidateTarget || nextHopMode === 'candidate') && options['candidate-installer']) {
      assert(options.candidate, 'candidate installer is forbidden in published tier');
      script = resolve(options['candidate-installer']);
      report.candidateInstaller = verifyCandidateInstaller(resolve(options.candidate), script);
      label = 'candidate source installer';
    } else {
      const fetched = ok(await call('download public installer', 'curl', ['-fsSL', 'https://get.cotal.ai']), 'installer download');
      script = join(root, 'public-installer.sh');
      writeFileSync(script, fetched.stdout, { mode: 0o600 });
      report.installerSha256 = digest(fetched.stdout);
    }
    return call(label, 'sh', [script, '--version', version, '--no-setup', '--no-modify-path']);
  }
  try {
    const target = ok(await npmCall('resolve public latest', ['view', 'cotal-ai@latest', 'version', '--json']), 'public latest');
    report.target = JSON.parse(target.stdout);
    if (expectedTarget && !options.candidate) assert.equal(report.target, expectedTarget, 'public target differs from frozen release; do not certify another version');
    report.resolvedBeforeCell = report.target;
    if (nextHopMode) assertPublishedPairTarget(options, report.resolvedBeforeCell, json(join(options.candidate,'bootstrap.json')).version);
    report.source = source === 'latest' ? report.target : source;
    if (publishedLaunchd) assert.notEqual(report.target, report.source, 'next published release is not available yet');
    report.registry = ok(await npmCall('record npm registry', ['config', 'get', 'registry']), 'registry').stdout.trim();
    if (nextHopMode) {
      const { candidatePairRegistry } = await import('./candidate-pair-registry.mjs');
      overlay = options['candidate-follow-on']
        ? await candidatePairRegistry(resolve(options.candidate), resolve(options['candidate-next']), resolve(options['candidate-follow-on']), report.registry)
        : await candidatePairRegistry(resolve(options.candidate), resolve(options['candidate-next']), report.registry);
      report.candidateNext = overlay.identity;
      report.candidate = { source: overlay.identity.source, version: overlay.identity.sourceVersion, manifestSha256: overlay.identity.sourceManifestSha256, archives: overlay.identity.sourceArchives, direction: 'A' };
      if (nextHopMode === 'candidate') assert.equal(report.source, overlay.identity.sourceVersion, 'installed updater must be the frozen candidate A');
      report.target = nextHopMode === 'candidate' ? overlay.identity.targetVersion : overlay.identity.sourceVersion;
      if (expectedTarget) assert.equal(report.target, expectedTarget, 'paired target differs from the frozen coordinate');
      const finalTargetVersion = options['follow-on-action'] ? overlay.identity.followOnVersion : overlay.identity.targetVersion;
      if (options['next-hop-final-target']) assert.equal(finalTargetVersion, options['next-hop-final-target']);
      report.nextHop = { mode: nextHopMode, sourceVersion: report.source, firstTargetVersion: overlay.identity.sourceVersion, finalTargetVersion };
      env.npm_config_registry = overlay.url;
      restoreRegistry = configureCandidateRegistry(home, overlay.url);
    } else if (options.candidate) {
      overlay = await candidateRegistry(resolve(options.candidate), options.direction ?? 'B', report.registry);
      report.candidate = overlay.identity;
      const numeric = value => value.split('.').map(Number);
      const compare = (a, b) => { const left = numeric(a), right = numeric(b); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]; return 0; };
      assert((options.direction ?? 'B') === 'B' ? compare(overlay.identity.version, report.source) > 0 : compare(report.target, overlay.identity.version) > 0, 'candidate ordering must permit a real version-changing stock update');
      env.npm_config_registry = overlay.url;
      if ((options.direction ?? 'B') === 'B') report.target = overlay.identity.version;
      else report.source = overlay.identity.version;
      if (expectedTarget) assert.equal(report.target, expectedTarget, 'packed target differs from frozen version PR head');
      // Native services read npm's normal per-account config, not the launching shell's registry env.
      restoreRegistry = configureCandidateRegistry(home, overlay.url);
    }
    const sourceInstall = ok(layout === 'installer' ? await installer(report.source) : await npmCall(nextHopMode === 'candidate' ? 'install exact candidate source' : 'install published source', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.source}`, '--no-audit', '--no-fund']), 'source install');
    assert.equal(json(join(pkg, 'package.json')).version, report.source, 'source installed version');
    report.sourceManifestSha256 = digest(readFileSync(join(pkg, 'package.json')));
    if (process.platform === 'win32') {
      const core = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
      const prepare = `const {mkSecretDir}=await import(${JSON.stringify(core)});for(const dir of ${JSON.stringify([root, ...(home.startsWith(root) ? [home] : []), project])})mkSecretDir(dir);`;
      ok(await call('harden native fixture directories', process.execPath, ['--input-type=module', '-e', prepare]), 'published private-directory preparation');
    }
    if (options['prior-status'] === 'true') {
      report.priorStatus = await cotal('prior real user command: status', ['status']);
      report.configExistedAfterPriorStatus = existsSync(config);
    }
    if (state === 'daemon' && report.source === '0.155.0') {
      report.result = 'unsupported';
      report.refusal = "Published 0.155.0 has no automatic-update settings (--auto is unknown), so this state cannot be constructed through its CLI.";
      return report;
    }
    if (['configured', 'daemon', 'agent', 'concurrent', 'stale-extensions'].includes(state) && !(desktopRuntime && options['stopped-daemon-before-update'] !== 'true')) {
      ok(await cotal('seed published connectors', ['ext', 'seed']), 'connector setup');
      ok(await cotal('install published runtime', ['ext', 'add', `@cotal-ai/tmux@${report.source}`]), 'runtime setup');
    }
    if (state === 'stale-extensions') {
      const old = options['stale-version'] ?? (report.source === '0.155.0' ? '0.154.0' : '0.155.0');
      assert(/^\d+\.\d+\.\d+$/.test(old), 'stale extension version must be an exact release');
      const runtimes = options['stale-version'] ? ['tmux', 'cmux', 'orca', 'herdr'] : ['tmux'];
      for (const runtime of runtimes) ok(await cotal(`install older recorded runtime ${runtime}`, ['ext', 'add', `@cotal-ai/${runtime}@${old}`]), `older runtime ${runtime}`);
      report.staleRuntimes = runtimes;
      report.staleVersion = old;
    }
    if (options.prepare !== undefined) {
      assert.equal(typeof options.prepare, 'function', 'composition prepare must be an in-process callback, never a CLI string');
      compositionCleanup = await options.prepare({ env, project, pkg, root, config, cotalHome, call, cotal, check, report });
      assert(compositionCleanup === undefined || typeof compositionCleanup === 'function', 'composition prepare returns an optional owned cleanup callback');
    }
    if (containerManager) {
      assert(report.participant?.remote === true && report.participant?.localManagerStarted === false, 'container Manager regression requires a selected remote-user participant composition, not a local host control');
      check('host selected remote user-sign-in mesh before upgrade', report.participant.remote === true, report.participant);
      const directory = join(root, 'foreign-container');
      mkdirSync(directory, { mode: 0o700 });
      const tag = `cotal-upgrade-foreign-${process.pid}-${Date.now()}`;
      writeFileSync(join(directory, 'Dockerfile'), [
        'FROM nats:2.14.0 AS broker', 'FROM node:24-bookworm',
        'COPY --from=broker /nats-server /usr/local/bin/nats-server',
        'ENV DO_NOT_TRACK=1 COTAL_TELEMETRY=off',
        `RUN npm install -g cotal-ai@${report.source} --no-audit --no-fund`,
        'USER 23001:23001',
      ].join('\n') + '\n');
      ok(await call('build stock foreign container fixture', 'docker', ['build', '--tag', tag, directory], 600000), 'foreign container image');
      const script = 'set -eu; export HOME=/tmp/foreign-home COTAL_HOME=/tmp/foreign-home/.cotal XDG_CONFIG_HOME=/tmp/foreign-home/config; unset COTAL_SPACE; mkdir -p "$HOME" /tmp/project/.cotal; cd /tmp/project; cotal up --space foreign --open --detach --no-manager; cotal use foreign; exec cotal supervise';
      const label = `${id}-${Date.now()}`;
      const launched = ok(await call('start foreign stock supervise without space flag', 'docker', ['run', '--detach', '--name', tag, '--label', `cotal.upgrade.cell=${label}`, tag, 'sh', '-c', script]), 'foreign supervisor');
      const identity = launched.stdout.trim();
      assert.match(identity, /^[a-f0-9]{64}$/);
      container = { id: identity, label, image: tag };
      report.foreignContainer = container;
      for (let i = 0; i < 90; i++) {
        const inspected = ok(await call('observe owned foreign container', 'docker', ['inspect', container.id]), 'container inspection');
        const value = JSON.parse(inspected.stdout)[0];
        assert.equal(value.Id, container.id); assert.equal(value.Config.Labels['cotal.upgrade.cell'], label);
        const logs = await call('observe stock foreign Manager readiness', 'docker', ['logs', container.id]);
        if (!value.State.Running) throw new Error(`foreign stock supervisor exited before readiness: ${logs.stdout}${logs.stderr}`);
        if (/manager up/i.test(logs.stdout + logs.stderr)) {
          container.pid = value.State.Pid;
          container.startedAt = value.State.StartedAt;
          container.user = value.Config.User;
          assert.equal(container.user, '23001:23001');
          assert(Number.isSafeInteger(container.pid) && container.pid > 1);
          break;
        }
        await delay(1000);
      }
      assert(container.pid, 'stock foreign container reached manager up with an owned host PID');
      report.foreignContainer.pid1 = ok(await call('pin foreign container first process', 'docker', ['exec', container.id, 'sh', '-c', 'test -r /proc/1/cmdline && tr "\\000" " " < /proc/1/cmdline']), 'container first process');
      report.foreignContainer.pid1Supervise = /(?:^|\s)(?:[^ ]*\/)?cotal(?:\.js)? supervise\s*$/.test(report.foreignContainer.pid1.stdout);
      assert(report.foreignContainer.pid1Supervise, 'owned container first process must be the bare supervisor under test');
      report.foreignContainer.hostProcesses = ok(await call('record owned foreign supervisor host identity', 'docker', ['top', container.id, '-eo', 'pid,uid,args']), 'owned container process identity').stdout;
      report.foreignContainer.imageIdentity = ok(await call('record foreign image identity', 'docker', ['image', 'inspect', tag]), 'image identity').stdout;
    }
    if (state === 'recovery') {
      mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
      const snapshot = foreignSnapshot ? join(root, 'other-config-home', 'cotal', '.update-snapshot-foreign') : join(config, '.update-snapshot-missing');
      if (foreignSnapshot) {
        mkdirSync(snapshot, { recursive: true, mode: 0o700 });
        writeFileSync(join(snapshot, 'foreign-owner-sentinel'), 'belongs to a different config home; never touch\n', { mode: 0o600 });
        report.foreignSnapshot = { path: snapshot, sentinelSha256: digest(readFileSync(join(snapshot, 'foreign-owner-sentinel'))) };
      }
      const renames = ['extensions', ...['authority.bak.json', 'authority.json', 'reconcile.cursor.json', 'stamp.json', 'witness.json'].map(name => `seed/${name}`)].flatMap(name => [
        { from: join(config, name), to: join(snapshot, `failed-${name}`), done: true },
        { from: join(snapshot, name), to: join(config, name), done: true },
      ]);
      const fixture = { v: 1, previous: foreignSnapshot ? '0.13.1' : report.source, target: foreignSnapshot ? '0.13.2' : report.target, installed: 'unknown', phase: 'paused', reason: 'interrupted update restore failed: invalid update snapshot directory', owner: { pid: 2147483647, start: '0', nonce: 'fixture-not-a-credential' }, preparedRestart: false, snapshot, renames, recordedAt: new Date().toISOString() };
      save(join(cotalHome, 'update-recovery.json'), fixture);
      if (foreignSnapshot) save(join(cotalHome, 'update-attempt.json'), { version: report.source, failures: 1, result: 'interrupted update', next: Date.now() - 3 * 86400000 });
      report.syntheticFixture = foreignSnapshot ? 'paused journal refreshed now with completed renames and a real snapshot under another config home; separate old attempt clock' : 'paused recovery journal with a missing snapshot and completed rename entries';
      save(join(output, `${id}-recovery-before.json`), fixture);
    }
    if (['agent', 'concurrent'].includes(state)) {
      const fixture = join(root, 'native-fixture');
      mkdirSync(fixture, { mode: 0o700 });
      const core = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
      save(join(fixture, 'package.json'), { name: 'cotal-upgrade-native-fixture', version: report.target, type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } });
      const seat = join(fixture, 'seat.mjs');
      writeFileSync(seat, daemonHostedManager
        ? `import {CotalEndpoint} from ${JSON.stringify(core)};import {readFileSync} from 'node:fs';import {execFile} from 'node:child_process';const e=process.env;const cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(error,stdout)=>error?reject(error):resolve(stdout.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();setInterval(()=>{},1000);for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`
        : `import {CotalEndpoint} from ${JSON.stringify(core)};import {readFileSync} from 'node:fs';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,...(e.COTAL_CREDS?{creds:readFileSync(e.COTAL_CREDS,'utf8')}:{}),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();setInterval(()=>{},1000);for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`);
      const recorder = daemonHostedManager ? writeHostedSeatRecorder(fixture, seat) : undefined;
      const launchedSeat = recorder?.launcher ?? seat;
      const launchRecord = recorder ? `writeFileSync(${JSON.stringify(recorder.paths.launch)},JSON.stringify({recordedAt:new Date().toISOString(),name:o.name,id:o.id,lifecycleUid:o.lifecycleUid,space:o.space,command:process.execPath,args:[${JSON.stringify(launchedSeat)}],seat:${JSON.stringify(seat)},cwd:process.cwd(),managerPid:process.pid},null,2),{mode:0o600});` : '';
      const ready = join(root, 'writer-ready'), release = join(root, 'writer-release');
      releaseHolder = () => writeFileSync(release, 'release');
      writeFileSync(join(fixture, 'index.js'), `import {registry} from '@cotal-ai/core';import {existsSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';if(process.env.MATRIX_HOLD==='1'){writeFileSync(${JSON.stringify(ready)},'ready');const deadline=Date.now()+30000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('fixture writer deadline');await delay(50);}}registry.register({kind:'connector',name:'upgrade-standin',requires:['node'],buildLaunch:o=>{${launchRecord}return {command:process.execPath,args:[${JSON.stringify(launchedSeat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),...(o.userAuth?{COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd)}:{COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id)}),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}}}});`);
      if (state === 'agent' && daemonHostedManager) {
        assert(report.participant?.remote === true && report.participant?.localManagerStarted === false, 'daemon-hosted Manager requires prepared remote user-auth participant without a local Manager');
        const space = report.participant.space;
        assert(typeof space === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(space), 'prepared participant must name its space');
        report.managerHost = { mode: 'daemon-hosted', space };
        ok(await cotal('register daemon-hosted stand-in connector', ['ext', 'add', fixture]), 'hosted stand-in registration');
        const fixturePath = join(config, 'extensions/node_modules/cotal-upgrade-native-fixture');
        const fixtureFiles = ['package.json', 'index.js', 'seat.mjs', 'record-seat.mjs'];
        const fixtureMetadata = json(join(fixturePath, 'package.json'));
        assert.equal(fixtureMetadata.name, 'cotal-upgrade-native-fixture');
        assert.equal(fixtureMetadata.version, report.target);
        const files = Object.fromEntries(fixtureFiles.map(name => {
          const bytes = readFileSync(join(fixturePath, name));
          assert.equal(digest(bytes), digest(readFileSync(join(fixture, name))), 'installed local fixture differs from the owned source');
          return [name, digest(bytes)];
        }));
        report.ownedLocalFixture = {pkg: fixtureMetadata.name, spec: fixture, version: fixtureMetadata.version, path: fixturePath, realpath: realpathSync(fixturePath), files};
        const planned = ok(await daemon('hosted Manager native install plan', ['daemon', 'install', '--dry-run', '--json']), 'hosted native plan');
        plan = JSON.parse(planned.stdout).result;
        assert.equal(plan.state, 'would-install', 'hosted cell must own a new native service');
        report.daemonHome = plan.daemonHome ?? join(cotalHome, 'daemon');
        installedService = true;
        report.managerHost.setup = ok(await daemon('start documented daemon-hosted Manager', hostedManagerCommand(space)), 'daemon Manager setup');
        receipt = json(join(report.daemonHome, 'service-unit.json'));
        assert.equal(receipt.unit, plan.unit);
        assert.equal(receipt.unitSha256, digest(readFileSync(plan.unitPath)));
        const setup = JSON.parse(report.managerHost.setup.stdout).result;
        assert.equal(setup.manager?.state, 'answering');
        assert(setup.manager.instanceId, 'daemon setup must return answering Manager identity');
        report.managerHost.instanceId = setup.manager.instanceId;
        report.managerHost.spawn = await cotal('spawn real daemon-hosted agent', ['spawn', '--agent', 'upgrade-standin', '--on', setup.manager.instanceId, '--name', 'upgrade_proof_worker', '--detach', '--no-events', '--space', space]);
        report.managerHost.diagnostics = archiveHostedDiagnostics({ fixture, cotalHome, space, output, id });
        report.managerHost.launchObservation = await cotal('record daemon-hosted Manager launch inventory', ['ps', '--on', setup.manager.instanceId, '--space', space, '--json']);
        ok(report.managerHost.spawn, 'hosted spawn');
        report.agentBefore = ok(await cotal('confirm daemon-hosted seat', ['ps', '--on', setup.manager.instanceId, '--space', space, '--json']), 'hosted ps').stdout;
        const beforeSeats = JSON.parse(report.agentBefore).result;
        assert(beforeSeats.kind === 'seats' && beforeSeats.items?.length === 1 && beforeSeats.items[0].name === 'upgrade_proof_worker'
          && beforeSeats.managers?.length === 1 && beforeSeats.managers[0].instanceId === setup.manager.instanceId && beforeSeats.managers[0].state === 'answered', 'hosted consent requires one real answering seat before the update');
      } else if (state === 'agent') {
        report.managerHost = { mode: 'standalone', space: 'upgrade-proof' };
        ok(await cotal('register native stand-in connector', ['ext', 'add', fixture]), 'stand-in registration');
        ok(await cotal('prepare local stand-in space', ['setup', '--destination', 'local', '--harness', 'upgrade-standin', '--project', project, '--space', 'upgrade-proof', '--no-input', '--configure-only']), 'local setup');
        stackStarted = true;
        ok(await cotal('start local space', ['up', '--detach', '--space', 'upgrade-proof']), 'local stack');
        ok(await cotal('spawn real stand-in agent', ['spawn', '--agent', 'upgrade-standin', '--name', 'upgrade-proof-worker', '--detach', '--no-events', '--space', 'upgrade-proof']), 'stand-in spawn');
        report.agentBefore = ok(await cotal('confirm native stand-in seat', ['ps', '--space', 'upgrade-proof', '--json']), 'stand-in ps').stdout;
      } else {
        env.MATRIX_HOLD = '1';
        holderPromise = cotal('concurrent real extension writer', ['ext', 'add', fixture]);
        delete env.MATRIX_HOLD;
        for (let i = 0; i < 300 && !existsSync(ready); i++) await delay(50);
        assert(existsSync(ready), 'real CLI writer reached import while holding installation');
        report.contentionFixture = 'real ext add held during connector import by a fixture-only module gate';
        setTimeout(releaseHolder, 2500);
      }
    }
    if (windowsPolicy) {
      report.tier = 'published product; metadata-only newer-version policy probe';
      report.policyBaseline = { installed: report.source, publicLatest: report.target, advertised: '0.164.7', registry: 'metadata-only newer visible; no candidate product or archive served' };
      assert.equal(report.source, '0.164.6');
      overlay = await policyRegistry(report.policyBaseline.advertised);
      env.npm_config_registry = overlay.url;
      restoreRegistry = configureCandidateRegistry(home, overlay.url);
      report.policyBaseline.inventoryBefore = { package: digest(readFileSync(join(pkg, 'package.json'))), cli: digest(readFileSync(cli)) };
    }
    if (state === 'daemon') {
      const planned = ok(await daemon('native install plan', ['daemon', 'install', '--dry-run', '--json']), 'native plan');
      plan = JSON.parse(planned.stdout).result;
      assert.equal(plan.state, 'would-install', 'native service must be absent before this cell');
      report.daemonHome = plan.daemonHome ?? join(cotalHome, 'daemon');
      const priorAutoSkip = env.COTAL_SKIP_CONNECTOR_SEED;
      if (desktopRuntime) env.COTAL_SKIP_CONNECTOR_SEED = '1';
      try {
        report.automaticSettings = ok(await cotal('set automatic updates before native service', ['update', '--auto', method === 'self' || launchdProof === 'off-before-tick' ? 'off' : 'on']), 'automatic settings');
      } finally {
        if (desktopRuntime) {
          if (priorAutoSkip === undefined) delete env.COTAL_SKIP_CONNECTOR_SEED;
          else env.COTAL_SKIP_CONNECTOR_SEED = priorAutoSkip;
        }
      }
      if (windowsPolicy) report.policyBaseline.settingsBeforeInstall = json(join(cotalHome, 'update-settings.json'));
      installedService = true;
      ok(await daemon('native install', ['daemon', 'install', '--json']), 'native installation');
      receipt = json(join(report.daemonHome, 'service-unit.json'));
      assert.equal(receipt.unit, plan.unit);
      assert.equal(receipt.unitSha256, digest(readFileSync(plan.unitPath)));
      for (let i = 0; i < 60; i++) {
        const status = await daemon('native status before', ['daemon', 'status', '--json']);
        if (status.exit === 0 && JSON.parse(status.stdout).result?.state === 'ready') {
          report.daemonBefore = JSON.parse(status.stdout).result;
          break;
        }
        await delay(1000);
      }
      assert(report.daemonBefore, 'native daemon ready before update');
      if (method === 'self' && !desktopRuntime) {
        const manualReady = report.daemonBefore.version === report.source && report.daemonBefore.update?.automatic === false
          && Array.isArray(report.daemonBefore.managers) && report.daemonBefore.managers.length === 0
          && Array.isArray(report.daemonBefore.agents) && report.daemonBefore.agents.length === 0;
        check('manual native service starts at source with scheduler disabled', manualReady, report.daemonBefore);
        assert(manualReady, 'manual update must start at the source with no Manager, agent or competing scheduler');
      }
      if (desktopRuntime) {
        const unitText = readFileSync(plan.unitPath, 'utf8');
        const execLine = /^ExecStart=(.*)$/m.exec(unitText)?.[1] ?? '';
        const execArgv = [...execLine.matchAll(/"((?:\\.|[^"\\])*)"|([^\s"]+)/g)].map(match => (match[1] ?? match[2]).replace(/\\([\\"])/g, '$1').replaceAll('%%', '%').replaceAll('$$', '$'));
        const daemonIdx = execArgv.indexOf('daemon');
        const desktopEntry = daemonIdx >= 2 ? execArgv[daemonIdx - 1] : execArgv[0];
        assert.equal(desktopEntry, join(desktopRuntime, 'dist/cotal.js'), 'recorded desktop unit entry must match released desktop runtime');
        report.desktop = { runtime: desktopRuntime, entry: desktopEntry, inventory: desktopInventory, nodeSha256: digest(readFileSync(desktopNode)), release: 'v0.164.2', workflowRun: 43456519342 };
        assert.equal(report.daemonBefore.version, '0.164.2');
        assert.equal(report.daemonBefore.update.channel, 'desktop');
        assert.equal(report.daemonBefore.update.automatic, false);
        assert(unitText.includes(desktopRuntime), 'native service source must name actual released desktop runtime');
        if (options['stopped-daemon-before-update'] !== 'true' && report.participant?.space) {
          const space = report.participant.space;
          const desktopFixture = join(root, 'desktop-standin');
          mkdirSync(desktopFixture, { mode: 0o700 });
          save(join(desktopFixture, 'package.json'), { name: 'cotal-upgrade-native-fixture', version: report.target, type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } });
          writeFileSync(join(desktopFixture, 'seat.mjs'), 'setInterval(()=>{},1000);\n');
          writeFileSync(join(desktopFixture, 'record-seat.mjs'), 'export {};\n');
          writeFileSync(join(desktopFixture, 'index.js'), "import {registry} from '@cotal-ai/core';registry.register({kind:'connector',name:'desktop-standin',requires:['node'],buildLaunch:()=>({command:process.execPath,args:['-e','setInterval(()=>{},1000)']})});\n");
          ok(await daemon('seed desktop runtime connectors before Manager setup', ['ext', 'seed']), 'desktop connector seed');
          ok(await daemon('register desktop stand-in connector', ['ext', 'add', desktopFixture]), 'desktop stand-in registration');
          const fixturePath = join(config, 'extensions/node_modules/cotal-upgrade-native-fixture');
          const fixtureFiles = ['package.json', 'index.js', 'seat.mjs', 'record-seat.mjs'];
          const fixtureMetadata = json(join(fixturePath, 'package.json'));
          const files = Object.fromEntries(fixtureFiles.map(name => [name, digest(readFileSync(join(fixturePath, name)))]));
          report.ownedLocalFixture = { pkg: fixtureMetadata.name, spec: desktopFixture, version: fixtureMetadata.version, path: fixturePath, realpath: realpathSync(fixturePath), files };
          const desktopSetup = ok(await daemon('start desktop-hosted Manager before CLI update', hostedManagerCommand(space)), 'desktop Manager setup');
          const setupResult = JSON.parse(desktopSetup.stdout).result;
          assert.equal(setupResult.manager?.state, 'answering');
          assert(setupResult.manager?.instanceId, 'desktop setup must return answering Manager identity');
          report.desktop.hostedManager = { space, instanceId: setupResult.manager.instanceId, setup: desktopSetup };
          const statusWithManager = ok(await daemon('native status with desktop Manager before', ['daemon', 'status', '--json']), 'native status with desktop Manager');
          report.daemonBefore = JSON.parse(statusWithManager.stdout).result;
          const priorSkip = env.COTAL_SKIP_CONNECTOR_SEED;
          env.COTAL_SKIP_CONNECTOR_SEED = '1';
          try {
            ok(await cotal('install published runtime', ['ext', 'add', `@cotal-ai/tmux@${report.source}`]), 'runtime setup');
          } finally {
            if (priorSkip === undefined) delete env.COTAL_SKIP_CONNECTOR_SEED;
            else env.COTAL_SKIP_CONNECTOR_SEED = priorSkip;
          }
          report.extensionsBefore = existsSync(join(config, 'extensions/extensions.json')) ? json(join(config, 'extensions/extensions.json')).extensions : [];
        }
      }
      if (needsSchedulerEligibility({ method, platform: process.platform, launchdProof, windowsPolicy, policy })) {
        // Native custody observation runs asynchronously after the socket first becomes ready.
        await waitForSchedulerEligibility(report, remaining => cotal('wait for verified native scheduler custody', ['daemon', 'status', '--json'], remaining));
      }
    }
    report.extensionsBefore = existsSync(join(config, 'extensions/extensions.json')) ? json(join(config, 'extensions/extensions.json')).extensions : [];
    const sourceInventory = () => [join(pkg, 'package.json'), cli, join(config, 'extensions/extensions.json'), ...report.extensionsBefore.map(entry => join(config, 'extensions/node_modules', entry.pkg, 'package.json'))].map(path => ({ path, sha256: existsSync(path) ? digest(readFileSync(path)) : null }));
    if (policy) report.policyInventoryBefore = sourceInventory();
    report.sourceInventoryBeforeAction = sourceInventory();
    report.targetBeforeAction = report.target;
    report.versionChanging = report.source !== report.target;
    if (nextHopMode && options['next-hop-phase'] === 'published') {
      const observed = ok(await npmCall('resolve frozen public A immediately before paired action', ['view','cotal-ai@latest','version','--json','--registry=https://registry.npmjs.org/']), 'public A before paired action');
      report.publicPairTargetBeforeAction = JSON.parse(observed.stdout);
      assertPublishedPairTarget(options, report.publicPairTargetBeforeAction, report.candidateNext.sourceVersion);
    }
    if (!options.candidate && !windowsPolicy) {
      report.target = JSON.parse(ok(await npmCall('resolve public latest immediately before action', ['view', 'cotal-ai@latest', 'version', '--json']), 'latest before action').stdout);
      if (expectedTarget) assert.equal(report.target, expectedTarget, 'public target changed before action; do not certify another release');
      report.versionChanging = report.source !== report.target;
    }
    if (launchdProof) {
      const native = await import(pathToFileURL(join(pkg, 'node_modules/@cotal-ai/seat/dist/index.js')).href);
      if (launchdProof === 'killed-before-result') killControl = createPreResultKill({ home: cotalHome, native, output, id, daemonPid: report.daemonBefore.pid });
      launchdObserver = observeMacHandoff({ home: cotalHome, daemonHome: report.daemonHome, output, id, native, control: killControl, intervalMs: killControl ? 20 : 100 });
      await launchdObserver.sample();
      report.launchdProof = { kind: launchdProof, publicTarget: report.target };
      if (launchdProof === 'off-before-tick') offInventory = { package: digest(readFileSync(join(pkg, 'package.json'))), cli: digest(readFileSync(cli)), extensions: existsSync(join(config, 'extensions/extensions.json')) ? digest(readFileSync(join(config, 'extensions/extensions.json'))) : undefined };
    }
    if (options['stopped-daemon-before-update'] === 'true') {
      const stopCommand = process.platform === 'linux'
        ? ok(await call('stop native daemon before manual repair', 'systemctl', ['--user', '--no-ask-password', '--no-pager', 'stop', receipt.unit]), 'stop native daemon before manual repair')
        : process.platform === 'darwin'
          ? ok(await call('stop native daemon before manual repair', '/bin/launchctl', ['bootout', `gui/${process.getuid()}/${receipt.unit}`]), 'stop native daemon before manual repair')
          : ok(await call('stop native daemon before manual repair', join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'schtasks.exe'), ['/End', '/TN', receipt.unit]), 'stop native daemon before manual repair');
      let stoppedStatus = await daemon('stopped daemon status before manual repair', ['daemon', 'status', '--json']);
      for (let i = 0; i < 60 && stoppedStatus.exit === 0; i++) {
        await delay(500);
        stoppedStatus = await daemon('stopped daemon status before manual repair', ['daemon', 'status', '--json']);
      }
      const stoppedBytes = Buffer.from(JSON.stringify({ stopCommand, statusWhileStopped: stoppedStatus }));
      const stoppedCommands = { artifact: `${id}-stopped-daemon-before-update.txt`, bytes: stoppedBytes.length, sha256: digest(stoppedBytes) };
      writeFileSync(join(output, stoppedCommands.artifact), stoppedBytes, { flag: 'wx', mode: 0o600 });
      const stoppedPassed = stopCommand.exit === 0 && stopCommand.signal === null && stopCommand.timeout === false
        && stoppedStatus.exit === 2 && stoppedStatus.signal === null && stoppedStatus.timeout === false;
      report.stoppedDaemonBeforeUpdate = { passed: stoppedPassed, unit: receipt.unit, stopCommand, statusWhileStopped: stoppedStatus, commands: stoppedCommands };
      check('native daemon confirmed stopped before manual update', stoppedPassed, report.stoppedDaemonBeforeUpdate);
      assert(stoppedPassed, 'native daemon must be confirmed stopped before manual update');
    }
    if (options['disabled-daemon-before-update'] === 'true') {
      assert(['linux', 'darwin'].includes(process.platform), 'disabled-daemon-before-update requires Linux systemd or macOS launchd user service');
      let disableCommand, stopCommand, unitShowBefore;
      if (process.platform === 'linux') {
        disableCommand = ok(await call('disable native daemon before manual update', 'systemctl', ['--user', '--no-ask-password', '--no-pager', 'disable', '--now', receipt.unit]), 'disable native daemon before manual update');
      } else {
        const gui = `gui/${process.getuid()}`;
        disableCommand = ok(await call('disable native daemon before manual update', '/bin/launchctl', ['disable', `${gui}/${receipt.unit}`]), 'disable native daemon before manual update');
        stopCommand = ok(await call('stop native daemon before manual update', '/bin/launchctl', ['bootout', `${gui}/${receipt.unit}`]), 'stop native daemon before manual update');
      }
      let disabledStatus = await daemon('disabled daemon status before manual update', ['daemon', 'status', '--json']);
      for (let i = 0; i < 60 && disabledStatus.exit === 0; i++) {
        await delay(500);
        disabledStatus = await daemon('disabled daemon status before manual update', ['daemon', 'status', '--json']);
      }
      unitShowBefore = process.platform === 'linux'
        ? ok(await call('disabled unit show before manual update', 'systemctl', ['--user', '--no-ask-password', '--no-pager', 'show', receipt.unit, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID']), 'disabled unit show before manual update')
        : ok(await call('disabled unit show before manual update', '/bin/launchctl', ['print-disabled', `gui/${process.getuid()}`]), 'disabled unit show before manual update');
      const disabledBytes = Buffer.from(JSON.stringify({ disableCommand, ...(stopCommand ? { stopCommand } : {}), statusWhileDisabled: disabledStatus, unitShowBefore }));
      const disabledCommands = { artifact: `${id}-disabled-daemon-before-update.txt`, bytes: disabledBytes.length, sha256: digest(disabledBytes) };
      writeFileSync(join(output, disabledCommands.artifact), disabledBytes, { flag: 'wx', mode: 0o600 });
      const unitDisabledBefore = process.platform === 'linux'
        ? /ActiveState=inactive/.test(unitShowBefore.stdout) && /UnitFileState=disabled/.test(unitShowBefore.stdout) && /MainPID=0/.test(unitShowBefore.stdout)
        : new RegExp(`"${receipt.unit.replaceAll('.', '\\.')}" => (?:true|disabled)`).test(unitShowBefore.stdout);
      const disabledPassed = disableCommand.exit === 0 && disableCommand.signal === null && disableCommand.timeout === false
        && (!stopCommand || (stopCommand.exit === 0 && stopCommand.signal === null && stopCommand.timeout === false))
        && disabledStatus.exit === 2 && disabledStatus.signal === null && disabledStatus.timeout === false
        && unitDisabledBefore;
      report.disabledDaemonBeforeUpdate = { passed: disabledPassed, unit: receipt.unit, disableCommand, ...(stopCommand ? { stopCommand } : {}), statusWhileDisabled: disabledStatus, unitShowBefore, commands: disabledCommands };
      check('native daemon confirmed disabled and stopped before manual update', disabledPassed, report.disabledDaemonBeforeUpdate);
      assert(disabledPassed, 'native daemon must be confirmed disabled and stopped before manual update');
    }
    await captureServiceEvidence('before-update');
    if (nextHopMode === 'candidate') {
      report.candidateSourceInvocation = candidateSourceIdentity({ pkg, cli, identity: report.candidateNext, argv: [cli, 'update', '--self'] });
      check('candidate source CLI matches packed artifact', true, report.candidateSourceInvocation);
      overlay.activateTarget();
    }
    let update;
    if (options['first-install'] === 'true') update = sourceInstall;
    else if (method === 'self') {
      update = await cotal('upgrade under test', ['update', '--self', ...(options['stop-agents'] === 'true' ? ['--stop-agents'] : [])]);
      if (nextHopMode === 'source-0.164.10') {
        const firstCall = report.calls.findLast(row => row.label === 'upgrade under test');
        report.nextHop.firstHop = { update: { ...update, elapsedMs: firstCall.elapsedMs } };
        // The complete failed-hop state is captured before matching, retrying or cleaning anything.
        await captureServiceEvidence('between-hops');
        const status = await daemon('between hops public daemon status', ['daemon', 'status', '--json']);
        const updateCheck = await cotal('between hops public update check', ['update', '--check']);
        const commandBytes = Buffer.from(JSON.stringify({status,updateCheck}));
        const commands = {artifact:`${id}-between-hop-commands.txt`,bytes:commandBytes.length,sha256:digest(commandBytes)};
        writeFileSync(join(output,commands.artifact),commandBytes,{flag:'wx',mode:0o600});
        report.nextHop.intermediate = intermediateWholeMachine({ diagnostics: report.daemonDiagnostics['between-hops'], output, target: report.candidateNext.sourceVersion, platform: process.platform, status, updateCheck, commands });
        if (daemonHostedManager) report.nextHop.intermediate.hostedManager = await captureHostedManager('between hops', report.candidateNext.sourceVersion);
        report.nextHop.firstHop.refusal = matchSource16410Refusal({ platform: process.platform, layout, sourceVersion: report.source, targetVersion: report.candidateNext.sourceVersion, update: report.nextHop.firstHop.update });
        check('source 0.164.10 matches measured postlude refusal', true, report.nextHop.firstHop.refusal);
        check('source 0.164.10 refusal leaves a whole machine', report.nextHop.intermediate.passed, report.nextHop.intermediate);
        assert(report.nextHop.intermediate.passed, 'source 0.164.10 refused hop did not independently leave a whole machine');
        if (uncertain) {
          const unknown = report.calls.filter(row => row.exit === null || row.timeout || row.signal);
          assert(unknown.length === 1 && unknown[0] === firstCall, 'another unknown command cannot inherit the source deadline contract');
          uncertain = false;
        }
        report.candidateSourceInvocation = candidateSourceIdentity({ pkg, cli, identity: report.candidateNext, argv: [cli, 'update', '--self'] });
        check('candidate source CLI matches packed artifact', true, report.candidateSourceInvocation);
        overlay.activateTarget();
        report.target = report.candidateNext.targetVersion;
        update = await cotal('candidate second hop under test', ['update', '--self']);
      }
      if (nextHopMode) {
        report.nextHop.secondHop = { update };
        report.nextHop.passed = update.exit === 0 && update.signal === null && update.timeout === false;
        check('candidate next target matches packed artifact', report.target === report.candidateNext.targetVersion, report.target);
        check('candidate next hop exits successfully', update.exit === 0 && update.signal === null && update.timeout === false, update);
        if (options['follow-on-action']) {
          const followOnAction = options['follow-on-action'];
          await captureServiceEvidence('between-hops');
          const status = await daemon('between hops public daemon status', ['daemon', 'status', '--json']);
          const updateCheck = await cotal('between hops public update check', ['update', '--check']);
          const commandBytes = Buffer.from(JSON.stringify({ status, updateCheck }));
          const commands = { artifact: `${id}-between-hop-commands.txt`, bytes: commandBytes.length, sha256: digest(commandBytes) };
          writeFileSync(join(output, commands.artifact), commandBytes, { flag: 'wx', mode: 0o600 });
          report.nextHop.intermediate = intermediateWholeMachine({ diagnostics: report.daemonDiagnostics['between-hops'], output, target: report.candidateNext.targetVersion, platform: process.platform, expectedPackageManagerVersion: report.candidateNext.sourceVersion, status, updateCheck, commands });
          check('candidate first hop leaves a whole machine', report.nextHop.intermediate.passed, report.nextHop.intermediate);
          assert(report.nextHop.intermediate.passed, 'candidate first hop did not independently leave a whole machine before follow-on action');
          overlay.activateFollowOn();
          report.target = report.candidateNext.followOnVersion;
          let npmInstall, bareNpmObservation;
          if (followOnAction === 'self') {
            update = await cotal('candidate follow-on self update under test', ['update', '--self']);
          } else if (followOnAction === 'npm') {
            npmInstall = ok(await npmCall('manual npm install follow-on target', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.target}`, '--no-audit', '--no-fund']), 'manual npm follow-on install');
            const bareVersion = await cotal('bare manual npm CLI version observation', ['--version']);
            const bareRoute = inspectInstalledUpdateRoute(pkg, process.platform);
            const bareManifest = join(config, 'extensions/extensions.json');
            const bareExtensions = existsSync(bareManifest) ? json(bareManifest).extensions : [];
            const bareInstalledExtensions = bareExtensions.map(entry => {
              const path = join(config, 'extensions/node_modules', entry.pkg);
              const metadata = existsSync(join(path, 'package.json')) ? json(join(path, 'package.json')) : undefined;
              return { pkg: entry.pkg, version: metadata?.version };
            });
            const bareRecovery = existsSync(join(cotalHome, 'update-recovery.json')) ? json(join(cotalHome, 'update-recovery.json')) : null;
            let bareDaemonStatus = await daemon('bare manual npm daemon status', ['daemon', 'status', '--json']);
            for (let i = 0; i < 60; i++) {
              if (bareDaemonStatus.exit === 0 && nativeGenerationReady(JSON.parse(bareDaemonStatus.stdout).result, report.target)) break;
              await delay(1000);
              bareDaemonStatus = await daemon('wait for bare manual npm daemon generation', ['daemon', 'status', '--json']);
            }
            const bareDaemon = bareDaemonStatus.exit === 0 ? JSON.parse(bareDaemonStatus.stdout).result : undefined;
            const bareRuntimes = await cotal('bare manual npm runtimes observation', ['runtimes', '--json']);
            const bareTmuxRow = [0, 4].includes(bareRuntimes.exit) ? JSON.parse(bareRuntimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
            const remedyPresent = /Reconciliation pending: Run `cotal update --self` to reconcile this installation\./.test(bareVersion.stdout);
            const bareExtensionsAccounted = bareExtensions.length >= 8 && bareExtensions.every(entry => {
              const installed = bareInstalledExtensions.find(row => row.pkg === entry.pkg);
              if (!installed || installed.version !== entry.version) return false;
              if (entry.version === report.target) return true;
              return entry.version === report.candidateNext.targetVersion && remedyPresent;
            });
            env.npm_config_registry = 'http://127.0.0.1:1';
            const restoreBrokenRegistry = configureCandidateRegistry(home, 'http://127.0.0.1:1');
            let launchGateRefusal;
            try {
              launchGateRefusal = await cotal('bare manual npm launch gate refusal when registry unreachable', ['space', 'forget', 'manual-npm-gate-probe']);
            } finally {
              restoreBrokenRegistry();
              env.npm_config_registry = overlay.url;
            }
            const refusalExtensions = existsSync(bareManifest) ? json(bareManifest).extensions : [];
            const refusalInstalledExtensions = refusalExtensions.map(entry => {
              const path = join(config, 'extensions/node_modules', entry.pkg);
              const metadata = existsSync(join(path, 'package.json')) ? json(join(path, 'package.json')) : undefined;
              return { pkg: entry.pkg, version: metadata?.version };
            });
            const launchGateReconcile = await cotal('bare manual npm launch gate reconciles official extensions', ['space', 'forget', 'manual-npm-gate-probe']);
            const launchGateVersion = await cotal('bare manual npm version after launch gate', ['--version']);
            const launchGateRuntimes = await cotal('bare manual npm runtimes after launch gate', ['runtimes', '--json']);
            const launchGateTmuxRow = launchGateRuntimes.exit === 0 ? JSON.parse(launchGateRuntimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
            const launchGateExtensions = existsSync(bareManifest) ? json(bareManifest).extensions : [];
            const launchGateInstalledExtensions = launchGateExtensions.map(entry => {
              const path = join(config, 'extensions/node_modules', entry.pkg);
              const metadata = existsSync(join(path, 'package.json')) ? json(join(path, 'package.json')) : undefined;
              return { pkg: entry.pkg, version: metadata?.version };
            });
            const priorSkipSeed = env.COTAL_SKIP_CONNECTOR_SEED;
            env.COTAL_SKIP_CONNECTOR_SEED = '1';
            try {
              ok(await cotal('reset tmux to B before scheduled reconciliation', ['ext', 'add', `@cotal-ai/tmux@${report.candidateNext.targetVersion}`]), 'reset tmux to B');
            } finally {
              if (priorSkipSeed === undefined) delete env.COTAL_SKIP_CONNECTOR_SEED;
              else env.COTAL_SKIP_CONNECTOR_SEED = priorSkipSeed;
            }
            const pendingBeforeScheduled = await cotal('manual npm version before scheduled reconciliation', ['--version']);
            ok(await cotal('enable automatic updates for manual npm scheduled reconciliation', ['update', '--auto', 'on']), 'enable automatic updates');
            await waitForSchedulerEligibility({ ...report, source: report.target, daemonBefore: undefined }, remaining => daemon('wait for manual npm scheduler custody', ['daemon', 'status', '--json'], remaining));
            for (let i = 0; i < 40 && !existsSync(join(cotalHome, 'update-check.json')); i++) await delay(1000);
            if (!existsSync(join(cotalHome, 'update-check.json'))) await cotal('populate manual npm update check cache', ['update', '--check']);
            const agedAt = Date.now() - 25 * 3600000;
            for (const [name, fields] of [['update-check.json', ['checkedAt', 'firstSeenAt', 'attemptedAt']], ['update-attempt.json', ['next']]]) {
              const file = join(cotalHome, name);
              if (!existsSync(file)) continue;
              const current = json(file);
              const next = { ...current };
              for (const field of fields) next[field] = agedAt;
              save(file, next);
            }
            const scheduleDeadline = Date.now() + 180000;
            let scheduledAttempt;
            while (Date.now() < scheduleDeadline) {
              await delay(3000);
              const curAttempt = existsSync(join(cotalHome, 'update-attempt.json')) ? json(join(cotalHome, 'update-attempt.json')) : null;
              const curExts = existsSync(bareManifest) ? json(bareManifest).extensions : [];
              const launchdBusy = existsSync(join(cotalHome, 'update-launchd.json')) || existsSync(join(cotalHome, 'update-launchd-result.json'));
              if (curAttempt?.version === report.target && curAttempt?.result === `updated to ${report.target}` && !launchdBusy && curExts.length >= 8 && curExts.every(entry => entry.version === report.target)) {
                scheduledAttempt = curAttempt;
                break;
              }
            }
            const scheduledVersion = await cotal('manual npm version after scheduled reconciliation', ['--version']);
            const scheduledRuntimes = await cotal('manual npm runtimes after scheduled reconciliation', ['runtimes', '--json']);
            const scheduledTmuxRow = scheduledRuntimes.exit === 0 ? JSON.parse(scheduledRuntimes.stdout).result?.items?.find(row => row.name === 'tmux') : undefined;
            const scheduledDaemonStatus = await daemon('manual npm daemon status after scheduled reconciliation', ['daemon', 'status', '--json']);
            const scheduledExtensions = existsSync(bareManifest) ? json(bareManifest).extensions : [];
            const scheduledInstalledExtensions = scheduledExtensions.map(entry => {
              const path = join(config, 'extensions/node_modules', entry.pkg);
              const metadata = existsSync(join(path, 'package.json')) ? json(join(path, 'package.json')) : undefined;
              return { pkg: entry.pkg, version: metadata?.version };
            });
            ok(await cotal('disable automatic updates after manual npm scheduled reconciliation', ['update', '--auto', 'off']), 'disable automatic updates');
            const bareChecks = {
              cliAtTargetWithExitZero: bareVersion.exit === 0 && bareVersion.signal === null && bareVersion.timeout === false && cliReportsVersion(bareVersion.stdout, report.target) && bareRoute.selectedCliVersion === report.target && bareRoute.packageManagerRecordVersion === report.target,
              routeInPlace: bareRoute.updateRoute === 'in-place',
              daemonAtTarget: bareDaemonStatus.exit === 0 && nativeGenerationReady(bareDaemon, report.target),
              noRecoveryRecord: bareRecovery === null,
              extensionsAtTargetOrNamedWithRemedy: bareExtensionsAccounted,
              staleTmuxRefusedWithRemedyBeforeReconcile: [0, 4].includes(bareRuntimes.exit) && typeof bareTmuxRow?.error === 'string' && bareTmuxRow.error.includes(`@cotal-ai/tmux is ${report.candidateNext.targetVersion} and this cotal is ${report.target} - run \`cotal update --self\` to reconcile this installation`),
              launchGateRefusesWhenUnreachableWithRemedy: launchGateRefusal.exit === 1 && /run `cotal update --self` to reconcile this installation/.test(launchGateRefusal.stdout + launchGateRefusal.stderr) && refusalExtensions.some(entry => entry.pkg === '@cotal-ai/tmux' && entry.version === report.candidateNext.targetVersion) && refusalInstalledExtensions.some(entry => entry.pkg === '@cotal-ai/tmux' && entry.version === report.candidateNext.targetVersion),
              launchGateReconcilesOfficialExtensionsAndLoadsTmux: launchGateVersion.exit === 0 && cliReportsVersion(launchGateVersion.stdout, report.target) && !/Reconciliation pending/.test(launchGateVersion.stdout) && launchGateTmuxRow?.state === 'installed' && launchGateTmuxRow?.package === '@cotal-ai/tmux' && launchGateTmuxRow?.error === null && launchGateExtensions.length >= 8 && launchGateExtensions.every(entry => entry.version === report.target && launchGateInstalledExtensions.find(row => row.pkg === entry.pkg)?.version === report.target),
              scheduledCheckReconcilesPendingExtensionsAndLoadsTmux: /Reconciliation pending: Run `cotal update --self` to reconcile this installation\./.test(pendingBeforeScheduled.stdout) && scheduledAttempt?.version === report.target && scheduledAttempt?.result === `updated to ${report.target}` && scheduledVersion.exit === 0 && cliReportsVersion(scheduledVersion.stdout, report.target) && !/Reconciliation pending/.test(scheduledVersion.stdout) && scheduledTmuxRow?.state === 'installed' && scheduledTmuxRow?.package === '@cotal-ai/tmux' && scheduledTmuxRow?.error === null && scheduledExtensions.length >= 8 && scheduledExtensions.every(entry => entry.version === report.target && scheduledInstalledExtensions.find(row => row.pkg === entry.pkg)?.version === report.target),
            };
            const bareBytes = Buffer.from(JSON.stringify({
              version: bareVersion,
              daemonStatus: bareDaemonStatus,
              runtimes: bareRuntimes,
              route: bareRoute,
              recovery: bareRecovery,
              extensions: bareExtensions,
              installedExtensions: bareInstalledExtensions,
              launchGateRefusal: { command: launchGateRefusal, extensions: refusalExtensions, installedExtensions: refusalInstalledExtensions },
              launchGateReconcile: { command: launchGateReconcile, version: launchGateVersion, runtimes: launchGateRuntimes, extensions: launchGateExtensions, installedExtensions: launchGateInstalledExtensions },
              scheduledReconcile: { pendingBefore: pendingBeforeScheduled, attempt: scheduledAttempt, version: scheduledVersion, runtimes: scheduledRuntimes, daemonStatus: scheduledDaemonStatus, extensions: scheduledExtensions, installedExtensions: scheduledInstalledExtensions },
              checks: bareChecks,
            }));
            const bareCommands = { artifact: `${id}-bare-manual-npm.txt`, bytes: bareBytes.length, sha256: digest(bareBytes) };
            writeFileSync(join(output, bareCommands.artifact), bareBytes, { flag: 'wx', mode: 0o600 });
            bareNpmObservation = { passed: Object.values(bareChecks).every(Boolean), selectedCliVersion: bareRoute.selectedCliVersion, packageManagerRecordVersion: bareRoute.packageManagerRecordVersion, updateRoute: bareRoute.updateRoute, daemonVersion: bareDaemon?.version, recovery: bareRecovery, extensions: bareExtensions, installedExtensions: bareInstalledExtensions, remedyPresent, versionCommand: bareVersion, daemonStatusCommand: bareDaemonStatus, runtimesCommand: bareRuntimes, launchGateRefusal: { command: launchGateRefusal, extensions: refusalExtensions, installedExtensions: refusalInstalledExtensions }, launchGateReconcile: { command: launchGateReconcile, version: launchGateVersion, runtimes: launchGateRuntimes, extensions: launchGateExtensions, installedExtensions: launchGateInstalledExtensions }, scheduledReconcile: { pendingBefore: pendingBeforeScheduled, attempt: scheduledAttempt, version: scheduledVersion, runtimes: scheduledRuntimes, daemonStatus: scheduledDaemonStatus, extensions: scheduledExtensions, installedExtensions: scheduledInstalledExtensions }, checks: bareChecks, commands: bareCommands };
            check('bare manual npm install reaches target in-place and names any pending extension reconciliation', bareNpmObservation.passed, bareNpmObservation);
            update = await cotal('reconcile manual npm follow-on target', ['update', '--self']);
          } else {
            update = await installer(report.target, 'follow-on');
          }
          report.nextHop.followOn = { action: followOnAction, targetVersion: report.target, ...(npmInstall ? { npmInstall } : {}), ...(bareNpmObservation ? { bareNpmObservation } : {}), update };
          const followOnPassed = update.exit === 0 && update.signal === null && update.timeout === false && (!npmInstall || (npmInstall.exit === 0 && npmInstall.signal === null && npmInstall.timeout === false)) && (!bareNpmObservation || bareNpmObservation.passed);
          report.nextHop.passed = report.nextHop.passed && followOnPassed;
          check('follow-on target matches packed artifact', report.target === report.candidateNext.followOnVersion, report.target);
          check('follow-on action exits successfully', followOnPassed, report.nextHop.followOn);
        }
      }
    }
    else if (method === 'installer') update = await installer(report.target, true);
    else if (policy === 'unsupported-scheduler') update = { attempted: false, exit: null, stdout: '', stderr: '', reason: 'source scheduler policy does not support automatic installation on this OS' };
    else {
      if (launchdProof !== 'off-before-tick' && !windowsPolicy) assert.equal(report.daemonBefore.update.automatic, true, report.daemonBefore.update.lastResult);
      else if (launchdProof === 'off-before-tick') check('automatic updates disabled before first native tick', report.daemonBefore.update.automatic === false, report.daemonBefore.update);
      // Wait for the daemon's normal timer to populate the registry cache. Do not invoke an updater.
      for (let i = 0; i < 60 && !existsSync(join(cotalHome, 'update-check.json')); i++) await delay(1000);
      assert(existsSync(join(cotalHome, 'update-check.json')), 'daemon normal registry check created cache');
      for (const [name, fields] of [['update-check.json', ['checkedAt', 'firstSeenAt', 'attemptedAt']], ['update-attempt.json', ['next']]]) {
        const file = join(cotalHome, name), before = json(file), after = { ...before };
        for (const field of fields) after[field] = Date.now() - 7200000;
        if (windowsPolicy && name === 'update-check.json') after.checkedAt = Date.now() - 25 * 3600000;
        save(join(output, `${id}-${name}-clock.json`), { before, after });
        save(file, after);
      }
      if (windowsPolicy) {
        const agedAt = Date.now(), observations = [];
        const deadline = Date.now() + 90000;
        let tick;
        do {
          await delay(5000);
          const cached = json(join(cotalHome, 'update-check.json'));
          const observed = await daemon('Windows scheduler tick observation', ['daemon', 'status', '--json']);
          observations.push({ at: new Date().toISOString(), cached, status: observed });
          if (cached.attemptedAt >= agedAt && cached.latest === report.policyBaseline.advertised && observed.exit === 0) { tick = JSON.parse(observed.stdout).result; break; }
        } while (Date.now() < deadline);
        save(join(output, `${id}-tick-observations.json`), observations);
        check('normal native scheduler tick refreshed newer registry cache', Boolean(tick), observations);
        check('automatic preference enabled before native installation', report.policyBaseline.settingsBeforeInstall.auto === true, report.policyBaseline.settingsBeforeInstall);
        check('recorded scheduler refusal names Windows', tick?.update?.automatic === false && /Automatic installation is unavailable on Windows/.test(tick?.update?.lastResult ?? ''), tick?.update);
        check('native daemon remains ready at unchanged published generation', tick?.state === 'ready' && tick.version === report.source && tick.pid === report.daemonBefore.pid, tick);
        check('published installation remains unchanged', json(join(pkg, 'package.json')).version === report.source, report.source);
        const inventoryAfter = { package: digest(readFileSync(join(pkg, 'package.json'))), cli: digest(readFileSync(cli)) };
        check('published package and CLI bytes remain unchanged', JSON.stringify(inventoryAfter) === JSON.stringify(report.policyBaseline.inventoryBefore), { before: report.policyBaseline.inventoryBefore, after: inventoryAfter });
        const publicStatus = await cotal('Windows baseline public status', ['status']);
        check('public status succeeds after recorded policy refusal', publicStatus.exit === 0, publicStatus);
        check('no paused recovery record', !existsSync(join(cotalHome, 'update-recovery.json')), null);
        report.policyBaseline.observed = tick;
        report.policyBaseline.refusal = tick?.update?.lastResult;
        report.result = report.assertions.every(row => row.passed) ? 'passed' : 'failed';
        return report;
      } else if (launchdProof === 'off-before-tick') {
        await delay(70000);
        await launchdObserver.sample();
        const inventory = { package: digest(readFileSync(join(pkg, 'package.json'))), cli: digest(readFileSync(cli)), extensions: existsSync(join(config, 'extensions/extensions.json')) ? digest(readFileSync(join(config, 'extensions/extensions.json'))) : undefined };
        check('off control keeps installation inventory unchanged', JSON.stringify(inventory) === JSON.stringify(offInventory), { before: offInventory, after: inventory });
        check('off control never hands off an updater job', !launchdObserver.observations.some(x => x.records?.['update-launchd.json'] || x.records?.['update-launchd-result.json']), launchdObserver.observations.length);
        report.launchdProof.observationMs = 70000;
        update = { exit: 0, stdout: 'Automatic updates disabled before native tick; no installation requested.\n', stderr: '' };
      } else {
      const deadline = Date.now() + (killControl ? 540000 : 300000);
      do {
        await delay(5000);
        // npm reify temporarily removes the old package directory. Absence mid-replacement
        // is an observation, not a terminal verdict or permission to stop the updater.
        if (!existsSync(join(pkg, 'package.json')) || !existsSync(cli)) {
          report.schedulerReplacementObserved = true;
          continue;
        }
        let installedState;
        try { installedState = inspectInstalledUpdateRoute(pkg, process.platform); }
        catch (error) { if (error.code === 'ENOENT') { report.schedulerReplacementObserved = true; continue; } throw error; }
        const installedVersion = installedState.selectedCliVersion;
        const status = await cotal('scheduler observation', ['daemon', 'status', '--json']);
        report.schedulerLastStatus = status;
        if (launchdObserver?.status().failure) throw new Error(launchdObserver.status().failure);
        if (killControl?.status().failure) throw new Error(killControl.status().failure);
        if (installedVersion === report.target && status.exit === 0 && nativeGenerationReady(JSON.parse(status.stdout).result, report.target)) {
          const attempt = json(join(cotalHome, 'update-attempt.json'));
          if (report.source === report.target ? attempt.result === 'up to date' : /^(?:repaired and )?updated to /i.test(attempt.result)) break;
        }
      } while (Date.now() < deadline);
      const attempt = json(join(cotalHome, 'update-attempt.json'));
      if (/^updating to /.test(attempt.result)) {
        uncertain = true;
        throw new Error(`scheduler outcome unknown after observation deadline: ${attempt.result}; native service retained for runner teardown`);
      }
      const postSchedulerRoute = inspectInstalledUpdateRoute(pkg, process.platform);
      check('scheduler completed within observation deadline', report.source === report.target ? attempt.result === 'up to date' : postSchedulerRoute.selectedCliVersion === report.target && /^(?:repaired and )?updated to /i.test(attempt.result), attempt);
      update = { exit: 0, stdout: existsSync(join(cotalHome, 'update-attempt.log')) ? readFileSync(join(cotalHome, 'update-attempt.log'), 'utf8') : '', stderr: '' };
      save(join(output, `${id}-scheduler-after.json`), { check: json(join(cotalHome, 'update-check.json')), attempt: json(join(cotalHome, 'update-attempt.json')) });
      check('daemon scheduler performed a replacement or reported up to date', report.source === report.target || update.stdout.length > 0, update.stdout);
      }
    }
    report.sourceInventoryAfterAction = sourceInventory();
    if (update.exit !== 0) check('source generation unchanged', JSON.stringify(report.sourceInventoryAfterAction) === JSON.stringify(report.sourceInventoryBeforeAction), { before: report.sourceInventoryBeforeAction, after: report.sourceInventoryAfterAction });
    if (policy) {
      report.update = update;
      report.targetUpgradeAcceptance = 'not accepted: source refused or scheduler is unsupported';
      check('exact source policy refusal', policyRefusal(policy, update, config, report.daemonBefore), { update, daemon: report.daemonBefore });
      if (policy === 'legacy-seat') check('real local legacy seat observed before refusal', stackStarted && report.agentBefore.includes('upgrade-proof-worker'), report.agentBefore);
      if (policy === 'unsupported-scheduler') check('unsupported scheduler retains ready source daemon', nativeGenerationReady(report.daemonBefore, report.source), report.daemonBefore);
      if (policy === 'unsupported-scheduler') {
        check('settings CLI reports Linux-only automatic installation', report.automaticSettings.stdout.includes('Automatic updates: on') && report.automaticSettings.stdout.includes('Automatic installation is available on Linux in this release. Run `cotal update --self` here for a manual update.'), report.automaticSettings);
        const final = JSON.parse(ok(await daemon('unsupported scheduler final status', ['daemon', 'status', '--json']), 'final source daemon').stdout).result;
        check('unsupported scheduler leaves daemon identity unchanged', nativeGenerationReady(final, report.source) && final.pid === report.daemonBefore.pid && typeof final.startedAt === 'string' && final.startedAt === report.daemonBefore.startedAt, { before: report.daemonBefore, after: final });
      }
      if (policy === 'missing-config') check('missing config remains absent after refused first hop', !existsSync(config), config);
      check('source inventory unchanged', JSON.stringify(sourceInventory()) === JSON.stringify(report.policyInventoryBefore), sourceInventory());
      check('source CLI remains selected', cliReportsVersion(ok(await cotal('source version after refusal', ['--version']), 'source version').stdout, report.source), report.source);
      check('all eight first-party extensions recorded before refusal', policy === 'missing-config' ? report.extensionsBefore.length === 0 : report.extensionsBefore.filter(entry => entry.pkg.startsWith('@cotal-ai/')).length === 8, report.extensionsBefore);
      if (policy === 'legacy-seat') check('stand-in fixture remains separately recorded', report.extensionsBefore.length === 9, report.extensionsBefore);
      check('cotal status exits zero after refusal', (await cotal('status after refusal', ['status'])).exit === 0, null);
      check('no paused recovery after refusal', !existsSync(join(cotalHome, 'update-recovery.json')), null);
      if (policy === 'missing-config' && report.assertions.every(row => row.passed)) {
        // The old binary cannot repair its first hop. Keep its transcript above.
        env.COTAL_INSTALL_DIR = prefix;
        env.COTAL_BIN_DIR = dirname(launcher);
        report.installerEscape = { source: report.source, target: report.target, prefix, bin: dirname(launcher), route: 'public installer into the original npm prefix; separate acceptance' };
        const escape = await installer(report.target);
        report.installerEscape.update = escape;
        check('public installer escape exits zero without repair hint', escape.exit === 0 && !requiresManualStep(completionAdvisory(escape.stdout + escape.stderr).required), escape);
        check('public installer replaces original prefix with target', json(join(pkg, 'package.json')).version === report.target, prefix);
        const selected = await call('public installer selected launcher', launcher, ['--version']);
        check('public installer launcher selects target', selected.exit === 0 && cliReportsVersion(selected.stdout, report.target), selected);
        const escapedExtensions = existsSync(join(config, 'extensions/extensions.json')) ? json(join(config, 'extensions/extensions.json')).extensions : [];
        report.installerEscape.extensions = escapedExtensions;
        const seeded = ['connector-claude-code', 'connector-opencode', 'connector-codex', 'connector-hermes', 'connector-jcode', 'pi', 'web'].map(name => `@cotal-ai/${name}`);
        check('public installer records every target built-in connector', JSON.stringify(escapedExtensions.map(entry => entry.pkg).sort()) === JSON.stringify(seeded.sort()) && escapedExtensions.every(entry => entry.version === report.target && existsSync(join(config, 'extensions/node_modules', entry.pkg, 'package.json')) && json(join(config, 'extensions/node_modules', entry.pkg, 'package.json')).version === report.target), escapedExtensions);
        check('public installer status exits zero', (await call('public installer status', launcher, ['status'])).exit === 0, null);
        check('public installer leaves no recovery', !existsSync(join(cotalHome, 'update-recovery.json')), null);
        report.installerEscape.accepted = report.assertions.every(row => row.passed);
      }
      report.result = policy === 'unsupported-scheduler' && report.assertions.every(row => row.passed) ? 'unsupported' : 'failed';
      report.expectedRefusal = { kind: policy, passed: report.assertions.every(row => row.passed) };
      report.refusal = report.assertions.filter(row => !row.passed).map(row => row.name).join('\n') || report.targetUpgradeAcceptance;
      return report;
    }
    const expectedVersion = launchdProof === 'off-before-tick' ? report.source : report.target;
    report.expectedVersion = expectedVersion;
    report.update = update;
    const selectedVersions = selectedTargets(update.stdout + update.stderr);
    report.updaterSelectedVersions = selectedVersions;
    report.updaterSelectedVersion = selectedVersions[0];
    check('upgrade exits successfully', update.exit === 0, update);
    const installedRoute = inspectInstalledUpdateRoute(pkg, process.platform);
    report.updateRoute = installedRoute.updateRoute;
    report.selectedCliVersion = installedRoute.selectedCliVersion;
    report.packageManagerRecordVersion = installedRoute.packageManagerRecordVersion;
    const expectedPackageManagerVersion = ['npm', 'installer'].includes(options['follow-on-action']) || method === 'installer' || options['first-install'] === 'true'
      ? expectedVersion
      : nextHopMode === 'source-0.164.10'
        ? report.daemonDiagnostics?.['between-hops']?.observations?.find(row => row.kind === 'installed-version')?.packageManagerRecordVersion ?? report.candidateNext.sourceVersion
        : report.source;
    const routeMatches = installedRoute.selectedCliVersion === expectedVersion && (installedRoute.updateRoute === 'in-place'
      ? installedRoute.packageManagerRecordVersion === expectedVersion
      : !['npm', 'installer'].includes(options['follow-on-action']) && method !== 'installer' && options['first-install'] !== 'true' && installedRoute.packageManagerRecordVersion === expectedPackageManagerVersion);
    check('CLI version is target', routeMatches, installedRoute.selectedCliVersion);
    const manifest = join(config, 'extensions/extensions.json');
    const extensions = existsSync(manifest) ? json(manifest).extensions : [];
    report.extensionsAfter = extensions;
    check('every prior extension remains recorded', report.extensionsBefore.every(before => extensions.some(after => after.pkg === before.pkg)), extensions.map(entry => entry.pkg));
    const installedExtensions = extensions.map(entry => {
      const path = join(config, 'extensions/node_modules', entry.pkg);
      const metadata = existsSync(join(path, 'package.json')) ? json(join(path, 'package.json')) : undefined;
      const files = entry.pkg === report.ownedLocalFixture?.pkg ? Object.fromEntries(Object.keys(report.ownedLocalFixture.files).map(name => [name, existsSync(join(path, name)) ? digest(readFileSync(join(path, name))) : null])) : {};
      return {pkg: entry.pkg, path, realpath: existsSync(path) ? realpathSync(path) : null, version: metadata?.version, files};
    });
    const versions = extensionVersionChecks({extensions, before: report.extensionsBefore, target: expectedVersion, fixture: report.ownedLocalFixture, installed: installedExtensions});
    report.installedExtensionVersions = installedExtensions;
    check('every recorded extension is at target', versions.recorded, extensions.map(({ pkg, version }) => ({ pkg, version })));
    const version = await cotal('selected CLI version assertion', ['--version']);
    check('selected CLI reports target', version.exit === 0 && cliReportsVersion(version.stdout, expectedVersion), version);
    check('recorded extension package versions match target', versions.installed, installedExtensions);
    const status = await cotal('status assertion', ['status']);
    check('cotal status exits zero', status.exit === 0, status);
    const recovery = existsSync(join(cotalHome, 'update-recovery.json')) ? json(join(cotalHome, 'update-recovery.json')) : null;
    check('no paused recovery record', recovery === null, recovery);
    if (foreignSnapshot) check('foreign snapshot bytes remain untouched', existsSync(join(report.foreignSnapshot.path, 'foreign-owner-sentinel')) && digest(readFileSync(join(report.foreignSnapshot.path, 'foreign-owner-sentinel'))) === report.foreignSnapshot.sentinelSha256 && readdirSync(report.foreignSnapshot.path).join(',') === 'foreign-owner-sentinel', report.foreignSnapshot);
    if (container) {
      const current = JSON.parse(ok(await call('foreign container after host upgrade', 'docker', ['inspect', container.id]), 'foreign container preservation').stdout)[0];
      check('foreign container Manager remains running and untouched', current.Id === container.id && current.Config.Labels['cotal.upgrade.cell'] === container.label && current.State.Running === true && current.State.Pid === container.pid && current.State.StartedAt === container.startedAt, { before: container, after: current.State });
    }
    if (daemonHostedManager) {
      let observed, current;
      const deadline = Date.now() + 60000;
      do {
        observed = await daemon('observe current daemon-hosted Manager', ['daemon', 'status', '--space', report.managerHost.space, '--json']);
        report.managerHost.statusAfter = observed;
        if (observed.exit === 0) {
          current = JSON.parse(observed.stdout).result.managers?.find(manager => manager.space === report.managerHost.space);
          if (current?.state === 'answering' && current.instanceId) break;
        }
        await delay(1000);
      } while (Date.now() < deadline);
      assert(current?.state === 'answering' && current.instanceId, `current daemon-hosted Manager must answer after update: ${JSON.stringify(observed)}`);
      report.managerHost.instanceAfter = current.instanceId;
      const seats = await cotal('confirm consent stopped daemon-hosted seats', ['ps', '--on', current.instanceId, '--space', report.managerHost.space, '--json']);
      report.managerHost.after = seats;
      if (nextHopMode && daemonHostedManager) {
        report.nextHop.secondHop.hostedManager = await captureHostedManager('after update', report.candidateNext.targetVersion);
        check('hosted Manager restored after both update hops', true, {intermediate: report.nextHop.intermediate.hostedManager, final: report.nextHop.secondHop.hostedManager});
      }
      check('daemon-hosted consent ends owned seat', seats.exit === 0 && !seats.stdout.includes('upgrade_proof_worker'), seats);
    }
    if (installedService) {
      if (desktopRuntime && options['stopped-daemon-before-update'] === 'true') {
        const afterStatus = await daemon('native status after', ['daemon', 'status', '--json']);
        const unitShowAfter = ok(await call('desktop unit show after CLI update', 'systemctl', ['--user', '--no-ask-password', '--no-pager', 'show', receipt.unit, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID']), 'desktop unit show after CLI update');
        const ownerReport = `machine daemon: the background service belongs to another Cotal installation (${report.desktop.entry}). This update left it stopped.`;
        const stoppedDesktopAfter = {
          status: afterStatus,
          unitShowAfter,
          updateNamesDesktopOwner: update.stdout.includes(ownerReport),
          remainsStopped: afterStatus.exit === 2 && afterStatus.signal === null && afterStatus.timeout === false && /ActiveState=inactive/.test(unitShowAfter.stdout) && /MainPID=0/.test(unitShowAfter.stdout),
        };
        const afterBytes = Buffer.from(JSON.stringify(stoppedDesktopAfter));
        const afterCommands = { artifact: `${id}-stopped-desktop-after-update.txt`, bytes: afterBytes.length, sha256: digest(afterBytes) };
        writeFileSync(join(output, afterCommands.artifact), afterBytes, { flag: 'wx', mode: 0o600 });
        report.stoppedDesktopAfterUpdate = { ...stoppedDesktopAfter, commands: afterCommands };
        check('stopped desktop daemon remains stopped across CLI update', stoppedDesktopAfter.remainsStopped, report.stoppedDesktopAfterUpdate);
        check('CLI update names the stopped desktop service owner', stoppedDesktopAfter.updateNamesDesktopOwner, update.stdout);
        check('released desktop inventory unchanged', verifyDesktopRuntime(desktopRuntime).sha256 === desktopHash, desktopHash);
        const current = json(join(report.daemonHome, 'service-unit.json'));
        check('CLI update preserves original desktop service source', current.unit === receipt.unit && current.unitPath === receipt.unitPath && current.unitSha256 === receipt.unitSha256, current);
      } else if (options['disabled-daemon-before-update'] === 'true') {
        const afterStatus = await daemon('native status after', ['daemon', 'status', '--json']);
        const unitShowAfter = process.platform === 'linux'
          ? ok(await call('disabled unit show after manual update', 'systemctl', ['--user', '--no-ask-password', '--no-pager', 'show', receipt.unit, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID']), 'disabled unit show after manual update')
          : ok(await call('disabled unit show after manual update', '/bin/launchctl', ['print-disabled', `gui/${process.getuid()}`]), 'disabled unit show after manual update');
        const disabledReport = `${receipt.unit}: service is disabled; not started`;
        const unitDisabledAfter = process.platform === 'linux'
          ? /ActiveState=inactive/.test(unitShowAfter.stdout) && /UnitFileState=disabled/.test(unitShowAfter.stdout) && /MainPID=0/.test(unitShowAfter.stdout)
          : new RegExp(`"${receipt.unit.replaceAll('.', '\\.')}" => (?:true|disabled)`).test(unitShowAfter.stdout);
        const disabledAfter = {
          status: afterStatus,
          unitShowAfter,
          updateReportsDisabledNotStarted: update.stdout.includes(disabledReport),
          remainsDisabledAndStopped: afterStatus.exit === 2 && afterStatus.signal === null && afterStatus.timeout === false && unitDisabledAfter,
        };
        const afterBytes = Buffer.from(JSON.stringify(disabledAfter));
        const afterCommands = { artifact: `${id}-disabled-daemon-after-update.txt`, bytes: afterBytes.length, sha256: digest(afterBytes) };
        writeFileSync(join(output, afterCommands.artifact), afterBytes, { flag: 'wx', mode: 0o600 });
        report.disabledDaemonAfterUpdate = { ...disabledAfter, commands: afterCommands };
        check('disabled native daemon remains stopped across manual update', disabledAfter.remainsDisabledAndStopped, report.disabledDaemonAfterUpdate);
        check('manual update reports service is disabled; not started', disabledAfter.updateReportsDisabledNotStarted, update.stdout);
      } else {
        let active = await daemon('native status after', ['daemon', 'status', '--json']);
        const expectedDaemonVersion = desktopInventory?.version ?? expectedVersion;
        for (let i = 0; i < 60; i++) {
          if (active.exit === 0 && nativeGenerationReady(JSON.parse(active.stdout).result, expectedDaemonVersion)) break;
          await delay(1000);
          active = await daemon('wait for target native generation', ['daemon', 'status', '--json']);
        }
        check('native daemon remains active at its expected generation', active.exit === 0 && nativeGenerationReady(JSON.parse(active.stdout).result, expectedDaemonVersion), active);
        if (active.exit === 0) finalDaemon = JSON.parse(active.stdout).result;
        if (desktopRuntime) {
          const after = JSON.parse(active.stdout).result;
          check('CLI update preserves desktop daemon version and channel', after?.version === desktopInventory.version && after?.update?.channel === 'desktop' && after?.update?.automatic === false, after);
          check('released desktop inventory unchanged', verifyDesktopRuntime(desktopRuntime).sha256 === desktopHash, desktopHash);
          const current = json(join(report.daemonHome, 'service-unit.json'));
          check('CLI update preserves original desktop service source', current.unit === receipt.unit && current.unitPath === receipt.unitPath && current.unitSha256 === receipt.unitSha256, current);
          if (report.desktop.hostedManager) {
            const { space, instanceId } = report.desktop.hostedManager;
            const secondUpdate = await cotal('second cotal update beside desktop daemon', ['update']);
            const secondSelfUpdate = await cotal('second cotal update --self beside desktop daemon', ['update', '--self']);
            const statusAfterSecond = await daemon('native status after second CLI update', ['daemon', 'status', '--json']);
            const afterSecond = statusAfterSecond.exit === 0 ? JSON.parse(statusAfterSecond.stdout).result : undefined;
            const managerAfter = afterSecond?.managers?.find(row => row.space === space);
            const modelsAfter = await cotal('models on desktop-hosted Manager after CLI updates', ['models', '--on', instanceId, '--space', space, '--json']);
            const followUpBytes = Buffer.from(JSON.stringify({ firstAfter: after, secondUpdate, secondSelfUpdate, statusAfterSecond, modelsAfter }));
            const followUpCommands = { artifact: `${id}-desktop-beside-cli-followup.txt`, bytes: followUpBytes.length, sha256: digest(followUpBytes) };
            writeFileSync(join(output, followUpCommands.artifact), followUpBytes, { flag: 'wx', mode: 0o600 });
            report.desktop.followUp = {
              secondUpdate,
              secondSelfUpdate,
              statusAfterSecond,
              modelsAfter,
              commands: followUpCommands,
              firstUpdateLeftNoFence: after?.update?.restartEvidence?.prepared === false,
              secondUpdatePassed: secondUpdate.exit === 0 && secondUpdate.signal === null && secondUpdate.timeout === false,
              secondSelfUpdatePassed: secondSelfUpdate.exit === 0 && secondSelfUpdate.signal === null && secondSelfUpdate.timeout === false,
              managerStillAnswering: managerAfter?.state === 'answering' && managerAfter?.instanceId === instanceId && afterSecond?.update?.restartEvidence?.prepared === false && modelsAfter.exit === 0,
            };
            check('CLI update leaves no restart fence on foreign desktop daemon', report.desktop.followUp.firstUpdateLeftNoFence, after?.update?.restartEvidence);
            check('second cotal update beside desktop daemon exits zero', report.desktop.followUp.secondUpdatePassed, secondUpdate);
            check('second cotal update --self beside desktop daemon exits zero', report.desktop.followUp.secondSelfUpdatePassed, secondSelfUpdate);
            check('desktop-hosted Manager still answers after CLI updates', report.desktop.followUp.managerStillAnswering, { managerAfter, restartEvidence: afterSecond?.update?.restartEvidence, modelsAfter });
          }
        }
      }
    }
    if (launchdObserver) {
      if (launchdProof !== 'off-before-tick') {
        const deadline = Date.now() + 90000;
        do { await launchdObserver.sample(); if (handoffEvidence(launchdObserver.observations, killControl?.status().receipt?.label).retired) break; await delay(500); } while (Date.now() < deadline);
        const evidence = handoffEvidence(launchdObserver.observations, killControl?.status().receipt?.label);
        report.launchdProof.evidence = evidence;
        if (killControl) {
          report.launchdProof.failureControl = killControl.status();
          check('killed runner recovered and a later scheduler retry completed', killControl.status().stage === 'retry-completed', killControl.status());
        }
        for (const [name, passed] of Object.entries(evidence)) check(`launchd ${name}`, passed, evidence);
        if (!evidence.retired) uncertain = true;
        const pids = new Set(launchdObserver.observations.filter(x => x.daemon?.verified && x.daemon.parent === 1).map(x => x.daemon.pid));
        report.launchdProof.observedDaemonPids = [...pids];
        check('launchd transition observed exactly one daemon restart', pids.size === 2 && pids.has(report.daemonBefore.pid) && pids.has(finalDaemon?.pid) && finalDaemon.pid !== report.daemonBefore.pid && finalDaemon.version === expectedVersion, { pids: [...pids], finalDaemon });
      }
      report.launchdProof.observer = await launchdObserver.close();
      if (report.launchdProof.observer.failure) uncertain = true;
      launchdObserver = undefined;
      check('launchd observer remained readable', !report.launchdProof.observer.failure, report.launchdProof.observer);
    }
    const completion = completionAdvisory(update.stdout + update.stderr);
    report.advisory = completion.advisory;
    check('no manual step or refusal', update.exit === 0 && !requiresManualStep(completion.required), completion.required);
    report.result = report.assertions.every(row => row.passed) ? 'passed' : 'failed';
    if (report.result === 'failed') report.refusal = report.assertions.filter(row => !row.passed).map(row => `${row.name}: ${typeof row.observed === 'string' ? row.observed : JSON.stringify(row.observed)}`).join('\n');
  } catch (error) {
    if (method === 'scheduler' && report.daemonBefore) {
      try { if (/^updating to /.test(json(join(cotalHome, 'update-attempt.json')).result)) uncertain = true; }
      catch { uncertain = true; }
    }
    report.result = 'failed'; report.refusal = error.message;
  } finally {
    if (installedService && !report.daemonDiagnostics?.['before-update']) {
      report.daemonDiagnostics ??= {};
      report.daemonDiagnostics['before-update'] = { state: 'not-reached', reason: 'setup failed before the update boundary', observedAt: new Date().toISOString() };
    }
    // Observe the update's end before any fixture, Manager or native service cleanup, even on timeout.
    await captureServiceEvidence('after-update');
    if (installedService && (state === 'daemon' || nextHopMode && daemonHostedManager) && method === 'self' && !desktopRuntime && options['disabled-daemon-before-update'] !== 'true') {
      const expectedPackageManagerVersion = ['npm', 'installer'].includes(options['follow-on-action'])
        ? report.target
        : nextHopMode === 'source-0.164.10'
          ? report.daemonDiagnostics?.['between-hops']?.observations?.find(row => row.kind === 'installed-version')?.packageManagerRecordVersion ?? report.candidateNext.sourceVersion
          : report.source;
      report.manualServiceFinalState = evaluateManualDaemonState({ diagnostics: report.daemonDiagnostics?.['after-update'], output, target: report.target, platform: process.platform, expectedPackageManagerVersion });
      if (['npm', 'installer'].includes(options['follow-on-action']) && report.manualServiceFinalState.updateRoute !== 'in-place') report.manualServiceFinalState.passed = false;
      check('independent manual service final state', report.manualServiceFinalState.passed, report.manualServiceFinalState);
      if (!report.manualServiceFinalState.passed) report.result = 'failed';
      if (nextHopMode) report.nextHop.passed = report.nextHop.passed === true && report.manualServiceFinalState.passed && report.assertions.every(row => row.passed);
    } else if (nextHopMode && (options['disabled-daemon-before-update'] === 'true' || Boolean(desktopRuntime))) {
      report.nextHop.passed = report.nextHop.passed === true && report.assertions.every(row => row.passed);
    }
    if (compositionCleanup && !daemonHostedManager && !report.desktop?.hostedManager) {
      try { await compositionCleanup(); report.compositionCleanup = 'owned composition stopped before reporting'; }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (container) {
      try {
        const current = JSON.parse(ok(await call('verify owned container before stop', 'docker', ['inspect', container.id]), 'container cleanup ownership').stdout)[0];
        assert.equal(current.Id, container.id); assert.equal(current.Config.Labels['cotal.upgrade.cell'], container.label);
        assert(current.State.Running, 'owned foreign container must remain running until stack cleanup');
        report.foreignStackStop = await call('stop stock stack inside owned foreign container', 'docker', ['exec', container.id, 'sh', '-c', foreignStackCleanupCommand], 60000);
        report.ownedStackCleanup = report.foreignStackStop;
        const endObservation = ok(await call('observe container immediately after stock down', 'docker', ['inspect', container.id]), 'container end observation');
        const ended = JSON.parse(endObservation.stdout)[0];
        const processCheck = await call('confirm no owned container process remains', 'docker', ['top', container.id, '-eo', 'pid,uid,args']);
        const processRows = processCheck.stdout.trim().split('\n').filter(Boolean);
        const noProcesses = processCheck.exit === 0 ? processRows.length <= 1 : processCheck.exit === 1 && processCheck.stdout.trim() === '' && /is not running/.test(processCheck.stderr);
        const stackEnded = foreignStackEnded({ stop: report.calls.findLast(entry => entry.label === 'stop stock stack inside owned foreign container'), before: container, after: ended, noProcesses, observedAt: report.calls.findLast(entry => entry.label === 'observe container immediately after stock down').startedAt });
        report.foreignStackEnd = { state: ended.State, noProcesses, processCheck, passed: stackEnded, pid1Exit137: report.foreignStackStop.exit === 137 && stackEnded };
        check('owned local stack cleanup succeeds', stackEnded, report.foreignStackEnd);
        report.foreignContainerStop = ok(await call('stop owned foreign supervisor and broker', 'docker', ['stop', '--time', '20', container.id], 60000), 'foreign container stop');
        const stopped = JSON.parse(ok(await call('confirm owned foreign container stopped', 'docker', ['inspect', container.id]), 'container stop proof').stdout)[0];
        assert.equal(stopped.Id, container.id);
        assert.equal(stopped.Config.Labels['cotal.upgrade.cell'], container.label);
        assert.equal(stopped.State.Running, false);
        report.foreignContainerCleanup = { exit: report.foreignContainerStop.exit, running: stopped.State.Running, retained: true };
        check('foreign container cleanup succeeds', report.foreignContainerCleanup.exit === 0 && !report.foreignContainerCleanup.running, report.foreignContainerCleanup);
        assert(stackEnded, 'owned stock stack end was not confirmed');
      } catch (error) {
        if (!report.assertions.some(row => row.name === 'foreign container cleanup succeeds')) check('foreign container cleanup succeeds', false, error.message);
        report.cleanupFailure = error.message; report.result = 'failed';
      }
    }
    if (launchdObserver) {
      report.launchdProof ??= { kind: launchdProof };
      report.launchdProof.observer = await launchdObserver.close();
      if (report.launchdProof.observer.failure || (launchdProof !== 'off-before-tick' && !handoffEvidence(launchdObserver.observations, killControl?.status().receipt?.label).retired)) uncertain = true;
    }
    if (releaseHolder) releaseHolder();
    if (holderPromise) {
      const holderResult = await holderPromise;
      check('concurrent writer completed', holderResult.exit === 0, holderResult);
      if (holderResult.exit !== 0) report.result = 'failed';
    }
    if (stackStarted && !uncertain) {
      try {
        report.ownedStackCleanup = await cotal('stop owned local stack', ['down', '--yes']);
        check('owned local stack cleanup succeeds', report.ownedStackCleanup.exit === 0, report.ownedStackCleanup);
        ok(report.ownedStackCleanup, 'local stack cleanup');
      }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (daemonHostedManager && report.managerHost?.instanceId) {
      report.managerHost.diagnosticsBeforeCleanup = archiveHostedDiagnostics({ fixture: join(root, 'native-fixture'), cotalHome, space: report.managerHost.space, output, id, stage: 'before-cleanup' });
    }
    if (daemonHostedManager && !uncertain && report.managerHost?.instanceId) {
      try {
        report.managerHost.stop = await daemon('stop owned daemon-hosted Manager', ['daemon', 'service-disconnect', '--space', report.managerHost.space, '--json']);
        check('owned daemon-hosted Manager stop succeeds', report.managerHost.stop.exit === 0, report.managerHost.stop);
        ok(report.managerHost.stop, 'hosted agent cleanup');
        report.managerHost.diagnosticsAfterStop = archiveHostedDiagnostics({ fixture: join(root, 'native-fixture'), cotalHome, space: report.managerHost.space, output, id, stage: 'after-stop' });
      } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (report.desktop?.hostedManager && !uncertain) {
      try {
        report.desktop.hostedManager.stop = await daemon('stop desktop-hosted Manager', ['daemon', 'service-disconnect', '--space', report.desktop.hostedManager.space, '--json']);
        check('desktop-hosted Manager stop succeeds', report.desktop.hostedManager.stop.exit === 0, report.desktop.hostedManager.stop);
        ok(report.desktop.hostedManager.stop, 'desktop Manager cleanup');
      } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (installedService) {
      report.cleanup = 'retained for disposable runner teardown';
      if (!uncertain && receipt && existsSync(join(report.daemonHome, 'service-unit.json'))) {
        try {
          const current = json(join(report.daemonHome, 'service-unit.json'));
          assert.equal(current.unit, receipt.unit);
          assert.equal(current.unitPath, receipt.unitPath);
          assert.equal(digest(readFileSync(current.unitPath)), current.unitSha256);
          report.nativeUninstall = ok(await daemon('native uninstall', ['daemon', 'uninstall', '--yes', '--json']), 'native removal');
          assert(!existsSync(join(report.daemonHome, 'service-unit.json')) && !existsSync(plan.unitPath));
          report.cleanup = 'receipt-guarded native removal confirmed';
        } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
      }
    }
    if (compositionCleanup && (daemonHostedManager || report.desktop?.hostedManager)) {
      try {
        await compositionCleanup();
        report.compositionCleanup = (report.managerHost?.stop?.exit === 0 || report.desktop?.hostedManager?.stop?.exit === 0)
          ? 'owned composition stopped after confirmed hosted Manager removal'
          : 'owned composition stopped; hosted Manager removal not confirmed';
      }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (restoreRegistry && !uncertain && (!installedService || report.cleanup === 'receipt-guarded native removal confirmed')) {
      try { restoreRegistry(); report.registryConfig = 'restored before candidate registry stopped'; }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (overlay) report.registryRequests = await overlay.close();
    report.cleanupSafety = { required: true, uncertain, ownedStackExit: report.ownedStackCleanup?.exit, hostedAgentStopExit: report.managerHost?.stop?.exit ?? report.desktop?.hostedManager?.stop?.exit, nativeUninstallExit: report.nativeUninstall?.exit, container: report.foreignContainerCleanup, passed: !uncertain && !report.cleanupFailure && (!installedService || report.cleanup === 'receipt-guarded native removal confirmed') && (!stackStarted || report.ownedStackCleanup?.exit === 0) && (!container || report.foreignStackEnd?.passed === true) && (!daemonHostedManager || report.managerHost?.stop?.exit === 0) && (!report.desktop?.hostedManager || report.desktop.hostedManager.stop?.exit === 0) };
    if (!report.cleanupSafety.passed) { report.result = 'failed'; report.cleanupFailure ??= 'cleanup safety not established; retained for disposable runner teardown'; }
    if (!report.refusal && report.result === 'failed') report.refusal = report.cleanupFailure;
    if (options['expect-recovery-refusal'] === 'true') report.expectedRefusal = { kind: 'paused-snapshot reconciliation', passed: expectedRecoveryRefusal(report) };
    report.root = root;
    report.finishedAt = new Date().toISOString();
    report.retentionOwner = hosted ? 'disposable runner teardown' : 'lane owner after process quiescence';
    save(join(output, `${id}.json`), report);
    writeFileSync(join(output, `${id}.sha256`), `${digest(readFileSync(join(output, `${id}.json`)))}  ${id}.json\n${digest(readFileSync(join(output, `${id}.log`)))}  ${id}.log\n`);
    console.log(JSON.stringify({ tier: report.tier, cell: id, target: report.target, result: report.result, expectedRefusal: report.expectedRefusal, refusal: report.refusal, managerHostMode: report.environment.managerHostMode, cleanupSafety: report.cleanupSafety, evidence: join(output, `${id}.json`) }));
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `| Cell | Target | Result | Exact refusal |\n|---|---|---|---|\n| ${id} | ${report.target ?? 'unresolved'} | ${report.result} | ${(report.refusal ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')} |\n`, { flag: 'a' });
  }
  return report;
}

export function bootstrapVersion(latest, direction) {
  assert(/^\d+\.\d+\.\d+$/.test(latest), 'published latest must be stable numeric semver');
  assert(['A', 'B'].includes(direction));
  const [major, minor, patch] = latest.split('.').map(Number);
  assert([major, minor, patch].every(Number.isSafeInteger), 'published version exceeds safe numeric ordering');
  if (direction === 'B') return `${major}.${minor}.${patch + 1}`;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  assert(major > 0, 'no lower stable bootstrap exists below 0.0.0');
  return `${major - 1}.0.0`;
}

export function resolveCandidateSourceRoot(sourceRoot) {
  if (sourceRoot === undefined) return resolve(import.meta.dirname, '..');
  assert(typeof sourceRoot === 'string' && sourceRoot.trim(), 'explicit source root must be a non-empty path');
  const root = realpathSync(resolve(sourceRoot));
  const git = argv => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8' }).trim();
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), root, 'source root must be the actual Git root');
  assert.match(git(['rev-parse', '--verify', 'HEAD']), /^[a-f0-9]{40}$/, 'source root must have an immutable commit');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']), '', 'source root tracked tree must be clean, with no untracked product inputs');
  return root;
}

export async function packCandidate(output, version, sourceRoot) {
  const root = resolveCandidateSourceRoot(sourceRoot);
  if (['A', 'B'].includes(version)) {
    const [npm, prefix] = npmCommand();
    const env = cleanEnvironment();
    const latest = JSON.parse(execFileSync(npm, [...prefix, 'view', 'cotal-ai@latest', 'version', '--json'], { env, encoding: 'utf8' }));
    version = bootstrapVersion(latest, version);
  }
  assert(/^\d+\.\d+\.\d+$/.test(version), 'candidate bootstrap uses stable numeric semver for stock newerUpdate ordering');
  const rows = JSON.parse(execFileSync('pnpm', ['list', '-r', ...(sourceRoot === undefined ? [] : ['--include-workspace-root']), '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }));
  const expected = json(join(root, '.changeset/config.json')).fixed.flat();
  const manifests = rows.filter(row => expected.includes(row.name)).map(row => ({ path: join(row.path, 'package.json'), original: readFileSync(join(row.path, 'package.json'), 'utf8') }));
  assert.deepEqual(rows.filter(row => expected.includes(row.name)).map(row => row.name).sort(), [...expected].sort(), 'complete fixed-group package set');
  // A separate product's private root may pin fixed-group dependencies too.
  const rootManifest = join(root, 'package.json');
  if (sourceRoot !== undefined && !manifests.some(row => row.path === rootManifest)) {
    manifests.push({ path: rootManifest, original: readFileSync(rootManifest, 'utf8') });
  }
  const changes = [];
  try {
    for (const row of manifests) {
      const before = JSON.parse(row.original), after = structuredClone(before);
      if (expected.includes(before.name)) after.version = version;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const name of Object.keys(after[field] ?? {})) {
        if (expected.includes(name) && !after[field][name].startsWith('workspace:')) after[field][name] = version;
      }
      changes.push({ path: row.path, before, after });
      save(row.path, after);
    }
    const { packColdCandidate } = await import(pathToFileURL(join(root, 'scripts/pack-cold-candidate.mjs')).href);
    // Only release versions changed above. Do not let pnpm auto-reinstall/purge the
    // already-built dependency graph, but retain every prepublish and native guard.
    const exec = (file, argv, options) => execFileSync(file, argv, { ...options,
      env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'warn', PNPM_CONFIG_WORKSPACE_CONCURRENCY: '3' } });
    const manifest = packColdCandidate({ root, output, exec });
    const installerFile = join(resolve(output), 'installer.sh');
    copyFileSync(join(root, 'install.sh'), installerFile);
    save(join(resolve(output), 'installer.json'), { source: manifest.source, sha256: digest(readFileSync(installerFile)) });
    save(join(resolve(output), 'bootstrap.json'), { source: manifest.source, version, label: 'candidate-only version metadata; no installed file edits; never publish', changes });
    return manifest;
  } finally {
    for (const row of manifests) writeFileSync(row.path, row.original);
  }
}

export async function candidateRegistry(directory, direction, upstream) {
  assert(['A', 'B'].includes(direction), 'candidate direction must be A or B');
  assert.equal(new URL(upstream).origin, 'https://registry.npmjs.org', 'overlay only proxies the public registry, never private registry credentials');
  const manifest = json(join(directory, 'manifest.json'));
  const { list } = await import('tar');
  const entries = new Map(), archives = new Map(), requests = [];
  for (const pkg of manifest.packages) {
    assert(/^[^/\\]+\.tgz$/.test(pkg.archive), 'candidate archive path must be a basename');
    const file = join(directory, pkg.archive), bytes = readFileSync(file);
    assert.equal(digest(bytes), pkg.sha256, `candidate archive hash ${pkg.name}`);
    let metadata;
    await list({ file, strict: true, onReadEntry(entry) {
      if (entry.path !== 'package/package.json') { entry.resume(); return; }
      const chunks = [];
      entry.on('data', chunk => chunks.push(chunk));
      entry.on('end', () => { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
    } });
    assert.equal(metadata?.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    entries.set(pkg.name, metadata);
    archives.set(pkg.archive, bytes);
  }
  const expected = json(resolve(import.meta.dirname, '../.changeset/config.json')).fixed.flat().sort();
  assert.deepEqual([...entries.keys()].sort(), expected, 'overlay must carry every first-party package from the packed head');
  const versions = [...new Set(manifest.packages.map(pkg => pkg.version))];
  assert.equal(versions.length, 1, 'candidate closure is lockstep');
  const version = versions[0], cache = new Map();
  let url;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405).end('read-only candidate registry'); return; }
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
      requests.push({ at: new Date().toISOString(), path });
      if (path.startsWith('__candidate/')) {
        const bytes = archives.get(path.slice('__candidate/'.length));
        if (!bytes) { response.writeHead(404).end('unknown candidate archive'); return; }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes); return;
      }
        if (path.includes('/-/')) {
          const archiveResponse = await fetch(`${upstream.replace(/\/$/, '')}/${request.url.slice(1)}`, { signal: AbortSignal.timeout(30000) });
          response.writeHead(archiveResponse.status, { 'content-type': 'application/octet-stream' }).end(Buffer.from(await archiveResponse.arrayBuffer())); return;
        }
        const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
      const selector = path.slice(name.length + 1);
      if (!cache.has(name)) {
        const upstreamResponse = await fetch(`${upstream.replace(/\/$/, '')}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
        if (!upstreamResponse.ok) { response.writeHead(upstreamResponse.status).end(await upstreamResponse.text()); return; }
        cache.set(name, await upstreamResponse.json());
      }
      const packument = structuredClone(cache.get(name));
      const local = entries.get(name);
      if (local) {
        const pkg = manifest.packages.find(pkg => pkg.name === name), bytes = archives.get(pkg.archive);
        packument.versions[version] = { ...local, dist: { tarball: `${url}/__candidate/${pkg.archive}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') } };
        if (direction === 'B') packument['dist-tags'].latest = version;
      }
      const body = selector ? packument.versions[packument['dist-tags'][selector] ?? selector] : packument;
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { error: 'version not found' }));
    } catch (error) { response.writeHead(502).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, identity: { source: manifest.source, version, manifestSha256: digest(readFileSync(join(directory, 'manifest.json'))), direction, registry: 'synthetic candidate overlay', archives: manifest.packages.map(({ name, sha256 }) => ({ name, sha256 })) },
    close: async () => { save(join(directory, `registry-requests-${process.pid}.json`), requests); await new Promise(done => server.close(done)); return requests; } };
}

export const callTimeout = (label, platform = process.platform) => ['upgrade under test', 'candidate second hop under test'].includes(label) && platform === 'win32' ? 300000 : 180000;

export function updateCallDuration(report) {
  if (report.method === 'scheduler') return 'scheduler: not a direct update call';
  const calls = report.calls ?? [];
  let call = calls.find(call => call.label === 'upgrade under test');
  if (report.method === 'installer') {
    const installers = calls.filter(call => ['public installer', 'receipt-bound published installer', 'candidate source installer'].includes(call.label));
    if (installers.length > 1 || report.layout === 'npm' || report.id?.endsWith('-first-install')) call = installers.at(-1);
  }
  return call?.elapsedMs ?? 'no update call recorded';
}

export function summarize(directory) {
  const admissions = [];
  const reports = readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.json')).flatMap(name => {
    const file = join(directory, name);
    const row = json(file);
    if (String(name).endsWith('runner-admission.json')) {
      assert(['admitted', 'unrun'].includes(row.result) && typeof row.runner === 'string', 'invalid runner admission receipt');
      admissions.push(row);
    }
    if (!(row.id && row.tier && row.result)) return [];
    const coordFile = join(dirname(file), 'coordinate.json');
    let knownRefusal = null;
    if (existsSync(coordFile)) {
      const cell = json(coordFile);
      if (cell && !cell.chain && typeof cell.id === 'string' && typeof cell.phase === 'string' && typeof cell.sourceVersion === 'string') {
        try { knownRefusal = matchKnownRefusal(cell, row); } catch { knownRefusal = null; }
      }
    }
    return [{ ...row, ...(knownRefusal ? { knownRefusal: { id: knownRefusal.id, issue: knownRefusal.issue } } : {}) }];
  });
  assert(reports.length > 0 || admissions.length > 0, 'no upgrade cell or runner admission evidence found');
  const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const table = ['| Tier | Cell | Source | Target | Result | Update call duration (ms) | Exact refusal |', '|---|---|---|---|---|---|---|',
    ...reports.map(row => `| ${[row.tier, row.id, row.source, row.target, row.result, updateCallDuration(row), row.refusal].map(escape).join(' | ')} |`)];
  if (admissions.length) table.push('', '| Runner | Admission | Reason |', '|---|---|---|', ...admissions.map(row => `| ${[row.runner, row.result, row.reason].map(escape).join(' | ')} |`));
  const counts = reports.reduce((counts, row) => ({ ...counts, [row.result]: (counts[row.result] ?? 0) + 1 }), {});
  const summary = { counts, unexpectedFailures: reports.filter(row => !row.knownRefusal && cellExitCode(row) !== 0).length, admissions, cells: reports.map(row => { const { tier, id, result, target, harnessSource, harnessSha256, refusal, expectedRefusal, knownRefusal, targetUpgradeAcceptance, installerEscape } = row; return { tier, id, result, target, harnessSource, harnessSha256, refusal, expectedRefusal, ...(knownRefusal ? { knownRefusal } : {}), targetUpgradeAcceptance, installerEscape, updateCallDuration: updateCallDuration(row) }; }) };
  save(join(directory, 'summary.json'), summary);
  writeFileSync(join(directory, 'summary.md'), table.join('\n') + '\n');
  console.log(table.join('\n'));
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--list') {
    console.log(JSON.stringify(coordinates(process.argv[3] ?? process.platform), null, 2));
  } else if (process.argv[2] === '--summary') {
    const summary = summarize(resolve(process.argv[3]));
    process.exitCode = summary.unexpectedFailures ? 1 : 0;
  } else if (process.argv[2] === '--pack') {
    const options = args();
    await packCandidate(options.pack, options.version, options['source-root']);
  } else {
    const result = await matrixCell(args());
    process.exitCode = cellExitCode(result);
  }
}
