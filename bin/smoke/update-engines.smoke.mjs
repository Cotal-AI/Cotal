import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSentinel, skipSuite } from './sentinel.mjs';

if (process.platform !== 'linux' && process.platform !== 'darwin') skipSuite('engine update regression requires a POSIX npm prefix');

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const current = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const target = '99.0.0';
const scenarios = process.argv[2] ? [process.argv[2]] : ['compatible', 'node', 'npm', 'dependency'];
for (const scenario of scenarios) {
  assert(['compatible', 'node', 'npm', 'dependency'].includes(scenario));
  const root = mkdtempSync(join(tmpdir(), 'cotal-update-engines-'));
  for (const name of ['home', 'config', 'cotal', 'runtime', 'tmp', 'prefix', 'payload/package/dist']) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  }
  const archives = new Map();
  for (const [name, version] of [['cotal-ai', current], ['cotal-ai', target], ['engine-dependency', '1.0.0']]) {
    const engines = version === current ? { node: '>=22.10' }
      : name === 'engine-dependency' ? { node: scenario === 'dependency' ? '>=99' : '>=22.10' }
      : scenario === 'node' ? { node: '>=99' } : scenario === 'npm' ? { npm: '>=99' } : { node: '>=22.10' };
    const meta = { name, version, engines, ...(name === 'cotal-ai' ? { bin: { cotal: 'dist/cotal.js' } } : {}),
      ...(version === target && scenario === 'dependency' ? { dependencies: { 'engine-dependency': '1.0.0' } } : {}) };
    writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify(meta));
    writeFileSync(join(root, 'payload/package/dist/cotal.js'), '#!/usr/bin/env node\nconsole.log("fixture reconciled");\n', { mode: 0o755 });
    const archive = join(root, `${name}-${version}.tgz`);
    const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'package']);
    assert.equal(packed.status, 0);
    const bytes = readFileSync(archive);
    archives.set(`${name}-${version}`, { meta, bytes });
  }
  let origin;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('.tgz')) {
      const archive = archives.get(request.url.slice(1, -4));
      return archive ? response.end(archive.bytes) : response.writeHead(404).end();
    }
    const name = decodeURIComponent(request.url.slice(1));
    const versions = Object.fromEntries([...archives].filter(([, archive]) => archive.meta.name === name).map(([key, { meta, bytes }]) => [meta.version, {
      ...meta, dist: { tarball: `${origin}/${key}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
    }]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: name === 'cotal-ai' ? target : '1.0.0' }, versions }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), COTAL_HOME: join(root, 'cotal'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: join(root, 'tmp'), npm_config_registry: origin,
    npm_config_prefix: join(root, 'prefix'), npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_force: 'true', npm_config_engine_strict: 'false',
    COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', NO_COLOR: '1' });
  const run = async (file, args) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => output += bytes);
    child.stderr.on('data', bytes => output += bytes);
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      return { code, output };
    } finally { clearTimeout(timer); }
  };
  try {
    const install = await run('npm', ['install', '-g', `cotal-ai@${current}`]);
    assert.equal(install.code, 0, install.output);
    const packageRoot = join(root, 'prefix/lib/node_modules/cotal-ai');
    const manifest = readFileSync(join(packageRoot, 'package.json'));
    const entry = readFileSync(join(packageRoot, 'dist/cotal.js'));
    writeFileSync(join(packageRoot, 'preserve'), 'unchanged');
    const update = await run(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
    writeFileSync(join(root, 'update.log'), update.output);
    const selected = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    console.log(JSON.stringify({ scenario, root, code: update.code, selected, requests, output: update.output }));
    if (scenario === 'compatible') {
      assert.equal(update.code, 0, update.output);
      assert.equal(selected, target);
      assert.match(update.output, /installed globally and reconciled/);
    } else {
      assert.equal(update.code, 1, `incompatible ${scenario} must refuse before replacement: ${update.output}`);
      assert.match(update.output, /EBADENGINE/);
      assert.match(update.output, /Upgrade the runtime to satisfy the reported engines/);
      assert.doesNotMatch(update.output, /again in a few minutes|still reaching the registry/);
      assert.match(update.output, /no global install was attempted/);
      assert.equal(selected, current);
      assert.deepEqual(readFileSync(join(packageRoot, 'package.json')), manifest);
      assert.deepEqual(readFileSync(join(packageRoot, 'dist/cotal.js')), entry);
      assert.equal(readFileSync(join(packageRoot, 'preserve'), 'utf8'), 'unchanged');
      assert.doesNotMatch(update.output, /Saving update recovery snapshot|installing cotal-ai@|Restoring verified/);
    }
    const recovery = join(root, 'cotal/update-recovery.json');
    assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, 'utf8')) : null, null);
  } finally {
    await new Promise(done => server.close(done));
  }
}
emitSentinel({ passed: scenarios.length, failed: 0 });
