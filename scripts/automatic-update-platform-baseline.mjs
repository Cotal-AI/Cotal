/** Published baseline only. Explicit-home native lifecycle and native-OS policy evidence are separate.
 * This does not prove default-home scheduler eligibility or any automatic version transition.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert(process.env.COTAL_TEST_REAL_SERVICE === '1' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_TEMP
  && ['darwin', 'win32'].includes(process.platform), 'requires opted-in disposable native GitHub runner');
assert.deepEqual(Object.keys(process.env).filter(key => key.startsWith('COTAL_') && !['COTAL_TEST_REAL_SERVICE', 'COTAL_TEST_NATIVE_ACCOUNT_HOME'].includes(key)), [],
  'baseline requires unset inherited COTAL configuration');
const evidence = join(process.env.RUNNER_TEMP, 'automatic-update-baseline-evidence');
mkdirSync(evidence, { mode: 0o700 });
const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, 'cotal-baseline-')));
const prefix = join(root, 'prefix'), home = join(root, 'private-home'), daemonHome = join(root, 'daemon');
// The native fixture root is hardened with the published helper after npm installation.
for (const dir of [prefix, home]) mkdirSync(dir, { mode: 0o700 });
for (const dir of ['config', 'cache', 'data', 'state', 'runtime', 'tmp']) mkdirSync(join(home, dir), { mode: 0o700 });
const report = { platform: process.platform, version: '0.164.0', calls: [],
  scope: 'explicit daemon-home native baseline plus separate eligible:true native-OS policy probe; no transition',
  serviceEnvironment: 'native account environment, not private CLI HOME', cleanup: 'not-needed' };
let cli, plan, attempted = false, uncertain = false, cleanupAttempted = false;
function save(name, value) { writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function native(file, args, env = process.env) {
  const r = spawnSync(file, args, { env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (r.error || r.signal || r.status === null) { uncertain = true; throw new Error(`${file}: unknown outcome (${r.error?.code ?? r.signal})`); }
  return r;
}
function call(verb, ...flags) {
  const r = native(process.execPath, [cli, 'daemon', verb, '--daemon-home', daemonHome, '--json', ...flags]);
  let body;
  try { body = JSON.parse(r.stdout); } catch { throw new Error(`${verb}: invalid JSON (exit ${r.status})`); }
  report.calls.push({ verb, flags, exit: r.status, body });
  assert.equal(body.schemaVersion, 1);
  return { body, exit: r.status };
}
function ok(verb, ...flags) {
  const r = call(verb, ...flags);
  assert.equal(r.exit, 0, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'ok');
  return r.body.result;
}
async function wait(ready) {
  for (let i = 0; i < 60; i++) {
    const r = call('status');
    if (ready && r.exit === 0 && r.body.result?.state === 'ready' && r.body.result?.update) return r.body.result;
    if (!ready && r.exit === 2 && r.body.error?.cause?.code === 'NOT_RUNNING') return;
    await delay(500);
  }
  throw new Error(`native endpoint did not become ${ready ? 'ready' : 'NOT_RUNNING'}`);
}
try {
  // npm install alone uses private HOME/XDG/cache. The service does not inherit this environment.
  const env = { ...process.env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, '.cotal'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'runtime'), TMPDIR: join(home, 'tmp'), TMP: join(home, 'tmp'), TEMP: join(home, 'tmp'),
    npm_config_cache: join(home, 'npm-cache') };
  let installed;
  if (process.platform === 'win32') {
    // setup-node's Windows distribution keeps npm beside node.exe. Execute its JS entry
    // directly so cmd.exe cannot preserve shell quotes as literal prefix characters.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert(existsSync(npmCli), `setup-node npm CLI missing: ${npmCli}; no shell fallback`);
    installed = native(process.execPath,
      [npmCli, 'install', '-g', '--prefix', prefix, 'cotal-ai@0.164.0', '--no-audit', '--no-fund'], env);
  } else installed = native('npm', ['install', '-g', '--prefix', prefix, 'cotal-ai@0.164.0', '--no-audit', '--no-fund'], env);
  save('installation.json', { exit: installed.status, stdout: installed.stdout, stderr: installed.stderr });
  assert.equal(installed.status, 0, 'published npm installation failed');
  const pkg = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'cotal-ai');
  cli = join(pkg, 'dist', 'cotal.js');
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '0.164.0');
  const scheduler = join(pkg, 'dist', 'daemon', 'auto-update.js');
  const bytes = readFileSync(scheduler);
  report.schedulerSha256 = createHash('sha256').update(bytes).digest('hex');
  // Run the unchanged published module in a child so private policy paths cannot leak into service calls.
  const probe = `import assert from 'node:assert/strict';
const {automaticUpdates}=await import(${JSON.stringify(pathToFileURL(scheduler).href)});
const u=automaticUpdates({version:'0.164.0',eligible:()=>true,prepare:async()=>{},abort:async()=>{},report:()=>{}});
try { const s=u.status(); console.log(JSON.stringify({platform:process.platform,eligible:true,status:s})); assert.equal(s.automatic,false); assert.match(s.lastResult,/Automatic installation is available on Linux in this release/); } finally { await u.close(); }`;
  const policy = native(process.execPath, ['--input-type=module', '-e', probe], env);
  save('policy-probe.json', { exit: policy.status, stdout: policy.stdout, stderr: policy.stderr });
  assert.equal(policy.status, 0, 'unchanged native-OS eligible:true policy probe failed');
  assert.equal(process.env.COTAL_TEST_NATIVE_ACCOUNT_HOME, '1',
    'BLOCKED: native service uses disposable runner account HOME; explicit coordinator approval required');
  // Match daemon-install-real.smoke.mjs: harden the owned root before creating its
  // daemon child, so Windows CREATOR OWNER grants are not inherited by that child.
  // Resolve the helper from this published CLI's ESM dependency graph, not checkout deps.
  const fixture = `const url=import.meta.resolve('@cotal-ai/core', ${JSON.stringify(pathToFileURL(cli).href)});
const {mkSecretDir}=await import(url);
mkSecretDir(${JSON.stringify(root)}); mkSecretDir(${JSON.stringify(daemonHome)});`;
  const prepared = native(process.execPath,
    ['--experimental-import-meta-resolve', '--input-type=module', '-e', fixture]);
  save('fixture-preparation.json', { exit: prepared.status, stdout: prepared.stdout, stderr: prepared.stderr });
  assert.equal(prepared.status, 0, 'published private-directory helper must prepare native fixture');
  if (process.platform === 'darwin') {
    const domain = native('/bin/launchctl', ['print', `gui/${process.getuid()}`]);
    save('gui-domain.json', { exit: domain.status });
    assert.equal(domain.status, 0, 'BLOCKED: native GUI domain unavailable; no alternate domain permitted');
  }
  plan = ok('install', '--dry-run');
  assert.equal(plan.state, 'would-install');
  assert.equal(plan.daemonHome, daemonHome);
  assert.match(plan.unit, process.platform === 'darwin' ? /^ai\.cotal\.daemon\.[a-f0-9]{16}$/ : /^cotal-daemon-[a-f0-9]{16}-S-1-/);
  attempted = true;
  ok('install');
  const receipt = JSON.parse(readFileSync(join(daemonHome, 'service-unit.json'), 'utf8'));
  assert.equal(receipt.unit, plan.unit);
  assert.equal(createHash('sha256').update(readFileSync(plan.unitPath)).digest('hex'), plan.sha256);
  assert.equal(receipt.unitSha256, plan.sha256);
  assert.equal(receipt.unitPath, plan.unitPath);
  assert.equal(receipt.daemonHome, daemonHome);
  save('receipt.json', receipt);
  const status = await wait(true);
  save('native-status.json', status);
  assert.equal(status.version, '0.164.0');
  assert(Number.isInteger(status.pid) && status.pid > 0);
  assert.equal(status.update.automatic, false);
  assert.match(status.update.lastResult, /Automatic installation is available on Linux in this release/);
  const started = ok('start');
  report.start = started;
  const second = await wait(true);
  assert.equal(second.pid, status.pid);
  assert.equal(second.startedAt, status.startedAt);
  report.baseline = 'observed-platform-disabled';
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (attempted) {
    report.cleanup = 'retained-for-runner-disposal';
    if (!uncertain && existsSync(join(daemonHome, 'service-unit.json'))) {
      try {
        cleanupAttempted = true;
        assert.equal(ok('uninstall', '--yes').state, 'removed');
        assert(!existsSync(join(daemonHome, 'service-unit.json')));
        assert(!existsSync(plan.unitPath));
        const absent = ok('install', '--dry-run');
        assert.equal(absent.state, 'would-install');
        assert.equal(absent.unit, plan.unit);
        await wait(false);
        report.cleanup = 'verified-removed';
      } catch (error) { report.cleanupFailure = error.message; process.exitCode = 1; }
    } else { report.cleanupFailure = 'unknown native outcome or missing receipt; no blind retry'; process.exitCode = 1; }
  }
  report.cleanupAttempted = cleanupAttempted;
  report.retainedRoot = root;
  report.retentionOwner = 'disposable GitHub runner teardown; no recursive deletion by harness';
  report.outcome = process.exitCode ? 'failed' : 'passed';
  save('result.json', report);
  console.log(JSON.stringify(report));
}
