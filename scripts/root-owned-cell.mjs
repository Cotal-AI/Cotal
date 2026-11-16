import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Regrade recorded normal/root outcomes after the caller verifies report and manifest digests. */
export function rootOwnedAssertions(report, cell) {
  const calls=report.calls??[], observations=report.observations??[];
  const clean=row=>Number.isInteger(row?.exit)&&row.signal===null&&row.timeout===false;
  const version=expected=>calls.some(row=>row.label===`normal account version ${expected}`&&row.root===false&&clean(row)&&row.exit===0&&row.stdout.split(/\r?\n/,1)[0]===`cotal-ai ${expected}`);
  const update=calls.find(row=>row.label==='root candidate public updater to next');
  const refusal=calls.find(row=>row.label==='normal account own updater refusal');
  const modes=observations.findLast(row=>row.modes)?.modes;
  const store=observations.find(row=>row.store)?.store;
  const refusedStore=observations.find(row=>row.afterNormalRefusal)?.afterNormalRefusal;
  const mode=(suffix,value)=>modes?.entries?.some(row=>row.path.endsWith(suffix)&&row.mode===value&&row.uid===0);
  const records=modes?.entries?.filter(row=>row.path.endsWith('/inventory.json')||/\/\.active-[a-f0-9]{64}\.json$/.test(row.path))??[];
  const assertions={
    'root-update-success':update?.root===true&&clean(update)&&update.exit===0,
    'normal-account-versions':version(cell.sourceVersion)&&version(cell.targetVersion),
    'owning-command-refusal':refusal?.root===false&&clean(refusal)&&refusal.exit!==0&&/owning command: npm install -g --prefix \/usr\/local cotal-ai@latest/.test(refusal.stdout+refusal.stderr),
    'root-owned-install':observations.some(row=>row.ownership?.uid===0&&row.ownership.path.startsWith('/usr/local/'))&&observations.some(row=>row.installed?.uid===0&&row.installed.version===cell.sourceVersion),
    'readable-generation-metadata':modes?.passed===true&&mode('/.cotal-generations',0o755)&&mode('/dist/cotal.js',0o755)&&records.length>=2&&records.every(row=>row.uid===0&&row.mode===0o644),
    'private-journals':modes?.passed===true&&modes.entries.filter(row=>row.path.includes('/.transaction-')).every(row=>row.mode===(row.kind==='directory'?0o700:0o600)),
    'generation-store-protected':store?.passed===true,
    'refusal-store-unchanged':store?.passed===true&&refusedStore?.passed===true&&Number.isSafeInteger(store.logicalBytes)&&refusedStore.logicalBytes===store.logicalBytes,
    'owned-runner-teardown':report.cleanup?.owner==='disposable hosted runner teardown'&&report.cleanup.commandOutcomesKnown===true,
  };
  if(cell.oldVersion){
    const locked=calls.find(row=>row.label===`normal account after ${cell.oldVersion} attempt`);
    const installed=calls.find(row=>row.label===`root npm install ${cell.sourceVersion}`&&Date.parse(row.startedAt)>=Date.parse(locked?.finishedAt));
    assertions['published-root-lockout']=locked?.root===false&&locked.timeout===false&&locked.signal===null&&(locked.exit===126||/EACCES|Permission denied/.test(locked.stdout+locked.stderr));
    assertions['manual-root-install-heals']=installed?.root===true&&clean(installed)&&installed.exit===0&&version(cell.sourceVersion);
  }
  return {assertions,passed:report.passed===true&&!report.error&&cell.requiredAssertions.every(name=>assertions[name]===true)};
}

/** Hosted-only proof. Call with an already running paired registry and its immutable identity. */
export async function rootOwnedCell({ registry, identity, output, oldVersion }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.platform, 'linux');
  assert(process.getuid() !== 0, 'proof driver must remain the normal runner account');
  const node = '/usr/local/bin/node', npm = '/usr/local/bin/npm', prefix = '/usr/local';
  const pkg = join(prefix, 'lib/node_modules/cotal-ai'), cli = join(prefix, 'bin/cotal');
  const rootHome = join(process.env.RUNNER_TEMP, 'root-install-home');
  const userHome = join(process.env.RUNNER_TEMP, 'normal-install-home');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  assert(/^[a-f0-9]{40}$/.test(identity.source), 'immutable root proof source required');
  if (oldVersion !== undefined) assert(['0.164.16', '0.164.17'].includes(oldVersion), 'unsupported old root source');
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(registry.url), 'owned paired loopback registry required');
  const report = { cleanup: { owner: 'disposable hosted runner teardown', retained: ['/usr/local/lib/node_modules/cotal-ai', '/usr/local/lib/.cotal-generations', rootHome, userHome], noServiceRequested: true, commandOutcomesKnown: false }, source: identity.source, sourceManifestSha256: identity.sourceManifestSha256, targetManifestSha256: identity.targetManifestSha256, followOnManifestSha256: identity.followOnManifestSha256, calls: [], observations: [], assertions: [] };
  const check = (name, passed, observed) => report.assertions.push({ name, passed, observed });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('COTAL_')) delete env[key];
  const assignments = home => [
    `HOME=${home}`, `COTAL_HOME=${home}/.cotal`, `XDG_CONFIG_HOME=${home}/config`, `TMPDIR=${home}/tmp`,
    'PATH=/usr/local/bin:/usr/bin:/bin', 'DO_NOT_TRACK=1', 'COTAL_TELEMETRY=off', 'COTAL_SKIP_CONNECTOR_SEED=1',
    `npm_config_registry=${registry.url}`, `npm_config_cache=${home}/cache`,
  ];
  async function call(label, root, argv, timeoutMs = 180000) {
    const startedAt = new Date().toISOString();
    const home = root ? rootHome : userHome;
    const file = root ? 'sudo' : '/usr/bin/env';
    const args = root ? ['-n', '/usr/bin/env', '-i', ...assignments(home), ...argv] : ['-i', ...assignments(home), ...argv];
    const result = await new Promise(resolve => {
      const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', error => { clearTimeout(timer); resolve({ exit: null, signal: null, timeout: false, stdout, stderr: stderr + String(error), error: error.code }); });
      child.once('close', (exit, signal) => { clearTimeout(timer); resolve({ exit, signal, timeout: timedOut, stdout, stderr }); });
    });
    report.calls.push({ label, root, file, args, startedAt, finishedAt: new Date().toISOString(), ...result });
    writeFileSync(join(output, 'root-owned.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert(!result.timeout && !result.signal, `${label}: outcome unknown, retain runner for teardown`);
    return result;
  }
  const ok = (row, label) => { assert.equal(row.exit, 0, `${label}: ${row.stdout}${row.stderr}`); return row; };
  const install = async version => {
    const result = ok(await call(`root npm install ${version}`, true, [npm, 'install', '-g', '--prefix', prefix, `cotal-ai@${version}`, '--no-audit', '--no-fund', '--loglevel=verbose']), 'root installation');
    const source = "import {lstatSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';const p='/usr/local/lib/node_modules/cotal-ai';const info=lstatSync(p);const read=n=>{const b=readFileSync(p+'/'+n);return {sha256:createHash('sha256').update(b).digest('hex'),mode:lstatSync(p+'/'+n).mode&4095}};console.log(JSON.stringify({uid:info.uid,mode:info.mode&4095,version:JSON.parse(readFileSync(p+'/package.json')).version,manifest:read('package.json'),bootstrap:read('dist/cotal.js')}));";
    const observation = JSON.parse(ok(await call('record root-installed source bytes and ownership', true, [node, '--input-type=module', '-e', source]), 'installed source identity').stdout);
    assert.equal(observation.uid, 0, 'global package must be root owned');
    assert.equal(observation.version, version);
    if (version === identity.sourceVersion) {
      const packed = identity.sourcePackages.find(row => row.name === 'cotal-ai');
      assert(packed?.files, 'packed source identity missing');
      assert.equal(observation.manifest.sha256, packed.files['package.json']);
      assert.equal(observation.bootstrap.sha256, packed.files['dist/cotal.js']);
    }
    report.observations.push({ installed: observation });
    return result;
  };
  const version = async expected => {
    const result = await call(`normal account version ${expected}`, false, [cli, '--version']);
    check(`normal account follows ${expected}`, result.exit === 0 && result.stdout.split(/\r?\n/, 1)[0] === `cotal-ai ${expected}`, result);
    return result;
  };
  async function modes(requireGeneration) {
    const moduleURL = pathToFileURL(join(import.meta.dirname, 'shared-generation-modes.mjs')).href;
    const source = `import {inspectSharedGenerationModes} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(inspectSharedGenerationModes(${JSON.stringify(pkg)},{requireGeneration:${requireGeneration}})));`;
    return JSON.parse(ok(await call('root reads shared-generation modes', true, [node, '--input-type=module', '-e', source]), 'mode census').stdout);
  }
  async function census() {
    const moduleURL = pathToFileURL(join(import.meta.dirname, 'generation-store-census.mjs')).href;
    const source = `import {inspectGenerationStore} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(inspectGenerationStore('/usr/local/lib/.cotal-generations')));`;
    return JSON.parse(ok(await call('root reads full generation census', true, [node, '--input-type=module', '-e', source]), 'store census').stdout);
  }
  try {
    for (const home of [rootHome, userHome]) ok(await call('prepare isolated account home', home === rootHome, ['/bin/mkdir', '-m', '700', '-p', home, join(home, '.cotal'), join(home, 'config'), join(home, 'tmp')]), 'account home');
    const ownership = ok(await call('verify actual root-owned Node in /usr/local', true, [node, '--input-type=module', '-e', "import {statSync,realpathSync} from 'node:fs';const p=realpathSync(process.execPath);const s=statSync(p);if(!p.startsWith('/usr/local/')||s.uid!==0)throw Error('root-owned /usr/local Node required');console.log(JSON.stringify({path:p,uid:s.uid,version:process.versions.node}));"]), 'Node ownership');
    assert.equal(JSON.parse(ownership.stdout).version,'24.18.0','root proof must use pinned system Node');
    report.observations.push({ ownership: JSON.parse(ownership.stdout) });
    // A refused old updater is sufficient to create the old private-store lockout.
    for (const old of oldVersion === undefined ? [] : [oldVersion]) {
      assert(['0.164.16', '0.164.17'].includes(old), 'old root source must be an affected published release');
      await install(old);
      const before = await version(old);
      assert.equal(before.exit, 0, 'old package must work before its attempt');
      const attempt = await call(`published ${old} root attempt`, true, ['/bin/sh', '-c', 'umask 0002; exec "$@"', 'root-cell', cli, 'update', '--self']);
      report.observations.push({ old, attempt });
      const locked = await call(`normal account after ${old} attempt`, false, [cli, '--version']);
      check(`published ${old} lockout reproduced`, locked.exit === 126 || /EACCES|Permission denied/.test(locked.stdout + locked.stderr), locked);
      await install(identity.sourceVersion);
      await version(identity.sourceVersion);
      // The owner opens an old private store at its next start.
      ok(await call('owner opens old private generation store', true, [cli, '--version']), 'owner start');
      const healedModes = await modes(false);
      report.observations.push({ healedAfter: old, modes: healedModes });
      check(`candidate heals ${old} lockout`, healedModes.passed, healedModes);
    }
    await install(identity.sourceVersion);
    await version(identity.sourceVersion);
    registry.activateTarget();
    const update = await call('root candidate public updater to next', true, [cli, 'update', '--self']);
    check('root candidate update exits zero', update.exit === 0, update);
    await version(identity.targetVersion);
    const publishedModes = await modes(true);
    const store = await census();
    report.observations.push({ modes: publishedModes, store });
    check('shared metadata readable and journals private', publishedModes.passed, publishedModes);
    check('generation store clean and protected', store.passed, store);
    assert(identity.followOnVersion && typeof registry.activateFollowOn === 'function', 'normal-account updater proof requires a visible newer target');
    registry.activateFollowOn();
    const refused = await call('normal account own updater refusal', false, [cli, 'update', '--self']);
    check('normal updater names owning npm command', refused.exit !== 0 && /owning command: npm install -g --prefix \/usr\/local cotal-ai@latest/.test(refused.stdout + refused.stderr), refused);
    const afterNormalRefusal=await census();
    report.observations.push({afterNormalRefusal});
    check('fixed refusal leaves no staging or generation-store growth',afterNormalRefusal.passed&&afterNormalRefusal.logicalBytes===store.logicalBytes,{before:store,after:afterNormalRefusal});
    report.passed = report.assertions.every(row => row.passed);
  } catch (error) { report.passed = false; report.error = error.message; }
    report.cleanup.commandOutcomesKnown = report.calls.every(row => row.timeout === false && row.signal === null && (Number.isInteger(row.exit) || row.error === 'EACCES'));
  report.passed = report.passed === true && report.cleanup.commandOutcomesKnown;
  const bytes = JSON.stringify(report, null, 2);
  writeFileSync(join(output, 'root-owned.json'), bytes, { mode: 0o600 });
  writeFileSync(join(output, 'root-owned.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  root-owned.json\n`, { mode: 0o600 });
  return report;
}
