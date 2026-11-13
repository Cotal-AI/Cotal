/** Native lifecycle baseline and real published upgrade matrix. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const sources = ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest'];
export const states = ['fresh', 'configured', 'daemon', 'agent', 'stale-extensions', 'recovery', 'concurrent'];
export const methods = ['self', 'scheduler', 'installer'];
const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const requiresManualStep = output => /run `cotal|run cotal|manual (?:step|intervention)|interrupted update|OPERATION_UNKNOWN|Outcome unconfirmed|needs restoration|refused/i.test(output);
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
export function verifyCandidateInstaller(directory, script) {
  const identity = json(join(directory, 'installer.json'));
  const candidate = json(join(directory, 'manifest.json'));
  const result = { path: resolve(script), sha256: digest(readFileSync(script)), source: identity.source };
  assert.match(identity.source, /^[a-f0-9]{40}$/);
  assert.equal(identity.source, candidate.source, 'candidate installer and packed closure source differ');
  assert.equal(result.sha256, identity.sha256, 'candidate installer differs from packed source receipt');
  return result;
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
  assert(sources.includes(source) && states.includes(state) && methods.includes(method) && ['npm', 'installer'].includes(layout), 'unknown matrix coordinate');
  const output = resolve(options.output ?? join(process.env.RUNNER_TEMP ?? '/var/tmp/upgrade-matrix', 'upgrade-evidence'));
  const id = `${options.candidate ? `candidate-${options.direction ?? 'B'}-` : 'published-'}${process.platform}-${source}-${layout}-${state}-${method}`;
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
  const prefix = layout === 'installer' ? join(home, '.local/share/cotal') : join(root, 'prefix');
  const project = join(root, 'project');
  for (const dir of [home, project, prefix]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project, '.cotal'), { mode: 0o700 });
  const env = { ...cleanEnvironment(), HOME: home, USERPROFILE: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache') };
  if (!(hosted && state === 'daemon')) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'), XDG_RUNTIME_DIR: join(home, 'runtime'), LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming') });
  if (!hosted) env.COTAL_SKIP_CONNECTOR_SEED = '1';
  report.environment = { hostedDisposable: hosted, privateHome: home.startsWith(root), seedSkipped: env.COTAL_SKIP_CONNECTOR_SEED === '1', registryOverridden: Boolean(options.candidate), nativeServiceRequested: state === 'daemon' };
  for (const key of ['XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) if (env[key] && env[key].startsWith(root)) mkdirSync(env[key], { recursive: true, mode: 0o700 });
  const cotalHome = env.COTAL_HOME ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA, 'Cotal') : join(home, '.cotal'));
  const config = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cotal') : process.platform === 'win32' ? join(env.APPDATA, 'Cotal') : join(home, '.config/cotal');
  const modules = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  const pkg = join(modules, 'cotal-ai');
  const cli = join(pkg, 'dist/cotal.js');
  const launcher = join(home, '.local/bin/cotal');
  env.PATH = [join(prefix, process.platform === 'win32' ? '' : 'bin'), join(home, '.local/bin'), env.PATH].join(delimiter);
  const [npm, npmPrefix] = npmCommand();
  let uncertain = false, installedService = false, stackStarted = false, plan, receipt, holderPromise, releaseHolder, overlay;
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
    const entry = { label, file, argv, startedAt, ...result };
    report.calls.push(entry);
    transcript.push(`$ ${file} ${argv.join(' ')}\n${result.stdout}${result.stderr}\n[exit ${result.exit}]\n`);
    writeFileSync(join(output, `${id}.log`), transcript.join('\n'), { mode: 0o600 });
    if (result.exit === null || result.timeout || result.signal) { uncertain = true; throw new Error(`${label}: outcome unknown, retained for disposable runner teardown`); }
    return result;
  }
  const npmCall = (label, argv) => call(label, npm, [...npmPrefix, ...argv]);
  const cotal = (label, argv) => layout === 'installer' ? call(label, launcher, argv) : call(label, process.execPath, [cli, ...argv]);
  function ok(result, label) { assert.equal(result.exit, 0, `${label}: ${result.stdout}${result.stderr}`); return result; }
  function check(name, passed, observed) { report.assertions.push({ name, passed, observed }); }
  async function installer(version, candidateTarget = false) {
    let script;
    if (candidateTarget && options['candidate-installer']) {
      assert(options.candidate, 'candidate installer is forbidden in published tier');
      script = resolve(options['candidate-installer']);
      report.candidateInstaller = verifyCandidateInstaller(resolve(options.candidate), script);
    } else {
      const fetched = ok(await call('download public installer', 'curl', ['-fsSL', 'https://get.cotal.ai']), 'installer download');
      script = join(root, 'public-installer.sh');
      writeFileSync(script, fetched.stdout, { mode: 0o600 });
      report.installerSha256 = digest(fetched.stdout);
    }
    return call(candidateTarget && options['candidate-installer'] ? 'candidate source installer' : 'public installer', 'sh', [script, '--version', version, '--no-setup', '--no-modify-path']);
  }
  try {
    const target = ok(await npmCall('resolve public latest', ['view', 'cotal-ai@latest', 'version', '--json']), 'public latest');
    report.target = JSON.parse(target.stdout);
    report.resolvedBeforeCell = report.target;
    report.source = source === 'latest' ? report.target : source;
    report.registry = ok(await npmCall('record npm registry', ['config', 'get', 'registry']), 'registry').stdout.trim();
    if (options.candidate) {
      overlay = await candidateRegistry(resolve(options.candidate), options.direction ?? 'B', report.registry);
      report.candidate = overlay.identity;
      const numeric = value => value.split('.').map(Number);
      const compare = (a, b) => { const left = numeric(a), right = numeric(b); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]; return 0; };
      assert((options.direction ?? 'B') === 'B' ? compare(overlay.identity.version, report.source) > 0 : compare(report.target, overlay.identity.version) > 0, 'candidate ordering must permit a real version-changing stock update');
      env.npm_config_registry = overlay.url;
      if ((options.direction ?? 'B') === 'B') report.target = overlay.identity.version;
      else report.source = overlay.identity.version;
      // Native services read npm's normal per-account config, not the launching shell's registry env.
      writeFileSync(join(home, '.npmrc'), `registry=${overlay.url}\n`, { mode: 0o600 });
    }
    ok(layout === 'installer' ? await installer(report.source) : await npmCall('install published source', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.source}`, '--no-audit', '--no-fund']), 'source install');
    assert.equal(json(join(pkg, 'package.json')).version, report.source, 'source installed version');
    report.sourceManifestSha256 = digest(readFileSync(join(pkg, 'package.json')));
    if (process.platform === 'win32') {
      const core = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
      const prepare = `const {mkSecretDir}=await import(${JSON.stringify(core)});for(const dir of ${JSON.stringify([root, ...(home.startsWith(root) ? [home] : []), project])})mkSecretDir(dir);`;
      ok(await call('harden native fixture directories', process.execPath, ['--input-type=module', '-e', prepare]), 'published private-directory preparation');
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
    if (state === 'stale-extensions') {
      const old = report.source === '0.155.0' ? '0.154.0' : '0.155.0';
      ok(await cotal('install older recorded extension', ['ext', 'add', `@cotal-ai/tmux@${old}`]), 'older runtime');
      report.staleVersion = old;
    }
    if (state === 'recovery') {
      mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
      const snapshot = join(config, '.update-snapshot-missing');
      const renames = ['extensions', ...['authority.bak.json', 'authority.json', 'reconcile.cursor.json', 'stamp.json', 'witness.json'].map(name => `seed/${name}`)].flatMap(name => [
        { from: join(config, name), to: join(snapshot, `failed-${name}`), done: true },
        { from: join(snapshot, name), to: join(config, name), done: true },
      ]);
      const fixture = { v: 1, previous: report.source, target: report.target, installed: 'unknown', phase: 'paused', reason: 'interrupted update restore failed: invalid update snapshot directory', owner: { pid: 2147483647, start: '0', nonce: 'fixture-not-a-credential' }, preparedRestart: false, snapshot, renames, recordedAt: new Date().toISOString() };
      save(join(cotalHome, 'update-recovery.json'), fixture);
      report.syntheticFixture = 'paused recovery journal with a missing snapshot and completed rename entries';
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
    if (state === 'daemon') {
      const planned = ok(await cotal('native install plan', ['daemon', 'install', '--dry-run', '--json']), 'native plan');
      plan = JSON.parse(planned.stdout).result;
      assert.equal(plan.state, 'would-install', 'native service must be absent before this cell');
      report.daemonHome = plan.daemonHome ?? join(cotalHome, 'daemon');
      ok(await cotal('enable automatic updates', ['update', '--auto', 'on']), 'automatic settings');
      installedService = true;
      ok(await cotal('native install', ['daemon', 'install', '--json']), 'native installation');
      receipt = json(join(report.daemonHome, 'service-unit.json'));
      assert.equal(receipt.unit, plan.unit);
      assert.equal(receipt.unitSha256, digest(readFileSync(plan.unitPath)));
      for (let i = 0; i < 60; i++) {
        const status = await cotal('native status before', ['daemon', 'status', '--json']);
        if (status.exit === 0 && JSON.parse(status.stdout).result?.state === 'ready') {
          report.daemonBefore = JSON.parse(status.stdout).result;
          break;
        }
        await delay(1000);
      }
      assert(report.daemonBefore, 'native daemon ready before update');
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
    if (!options.candidate) {
      report.target = JSON.parse(ok(await npmCall('resolve public latest immediately before action', ['view', 'cotal-ai@latest', 'version', '--json']), 'latest before action').stdout);
      report.versionChanging = report.source !== report.target;
    }
    let update;
    if (method === 'self') update = await cotal('upgrade under test', ['update', '--self', ...(options['stop-agents'] === 'true' ? ['--stop-agents'] : [])]);
    else if (method === 'installer') update = await installer(report.target, true);
    else {
      assert.equal(report.daemonBefore.update.automatic, true, report.daemonBefore.update.lastResult);
      // Wait for the daemon's normal timer to populate the registry cache. Do not invoke an updater.
      for (let i = 0; i < 60 && !existsSync(join(cotalHome, 'update-check.json')); i++) await delay(1000);
      assert(existsSync(join(cotalHome, 'update-check.json')), 'daemon normal registry check created cache');
      for (const [name, fields] of [['update-check.json', ['checkedAt', 'firstSeenAt', 'attemptedAt']], ['update-attempt.json', ['next']]]) {
        const file = join(cotalHome, name), before = json(file), after = { ...before };
        for (const field of fields) after[field] = Date.now() - 7200000;
        save(join(output, `${id}-${name}-clock.json`), { before, after });
        save(file, after);
      }
      const deadline = Date.now() + 300000;
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
        if (installedVersion === report.target && status.exit === 0 && JSON.parse(status.stdout).result?.state === 'ready') {
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
    report.update = update;
    const selectedVersions = selectedTargets(update.stdout + update.stderr);
    report.updaterSelectedVersions = selectedVersions;
    report.updaterSelectedVersion = selectedVersions[0];
    check('upgrade exits successfully', update.exit === 0, update);
    check('CLI version is target', json(join(pkg, 'package.json')).version === report.target, json(join(pkg, 'package.json')).version);
    const manifest = join(config, 'extensions/extensions.json');
    const extensions = existsSync(manifest) ? json(manifest).extensions : [];
    report.extensionsAfter = extensions;
    check('every prior extension remains recorded', report.extensionsBefore.every(before => extensions.some(after => after.pkg === before.pkg)), extensions.map(entry => entry.pkg));
    check('every recorded extension is at target', extensions.every(entry => entry.version === report.target), extensions.map(({ pkg, version }) => ({ pkg, version })));
    const version = await cotal('selected CLI version assertion', ['--version']);
    check('selected CLI reports target', version.exit === 0 && cliReportsVersion(version.stdout, report.target), version);
    check('recorded extension package versions match target', extensions.every(entry => {
      const path = join(config, 'extensions/node_modules', entry.pkg, 'package.json');
      return existsSync(path) && json(path).version === report.target;
    }), extensions.map(entry => ({ pkg: entry.pkg, path: join(config, 'extensions/node_modules', entry.pkg, 'package.json') })));
    const status = await cotal('status assertion', ['status']);
    check('cotal status exits zero', status.exit === 0, status);
    const recovery = existsSync(join(cotalHome, 'update-recovery.json')) ? json(join(cotalHome, 'update-recovery.json')) : null;
    check('no paused recovery record', recovery === null, recovery);
    if (installedService) {
      const active = await cotal('native status after', ['daemon', 'status', '--json']);
      check('native daemon remains active', active.exit === 0 && JSON.parse(active.stdout).result?.state === 'ready', active);
    }
    check('no manual step or refusal', update.exit === 0 && !requiresManualStep(update.stdout + update.stderr), update.stdout + update.stderr);
    report.result = report.assertions.every(row => row.passed) ? 'passed' : 'failed';
    if (report.result === 'failed') report.refusal = report.assertions.filter(row => !row.passed).map(row => `${row.name}: ${typeof row.observed === 'string' ? row.observed : JSON.stringify(row.observed)}`).join('\n');
  } catch (error) {
    if (method === 'scheduler' && report.daemonBefore) {
      try { if (/^updating to /.test(json(join(cotalHome, 'update-attempt.json')).result)) uncertain = true; }
      catch { uncertain = true; }
    }
    report.result = 'failed'; report.refusal = error.message;
  } finally {
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
          ok(await cotal('native uninstall', ['daemon', 'uninstall', '--yes', '--json']), 'native removal');
          assert(!existsSync(join(report.daemonHome, 'service-unit.json')) && !existsSync(plan.unitPath));
          report.cleanup = 'receipt-guarded native removal confirmed';
        } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
      }
    }
    if (overlay) report.registryRequests = await overlay.close();
    if (!report.refusal && report.result === 'failed') report.refusal = report.cleanupFailure;
    report.root = root;
    report.finishedAt = new Date().toISOString();
    report.retentionOwner = hosted ? 'disposable runner teardown' : 'lane owner after process quiescence';
    save(join(output, `${id}.json`), report);
    writeFileSync(join(output, `${id}.sha256`), `${digest(readFileSync(join(output, `${id}.json`)))}  ${id}.json\n${digest(readFileSync(join(output, `${id}.log`)))}  ${id}.log\n`);
    console.log(JSON.stringify({ tier: report.tier, cell: id, target: report.target, result: report.result, refusal: report.refusal, evidence: join(output, `${id}.json`) }));
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

export async function packCandidate(output, version) {
  if (['A', 'B'].includes(version)) {
    const [npm, prefix] = npmCommand();
    const env = cleanEnvironment();
    const latest = JSON.parse(execFileSync(npm, [...prefix, 'view', 'cotal-ai@latest', 'version', '--json'], { env, encoding: 'utf8' }));
    version = bootstrapVersion(latest, version);
  }
  assert(/^\d+\.\d+\.\d+$/.test(version), 'candidate bootstrap uses stable numeric semver for stock newerUpdate ordering');
  const root = resolve(import.meta.dirname, '..');
  const rows = JSON.parse(execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }));
  const expected = json(join(root, '.changeset/config.json')).fixed.flat();
  const manifests = rows.filter(row => expected.includes(row.name)).map(row => ({ path: join(row.path, 'package.json'), original: readFileSync(join(row.path, 'package.json'), 'utf8') }));
  assert.equal(manifests.length, expected.length, 'complete fixed-group package set');
  const changes = [];
  try {
    for (const row of manifests) {
      const before = JSON.parse(row.original), after = structuredClone(before);
      after.version = version;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const name of Object.keys(after[field] ?? {})) {
        if (expected.includes(name) && !after[field][name].startsWith('workspace:')) after[field][name] = version;
      }
      changes.push({ path: row.path, before, after });
      save(row.path, after);
    }
    const { packColdCandidate } = await import('./pack-cold-candidate.mjs');
    const manifest = packColdCandidate({ root, output });
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

export function summarize(directory) {
  const reports = readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.json')).flatMap(name => {
    const row = json(join(directory, name));
    return row.id && row.tier && row.result ? [row] : [];
  });
  assert(reports.length > 0, 'no upgrade cell evidence found');
  const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const table = ['| Tier | Cell | Source | Target | Result | Exact refusal |', '|---|---|---|---|---|---|',
    ...reports.map(row => `| ${[row.tier, row.id, row.source, row.target, row.result, row.refusal].map(escape).join(' | ')} |`)];
  const counts = reports.reduce((counts, row) => ({ ...counts, [row.result]: (counts[row.result] ?? 0) + 1 }), {});
  const summary = { counts, cells: reports.map(({ tier, id, result, target, harnessSource, harnessSha256, refusal }) => ({ tier, id, result, target, harnessSource, harnessSha256, refusal })) };
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
    await packCandidate(options.pack, options.version);
  } else {
    const result = await matrixCell(args());
    process.exitCode = ['passed', 'excluded'].includes(result.result) ? 0 : 1;
  }
}
