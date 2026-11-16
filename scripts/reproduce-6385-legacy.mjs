/** Hosted-only historical update and same-path recovery measurements. No product edits. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
export function ageObservedSchedule(check, attempt, target, now = Date.now()) {
  assert.equal(check.latest, target, 'only a genuinely observed release may be aged');
  assert(Number.isFinite(check.firstSeenAt), 'observed release timestamp required');
  assert(Number.isInteger(attempt.failures) && attempt.failures >= 0, 'real failure budget required');
  const aged = now - 25 * 3600000;
  return { check: { ...check, firstSeenAt: aged, checkedAt: aged, attemptedAt: aged }, attempt: { ...attempt, next: aged } };
}
export function opportunitySettled(before, after, status, target) {
  if (status?.state !== 'ready') return false;
  if (status.version === target && !/^updating to /.test(after.result)) return true;
  return after.failures > before.failures || /failed twice; waiting for a newer version/.test(after.result) || after.result === 'up to date';
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
  const report = { schema: 3, source: '0.160.2', target: '0.160.3', calls: [], opportunities: [], startedAt: new Date().toISOString(), root, result: 'incomplete' };
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
    const attemptPath = join(state, 'update-attempt.json');
    const record = { at: new Date().toISOString(), marker: m ? { sha256: sha256(m), ambiguous: ambiguous(m), value: JSON.parse(m) } : { absent: true }, preservation: preservation(canaries ?? []), attempt: existsSync(attemptPath) ? JSON.parse(readFileSync(attemptPath)) : null };
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
  async function observeOpportunity(label, target) {
    const checkPath = join(state, 'update-check.json'), attemptPath = join(state, 'update-attempt.json');
    const learnedUntil = Date.now() + 120000;
    if (existsSync(checkPath)) {
      const current = JSON.parse(readFileSync(checkPath));
      if (current.latest !== target) {
        // Expire freshness only. The next scheduler check must discover the new tag itself.
        current.checkedAt = current.attemptedAt = Date.now() - 25 * 3600000;
        writeFileSync(checkPath, JSON.stringify(current) + '\n', { mode: 0o600 });
      }
    }
    while (Date.now() < learnedUntil) {
      if (existsSync(checkPath) && JSON.parse(readFileSync(checkPath)).latest === target) break;
      await cotal(`${label}: observe registry learning`, ['daemon', 'status', '--json']);
      await delay(3000);
    }
    const before = await snapshot(`${label}: before`);
    assert(before.attempt, 'real attempt record required');
    const aged = ageObservedSchedule(JSON.parse(readFileSync(checkPath)), before.attempt, target);
    writeFileSync(checkPath, JSON.stringify(aged.check) + '\n', { mode: 0o600 });
    writeFileSync(attemptPath, JSON.stringify(aged.attempt) + '\n', { mode: 0o600 });
    const reload = await cotal(`${label}: read-only clock reload`, ['daemon', 'status', '--json'], true);
    assert.equal(JSON.parse(reload.stdout).result.pid, JSON.parse(before.daemon.stdout).result.pid, 'clock stimulus must not restart daemon');
    const row = { label, target, before, aged, reload, samples: [] }; report.opportunities.push(row); persist();
    const until = Date.now() + 6 * 60000;
    let settledAt;
    while (Date.now() < until) {
      const observed = await snapshot(`${label}: scheduler observation`);
      row.samples.push(observed); row.final = observed; persist();
      if (observed.marker.ambiguous) { row.outcome = 'ambiguous'; break; }
      const status = statusEvidence(observed.daemon.stdout);
      if (observed.attempt && observed.attempt.next > aged.attempt.next && opportunitySettled(before.attempt, observed.attempt, status, target)) {
        settledAt ??= Date.now();
        // A failure count can change before native recovery finishes. Require a stable
        // ready minute so an old daemon answering mid-update is not a final outcome.
        if (Date.now() - settledAt >= 60000) {
          row.outcome = /failed twice; waiting/.test(observed.attempt.result) ? 'failure-budget-stop' : status.version === target ? 'target-ready' : 'restored-or-retained';
          break;
        }
      } else settledAt = undefined;
      await delay(5000);
    }
    row.outcome ??= 'observation-bound'; persist(); return row;
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
    let initial;
    const readyUntil = Date.now() + 120000;
    while (Date.now() < readyUntil) {
      initial = await snapshot('source readiness observation');
      const status = statusEvidence(initial.daemon.stdout);
      if (status.state === 'ready' && status.version === '0.160.2' && status.update.automatic === true) break;
      await delay(2000);
    }
    report.before = initial;
    assert.equal(statusEvidence(initial.daemon.stdout).version, '0.160.2'); assert.equal(statusEvidence(initial.daemon.stdout).state, 'ready');
    assert.equal(statusEvidence(initial.daemon.stdout).update.automatic, true, 'historical scheduler must actually be enabled');
    for (let index = 0; index < 3; index++) {
      const row = await observeOpportunity('historical automatic opportunity ' + (index + 1), '0.160.3');
      if (row.outcome === 'ambiguous' || row.outcome === 'observation-bound') break;
    }
    report.historicalOpportunityCount = report.opportunities.length;
    report.historicalComplete = report.opportunities.length === 3 && report.opportunities.every(row => !['ambiguous', 'observation-bound'].includes(row.outcome));
    report.beforeWayOut = await snapshot('after historical automatic opportunities');
    report.journal = await call('historical service journal', 'journalctl', ['--user', '--no-pager', '-u', nativePlan.unit, '--since', report.startedAt, '-n', '250']);
    const latestResponse = await fetch('https://registry.npmjs.org/cotal-ai/latest', { signal: AbortSignal.timeout(30000) }); assert(latestResponse.ok);
    const latest = await latestResponse.text(); report.publishedLatest = JSON.parse(latest).version;
    report.latestReceipt = { at: new Date().toISOString(), sha256: sha256(latest), version: report.publishedLatest };
    registry.setLatest(report.publishedLatest);
    report.wayOut = {};
    report.wayOut.reinstall = await call('documented npm latest reinstall', 'npm', ['install', '-g', 'cotal-ai@latest', '--no-audit', '--no-fund'], false, 600000);
    report.wayOut.afterReinstall = await snapshot('after documented reinstall');
    // Existing upgrade docs prescribe current update --self after installing the fixed release.
    // Preserve its instruction/refusal verbatim. No marker clearing, new repair or forced restart.
    report.wayOut.updateSelf = await cotal('installed release documented update self', ['update', '--self']);
    report.wayOut.publicStatus = await cotal('installed release public status', ['status']);
    report.wayOut.final = await snapshot('after installed release instructions');
    const readyUntilAfter = Date.now() + 120000;
    while (Date.now() < readyUntilAfter && statusEvidence(report.wayOut.final.daemon.stdout).version !== report.publishedLatest) {
      await delay(3000);
      report.wayOut.final = await snapshot('observe installed release native activation');
    }
    const ready = statusEvidence(report.wayOut.final.daemon.stdout);
    report.wayOut.canariesIntact = JSON.stringify(report.wayOut.final.preservation) === JSON.stringify(report.canaries.before);
    report.wayOut.markerGone = report.wayOut.final.marker.absent === true;
    report.wayOut.daemonRunning = ready.state === 'ready';
    if (ready.state === 'ready' && ready.version === report.publishedLatest) {
      report.wayOut.automaticObservation = await observeOpportunity('after reinstall automatic scheduling', report.publishedLatest);
      const final = report.wayOut.automaticObservation.final;
      report.wayOut.automaticEnabled = statusEvidence(final.daemon.stdout).update.automatic === true;
      report.wayOut.automaticCheckSucceeded = final.attempt?.result === 'up to date' && report.wayOut.automaticEnabled;
      report.wayOut.proofLimit = 'latest-to-latest scheduler check, not a newer-release replacement';
    } else report.wayOut.automaticUnmeasured = 'installed instructions did not leave latest daemon ready';
    report.result = report.historicalComplete ? 'observed' : 'partial';
  } catch (error) { report.result = 'blocked'; report.error = String(error.stack).slice(0, 6000); }
  finally {
    persist();
    if (serviceOwned && receipt) {
      try { verifyOwnedUnit(); report.cleanup = await cotal('owned native service uninstall', ['daemon', 'uninstall', '--yes', '--json']); }
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
  for (let i = 0; i < args.length; i += 2) { assert(args[i] === '--output' && args[i + 1]); options.output = args[i + 1]; }
  const report = await runLegacy(options); console.log(JSON.stringify({ result: report.result })); process.exitCode = report.result === 'observed' ? 0 : 1;
}
