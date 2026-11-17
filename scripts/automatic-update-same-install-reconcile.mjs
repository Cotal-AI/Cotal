import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const rows = [];
  const visit = (path, key) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) rows.push({ path: key, link: readlinkSync(path) });
    else if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), key ? `${key}/${name}` : name);
    else if (info.isFile()) rows.push({ path: key, sha256: digest(readFileSync(path)) });
  };
  visit(root, ''); return rows;
}
function birth(pid) {
  if (process.platform !== 'linux') return undefined;
  try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' '); return fields[0] === 'Z' ? undefined : fields[19]; } catch { return undefined; }
}
async function unusedPort() { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
function nativeProcesses(root) {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name) && +name !== process.pid).flatMap(name => {
    try { return readlinkSync(`/proc/${name}/cwd`).startsWith(root) && birth(+name) ? [{ pid: +name, birth: birth(+name) }] : []; } catch { return []; }
  });
}
function selectedGraphs(root) {
  const installs = join(root, 'config/cotal/installs');
  const roots = [];
  try { for (const install of readdirSync(installs)) for (const version of readdirSync(join(installs, install, 'sets'))) {
    const path = join(installs, install, 'sets', version, 'selection.json');
    try { const selection = JSON.parse(readFileSync(path, 'utf8')); roots.push({ version, root: selection.root, inventory: inventory(selection.root) }); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return roots;
}

/** Real legacy installer first hop, installed public CLI, authenticated Manager inventory and one responsive PTY seat. */
export async function sameInstallReconcileCell({ root, candidate, nextCandidate, seedSkip = false, restart = true, expected = 'green' }) {
  assert.equal(process.platform, 'linux', 'native PID/birth acceptance is currently Linux only');
  root = resolve(root);
  for (const name of ['', 'home', 'cotal', 'config', 'data', 'tmp', 'runtime', 'project', 'fixture', 'evidence']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const free = statfsSync(root); assert(free.bavail * free.bsize >= 30 * 1024 ** 3, '30GiB free space required');
  const home = join(root, 'home'), prefix = join(root, 'data/cotal'), entry = join(home, '.local/bin/cotal');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COTAL_') && !['npm_config_before', 'NPM_CONFIG_BEFORE', 'npm_config_registry', 'NPM_CONFIG_REGISTRY'].includes(name)));
  Object.assign(env, { PATH: `${join(home, '.local/bin')}:${env.PATH}`, HOME: home, COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: join(root, 'tmp'), DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_logs_max: '0', SHELL: '/bin/bash' });
  if (seedSkip) env.COTAL_SKIP_CONNECTOR_SEED = '1';
  if (process.env.RECONCILE_LIVE_LAUNCH === '1') {
    const fake = resolve(import.meta.dirname, '../extensions/connector-jcode/smoke/fake-jcode.mjs');
    const tools = join(root, 'tools'); mkdirSync(tools, { mode: 0o700 });
    writeFileSync(join(tools, 'jcode'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'jcode 0.99.0'; exit 0; fi\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
    env.PATH = `${tools}:${env.PATH}`;
    env.COTAL_JCODE_TUI = '0';
  }
  const report = { v: 1, root, seedSkip, expected, calls: [], source: 'public cotal-ai@0.162.0', platform: process.platform, startedAt: new Date().toISOString() };
  const run = async (label, file, args, override = {}) => {
    const child = spawn(file, args, { cwd: join(root, 'project'), env: { ...env, ...override }, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = Date.now(), chunks = []; let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; chunks.push({ stream: 'stdout', text: String(bytes) }); });
    child.stderr.on('data', bytes => { stderr += bytes; chunks.push({ stream: 'stderr', text: String(bytes) }); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 420000);
    try { const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); const call = { label, code, elapsedMs: Date.now() - started, stdout, stderr, chunks, npmBefore: override.npm_config_before ?? null }; report.calls.push(call); writeFileSync(join(root, 'evidence', `${label}.json`), JSON.stringify(call, null, 2)); return call; }
    finally { clearTimeout(timer); }
  };
  const publicCall = (label, args, override) => run(label, entry, args, override);
  const ok = call => { assert.equal(call.code, 0, call.stdout + call.stderr); return call; };
  const bootstrap = { npm_config_before: '2026-11-16T19:38:00.000Z' };
  const installer = join(root, 'evidence/installer.sh');
  let started = false, overlay, nextOverlay;
  try {
    ok(await run('fetch-installer', 'curl', ['-fsSL', 'https://get.cotal.ai', '-o', installer]));
    report.installerSha256 = digest(readFileSync(installer));
    const meta = await fetch('https://registry.npmjs.org/cotal-ai/0.162.0'); assert(meta.ok); const metadata = await meta.json();
    report.sourceArchive = { tarball: metadata.dist.tarball, integrity: metadata.dist.integrity };
    const archive = await fetch(metadata.dist.tarball); assert(archive.ok); const bytes = Buffer.from(await archive.arrayBuffer());
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, metadata.dist.integrity);
    report.sourceArchive.sha256 = digest(bytes);
    ok(await run('bootstrap-installer', 'sh', [installer, '--version', '0.162.0', '--no-setup'], bootstrap));
    assert.match(ok(await publicCall('source-version', ['--version'])).stdout, /cotal-ai 0\.162\.0/);
    const fixture = join(root, 'fixture'), core = pathToFileURL(join(prefix, 'lib/node_modules/cotal-ai/node_modules/@cotal-ai/core/dist/index.js')).href;
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'cotal-reconcile-seat-fixture', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
    const seat = join(fixture, 'seat.mjs'), readyPath = join(root, 'seat-ready.json');
    writeFileSync(seat, `import{CotalEndpoint}from${JSON.stringify(core)};import{readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,creds:readFileSync(e.COTAL_CREDS,'utf8'),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});ep.on('error',console.error);await ep.start();const http=createServer((q,r)=>r.end(q.url));await new Promise(done=>http.listen(0,'127.0.0.1',done));writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({pid:process.pid,port:http.address().port,lifecycleUid:e.COTAL_LIFECYCLE_UID}));for(const signal of['SIGINT','SIGTERM'])process.on(signal,()=>{http.close();ep.stop().finally(()=>process.exit(0));});`);
    writeFileSync(join(fixture, 'index.js'), `import{registry}from'@cotal-ai/core';registry.register({kind:'connector',name:'reconcile-seat',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
    ok(await publicCall('fixture-add', ['ext', 'add', fixture], bootstrap));
    ok(await publicCall('setup', ['setup', '--destination', 'local', '--harness', 'reconcile-seat', '--project', join(root, 'project'), '--space', 'reconcile-proof', '--no-input', '--configure-only'], bootstrap));
    ok(await publicCall('up', ['up', '--space', 'reconcile-proof', '--server', `nats://127.0.0.1:${await unusedPort()}`], bootstrap)); started = true;
    ok(await publicCall('spawn', ['spawn', '--agent', 'reconcile-seat', '--name', 'reconcile_worker', '--detach', '--no-events', '--space', 'reconcile-proof'], bootstrap));
    const before = JSON.parse(ok(await publicCall('ps-before', ['ps', '--space', 'reconcile-proof', '--json'])).stdout).result;
    assert.equal(before.items.length, 1); assert.equal(before.items[0].presenceIdentityVerified, true);
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')), seatBirth = birth(ready.pid);
    report.before = { ps: before, seat: ready, seatBirth, native: nativeProcesses(root) };
    assert(report.before.native.length >= 4, 'broker, delivery, Manager and seat must be real native processes');
    const oldSelf = await publicCall('old-self', ['update', '--self']); assert.equal(oldSelf.code, 1); assert.match(oldSelf.stdout + oldSelf.stderr, /legacy manager custody/);
    report.oldPrefix = inventory(join(root, 'config/cotal/extensions'));
    if (candidate) { overlay = await candidateRegistry(resolve(candidate), 'B', 'https://registry.npmjs.org/'); env.npm_config_registry = overlay.url; report.candidate = overlay.identity; }
    const installCall = await run('installer-under-test', 'bash', ['-o', 'pipefail', '-c', 'curl -fsSL https://get.cotal.ai | sh -s -- --no-setup']);
    const installerSeats = JSON.parse(ok(await publicCall('ps-after-installer', ['ps', '--space', 'reconcile-proof', '--json'])).stdout).result;
    assert.equal(installerSeats.items.length, 1);
    for (const key of ['pid', 'id', 'lifecycleUid', 'instanceId']) assert.equal(installerSeats.items[0][key], before.items[0][key]);
    for (const row of report.before.native) assert.equal(birth(row.pid), row.birth);
    const installedPing = `installed-${Date.now()}`; assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}/${installedPing}`)).text(), `/${installedPing}`);
    const installedVersion = ok(await publicCall('version-after-installer', ['--version']));
    report.afterInstaller = { ps: installerSeats, version: installedVersion.stdout, challenge: installedPing, selected: selectedGraphs(root) };
    const nextSelf = await publicCall('next-self', ['update', '--self']);
    const version = ok(await publicCall('version-after', ['--version']));
    const after = JSON.parse(ok(await publicCall('ps-after', ['ps', '--space', 'reconcile-proof', '--json'])).stdout).result;
    assert.equal(after.items.length, 1); for (const key of ['pid', 'id', 'lifecycleUid', 'instanceId']) assert.equal(after.items[0][key], before.items[0][key]);
    assert.equal(birth(ready.pid), seatBirth);
    for (const row of report.before.native) assert.equal(birth(row.pid), row.birth, 'no original process may restart during reconciliation');
    const challenge = `after-${Date.now()}`; assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}/${challenge}`)).text(), `/${challenge}`);
    report.after = { ps: after, version: version.stdout, seatBirth: birth(ready.pid), oldPrefix: inventory(join(root, 'config/cotal/extensions')), challenge, selected: selectedGraphs(root) };
    assert.deepEqual(report.after.oldPrefix, report.oldPrefix);
    assert.equal(installCall.code, expected === 'green' ? 0 : 1); assert.equal(nextSelf.code, expected === 'green' ? 0 : 1);
    if (expected === 'green') { for (const text of [installedVersion.stdout, version.stdout]) { assert.doesNotMatch(text, /Reconciliation pending/); for (const name of ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi']) assert.match(text, new RegExp(name + '\\s+' + report.candidate.version.replaceAll('.', '\\.'))); assert.match(text, new RegExp('web, web-service, __service-web\\s+' + report.candidate.version.replaceAll('.', '\\.'))); } }
    if (restart && expected === 'green') {
      ok(await publicCall('future-down', ['down', '--with-agents', '--yes'])); started = false;
      ok(await publicCall('future-up', ['up', '--space', 'reconcile-proof'])); started = true;
      ok(await publicCall('new-spawn', ['spawn', '--agent', 'reconcile-seat', '--name', 'reconcile_new_worker', '--detach', '--no-events', '--space', 'reconcile-proof']));
      const fresh = JSON.parse(ok(await publicCall('new-ps', ['ps', '--space', 'reconcile-proof', '--json'])).stdout).result; assert.equal(fresh.items.length, 1); assert.notEqual(fresh.items[0].pid, ready.pid);
      const newReady = JSON.parse(readFileSync(readyPath, 'utf8')), ping = `new-${Date.now()}`; assert.equal(await (await fetch(`http://127.0.0.1:${newReady.port}/${ping}`)).text(), `/${ping}`); report.restart = { ps: fresh, ready: newReady, challenge: ping };
      if (nextCandidate) {
        const selectedBefore = selectedGraphs(root);
        assert(selectedBefore.length > 0, 'first hop must have selected a retained prefix');
        nextOverlay = await candidateRegistry(resolve(nextCandidate), 'B', 'https://registry.npmjs.org/');
        env.npm_config_registry = nextOverlay.url;
        report.nextCandidate = nextOverlay.identity;
        ok(await publicCall('candidate-to-next', ['update', '--self']));
        const nextVersion = ok(await publicCall('candidate-to-next-version', ['--version']));
        assert.match(nextVersion.stdout, new RegExp('cotal-ai ' + report.nextCandidate.version.replaceAll('.', '\\.')));
        assert.doesNotMatch(nextVersion.stdout, /Reconciliation pending/);
        assert.deepEqual(inventory(join(root, 'config/cotal/extensions')), report.oldPrefix);
        for (const graph of selectedBefore) assert.deepEqual(inventory(graph.root), graph.inventory, 'next release must not mutate prior selected graph');
        const nextGraphs = selectedGraphs(root);
        assert(nextGraphs.some(graph => graph.version === report.nextCandidate.version), 'next release must select its own inherited graph');
        const nextSeats = JSON.parse(ok(await publicCall('candidate-to-next-ps', ['ps', '--space', 'reconcile-proof', '--json'])).stdout).result;
        assert.equal(nextSeats.items.length, 1);
        assert.equal(nextSeats.items[0].lifecycleUid, fresh.items[0].lifecycleUid);
        const nextPing = `next-${Date.now()}`;
        assert.equal(await (await fetch(`http://127.0.0.1:${newReady.port}/${nextPing}`)).text(), `/${nextPing}`);
        report.next = { version: nextVersion.stdout, ps: nextSeats, challenge: nextPing, selectedBefore, selected: nextGraphs, oldPrefix: inventory(join(root, 'config/cotal/extensions')) };
        if (process.env.RECONCILE_LIVE_LAUNCH === '1') {
          ok(await publicCall('old-manager-firstparty-launch', ['spawn', '--agent', 'jcode', '--name', 'retained_jcode', '--detach', '--no-events', '--space', 'reconcile-proof', '--on', fresh.items[0].instanceId]));
        }
      }
    }
    report.passed = true;
  } finally {
    if (started) report.cleanup = await publicCall('cleanup-down', ['down', '--with-agents', '--yes']);
    if (overlay) await overlay.close();
    if (nextOverlay) await nextOverlay.close();
    report.finalNative = nativeProcesses(root);
    report.endedAt = new Date().toISOString();
    writeFileSync(join(root, 'evidence/result.json'), JSON.stringify(report, null, 2));
  }
  assert(report.cleanup === undefined || report.cleanup.code === 0, 'owned stack cleanup must succeed');
  assert.deepEqual(report.finalNative, [], 'owned fixture processes must exit');
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, candidate, nextCandidate] = process.argv.slice(2); assert(root, 'usage: automatic-update-same-install-reconcile.mjs <private-root> [candidate-pack] [next-candidate-pack]');
  console.log(JSON.stringify(await sameInstallReconcileCell({ root, candidate, nextCandidate, seedSkip: process.env.RECONCILE_SEED_SKIP === '1', expected: candidate ? 'green' : 'red' })));
}
