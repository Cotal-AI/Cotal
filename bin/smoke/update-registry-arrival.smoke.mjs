import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitSentinel } from './sentinel.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Runs real npm and the built public entry against a registry with a listed, initially missing archive. */
export async function registryArrivalCell({ scenario, entry = join(repo, 'bin/dist/cotal.js'), parent = tmpdir() }) {
  assert(['arrives', 'unavailable', 'integrity', 'reset', 'orphan', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging'].includes(scenario));
  const dateFiltered = scenario === 'min-release-age' || scenario === 'before';
  const offline = scenario.startsWith('offline-');
  const root = mkdtempSync(join(parent, 'registry-arrival-'));
  const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
  const target = '99.0.0', archives = new Map(), requests = [];
  const prefix = join(root, 'prefix'), home = join(root, 'home');
  for (const name of ['home', 'cotal', 'config', 'tmp', 'runtime', 'prefix', '.cotal', 'payload/package/dist']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  for (const version of [previous, target]) {
    writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' } }));
    writeFileSync(join(root, 'payload/package/dist/cotal.js'), '#!/usr/bin/env node\nconsole.log("fixture reconciled");\n', { mode: 0o755 });
    const packed = spawnSync('tar', ['-czf', join(root, `${version}.tgz`), '-C', join(root, 'payload'), 'package']);
    assert.equal(packed.status, 0);
    archives.set(version, readFileSync(join(root, `${version}.tgz`)));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COTAL_') && !['npm_config_before', 'NPM_CONFIG_BEFORE'].includes(name)));
  Object.assign(env, { HOME: home, COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'), XDG_RUNTIME_DIR: join(root, 'runtime'), npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });
  let origin, armed = false, disconnected = false, missing = 0;
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
        if (scenario === 'reset' && missing === 1) return request.socket.destroy();
        if (scenario === 'unavailable' || scenario === 'arrives' && missing === 1) return response.writeHead(404).end('archive is propagating');
        if (scenario === 'integrity') return response.end(Buffer.from('corrupt archive'));
      }
      return response.end(archives.get(version));
    }
    const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, { name: 'cotal-ai', version, ...(armed && scenario === 'closed-scope' ? { dependencies: { '@cotal-ai/cli': version } } : {}), bin: { cotal: 'dist/cotal.js' }, dist: { tarball: `${origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: target }, versions, time: { [previous]: '2019-01-01T00:00:00.000Z', [target]: new Date().toISOString() } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.npm_config_registry = origin;
  let interrupted, orphan, abandoned;
  const run = async (file, args, timeoutMs) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
      const progress = { 'offline-metadata': 'release archives', 'offline-closure': 'Checking installed extension dependencies', 'offline-staging': 'beside the running version' }[scenario];
      if (armed && progress && output.includes(progress)) disconnected = true;
    });
    child.stderr.on('data', bytes => output += bytes);
    interrupted = child;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      return { code, output };
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
    const filterConfig = scenario === 'before' ? 'before=2020-01-01\n' : 'min-release-age=365\n';
    if (dateFiltered) writeFileSync(join(home, '.npmrc'), filterConfig);
    const started = Date.now();
    if (scenario === 'orphan') {
      const first = run(process.execPath, [entry, 'update', '--self'], 60000);
      const updater = interrupted;
      const marker = join(prefix, 'lib/node_modules/.cotal-update-child');
      const deadline = Date.now() + 30000;
      let record;
      while (Date.now() < deadline && updater.exitCode === null) {
        if (existsSync(marker)) {
          record = JSON.parse(readFileSync(marker, 'utf8'));
          if (record.phase === 'live' && record.operation === 'global install') break;
        }
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
    const update = await run(process.execPath, [entry, 'update', '--self'], 660000);
    if (abandoned) await abandoned;
    const elapsedMs = Date.now() - started;
    const selected = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    if (scenario === 'closed-scope') {
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
      assert.doesNotMatch(update.output, /npm error|release is not ready|still reaching|staged pre-install check refused/);
    } else if (scenario === 'integrity') {
      assert.equal(update.code, 1, update.output);
      assert.doesNotMatch(update.output, /Waiting for cotal-ai|Keeping cotal-ai/);
    } else {
      assert.equal(update.code, 0, update.output);
      if (scenario !== 'reset' && scenario !== 'orphan') assert.match(update.output, /Waiting for cotal-ai@99\.0\.0 release archives/);
      if (scenario === 'orphan') {
        assert.equal(selected, target, update.output);
        assert.match(update.output, /installed globally and reconciled/);
        assert.equal(existsSync(join(prefix, 'lib/node_modules/.cotal-update-child')), false);
      } else if (scenario === 'reset') {
        assert.equal(selected, target);
        assert.match(update.output, /installed globally and reconciled/);
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
    if (scenario !== 'arrives' && scenario !== 'reset' && scenario !== 'orphan') {
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
    if (dateFiltered) {
      writeFileSync(join(home, '.npmrc'), '');
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
    return { scenario, code: update.code, elapsedMs, selected, missing, requests, output: update.output, ...(retry ? { retry } : {}) };
  } finally {
    if (orphan) { try { process.kill(orphan, 'SIGCONT'); } catch {} }
    if (abandoned) await abandoned.catch(() => {});
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const selected = process.argv[2] ? [process.argv[2]] : ['arrives', 'unavailable', 'integrity', 'reset', 'orphan', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging'];
  for (const scenario of selected) console.log(JSON.stringify(await registryArrivalCell({ scenario })));
  emitSentinel({ passed: selected.length, failed: 0 });
}
