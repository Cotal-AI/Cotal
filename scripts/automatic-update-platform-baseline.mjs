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
import { createPreResultKill } from './mac-pre-result-kill.mjs';

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
  ? (report.expectedRefusal.passed ? 0 : 1)
  : (['passed', 'excluded'].includes(report.result) ? 0 : 1);

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
  if (publishedLaunchd) assert(!options.candidate && source === '0.164.6' && launchdProof === 'transition', 'published launchd proof requires released 0.164.6 transition');
  if (launchdProof) assert(hosted && process.platform === 'darwin' && (publishedLaunchd || options.candidate && (options.direction === 'A' || options.direction === 'B' && source === '0.164.6' && launchdProof === 'transition')) && state === 'daemon' && method === 'scheduler' && ['transition', 'off-before-tick', 'killed-before-result'].includes(launchdProof), 'launchd proof requires hosted macOS candidate-A, published or published-to-candidate scheduler');
  if (windowsPolicy) assert(hosted && process.platform === 'win32' && !options.candidate && source === '0.164.6' && layout === 'npm' && state === 'daemon' && method === 'scheduler', 'Windows policy baseline requires hosted published 0.164.6 npm daemon scheduler');
  const output = resolve(options.output ?? join(process.env.RUNNER_TEMP ?? '/var/tmp/upgrade-matrix', 'upgrade-evidence'));
  const variant = [options['stale-version'] ? `stale-${options['stale-version']}` : '', options['prior-status'] === 'true' ? 'prior-status' : '', options['desktop-runtime'] ? 'desktop-beside-cli' : '', options['stop-agents'] === 'true' ? 'stop-agents' : '', options['first-install'] === 'true' ? 'first-install' : '', launchdProof ?? '', windowsPolicy ? 'windows-policy' : ''].filter(Boolean).join('-');
  const id = `${options.candidate ? `candidate-${options.direction ?? 'B'}-` : 'published-'}${process.platform}-${source}-${layout}-${state}-${method}${variant ? `-${variant}` : ''}`;
  const report = { tier: options.candidate ? `candidate-${options.direction ?? 'B'} (synthetic registry, real native processes)` : 'published', id, sourceRequested: source, platform: process.platform, layout, state, method, calls: [], assertions: [], startedAt: new Date().toISOString(), harnessSource: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim(), harnessSha256: digest(readFileSync(import.meta.filename)) };
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
  const home = hosted && state === 'daemon' ? homedir() : join(root, 'home');
  const prefix = layout === 'installer' ? (launchdProof ? join(root, 'installer') : join(home, '.local/share/cotal')) : join(root, 'prefix');
  const project = join(root, 'project');
  for (const dir of [home, project, prefix]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project, '.cotal'), { mode: 0o700 });
  const env = { ...cleanEnvironment(), HOME: home, USERPROFILE: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache') };
  env.TMPDIR = join(root, 'tmp');
  mkdirSync(env.TMPDIR, { mode: 0o700 });
  if (!(hosted && state === 'daemon')) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'), XDG_RUNTIME_DIR: join(home, 'runtime'), LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming') });
  if (!hosted) env.COTAL_SKIP_CONNECTOR_SEED = '1';
  report.environment = { hostedDisposable: hosted, privateHome: home.startsWith(root), seedSkipped: env.COTAL_SKIP_CONNECTOR_SEED === '1', registryOverridden: Boolean(options.candidate), nativeServiceRequested: state === 'daemon' };
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
  async function call(label, file, argv, timeout = 180000) {
    if (/install|seed|upgrade under test/.test(label)) {
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
    if (result.exit === null || result.timeout || result.signal) { uncertain = true; throw new Error(`${label}: outcome unknown, retained for disposable runner teardown`); }
    return result;
  }
  const npmCall = (label, argv) => call(label, npm, [...npmPrefix, ...argv]);
  const cotal = (label, argv) => layout === 'installer' ? call(label, launcher, argv) : call(label, process.execPath, [cli, ...argv]);
  const daemon = (label, argv) => desktopRuntime
    ? call(label, desktopNode, [join(desktopRuntime, 'dist/cotal.js'), ...argv])
    : cotal(label, argv);
  function ok(result, label) { assert.equal(result.exit, 0, `${label}: ${result.stdout}${result.stderr}`); return result; }
  function check(name, passed, observed) { report.assertions.push({ name, passed, observed }); }
  async function installer(version, candidateTarget = false) {
    let script, label = 'public installer';
    if (publishedInstaller && (candidateTarget || options['installer-setup'] === 'true')) {
      report.publishedInstaller = verifyPublishedInstaller({ ...options, layout, method });
      script = report.publishedInstaller.path;
      label = 'receipt-bound published installer';
    } else if (candidateTarget && options['candidate-installer']) {
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
    if (options['expected-public-target']) assert.equal(report.target, options['expected-public-target'], 'public latest changed from the frozen proof baseline');
    if (expectedTarget && !options.candidate) assert.equal(report.target, expectedTarget, 'public target differs from frozen release; do not certify another version');
    report.resolvedBeforeCell = report.target;
    report.source = source === 'latest' ? report.target : source;
    if (publishedLaunchd) assert.notEqual(report.target, report.source, 'next published release is not available yet');
    report.registry = ok(await npmCall('record npm registry', ['config', 'get', 'registry']), 'registry').stdout.trim();
    if (options['source-candidate']) {
      assert(options.candidate && options.direction === 'B' && layout === 'npm' && state === 'configured', 'source candidate requires configured npm candidate-B proof');
      const sourceManifest = json(join(resolve(options['source-candidate']), 'manifest.json'));
      report.source = sourceManifest.packages[0].version;
      report.sourceCandidate = { source: sourceManifest.source, version: report.source, manifestSha256: digest(readFileSync(join(resolve(options['source-candidate']), 'manifest.json'))) };
    }
    if (options.candidate) {
      overlay = await candidateRegistry(resolve(options['source-candidate'] ?? options.candidate), options.direction ?? 'B', report.registry);
      report.candidate = overlay.identity;
      const numeric = value => value.split('.').map(Number);
      const compare = (a, b) => { const left = numeric(a), right = numeric(b); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]; return 0; };
      const targetVersion = options['source-candidate'] ? json(join(resolve(options.candidate), 'manifest.json')).packages[0].version : overlay.identity.version;
      assert((options.direction ?? 'B') === 'B' ? compare(targetVersion, report.source) > 0 : compare(report.target, overlay.identity.version) > 0, 'candidate ordering must permit a real version-changing stock update');
      env.npm_config_registry = overlay.url;
      if ((options.direction ?? 'B') === 'B') report.target = targetVersion;
      else report.source = overlay.identity.version;
      if (expectedTarget) assert.equal(report.target, expectedTarget, 'packed target differs from frozen version PR head');
      // Native services read npm's normal per-account config, not the launching shell's registry env.
      restoreRegistry = configureCandidateRegistry(home, overlay.url);
    }
    const sourceInstall = ok(layout === 'installer' ? await installer(report.source) : await npmCall('install published source', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.source}`, '--no-audit', '--no-fund']), 'source install');
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
    if (['configured', 'daemon', 'agent', 'concurrent', 'stale-extensions'].includes(state)) {
      ok(await cotal('seed published connectors', ['ext', 'seed']), 'connector setup');
      ok(await cotal('install published runtime', ['ext', 'add', `@cotal-ai/tmux@${report.source}`]), 'runtime setup');
    }
    if (options['source-candidate']) {
      const sourceIdentity = overlay.identity;
      restoreRegistry();
      report.sourceRegistryRequests = await overlay.close();
      overlay = await candidateRegistry(resolve(options.candidate), 'B', report.registry, resolve(options['source-candidate']));
      assert.equal(overlay.identity.source, sourceIdentity.source, 'candidate A/B must come from the same source');
      report.sourceCandidate = sourceIdentity;
      report.candidate = overlay.identity;
      env.npm_config_registry = overlay.url;
      restoreRegistry = configureCandidateRegistry(home, overlay.url);
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
        'RUN npm install -g cotal-ai@0.164.6 --no-audit --no-fund',
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
      writeFileSync(seat, `import {CotalEndpoint} from ${JSON.stringify(core)};import {readFileSync} from 'node:fs';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,...(e.COTAL_CREDS?{creds:readFileSync(e.COTAL_CREDS,'utf8')}:{}),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();setInterval(()=>{},1000);for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`);
      const ready = join(root, 'writer-ready'), release = join(root, 'writer-release');
      releaseHolder = () => writeFileSync(release, 'release');
      writeFileSync(join(fixture, 'index.js'), `import {registry} from ${JSON.stringify(core)};import {existsSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';if(process.env.MATRIX_HOLD==='1'){writeFileSync(${JSON.stringify(ready)},'ready');const deadline=Date.now()+30000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('fixture writer deadline');await delay(50);}}registry.register({kind:'connector',name:'upgrade-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
      if (state === 'agent') {
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
      ok(await cotal('set automatic updates before native service', ['update', '--auto', launchdProof === 'off-before-tick' ? 'off' : 'on']), 'automatic settings');
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
      if (desktopRuntime) {
        report.desktop = { runtime: desktopRuntime, inventory: desktopInventory, nodeSha256: digest(readFileSync(desktopNode)), release: 'v0.164.2', workflowRun: 43456519342 };
        assert.equal(report.daemonBefore.version, '0.164.2');
        assert.equal(report.daemonBefore.update.channel, 'desktop');
        assert.equal(report.daemonBefore.update.automatic, false);
        assert(readFileSync(plan.unitPath, 'utf8').includes(desktopRuntime), 'native service source must name actual released desktop runtime');
      }
      if (method === 'scheduler' && process.platform === 'linux') {
        // Native custody observation runs asynchronously after the socket first becomes ready.
        for (let i = 0; i < 90 && !report.daemonBefore.update?.automatic; i++) {
          await delay(1000);
          const status = await cotal('wait for verified native scheduler custody', ['daemon', 'status', '--json']);
          if (status.exit === 0) report.daemonBefore = JSON.parse(status.stdout).result;
        }
      }
    }
    report.extensionsBefore = existsSync(join(config, 'extensions/extensions.json')) ? json(join(config, 'extensions/extensions.json')).extensions : [];
    report.targetBeforeAction = report.target;
    report.versionChanging = report.source !== report.target;
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
    let update;
    if (options['first-install'] === 'true') update = sourceInstall;
    else if (options['bootstrap-reconcile'] === 'true') {
      assert(options.candidate && layout === 'npm' && method === 'self', 'bootstrap proof requires a candidate npm source');
      report.bootstrapInstall = ok(await npmCall('replace package as public installer', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.target}`, '--no-audit', '--no-fund']), 'candidate package replacement');
      assert.equal(json(join(pkg, 'package.json')).version, report.target, 'bootstrap installed target before executing its entry');
      update = await cotal('candidate own reconciliation after package replacement', ['update']);
    }
    else if (method === 'self') update = await cotal('upgrade under test', ['update', '--self', ...(options['stop-agents'] === 'true' ? ['--stop-agents'] : [])]);
    else if (method === 'installer') update = await installer(report.target, true);
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
        let installedVersion;
        try { installedVersion = json(join(pkg, 'package.json')).version; }
        catch (error) { if (error.code === 'ENOENT') { report.schedulerReplacementObserved = true; continue; } throw error; }
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
      check('scheduler completed within observation deadline', report.source === report.target ? attempt.result === 'up to date' : json(join(pkg, 'package.json')).version === report.target && /^(?:repaired and )?updated to /i.test(attempt.result), attempt);
      update = { exit: 0, stdout: existsSync(join(cotalHome, 'update-attempt.log')) ? readFileSync(join(cotalHome, 'update-attempt.log'), 'utf8') : '', stderr: '' };
      save(join(output, `${id}-scheduler-after.json`), { check: json(join(cotalHome, 'update-check.json')), attempt: json(join(cotalHome, 'update-attempt.json')) });
      check('daemon scheduler performed a replacement or reported up to date', report.source === report.target || update.stdout.length > 0, update.stdout);
      }
    }
    const expectedVersion = launchdProof === 'off-before-tick' ? report.source : report.target;
    report.expectedVersion = expectedVersion;
    report.update = update;
    const selectedVersions = selectedTargets(update.stdout + update.stderr);
    report.updaterSelectedVersions = selectedVersions;
    report.updaterSelectedVersion = selectedVersions[0];
    check('upgrade exits successfully', update.exit === 0, update);
    check('CLI version is target', json(join(pkg, 'package.json')).version === expectedVersion, json(join(pkg, 'package.json')).version);
    const manifest = join(config, 'extensions/extensions.json');
    const extensions = existsSync(manifest) ? json(manifest).extensions : [];
    report.extensionsAfter = extensions;
    check('every prior extension remains recorded', report.extensionsBefore.every(before => extensions.some(after => after.pkg === before.pkg)), extensions.map(entry => entry.pkg));
    check('every recorded extension is at target', extensions.every(entry => entry.version === expectedVersion), extensions.map(({ pkg, version }) => ({ pkg, version })));
    const version = await cotal('selected CLI version assertion', ['--version']);
    check('selected CLI reports target', version.exit === 0 && cliReportsVersion(version.stdout, expectedVersion), version);
    check('recorded extension package versions match target', extensions.every(entry => {
      const path = join(config, 'extensions/node_modules', entry.pkg, 'package.json');
      return existsSync(path) && json(path).version === expectedVersion;
    }), extensions.map(entry => ({ pkg: entry.pkg, path: join(config, 'extensions/node_modules', entry.pkg, 'package.json') })));
    const status = await cotal('status assertion', ['status']);
    check('cotal status exits zero', status.exit === 0, status);
    const recovery = existsSync(join(cotalHome, 'update-recovery.json')) ? json(join(cotalHome, 'update-recovery.json')) : null;
    check('no paused recovery record', recovery === null, recovery);
    if (foreignSnapshot) check('foreign snapshot bytes remain untouched', existsSync(join(report.foreignSnapshot.path, 'foreign-owner-sentinel')) && digest(readFileSync(join(report.foreignSnapshot.path, 'foreign-owner-sentinel'))) === report.foreignSnapshot.sentinelSha256 && readdirSync(report.foreignSnapshot.path).join(',') === 'foreign-owner-sentinel', report.foreignSnapshot);
    if (container) {
      const current = JSON.parse(ok(await call('foreign container after host upgrade', 'docker', ['inspect', container.id]), 'foreign container preservation').stdout)[0];
      check('foreign container Manager remains running and untouched', current.Id === container.id && current.Config.Labels['cotal.upgrade.cell'] === container.label && current.State.Running === true && current.State.Pid === container.pid && current.State.StartedAt === container.startedAt, { before: container, after: current.State });
    }
    if (installedService) {
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
    if (compositionCleanup) {
      try { await compositionCleanup(); report.compositionCleanup = 'owned composition stopped before reporting'; }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (container) {
      try {
        const current = JSON.parse(ok(await call('verify owned container before stop', 'docker', ['inspect', container.id]), 'container cleanup ownership').stdout)[0];
        assert.equal(current.Id, container.id); assert.equal(current.Config.Labels['cotal.upgrade.cell'], container.label);
        if (current.State.Running) report.foreignStackStop = await call('stop stock stack inside owned foreign container', 'docker', ['exec', container.id, 'sh', '-c', 'export HOME=/tmp/foreign-home COTAL_HOME=/tmp/foreign-home/.cotal XDG_CONFIG_HOME=/tmp/foreign-home/config; cd /tmp/project; cotal down --with-agents'], 60000);
        ok(await call('stop owned foreign supervisor and broker', 'docker', ['stop', '--time', '20', container.id], 60000), 'foreign container stop');
        const stopped = JSON.parse(ok(await call('confirm owned foreign container stopped', 'docker', ['inspect', container.id]), 'container stop proof').stdout)[0];
        assert.equal(stopped.State.Running, false);
        report.foreignContainerCleanup = 'owned container stopped, not deleted, before reporting';
      } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
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
      try { ok(await cotal('stop owned local stack', ['down', '--yes']), 'local stack cleanup'); }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (installedService) {
      report.cleanup = 'retained for disposable runner teardown';
      if (!uncertain && receipt && existsSync(join(report.daemonHome, 'service-unit.json'))) {
        try {
          const current = json(join(report.daemonHome, 'service-unit.json'));
          assert.equal(current.unit, receipt.unit);
          assert.equal(current.unitPath, receipt.unitPath);
          assert.equal(digest(readFileSync(current.unitPath)), current.unitSha256);
          ok(await daemon('native uninstall', ['daemon', 'uninstall', '--yes', '--json']), 'native removal');
          assert(!existsSync(join(report.daemonHome, 'service-unit.json')) && !existsSync(plan.unitPath));
          report.cleanup = 'receipt-guarded native removal confirmed';
        } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
      }
    }
    if (restoreRegistry && !uncertain && (!installedService || report.cleanup === 'receipt-guarded native removal confirmed')) {
      try { restoreRegistry(); report.registryConfig = 'restored before candidate registry stopped'; }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (overlay) report.registryRequests = await overlay.close();
    if (!report.refusal && report.result === 'failed') report.refusal = report.cleanupFailure;
    if (options['expect-recovery-refusal'] === 'true') report.expectedRefusal = { kind: 'paused-snapshot reconciliation', passed: expectedRecoveryRefusal(report) };
    report.root = root;
    report.finishedAt = new Date().toISOString();
    report.retentionOwner = hosted ? 'disposable runner teardown' : 'lane owner after process quiescence';
    save(join(output, `${id}.json`), report);
    writeFileSync(join(output, `${id}.sha256`), `${digest(readFileSync(join(output, `${id}.json`)))}  ${id}.json\n${digest(readFileSync(join(output, `${id}.log`)))}  ${id}.log\n`);
    console.log(JSON.stringify({ tier: report.tier, cell: id, target: report.target, result: report.result, expectedRefusal: report.expectedRefusal, refusal: report.refusal, evidence: join(output, `${id}.json`) }));
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

export async function candidateRegistry(directory, direction, upstream, previousDirectory) {
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
  const previousEntries = new Map();
  if (previousDirectory) {
    const previous = json(join(previousDirectory, 'manifest.json'));
    assert.equal(previous.source, manifest.source, 'previous candidate must match target source');
    assert.deepEqual(previous.packages.map(pkg => pkg.name).sort(), expected, 'previous candidate closure must be complete');
    const previousVersions = [...new Set(previous.packages.map(pkg => pkg.version))];
    assert.equal(previousVersions.length, 1, 'previous candidate closure is lockstep');
    assert.match(previousVersions[0], /^\d+\.\d+\.\d+$/);
    const before = previousVersions[0].split('.').map(Number), after = versions[0].split('.').map(Number);
    assert(before[0] < after[0] || before[0] === after[0] && (before[1] < after[1] || before[1] === after[1] && before[2] < after[2]), 'previous candidate must be older than target');
    for (const pkg of previous.packages) {
      assert(/^[^/\\]+\.tgz$/.test(pkg.archive), 'previous candidate archive path must be a basename');
      assert(!archives.has(pkg.archive), 'candidate archive basenames must not collide');
      const file = join(previousDirectory, pkg.archive), bytes = readFileSync(file);
      assert.equal(digest(bytes), pkg.sha256, 'previous candidate archive hash');
      let metadata;
      await list({ file, strict: true, onReadEntry(entry) {
        if (entry.path !== 'package/package.json') { entry.resume(); return; }
        const chunks = [];
        entry.on('data', chunk => chunks.push(chunk));
        entry.on('end', () => { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
      } });
      assert.equal(metadata?.name, pkg.name);
      assert.equal(metadata?.version, pkg.version);
      assert.notEqual(pkg.version, versions[0], 'previous and target versions must differ');
      previousEntries.set(pkg.name, { pkg, bytes, metadata });
      archives.set(pkg.archive, bytes);
    }
  }
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
      const previous = previousEntries.get(name);
      if (previous) {
        const { pkg, bytes, metadata } = previous;
        packument.versions[pkg.version] = { ...metadata, dist: { tarball: `${url}/__candidate/${pkg.archive}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') } };
      }
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

export function summarize(directory) {
  const admissions = [];
  const reports = readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.json')).flatMap(name => {
    const row = json(join(directory, name));
    if (String(name).endsWith('runner-admission.json')) {
      assert(['admitted', 'unrun'].includes(row.result) && typeof row.runner === 'string', 'invalid runner admission receipt');
      admissions.push(row);
    }
    return row.id && row.tier && row.result ? [row] : [];
  });
  assert(reports.length > 0 || admissions.length > 0, 'no upgrade cell or runner admission evidence found');
  const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const table = ['| Tier | Cell | Source | Target | Result | Exact refusal |', '|---|---|---|---|---|---|',
    ...reports.map(row => `| ${[row.tier, row.id, row.source, row.target, row.result, row.refusal].map(escape).join(' | ')} |`)];
  if (admissions.length) table.push('', '| Runner | Admission | Reason |', '|---|---|---|', ...admissions.map(row => `| ${[row.runner, row.result, row.reason].map(escape).join(' | ')} |`));
  const counts = reports.reduce((counts, row) => ({ ...counts, [row.result]: (counts[row.result] ?? 0) + 1 }), {});
  const summary = { counts, admissions, cells: reports.map(({ tier, id, result, target, harnessSource, harnessSha256, refusal }) => ({ tier, id, result, target, harnessSource, harnessSha256, refusal })) };
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
    process.exitCode = summary.counts.failed || summary.counts.unsupported ? 1 : 0;
  } else if (process.argv[2] === '--pack') {
    const options = args();
    await packCandidate(options.pack, options.version, options['source-root']);
  } else {
    const result = await matrixCell(args());
    process.exitCode = cellExitCode(result);
  }
}
