/** Native lifecycle baseline and real published upgrade matrix. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const sources = ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest'];
export const states = ['fresh', 'configured', 'daemon', 'agent', 'stale-extensions', 'recovery', 'concurrent'];
export const methods = ['self', 'scheduler', 'installer'];
const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const requiresManualStep = output => /run `cotal|run cotal|manual (?:step|intervention)|interrupted update|OPERATION_UNKNOWN|Outcome unconfirmed|needs restoration|refused/i.test(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function exclusion({ layout, method, state }) {
  if (layout === 'installer' && process.platform === 'win32') return 'No public Windows installer exists.';
  if (method === 'installer' && layout !== 'installer') return 'Installer rerun would change the npm-global installation route.';
  if (method === 'scheduler' && state !== 'daemon') return 'Scheduler rows require the pre-existing automatic daemon state.';
  return undefined;
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
  const id = `${process.platform}-${source}-${layout}-${state}-${method}`;
  const report = { tier: 'published', id, sourceRequested: source, platform: process.platform, layout, state, method, calls: [], assertions: [], startedAt: new Date().toISOString() };
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
  const env = { ...cleanEnvironment(), HOME: home, USERPROFILE: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache') };
  if (!(hosted && state === 'daemon')) Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming') });
  const cotalHome = env.COTAL_HOME ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA, 'Cotal') : join(home, '.cotal'));
  const config = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cotal') : process.platform === 'win32' ? join(env.APPDATA, 'Cotal') : join(home, '.config/cotal');
  const modules = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  const pkg = join(modules, 'cotal-ai');
  const cli = join(pkg, 'dist/cotal.js');
  const launcher = join(home, '.local/bin/cotal');
  env.PATH = [join(prefix, process.platform === 'win32' ? '' : 'bin'), join(home, '.local/bin'), env.PATH].join(delimiter);
  const [npm, npmPrefix] = npmCommand();
  let uncertain = false, installedService = false, stackStarted = false, plan, receipt, holderPromise, releaseHolder;
  const transcript = [];
  async function call(label, file, argv, timeout = 180000) {
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
  async function installer(version) {
    const fetched = ok(await call('download public installer', 'curl', ['-fsSL', 'https://get.cotal.ai']), 'installer download');
    const script = join(root, 'public-installer.sh');
    writeFileSync(script, fetched.stdout, { mode: 0o600 });
    report.installerSha256 = digest(fetched.stdout);
    return call('public installer', 'sh', [script, '--version', version, '--no-setup', '--no-modify-path']);
  }
  try {
    const target = ok(await npmCall('resolve public latest', ['view', 'cotal-ai@latest', 'version', '--json']), 'public latest');
    report.target = JSON.parse(target.stdout);
    report.source = source === 'latest' ? report.target : source;
    report.registry = ok(await npmCall('record npm registry', ['config', 'get', 'registry']), 'registry').stdout.trim();
    ok(layout === 'installer' ? await installer(report.source) : await npmCall('install published source', ['install', '-g', '--prefix', prefix, `cotal-ai@${report.source}`, '--no-audit', '--no-fund']), 'source install');
    assert.equal(json(join(pkg, 'package.json')).version, report.source, 'source installed version');
    report.sourceManifestSha256 = digest(readFileSync(join(pkg, 'package.json')));
    if (['configured', 'daemon', 'agent', 'concurrent'].includes(state)) {
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
        ok(await cotal('spawn real stand-in agent', ['spawn', '--type', 'upgrade-standin', '--name', 'upgrade-proof-worker', '--detach', '--space', 'upgrade-proof']), 'stand-in spawn');
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
      ok(await cotal('enable automatic updates', ['update', '--auto', 'on']), 'automatic settings');
      installedService = true;
      ok(await cotal('native install', ['daemon', 'install', '--json']), 'native installation');
      receipt = json(join(plan.daemonHome, 'service-unit.json'));
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
    }
    report.extensionsBefore = existsSync(join(config, 'extensions/extensions.json')) ? json(join(config, 'extensions/extensions.json')).extensions : [];
    let update;
    if (method === 'self') update = await cotal('upgrade under test', ['update', '--self']);
    else if (method === 'installer') update = await installer(report.target);
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
        const status = await cotal('scheduler observation', ['daemon', 'status', '--json']);
        report.schedulerLastStatus = status;
        if (json(join(pkg, 'package.json')).version === report.target && (report.source !== report.target || existsSync(join(cotalHome, 'update-attempt.log')))) break;
      } while (Date.now() < deadline);
      update = { exit: 0, stdout: existsSync(join(cotalHome, 'update-attempt.log')) ? readFileSync(join(cotalHome, 'update-attempt.log'), 'utf8') : '', stderr: '' };
      save(join(output, `${id}-scheduler-after.json`), { check: json(join(cotalHome, 'update-check.json')), attempt: json(join(cotalHome, 'update-attempt.json')) });
      check('daemon scheduler performed a replacement or reported up to date', report.source === report.target || update.stdout.length > 0, update.stdout);
    }
    report.update = update;
    check('upgrade exits successfully', update.exit === 0, update);
    check('CLI version is target', json(join(pkg, 'package.json')).version === report.target, json(join(pkg, 'package.json')).version);
    const manifest = join(config, 'extensions/extensions.json');
    const extensions = existsSync(manifest) ? json(manifest).extensions : [];
    report.extensionsAfter = extensions;
    check('every prior extension remains recorded', report.extensionsBefore.every(before => extensions.some(after => after.pkg === before.pkg)), extensions.map(entry => entry.pkg));
    check('every recorded extension is at target', extensions.every(entry => entry.version === report.target), extensions.map(({ pkg, version }) => ({ pkg, version })));
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
    report.result = 'failed'; report.refusal = error.message;
  } finally {
    if (releaseHolder) releaseHolder();
    if (holderPromise) {
      const holderResult = await holderPromise;
      check('concurrent writer completed', holderResult.exit === 0, holderResult);
      if (holderResult.exit !== 0) report.result = 'failed';
    }
    if (stackStarted && !uncertain) {
      try { ok(await cotal('stop owned local stack', ['down', '--space', 'upgrade-proof']), 'local stack cleanup'); }
      catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
    }
    if (installedService) {
      report.cleanup = 'retained for disposable runner teardown';
      if (!uncertain && receipt && existsSync(join(plan.daemonHome, 'service-unit.json'))) {
        try {
          const current = json(join(plan.daemonHome, 'service-unit.json'));
          assert.equal(current.unit, receipt.unit);
          assert.equal(current.unitPath, receipt.unitPath);
          assert.equal(digest(readFileSync(current.unitPath)), current.unitSha256);
          ok(await cotal('native uninstall', ['daemon', 'uninstall', '--yes', '--json']), 'native removal');
          assert(!existsSync(join(plan.daemonHome, 'service-unit.json')) && !existsSync(plan.unitPath));
          report.cleanup = 'receipt-guarded native removal confirmed';
        } catch (error) { report.cleanupFailure = error.message; report.result = 'failed'; }
      }
    }
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await matrixCell(args());
  process.exitCode = ['passed', 'excluded'].includes(result.result) ? 0 : 1;
}
