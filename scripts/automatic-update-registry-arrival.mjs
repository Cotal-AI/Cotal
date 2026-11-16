import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

/** Upgrade two normal packed closures through the installed entry while the target archive propagates. */
export async function registryArrivalUpgrade({ oldDirectory, targetDirectory, root }) {
  root = resolve(root);
  for (const name of ['', 'home', 'cotal', 'config', 'tmp', 'runtime', 'prefix', 'project']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COTAL_') && !['npm_config_before', 'NPM_CONFIG_BEFORE'].includes(name)));
  Object.assign(env, { HOME: join(root, 'home'), COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'), XDG_RUNTIME_DIR: join(root, 'runtime'), npm_config_prefix: join(root, 'prefix'), npm_config_cache: join(root, 'cache'), COTAL_TELEMETRY: 'off', COTAL_SKIP_CONNECTOR_SEED: '1', DO_NOT_TRACK: '1' });
  const calls = [], requests = [];
  const run = async (label, file, args) => {
    const started = Date.now();
    const child = spawn(file, args, { cwd: join(root, 'project'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.on('data', bytes => stderr += bytes);
    const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      const result = { label, code, elapsedMs: Date.now() - started, stdout, stderr };
      calls.push(result);
      writeFileSync(join(root, `${label}.json`), JSON.stringify(result, null, 2));
      return result;
    } finally { clearTimeout(timer); }
  };
  const old = await candidateRegistry(resolve(oldDirectory), 'A', 'https://registry.npmjs.org/');
  let target, gate, misses = 0;
  try {
    env.npm_config_registry = old.url;
    const installed = await run('install', 'npm', ['install', '-g', `cotal-ai@${old.identity.version}`]);
    assert.equal(installed.code, 0, installed.stderr);
    const entry = join(root, 'prefix/bin/cotal');
    const before = await run('before', entry, ['--version']);
    assert.equal(before.code, 0);
    assert(before.stdout.includes(old.identity.version));
    target = await candidateRegistry(resolve(targetDirectory), 'B', 'https://registry.npmjs.org/');
    let gateUrl;
    gate = createServer(async (request, response) => {
      try {
        requests.push({ at: Date.now(), url: request.url });
        if (request.url.includes('__candidate/cotal-ai-') && ++misses === 1) return response.writeHead(404).end('release archive is propagating');
        const upstream = await fetch(target.url + request.url, { signal: AbortSignal.timeout(30000) });
        const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
        const bytes = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, { 'content-type': contentType });
        response.end(contentType.includes('json') ? bytes.toString().replaceAll(target.url, gateUrl) : bytes);
      } catch (error) { response.writeHead(502).end(String(error)); }
    });
    await new Promise(done => gate.listen(0, '127.0.0.1', done));
    gateUrl = `http://127.0.0.1:${gate.address().port}`;
    env.npm_config_registry = gateUrl;
    const updated = await run('update', entry, ['update', '--self']);
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    assert(updated.stdout.includes(`Waiting for cotal-ai@${target.identity.version} release archives`), updated.stdout);
    assert.match(updated.stdout, /in use and reconciled/);
    assert(updated.elapsedMs >= 15000 && misses >= 2);
    const after = await run('after', entry, ['--version']);
    assert.equal(after.code, 0);
    assert(after.stdout.includes(target.identity.version), after.stdout);
    let recovery = null;
    try { recovery = JSON.parse(readFileSync(join(root, 'cotal/update-recovery.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(recovery, null);
    return { old: old.identity, target: target.identity, calls, requests, misses, recovery };
  } finally {
    writeFileSync(join(root, 'calls.json'), JSON.stringify({ calls, requests, misses }, null, 2));
    if (gate) await new Promise(done => gate.close(done));
    if (target) await target.close();
    await old.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [oldDirectory, targetDirectory, root] = process.argv.slice(2);
  assert(oldDirectory && targetDirectory && root, 'usage: automatic-update-registry-arrival.mjs <old-pack> <target-pack> <private-root>');
  const result = await registryArrivalUpgrade({ oldDirectory, targetDirectory, root });
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
