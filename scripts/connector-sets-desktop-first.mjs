#!/usr/bin/env node
/** Observe an installed CLI Manager while a product-built desktop runtime is replaced. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function requireHostedLinux(env = process.env, platform = process.platform) {
  assert(platform === 'linux' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted', 'desktop-first measurement requires disposable GitHub-hosted Linux');
}
export function parseOptions(args) {
  const keys = ['cli-candidate', 'desktop-runtime', 'desktop-candidate-A', 'desktop-next', 'desktop-node', 'output'];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    assert(args[i]?.startsWith('--') && keys.includes(key) && !options[key] && args[i + 1] && !args[i + 1].startsWith('--'), 'expected unique explicit path options');
    options[key] = resolve(args[i + 1]);
  }
  for (const key of keys) assert(options[key], `missing --${key}`);
  return options;
}
export function inside(root, path) {
  const r = relative(root, path);
  return r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r);
}
export function preparedRuntime(root) {
  const receipt = json(join(root, 'desktop-runtime.json'));
  assert(receipt.schema === 1 && receipt.target.endsWith('-unknown-linux-gnu') && /^24\./.test(receipt.node), 'requires product prepare:runtime Linux Node 24 receipt');
  assert(Array.isArray(receipt.files) && receipt.files.length > 0, 'missing prepared runtime inventory');
  const seen = new Set();
  for (const file of receipt.files) {
    const path = resolve(root, file.path);
    assert(inside(root, path) && !seen.has(path), 'invalid prepared runtime inventory path');
    seen.add(path);
    assert.equal(hash(path), file.sha256, `prepared runtime hash ${file.path}`);
  }
  assert.equal(json(join(root, 'package.json')).version, receipt.version);
  assert.equal(json(join(root, 'node_modules/@cotal-ai/core/package.json')).version, receipt.version);
  assert(seen.has(join(root, 'dist/cotal.js')), 'prepared runtime inventory lacks stock CLI');
  return { version: receipt.version, receiptSha256: hash(join(root, 'desktop-runtime.json')), files: receipt.files.length };
}
export function matchedSet(observation, version) {
  assert.equal(observation.version, version, 'extension set version must match selected core');
  assert(observation.id, 'expected installation-scoped version set');
  const manifest = json(join(observation.root, 'extensions.json'));
  const extensions = manifest.extensions.map(entry => ({ ...entry, installedVersion: json(join(observation.root, 'node_modules', entry.pkg, 'package.json')).version }));
  const firstParty = extensions.filter(entry => entry.pkg.startsWith('@cotal-ai/'));
  assert(firstParty.length > 0, 'expected seeded first-party connectors');
  assert(firstParty.every(entry => entry.version === version && entry.installedVersion === version), 'first-party extension/core skew');
  for (const entry of firstParty) assert.equal(json(join(observation.root, 'node_modules', entry.pkg, 'node_modules/@cotal-ai/core/package.json')).version, version, 'extension core skew');
  return { ...observation, coreVersion: version, extensions };
}
export function stableDistinctRoots(cli, before, after) {
  return Boolean(cli.id && before.id && before.id === after.id && cli.id !== before.id && before.version !== after.version && before.root !== after.root);
}
export function ownedProcessCensus(root, proc = '/proc') {
  const rows = [];
  for (const pid of readdirSync(proc).filter(name => /^\d+$/.test(name))) {
    try {
      if (!inside(root, readlinkSync(join(proc, pid, 'cwd')))) continue;
      rows.push({ pid: Number(pid), stat: readFileSync(join(proc, pid, 'stat'), 'utf8') });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  return rows;
}
function fixtureFiles(core, seat) {
  return {
    'package.json': JSON.stringify({ name: 'cotal-desktop-first-standin', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }),
    'seat.mjs': `import {CotalEndpoint} from ${JSON.stringify(pathToFileURL(core).href)};import {readFileSync} from 'node:fs';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,...(e.COTAL_CREDS?{creds:readFileSync(e.COTAL_CREDS,'utf8')}:{}),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();setInterval(()=>{},1000);for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`,
    'index.js': `import {registry} from '@cotal-ai/core';registry.register({kind:'connector',name:'desktop-first-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`,
  };
}
export async function measureDesktopFirst(options) {
  // Admission precedes registry startup, output creation, copies and package installation.
  requireHostedLinux();
  const { candidateRegistry, compareDesktopCatalogs, extensionRootObservation, standaloneSeatAttributed, runDiagnosticCommand } = await import('./automatic-update-platform-baseline.mjs');
  const input = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, resolve(value)]));
  for (const key of ['cli-candidate', 'desktop-runtime', 'desktop-candidate-A', 'desktop-next', 'desktop-node', 'output']) assert(input[key], `missing ${key}`);
  assert(!existsSync(input['desktop-runtime']), 'final desktop runtime root must be new and owned by this cell');
  assert(!existsSync(input.output), 'output must be a fresh directory');
  const a = preparedRuntime(input['desktop-candidate-A']), b = preparedRuntime(input['desktop-next']);
  assert.notEqual(a.version, b.version, 'desktop replacement must change version');
  assert(!inside(input['desktop-runtime'], input['desktop-next']) && !inside(input['desktop-runtime'], input['desktop-candidate-A']), 'prepared inputs must remain outside replacement root');
  mkdirSync(input.output, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(input.output, 'cell-'));
  const report = { kind: 'connector-sets-desktop-first', input, prepared: { a, b }, result: 'failed', calls: [], cleanup: {} };
  const save = () => writeFileSync(join(input.output, 'desktop-first.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const home = join(root, 'home'), project = join(root, 'project'), prefix = join(root, 'npm');
  for (const path of [home, project]) mkdirSync(path, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !key.startsWith('npm_config_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  Object.assign(env, { HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), COTAL_NO_PROMPT: '1', npm_config_userconfig: join(home, '.npmrc'), npm_config_cache: join(home, '.npm'), npm_config_prefix: prefix });
  env.PATH = `${join(prefix, 'bin')}:${env.PATH}`;
  const call = async (label, file, argv) => {
    const response = await runDiagnosticCommand(file, argv, { cwd: project, env, timeoutMs: 180000, maxBytes: 32 * 1024 * 1024 });
    let envelope;
    try { envelope = JSON.parse(response.stdout); } catch { /* Text commands have no envelope. */ }
    const outcome = response.timeout || response.signal || response.truncated || envelope?.outcome === 'unknown' ? 'unknown' : envelope?.outcome ?? 'recorded';
    report.calls.push({ label, file, argv, ...response, outcome });
    if (outcome === 'unknown') report.unknownOutcomes = [...(report.unknownOutcomes ?? []), label];
    save(); return response;
  };
  const ok = response => { assert(response.exit === 0 && response.signal === null && response.timeout === false && !response.truncated, 'command did not succeed, see original response'); return response; };
  const pkg = join(prefix, 'lib/node_modules/cotal-ai');
  const cli = (label, argv) => call(label, process.execPath, [join(pkg, 'dist/cotal.js'), ...argv]);
  const desktop = (label, argv) => call(label, input['desktop-node'], [join(input['desktop-runtime'], 'dist/cotal.js'), ...argv]);
  const space = 'desktop-first-proof';
  let registry, stackAttempted = false;
  try {
    registry = await candidateRegistry(input['cli-candidate'], 'A', 'https://registry.npmjs.org/');
    report.candidate = registry.identity;
    assert.equal(registry.identity.version, a.version, 'CLI and desktop A must be same candidate');
    env.npm_config_registry = registry.url;
    writeFileSync(join(home, '.npmrc'), `registry=${registry.url}\n`, { mode: 0o600 });
    ok(await call('install actual CLI candidate A', 'npm', ['install', '--global', '--prefix', prefix, `cotal-ai@${registry.identity.version}`, '--registry', registry.url]));
    assert.equal(json(join(pkg, 'node_modules/@cotal-ai/core/package.json')).version, a.version);
    mkdirSync(dirname(input['desktop-runtime']), { recursive: true });
    cpSync(input['desktop-candidate-A'], input['desktop-runtime'], { recursive: true, force: false, errorOnExist: true });
    // Desktop writes first into the shared private operator config.
    ok(await desktop('desktop A seed', ['ext', 'seed']));
    report.desktopBefore = matchedSet(extensionRootObservation(await desktop('desktop A root', ['ext', 'root'])), a.version);
    ok(await cli('CLI A seed', ['ext', 'seed']));
    report.cliBefore = matchedSet(extensionRootObservation(await cli('CLI A root', ['ext', 'root'])), a.version);
    assert.notEqual(report.desktopBefore.id, report.cliBefore.id);
    const fixture = join(root, 'standin'); mkdirSync(fixture);
    for (const [name, content] of Object.entries(fixtureFiles(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js'), join(fixture, 'seat.mjs')))) writeFileSync(join(fixture, name), content);
    ok(await cli('register real standin', ['ext', 'add', fixture]));
    ok(await cli('configure actual CLI local stack', ['setup', '--destination', 'local', '--harness', 'desktop-first-standin', '--project', project, '--space', space, '--no-input', '--configure-only']));
    stackAttempted = true;
    ok(await cli('start actual CLI stack', ['up', '--detach', '--space', space, '--server', 'nats://127.0.0.1:44229']));
    ok(await cli('spawn original standin', ['spawn', '--agent', 'desktop-first-standin', '--name', 'desktop-first-before', '--detach', '--no-events', '--space', space]));
    report.psBefore = ok(await cli('original CLI seats', ['ps', '--space', space, '--json']));
    const managers = JSON.parse(report.psBefore.stdout).result.managers;
    assert(managers?.length === 1 && managers[0].state === 'answered' && managers[0].instanceId);
    const instance = report.instanceId = managers[0].instanceId;
    assert(standaloneSeatAttributed(report.psBefore, instance, 'desktop-first-before'));
    report.modelsBefore = await cli('pinned CLI catalog before desktop replacement', ['models', '--on', instance, '--space', space, '--json']);
    report.processesBefore = ownedProcessCensus(root);
    const retired = `${input['desktop-runtime']}.retired-${process.pid}`;
    assert(!existsSync(retired), 'retired desktop root already exists');
    // Only this cell's copy is renamed. The prepared bundles remain immutable.
    renameSync(input['desktop-runtime'], retired);
    report.retainedDesktopA = retired;
    cpSync(input['desktop-next'], input['desktop-runtime'], { recursive: true, force: false, errorOnExist: true });
    report.replacement = preparedRuntime(input['desktop-runtime']);
    ok(await desktop('desktop B seed', ['ext', 'seed']));
    report.desktopAfter = matchedSet(extensionRootObservation(await desktop('desktop B root', ['ext', 'root'])), b.version);
    report.cliAfter = matchedSet(extensionRootObservation(await cli('unchanged CLI root', ['ext', 'root'])), a.version);
    assert(stableDistinctRoots(report.cliBefore, report.desktopBefore, report.desktopAfter), 'desktop identity must survive replacement and remain distinct from CLI');
    assert.equal(report.cliAfter.root, report.cliBefore.root, 'CLI set must remain unchanged');
    report.modelsAfter = await cli('pinned CLI catalog after desktop replacement', ['models', '--on', instance, '--space', space, '--json']);
    report.catalogs = compareDesktopCatalogs(report.modelsBefore, report.modelsAfter, instance);
    assert(report.catalogs.passed, JSON.stringify(report.catalogs));
    ok(await cli('spawn NEW standin on original CLI Manager', ['spawn', '--agent', 'desktop-first-standin', '--on', instance, '--name', 'desktop-first-after', '--detach', '--no-events', '--space', space]));
    report.psAfter = ok(await cli('pinned CLI seats after desktop replacement', ['ps', '--on', instance, '--space', space, '--json']));
    assert(standaloneSeatAttributed(report.psAfter, instance, 'desktop-first-before'));
    assert(standaloneSeatAttributed(report.psAfter, instance, 'desktop-first-after'));
    report.result = 'passed';
  } catch (error) { report.error = { message: error.message, stack: error.stack }; }
  finally {
    // No process is signalled by census. The actual stock down command owns cleanup.
    if (stackAttempted) {
      report.cleanup.before = ownedProcessCensus(root);
      report.cleanup.down = await cli('cleanup owned actual CLI stack', ['down', '--yes', '--space', space]);
      for (let attempt = 0; attempt < 20; attempt++) {
        report.cleanup.remaining = ownedProcessCensus(root);
        if (!report.cleanup.remaining.length) break;
        await delay(250);
      }
      report.cleanup.passed = report.cleanup.down.exit === 0 && report.cleanup.down.signal === null && report.cleanup.down.timeout === false && report.cleanup.remaining.length === 0;
      if (!report.cleanup.passed) report.result = 'failed';
    }
    if (registry) report.registryRequests = await registry.close();
    report.retained = { owner: 'calling workflow', paths: [root, input['desktop-runtime'], report.retainedDesktopA].filter(Boolean), release: 'after evidence archival and confirmed empty owned process census' };
    save();
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  requireHostedLinux();
  const report = await measureDesktopFirst(parseOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ result: report.result, output: report.input.output }));
  if (report.result !== 'passed') process.exitCode = 1;
}
