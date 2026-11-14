import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prependPath } from './update-duration-environment.mjs';
import { captureRecords } from './update-duration-records.mjs';
import { createServer } from 'node:http';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'measurement requires GitHub Actions');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'measurement requires disposable hosted runner');
assert(['win32', 'linux'].includes(process.platform));
const root = resolve(process.env.RUNNER_TEMP, `update-duration-${process.env.SAMPLE}`);
const evidence = resolve(process.env.RUNNER_TEMP, 'update-duration-evidence');
const trace = join(evidence, 'trace');
for (const dir of [root, evidence, trace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !key.startsWith('NODE_OPTIONS')));
const home = join(root, 'home'), prefix = join(root, 'prefix'), project = join(root, 'project');
Object.assign(env, {
  HOME: home, USERPROFILE: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
  LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
  TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
  npm_config_prefix: prefix, npm_config_cache: join(root, 'npm-cache'),
  DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', COTAL_NO_UPDATE_CHECK: '1',
});
for (const dir of [home, prefix, project, env.TMPDIR, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
mkdirSync(join(project, '.cotal'), { mode: 0o700 });
prependPath(env, join(prefix, process.platform === 'win32' ? '' : 'bin'));
const npmCli = join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
assert(existsSync(npmCli), `npm entry missing: ${npmCli}`);
const pkg = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules/cotal-ai');
const cli = join(pkg, 'dist/cotal.js');
const observerPath = resolve(process.env.UPDATE_OBSERVER ?? 'scripts/update-duration-observer.cjs');
const report = { source: '0.164.7', target: '0.164.8', sample: process.env.SAMPLE, mode: process.env.MODE, platform: process.platform, runner: process.env.RUNNER_OS, run: process.env.GITHUB_RUN_ID, head: process.env.GITHUB_SHA, calls: [] };
const save = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
async function call(label, argv, observed = false) {
  const disk = statfsSync(root);
  assert(disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'less than 20 GiB before install/update');
  const startedAt = Date.now();
  console.log(`${new Date(startedAt).toISOString()} start ${label}`);
  const childEnv = { ...env };
  if (observed) Object.assign(childEnv, { UPDATE_TIMING_DIR: trace, NODE_OPTIONS: `--require=${JSON.stringify(observerPath)}` });
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, argv, { cwd: project, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', (status, signal) => done({ status, signal, stdout, stderr }));
  });
  const endedAt = Date.now();
  const row = { label, command: [process.execPath, ...argv], startedAt, endedAt, durationMs: endedAt - startedAt, ...result };
  report.calls.push(row);
  save();
  console.log(`${new Date(endedAt).toISOString()} end ${label}: ${row.durationMs}ms`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.signal, null);
  return result;
}
let overlays = [], proxy, activeRegistry;
try {
  if (process.env.PACKED_INPUTS) {
    const packed = resolve(process.env.PACKED_INPUTS);
    for (const name of ['source', 'target']) overlays.push(await candidateRegistry(join(packed, name), 'B', 'https://registry.npmjs.org'));
    activeRegistry = overlays[0];
    proxy = createServer(async (request, response) => {
      try {
        const selected = request.url.endsWith('/0.164.7') ? overlays[0] : activeRegistry;
        const url = selected.url + request.url;
        const upstream = await fetch(url, { signal: AbortSignal.timeout(60000) });
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        if (contentType.includes('json') && upstream.ok) {
          const metadata = await upstream.json();
          if (metadata.versions) {
            const source = await (await fetch(overlays[0].url + request.url, { signal: AbortSignal.timeout(60000) })).json();
            if (source.versions?.['0.164.7']) metadata.versions['0.164.7'] = source.versions['0.164.7'];
          }
          response.writeHead(upstream.status, { 'content-type': contentType }).end(JSON.stringify(metadata));
        } else {
          response.writeHead(upstream.status, { 'content-type': contentType });
          response.end(Buffer.from(await upstream.arrayBuffer()));
        }
      } catch (error) { response.writeHead(502).end(String(error)); }
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    env.npm_config_registry = `http://127.0.0.1:${proxy.address().port}`;
    report.packed = { kind: 'fixed source and target packed with release guards', source: overlays[0].identity, target: overlays[1].identity };
  }
  await call('install published source', [npmCli, 'install', '-g', 'cotal-ai@0.164.7', '--no-audit', '--no-fund']);
  if (process.platform === 'win32') {
    const core = pathToFileURL(join(pkg, 'node_modules/@cotal-ai/core/dist/index.js')).href;
    await call('protect fixture directories', ['--input-type=module', '-e', `const {mkSecretDir}=await import(${JSON.stringify(core)});for(const p of ${JSON.stringify([root, home, project, env.XDG_CONFIG_HOME])})mkSecretDir(p);`]);
  }
  await call('seed all built-in connectors', [cli, 'ext', 'seed']);
  await call('add runtime extension', [cli, 'ext', 'add', '@cotal-ai/tmux@0.164.7']);
  report.before = JSON.parse((await call('record source extensions', [cli, 'ext', 'list', '--json'])).stdout);
  if (overlays.length) activeRegistry = overlays[1];
  const latest = JSON.parse((await call('assert unchanged published target', [npmCli, 'view', 'cotal-ai@latest', 'version', '--json'])).stdout);
  assert.equal(latest, report.target, 'latest drifted, refuse another target');
  await call('update under test', [cli, 'update', '--self'], process.env.MODE === 'passive');
  report.installed = JSON.parse(readFileSync(join(pkg, 'package.json'))).version;
  assert.equal(report.installed, report.target);
  report.after = JSON.parse((await call('verify installed extensions', [cli, 'ext', 'list', '--json'])).stdout);
  assert.equal(report.after.result.items.length, 8);
  assert.deepEqual(report.after.result.items.map(entry => entry.pkg), report.before.result.items.map(entry => entry.pkg));
  assert(report.after.result.items.every(entry => entry.version === report.target));
  report.versionOutput = (await call('verify global CLI version', [cli, 'version'])).stdout;
  assert(report.versionOutput.startsWith(`cotal-ai ${report.target}`));
  // Retain operator records but never copy credentials or arbitrary state.
  report.records = captureRecords(root, env);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  if (proxy) await new Promise(done => proxy.close(done));
  for (const overlay of overlays) await overlay.close();
  report.observerSha256 = createHash('sha256').update(readFileSync(observerPath)).digest('hex');
  save();
  const events = readdirSync(trace).flatMap(name => readFileSync(join(trace, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const starts = new Map(events.filter(e => e.kind === 'child-start').map(e => [e.id, e]));
  const children = events.filter(e => e.kind === 'child-end').map(end => ({ ...starts.get(end.id), end: end.at, durationMs: end.at - starts.get(end.id)?.at, status: end.status, error: end.error }));
  writeFileSync(join(evidence, 'children.json'), JSON.stringify(children, null, 2));
  writeFileSync(join(evidence, 'output-events.json'), JSON.stringify(events.filter(e => e.kind === 'output').sort((a, b) => a.at - b.at), null, 2));
  writeFileSync(join(evidence, 'filesystem.json'), JSON.stringify(events.filter(e => e.kind === 'filesystem-group').sort((a, b) => b.durationMs - a.durationMs), null, 2));
}
