import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { isMainEntry } from './main-entry.mjs';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

/** Two homes share one installed CLI, but each must reconcile its own built-ins before launch. */
export async function twoHomeUpgrade({ oldDirectory, targetDirectory, root, routes = ['up', 'launch', 'old-manager'] }) {
  assert(['linux', 'darwin'].includes(process.platform), 'two-home installed-prefix proof is POSIX only');
  root = resolve(root);
  assert(!existsSync(root), 'two-home proof needs a new private root');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const report = { source: 'real installed candidate pair', calls: [], checks: [], graphs: {}, managers: {}, readOnly: {}, cleanup: 'not-started' };
  report.platform = process.platform;
  report.arch = process.arch;
  report.environment = { hostedDisposable: process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', nodeVersion: process.version };
  report.harnessSource = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim();
  report.harnessFiles = Object.fromEntries(['automatic-update-two-homes.mjs', 'automatic-update-two-homes-evidence.mjs'].map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')]));
  const save = () => {
    const result = JSON.stringify(report, null, 2);
    const transcript = report.calls.map(call => `${call.route}/${call.home}/${call.label}\n${call.stdout}${call.stderr}`).join('\n');
    writeFileSync(join(root, 'result.json'), result);
    writeFileSync(join(root, 'transcript.log'), transcript);
    writeFileSync(join(root, 'evidence.sha256'), [['result.json', result], ['transcript.log', transcript]].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n');
  };
  const check = (name, value) => { report.checks.push({ name, passed: Boolean(value) }); save(); assert(value, name); };
  const old = await candidateRegistry(resolve(oldDirectory), 'A', 'https://registry.npmjs.org/');
  let target;
  try {
    target = await candidateRegistry(resolve(targetDirectory), 'B', 'https://registry.npmjs.org/');
    report.old = old.identity; report.target = target.identity;
    for (const route of routes) {
      assert(['up', 'launch', 'old-manager'].includes(route), 'unknown two-home route');
      const directory = join(root, route);
      const prefix = join(root, 'prefix');
      const entry = join(prefix, 'bin', 'cotal');
      const environments = {};
      for (const home of ['A', 'B']) {
        const homeRoot = join(directory, home);
        for (const part of ['', 'config', 'cotal', 'runtime', 'tmp', 'project']) mkdirSync(join(homeRoot, part), { recursive: true, mode: 0o700 });
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'npm_config_before', 'NPM_CONFIG_BEFORE'].includes(key)));
        Object.assign(env, { HOME: homeRoot, COTAL_HOME: join(homeRoot, 'cotal'), XDG_CONFIG_HOME: join(homeRoot, 'config'), XDG_RUNTIME_DIR: join(homeRoot, 'runtime'), TMPDIR: join(homeRoot, 'tmp'), npm_config_prefix: prefix, npm_config_cache: join(directory, 'cache'), npm_config_registry: old.url, DO_NOT_TRACK: '1', NO_COLOR: '1', PATH: [join(prefix, 'bin'), env.PATH].join(delimiter) });
        environments[home] = env;
      }
      const call = async (home, label, file, args) => {
        const child = spawn(file, args, { cwd: join(directory, home, 'project'), env: environments[home], stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
        const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
        try {
          const { code, signal } = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
          const row = { route, home, label, args, code, signal, stdout, stderr };
          report.calls.push(row); save(); return row;
        } finally { clearTimeout(timer); }
      };
      const ok = async (home, label, args) => { const row = await call(home, label, entry, args); check(`${route} ${home} ${label} exits zero`, row.code === 0 && row.signal === null); return row; };
      const managerProbe = async (label, instanceId) => {
        const modules = join(prefix, 'lib/node_modules/cotal-ai/node_modules');
        const script = `const{localUpdateManagers}=await import(${JSON.stringify(pathToFileURL(join(modules, '@cotal-ai/cli/dist/commands/update.js')).href)});const{assertRecordIdentity}=await import(${JSON.stringify(pathToFileURL(join(modules, '@cotal-ai/workspace/dist/index.js')).href)});const candidates=localUpdateManagers({space:'twohomes'},${JSON.stringify(join(prefix, 'lib/node_modules/cotal-ai/dist/cotal.js'))});const owner=candidates.find(m=>m.instanceId===${JSON.stringify(instanceId)});if(!owner?.process||assertRecordIdentity(owner.process).kind!=='match')throw Error('Manager endpoint has no verified native owner');const{resolveControlTarget}=await import(${JSON.stringify(pathToFileURL(join(modules, '@cotal-ai/workspace/dist/index.js')).href)});const{askManager}=await import(${JSON.stringify(pathToFileURL(join(modules, '@cotal-ai/workspace/dist/control/index.js')).href)});const t=await resolveControlTarget({space:'twohomes'},'control-caller-admin',${JSON.stringify(instanceId)},{readOnly:true,onRefusal:'throw'});const s=await askManager({versionSkew:()=>{},roster:async()=>[]},t.space,t.server,'managerStatus',undefined,t.auth,'owner',3000,{instanceId:${JSON.stringify(instanceId)}});if(!s.ok||assertRecordIdentity(owner.process).kind!=='match')throw new Error(s.error??'Manager native identity changed');console.log(JSON.stringify({...s.data,native:owner.process}));`;
        const receipt = await call('B', label, process.execPath, ['--input-type=module', '-e', script]);
        check(`${route} ${label} exits zero`, receipt.code === 0 && receipt.signal === null);
        return JSON.parse(receipt.stdout);
      };
      let running = false;
      try {
        const install = await call('A', 'install old closure', 'npm', ['install', '-g', `cotal-ai@${old.identity.version}`]);
        check(`${route} installs normal old closure`, install.code === 0 && install.signal === null);
        for (const home of ['A', 'B']) {
          await ok(home, 'seed old home', ['ext', 'seed']);
          const version = await ok(home, 'old version', ['--version']);
          check(`${route} ${home} built-ins start at A`, inventory(version.stdout, old.identity.version));
        }
        const logicalEntry = realpathSync(entry);
        const fixture = join(directory, 'fixture'); mkdirSync(fixture, { mode: 0o700 });
        const fixtureRoot = selectedConnectorRoot(join(directory, 'B/config/cotal'), logicalEntry, old.identity.version);
        const connectorModules = realpathSync(join(fixtureRoot, 'extensions/node_modules/@cotal-ai/connector-jcode'));
        const core = execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', `console.log(import.meta.resolve('@cotal-ai/core',${JSON.stringify(pathToFileURL(join(connectorModules, 'package.json')).href)}));`], { encoding: 'utf8', env: environments.B }).trim();
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'cotal-two-home-seat', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
        const joined = join(fixture, 'joined.json');
        writeFileSync(join(fixture, 'seat.mjs'), `import{CotalEndpoint}from${JSON.stringify(core)};import{readFileSync,writeFileSync}from'node:fs';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,creds:readFileSync(e.COTAL_CREDS,'utf8'),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(${JSON.stringify(joined)},JSON.stringify({pid:process.pid,name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID}));setTimeout(()=>ep.stop().finally(()=>process.exit(0)),2000);`);
        writeFileSync(join(fixture, 'index.js'), `import{registry}from'@cotal-ai/core';registry.register({kind:'connector',name:'two-home-seat',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(join(fixture, 'seat.mjs'))}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
        if (route !== 'up') await ok('B', 'register fixture', ['ext', 'add', fixture]);
        await ok('B', 'prepare space', ['space', 'create', 'twohomes', '--plain']);
        const probe = createServer();
        await new Promise(done => probe.listen(0, '127.0.0.1', done));
        const server = `nats://127.0.0.1:${probe.address().port}`;
        await new Promise(done => probe.close(done));
        running = true;
        await ok('B', 'start original space', ['up', '--server', server, '--detach', ...(route === 'launch' ? ['--no-manager'] : [])]);
        const canonical = join(directory, 'B/config/cotal');
        const oldRoot = selectedConnectorRoot(canonical, logicalEntry, old.identity.version);
        const oldGraphs = [...new Set([canonical, oldRoot])].map(path => ({ path, before: connectorGraph(path) }));
        if (route === 'old-manager') {
          const status = await ok('B', 'old Manager identity before', ['status', '--json']);
          const local = JSON.parse(status.stdout).result.stackManager;
          assert(local && Number.isSafeInteger(local.pid) && typeof local.instanceId === 'string', 'live stack Manager identity required');
          const peers = JSON.parse((await ok('B', 'old Manager endpoint before', ['ps', '--json'])).stdout).result.managers;
          assert(peers.length === 1 && peers[0].state === 'answered', 'one answering Manager required');
          const served = await managerProbe('old Manager served identity before', peers[0].instanceId);
          report.managers[route] = { before: managerIdentity(served, local.pid) };
          check('old-manager starts exact old Manager', report.managers[route].before.version === old.identity.version);
        }
        if (route === 'up') { await ok('B', 'stop original space', ['down', '--yes']); running = false; }
        environments.A.npm_config_registry = target.url;
        if (route === 'old-manager') {
          const install = await call('A', 'old Manager candidate install setup', 'npm', ['install', '-g', `cotal-ai@${target.identity.version}`]);
          check('old Manager setup installs exact target without claiming updater acceptance', install.code === 0 && install.signal === null);
          await ok('A', 'reconcile separate A home', ['ext', 'seed']);
        } else await ok('A', 'self update shared installation', ['update', '--self']);
        const a = await ok('A', 'updated home version', ['--version']);
        check(`${route} A is fully reconciled`, inventory(a.stdout, target.identity.version) && !a.stdout.includes('Reconciliation pending'));
        const selectedPath = selectionPath(canonical, logicalEntry, target.identity.version);
        report.readOnly[route] = { targetSelectionAbsent: !existsSync(selectedPath), oldRoot, oldManifestRaw: readFileSync(join(oldRoot, 'extensions/extensions.json'), 'utf8'), oldManifest: JSON.parse(readFileSync(join(oldRoot, 'extensions/extensions.json'), 'utf8')), oldManifestSha256: createHash('sha256').update(readFileSync(join(oldRoot, 'extensions/extensions.json'))).digest('hex') };
        const stale = await ok('B', 'stale home version before command', ['--version']);
        check(`${route} B starts stale in shared installation`, stale.stdout.startsWith(`cotal-ai ${target.identity.version}\n`) && (inventory(stale.stdout, old.identity.version) || oldRoot !== canonical && stale.stdout === `cotal-ai ${target.identity.version}\n`) && report.readOnly[route].targetSelectionAbsent && !existsSync(selectedPath));
        check(`${route} home-only hint never asks for self replacement`, !stale.stdout.includes('update --self'));
        // --version is read-only. The next ordinary command creates the target selection.
        if (route === 'old-manager') {
          await ok('B', 'ordinary old Manager agent launch', ['spawn', '--detach', '--agent', 'two-home-seat', '--name', 'twohome-proof', '--no-events', '--on', report.managers[route].before.instanceId]);
          const seat = JSON.parse(readFileSync(joined, 'utf8'));
          check('old-manager real old fixture joined', seat.pid > 0 && seat.name === 'twohome-proof' && typeof seat.lifecycleUid === 'string');
          report.oldManagerSeat = seat;
          const retained = await ok('B', 'old Manager remains answering', ['ps', '--json']);
          check('old Manager control request still succeeds', JSON.parse(retained.stdout).outcome === 'ok');
        }
        else if (route === 'up') { await ok('B', 'ordinary next up', ['up', '--detach']); running = true; }
        else {
          await ok('B', 'ordinary next agent launch', ['spawn', '--foreground', '--agent', 'two-home-seat', '--name', 'twohome-proof', '--no-events']);
          const seat = JSON.parse(readFileSync(joined, 'utf8'));
          check('a real fixture seat joined without signed-in harness', seat.pid > 0 && seat.name === 'twohome-proof' && typeof seat.lifecycleUid === 'string');
          report.seat = seat;
        }
        const b = await ok('B', 'home version after ordinary command', ['--version']);
        check(`${route} ordinary command reconciles B completely`, inventory(b.stdout, target.identity.version) && !b.stdout.includes('Reconciliation pending'));
        const selectedRoot = selectedConnectorRoot(canonical, logicalEntry, target.identity.version, true);
        check(`${route} target selected root is isolated`, selectedRoot !== canonical && selectedRoot !== oldRoot);
        report.graphs[route] = { canonical, oldRoot, logicalEntry, version: target.identity.version, selectionPath: selectedPath, selection: JSON.parse(readFileSync(selectedPath, 'utf8')), selectedRoot, selected: connectorGraph(selectedRoot), old: oldGraphs.map(row => ({ ...row, after: connectorGraph(row.path) })) };
        check(`${route} old graphs byte and link unchanged`, report.graphs[route].old.every(row => JSON.stringify(row.before) === JSON.stringify(row.after)));
        const status = await ok('B', 'home status after command', ['status', '--json']);
        if (route === 'old-manager') {
          const local = JSON.parse(status.stdout).result.stackManager;
          assert(local && local.pid === report.managers[route].before.pid, 'stack Manager PID changed');
          report.managers[route].after = managerIdentity(await managerProbe('old Manager served identity after', report.managers[route].before.instanceId), local.pid);
          check('old-manager version PID and birth unchanged', JSON.stringify(report.managers[route].before) === JSON.stringify(report.managers[route].after));
        }
        const recovery = join(directory, 'B/cotal/update-recovery.json');
        check(`${route} home has no recovery obligation`, !existsSync(recovery) || JSON.parse(readFileSync(recovery, 'utf8')) === null);
        report[`${route}ManifestSha256`] = createHash('sha256').update(readFileSync(join(selectedRoot, 'extensions/extensions.json'))).digest('hex');
      } finally {
        if (running) {
          const cleanup = await call('B', 'final owned stack down', entry, ['down', '--yes']);
          check(`${route} owned stack cleanup confirmed`, cleanup.code === 0 && cleanup.signal === null);
        }
      }
    }
    report.cleanup = 'both owned stacks stopped'; report.acceptance = routes.length === 3 && new Set(routes).size === 3; save(); return report;
  } finally { if (target) await target.close(); await old.close(); save(); }
}

export function selectionPath(canonical, entry, version) {
  return join(canonical, 'installs', createHash('sha256').update(entry).digest('hex'), 'sets', version, 'selection.json');
}

export function selectedConnectorRoot(canonical, entry, version, required = false) {
  const path = selectionPath(canonical, entry, version);
  if (!existsSync(path)) { assert(!required, 'selected root receipt missing'); return canonical; }
  const file = lstatSync(path);
  assert(file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid() && (file.mode & 0o077) === 0 && file.size <= 8192, 'selection record is not private');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const root = join(path, '..', 'cotal');
  assert(record.v === 1 && record.entry === entry && record.version === version && record.root === root, 'invalid installed selection');
  for (let current = root; current !== canonical; current = resolve(current, '..')) {
    assert(current !== resolve(current, '..'), 'selection escaped config');
    const stat = lstatSync(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'selection is not private');
  }
  for (const name of ['seed', 'extensions']) {
    const stat = lstatSync(join(root, name));
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'selected graph is not a real directory');
  }
  return root;
}

function connectorGraph(root) {
  const rows = [];
  const visit = (path, relative) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) rows.push([relative, 'link', readlinkSync(path)]);
    else if (stat.isDirectory()) { rows.push([relative, 'directory']); for (const name of readdirSync(path).sort()) visit(join(path, name), join(relative, name)); }
    else { assert(stat.isFile(), 'unexpected graph entry'); rows.push([relative, 'file', createHash('sha256').update(readFileSync(path)).digest('hex')]); }
  };
  for (const name of ['seed', 'extensions']) if (existsSync(join(root, name))) visit(join(root, name), name);
  return rows;
}

function managerIdentity(served, pid) {
  assert(typeof served.version === 'string' && typeof served.instanceId === 'string', 'served Manager identity required');
  assert(Number.isSafeInteger(pid) && pid > 0);
  process.kill(pid, 0);
  const birth = process.platform === 'linux' ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] : served.native?.token;
  assert(birth, 'Manager birth required');
  assert(served.native?.pid === pid && served.native.token === birth, 'served Manager endpoint differs from native lifetime');
  return { version: served.version, instanceId: served.instanceId, pid, birth, native: served.native };
}

function inventory(output, version) {
  return ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
}

if (isMainEntry(import.meta.url)) {
  const [oldDirectory, targetDirectory, root, route] = process.argv.slice(2);
  assert(oldDirectory && targetDirectory && root, 'usage: automatic-update-two-homes.mjs <old-packed-closure> <target-packed-closure> <new-private-root>');
  await twoHomeUpgrade({ oldDirectory, targetDirectory, root, ...(route ? { routes: [route] } : {}) });
}
