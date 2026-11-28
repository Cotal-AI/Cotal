import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, cpSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitSentinel } from './sentinel.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^cotal_/i.test(name)));

function reconciliationScratch(parent, worker) {
  const old = new Date(Date.now() - 61 * 60_000);
  const fixture = shape => {
    const outer = mkdtempSync(join(parent, 'cotal-update-'));
    const cache = join(outer, 'node-compile-cache');
    const version = join(cache, 'v24');
    const compiled = join(version, 'compiled');
    mkdirSync(cache, { mode: 0o700 });
    mkdirSync(version, { mode: 0o700 });
    writeFileSync(compiled, 'cache');
    if (shape === 'link') {
      const link = join(outer, 'cotal-update-npm-linked');
      symlinkSync(cache, link);
      lutimesSync(link, old, old);
    } else if (shape !== 'compile-only' && shape !== 'fresh-deep') {
      const recorded = ['dead', 'live', 'pending', 'fresh-recorded'].includes(shape);
      const npm = mkdtempSync(join(outer, recorded ? 'cotal-update-reconcile-' : 'cotal-update-npm-'));
      if (recorded) {
        writeFileSync(join(npm, '.owner'), '2147483647\nexpired\n', { mode: 0o600 });
        if (shape !== 'pending') writeFileSync(join(npm, `.worker-${shape === 'live' ? worker : 2147483647}`), '', { mode: 0o600 });
      }
      if (shape === 'nonempty') writeFileSync(join(npm, '.keep'), 'other content');
      if (shape === 'shared') chmodSync(npm, 0o750);
      if (shape === 'mixed') writeFileSync(join(outer, 'keep'), 'other content');
      if (shape !== 'recent') utimesSync(npm, old, old);
    }
    for (const path of [compiled, version, cache, outer]) utimesSync(path, old, old);
    if (shape === 'fresh-deep' || shape === 'fresh-recorded') writeFileSync(compiled, 'recent in-place rewrite');
    return outer;
  };
  const expired = ['compile-only', ...(worker ? ['dead'] : [])].map(fixture);
  const retained = ['empty', 'fresh-deep', ...(process.getuid ? ['nonempty', 'shared', 'link', 'mixed', 'recent'] : []),
    ...(worker ? ['pending', 'fresh-recorded'] : [])]
    .map(fixture).map(path => [path, readdirSync(path, { recursive: true }).sort()]);
  return { expired, retained, live: worker && fixture('live') };
}

function lifecycleRuntime(root, payload) {
  const tools = join(root, 'lifecycle tools');
  mkdirSync(tools);
  const npm = spawnSync('/bin/sh', ['-c', 'command -v npm'], { env: childEnv, encoding: 'utf8' });
  assert.equal(npm.status, 0, npm.stderr);
  symlinkSync(realpathSync(npm.stdout.trim()), join(tools, 'npm'));
  const node = join(tools, `node-${process.versions.node}`);
  cpSync(realpathSync(process.execPath), node);
  const scripts = join(payload, 'scripts');
  mkdirSync(scripts);
  cpSync(join(repo, 'bin/scripts/pin-npm-node.cjs'), join(scripts, 'pin-npm-node.cjs'));
  const { engines, scripts: { postinstall } } = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8'));
  symlinkSync('/bin/sh', join(tools, 'sh'));
  assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: tools } }).status, 0);
  return { node, path: tools, manifest: { engines, scripts: { postinstall }, hasInstallScript: true } };
}

async function assertLifecycleExtension(run, { node }, entry, root) {
  const source = join(root, 'lifecycle-extension');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'lifecycle-extension', version: '1.0.0',
    main: 'index.mjs', peerDependencies: { '@cotal-ai/core': '*' }, scripts: { postinstall: 'node install.cjs' } }));
  writeFileSync(join(source, 'index.mjs'), `import { registry } from '@cotal-ai/core';\nregistry.register({ kind: 'command', name: 'lifecycle-test', group: 'Extensions', summary: 'Lifecycle fixture', flags: [], run: async () => {} });\n`);
  writeFileSync(join(source, 'install.cjs'), `require('node:fs').writeFileSync('node-path', process.execPath);\n`);
  const result = await run(node, [entry, 'ext', 'add', source], 60000);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /lifecycle-test/);
  assert.equal(readFileSync(join(root, 'config/cotal/extensions/node_modules/lifecycle-extension/node-path'), 'utf8'), node);
}

/** Runs real npm and the built public entry against a loopback registry. */
export async function registryArrivalCell({ scenario, entry = join(repo, 'bin/dist/cotal.js'), parent = tmpdir() }) {
  if (scenario === 'corepack-node-fallback') return corepackNodeFallbackCell(entry, parent);
  const versionNamedNode = scenario === 'version-named-node';
  const reconcileOrphan = scenario === 'reconcile-orphan';
  const reconcileInterrupted = reconcileOrphan || scenario === 'reconcile-killed';
  const stagingFetchTimeout = scenario === 'staging-fetch-timeout';
  const stagingNetwork = stagingFetchTimeout || ['staging-partial', 'staging-no-accept', 'staging-trickle', 'staging-auto'].includes(scenario);
  const stagingTimeout = scenario === 'staging-timeout';
  const noAccept = ['staging-no-accept', 'staging-auto'].includes(scenario);
  const stagingRefused = scenario === 'staging-refused';
  const configAccess = scenario === 'config-access-upgrade' || scenario === 'config-access-auto';
  const unprotectedConfig = scenario === 'config-unprotected' || scenario === 'config-unprotected-auto';
  const repairSelection = scenario === 'selection-upgrade' || scenario === 'selection-rollback';
  const extensionMissing = scenario === 'extension-arrives' || scenario === 'extension-unavailable';
  assert(versionNamedNode || repairSelection || configAccess || unprotectedConfig || stagingNetwork || stagingTimeout || stagingRefused || extensionMissing || reconcileInterrupted || ['arrives', 'unavailable', 'integrity', 'reset', 'cache', 'archive-interrupted', 'closure-killed', 'closure-nospace', 'orphan', 'pending', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging', 'staging-killed', 'concurrent', 'extension-peers', 'corepack'].includes(scenario));
  const dateFiltered = scenario === 'min-release-age' || scenario === 'before';
  const closureKilled = scenario === 'closure-killed';
  const closureNoSpace = scenario === 'closure-nospace';
  const offline = scenario.startsWith('offline-');
  const temporary = mkdtempSync(join(parent, 'registry-arrival-'));
  const root = versionNamedNode ? realpathSync(temporary) : temporary;
  const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
  const target = '99.0.0', archives = new Map(), requests = [];
  const extension = extensionMissing ? '@cotal-ai/connector-hermes' : '@cotal-ai/cache-fixture';
  const extensionPeers = scenario === 'extension-peers' || extensionMissing;
  const newer = '100.0.0';
  const hostPeers = ['@cotal-ai/core', '@cotal-ai/workspace'];
  const peerArchives = new Map();
  const cliDependencies = version => extensionPeers && version === target
    ? { dependencies: Object.fromEntries(hostPeers.map(peer => [peer, target])) } : {};
  const prefix = join(root, 'prefix'), home = join(root, 'home');
  const marker = join(prefix, 'lib/node_modules/.cotal-update-child');
  const ready = join(root, 'reconcile.pid');
  const releaseReconcile = join(root, 'reconcile-release');
  function readMarker() {
    try { return JSON.parse(readFileSync(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of ['home', 'cotal', 'config', 'tmp', 'runtime', 'prefix', '.cotal', 'payload/package/dist']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const lifecycle = versionNamedNode ? lifecycleRuntime(root, join(root, 'payload/package')) : undefined;
  const staged = scenario === 'staging-killed' || stagingNetwork || stagingTimeout || stagingRefused || repairSelection || configAccess || unprotectedConfig;
  const preinstall = { v: 1, entry: 'dist/preinstall.js' };
  if (closureNoSpace) writeFileSync(join(root, 'payload/package/dist/data'), Buffer.alloc(4 * 1024 * 1024));
  if (stagingNetwork) writeFileSync(join(root, 'payload/package/dist/data'), randomBytes(1024 * 1024));
  for (const version of [previous, target]) {
    writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' }, ...(staged ? { cotalPreinstall: preinstall } : {}), ...cliDependencies(version), ...lifecycle?.manifest }));
    const contention = scenario === 'concurrent'
      ? `if (process.argv.includes('update')) { const deadline = Date.now() + 30000; while (!existsSync(${JSON.stringify(join(root, 'waiter-observed'))})) { if (Date.now() >= deadline) throw new Error('competing updater did not reach the reservation'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } }\n`
      : '';
    const hold = reconcileInterrupted && version === target ? `if (process.argv[2] === 'update' && !existsSync(${JSON.stringify(ready)})) { writeFileSync(${JSON.stringify(ready)}, String(process.pid)); ${reconcileOrphan ? `const deadline = Date.now() + 60000; const timer = setInterval(() => { if (existsSync(${JSON.stringify(releaseReconcile)}) || Date.now() >= deadline) clearInterval(timer); }, 20);` : 'setTimeout(() => process.exit(99), 60000);'} }\n` : '';
    writeFileSync(join(root, 'payload/package/dist/cotal.js'), `#!/usr/bin/env node\nimport { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n${contention}${hold}const scratch = mkdtempSync(join(tmpdir(), "reconcile-child-"));\nrmSync(scratch, { recursive: true });\nconsole.log("fixture reconciled with writable temporary directory");\n`, { mode: 0o755 });
    if (staged) {
      const fail = (scenario === 'selection-rollback' || unprotectedConfig) && version === target
        ? `if (process.argv.includes('update')) { console.error('fixture reconciliation failed'); process.exit(7); }\n` : '';
      writeFileSync(join(root, 'payload/package/dist/cotal.js'), `#!/usr/bin/env node\n${fail}console.log('cotal-ai ${version}');\n`, { mode: 0o755 });
      writeFileSync(join(root, 'payload/package/dist/cotal-program.js'), `${fail}console.log('cotal-ai ${version}');\n`);
      writeFileSync(join(root, 'payload/package/dist/preinstall.js'), `const { nonce, installedEntry } = JSON.parse(process.argv[2]); console.log('COTAL_PREINSTALL_RESULT ' + JSON.stringify({ v: 1, nonce, installedEntry, hostedSpaces: [], occupied: 0, admission: { disposition: 'restart-empty', occupied: 0, hostedSpaces: [] } }));\n`);
    }
    const packed = spawnSync('tar', ['-czf', join(root, `${version}.tgz`), '-C', join(root, 'payload'), 'package'], { env: childEnv });
    assert.equal(packed.status, 0);
    archives.set(version, readFileSync(join(root, `${version}.tgz`)));
  }
  if (extensionPeers) {
    mkdirSync(join(root, 'peer-payload/package'), { recursive: true });
    for (const name of [extension, ...hostPeers]) {
      const manifest = { name, version: target, ...(name === extension
        ? { peerDependencies: Object.fromEntries(hostPeers.map(peer => [peer, '*'])) } : {}) };
      writeFileSync(join(root, 'peer-payload/package/package.json'), JSON.stringify(manifest));
      const archive = join(root, `${name.split('/')[1]}.tgz`);
      assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'peer-payload'), 'package'], { env: childEnv }).status, 0);
      peerArchives.set(name, { manifest, bytes: readFileSync(archive) });
    }
  }
  const hermesManifest = { name: extension, version: previous };
  let hermesArchive;
  if (extensionMissing) {
    writeFileSync(join(root, 'peer-payload/package/package.json'), JSON.stringify(hermesManifest));
    const archive = join(root, 'hermes-previous.tgz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'peer-payload'), 'package'], { env: childEnv }).status, 0);
    hermesArchive = readFileSync(archive);
  }
  const env = lifecycle ? { PATH: childEnv.PATH } : Object.fromEntries(Object.entries(childEnv).filter(([name]) =>
    !/^npm_config_(?:before|offline)$/i.test(name) && !(stagingFetchTimeout && /^npm_config_(?:prefix|registry)$/i.test(name))));
  Object.assign(env, { HOME: home, COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'), XDG_RUNTIME_DIR: join(root, 'runtime'), npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });
  let origin, armed = false, disconnected = false, missing = 0, heldArchive, closureSignal, holdStaging = scenario === 'staging-killed';
  let hermesAvailable = false, installedAtWait, originalInstallation;
  const installedFiles = [join(prefix, 'lib/node_modules/cotal-ai/dist/cotal.js'),
    join(root, 'config/cotal/extensions/extensions.json'),
    join(root, 'config/cotal/extensions/node_modules', extension, 'package.json')];
  const readInstallation = () => installedFiles.map(path => readFileSync(path, 'utf8'));
  let blackhole, blockedPort, networkChild, networkStarted, trickle, cacheWorker;
  let stagingDenied = false;
  let invalidStagingMetadata = true;
  const backlog = [];
  const server = createServer((request, response) => {
    requests.push({ at: Date.now(), path: request.url });
    if (disconnected || armed && scenario === 'offline-archive' && request.url?.endsWith(`/${target}.tgz`)) {
      disconnected = true;
      return request.socket.destroy();
    }
    const path = decodeURIComponent(request.url?.split('?')[0] ?? '');
    if (armed && stagingNetwork) {
      const record = readMarker();
      if (record?.phase === 'live' && record.operation === 'global install') {
        if (stagingFetchTimeout && path === '/cotal-ai') {
          if (invalidStagingMetadata) return response.writeHead(200, { 'content-type': 'application/json' }).end('{');
          networkChild ??= record.pid;
          networkStarted ??= Date.now();
          return;
        }
        if (path === (noAccept ? '/cotal-ai' : `/${target}.tgz`)) {
          networkChild ??= record.pid;
          networkStarted ??= Date.now();
        }
        if (!noAccept && path === `/${target}.tgz`) {
          const bytes = archives.get(target);
          response.writeHead(200, { 'content-length': bytes.length }).write(bytes.subarray(0, 4096));
          if (scenario === 'staging-trickle') {
            let offset = 4096;
            trickle = setInterval(() => {
              const next = offset + 140_000;
              response.write(bytes.subarray(offset, next));
              offset = next;
              if (offset >= bytes.length) response.end();
            }, 8000);
            response.once('close', () => clearInterval(trickle));
          }
          return;
        }
      }
    }
    if (extensionPeers) {
      const [name, archiveVersion] = path.slice(1).split('/-/');
      const archive = peerArchives.get(name);
      if (archive) {
        if (hermesArchive && name === extension) {
          if (archiveVersion === `${previous}.tgz`) return response.end(hermesArchive);
          if (!hermesAvailable) {
            missing++;
            response.setHeader('content-type', 'application/json');
            return response.end(JSON.stringify({ name, 'dist-tags': { latest: previous }, versions: { [previous]: { ...hermesManifest, dist: {
              tarball: `${origin}/${name}/-/${previous}.tgz`, integrity: `sha512-${createHash('sha512').update(hermesArchive).digest('base64')}`,
            } } } }));
          }
        }
        if (archiveVersion === `${target}.tgz`) return response.end(archive.bytes);
        if (archiveVersion !== undefined) return response.writeHead(404).end('archive is propagating');
        const manifestAt = version => ({ ...archive.manifest, version, dist: {
          tarball: `${origin}/${name}/-/${version}.tgz`,
          integrity: `sha512-${createHash('sha512').update(archive.bytes).digest('base64')}`,
        } });
        const latest = name === extension ? target : newer;
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ name, 'dist-tags': { latest }, versions: {
          [target]: manifestAt(target), ...(latest === newer ? { [newer]: manifestAt(newer) } : {}),
        } }));
      }
    }
    if (request.url?.endsWith('.tgz')) {
      const version = request.url.slice(1, -4);
      if (armed && version === target) {
        missing++;
        if (stagingRefused && readMarker()?.operation === 'global install') {
          stagingDenied = true;
          return response.writeHead(403).end('target staging forbidden');
        }
        if (holdStaging && readMarker()?.operation === 'global install') { heldArchive = response; return; }
        if (scenario === 'archive-interrupted' && missing === 1) { heldArchive = response; return; }
        if (scenario === 'reset' && missing === 1) return request.socket.destroy();
        if (scenario === 'unavailable' || scenario === 'arrives' && missing === 1) return response.writeHead(404).end('archive is propagating');
        if (scenario === 'integrity') return response.end(Buffer.from('corrupt archive'));
      }
      return response.end(archives.get(version));
    }
    if (path === `/${extension}`) {
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
    const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, { name: 'cotal-ai', version, ...cliDependencies(version), ...lifecycle?.manifest, ...(armed && scenario === 'closed-scope' ? { dependencies: { '@cotal-ai/cli': version } } : {}), bin: { cotal: 'dist/cotal.js' }, dist: { tarball: `${armed && blockedPort && version === target && readMarker()?.operation === 'global install' ? `http://127.0.0.1:${blockedPort}` : origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: repairSelection && !armed ? previous : target }, versions, time: { [previous]: '2019-01-01T00:00:00.000Z', [target]: new Date().toISOString() } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.npm_config_registry = origin;
  let interrupted, orphan, abandoned, pausedArchive;
  let closureStart, closureEnd;
  let cwd = root;
  const run = async (file, args, timeoutMs) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
      if (extensionPeers) {
        if (output.includes('Checking installed extension dependencies')) closureStart ??= requests.length;
        if (output.includes('recovery archives')) closureEnd ??= requests.length;
      }
      if (extensionMissing && !installedAtWait && /Waiting for .*connector-hermes/.test(output)) {
        installedAtWait = readInstallation();
        hermesAvailable = scenario === 'extension-arrives';
      }
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
    if (scenario === 'offline-staging' || staged) {
      cpSync(join(repo, 'bin/dist'), join(packageRoot, 'dist'), { recursive: true });
      cpSync(join(repo, 'bin/package.json'), join(packageRoot, 'package.json'));
      symlinkSync(join(repo, 'bin/node_modules'), join(packageRoot, 'node_modules'), 'dir');
      entry = join(packageRoot, 'dist/cotal.js');
      // The built entry replaces the executable that npm linked in the private prefix.
      if (stagingTimeout || stagingFetchTimeout) chmodSync(entry, 0o755);
    }
    if (scenario === 'offline-closure') {
      const extensions = join(root, 'config/cotal/extensions');
      mkdirSync(extensions, { recursive: true, mode: 0o700 });
      writeFileSync(join(extensions, 'extensions.json'), JSON.stringify({ extensions: [{ pkg: '@cotal-ai/network-fixture', version: previous, spec: `@cotal-ai/network-fixture@${previous}`, commands: [] }] }));
    }
    const before = readFileSync(join(packageRoot, 'dist/cotal.js'));
    writeFileSync(join(packageRoot, 'preserve'), 'unchanged');
    armed = true;
    if (unprotectedConfig) {
      const config = env.XDG_CONFIG_HOME = join(root, 'config with space');
      const extensions = join(config, 'cotal', 'extensions');
      mkdirSync(extensions, { recursive: true, mode: 0o700 });
      const manifest = join(extensions, 'extensions.json');
      writeFileSync(manifest, 'not a trusted extension manifest');
      chmodSync(config, 0o777);
      const manual = await run(process.execPath, [entry, 'update'], 60000);
      assert.equal(manual.code, 4, manual.output);
      assert.match(manual.output, /chmod go-w/);
      const structured = await run(process.execPath, [entry, 'update', '--json'], 60000);
      assert.equal(structured.code, 4, structured.output);
      const report = JSON.parse(structured.output);
      assert.equal(report.outcome, 'partial');
      assert.equal(report.error.code, 'OPERATION_PARTIAL');
      assert.equal(report.error.message, manual.output.trim());
      assert.equal(report.result.releaseInstalled, false);
      if (scenario === 'config-unprotected-auto') {
        const now = Date.now();
        writeFileSync(join(env.COTAL_HOME, 'update-check.json'), JSON.stringify({ v: 1, latest: target, attemptedAt: now, checkedAt: now, firstSeenAt: now - 3_601_000 }));
        env.COTAL_AUTO_UPDATE = '1';
      }
      const update = await run(process.execPath, [entry, 'update', '--self'], 180000);
      assert.equal(update.code, 4, update.output);
      assert.match(update.output, /cotal-ai@99\.0\.0 installed/);
      assert.match(update.output, /connector config folder.*writable by every local account/);
      assert.ok(update.output.includes(`chmod go-w '${config}' && `));
      assert.equal(update.output.split('\n').filter(line => line.includes('chmod go-w')).length, 1);
      assert.doesNotMatch(update.output, /fixture reconciliation failed|recovery snapshot saved/);
      const version = await run(process.execPath, [entry, '--version'], 60000);
      assert.equal(version.output.trim(), `cotal-ai ${target}`);
      assert.equal(statSync(config).mode & 0o777, 0o777);
      assert.equal(readFileSync(manifest, 'utf8'), 'not a trusted extension manifest');
      assert.deepEqual(readdirSync(join(config, 'cotal')), ['extensions']);
      assert.equal(JSON.parse(readFileSync(join(env.COTAL_HOME, 'update-recovery.json'), 'utf8')), null);
      const attempt = JSON.parse(readFileSync(join(env.COTAL_HOME, 'update-attempt.json'), 'utf8'));
      assert.equal(attempt.failures, 0);
      assert.equal(attempt.connectorReconciliationPending, true);
      assert.equal(attempt.result, `installed ${target}; connector reconciliation is waiting for folder repair`);
      return { scenario, manual, update, version };
    }
    if (stagingTimeout) {
      const tools = join(root, 'staging-tools'), pidFile = join(root, 'staging.pid');
      mkdirSync(tools, { mode: 0o700 });
      writeFileSync(join(tools, 'npm'), `#!/bin/sh
if [ "$1" = install ] && [ "$3" = --prefix ]; then
  case "$4" in
    */.installing-*) printf '%s\\n' "$$" > "$SMOKE_STAGING_PID"; exec sleep 90 ;;
  esac
fi
export PATH="$SMOKE_NPM_PATH"
exec npm "$@"
`, { mode: 0o700 });
      env.SMOKE_NPM_PATH = env.PATH;
      env.SMOKE_STAGING_PID = pidFile;
      env.PATH = `${tools}:${join(prefix, 'bin')}:${env.PATH}`;
      const result = await run(process.execPath, [entry, 'update', '--self'], 90000);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert(pid > 1, result.output);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Package staging reached its time limit\. The previous version remains installed\. Run `(?:pnpm )?cotal update --self` again\./);
      assert.doesNotMatch(result.output, /registry cannot be reached|recovery snapshot/i);
      assert.equal(existsSync(marker), false);
      assert.deepEqual(readFileSync(entry), before);
      env.PATH = env.SMOKE_NPM_PATH;
      const current = await run(process.execPath, [entry, '--version'], 60000);
      assert.equal(current.output.split('\n')[0], `cotal-ai ${previous}`);
      const available = await run('npm', ['view', `cotal-ai@${target}`, 'version', '--json'], 60000);
      assert.equal(available.code, 0, available.output);
      assert.equal(JSON.parse(available.output), target);
      const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 0, retry.output);
      assert.match(retry.output, /cotal-ai@99\.0\.0 in use and reconciled/);
      return { scenario, code: result.code, output: result.output, retry };
    }
    if (stagingRefused) {
      const seed = join(env.XDG_CONFIG_HOME, 'cotal/seed/child');
      mkdirSync(seed, { recursive: true, mode: 0o700 });
      chmodSync(seed, 0o500);
      const manifestPath = join(packageRoot, 'package.json'), manifest = readFileSync(manifestPath);
      const started = Date.now();
      const result = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert(stagingDenied, result.output);
      assert.equal(result.code, 1, result.output);
      assert.equal(result.output.split('\n').filter(line => line === 'Restored owner access to the Cotal connector configuration.').length, 1, result.output);
      assert.match(result.output, /staged pre-install check refused:[\s\S]*E403[\s\S]*; no installed packages were replaced/);
      assert.doesNotMatch(result.output, /connector state were changed|nothing was changed/);
      assert.equal(statSync(seed).mode & 0o777, 0o700);
      assert.deepEqual(readFileSync(manifestPath), manifest);
      assert.deepEqual(readFileSync(entry), before);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(env.COTAL_HOME, 'update-recovery.json')), false);
      return { scenario, code: result.code, elapsedMs: Date.now() - started, selected: previous, missing, requests, output: result.output };
    }
    if (configAccess && process.getuid?.() !== 0) {
      const connectorConfig = join(env.XDG_CONFIG_HOME, 'cotal');
      const restored = 'Restored owner access to the Cotal connector configuration.';
      mkdirSync(join(connectorConfig, 'extensions'), { recursive: true, mode: 0o700 });
      chmodSync(connectorConfig, 0o500);
      assert.equal(statSync(connectorConfig).mode & 0o777, 0o500);
      const started = Date.now();
      let result;
      if (scenario === 'config-access-auto') {
        const now = Date.now();
        const attempt = join(env.COTAL_HOME, 'update-attempt.json');
        writeFileSync(attempt, JSON.stringify({ version: target, failures: 0, result: 'due', next: 0 }));
        writeFileSync(join(env.COTAL_HOME, 'update-check.json'), JSON.stringify({ v: 1, latest: target, attemptedAt: now, checkedAt: now, firstSeenAt: now - 3_601_000 }));
        const automatic = join(packageRoot, 'dist/daemon/auto-update.js');
        const autoRun = await run(process.execPath, ['--input-type=module', '-e', `
          import { automaticUpdates } from ${JSON.stringify(pathToFileURL(automatic).href)};
          globalThis[Symbol.for('cotal.execution.identity')] = Object.freeze({ logicalEntry: ${JSON.stringify(entry)}, loadedEntry: ${JSON.stringify(entry)} });
          const timer = setTimeout(() => process.exit(2), 120000);
          const updates = automaticUpdates({ version: ${JSON.stringify(previous)}, eligible: () => true, prepare: async () => {}, abort: async () => {}, report(line) { console.log(line); clearTimeout(timer); } });
          await new Promise(resolve => process.once('beforeExit', resolve));
          await updates.close();
        `], 130000);
        assert.equal(autoRun.code, 0, autoRun.output);
        assert.equal(autoRun.output.trim(), `updated to ${target}`);
        const recorded = JSON.parse(readFileSync(attempt, 'utf8'));
        assert.equal(recorded.failures, 0);
        assert.equal(recorded.result, `updated to ${target}`);
        result = { code: autoRun.code, output: readFileSync(join(env.COTAL_HOME, 'update-attempt.log'), 'utf8') };
      } else {
        result = await run(process.execPath, [entry, 'update', '--self'], 180000);
      }
      const elapsedMs = Date.now() - started;
      assert.equal(result.code, 0, result.output);
      assert.equal(statSync(connectorConfig).mode & 0o777, 0o700);
      assert.equal(result.output.split('\n').filter(line => line === restored).length, 1, result.output);
      assert.doesNotMatch(result.output, /no installed packages were replaced/);
      assert.match(result.output, /cotal-ai@99\.0\.0 in use and reconciled/);
      const version = await run(process.execPath, [entry, '--version'], 60000);
      assert.equal(version.code, 0, version.output);
      assert.equal(version.output.split('\n')[0], `cotal-ai ${target}`);
      if (scenario === 'config-access-upgrade') {
        const writableControl = await run(process.execPath, [entry, 'update', '--self'], 60000);
        assert.equal(writableControl.code, 0, writableControl.output);
        assert.doesNotMatch(writableControl.output, /Restored owner access/);
      }
      return { scenario, code: result.code, elapsedMs, selected: target, missing, requests, output: result.output };
    }
    if (repairSelection) {
      const rollback = scenario === 'selection-rollback';
      const sets = join(env.XDG_CONFIG_HOME, 'cotal/installs', createHash('sha256').update(realpathSync(entry)).digest('hex'), 'sets');
      const generation = join(sets, previous), graph = join(generation, 'cotal');
      const local = join(generation, 'selection.json'), current = join(sets, 'current.json');
      mkdirSync(join(graph, 'seed'), { recursive: true, mode: 0o700 });
      if (rollback) {
        // The legacy source has deliberately removed every built-in. A real rollback must
        // reconcile that graph without consulting archives outside this loopback registry.
        const seed = join(env.XDG_CONFIG_HOME, 'cotal/seed');
        mkdirSync(seed, { mode: 0o700 });
        const everSeeded = ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web'];
        for (const file of ['authority.json', 'authority.bak.json']) writeFileSync(join(seed, file), JSON.stringify({ everSeeded }));
        writeFileSync(join(seed, 'witness.json'), JSON.stringify({ initialized: true, firstGeneration: previous }));
        writeFileSync(join(seed, 'stamp.json'), JSON.stringify({ generation: previous }));
      }
      const corrupt = '{"v":2,"futureSelection":true}\n';
      const record = JSON.stringify({ v: 1, entry: realpathSync(entry), version: previous, root: graph });
      writeFileSync(local, corrupt, { mode: 0o400 });
      writeFileSync(current, JSON.stringify({ ...JSON.parse(record), root: generation }), { mode: 0o600 });
      armed = false;
      const noNewer = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(noNewer.code, 0, noNewer.output);
      assert.match(noNewer.output, /No newer CLI version\. No connector reconciliation was run\./);
      assert.match(noNewer.output, /connector retention selection.*unreadable.*cotal ext seed --repair/);
      assert.equal(readFileSync(local, 'utf8'), corrupt);
      armed = true;
      // Use only a damaged lineage in the rollback case, and a readable lineage in the success case.
      const unreadable = rollback ? current : local;
      if (rollback) {
        rmSync(local);
        writeFileSync(current, corrupt);
        chmodSync(current, 0o400);
      } else writeFileSync(current, record);
      const started = Date.now();
      const result = await run(process.execPath, [entry, 'update', '--self'], 180000);
      const elapsedMs = Date.now() - started;
      assert.equal(result.code, rollback ? 7 : 0, result.output);
      assert.match(result.output, /new version installed and verified/);
      const warnings = result.output.split('\n').filter(line => line.startsWith('Set aside unreadable connector selection: '));
      assert.equal(warnings.length, 1, result.output);
      const backup = JSON.parse(warnings[0].slice('Set aside unreadable connector selection: '.length));
      assert(backup.startsWith(`${unreadable}.corrupt.`), backup);
      assert.equal(readFileSync(backup, 'utf8'), corrupt);
      assert.equal(statSync(backup).mode & 0o777, 0o400);
      const selection = JSON.parse(readFileSync(current, 'utf8'));
      assert.equal(selection.v, 1);
      if (rollback) {
        assert.match(result.output, /fixture reconciliation failed/);
        assert.match(result.output, /was restored and reconciled/);
        assert.notEqual(selection.root, graph, 'an unidentified graph must not be selected');
        assert(existsSync(graph), 'an unidentified graph must not be removed');
        assert.equal(JSON.parse(readFileSync(join(selection.root, 'seed/stamp.json'), 'utf8')).generation, previous);
      } else {
        assert.equal(selection.root, graph, 'the readable lineage preserves the source graph');
        assert.match(result.output, /in use and reconciled/);
      }
      const version = await run(process.execPath, [entry, '--version'], 60000);
      assert.equal(version.code, 0, version.output);
      assert.equal(version.output.split('\n')[0], `cotal-ai ${rollback ? previous : target}`);
      assert.equal(JSON.parse(readFileSync(join(env.COTAL_HOME, 'update-recovery.json'), 'utf8')), null);
      return { scenario, code: result.code, selected: rollback ? previous : target, missing, requests, elapsedMs, output: result.output };
    }
    if (stagingNetwork) {
      const store = join(prefix, 'lib/.cotal-generations');
      const unrelated = join(store, 'unrelated');
      mkdirSync(unrelated, { recursive: true, mode: 0o700 });
      const manifest = readFileSync(join(packageRoot, 'package.json'));
      const launch = join(prefix, 'bin/cotal'), link = readlinkSync(launch);
      const connector = join(root, 'config/cotal/keep');
      mkdirSync(join(root, 'config/cotal'), { mode: 0o700 });
      writeFileSync(connector, 'connector state');
      const recovery = join(root, 'cotal/update-recovery.json');
      const resistant = join(root, 'staging-descendant.pid');
      if (scenario === 'staging-no-accept') {
        const tools = join(root, 'staging-tools');
        mkdirSync(tools, { mode: 0o700 });
        writeFileSync(join(tools, 'npm'), `#!/bin/sh
export PATH="$SMOKE_NPM_PATH"
case "$1:$4" in
  install:*/.installing-*)
    ${JSON.stringify(process.execPath)} -e 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);' "$SMOKE_STAGING_DESCENDANT" </dev/null >/dev/null 2>&1 &
    ;;
esac
exec npm "$@"
`, { mode: 0o700 });
        env.SMOKE_NPM_PATH = env.PATH;
        env.SMOKE_STAGING_DESCENDANT = resistant;
        env.PATH = `${tools}:${env.PATH}`;
      }
      if (noAccept) {
        // Stop the loopback listener before anyone connects. Fill Linux's accept queue
        // so the npm client's SYN gets no answer, unlike an intentionally refused port.
        blackhole = spawn(process.execPath, ['-e', `require('node:net').createServer().listen({host:'127.0.0.1',port:0,backlog:1}, function() { process.send(this.address().port); process.kill(process.pid,'SIGSTOP'); });`], { env: childEnv, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        blockedPort = await new Promise((resolve, reject) => { blackhole.once('message', resolve); blackhole.once('error', reject); });
        for (let i = 0; i < 2; i++) await new Promise((resolve, reject) => {
          const socket = connect(blockedPort, '127.0.0.1', resolve);
          backlog.push(socket);
          socket.once('error', reject);
        });
      }
      let result;
      if (stagingFetchTimeout) {
        env.PATH = `${join(prefix, 'bin')}:${env.PATH}`;
        const invalid = await run(process.execPath, [entry, 'update', '--self'], 60000);
        assert.equal(invalid.code, 1, invalid.output);
        assert.match(invalid.output, /staged pre-install check refused:[\s\S]*npm error code FETCH_ERROR[\s\S]*invalid json response body/);
        invalidStagingMetadata = false;
      }
      if (scenario === 'staging-auto') {
        const now = Date.now();
        const attempt = join(root, 'cotal/update-attempt.json');
        writeFileSync(attempt, JSON.stringify({ version: target, failures: 1, result: 'due', next: 0 }));
        writeFileSync(join(root, 'cotal/update-check.json'), JSON.stringify({ v: 1, latest: target, attemptedAt: now, checkedAt: now, firstSeenAt: now - 3_601_000 }));
        const automatic = join(packageRoot, 'dist/daemon/auto-update.js');
        result = await run(process.execPath, ['--input-type=module', '-e', `
          import { automaticUpdates } from ${JSON.stringify(pathToFileURL(automatic).href)};
          globalThis[Symbol.for('cotal.execution.identity')] = Object.freeze({ logicalEntry: ${JSON.stringify(entry)}, loadedEntry: ${JSON.stringify(entry)} });
          const timer = setTimeout(() => process.exit(2), 120000);
          const updates = automaticUpdates({ version: ${JSON.stringify(previous)}, eligible: () => true, prepare: async () => {}, abort: async () => {}, report(line) { console.log(line); clearTimeout(timer); } });
          await new Promise(resolve => process.once('beforeExit', resolve));
          await updates.close();
        `], 130000);
        assert.equal(result.code, 0, result.output);
        assert.equal(result.output.trim(), 'Package staging reached its time limit');
        const deferred = JSON.parse(readFileSync(attempt, 'utf8'));
        assert.equal(deferred.failures, 1);
        assert.equal(deferred.deferred, 'Package staging reached its time limit');
        assert.ok(deferred.next > Date.now() && deferred.next <= Date.now() + 3_600_000);
        result.output = readFileSync(join(root, 'cotal/update-attempt.log'), 'utf8');
      } else {
        result = await run(process.execPath, [entry, 'update', '--self'], 310000);
      }
      const elapsedMs = Date.now() - networkStarted;
      assert(networkChild, result.output);
      assert.equal(result.code, 0, result.output);
      assert.equal(existsSync(marker), false, result.output);
      assert(!readdirSync(store).some(name => name.startsWith('.installing-')));
      assert.throws(() => process.kill(networkChild, 0), { code: 'ESRCH' });
      if (scenario === 'staging-no-accept') {
        const pid = Number(readFileSync(resistant, 'utf8'));
        assert(pid > 1);
        const stat = `/proc/${pid}/stat`;
        if (existsSync(stat)) assert.match(readFileSync(stat, 'utf8').split(') ').at(-1), /^[ZX] /, 'the TERM-resistant descendant cannot keep writing');
        env.PATH = env.SMOKE_NPM_PATH;
      }
      networkChild = undefined;
      if (scenario === 'staging-trickle') {
        assert(elapsedMs >= 60000, `trickle must run longer than the idle limit: ${elapsedMs}`);
        assert.match(result.output, /cotal-ai@99\.0\.0 in use and reconciled/);
        assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, 'utf8')) : null, null, result.output);
        return { scenario, elapsedMs, output: result.output };
      }
      assert.equal(existsSync(recovery), false, result.output);
      assert.deepEqual(readFileSync(join(packageRoot, 'package.json')), manifest);
      assert.equal(readlinkSync(launch), link);
      assert.equal(readFileSync(connector, 'utf8'), 'connector state');
      assert.equal(existsSync(unrelated), true);
      assert(elapsedMs < 300000, `staging must exit within five minutes: ${elapsedMs}`);
      assert.match(result.output, /installing cotal-ai@99\.0\.0 beside the running version/);
      const lastLine = result.output.trim().split('\n').at(-1);
      if (noAccept) {
        assert.match(lastLine, /Package staging reached its time limit\. The previous version remains installed\./);
      } else if (stagingFetchTimeout) {
        assert.match(lastLine, /^The registry fetch timed out during package staging\. The previous version remains installed\. Run `(?:pnpm )?cotal update --self` again when the registry responds\.$/);
      } else {
        assert.equal(lastLine, 'The registry cannot be reached; nothing was changed.');
      }
      assert.doesNotMatch(result.output, /npm error|staged pre-install check refused|recovery snapshot/);
      assert.deepEqual(readFileSync(join(packageRoot, 'dist/cotal.js')), before);
      armed = false;
      const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 0, retry.output);
      assert.match(retry.output, /cotal-ai@99\.0\.0 in use and reconciled/);
      const current = await run(process.execPath, [entry, '--version'], 60000);
      assert.match(current.output, /cotal-ai 99\.0\.0/);
      return { scenario, elapsedMs, output: result.output, retry };
    }
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
    if (scenario === 'cache' || closureKilled || closureNoSpace || extensionPeers) {
      const extensions = join(root, 'config/cotal/extensions');
      mkdirSync(extensions, { recursive: true });
      if (extensionMissing) {
        const install = await run('npm', ['install', '--prefix', extensions, '--ignore-scripts', `${extension}@${previous}`], 60000);
        assert.equal(install.code, 0, install.output);
      }
      writeFileSync(join(extensions, 'extensions.json'), JSON.stringify({ extensions: [{ pkg: extension, version: previous, spec: `${extension}@${previous}`, ...(extensionMissing ? { source: 'seeded' } : {}), provides: [], commands: [] }] }));
      if (extensionMissing) {
        originalInstallation = readInstallation();
        missing = 0;
      }
    }
    const originalPath = env.PATH;
    if (scenario === 'corepack') {
      cwd = join(root, 'work');
      const project = join(root, 'package.json'), tools = join(cwd, 'tools');
      const manifest = JSON.stringify({ name: 'local-project', private: true, packageManager: 'pnpm@11.0.0' });
      writeFileSync(project, manifest);
      mkdirSync(tools, { recursive: true });
      writeFileSync(join(tools, 'npm'), `#!/bin/sh
set -eu
if [ "\${NPM_SMOKE_REFUSAL:-}" = 1 ]; then
  printf '%s\n' 'npm requires an authenticated registry session' 'second diagnostic line' >&2
  exit 1
fi
dir=$PWD
while :; do
  if [ -f "$dir/package.json" ] && grep -q '"packageManager":"pnpm@' "$dir/package.json"; then
    printf '%s\n' "This project is configured to use pnpm because $dir/package.json has a packageManager field" >&2
    exit 1
  fi
  [ "$dir" != / ] || break
  dir=$(dirname "$dir")
done
export PATH="$NPM_SMOKE_REAL_PATH"
exec npm "$@"
`, { mode: 0o700 });
      env.NPM_SMOKE_REAL_PATH = originalPath;
      const relativePath = `tools${delimiter}${originalPath}`;
      env.PATH = relativePath;
      const blocked = await run('npm', ['view', 'cotal-ai@latest', 'version', '--json'], 60000);
      assert.equal(blocked.code, 1, blocked.output);
      assert.match(blocked.output, /This project is configured to use pnpm/);
      env.NPM_SMOKE_REFUSAL = '1';
      symlinkSync(join('tools', 'npm'), join(cwd, 'npm'));
      const absent = join(tools, 'missing');
      const paths = [relativePath, '.', ['', absent].join(delimiter),
        [absent, '', absent].join(delimiter), [absent, ''].join(delimiter), ''];
      const assertCallerNpm = async path => {
        env.PATH = path;
        const refused = await run(process.execPath, [entry, 'update', '--self'], 60000);
        assert.equal(refused.code, 1, refused.output);
        assert.match(refused.output, /cotal-ai version check failed: npm requires an authenticated registry session/, `PATH=${JSON.stringify(path)}: ${refused.output}`);
        assert.doesNotMatch(refused.output, /second diagnostic line|registry cannot be reached/);
      };
      for (const path of paths) await assertCallerNpm(path);
      const colonCaller = join(cwd, 'caller:colon'), splitCaller = join(cwd, 'caller');
      mkdirSync(colonCaller);
      mkdirSync(splitCaller);
      writeFileSync(join(splitCaller, 'npm'), '#!/bin/sh\necho wrong npm >&2\nexit 1\n', { mode: 0o700 });
      symlinkSync(join(tools, 'npm'), join(colonCaller, 'npm'));
      symlinkSync(tools, join(colonCaller, 'tools'));
      cwd = colonCaller;
      for (const path of [`${delimiter}${originalPath}`, '', '.', 'tools']) await assertCallerNpm(path);
      cwd = dirname(colonCaller);
      env.PATH = relativePath;
      delete env.NPM_SMOKE_REFUSAL;
      assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, previous);
    }
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
    let abandonedCache, unrecordedCache, abandonedStagingCache, unrecordedStagingCache;
    let legacyScratch, retainedScratch;
    if (staged) {
      const tools = join(root, 'tools'), busProbe = join(root, 'bus-called');
      mkdirSync(tools);
      writeFileSync(join(tools, 'busctl'), '#!/bin/sh\nprintf called > "$BUS_PROBE"\nprintf "native probe output\\n" >&2\nexit 1\n', { mode: 0o700 });
      const path = env.PATH;
      env.PATH = `${tools}:${path}`;
      env.BUS_PROBE = busProbe;
      const legacy = JSON.stringify({ phase: 'ambiguous', owner: 2147483647, nonce: 'd'.repeat(24), operation: 'global install', reason: 'install child terminated by SIGKILL' });
      writeFileSync(marker, legacy, { mode: 0o600 });
      const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
      assert.equal(retry.code, 2, retry.output);
      assert.match(retry.output, /systemd user manager answers on the user bus.*Run `cotal update --self` again/);
      assert.doesNotMatch(retry.output, /native probe output|OPERATION_UNKNOWN|remove the marker/);
      assert(existsSync(busProbe));
      assert.equal(readFileSync(marker, 'utf8'), legacy);
      rmSync(marker);
      rmSync(busProbe);
      const first = run(process.execPath, [entry, 'update', '--self'], 120000);
      abandoned = first;
      const updater = interrupted;
      let child;
      for (let deadline = Date.now() + 90000; !child && Date.now() < deadline && updater.exitCode === null; await new Promise(done => setTimeout(done, 10))) {
        const record = readMarker();
        if (heldArchive && record?.phase === 'live' && record.owner === updater.pid && record.operation === 'global install') child = record;
      }
      assert(child, 'the real staging npm child was published and blocked loading its archive');
      assert.match(readFileSync(`/proc/${child.pid}/cmdline`, 'utf8'), /npm.*install|\0install\0/);
      process.kill(child.pid, 'SIGKILL');
      const failed = await first;
      assert.equal(failed.code, 1, failed.output);
      assert.match(failed.output, /npm terminated by SIGKILL/);
      assert.equal(readMarker()?.custody?.pid, child.pid);
      assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, previous);
      heldArchive.end();
      heldArchive = undefined;

      const scratch = join(root, 'tmp');
      const unrecorded = mkdtempSync(join(scratch, 'cotal-update-'));
      unrecordedStagingCache = mkdtempSync(join(unrecorded, 'cotal-update-npm-'));
      abandoned = run(process.execPath, [entry, 'update', '--self'], 120000);
      const owner = interrupted;
      let worker;
      for (let deadline = Date.now() + 90000; !worker && Date.now() < deadline && owner.exitCode === null; await new Promise(done => setTimeout(done, 10))) {
        const record = readMarker();
        if (heldArchive && record?.phase === 'live' && record.owner === owner.pid && record.operation === 'global install') worker = record.pid;
      }
      assert(worker, 'the retry reached staging with a real npm worker');
      const caches = readdirSync(scratch).filter(name => name.startsWith('cotal-update-') && join(scratch, name) !== unrecorded)
        .flatMap(name => readdirSync(join(scratch, name)).filter(cache => cache.startsWith('cotal-update-npm-')).map(cache => join(scratch, name, cache)));
      assert.equal(caches.length, 1, 'found the staging worker’s private npm cache');
      abandonedStagingCache = caches[0];
      mkdirSync(join(dirname(abandonedStagingCache), 'node-compile-cache'), { recursive: true });
      const ownerExited = new Promise(done => owner.once('exit', (_code, signal) => done(signal)));
      owner.kill('SIGKILL');
      assert.equal(await ownerExited, 'SIGKILL');
      holdStaging = false;
      heldArchive.end(archives.get(target));
      heldArchive = undefined;
      assert.equal((await abandoned).signal, 'SIGKILL');
      assert(existsSync(abandonedStagingCache), 'the interrupted updater left its staging cache');
    }
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
      mkdirSync(join(scratch, outer, 'node-compile-cache'), { recursive: true });
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
      assert(existsSync(join(scratch, outer, 'node-compile-cache')), 'retry leaves compile cache with the surviving worker');
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
      const old = new Date(Date.now() - 61 * 60_000);
      const fixture = ({ recent, extra, mode } = {}) => {
        const path = mkdtempSync(join(scratch, 'cotal-update-'));
        const cache = join(path, 'node-compile-cache');
        const entry = join(cache, 'compiled');
        mkdirSync(cache);
        writeFileSync(entry, 'cache');
        if (extra) writeFileSync(join(path, 'keep'), 'other content');
        if (mode) chmodSync(path, mode);
        for (const [index, item] of [path, cache, entry].entries()) if (index !== recent) utimesSync(item, old, old);
        return path;
      };
      legacyScratch = fixture();
      const link = join(scratch, 'cotal-update-link00');
      const shared = fixture({ mode: 0o750 });
      const linkTarget = join(scratch, 'link-target');
      const targetCache = join(linkTarget, 'node-compile-cache');
      mkdirSync(targetCache, { recursive: true, mode: 0o700 });
      for (const item of [linkTarget, targetCache]) utimesSync(item, old, old);
      symlinkSync(linkTarget, link);
      retainedScratch = [shared, link, linkTarget, fixture({ extra: true }), ...[0, 1, 2].map(recent => fixture({ recent }))];
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
    if (scenario === 'pending' || reconcileInterrupted) {
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
        const [scratch] = readdirSync(env.TMPDIR).filter(name => /^cotal-update-[a-zA-Z0-9]{6}$/.test(name));
        assert(scratch, 'the live updater has private scratch');
        const [cache] = readdirSync(join(env.TMPDIR, scratch)).filter(name => name.startsWith('cotal-update-reconcile-'));
        assert(cache, 'the reconciliation has a private cache');
        const custody = join(env.TMPDIR, scratch, cache);
        assert.match(readFileSync(join(custody, '.owner'), 'utf8'), new RegExp(`^${updater.pid}\\n[^\\n]+\\n$`));
        assert(existsSync(join(custody, `.worker-${record.pid}`)), 'the running child has a published cache record');
        if (reconcileOrphan) {
          updater.kill('SIGKILL');
          writeFileSync(releaseReconcile, 'finish');
          assert.equal((await first).signal, 'SIGKILL');
          assert.throws(() => process.kill(record.owner, 0), { code: 'ESRCH' });
          const childExited = () => {
            try { return /^[ZX] /.test(readFileSync(`/proc/${record.pid}/stat`, 'utf8').split(') ').at(-1)); }
            catch (error) { if (error.code === 'ENOENT') return true; throw error; }
          };
          for (let deadline = Date.now() + 5000; !childExited() && Date.now() < deadline; )
            await new Promise(done => setTimeout(done, 20));
          assert(childExited(), 'the interrupted updater’s child exited');
          const reconcileScratch = join(env.TMPDIR, scratch);
          const compile = join(reconcileScratch, 'node-compile-cache');
          mkdirSync(compile, { recursive: true });
          const old = new Date(Date.now() - 61 * 60_000);
          for (const name of readdirSync(compile, { recursive: true })) utimesSync(join(compile, name), old, old);
          for (const path of [compile, custody, reconcileScratch]) utimesSync(path, old, old);
          // A different installation may run collection while the original update journal remains.
          const otherPrefix = join(root, 'other-prefix');
          mkdirSync(otherPrefix, { mode: 0o700 });
          env.npm_config_prefix = otherPrefix;
          env.COTAL_HOME = join(root, 'other-cotal');
          mkdirSync(env.COTAL_HOME, { mode: 0o700 });
          env.npm_config_fetch_retries = '0';
          disconnected = true;
          const collected = await run(process.execPath, [entry, 'update', '--self'], 60000);
          assert.equal(collected.code, 0, collected.output);
          if (existsSync(reconcileScratch))
            assert.fail(`interrupted reconciliation scratch remained: ${readdirSync(reconcileScratch, { recursive: true }).join(', ')}\n${collected.output}`);
          return { scenario, code: collected.code, output: collected.output };
        } else {
          process.kill(record.pid, 'SIGKILL');
          const result = await first;
          assert.equal(result.code, 1, result.output);
          const evidence = JSON.parse(readFileSync(marker, 'utf8'));
          assert.equal(evidence.phase, 'ambiguous');
          assert.equal(evidence.custody?.pid, record.pid);
          assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
        }
      }
      assert.throws(() => process.kill(record.owner, 0), { code: 'ESRCH' });
    }
    if (scenario === 'cache' && process.platform === 'linux') {
      cacheWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: childEnv, detached: true, stdio: 'ignore' });
      await once(cacheWorker, 'spawn');
    }
    const scratchFixtures = scenario === 'cache' ? reconciliationScratch(join(root, 'tmp'), cacheWorker?.pid) : undefined;
    if (lifecycle) env.PATH = lifecycle.path;
    const updates = await Promise.all(Array.from({ length: scenario === 'concurrent' ? 2 : 1 }, () => run(lifecycle?.node ?? process.execPath, [entry, 'update', '--self'], 660000)));
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
    if (extensionMissing) {
      assert(missing > 0, 'the installed connector was initially absent at the selected release');
      assert.match(update.output, /Waiting for .*connector-hermes@99\.0\.0/);
      assert.deepEqual(installedAtWait, originalInstallation);
    }
    if (staged) {
      assert.equal(update.code, 0, update.output);
      assert.match(update.output, /recovery snapshot saved/);
      assert.match(update.output, /cotal-ai@99\.0\.0 in use and reconciled/);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(root, 'bus-called')), false, 'exact child custody needs no native user manager query');
      assert(!existsSync(abandonedStagingCache), 'the successful retry removes the abandoned staging cache');
      assert(!existsSync(dirname(abandonedStagingCache)), 'the successful retry removes the abandoned staging scratch');
      assert(existsSync(unrecordedStagingCache), 'the successful retry leaves unrecorded staging caches alone');
      const current = await run(process.execPath, [entry, '--version'], 60000);
      assert.match(current.output, /cotal-ai 99\.0\.0/);
    } else if (closureKilled) {
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
    } else if (versionNamedNode) {
      assert.equal(update.code, 0, update.output);
      assert.equal(selected, target);
      assert.match(update.output, /installed globally and reconciled/);
      const launcher = join(prefix, 'bin/cotal');
      assert.equal(readlinkSync(launcher), '../lib/node_modules/cotal-ai/dist/cotal-npm', update.output);
      assert(readFileSync(join(packageRoot, 'dist/cotal-npm'), 'utf8').includes(`  node='${lifecycle.node}'`), 'postinstall pinned the version-named Node');
      assert.equal((await run(launcher, [], 60000)).code, 0, 'installed launcher runs without node on PATH');
      await assertLifecycleExtension(run, lifecycle, entry, root);
    } else if (scenario === 'corepack') {
      assert.equal(update.code, 0, update.output);
      assert.equal(selected, target);
      assert.match(update.output, /installed globally and reconciled/);
      assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager, 'pnpm@11.0.0');
    } else if (scenario === 'concurrent') {
      assert.equal(selected, target);
    } else if (scenario === 'extension-unavailable') {
      assert.equal(update.code, 1, update.output);
      assert(elapsedMs >= 600000 && elapsedMs < 660000, `real wait bound: ${elapsedMs}`);
      assert.match(update.output, /connector-hermes@99\.0\.0 is not yet available.*No global install was attempted.*run `cotal update --self` again in a few minutes/);
      assert.doesNotMatch(update.output, /Correct the reported failure/);
      assert.deepEqual(readInstallation(), originalInstallation);
    } else if (extensionPeers) {
      assert.equal(update.code, 0, update.output);
      assert.equal(selected, target);
      assert.match(update.output, /installed globally and reconciled/);
      assert(closureStart !== undefined && closureEnd !== undefined);
      const paths = requests.slice(closureStart, closureEnd).map(request => decodeURIComponent(request.path));
      assert(paths.includes(`/${extension}/-/${target}.tgz`), 'preflight downloads the installed extension archive');
      for (const peer of hostPeers) {
        assert(paths.includes(`/${peer}/-/${target}.tgz`), `preflight downloads ${peer} from the selected release`);
        assert(!requests.some(request => decodeURIComponent(request.path) === `/${peer}/-/${newer}.tgz`), `requested ${peer} from another release`);
      }
    } else if (scenario === 'integrity') {
      assert.equal(update.code, 1, update.output);
      assert.doesNotMatch(update.output, /Waiting for cotal-ai|Keeping cotal-ai/);
    } else {
      assert.equal(update.code, 0, update.output);
      if (!reconcileInterrupted && !['reset', 'cache', 'archive-interrupted', 'orphan', 'pending'].includes(scenario)) assert.match(update.output, /Waiting for cotal-ai@99\.0\.0 release archives/);
      if (scenario === 'cache') {
        assert.equal(selected, target, update.output);
        assert.match(update.output, /installed globally and reconciled/);
        assert.doesNotMatch(update.output, /EACCES|sudo chown|root-owned files/);
        assert.equal(statSync(configuredCache).mode & 0o777, 0o500);
        assert.deepEqual(readdirSync(configuredCache), []);
        assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), `cache=${configuredCache}\n`);
        for (const path of scratchFixtures.expired)
          assert(!existsSync(path), `successful self-update removes expired compile scratch: ${path}`);
        if (scratchFixtures.live) assert(existsSync(scratchFixtures.live), 'a live reconciliation group retains its scratch');
        assert.deepEqual(readdirSync(join(root, 'tmp')).filter(name => name.startsWith('cotal-')).sort(),
          [...scratchFixtures.retained.map(([path]) => basename(path)), ...(scratchFixtures.live ? [basename(scratchFixtures.live)] : [])].sort(),
          'ineligible scratch stays and new update scratch is removed');
        for (const [path, contents] of scratchFixtures.retained)
          assert.deepEqual(readdirSync(path, { recursive: true }).sort(), contents, `ineligible scratch is unchanged: ${path}`);
        if (scratchFixtures.live) {
          const exited = once(cacheWorker, 'exit');
          cacheWorker.kill();
          await exited;
          const retry = await run(process.execPath, [entry, 'update', '--self'], 60000);
          assert.equal(retry.code, 0, retry.output);
          assert(!existsSync(scratchFixtures.live), 'the next successful self-update collects scratch after the worker exits');
        }
        assert(requests.some(request => decodeURIComponent(request.path).startsWith(`/${extension}`)), 'the installed extension closure was downloaded');
      } else if (scenario === 'archive-interrupted') {
        assert.equal(selected, target, update.output);
        assert.equal(existsSync(abandonedCache), false, 'retry removes the recorded orphan cache');
        assert(!existsSync(dirname(abandonedCache)), 'retry removes the abandoned scratch and its compile cache');
        assert(existsSync(unrecordedCache), 'retry does not infer custody from a directory name');
        assert(!existsSync(legacyScratch), 'retry removes compile-only scratch without custody files');
        for (const path of retainedScratch) assert(existsSync(path), `retry preserves ineligible scratch: ${path}`);
      } else if (reconcileInterrupted || ['orphan', 'pending'].includes(scenario)) {
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
    if (!versionNamedNode && !reconcileInterrupted && !['arrives', 'reset', 'cache', 'archive-interrupted', 'orphan', 'pending', 'staging-killed', 'concurrent', 'extension-peers', 'extension-arrives', 'corepack'].includes(scenario)) {
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
    clearInterval(trickle);
    if (reconcileOrphan) writeFileSync(releaseReconcile, 'finish');
    if (cacheWorker && cacheWorker.exitCode === null && cacheWorker.signalCode === null) {
      const exited = once(cacheWorker, 'exit');
      cacheWorker.kill();
      await exited;
    }
    for (const socket of backlog) socket.destroy();
    blackhole?.kill('SIGKILL');
    if (networkChild) { try { process.kill(-networkChild, 'SIGKILL'); } catch {} }
    heldArchive?.end();
    if (pausedArchive) { try { process.kill(pausedArchive, 'SIGCONT'); } catch {} }
    if (orphan) { try { process.kill(orphan, 'SIGCONT'); } catch {} }
    if (interrupted?.exitCode === null && interrupted?.signalCode === null) interrupted.kill('SIGKILL');
    if (abandoned) await abandoned.catch(() => {});
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    if (existsSync(join(root, 'configured-cache'))) chmodSync(join(root, 'configured-cache'), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

async function corepackNodeFallbackCell(entry, parent) {
  const root = mkdtempSync(join(parent, 'corepack-node-fallback-'));
  const prefix = join(root, 'prefix'), home = join(root, 'home'), project = join(root, 'project');
  const installed = join(prefix, 'lib/node_modules/cotal-ai'), scripts = join(installed, 'scripts');
  const shims = join(root, 'npm-shims');
  const executable = join(prefix, 'bin/cotal');
  const exe = join(installed, 'dist/cotal.js');
  const version = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
  const env = { ...childEnv, HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: join(root, 'tmp'), npm_config_cache: join(root, 'cache'),
    COREPACK_HOME: join(root, 'corepack-cache'), COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_NPM_REGISTRY: 'https://registry.npmjs.org',
    COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', COTAL_NO_UPDATE_CHECK: '1', COTAL_SKIP_CONNECTOR_SEED: '1' };
  delete env.NODE_OPTIONS;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: version }, versions: { [version]: { name: 'cotal-ai', version } } }));
  });
  const run = (file, args) => new Promise((resolveRun, reject) => {
    let output = '';
    const child = spawn(file, args, { cwd: project, env, timeout: 120_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, output }));
  });
  const ok = async (file, args) => {
    const result = await run(file, args);
    assert.equal(result.code, 0, `${file} ${args.join(' ')}\n${result.output}`);
    return result.output;
  };
  try {
    for (const dir of [home, project, shims, scripts, dirname(executable), env.TMPDIR, env.XDG_RUNTIME_DIR])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tools = join(root, 'tools');
    const install = (dir, pkg) => ok('npm', ['install', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--prefix', dir, pkg]);
    for (const nodeVersion of ['22.10.0', '22.11.0', '24.21.0']) await install(join(tools, nodeVersion), `node@${nodeVersion}`);
    await install(tools, 'corepack@0.34.5');
    const [active, recorded, compatible] = ['22.10.0', '22.11.0', '24.21.0'].map(v => join(tools, v, 'node_modules/node/bin/node'));
    const corepack = join(tools, 'node_modules/corepack');
    await ok(compatible, [join(corepack, 'dist/corepack.js'), 'install', '--global', 'npm@12.2.3']);
    await ok(compatible, [join(corepack, 'dist/corepack.js'), 'enable', '--install-directory', shims, 'npm']);

    cpSync(dirname(entry), join(installed, 'dist'), { recursive: true });
    cpSync(join(repo, 'bin/package.json'), join(installed, 'package.json'));
    symlinkSync(join(repo, 'bin/node_modules'), join(installed, 'node_modules'));
    symlinkSync(exe, executable);
    const pin = join(scripts, 'pin-npm-node.cjs');
    cpSync(join(repo, 'bin/scripts/pin-npm-node.cjs'), pin);
    await ok(recorded, [pin]);
    assert(readFileSync(join(installed, 'dist/cotal-npm'), 'utf8').includes(`  node='${recorded}'`));
    const seed = join(env.XDG_CONFIG_HOME, 'cotal', 'seed');
    mkdirSync(seed, { recursive: true, mode: 0o700 });
    writeFileSync(join(seed, 'authority.json'), JSON.stringify({ everSeeded: ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web'] }));
    writeFileSync(join(seed, 'witness.json'), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, 'stamp.json'), JSON.stringify({ generation: version }));
    env.PATH = [dirname(executable), shims, ...[active, recorded, compatible].map(dirname), '/usr/bin', '/bin'].join(delimiter);
    env.npm_config_prefix = prefix;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}/`;
    env.NO_PROXY = '127.0.0.1';

    const npm = join(corepack, 'dist/npm.js');
    const args = ['view', 'cotal-ai@latest', 'version', '--json'];
    assert.match(await ok(recorded, [npm, '--version']), /12\.2\.3/);
    const incompatible = await run(recorded, [npm, ...args]);
    assert.notEqual(incompatible.code, 0);
    assert.match(incompatible.output, /ERR_REQUIRE_ESM/);
    assert.deepEqual(requests, [], 'the recorded Node cannot reach the registry through the selected npm');
    assert.equal((await ok('node', ['--version'])).trim(), 'v22.10.0');
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = requests.length;
      const output = await ok(executable, ['update', '--self']);
      assert.match(output, /Registry latest:/);
      assert.deepEqual(requests.slice(before), ['/cotal-ai'], 'npm reaches the registry without changing the caller Node');
    }
    assert.match(await ok(executable, ['status']), /Node v22\.10\.0/);
    return { scenario: 'corepack-node-fallback', cotal: version, node: '22.10.0', npm: '12.2.3', registryLookups: requests.length };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'closure-mount-probe-'));
  let canMount;
  try {
    canMount = process.platform === 'linux' && spawnSync('unshare', ['-Urm', 'mount', '-t', 'tmpfs', '-o', 'size=2m', 'tmpfs', mountPoint], { env: childEnv }).status === 0;
  } finally { rmSync(mountPoint, { recursive: true }); }
  const selected = process.argv[2] ? [process.argv[2]] : ['arrives', 'unavailable', 'integrity', 'reset', 'cache', 'orphan', 'closed-scope', 'min-release-age', 'before', 'offline-metadata', 'offline-archive', 'offline-closure', 'offline-staging', 'concurrent', 'extension-peers', 'extension-arrives', ...(process.platform !== 'win32' ? ['corepack'] : []), ...(process.platform === 'linux' ? ['archive-interrupted', 'closure-killed', 'pending', 'reconcile-killed', 'reconcile-orphan', 'staging-killed', 'staging-timeout', 'staging-fetch-timeout', 'staging-partial', 'staging-no-accept', 'staging-trickle', 'staging-auto', 'staging-refused', 'config-access-upgrade', 'config-access-auto', 'config-unprotected', 'config-unprotected-auto', 'selection-upgrade', 'selection-rollback'] : []), ...(canMount ? ['closure-nospace'] : [])];
  for (const scenario of selected) console.log(JSON.stringify(await registryArrivalCell({ scenario })));
  emitSentinel({ passed: selected.length, failed: 0 });
}
