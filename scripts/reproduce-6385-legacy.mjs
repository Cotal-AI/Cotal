/** Hosted-only legacy #6385 observation probe.
 * API: runLegacy({ output, waitMs? }). CLI: --output /runner/temp/new-directory.
 * Published 0.160.2 uses a real user service and registry-pinned 0.160.3 unattended update.
 * A genuinely learned release hold may be aged, as in the native baseline suite.
 * Default observation window is 35 minutes. No marker is manufactured.
 * LIMIT: same-state recovery copies are blocked pending exclusive orphan-child custody.
 * Both repairs are skipped rather than restoring account/process-bound state unsafely.
 * Output is bounded structured evidence and command hashes, not raw secret-bearing logs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  try {
    const s = JSON.parse(text).result;
    return { current: typeof s?.current === 'string' ? s.current : undefined, latest: typeof s?.latest === 'string' ? s.latest : undefined, updateAvailable: typeof s?.updateAvailable === 'boolean' ? s.updateAvailable : undefined };
  } catch { return { unreadable: true }; }
}
export function statusEvidence(text) {
  try {
    const s = JSON.parse(text).result;
    return { state: s?.state, version: s?.version, update: { automatic: s?.update?.automatic, next: s?.update?.next, lastCheckedAt: s?.update?.lastCheckedAt } };
  } catch { return { unreadable: true }; }
}
export function command(file, args, env, timeoutMs = 180000) {
  guard();
  return new Promise(resolveCommand => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let bytes = 0, stdout = '', overflow = false, timedOut = false;
    const hash = createHash('sha256');
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const collect = (chunk, out) => {
      const remaining = Math.max(0, 256 * 1024 - bytes);
      hash.update(chunk.subarray(0, remaining));
      if (out) stdout += chunk.subarray(0, remaining).toString();
      bytes += chunk.length;
      if (bytes > 256 * 1024) { overflow = true; kill(); }
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    let failed = false;
    child.on('error', () => { failed = true; });
    child.on('close', (exit, signal) => { clearTimeout(timer); resolveCommand({ exit, signal, failed, timedOut, overflow, bytes: Math.min(bytes, 256 * 1024), sha256: hash.digest('hex'), stdout }); });
  });
}

/** Read-only proxy pins first-party latest metadata while preserving published tarball integrity. */
export async function publishedRegistry() {
  guard();
  let latest = '0.160.3';
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' || req.url.length > 2048) { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
      const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
      const selector = path.slice(name.length + 1);
      const firstParty = name === 'cotal-ai' || name.startsWith('@cotal-ai/');
      const url = firstParty && !path.includes('/-/') ? `https://registry.npmjs.org/${encodeURIComponent(name)}` : `https://registry.npmjs.org${req.url}`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { await upstream.body.cancel().catch(() => {}); throw new Error('registry response too large'); }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (!upstream.ok || !firstParty || path.includes('/-/')) { res.writeHead(upstream.status).end(buffer); return; }
      const metadata = JSON.parse(buffer);
      const body = pinMetadata(metadata, latest, selector);
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
    } catch { res.writeHead(502).end('registry probe failed'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, setLatest(version) { assert.match(version, /^\d+\.\d+\.\d+$/); latest = version; }, close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }) };
}
function readMarker(path) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, 'unsafe marker');
  return readFileSync(path);
}
function inventory(root, limit = 256) {
  const result = [];
  function visit(path, depth) {
    if (!existsSync(path)) return;
    assert(result.length < limit && depth < 10, 'private inventory exceeds bound');
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), 'private inventory refuses symlinks');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) {
      if (['extensions', 'seed', 'node_modules', 'logs', 'store', 'daemon'].includes(name) || /^(update-|.*\.log)/.test(name)) continue;
      visit(join(path, name), depth + 1);
    }
    else { assert(stat.size <= 1024 * 1024, 'private file too large'); result.push({ pathSha256: sha256(path.slice(root.length)), sha256: sha256(readFileSync(path)) }); }
  }
  visit(root, 0);
  return result;
}
export async function runLegacy(options) {
  guard(); // Must precede every filesystem write, network listener and child process.
  assert(options.route === undefined, 'both routes run from the same original');
  const waitMs = Number(options.waitMs ?? 35 * 60000);
  assert(Number.isInteger(waitMs) && waitMs >= 60000 && waitMs <= 90 * 60000, 'wait bound is 1 to 90 minutes');
  const home = homedir(), temp = realpathSync(process.env.RUNNER_TEMP);
  const outputDirectory = resolve(options.output);
  assert(outputDirectory.startsWith(temp + '/') && !existsSync(outputDirectory), 'new output inside RUNNER_TEMP required');
  const output = join(outputDirectory, 'report.json');
  // A native user service needs the actual account HOME. Require an unused account surface.
  for (const path of ['.cotal', '.config/cotal', '.config/systemd/user/cotal-daemon.service', '.npmrc']) assert(!existsSync(join(home, path)), 'pristine account required');
  const root = mkdtempSync(join(temp, 'legacy-6385-'));
  const report = { schema: 1, route: 'same-state-pair', source: '0.160.2', target: '0.160.3', provenance: 'single original account-bound state, no copies or repairs attempted without custody barrier', preservation: 'not exercised: no credential canaries seeded', calls: [], result: 'incomplete' };
  const env = { PATH: process.env.PATH, HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, npm_config_prefix: join(root, 'prefix'), npm_config_cache: join(root, 'cache'), DO_NOT_TRACK: '1', NO_COLOR: '1' };
  const registry = await publishedRegistry();
  env.npm_config_registry = registry.url;
  // systemd does not inherit npm_config_registry. The pristine account's private npmrc
  // pins both daemon checks and its npm child without changing a product file.
  writeFileSync(join(home, '.npmrc'), `registry=${registry.url}\nprefix=${env.npm_config_prefix}\ncache=${env.npm_config_cache}\n`, { mode: 0o600, flag: 'wx' });
  const cli = join(env.npm_config_prefix, 'bin/cotal');
  const marker = join(env.npm_config_prefix, 'lib/node_modules/.cotal-update-child');
  const call = async (label, file, args, required = false) => {
    const r = await command(file, args, env);
    const { stdout, ...receipt } = r;
    report.calls.push({ label, command: [file, ...args].map(value => value.replaceAll(home, '<home>').replaceAll(root, '<fixture>')), ...receipt });
    if (required) assert(r.exit === 0 && !r.overflow && !r.timedOut, `${label} failed, see hashed command receipt`);
    return { ...receipt, stdout };
  };
  const snapshot = async label => {
    const m = existsSync(marker) ? readMarker(marker) : undefined;
    const status = await call(`${label}: daemon`, cli, ['daemon', 'status', '--json']);
    const next = await call(`${label}: next update`, cli, ['update', '--check', '--json']);
    return { marker: m ? { sha256: sha256(m), ambiguous: ambiguous(m) } : { absent: true }, daemon: statusEvidence(status.stdout), nextUpdate: { exit: next.exit, sha256: next.sha256, ...nextUpdateEvidence(next.stdout) }, configCredentialHashes: inventory(join(home, '.config/cotal')), machineCredentialHashes: inventory(join(home, '.cotal')) };
  };
  let installedService = false;
  try {
    await call('published source install', 'npm', ['install', '-g', 'cotal-ai@0.160.2', '--no-audit', '--no-fund'], true);
    const identity = await call('source identity', cli, ['--version'], true);
    assert.equal(identity.stdout.trim(), 'cotal-ai 0.160.2', 'source version mismatch');
    await call('enable unattended updates', cli, ['update', '--auto', 'on'], true);
    const plan = await call('native service plan', cli, ['daemon', 'install', '--dry-run', '--json'], true);
    const nativePlan = JSON.parse(plan.stdout).result;
    assert.equal(nativePlan.state, 'would-install');
    assert.equal(nativePlan.unit, 'cotal-daemon.service');
    assert(!existsSync(nativePlan.unitPath), 'native unit already exists');
    installedService = true;
    await call('real user service install', cli, ['daemon', 'install', '--json'], true);
    const ready = await call('source native service status', cli, ['daemon', 'status', '--json'], true);
    report.sourceDaemon = statusEvidence(ready.stdout);
    assert.equal(report.sourceDaemon.state, 'ready', 'source daemon not ready');
    assert.equal(report.sourceDaemon.version, '0.160.2', 'source daemon version mismatch');
    assert.equal(report.sourceDaemon.update.automatic, true, 'source unattended scheduler unavailable');
    report.before = await snapshot('before unattended update');
    assert(report.before.marker.absent, 'source must start without a marker');
    const deadline = Date.now() + waitMs;
    let aged = false;
    while (Date.now() < deadline) {
      const cachePath = join(home, '.cotal/update-check.json');
      if (!aged && existsSync(cachePath)) {
        const cache = JSON.parse(readFileSync(cachePath));
        if (cache.latest === '0.160.3' || cache.version === '0.160.3') {
          report.releaseHold = { beforeSha256: sha256(readFileSync(cachePath)), observedVersion: '0.160.3', agedFields: ['checkedAt', 'firstSeenAt'] };
          for (const field of report.releaseHold.agedFields) if (typeof cache[field] === 'number') cache[field] = Date.now() - 7200000;
          writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 });
          aged = true;
        }
      }
      if (existsSync(marker) && ambiguous(readMarker(marker))) break;
      await delay(10000);
    }
    report.broken = await snapshot('before recovery');
    if (!report.broken.marker.ambiguous) { report.result = 'reproduction-not-observed'; return report; }
    const pkg = JSON.parse(readFileSync(join(env.npm_config_prefix, 'lib/node_modules/cotal-ai/package.json')));
    assert.equal(pkg.version, '0.160.3', 'ambiguous marker did not arise at exact published target');
    const latest = await fetch('https://registry.npmjs.org/cotal-ai/latest', { signal: AbortSignal.timeout(30000) });
    assert(latest.ok);
    const latestBytes = await latest.text();
    assert(latestBytes.length < 1024 * 1024, 'latest receipt too large');
    report.recoveryTarget = JSON.parse(latestBytes).version;
    report.recoveryRegistryReceipt = { registry: 'https://registry.npmjs.org/', at: new Date().toISOString(), sha256: sha256(latestBytes), version: report.recoveryTarget };
    registry.setLatest(report.recoveryTarget);
    // Same-path replacement needs a process/custody barrier covering orphaned children,
    // not merely systemd's restart mask. Do not mutate the original without that proof.
    report.result = 'blocked';
    report.blocker = 'Same-state snapshot restoration cannot yet prove exclusive custody of orphaned update children. Original retained, both repairs skipped.';
    return report;
  } catch (error) {
    report.result = 'probe-failed';
    report.failureClass = error.code ?? error.name;
    report.failureReason = error.name === 'AssertionError' ? String(error.message).slice(0, 300) : 'bounded probe command or filesystem failure';
    return report;
  } finally {
    if (installedService) {
      report.serviceCleanup = await call('owned service uninstall', cli, ['daemon', 'uninstall', '--json']).then(({ stdout, ...receipt }) => receipt);
    }
    report.retainedFixture = { owner: 'hosted job', release: 'disposable runner teardown', privateRoot: root, accountStateRetained: true };
    await registry.close();
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  const names = { output: 'output', 'wait-ms': 'waitMs' };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = names[process.argv[i].slice(2)];
    assert(key && process.argv[i + 1], 'use documented --name value pairs');
    options[key] = process.argv[i + 1];
  }
  runLegacy(options).then(report => { console.log(JSON.stringify({ result: report.result })); process.exitCode = report.result === 'observed' ? 0 : 2; }).catch(() => { console.error('legacy probe refused before execution'); process.exitCode = 1; });
}
