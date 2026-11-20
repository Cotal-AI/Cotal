import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitSentinel } from './sentinel.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Runs real npm and the built public entry against a registry with a listed, initially missing archive. */
export async function registryArrivalCell({ scenario, entry = join(repo, 'bin/dist/cotal.js'), parent = tmpdir() }) {
  assert(['arrives', 'unavailable', 'integrity', 'reset', 'cache', 'archive-interrupted', 'closure-killed', 'closure-nospace', 'orphan', 'pending', 'reconcile-killed', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging', 'concurrent'].includes(scenario));
  const dateFiltered = scenario === 'min-release-age' || scenario === 'before';
  const closureKilled = scenario === 'closure-killed';
  const closureNoSpace = scenario === 'closure-nospace';
  const offline = scenario.startsWith('offline-');
  const root = mkdtempSync(join(parent, 'registry-arrival-'));
  const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
  const target = '99.0.0', archives = new Map(), requests = [];
  const extension = '@cotal-ai/cache-fixture';
  const prefix = join(root, 'prefix'), home = join(root, 'home');
  const marker = join(prefix, 'lib/node_modules/.cotal-update-child');
  const ready = join(root, 'reconcile.pid');
  function readMarker() {
    try { return JSON.parse(readFileSync(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of ['home', 'cotal', 'config', 'tmp', 'runtime', 'prefix', '.cotal', 'payload/package/dist']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  if (closureNoSpace) writeFileSync(join(root, 'payload/package/dist/data'), Buffer.alloc(4 * 1024 * 1024));
  for (const version of [previous, target]) {
    writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' } }));
    const contention = scenario === 'concurrent'
      ? `if (process.argv.includes('update')) { const deadline = Date.now() + 30000; while (!existsSync(${JSON.stringify(join(root, 'waiter-observed'))})) { if (Date.now() >= deadline) throw new Error('competing updater did not reach the reservation'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } }\n`
      : '';
    const hold = scenario === 'reconcile-killed' && version === target ? `if (process.argv[2] === 'update' && !existsSync(${JSON.stringify(ready)})) { writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(99), 60000); }\n` : '';
    writeFileSync(join(root, 'payload/package/dist/cotal.js'), `#!/usr/bin/env node\nimport { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n${contention}${hold}const scratch = mkdtempSync(join(tmpdir(), "reconcile-child-"));\nrmSync(scratch, { recursive: true });\nconsole.log("fixture reconciled with writable temporary directory");\n`, { mode: 0o755 });
    const packed = spawnSync('tar', ['-czf', join(root, `${version}.tgz`), '-C', join(root, 'payload'), 'package']);
    assert.equal(packed.status, 0);
    archives.set(version, readFileSync(join(root, `${version}.tgz`)));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COTAL_') && !['npm_config_before', 'NPM_CONFIG_BEFORE'].includes(name)));
  Object.assign(env, { HOME: home, COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'), XDG_RUNTIME_DIR: join(root, 'runtime'), npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });
  let origin, armed = false, disconnected = false, missing = 0, heldArchive, closureSignal;
  const server = createServer((request, response) => {
    requests.push({ at: Date.now(), path: request.url });
    if (disconnected || armed && scenario === 'offline-archive' && request.url?.endsWith(`/${target}.tgz`)) {
      disconnected = true;
      return request.socket.destroy();
    }
    if (request.url?.endsWith('.tgz')) {
      const version = request.url.slice(1, -4);
      if (armed && version === target) {
        missing++;
        if (scenario === 'archive-interrupted' && missing === 1) { heldArchive = response; return; }
        if (scenario === 'reset' && missing === 1) return request.socket.destroy();
        if (scenario === 'unavailable' || scenario === 'arrives' && missing === 1) return response.writeHead(404).end('archive is propagating');
        if (scenario === 'integrity') return response.end(Buffer.from('corrupt archive'));
      }
      return response.end(archives.get(version));
    }
    if (decodeURIComponent(request.url?.split('?')[0] ?? '') === `/${extension}`) {
      if (armed && closureKilled && !closureSignal) {
        try {
          const pid = interrupted.pid;
          const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
          assert.match(children, /^[1-9]\d*$/, 'only the actual dependency-check npm child is running');
          const argv = readFileSync(`/proc/${children}/cmdline`, 'utf8');
          assert.match(argv, /npm.*install.*cotal-closure-check|npm install @cotal-ai\//s);
          process.kill(Number(children), 'SIGKILL');
          closureSignal = 'SIGKILL';
        } catch (error) {
          closureSignal = error;
        }
      }
      const bytes = archives.get(target);
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ name: extension, 'dist-tags': { latest: target }, versions: { [target]: { name: extension, version: target, dist: { tarball: `${origin}/${target}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } } }));
    }
    const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, { name: 'cotal-ai', version, ...(armed && scenario === 'closed-scope' ? { dependencies: { '@cotal-ai/cli': version } } : {}), bin: { cotal: 'dist/cotal.js' }, dist: { tarball: `${origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: target }, versions, time: { [previous]: '2019-01-01T00:00:00.000Z', [target]: new Date().toISOString() } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.npm_config_registry = origin;
  let interrupted, orphan, abandoned, pausedArchive;
  const run = async (file, args, timeoutMs) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
      if (scenario === 'concurrent' && output.includes("Waiting for another updater to release npm's global root"))
        writeFileSync(join(root, 'waiter-observed'), 'ready');
      const progress = { 'offline-metadata': 'release archives', 'offline-closure': 'Checking installed extension dependencies', 'offline-staging': 'beside the running version' }[scenario];
      if (armed && progress && output.includes(progress)) disconnected = true;
    });
    child.stderr.on('data', bytes => output += bytes);
    interrupted = child;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    try {
      const { code, signal } = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
      return { code, signal, output };
    } finally { clearTimeout(timer); }
  };
  try {
    const install = await run('npm', ['install', '-g', `cotal-ai@${previous}`], 60000);
    assert.equal(install.code, 0, install.output);
    const packageRoot = join(prefix, 'lib/node_modules/cotal-ai');
    if (scenario === 'offline-staging') {
      cpSync(join(repo, 'bin/dist'), join(packageRoot, 'dist'), { recursive: true });
      cpSync(join(repo, 'bin/package.json'), join(packageRoot, 'package.json'));
      symlinkSync(join(repo, 'bin/node_modules'), join(packageRoot, 'node_modules'), 'dir');
      entry = join(packageRoot, 'dist/cotal.js');
    }
    if (scenario === 'offline-closure') {
      const extensions = join(root, 'config/cotal/extensions');
      mkdirSync(extensions, { recursive: true, mode: 0o700 });
      writeFileSync(join(extensions, 'extensions.json'), JSON.stringify({ extensions: [{ pkg: '@cotal-ai/network-fixture', version: previous, spec: `@cotal-ai/network-fixture@${previous}`, commands: [] }] }));
    }
    const before = readFileSync(join(packageRoot, 'dist/cotal.js'));
    writeFileSync(join(packageRoot, 'preserve'), 'unchanged');
    armed = true;
    if (scenario === 'closed-scope') {
      const closed = createServer();
      await new Promise(done => closed.listen(0, '127.0.0.1', done));
      const port = closed.address().port;
      await new Promise(done => closed.close(done));
      writeFileSync(join(home, '.npmrc'), `@cotal-ai:registry=http://127.0.0.1:${port}/\n`);
    }
    // The real npm archive reads, global install and target reconcile child must
    // receive writable scratch even when the caller's TMPDIR cannot be used.
    if (scenario === 'reset') env.TMPDIR = join(root, 'missing-temp');
    const configuredCache = join(root, 'configured-cache');
    if (scenario === 'cache') {
      delete env.npm_config_cache;
      mkdirSync(configuredCache, { mode: 0o500 });
      writeFileSync(join(home, '.npmrc'), `cache=${configuredCache}\n`);
    }
    if (scenario === 'cache' || closureKilled || closureNoSpace) {
      const extensions = join(root, 'config/cotal/extensions');
      mkdirSync(extensions, { recursive: true });
      writeFileSync(join(extensions, 'extensions.json'), JSON.stringify({ extensions: [{ pkg: extension, version: previous, spec: `${extension}@${previous}`, provides: [], commands: [] }] }));
    }
    const originalPath = env.PATH;
    if (closureNoSpace) {
      const tools = join(root, 'tools');
      mkdirSync(tools, { mode: 0o700 });
      writeFileSync(join(tools, 'npm'), `#!/bin/sh
set -eu
export PATH="$COTAL_SMOKE_REAL_NPM_PATH"
if [ "\${1:-}" = install ] && [ "\${2:-}" = --prefix ]; then
  case "$3" in */cotal-closure-check-*)
    exec unshare -Urm sh -ec 'mount -t tmpfs -o size=2m,mode=0700,nosuid,nodev tmpfs "$3"; exec npm "$@"' closure-check "$@"
  ;; esac
fi
exec npm "$@"
`, { mode: 0o700 });
      env.COTAL_SMOKE_REAL_NPM_PATH = originalPath;
      env.PATH = `${tools}:${originalPath}`;
    }
    const filterConfig = scenario === 'before' ? 'before=2020-01-01\n' : 'min-release-age=365\n';
    if (dateFiltered) writeFileSync(join(home, '.npmrc'), filterConfig);
    const started = Date.now();
    let abandonedCache, unrecordedCache;
    if (scenario === 'archive-interrupted') {
      const scratch = join(root, 'tmp');
      unrecordedCache = mkdtempSync(join(scratch, 'cotal-release-check-'));
      abandoned = run(process.execPath, [entry, 'update', '--self'], 60000);
      const updater = interrupted;
      const deadline = Date.now() + 30000;
      while (!heldArchive && updater.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      assert(heldArchive, 'the archive check reached the real npm download');
      const outer = readdirSync(scratch).find(name => name.startsWith('cotal-update-'));
      assert(outer, 'the running updater made private scratch');
      const cache = readdirSync(join(scratch, outer)).find(name => name.startsWith('cotal-release-check-'));
      assert(cache, 'the running updater made a release archive cache');
      abandonedCache = join(scratch, outer, cache);
      const workers = readdirSync(abandonedCache).filter(name => name.startsWith('.worker-'));
      assert(workers.length > 0, 'the real npm worker has recorded custody');
      pausedArchive = Number(workers.find(name => {
        const pid = name.slice('.worker-'.length);
        try { return /npm cache add|\0cache\0add\0/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
      })?.slice('.worker-'.length));
      assert(Number.isSafeInteger(pausedArchive), 'found the npm archive downloader');
      process.kill(pausedArchive, 'SIGSTOP');
      const exited = new Promise(done => updater.once('exit', (_code, signal) => done(signal)));
      updater.kill('SIGHUP');
      assert.equal(await exited, 'SIGHUP');
      const whileActive = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(whileActive.code, 0, whileActive.output);
      assert(existsSync(abandonedCache), 'retry leaves the surviving npm worker cache alone');
      heldArchive.end(archives.get(target));
      process.kill(pausedArchive, 'SIGCONT');
      pausedArchive = undefined;
      const gone = () => workers.every(name => {
        const pid = name.slice('.worker-'.length);
        const path = `/proc/${pid}/stat`;
        if (!existsSync(path)) return true;
        try { const stat = readFileSync(path, 'utf8'); return /^[ZX] /.test(stat.slice(stat.lastIndexOf(') ') + 2)); }
        catch (error) { return error.code === 'ENOENT'; }
      });
      const settled = Date.now() + 10000;
      while (!gone() && Date.now() < settled) await new Promise(done => setTimeout(done, 25));
      assert(gone(), 'the interrupted update archive workers exited');
    }
    if (scenario === 'orphan') {
      const first = run(process.execPath, [entry, 'update', '--self'], 60000);
      const updater = interrupted;
      const deadline = Date.now() + 30000;
      let record;
      while (Date.now() < deadline && updater.exitCode === null) {
        record = readMarker();
        if (record?.phase === 'live' && record.operation === 'global install') break;
        await new Promise(done => setTimeout(done, 5));
      }
      assert.equal(record?.phase, 'live', 'the actual updater published its install child');
      abandoned = first;
      orphan = record.pid;
      process.kill(record.pid, 'SIGSTOP');
      updater.kill('SIGKILL');
      if (updater.signalCode === null) await new Promise(done => updater.once('exit', done));
      process.kill(record.pid, 0);
      console.log(`killed updater ${updater.pid}; install child ${record.pid} survives`);
      setTimeout(() => { try { process.kill(record.pid, 'SIGCONT'); } catch {} }, 5000);
      // Do not await close: the detached npm child still owns the parent's output pipes.
      first.catch(() => {});
    }
    if (scenario === 'pending' || scenario === 'reconcile-killed') {
      const pending = scenario === 'pending';
      const preload = join(root, 'pause.cjs');
      // Stop after spawn returned but before the parent could publish or authorize the child.
      if (pending) writeFileSync(preload, `const fs = require('node:fs'); const cp = require('node:child_process'); const spawn = cp.spawn; cp.spawn = (...args) => { const child = spawn(...args); const marker = ${JSON.stringify(marker)}; if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).phase === 'pending') process.kill(process.pid, 'SIGSTOP'); return child; }; require('node:module').syncBuiltinESMExports();`);
      // Archive preflight and npm installation must finish before the interruption window opens.
      const first = run(process.execPath, [...(pending ? ['--require', preload] : []), entry, 'update', '--self'], 120000);
      const updater = interrupted;
      abandoned = first;
      const deadline = Date.now() + 90000;
      let record;
      while (Date.now() < deadline && updater.exitCode === null && updater.signalCode === null) {
        const row = readMarker();
        if (row?.owner === updater.pid && (pending
          ? row.phase === 'pending' && /^State:\s*T/m.test(readFileSync(`/proc/${updater.pid}/status`, 'utf8'))
          : row.phase === 'live' && row.operation === 'global reconcile' && existsSync(ready) && +readFileSync(ready, 'utf8') === row.pid)) {
          record = row;
          break;
        }
        await new Promise(done => setTimeout(done, 5));
      }
      if (!record) {
        if (updater.exitCode === null && updater.signalCode === null) updater.kill('SIGKILL');
        const result = await first;
        assert.fail(`the real updater did not reach the ${scenario} interruption window (exit ${result.code}, signal ${result.signal}):\n${result.output}`);
      }
      if (pending) {
        assert.equal(record.pid, undefined);
        const children = readFileSync(`/proc/${updater.pid}/task/${updater.pid}/children`, 'utf8').trim();
        assert.match(children, /^[1-9]\d*$/, 'exactly one direct child is waiting for publication');
        assert.equal(readFileSync(`/proc/${children}/cmdline`, 'utf8').split('\0')[0], '/bin/sh');
        updater.kill('SIGKILL');
        assert.equal((await first).signal, 'SIGKILL');
        assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, previous, 'the unauthorized child did not replace npm packages');
      } else {
        assert.deepEqual(readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1), [join(packageRoot, 'dist/cotal.js'), 'update']);
        process.kill(record.pid, 'SIGKILL');
        const result = await first;
        assert.equal(result.code, 1, result.output);
        const evidence = JSON.parse(readFileSync(marker, 'utf8'));
        assert.equal(evidence.phase, 'ambiguous');
        assert.equal(evidence.custody?.pid, record.pid);
        assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
      }
      assert.throws(() => process.kill(record.owner, 0), { code: 'ESRCH' });
    }
    const updates = await Promise.all(Array.from({ length: scenario === 'concurrent' ? 2 : 1 }, () => run(process.execPath, [entry, 'update', '--self'], 660000)));
    const update = updates[0];
    if (abandoned) await abandoned;
    const waitLine = "Waiting for another updater to release npm's global root";
    for (const result of updates) assert.doesNotMatch(result.output, /Reserving npm's global root/);
    if (scenario === 'concurrent') {
      for (const result of updates) assert.equal(result.code, 0, result.output);
      assert.equal(updates.filter(result => /installed globally and reconciled/.test(result.output)).length, 1, 'only one updater replaces the global package');
      assert(updates.some(result => /rechecking the installed CLI/.test(result.output)), JSON.stringify(updates));
      const installer = updates.find(result => /installed globally and reconciled/.test(result.output));
      const waiter = updates.find(result => /rechecking the installed CLI/.test(result.output));
      assert(!installer.output.includes(waitLine), installer.output);
      assert.equal(waiter.output.split(waitLine).length - 1, 1, waiter.output);
    } else {
      assert(!update.output.includes(waitLine), update.output);
    }
    const elapsedMs = Date.now() - started;
    const selected = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    if (closureKilled) {
      assert.equal(closureSignal, 'SIGKILL', `the real dependency-check child was killed: ${update.output}`);
      assert.equal(update.code, 1, update.output);
      assert.match(update.output, /npm dependency check was terminated by SIGKILL/);
      assert.match(update.output, /No installed packages were replaced\. Run `cotal update --self` again\./);
      assert.doesNotMatch(update.output, /registry access failed|still reaching the registry|again in a few minutes/);
    } else if (closureNoSpace) {
      assert.equal(update.code, 1, update.output);
      assert.match(update.output, /installed extension dependency closure is unavailable:[\s\S]*npm error code ENOSPC/);
      assert.match(update.output, /No global install was attempted\. Free space on the temporary filesystem, then run `cotal update --self` again\./);
      assert.doesNotMatch(update.output, /registry access|still reaching the registry|again in a few minutes/);
    } else if (scenario === 'closed-scope') {
      assert.equal(update.code, 1, update.output);
      assert.match(update.output, /metadata for @cotal-ai\/cli@99\.0\.0 is unavailable.*ECONNREFUSED/);
      assert.match(update.output, /@cotal-ai:registry.*\.npmrc/);
      assert.doesNotMatch(update.output, /still reaching|in a few minutes|Waiting for cotal-ai/);
      assert(elapsedMs < 60000, `registry failure does not enter the propagation wait: ${elapsedMs}`);
    } else if (dateFiltered) {
      assert.equal(update.code, 1, update.output);
      assert(elapsedMs < 60000, `date exclusions must not wait for propagation: ${elapsedMs}`);
      assert.match(update.output, /min-release-age.*before/);
      assert.doesNotMatch(update.output, /Waiting for cotal-ai|Keeping cotal-ai|still reaching the registry|again in a few minutes/);
      assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), filterConfig);
      assert.equal(missing, 0, 'npm excludes the release before downloading its archive');
    } else if (offline) {
      console.log(JSON.stringify({ scenario, ...update, elapsedMs }));
      assert(disconnected, 'registry connectivity was cut after the selected update progress');
      assert.equal(update.code, 0, update.output);
      assert.match(update.output, /The registry cannot be reached; nothing was changed\./);
      assert.doesNotMatch(update.output, /npm error|update preflight failed|still reaching|staged pre-install check refused/);
    } else if (scenario === 'concurrent') {
      assert.equal(selected, target);
    } else if (scenario === 'integrity') {
      assert.equal(update.code, 1, update.output);
      assert.doesNotMatch(update.output, /Waiting for cotal-ai|Keeping cotal-ai/);
    } else {
      assert.equal(update.code, 0, update.output);
      if (!['reset', 'cache', 'archive-interrupted', 'orphan', 'pending', 'reconcile-killed'].includes(scenario)) assert.match(update.output, /Waiting for cotal-ai@99\.0\.0 release archives/);
      if (scenario === 'cache') {
        assert.equal(selected, target, update.output);
        assert.match(update.output, /installed globally and reconciled/);
        assert.doesNotMatch(update.output, /EACCES|sudo chown|root-owned files/);
        assert.equal(statSync(configuredCache).mode & 0o777, 0o500);
        assert.deepEqual(readdirSync(configuredCache), []);
        assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), `cache=${configuredCache}\n`);
        assert.deepEqual(readdirSync(join(root, 'tmp')).filter(name => name.startsWith('cotal-')), [], 'all private update caches and closure staging are removed');
        assert(requests.some(request => decodeURIComponent(request.path).startsWith(`/${extension}`)), 'the installed extension closure was downloaded');
      } else if (scenario === 'archive-interrupted') {
        assert.equal(selected, target, update.output);
        assert.equal(existsSync(abandonedCache), false, 'retry removes the recorded orphan cache');
        assert(existsSync(unrecordedCache), 'retry does not infer custody from a directory name');
      } else if (['orphan', 'pending', 'reconcile-killed'].includes(scenario)) {
        assert.equal(selected, target, update.output);
        assert.match(update.output, /installed globally and reconciled/);
        assert.equal(existsSync(join(prefix, 'lib/node_modules/.cotal-update-child')), false);
      } else if (scenario === 'reset') {
        assert.equal(selected, target);
        assert.match(update.output, /installed globally and reconciled/);
        assert.match(update.output, /fixture reconciled with writable temporary directory/);
        assert.equal(existsSync(env.TMPDIR), false, 'update does not create the unavailable caller TMPDIR');
        assert(missing >= 2 && elapsedMs < 60000, `bounded transient retry: ${elapsedMs}`);
      } else if (scenario === 'arrives') {
        assert.equal(selected, target);
        assert.match(update.output, /installed globally and reconciled/);
        assert(elapsedMs >= 15000 && missing >= 2);
      } else {
        assert.match(update.output, /Keeping cotal-ai@/);
        assert(elapsedMs >= 600000 && elapsedMs < 660000, `real wait bound: ${elapsedMs}`);
      }
    }
    if (!['arrives', 'reset', 'cache', 'archive-interrupted', 'orphan', 'pending', 'reconcile-killed', 'concurrent'].includes(scenario)) {
      assert.equal(selected, previous);
      assert.deepEqual(readFileSync(join(packageRoot, 'dist/cotal.js')), before);
      assert.equal(readFileSync(join(packageRoot, 'preserve'), 'utf8'), 'unchanged');
    }
    if (scenario === 'closed-scope') {
      rmSync(join(home, '.npmrc'));
      armed = false;
      const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 0, retry.output);
      assert.match(retry.output, /installed globally and reconciled/);
      assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, target);
    }
    const recovery = join(root, 'cotal/update-recovery.json');
    assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, 'utf8')) : null, null);
    let retry;
    if (dateFiltered || closureKilled || closureNoSpace) {
      if (dateFiltered) writeFileSync(join(home, '.npmrc'), '');
      if (closureNoSpace) env.PATH = originalPath;
      retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 0, retry.output);
      assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, target);
      assert.match(retry.output, /installed globally and reconciled/);
    }
    if (offline && scenario !== 'offline-staging' && scenario !== 'offline-closure') {
      disconnected = armed = false;
      const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 0, retry.output);
      assert.match(retry.output, /installed globally and reconciled/);
      assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, target);
    }
    return { scenario, code: update.code, ...(scenario === 'concurrent' ? { updates } : {}), elapsedMs, selected, missing, requests, output: update.output, ...(retry ? { retry } : {}) };
  } finally {
    heldArchive?.end();
    if (pausedArchive) { try { process.kill(pausedArchive, 'SIGCONT'); } catch {} }
    if (orphan) { try { process.kill(orphan, 'SIGCONT'); } catch {} }
    if (interrupted?.exitCode === null && interrupted?.signalCode === null) interrupted.kill('SIGKILL');
    if (abandoned) await abandoned.catch(() => {});
    await new Promise(done => server.close(done));
    if (existsSync(join(root, 'configured-cache'))) chmodSync(join(root, 'configured-cache'), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'closure-mount-probe-'));
  let canMount;
  try {
    canMount = process.platform === 'linux' && spawnSync('unshare', ['-Urm', 'mount', '-t', 'tmpfs', '-o', 'size=2m', 'tmpfs', mountPoint]).status === 0;
  } finally { rmSync(mountPoint, { recursive: true }); }
  const selected = process.argv[2] ? [process.argv[2]] : ['arrives', 'unavailable', 'integrity', 'reset', 'cache', 'orphan', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging', 'concurrent', ...(process.platform === 'linux' ? ['archive-interrupted', 'closure-killed', 'pending', 'reconcile-killed'] : []), ...(canMount ? ['closure-nospace'] : [])];
  for (const scenario of selected) console.log(JSON.stringify(await registryArrivalCell({ scenario })));
  emitSentinel({ passed: selected.length, failed: 0 });
}
