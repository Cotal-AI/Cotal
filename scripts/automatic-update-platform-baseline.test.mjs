import assert from 'node:assert/strict';
import { candidateRegistry, bootstrapVersion, selectedTargets, cliReportsVersion, verifyCandidateInstaller, completionAdvisory, nativeGenerationReady } from './automatic-update-platform-baseline.mjs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as baseline from './automatic-update-platform-baseline.mjs';
import { ServerResponse } from 'node:http';

test('historical source bootstrap cutoff is isolated from the upgrade environment', () => {
  const env = { PATH: '/node', npm_config_before: 'old', NPM_CONFIG_BEFORE: 'other' };
  for (const source of ['0.155.0', '0.162.0', '0.164.10', '0.164.18']) {
    assert.deepEqual(baseline.historicalBootstrapEnvironment(env, source), { PATH: '/node', npm_config_before: '2026-11-16T19:38:00.000Z' });
  }
  for (const source of ['0.165.0', '0.165.1', '0.165.1001']) {
    assert.deepEqual(baseline.historicalBootstrapEnvironment(env, source), { PATH: '/node' });
  }
  assert.deepEqual(env, { PATH: '/node', npm_config_before: 'old', NPM_CONFIG_BEFORE: 'other' });
  const driver = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(driver.indexOf('bootstrapEnvironment = undefined;') < driver.indexOf('if (options.prepare !== undefined)'));
  assert(driver.includes('npmBefore: (bootstrapEnvironment ?? env).npm_config_before ?? null'));
});

test('extension observations ask the driven CLI each time and read that root on disk', async () => {
  const config = mkdtempSync(join(tmpdir(), 'extension-root-'));
  const roots = ['old', 'selected', 'manual'].map(name => join(config, name));
  const entries = roots.map((root, index) => {
    mkdirSync(root);
    const entry = { pkg: '@cotal-ai/tmux', version: `0.166.${index}` };
    writeFileSync(join(root, 'extensions.json'), JSON.stringify({ extensions: [entry] }));
    return entry;
  });
  let calls = 0;
  const run = async argv => {
    assert.deepEqual(argv, ['ext', '--json']);
    return { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { kind: 'extensions', root: roots[calls++], items: [{ version: 'untrusted-display' }] } }) };
  };
  for (let i = 0; i < roots.length; i++) {
    const observed = await baseline.observedExtensions({ config, run, platform: 'linux' });
    assert.equal(observed.root, roots[i]);
    assert.deepEqual(observed.extensions, [entries[i]]);
  }
  assert.equal(calls, 3);
});

test('extension root observation refuses missing or malformed public results without a canonical fallback', async () => {
  const config = mkdtempSync(join(tmpdir(), 'extension-invalid-'));
  const valid = { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { kind: 'extensions', root: config } }) };
  for (const change of [{ exit: 1 }, { signal: 'SIGTERM' }, { timeout: true }, { stdout: 'not json' }, { stdout: '{}' }, { stdout: JSON.stringify({ result: { kind: 'extensions', root: 'relative' } }) }]) {
    await assert.rejects(baseline.observedExtensions({ config, platform: 'linux', run: async () => ({ ...valid, ...change }) }));
  }
  for (const route of [{ platform: 'win32' }, { layout: 'checkout' }]) {
    const observed = await baseline.observedExtensions({ config, ...route, run: async () => assert.fail('unsupported routes must remain canonical') });
    assert.equal(observed.root, join(config, 'extensions'));
    assert.deepEqual(observed.extensions, []);
  }
});

test('earlier extension inventory checks the original manifest and recorded package bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'extension-inventory-'));
  const extensions = [{ pkg: '@cotal-ai/tmux', version: '0.166.0' }];
  const pkg = join(root, 'node_modules/@cotal-ai/tmux');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'extensions.json'), JSON.stringify({ extensions }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(extensions[0]));
  const before = baseline.extensionSourceInventory(root, extensions);
  assert.equal(before.length, 2);
  assert(before.every(row => typeof row.sha256 === 'string'));
  assert.deepEqual(baseline.extensionSourceInventory(root, extensions), before);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...extensions[0], version: 'changed' }));
  assert.notDeepEqual(baseline.extensionSourceInventory(root, extensions), before);
  writeFileSync(join(root, 'extensions.json'), '{}');
  assert.notEqual(baseline.extensionSourceInventory(root, extensions)[0].sha256, before[0].sha256);
});

test('driver reobserves roots at update and manual npm boundaries and requires earlier-prefix safety for refusals', () => {
  const driver = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  for (const label of ['extension root before update', 'extension root after update', 'bare manual npm extension root', 'refused manual npm extension root', 'reconciled manual npm extension root', 'scheduled manual npm extension root observation', 'scheduled manual npm final extension root']) {
    assert(driver.includes(`await observeExtensions('${label}')`), label);
  }
  assert(driver.includes("check('earlier extension prefix unchanged'"));
  assert(driver.includes('extensionSourceInventory(extensionsBefore.root, report.extensionsBefore)'));
  assert(!driver.includes("join(config, 'extensions/extensions.json')"));
  assert(!driver.includes("join(config, 'extensions/node_modules'"));
  const refusal = readFileSync(new URL('./upgrade-matrix-refusals.mjs', import.meta.url), 'utf8');
  assert(refusal.includes("'source generation unchanged', 'earlier extension prefix unchanged'"));
});

test('composition lifecycle surrounds the ordinary public update without replacing it', () => {
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  const activate = source.indexOf('overlay.activateTarget();', source.indexOf("if (nextHopMode === 'candidate')"));
  const before = source.indexOf('await compositionCleanup.beforeUpdate()');
  const update = source.indexOf("await cotal('upgrade under test'", before);
  const after = source.indexOf('await compositionCleanup.afterUpdate(update)');
  assert(activate > 0 && activate < before && before < update && update < after);
  assert(source.includes('cotalHome, prefix, call, cotal, daemon, check, report, output, cli, options'));
});

test('owned local fixture keeps its recorded identity and bytes while every other extension reaches target', () => {
  const before = [{pkg: 'cotal-upgrade-native-fixture', spec: '/owned/native-fixture', version: '0.164.11'}, {pkg: '@cotal-ai/tmux', spec: '@cotal-ai/tmux@0.164.11', version: '0.164.11'}];
  const extensions = [before[0], {...before[1], version: '0.164.1011'}];
  const fixture = { ...before[0], path: '/config/node_modules/cotal-upgrade-native-fixture', realpath: '/owned/native-fixture', files: {'package.json': 'package-hash', 'index.js': 'entry-hash', 'seat.mjs': 'seat-hash', 'record-seat.mjs': 'recorder-hash'} };
  const installed = extensions.map(entry => ({pkg: entry.pkg, path: '/config/node_modules/' + entry.pkg, realpath: entry.pkg === fixture.pkg ? fixture.realpath : '/config/node_modules/' + entry.pkg, version: entry.version, files: entry.pkg === fixture.pkg ? {...fixture.files} : {}}));
  const args = {extensions, before, target: '0.164.1011', fixture, installed};
  assert.deepEqual(baseline.extensionVersionChecks(args), {recorded: true, installed: true});
  for (const change of [
    v => { v.extensions[1].version = '0.164.11'; },
    v => { v.installed[1].version = '0.164.11'; },
    v => { v.extensions[0].spec = '/foreign/fixture'; },
    v => { v.extensions[0].version = '0.164.1011'; },
    v => { v.fixture.pkg = '@cotal-ai/tmux'; },
    v => { v.fixture.spec = '/foreign/fixture'; },
    v => { v.installed[0].path = '/foreign/installed'; },
    v => { v.installed[0].realpath = '/foreign/resolved'; },
    v => { v.extensions.shift(); },
    v => { v.installed[0].files['index.js'] = 'changed'; },
    v => { delete v.installed[0].files['package.json']; },
    v => { v.before = []; },
    v => { v.extensions.push({...v.extensions[0]}); },
    v => { v.extensions.push({pkg: 'unknown-local', version: '0.164.11', spec: '/other'}); v.installed.push({pkg: 'unknown-local', version: '0.164.11'}); },
  ]) {
    const changed = structuredClone(args); change(changed);
    const result = baseline.extensionVersionChecks(changed);
    assert.equal(result.recorded && result.installed, false);
  }
  assert.deepEqual(baseline.extensionVersionChecks({...args, fixture: undefined}), {recorded: false, installed: false});
  const selected = structuredClone(args);
  selected.root = '/selected/extensions';
  selected.installed[0].path = join(selected.root, 'node_modules', fixture.pkg);
  assert.deepEqual(baseline.extensionVersionChecks(selected), {recorded: true, installed: true});
  selected.installed[0].files['index.js'] = 'changed';
  assert.deepEqual(baseline.extensionVersionChecks(selected), {recorded: true, installed: false});
  const copied = structuredClone(args);
  copied.fixture.realpath = copied.fixture.path;
  copied.root = '/selected/extensions';
  copied.installed[0].path = copied.installed[0].realpath = join(copied.root, 'node_modules', fixture.pkg);
  assert.deepEqual(baseline.extensionVersionChecks(copied), {recorded: true, installed: true});
  copied.installed[0].realpath = '/foreign/copied-fixture';
  assert.deepEqual(baseline.extensionVersionChecks(copied), {recorded: true, installed: false});
});

test('owned fixture invariant uses real immutable file bytes and the driver records both inventories', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-invariant-')));
  const path = join(root, 'fixture');
  mkdirSync(path);
  const source = {'package.json': JSON.stringify({name: 'cotal-upgrade-native-fixture', version: '0.164.11'}), 'index.js': 'export const fixture = true;', 'seat.mjs': 'setInterval(() => {}, 1000);', 'record-seat.mjs': '// owned recorder'};
  for (const [name, bytes] of Object.entries(source)) writeFileSync(join(path, name), bytes);
  const files = () => Object.fromEntries(Object.keys(source).map(name => [name, createHash('sha256').update(readFileSync(join(path, name))).digest('hex')]));
  const entry = {pkg: 'cotal-upgrade-native-fixture', spec: path, version: '0.164.11'};
  const fixture = {...entry, path, realpath: realpathSync(path), files: files()};
  const installed = () => [{...entry, path, realpath: realpathSync(path), files: files()}];
  const args = {extensions: [entry], before: [entry], target: '0.164.1011', fixture};
  assert.deepEqual(baseline.extensionVersionChecks({...args, installed: installed()}), {recorded: true, installed: true});
  writeFileSync(join(path, 'seat.mjs'), '// altered fixture');
  assert.deepEqual(baseline.extensionVersionChecks({...args, installed: installed()}), {recorded: true, installed: false});
  const driver = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(driver.indexOf('report.ownedLocalFixture =') > driver.indexOf("ok(await cotal('register daemon-hosted stand-in connector'"));
  assert(driver.includes('fixture: report.ownedLocalFixture, installed: installedExtensions, root: extensionsAfter.root'));
  assert(driver.includes("check('every recorded extension is at target', versions.recorded"));
  assert(driver.includes("check('recorded extension package versions match target', versions.installed"));
});

test('hosted Manager observation retries only the explicit rate refusal within its original bound', async () => {
  let now = 0, reads = 0;
  const reply = state => ({exit: 0, signal: null, timeout: false, stdout: JSON.stringify({result: {managers: [{space: 'space', instanceId: 'manager', state, reason: '✗ actor cli of owner u_qdvahusrmtf2a7iyw3oyzwk45q is over its limit of 60 connects a minute - retry in 1s - only actor "cli" is limited, not the account\'s other actors'}]}})});
  const observations = [];
  const result = await baseline.observeHostedManager({space: 'space', timeoutMs: 3000, observations, now: () => now, sleep: async ms => { now += ms; }, read: async () => { reads++; return reply(reads === 1 ? 'starting' : 'answering'); }});
  assert.equal(result.status.exit, 0); assert.equal(reads, 2); assert.equal(now, 1000); assert.equal(observations.length, 2);
  for (const reason of ['not answering', 'actor other is over its limit of 60 connects a minute - retry in 1s', 'actor cli of owner u_owner is over its limit of 60 connects a minute - retry in 0s']) {
    const value = reply('starting'); const body = JSON.parse(value.stdout); body.result.managers[0].reason = reason; value.stdout = JSON.stringify(body);
    const rejected = [];
    await assert.rejects(baseline.observeHostedManager({space: 'space', timeoutMs: 3000, observations: rejected, now: () => 0, sleep: async () => {}, read: async () => value}));
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0].status, value);
  }
  now = 0; reads = 0;
  await assert.rejects(baseline.observeHostedManager({space: 'space', timeoutMs: 1000, observations: [], now: () => now, sleep: async ms => { now += ms; }, read: async () => { reads++; return reply('starting'); }}));
  assert.equal(reads, 1); assert.equal(now, 0);
});

test('candidate-owned next hop admission requires explicit paired hosted manual native source', () => {
  const options = {candidate:'/A', 'candidate-next':'/B', 'next-hop-source':'candidate', 'next-hop-phase':'candidate', source:'0.164.11', layout:'npm',state:'daemon',method:'self'};
  assert.equal(baseline.candidateNextOptions(options,true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, 'stopped-daemon-before-update': 'true'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, 'disabled-daemon-before-update': 'true'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, 'stopped-daemon-before-update': 'true', 'desktop-runtime': '/desktop/runtime'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, 'candidate-follow-on': '/C', 'follow-on-action': 'self'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, 'candidate-follow-on': '/C', 'follow-on-action': 'npm'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({...options, layout: 'installer', 'candidate-follow-on': '/C', 'follow-on-action': 'installer', 'candidate-follow-on-installer': '/C/installer.sh'},true),'candidate');
  assert.equal(baseline.candidateNextOptions({},false),undefined);
  assert.equal(baseline.candidateNextOptions({'stopped-daemon-before-update':'true', 'desktop-runtime':'/desktop/runtime', state:'daemon', method:'self'},true),undefined);
  assert.throws(()=>baseline.candidateNextOptions({'stopped-daemon-before-update':'true'},true));
  assert.throws(()=>baseline.candidateNextOptions({'disabled-daemon-before-update':'true'},true));
  for(const change of [{candidate:undefined},{layout:'installer'},{state:'configured'},{method:'scheduler'},{'next-hop-source':'latest'},{'next-hop-phase':undefined},{'follow-on-action':'self'},{'candidate-follow-on':'/C','follow-on-action':'installer'},{'candidate-follow-on':'/C','follow-on-action':'unknown'},{'stopped-daemon-before-update':'false'},{'disabled-daemon-before-update':'false'},{'stopped-daemon-before-update':'true','disabled-daemon-before-update':'true'},{'desktop-runtime':'/desktop/runtime'},{'stopped-daemon-before-update':'true','candidate-follow-on':'/C','follow-on-action':'self'},{'disabled-daemon-before-update':'true','candidate-follow-on':'/C','follow-on-action':'self'},{'stopped-daemon-before-update':'true',source:'0.164.10','next-hop-source':'0.164.10'}]) assert.throws(()=>baseline.candidateNextOptions({...options,...change},true));
  assert.throws(()=>baseline.candidateNextOptions(options,false));
  assert.equal(baseline.candidateNextOptions({...options,source:'0.164.10',layout:'installer','next-hop-source':'0.164.10'},true),'source-0.164.10');
  assert.throws(()=>baseline.candidateNextOptions({...options,source:'0.164.9','next-hop-source':'0.164.10'},true));
});

function hostedChainOptions() {
  return { candidate: '/A', 'candidate-next': '/B', 'next-hop-source': '0.164.10', 'next-hop-phase': 'candidate', source: '0.164.10', layout: 'npm', state: 'agent', method: 'self', 'daemon-hosted-manager': 'true', 'stop-agents': 'true', prepare() {} };
}

test('source 0.164.10 admits explicitly authorized disposable Linux npm hosted consent chain', { skip: process.platform !== 'linux' }, () => {
  for (const phase of ['candidate', 'published']) {
    assert.equal(baseline.candidateNextOptions({ ...hostedChainOptions(), 'next-hop-phase': phase }, true), 'source-0.164.10');
  }
});

test('hosted consent next hop rejects every missing authorization and unsupported agent layout', () => {
  const options = hostedChainOptions();
  for (const change of [
    { 'next-hop-source': 'candidate' }, { source: '0.164.11' },
    { 'daemon-hosted-manager': undefined }, { 'daemon-hosted-manager': 'false' },
    { 'stop-agents': undefined }, { 'stop-agents': 'false' },
    { prepare: undefined }, { prepare: true }, { layout: 'installer' },
    { method: 'scheduler' }, { candidate: undefined }, { 'next-hop-phase': undefined },
  ]) assert.throws(() => baseline.candidateNextOptions({ ...options, ...change }, true), JSON.stringify(change));
  assert.throws(() => baseline.candidateNextOptions(options, false));
  for (const platform of ['darwin', 'win32']) {
    assert.throws(() => baseline.daemonHostedManagerOptions(options, { hosted: true, platform }));
  }
});

test('next-hop driver captures refused source state before any second hop or cleanup', () => {
  const source=readFileSync(new URL('./automatic-update-platform-baseline.mjs',import.meta.url),'utf8');
  const between=source.indexOf("await captureServiceEvidence('between-hops')");
  const whole=source.indexOf('report.nextHop.intermediate = intermediateWholeMachine',between);
  const refusal=source.indexOf('report.nextHop.firstHop.refusal = matchSource16410Refusal',between);
  const second=source.indexOf("update = await cotal('candidate second hop under test'",between);
  assert(between>0 && between<whole && whole<refusal && refusal<second);
  assert(source.indexOf('assert(report.nextHop.intermediate.passed',between)<second);
  assert(source.indexOf('report.candidateSourceInvocation = candidateSourceIdentity',between)<second);
  assert(source.indexOf('overlay.activateTarget()',between)<second);
  assert(second<source.indexOf("await captureServiceEvidence('after-update')",second));
  assert(!source.slice(between,second).includes("['daemon', 'start'"));
});
test('published paired source refuses public latest supersession before either native action', () => {
  const options={'candidate-next':'/B','next-hop-phase':'published'};
  assert.doesNotThrow(()=>baseline.assertPublishedPairTarget(options,'0.164.11','0.164.11'));
  assert.throws(()=>baseline.assertPublishedPairTarget(options,'0.164.12','0.164.11'),/public target changed/);
  assert.doesNotThrow(()=>baseline.assertPublishedPairTarget({...options,'next-hop-phase':'candidate'},'0.164.10','0.164.11'));
  const source=readFileSync(new URL('./automatic-update-platform-baseline.mjs',import.meta.url),'utf8');
  assert(source.includes('assertPublishedPairTarget(options, report.resolvedBeforeCell'));
  assert(source.includes('assertPublishedPairTarget(options, report.publicPairTargetBeforeAction'));
  assert(source.includes('--registry=https://registry.npmjs.org/'));
});
import { spawnNameError } from '@cotal-ai/core';

test('daemon-hosted fixture name satisfies the actual user-mode actor rule', () => {
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  const name = source.match(/spawn real daemon-hosted agent[^\n]*'--name', '([^']+)'/)?.[1];
  assert(name, 'read the actual hosted spawn name');
  assert.match(spawnNameError('upgrade-proof-worker', { userMode: true }), /invalid owner\/actor token/);
  assert.equal(spawnNameError(name, { userMode: true }), undefined);
  assert(source.includes(`!seats.stdout.includes('${name}')`));
  assert(source.includes("'spawn real stand-in agent', ['spawn', '--agent', 'upgrade-standin', '--name', 'upgrade-proof-worker'"), 'standalone known-refusal transcript stays unchanged');
});

test('daemon hosted consent admission is separate from standalone and refuses unsafe options', async () => {
  const options = { state: 'agent', method: 'self', 'stop-agents': 'true', 'daemon-hosted-manager': 'true', prepare() {} };
  const runner = { hosted: true, platform: 'linux' };
  assert.equal(baseline.daemonHostedManagerOptions(options, runner), true);
  assert.equal(baseline.daemonHostedManagerOptions({ state: 'agent', 'stop-agents': 'true' }, runner), false);
  for (const change of [{ state: 'configured' }, { method: 'scheduler' }, { 'stop-agents': 'false' }, { prepare: undefined }, { 'daemon-hosted-manager': 'false' }]) {
    assert.throws(() => baseline.daemonHostedManagerOptions({ ...options, ...change }, runner));
  }
  for (const environment of [{ hosted: false, platform: 'linux' }, { hosted: true, platform: 'darwin' }, { hosted: true, platform: 'win32' }]) {
    assert.throws(() => baseline.daemonHostedManagerOptions(options, environment));
  }
  await assert.rejects(baseline.matrixCell(options), /requires hosted Linux/);
});

test('documented hosted Manager command and container cleanup are extracted without execution', () => {
  assert.deepEqual(baseline.hostedManagerCommand('upgrade-proof'), ['daemon', 'setup', '--space', 'upgrade-proof', '--json']);
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(source.includes("hostedManagerCommand(space)"));
  assert(source.includes("['spawn', '--agent', 'upgrade-standin', '--on', setup.manager.instanceId"));
  assert(source.indexOf("'register daemon-hosted stand-in connector'") < source.indexOf("'start documented daemon-hosted Manager'"));
  assert(source.includes("['daemon', 'status', '--space', report.managerHost.space, '--json']"));
  assert(source.includes("['ps', '--on', current.instanceId, '--space', report.managerHost.space, '--json']"));
  assert(source.includes("const home = hosted && (state === 'daemon' || daemonHostedManager) ? homedir()"));
  assert(source.includes("if (!(hosted && (state === 'daemon' || daemonHostedManager))) Object.assign"));
  assert(source.includes("if (daemonHostedManager || options['dead-updater'] === 'true' || options['other-home-auth'] === 'true') Object.assign(env, { COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config') })"));
  assert(source.includes('const deadline = Date.now() + 60000;'));
  assert(source.includes('JSON.stringify(observed)'));
  assert(source.includes("['daemon', 'service-disconnect', '--space', report.managerHost.space, '--json']"));
  assert.match(baseline.foreignStackCleanupCommand, /cotal down --with-agents --yes$/);
  assert(source.includes('const stackEnded = foreignStackEnded('));
  assert(source.includes("const endObservation = ok(await call('observe container immediately after stock down'"));
  assert(source.includes("observedAt: report.calls.findLast(entry => entry.label === 'observe container immediately after stock down').startedAt"));
  assert(source.includes("observedUntil: report.calls.findLast(entry => entry.label === 'observe container immediately after stock down').finishedAt"));
  assert(source.includes("assert(stackEnded, 'owned stock stack end was not confirmed')"));
  assert(source.indexOf("'observe container immediately after stock down'") < source.indexOf("'stop owned foreign supervisor and broker'"));
  for (const name of ['owned local stack cleanup succeeds', 'foreign container cleanup succeeds', 'source generation unchanged']) assert(source.includes(name));
  assert(source.includes("report.agentHost = state === 'agent' ? daemonHostedManager ? 'daemon' : 'standalone'"));
  assert(source.includes('if (!report.cleanupSafety.passed)'));
  assert.equal(baseline.cellExitCode({ result: 'passed', cleanupSafety: { passed: false } }), 1);
  assert.equal(baseline.cellExitCode({ result: 'failed', expectedRefusal: { passed: true }, cleanupSafety: { passed: false } }), 1);
});

test('Mac transition accepts stable newer sources only below explicit target and retains Windows history', () => {
  for (const source of ['0.164.6', '0.164.7', '0.165.0']) assert(baseline.macTransitionSource(source, '0.166.0', 'transition'));
  for (const source of ['0.164.5', '0.166.0', '0.167.0', 'latest', '0.165.0-rc.1']) assert(!baseline.macTransitionSource(source, '0.166.0', 'transition'));
  for (const kind of ['off-before-tick', 'killed-before-result']) assert(!baseline.macTransitionSource('0.164.7', '0.166.0', kind));
  assert(!baseline.macTransitionSource('0.164.7', undefined, 'transition'));
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(windowsPolicy\) assert\(hosted && process.platform === 'win32' && !options.candidate && source === '0.164.6'/);
});

// Retained run 43566289714, artifact 14102463041: first ready observation,
// before any assertions or scheduler action (10 calls, uptime 63 ms).
const macStartupObservation = {
  state: 'ready', version: '0.164.7', uptimeMs: 63,
  update: { channel: 'npm', current: '0.164.7', automatic: false, lastResult: 'not checked' },
};

test('scheduler eligibility waits on both native platforms without changing policy controls', () => {
  const normal = { method: 'scheduler', platform: 'darwin', launchdProof: 'transition' };
  for (const platform of ['linux', 'darwin']) assert(baseline.needsSchedulerEligibility({ ...normal, platform }));
  for (const change of [{ platform: 'win32' }, { method: 'self' }, { method: 'installer' }, { launchdProof: 'off-before-tick' }, { windowsPolicy: true }, { policy: 'unsupported-scheduler' }]) {
    assert(!baseline.needsSchedulerEligibility({ ...normal, ...change }));
  }
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(source.includes("needsSchedulerEligibility({ method, platform: process.platform, launchdProof, windowsPolicy, policy })"));
  assert(source.includes("waitForSchedulerEligibility(report, remaining => cotal('wait for verified native scheduler custody', ['daemon', 'status', '--json'], remaining))"));
});

test('actual early Mac observation remains in timed-out report, never treated as eligibility', async () => {
  const report = { source: '0.164.7', daemonBefore: structuredClone(macStartupObservation) };
  let clock = 1000, calls = 0;
  await assert.rejects(baseline.waitForSchedulerEligibility(report, async remaining => {
    calls++;
    assert(remaining > 0 && remaining <= 90);
    return { exit: 0, stdout: JSON.stringify({ result: macStartupObservation }) };
  }, { now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 100, intervalMs: 10 }), /native scheduler eligibility timed out/);
  assert.equal(calls, 9);
  assert.equal(report.schedulerEligibility.deadline, 1100);
  assert.equal(report.schedulerEligibility.source, '0.164.7');
  assert.equal(report.schedulerEligibility.observations.length, 10);
  for (const [i, observation] of report.schedulerEligibility.observations.entries()) {
    assert.equal(observation.attempt, i + 1);
    assert.deepEqual(observation.status, macStartupObservation);
  }
});

test('eligibility helper requires observed ready source and automatic true, not just a ready socket', async () => {
  const report = { source: '0.164.7', daemonBefore: structuredClone(macStartupObservation) };
  let clock = 0;
  // Synthetic helper contract only, not native service or upgrade acceptance evidence.
  const statuses = [
    { exit: 1, stdout: '' },
    { exit: 0, stdout: '{}' },
    ...[
      { ...macStartupObservation, state: 'starting', update: { automatic: true } },
      { ...macStartupObservation, version: '0.166.0', update: { automatic: true } },
      { ...macStartupObservation, update: { automatic: true } },
    ].map(result => ({ exit: 0, stdout: JSON.stringify({ result }) })),
  ];
  await baseline.waitForSchedulerEligibility(report, async () => statuses.shift(), {
    now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 100, intervalMs: 10,
  });
  assert.equal(report.schedulerEligibility.observations.length, 6);
  assert.equal(report.daemonBefore.version, report.source);
  assert.equal(report.daemonBefore.update.automatic, true);
});

test('eligibility rejects status arriving after deadline even when it claims automatic true', async () => {
  const report = { source: '0.164.7', daemonBefore: macStartupObservation };
  let clock = 0;
  await assert.rejects(baseline.waitForSchedulerEligibility(report, async () => {
    clock = 101;
    return { exit: 0, stdout: JSON.stringify({ result: { ...macStartupObservation, update: { automatic: true } } }) };
  }, { now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 100, intervalMs: 10 }), /timed out/);
  assert.equal(report.schedulerEligibility.observations.at(-1).observedAt, 101);
});

function productCheckout() {
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'source-root-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(root, '.gitignore'), 'dist/\nnative-build/\n');
  writeFileSync(join(root, 'package.json'), '{"name":"product","version":"1.0.0"}\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return { root, git };
}

test('source-root defaults to the matrix tree only when omitted', () => {
  assert.equal(baseline.resolveCandidateSourceRoot(), new URL('../', import.meta.url).pathname.replace(/\/$/, ''));
  assert.throws(() => baseline.resolveCandidateSourceRoot(''), /explicit source root/);
});

test('source-root accepts a clean actual Git root and ignored build outputs without switching branches', () => {
  const { root, git } = productCheckout();
  const branch = git('symbolic-ref', 'HEAD');
  for (const name of ['dist', 'native-build']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'generated'), 'generated');
  }
  assert.equal(baseline.resolveCandidateSourceRoot(root), root);
  assert.equal(git('symbolic-ref', 'HEAD'), branch);
  assert.equal(git('status', '--porcelain'), '');
  assert.throws(() => baseline.resolveCandidateSourceRoot(join(root, 'dist')), /actual Git root/);
});

test('source-root refuses tracked staged or unstaged changes before version rewriting', () => {
  for (const staged of [false, true]) {
    const { root, git } = productCheckout();
    writeFileSync(join(root, 'package.json'), '{"version":"dirty"}\n');
    if (staged) git('add', 'package.json');
    assert.throws(() => baseline.resolveCandidateSourceRoot(root), /tracked tree must be clean/);
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"version":"dirty"}\n');
  }
});

test('source-root CLI rejects a dirty product before invoking pack or rewriting manifests', () => {
  const { root } = productCheckout();
  const original = '{"version":"dirty"}\n';
  writeFileSync(join(root, 'package.json'), original);
  assert.throws(() => execFileSync(process.execPath, [
    new URL('./automatic-update-platform-baseline.mjs', import.meta.url).pathname,
    '--pack', join(root, 'candidate'), '--version', '1.0.1', '--source-root', root,
  ], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /tracked tree must be clean/);
    return true;
  });
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), original);
});

test('source-root refuses non-repositories and untracked product inputs', () => {
  const { root } = productCheckout();
  writeFileSync(join(root, 'untracked.mjs'), 'export {};');
  assert.throws(() => baseline.resolveCandidateSourceRoot(root), /tree must be clean/);
  const outside = mkdtempSync(join(tmpdir(), 'not-git-'));
  assert.throws(() => baseline.resolveCandidateSourceRoot(outside));
});
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { parse as parseYaml } from 'yaml';

test('old ready daemon verifying installed generation is not target readiness', () => {
  assert(!nativeGenerationReady({ state: 'ready', version: '0.160.7', generation: { installed: '0.164.2', running: '0.160.7', waiting: 'verifying the installed entry' } }, '0.164.2'));
  assert(!nativeGenerationReady(undefined, '0.164.2'));
  assert(nativeGenerationReady({ state: 'ready', version: '0.164.2' }, '0.164.2'));
});

test('only optional shell completion section becomes exact advisory', () => {
  const text = 'Owned shell completion\n  Changed files: 0\n  Preserved integrations: 1\n  powershell: the shell did not return a usable current-user profile\n  Startup files were not rewritten. Run `cotal completion` to inspect local integration.\nRun `cotal update --self` to repair installation.';
  const split = completionAdvisory(text);
  assert(split.advisory.includes('powershell: the shell did not return a usable current-user profile'));
  assert(!split.required.includes('cotal completion'));
  assert(requiresManualStep(split.required));
  assert(!requiresManualStep(completionAdvisory(text.split('\nRun `cotal update')[0]).required));
});

test('candidate installer binds exact bytes and source to packed closure', () => {
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'installer-proof-'));
  const script = join(root, 'installer.sh'), source = 'a'.repeat(40), bytes = '#!/bin/sh\nexit 0\n';
  writeFileSync(script, bytes);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source }));
  writeFileSync(join(root, 'installer.json'), JSON.stringify({ source, sha256: createHash('sha256').update(bytes).digest('hex') }));
  assert.equal(verifyCandidateInstaller(root, script).source, source);
  writeFileSync(script, '#!/bin/sh\nexit 1\n');
  assert.throws(() => verifyCandidateInstaller(root, script), /differs from packed source receipt/);
});

test('configured version inventory preserves the selected CLI header', () => {
  assert(cliReportsVersion('cotal-ai 0.164.1\n  tmux 0.164.1\n', '0.164.1'));
  assert(!cliReportsVersion('cotal-ai 0.162.0\n  tmux 0.164.1\n', '0.164.1'));
});

test('selected target ignores prior and restored versions in real propagation failure text', () => {
  assert.deepEqual(selectedTargets("cotal-ai@0.163.5 installed\ninstalling cotal-ai@0.164.1 into npm's global installation\nRestoring verified cotal-ai@0.163.5 through the global updater."), ['0.164.1']);
  assert.deepEqual(selectedTargets('updated to 0.164.1'), ['0.164.1']);
  assert.deepEqual(selectedTargets('No newer CLI version; installed package closure is current.'), []);
});

test('bootstrap versions bracket stable published releases', () => {
  assert.equal(bootstrapVersion('0.164.1', 'B'), '0.164.2');
  assert.equal(bootstrapVersion('0.164.1', 'A'), '0.164.0');
  assert.equal(bootstrapVersion('0.164.0', 'A'), '0.163.0');
  assert.equal(bootstrapVersion('1.0.0', 'A'), '0.0.0');
  assert.throws(() => bootstrapVersion('0.0.0', 'A'));
  assert.throws(() => bootstrapVersion('0.164.2-beta.1', 'B'));
});

test('workflow bounds diagnostics and preserves every immutable release head without cancellation', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.concurrency, undefined);
  assert(workflow.on.pull_request.types.includes('synchronize'));
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Changesets']);
  assert(workflow.jobs.priority);
  for (const name of ['candidate-pack', 'candidate-B', 'candidate-A', 'candidate-B-expanded']) {
    assert(workflow.jobs[name].if.includes('always()'), `${name} can be suppressed by expected-red priority ancestors`);
    assert(workflow.jobs[name].if.includes("== 'success'"), `${name} must verify its direct predecessor succeeded`);
  }
  assert(workflow.jobs.priority.steps.some(step => step.run?.includes('--stale-version 0.161.1 --method self')));
  const desktop = workflow.jobs['desktop-beside-cli'];
  assert(desktop.steps.some(step => step.with?.['run-id'] === 43456519342 && step.with?.name === 'desktop-release-Linux-X64'));
  assert(desktop.steps.some(step => step.run?.includes('--desktop-runtime') && step.run.includes('--desktop-node')));
  assert.deepEqual(workflow.jobs['candidate-B'].strategy.matrix.source, ['0.164.0']);
  assert.deepEqual(workflow.jobs['candidate-B-expanded'].strategy.matrix.source, sources);
  assert.equal(workflow.jobs['scheduler-proof'].strategy, undefined, 'narrow proof is one runner, not a matrix');
  assert(workflow.jobs['scheduler-proof'].steps.some(step => step.run?.includes('--source 0.160.7 --layout installer --state daemon --method scheduler')));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (['select', 'release-native', 'release-pack', 'release-cells', 'release-summary'].includes(name)) continue;
    if (name === 'next-release-macos') { assert(job.if.includes("github.event_name == 'release'")); continue; }
    if (name !== 'scheduler-proof') assert(job.if.includes("!contains(github.event.head_commit.message, '[scheduler-only]')"), `${name} could run during scheduler proof`);
    if (name !== 'installer-proof') assert(job.if.includes("!contains(github.event.head_commit.message, '[installer-only]')"), `${name} could run during installer proof`);
  }
  const installer = workflow.jobs['installer-proof'];
  assert.deepEqual(installer.strategy.matrix.os, ['macos-15-intel', 'macos-15']);
  assert.equal(installer.strategy['max-parallel'], 2);
  assert.equal(installer.steps[0].id, 'admission');
  assert.equal(installer.steps[0].uses, 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
  assert(installer.steps[0].with.script.includes('15 * 60 * 1000'));
  for (const step of installer.steps.slice(1).filter(step => !step.uses?.startsWith('actions/upload-artifact'))) assert.equal(step.if, "steps.admission.outputs.admitted == 'true'");
  assert(installer.steps.some(step => step.run?.includes('b4f30205f54cd468bf1914095b09974a5f17dee6') && step.run.includes('c0098825508fe4138c811f7f9ccf351b871593167578de35afc77d15d4df323c')));
  const actions = installer.steps.find(step => step.run?.includes('--first-install true')).run;
  assert(actions.includes('--source latest --layout installer --state fresh'));
  assert(actions.includes('--source 0.164.0 --layout installer --state configured'));
  assert.equal((actions.match(/--installer-setup true/g) ?? []).length, 2);
  assert(!actions.includes('--expect-recovery-refusal') && !actions.includes('--state stale-extensions'));
  const expanded = workflow.jobs['candidate-B-expanded'];
  assert(expanded.steps.some(step => step.run?.includes('for state in fresh configured stale-extensions recovery concurrent agent')));
  assert.deepEqual(workflow.jobs['candidate-native'].strategy.matrix.source, sources);
  assert.deepEqual(workflow.jobs['candidate-native'].strategy.matrix.method, methods);
  const visiting = new Set(), done = new Set();
  function visit(name) {
    assert(!visiting.has(name), `workflow dependency cycle at ${name}`);
    if (done.has(name)) return;
    const job = workflow.jobs[name];
    assert(job, `unknown dependency ${name}`);
    if (job.strategy) assert(job.strategy['max-parallel'] <= (name === 'release-cells' ? 45 : 6), `${name} exceeds its matrix bound`);
    if (!['priority', 'scheduler-proof', 'installer-proof', 'transition-native', 'mac-controls-proof', 'windows-baseline', 'next-release-macos', 'windows-job-facts', 'select'].includes(name)) assert(job.needs, `${name} bypasses priority ordering`);
    visiting.add(name);
    for (const dependency of [job.needs ?? []].flat()) visit(dependency);
    visiting.delete(name);
    done.add(name);
  }
  for (const name of Object.keys(workflow.jobs)) visit(name);
});


test('candidate overlay serves packed closure, stock metadata and read-only policy', async () => {
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'registry-test-'));
  const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat();
  const packages = [];
  for (const [i, name] of names.entries()) {
    const dir = join(root, String(i));
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package/package.json'), JSON.stringify({ name, version: '0.999.0', type: 'module' }));
    const archive = `${i}.tgz`;
    await create({ cwd: dir, file: join(root, archive), gzip: true }, ['package']);
    packages.push({ name, version: '0.999.0', archive, sha256: createHash('sha256').update(readFileSync(join(root, archive))).digest('hex') });
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source: 'a'.repeat(40), packages }));
  const overlay = await candidateRegistry(root, 'B', 'https://registry.npmjs.org/');
  try {
    const metadata = await (await fetch(`${overlay.url}/cotal-ai`)).json();
    assert.equal(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const target = await (await fetch(`${overlay.url}/cotal-ai/0.999.0`)).json();
    const archive = Buffer.from(await (await fetch(target.dist.tarball)).arrayBuffer());
    assert.equal(createHash('sha256').update(archive).digest('hex'), packages.find(pkg => pkg.name === 'cotal-ai').sha256);
    assert.equal((await fetch(`${overlay.url}/cotal-ai`, { method: 'PUT', body: '{}' })).status, 405);
  } finally { await overlay.close(); }
  const sourceOverlay = await candidateRegistry(root, 'A', 'https://registry.npmjs.org/');
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const original = 'registry=https://registry.npmjs.org/\nfund=false\n';
  writeFileSync(join(home, '.npmrc'), original);
  const restore = baseline.configureCandidateRegistry(home, sourceOverlay.url);
  const npmVersion = () => new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: join(root, 'cache'), npm_config_fetch_retries: '0' };
    delete env.npm_config_registry;
    delete env.NPM_CONFIG_REGISTRY;
    const child = spawn('npm', ['view', 'cotal-ai@latest', 'version', '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject);
    child.once('close', exit => resolve({ exit, stdout, stderr }));
  });
  try {
    const metadata = await (await fetch(`${sourceOverlay.url}/cotal-ai`)).json();
    assert.notEqual(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const installedMetadata = await (await fetch(`${sourceOverlay.url}/cotal-ai/0.999.0`)).json();
    assert(installedMetadata.dist.integrity.startsWith('sha512-'));
    assert.equal((await npmVersion()).exit, 0, 'real npm reaches active first-cell overlay');
  } finally { restore(); await sourceOverlay.close(); }
  assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), original);
  const second = await npmVersion();
  assert.equal(second.exit, 0, `second cell public latest after stopped first overlay: ${second.stderr}`);
  assert.match(JSON.parse(second.stdout), /^\d+\.\d+\.\d+$/);
});

for (const scenario of [
  { label: 'returns 502 when upstream archive body rejects', archive: true, rejects: true },
  { label: 'returns 502 when upstream error metadata body rejects', rejects: true },
  { label: 'returns 502 when upstream fetch rejects', fetchRejects: true },
  { label: 'preserves upstream archive status and bytes', archive: true },
  { label: 'preserves upstream error metadata status and body' },
  { label: 'ends an already-started response without rewriting headers', archive: true, endRejects: true },
]) test(`candidate overlay ${scenario.label}`, async t => {
  const path = scenario.archive ? '/dependency/-/dependency-1.0.0.tgz' : '/dependency';
  const status = scenario.archive ? 200 : 503;
  const method = scenario.archive ? 'arrayBuffer' : 'text';
  const body = scenario.archive ? Buffer.from([0, 1, 255]) : 'upstream unavailable';
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'registry-body-'));
  const packages = [];
  for (const [i, name] of JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat().entries()) {
    const dir = join(root, String(i));
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package/package.json'), JSON.stringify({ name, version: '0.999.0' }));
    const archive = `${i}.tgz`;
    await create({ cwd: dir, file: join(root, archive), gzip: true }, ['package']);
    packages.push({ name, version: '0.999.0', archive, sha256: createHash('sha256').update(readFileSync(join(root, archive))).digest('hex') });
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source: 'a'.repeat(40), packages }));
  const fetchClient = globalThis.fetch;
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://registry.npmjs.org/')) return fetchClient(url, options);
    upstreamCalls++;
    assert(options.signal instanceof AbortSignal, 'upstream deadline remains in force');
    if (scenario.fetchRejects) throw new Error('upstream fetch aborted');
    return { ok: status === 200, status, [method]: async () => {
      if (scenario.rejects) throw new Error('upstream body aborted');
      return body;
    } };
  });
  if (scenario.endRejects) {
    const end = ServerResponse.prototype.end;
    let first = true;
    t.mock.method(ServerResponse.prototype, 'end', function (...args) {
      if (first) {
        first = false;
        assert.equal(this.headersSent, true);
        throw new Error('response end failed');
      }
      return end.apply(this, args);
    });
  }
  const overlay = await candidateRegistry(root, 'B', 'https://registry.npmjs.org/');
  try {
    const response = await fetch(overlay.url + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, scenario.rejects || scenario.fetchRejects ? 502 : status);
    if (scenario.rejects || scenario.fetchRejects || scenario.endRejects) {
      assert.deepEqual(await response.json(), { error: scenario.endRejects ? 'response end failed' : scenario.fetchRejects ? 'upstream fetch aborted' : 'upstream body aborted' });
    } else {
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(body));
    }
    assert.equal(upstreamCalls, 1);
    const local = await fetch(`${overlay.url}/__candidate/${packages[0].archive}`);
    assert.equal(local.status, 200, 'registry keeps serving after upstream failure');
    assert.deepEqual(Buffer.from(await local.arrayBuffer()), readFileSync(join(root, packages[0].archive)));
  } finally { await overlay.close(); }
});

test('candidate registry configuration removes only unchanged owned bytes and preserves prior account settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'npmrc-test-'));
  const file = join(home, '.npmrc');
  const restoreAbsent = baseline.configureCandidateRegistry(home, 'http://127.0.0.1:1');
  restoreAbsent();
  assert(!existsSync(file));
  const original = 'registry=https://registry.npmjs.org/\nfund=false\n';
  writeFileSync(file, original);
  const restore = baseline.configureCandidateRegistry(home, 'http://127.0.0.1:2');
  assert(readFileSync(file, 'utf8').startsWith(original));
  writeFileSync(file, 'foreign change');
  assert.throws(restore, /changed during cell/);
  assert.equal(readFileSync(file, 'utf8'), 'foreign change');
  const other = mkdtempSync(join(tmpdir(), 'npmrc-link-'));
  symlinkSync(file, join(other, '.npmrc'));
  assert.throws(() => baseline.configureCandidateRegistry(other, 'http://127.0.0.1:3'), /regular file/);
});

test('Windows policy registry exposes newer metadata but can never supply an installation', async () => {
  const overlay = await baseline.policyRegistry('0.164.7');
  try {
    const value = await (await fetch(overlay.url + '/cotal-ai')).json();
    assert.equal(value['dist-tags'].latest, '0.164.7');
    assert.equal(value.versions['0.164.7'].dist, undefined);
    assert.equal((await fetch(overlay.url + '/cotal-ai/-/cotal-ai-0.164.7.tgz')).status, 404);
    assert.equal((await fetch(overlay.url + '/cotal-ai', { method: 'PUT' })).status, 405);
  } finally { assert((await overlay.close()).length >= 3); }
});

test('real product cache refresh requires success checkedAt older than one day, not merely two hours', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windows-tick-cache-'));
  const home = join(root, 'home'), cotal = join(home, '.cotal');
  mkdirSync(cotal, { recursive: true, mode: 0o700 });
  const overlay = await baseline.policyRegistry('0.164.7');
  const script = `import {checkForUpdate} from ${JSON.stringify(new URL('../packages/workspace/dist/update-check.js', import.meta.url).href)};console.log(JSON.stringify(await checkForUpdate()));`;
  const run = () => new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: join(home, 'config'), npm_config_registry: overlay.url, npm_config_cache: join(root, 'cache') };
    delete env.COTAL_NO_UPDATE_CHECK;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', exit => { if (exit !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  });
  try {
    const now = Date.now(), initial = { v: 1, latest: '0.164.7', checkedAt: now - 7200000, firstSeenAt: now - 7200000, attemptedAt: now - 7200000 };
    writeFileSync(join(cotal, 'update-check.json'), JSON.stringify(initial));
    assert.deepEqual(await run(), initial, 'two-hour success cache is intentionally reused');
    writeFileSync(join(cotal, 'update-check.json'), JSON.stringify({ ...initial, checkedAt: now - 25 * 3600000 }));
    const refreshed = await run();
    assert.equal(refreshed.latest, '0.164.7'); assert(refreshed.attemptedAt >= now); assert(refreshed.checkedAt >= now);
    assert.equal(refreshed.firstSeenAt, initial.firstSeenAt);
  } finally { await overlay.close(); }
});

test('Windows baseline admission cannot run native code on persistent or non-Windows host', async () => {
  if (process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  await assert.rejects(baseline.matrixCell({ source: '0.164.6', layout: 'npm', state: 'daemon', method: 'scheduler', 'windows-policy-baseline': 'true' }), /requires hosted published/);
});

test('published installer override requires explicit source/hash and cannot enter candidate tiers', async () => {
  const { verifyPublishedInstaller } = await import('./automatic-update-platform-baseline.mjs');
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'published-script-proof-'));
  const script = join(root, 'install.sh'), source = 'b'.repeat(40), bytes = '#!/bin/sh\nexit 0\n';
  writeFileSync(script, bytes);
  const options = { 'published-installer': script, 'installer-source': source, 'installer-sha256': createHash('sha256').update(bytes).digest('hex'), layout: 'installer', method: 'installer' };
  assert.equal(verifyPublishedInstaller(options).source, source);
  assert.throws(() => verifyPublishedInstaller({ ...options, candidate: root }), /published tier/);
  assert.throws(() => verifyPublishedInstaller({ ...options, layout: 'npm' }), /installer rerun/);
  assert.throws(() => verifyPublishedInstaller({ ...options, 'installer-source': undefined }), /source/);
  writeFileSync(script, '#!/bin/sh\nexit 1\n');
  assert.throws(() => verifyPublishedInstaller(options), /hash/);
});

test('expected recovery refusal stays a failed upgrade and requires exact fail-closed boundary', async () => {
  const { expectedRecoveryRefusal } = await import('./automatic-update-platform-baseline.mjs');
  const report = { update: { exit: 1, stdout: 'Cotal was installed, but reconciliation did not complete.\nRun cotal update --self to finish this update.\n', stderr: 'Outcome unconfirmed\nCode: OPERATION_UNKNOWN\n' }, assertions: [
    { name: 'upgrade exits successfully', passed: false }, { name: 'CLI version is target', passed: true },
    { name: 'no paused recovery record', passed: false }, { name: 'no manual step or refusal', passed: false },
  ], result: 'failed' };
  assert(expectedRecoveryRefusal(report));
  assert.equal(report.result, 'failed');
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, exit: 0 } }));
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, stdout: report.update.stdout + 'Cotal 0.164.0 → 0.164.4\n~/.local/bin/cotal · installed in 2s\n' } }));
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, stderr: 'unrelated failure' } }));
  assert(!expectedRecoveryRefusal({ ...report, assertions: [...report.assertions, { name: 'CLI version is target', passed: false }] }));
});

test('explicit refusal control cannot accept an unexpected successful upgrade', async () => {
  const { cellExitCode } = await import('./automatic-update-platform-baseline.mjs');
  assert.equal(cellExitCode({ result: 'passed', expectedRefusal: { passed: false } }), 1);
  assert.equal(cellExitCode({ result: 'failed', expectedRefusal: { passed: true } }), 0);
  assert.equal(cellExitCode({ result: 'failed', expectedRefusal: { passed: false } }), 1);
  assert.equal(cellExitCode({ result: 'passed' }), 0);
  assert.equal(cellExitCode({ result: 'failed' }), 1);
});

test('Mac admission gate records late arm64 unrun before any installation', async () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
  const script = workflow.jobs['installer-proof'].steps[0].with?.script;
  assert(script, 'first step must be admission, before checkout');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const [label, age, admitted] of [['macos-15', 900000, true], ['macos-15', 900001, false], ['macos-15-intel', 1800000, true]]) {
    const outputs = {}, files = {};
    const now = Date.parse('2026-11-13T21:00:00Z');
    const fakeRequire = name => {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:path') return { join };
      assert.equal(name, 'node:fs');
      return { mkdirSync() {}, writeFileSync(path, text) { files[path] = text; } };
    };
    await new AsyncFunction('github', 'context', 'core', 'require', 'process', 'Date', script)(
      { rest: { actions: { getWorkflowRun: async () => ({ data: { created_at: new Date(now - age).toISOString() } }) } } },
      { repo: { owner: 'test', repo: 'test' }, runId: 1, sha: 'a'.repeat(40) },
      { setOutput(key, value) { outputs[key] = value; }, info() {} }, fakeRequire,
      { env: { RUNNER_TEMP: '/fixture', QUALIFICATION_RUNNER: label } }, { now: () => now, parse: Date.parse },
    );
    assert.equal(outputs.admitted, String(admitted));
    const receipt = JSON.parse(Object.values(files)[0]);
    assert.equal(receipt.result, admitted ? 'admitted' : 'unrun');
    assert.equal(receipt.ageMs, age);
  }
  let outputWritten = false;
  await assert.rejects(new AsyncFunction('github', 'context', 'core', 'require', 'process', 'Date', script)(
    { rest: { actions: { getWorkflowRun: async () => ({ data: { created_at: 'invalid' } }) } } },
    { repo: {}, runId: 1 }, { setOutput() { outputWritten = true; } },
    name => {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:path') return { join };
      assert.equal(name, 'node:fs');
      return { mkdirSync() {}, writeFileSync() {} };
    },
    { env: {} }, { now: () => 1, parse: Date.parse },
  ), /run creation time unavailable/);
  assert.equal(outputWritten, false);
});

test('summary skips a JSON file that holds no object', async () => {
  const { summarize } = await import('./automatic-update-platform-baseline.mjs');
  const root = mkdtempSync(join(tmpdir(), 'null-summary-'));
  writeFileSync(join(root, 'cell.json'), JSON.stringify({ id: 'cell', tier: 'published', result: 'passed', target: '0.164.5' }));
  writeFileSync(join(root, 'state.json'), 'null');
  assert.deepEqual(summarize(root).counts, { passed: 1 });
});

test('summary preserves unrun runner receipts separately from product verdicts and does not count matched known refusals as unexpected failures', async () => {
  const { summarize } = await import('./automatic-update-platform-baseline.mjs');
  const { knownRefusals } = await import('./upgrade-matrix-refusals.mjs');
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'admission-summary-'));
  writeFileSync(join(root, 'runner-admission.json'), JSON.stringify({ run: 1, head: 'a'.repeat(40), runner: 'macos-15', ageMs: 900001, result: 'unrun', reason: 'late arm64' }));
  const alone = summarize(root);
  assert.deepEqual(alone.counts, {});
  assert.equal(alone.admissions.length, 1);
  assert.equal(alone.admissions[0].result, 'unrun');
  writeFileSync(join(root, 'cell.json'), JSON.stringify({ id: 'intel-cell', tier: 'published', result: 'passed', target: '0.164.5' }));
  const mixed = summarize(root);
  assert.deepEqual(mixed.counts, { passed: 1 });
  assert.equal(mixed.admissions.length, 1);
  assert(readFileSync(join(root, 'summary.md'), 'utf8').includes('macos-15 | unrun'));

  const knownDir = join(root, 'upgrade-cell-linux-npm-container-manager');
  mkdirSync(knownDir, { mode: 0o700 });
  const entry = knownRefusals.find(e => e.id === 'linux-npm-container-manager');
  const space = 'update-participant-a-1794633286189';
  const owner = 'u_wdhhojionrz2rav4mearesx4ou';
  const stdout = entry.stdout.replaceAll('{{space}}', space);
  const stderr = entry.stderr.replaceAll('{{owner}}', owner);
  const update = { exit: entry.exit, signal: null, timeout: false, stdout, stderr };
  writeFileSync(join(knownDir, 'coordinate.json'), JSON.stringify({ id: entry.id, phase: 'published', sourceVersion: '0.164.6' }));
  writeFileSync(join(knownDir, 'report.json'), JSON.stringify({
    id: 'published-linux-0.164.6-npm-configured-self',
    tier: 'published',
    source: '0.164.6',
    sourceRequested: '0.164.6',
    target: '0.164.7',
    result: 'failed',
    state: 'configured',
    participant: { remote: true, localManagerStarted: false, space, owner },
    cleanupSafety: { passed: true },
    update,
    extensionsBefore: [{ pkg: '@cotal-ai/core', version: '0.164.6' }],
    extensionsAfter: [{ pkg: '@cotal-ai/core', version: '0.164.6' }],
    assertions: [
      ...entry.failedAssertions.map(name => ({ name, passed: false, observed: name === 'upgrade exits successfully' ? update : name === 'CLI version is target' ? '0.164.6' : undefined })),
      ...entry.requiredAssertions.map(name => ({ name, passed: true })),
    ],
  }));
  const withRefusal = summarize(root);
  assert.equal(withRefusal.unexpectedFailures, 0);
  assert.equal(withRefusal.counts.failed, 1);
  assert.equal(withRefusal.cells.find(c => c.knownRefusal)?.knownRefusal.issue, entry.issue);
});

import { test } from 'node:test';
import { exclusion, requiresManualStep, sources, states, methods, coordinates } from './automatic-update-platform-baseline.mjs';

test('funding suggestions do not require upgrade intervention', () => {
  assert.equal(requiresManualStep('61 packages are looking for funding\n  run `npm fund` for details\n✓ cotal-ai@0.164.0 installed globally and reconciled'), false);
});
test('pre-existing installer PATH notice does not require installation repair', () => {
  const notice = 'Your PATH does not select the Cotal just installed.\nUse /private/bin/cotal instead of plain cotal.\nCheck `type -a cotal` in your shell.';
  assert.equal(requiresManualStep(notice), false);
  assert.equal(requiresManualStep(notice + '\nRun `cotal update --self` to repair installation.'), true);
});

test('actual upgrade remedies and unknown outcomes stay red', () => {
  for (const text of ['run `cotal update --self`', 'Outcome unconfirmed', 'Code: OPERATION_UNKNOWN', 'an interrupted update needs restoration', 'manual intervention']) assert.equal(requiresManualStep(text), true, text);
});
test('published policy expectations cannot accept latest no-op repair hints', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const coordinate = { source: '0.164.0', state: 'agent', method: 'self', platform };
    assert(baseline.policyCoordinate('legacy-seat', coordinate));
    assert(!baseline.policyCoordinate('legacy-seat', { ...coordinate, source: 'latest' }));
    assert(!baseline.policyCoordinate('legacy-seat', { ...coordinate, candidate: '/candidate' }));
    assert(!baseline.policyCoordinate('legacy-seat', { ...coordinate, stopAgents: true }));
    assert(!baseline.policyCoordinate('legacy-seat', { ...coordinate, layout: 'installer' }));
    const output = 'No newer CLI version; installed package closure is current. No connector reconciliation was run.\nRun `cotal update` to repair connector integrations.';
    assert(requiresManualStep(output));
    assert(!baseline.policyRefusal('legacy-seat', { exit: 0, stdout: output, stderr: '' }));
  }
});
test('missing config policy matches only the known exact first-hop refusal', () => {
  const config = '/cell/home/config/cotal';
  const update = { exit: 1, stdout: '', stderr: `update snapshot refused: ENOENT: no such file or directory, lstat '${config}'\n` };
  assert(baseline.policyRefusal('missing-config', update, config));
  assert(!baseline.policyRefusal('missing-config', { ...update, exit: 0 }, config));
  assert(!baseline.policyRefusal('missing-config', update, '/other/config/cotal'));
  assert(!baseline.policyRefusal('missing-config', { ...update, stderr: update.stderr + 'another failure' }, config));
});
test('old non-Linux scheduler is unsupported only with exact recorded source policy', () => {
  const coordinate = { source: '0.163.5', state: 'daemon', method: 'scheduler', platform: 'darwin', layout: 'installer' };
  assert(baseline.policyCoordinate('unsupported-scheduler', coordinate));
  assert(!baseline.policyCoordinate('unsupported-scheduler', { ...coordinate, platform: 'linux' }));
  assert(!baseline.policyCoordinate('unsupported-scheduler', { ...coordinate, layout: 'npm' }));
  assert(baseline.policyCoordinate('unsupported-scheduler', { ...coordinate, platform: 'win32', layout: 'npm' }));
  assert(!baseline.policyCoordinate('missing-config', { source: '0.160.7', state: 'fresh', method: 'self', platform: 'linux', layout: 'installer' }));
  assert(!baseline.policyCoordinate('unsupported-scheduler', { ...coordinate, source: '0.164.6' }));
  const daemon = { update: { automatic: false, lastResult: 'not checked. Automatic installation is available on Linux in this release. Run `cotal update --self` here' } };
  assert(baseline.policyRefusal('unsupported-scheduler', {}, '', daemon));
  assert(!baseline.policyRefusal('unsupported-scheduler', {}, '', { update: { ...daemon.update, automatic: true } }));
  assert(!baseline.policyRefusal('unsupported-scheduler', {}, '', { update: { automatic: false, lastResult: 'unrelated error' } }));
  assert.equal(baseline.cellExitCode({ result: 'unsupported', expectedRefusal: { passed: true }, cleanupFailure: 'failed to stop' }), 1);
});
test('matrix includes each requested source, state and method', () => {
  assert.equal(coordinates('linux').length, 252);
  assert.equal(coordinates('linux').filter(cell => !cell.excluded).length, 138);
  assert.equal(coordinates('win32').filter(cell => !cell.excluded).length, 48);
  assert.equal(coordinates('win32').filter(cell => !cell.excluded && cell.layout === 'installer').length, 0);
  assert.deepEqual(sources, ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest']);
  assert.equal(states.length, 7);
  assert.equal(methods.length, 3);
  assert(exclusion({ layout: 'npm', method: 'installer', state: 'fresh' }));
  assert(exclusion({ layout: 'npm', method: 'scheduler', state: 'fresh' }));
  assert.equal(exclusion({ layout: 'npm', method: 'scheduler', state: 'daemon' }), undefined);
});
