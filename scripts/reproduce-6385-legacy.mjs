/** Hosted-only historical update and same-path recovery measurements. No product edits. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function guard({ env = process.env, platform = process.platform, uid = process.getuid?.(), os = readFileSync('/etc/os-release', 'utf8') } = {}) {
  assert(platform === 'linux' && /^ID=ubuntu$/m.test(os), 'Ubuntu only');
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux', 'GitHub hosted Linux only');
  assert(Number.isInteger(uid) && uid > 0, 'nonroot only');
  assert(env.RUNNER_TEMP && env.GITHUB_RUN_ID, 'hosted identity required');
}
export function ambiguous(bytes) {
  try { const m = JSON.parse(bytes); return m.phase === 'ambiguous' && Number.isInteger(m.owner) && typeof m.nonce === 'string' && m.nonce.length > 0; }
  catch { return false; }
}
export function pinMetadata(metadata, latest, selector = '') {
  assert(metadata.versions?.[latest], 'pinned published package missing');
  return selector ? metadata.versions[selector === 'latest' ? latest : selector] : { ...metadata, 'dist-tags': { latest } };
}
export function nextUpdateEvidence(text) {
  try { const s = JSON.parse(text).result; return { current: s?.current, latest: s?.latest, updateAvailable: s?.updateAvailable }; }
  catch { return { unreadable: true }; }
}
export function statusEvidence(text) {
  try { const s = JSON.parse(text).result; return { state: s?.state, version: s?.version, update: { automatic: s?.update?.automatic, next: s?.update?.next, nextAttempt: s?.update?.nextAttempt } }; }
  catch { return { unreadable: true }; }
}
export function command(file, args, env, timeoutMs = 180000) {
  guard();
  return new Promise(done => {
    const startedAt = new Date().toISOString();
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false, error;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') error = e.message; } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const collect = (chunk, out) => {
      const remaining = Math.max(0, 1024 * 1024 - bytes);
      const text = chunk.subarray(0, remaining).toString().replace(/eyJ[A-Za-z0-9_.-]*/g, '<redacted>');
      if (out) stdout += text; else stderr += text;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { overflow = true; kill(); }
    };
    child.stdout.on('data', c => collect(c, true)); child.stderr.on('data', c => collect(c, false));
    child.on('error', e => { error = e.message; });
    child.on('close', (exit, signal) => { clearTimeout(timer); done({ startedAt, finishedAt: new Date().toISOString(), exit, signal, timedOut, overflow, error, stdout, stderr, sha256: sha256(stdout + '\0' + stderr) }); });
  });
}
export async function publishedRegistry() {
  guard();
  let latest = '0.160.3';
  const requests = [], metadata = new Map();
  const server = createServer(async (req, res) => {
    try {
      assert(req.method === 'GET' && req.url.length <= 2048);
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
      const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
      const selector = path.slice(name.length + 1), firstParty = name === 'cotal-ai' || name.startsWith('@cotal-ai/');
      requests.push({ at: new Date().toISOString(), path, latest });
      if (firstParty && !path.includes('/-/')) {
        if (!metadata.has(name)) {
          const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
          assert(response.ok); metadata.set(name, await response.json());
        }
        const body = pinMetadata(metadata.get(name), latest, selector);
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
      } else {
        const response = await fetch(`https://registry.npmjs.org${req.url}`, { signal: AbortSignal.timeout(30000) });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
        for await (const chunk of response.body) res.write(chunk);
        res.end();
      }
    } catch (error) { res.writeHead(502).end(error.message); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, setLatest(version) { assert.match(version, /^\d+\.\d+\.\d+$/); latest = version; }, close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }) };
}

export function preservation(files) {
  return files.map(path => ({ path, exists: existsSync(path), ...(existsSync(path) ? { sha256: sha256(readFileSync(path)) } : {}) }));
}
/** Never read process command lines. Unknown same-user file/cwd custody blocks replacement. */
export function assertNoFixtureProcesses(roots, ownPid = process.pid) {
  const owned = path => roots.some(root => path === root || path.startsWith(root + '/'));
  const observed = [];
  for (const name of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    if (Number(name) === ownPid) continue;
    const proc = `/proc/${name}`;
    try {
      if (lstatSync(proc).uid !== process.getuid()) continue;
      for (const entry of ['cwd', 'exe', ...readdirSync(join(proc, 'fd')).map(fd => `fd/${fd}`)]) {
        try { const target = readlinkSync(join(proc, entry)); assert(!owned(target), `fixture still held by pid ${name} (${entry})`); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      observed.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return observed;
}

export async function runLegacy(options) {
  guard();
  const home = realpathSync(homedir()), temp = realpathSync(process.env.RUNNER_TEMP);
  const output = resolve(options.output);
  assert(output.startsWith(temp + '/') && !existsSync(output), 'new output under RUNNER_TEMP required');
  for (const path of ['.cotal', '.config/cotal', '.config/systemd/user/cotal-daemon.service', '.npmrc']) assert(!existsSync(join(home, path)), `pristine hosted account required: ${path}`);
  const root = mkdtempSync(join(temp, 'legacy-6385-'));
  mkdirSync(output, { mode: 0o700 });
  const prefix = join(root, 'prefix'), state = join(home, '.cotal'), config = join(home, '.config/cotal');
  const report = { schema: 2, source: '0.160.2', target: '0.160.3', calls: [], routes: [], startedAt: new Date().toISOString(), root, result: 'incomplete' };
  const persist = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const env = { PATH: `${prefix}/bin:${process.env.PATH}`, HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), DO_NOT_TRACK: '1', NO_COLOR: '1' };
  const registry = await publishedRegistry(); env.npm_config_registry = registry.url;
  const cli = join(prefix, 'bin/cotal'), marker = join(prefix, 'lib/node_modules/.cotal-update-child');
  let nativePlan, receipt, canaries, serviceOwned = false;
  async function call(label, file, args, required = false, timeout = 180000) {
    const r = await command(file, args, env, timeout);
    report.calls.push({ label, file, args, ...r }); persist();
    if (required) assert(r.exit === 0 && !r.timedOut && !r.overflow, `${label}: ${r.stderr.slice(-2000)}`);
    return r;
  }
  const ctl = (label, args, required = true) => call(label, 'systemctl', ['--user', '--no-ask-password', '--no-pager', ...args], required);
  const cotal = (label, args, required = false) => call(label, cli, args, required);
  async function snapshot(label) {
    const m = existsSync(marker) ? readFileSync(marker) : undefined;
    const record = { at: new Date().toISOString(), marker: m ? { sha256: sha256(m), ambiguous: ambiguous(m), value: JSON.parse(m) } : { absent: true }, preservation: preservation(canaries ?? []) };
    if (nativePlan) record.unit = await ctl(`${label}: native state`, ['show', nativePlan.unit, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,NRestarts,ControlGroup'], false);
    record.daemon = await cotal(`${label}: daemon status`, ['daemon', 'status', '--json']);
    record.cli = await cotal(`${label}: version`, ['--version']);
    return record;
  }
  function verifyOwnedUnit() {
    assert(serviceOwned && nativePlan && receipt);
    const current = JSON.parse(readFileSync(join(state, 'daemon/service-unit.json')));
    assert.equal(current.unit, receipt.unit); assert.equal(current.unitPath, nativePlan.unitPath);
    assert.equal(sha256(readFileSync(nativePlan.unitPath)), current.unitSha256);
    return current;
  }
  async function stopBarrier(label) {
    verifyOwnedUnit();
    // The exclusive hosted account, disabled owned service, ended direct children and
    // full process/file census stay under this runner's control through each copy/swap.
    await ctl(`${label}: disable and stop owned service`, ['disable', '--now', nativePlan.unit]);
    await ctl(`${label}: hold native restart exclusion`, ['mask', '--runtime', nativePlan.unit]);
    const status = await ctl(`${label}: stopped custody`, ['show', nativePlan.unit, '--property=ActiveState,MainPID,ControlGroup']);
    assert(/^MainPID=0$/m.test(status.stdout), 'daemon must have exited before fixture copy');
    const group = /^ControlGroup=(.*)$/m.exec(status.stdout)?.[1];
    if (group && existsSync(`/sys/fs/cgroup${group}`)) {
      const walk = path => { if (existsSync(join(path, 'cgroup.procs'))) assert.equal(readFileSync(join(path, 'cgroup.procs'), 'utf8').trim(), '', 'service still has descendants'); for (const e of readdirSync(path, { withFileTypes: true })) if (e.isDirectory()) walk(join(path, e.name)); };
      walk(`/sys/fs/cgroup${group}`);
    }
    const m = existsSync(marker) ? JSON.parse(readFileSync(marker)) : undefined;
    for (const pid of [m?.owner, m?.pid].filter(Number.isSafeInteger)) assert(!existsSync(`/proc/${pid}`), `recorded updater pid ${pid} still exists, copy refused`);
    return { at: new Date().toISOString(), scanned: assertNoFixtureProcesses([root, state, config]), nativeState: status.stdout };
  }
  try {
    writeFileSync(join(home, '.npmrc'), `registry=${registry.url}\nprefix=${prefix}\ncache=${env.npm_config_cache}\n`, { mode: 0o600, flag: 'wx' });
    mkdirSync(config, { recursive: true, mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
    canaries = [join(config, '6385-config-canary'), join(state, '6385-credential-canary')];
    for (const path of canaries) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    report.canaries = { kind: 'opaque fixture preservation sentinels, not authenticated credentials', before: preservation(canaries) };
    await call('install exact published source', 'npm', ['install', '-g', 'cotal-ai@0.160.2', '--no-audit', '--no-fund'], true, 600000);
    const identity = await cotal('source version', ['--version'], true); assert.equal(identity.stdout.trim(), 'cotal-ai 0.160.2');
    await cotal('enable automatic updates', ['update', '--auto', 'on'], true);
    nativePlan = JSON.parse((await cotal('native install plan', ['daemon', 'install', '--dry-run', '--json'], true)).stdout).result;
    assert.equal(nativePlan.state, 'would-install'); assert.equal(nativePlan.unit, 'cotal-daemon.service'); assert(!existsSync(nativePlan.unitPath));
    serviceOwned = true;
    await cotal('install real owned service', ['daemon', 'install', '--json'], true);
    receipt = JSON.parse(readFileSync(join(state, 'daemon/service-unit.json'))); verifyOwnedUnit();
    report.plan = nativePlan; report.receipt = receipt;
    const initial = await snapshot('source ready'); report.before = initial;
    assert.equal(statusEvidence(initial.daemon.stdout).version, '0.160.2'); assert.equal(statusEvidence(initial.daemon.stdout).state, 'ready');
    assert.equal(statusEvidence(initial.daemon.stdout).update.automatic, true, 'historical scheduler must actually be enabled');
    const waitMs = Number(options.waitMs ?? 12 * 60000);
    assert(Number.isFinite(waitMs) && waitMs >= 60000 && waitMs <= 15 * 60000, 'historical observation bound is 1 to 15 minutes');
    const deadline = Date.now() + waitMs; let aged = false;
    while (Date.now() < deadline) {
      const checkPath = join(state, 'update-check.json'), attemptPath = join(state, 'update-attempt.json');
      if (!aged && existsSync(checkPath)) {
        const check = JSON.parse(readFileSync(checkPath));
        if (check.latest === '0.160.3' && Number.isFinite(check.firstSeenAt)) {
          report.learnedClock = { original: check, at: new Date().toISOString() };
          check.checkedAt = check.firstSeenAt = check.attemptedAt = Date.now() - 25 * 3600000;
          writeFileSync(checkPath, JSON.stringify(check) + '\n', { mode: 0o600 });
          if (existsSync(attemptPath)) { const attempt = JSON.parse(readFileSync(attemptPath)); attempt.next = Date.now() - 25 * 3600000; writeFileSync(attemptPath, JSON.stringify(attempt) + '\n', { mode: 0o600 }); }
          aged = true; persist();
        }
      }
      if (existsSync(marker) && ambiguous(readFileSync(marker))) break;
      await delay(3000);
    }
    report.broken = await snapshot('original broken state');
    report.journal = await call('historical service journal', 'journalctl', ['--user', '--no-pager', '-u', nativePlan.unit, '--since', report.startedAt, '-n', '200']);
    if (!report.broken.marker.ambiguous) { report.result = 'reproduction-not-observed'; return report; }
    assert.equal(JSON.parse(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/package.json'))).version, '0.160.3');
    report.copyBarrier = await stopBarrier('preserve broken original');
    const original = join(root, 'original'); mkdirSync(original, { mode: 0o700 });
    const surfaces = [{ name: 'prefix', live: prefix }, { name: 'state', live: state }, { name: 'config', live: config }];
    for (const s of surfaces) cpSync(s.live, join(original, s.name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    report.originalMarkerSha256 = sha256(readFileSync(join(original, 'prefix/lib/node_modules/.cotal-update-child')));
    assert.equal(report.originalMarkerSha256, report.broken.marker.sha256);
    const latestResponse = await fetch('https://registry.npmjs.org/cotal-ai/latest', { signal: AbortSignal.timeout(30000) }); assert(latestResponse.ok);
    const latest = await latestResponse.text(); report.publishedLatest = JSON.parse(latest).version;
    report.latestReceipt = { at: new Date().toISOString(), sha256: sha256(latest), version: report.publishedLatest };
    registry.setLatest(report.publishedLatest);
    const installerResponse = await fetch('https://get.cotal.ai', { signal: AbortSignal.timeout(30000) }); assert(installerResponse.ok);
    const installerBytes = Buffer.from(await installerResponse.arrayBuffer()); assert(installerBytes.length < 1024 * 1024);
    const installer = join(output, 'installer.sh'); writeFileSync(installer, installerBytes, { mode: 0o600 }); report.installer = { url: 'https://get.cotal.ai', sha256: sha256(installerBytes) };
    for (const route of ['npm', 'installer']) {
      if (route === 'installer') {
        report.restoreBarrier = await stopBarrier('restore same original for installer');
        for (const s of surfaces) { renameSync(s.live, join(root, `npm-after-${s.name}`)); cpSync(join(original, s.name), s.live, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false }); }
        assert.equal(sha256(readFileSync(marker)), report.originalMarkerSha256);
        verifyOwnedUnit();
      }
      await ctl(`${route}: release native restart exclusion`, ['unmask', '--runtime', nativePlan.unit]);
      await ctl(`${route}: reenable original service`, ['enable', '--now', nativePlan.unit]);
      const row = { route, inputMarkerSha256: sha256(readFileSync(marker)), before: await snapshot(`${route} copy before`) }; report.routes.push(row); persist();
      if (route === 'npm') row.reinstall = await call('current published reinstall', 'npm', ['install', '-g', 'cotal-ai@latest', '--no-audit', '--no-fund'], false, 600000);
      else { env.COTAL_INSTALL_DIR = prefix; env.COTAL_BIN_DIR = join(prefix, 'bin'); row.reinstall = await call('installer rerun', 'sh', [installer, '--version', report.publishedLatest, '--no-setup', '--no-modify-path'], false, 600000); delete env.COTAL_INSTALL_DIR; delete env.COTAL_BIN_DIR; }
      row.afterReinstall = await snapshot(`${route} after reinstall`);
      row.updateSelf = await cotal(`${route}: existing current self update`, ['update', '--self']);
      row.afterUpdate = await snapshot(`${route} after self update`);
      row.nextUpdate = await cotal(`${route}: next actual self update`, ['update', '--self']);
      row.final = await snapshot(`${route} final`);
      row.canariesIntact = JSON.stringify(row.final.preservation) === JSON.stringify(report.canaries.before);
      row.markerGone = row.final.marker.absent === true;
      row.daemonRunning = statusEvidence(row.final.daemon.stdout).state === 'ready';
      row.nextUpdateSucceeded = row.nextUpdate.exit === 0 && !row.nextUpdate.timedOut;
      persist();
    }
    report.result = 'observed';
  } catch (error) { report.result = 'blocked'; report.error = String(error.stack).slice(0, 6000); }
  finally {
    persist();
    if (serviceOwned && receipt) {
      try { verifyOwnedUnit(); await ctl('release owned native exclusion for uninstall', ['unmask', '--runtime', nativePlan.unit]); report.cleanup = await cotal('owned native service uninstall', ['daemon', 'uninstall', '--yes', '--json']); }
      catch (error) { report.cleanupError = error.message; }
    }
    report.registryRequests = registry.requests; await registry.close();
    report.finishedAt = new Date().toISOString(); persist();
    writeFileSync(join(output, 'report.sha256'), `${sha256(readFileSync(join(output, 'report.json')))}  report.json\n`);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { assert(['--output', '--wait-ms'].includes(args[i]) && args[i + 1]); options[args[i] === '--output' ? 'output' : 'waitMs'] = args[i + 1]; }
  const report = await runLegacy(options); console.log(JSON.stringify({ result: report.result })); process.exitCode = report.result === 'observed' ? 0 : 1;
}
