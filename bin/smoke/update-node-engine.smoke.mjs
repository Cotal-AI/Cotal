import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSentinel, skipSuite } from './sentinel.mjs';

if (!['linux', 'darwin'].includes(process.platform)) skipSuite('engine-update fixture uses POSIX npm prefixes');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(join(tmpdir(), 'update-node-engine-'));
const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const target = '99.0.0';
const scenarios = process.argv.slice(2);
let passed = 0;
console.log(`Retained engine-update evidence: ${root}`);
for (const scenario of scenarios.length ? scenarios : ['supported', 'unsupported', 'invalid', 'public-unsupported', 'auto-unsupported']) {
  assert(['supported', 'unsupported', 'invalid', 'public-unsupported', 'auto-unsupported'].includes(scenario));
  const cell = join(root, scenario);
  for (const name of ['home', 'config', 'cotal', 'runtime', 'tmp', 'prefix', 'payload/package/dist']) mkdirSync(join(cell, name), { recursive: true, mode: 0o700 });
  const archives = new Map(), requests = [];
  const incompatible = scenario.endsWith('unsupported');
  const range = scenario === 'supported' ? '>=22.10' : incompatible ? '>=99.0.0' : 'not-a-range';
  for (const version of [previous, target]) {
    const engines = { node: version === target ? range : '>=22.10' };
    writeFileSync(join(cell, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, engines, bin: { cotal: 'dist/cotal.js' } }));
    writeFileSync(join(cell, 'payload/package/dist/cotal.js'), `#!/usr/bin/env node\nconsole.log('cotal-ai ${version}');\n`, { mode: 0o755 });
    const archive = join(cell, `${version}.tgz`);
    const packed = spawnSync('tar', ['-czf', archive, '-C', join(cell, 'payload'), 'package']);
    assert.equal(packed.status, 0);
    archives.set(version, readFileSync(archive));
  }
  let origin;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url?.endsWith('.tgz')) return response.end(archives.get(request.url.slice(1, -4)));
    const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, {
      name: 'cotal-ai', version, engines: { node: version === target ? range : '>=22.10' }, bin: { cotal: 'dist/cotal.js' },
      dist: { tarball: `${origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
    }]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: target }, versions }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const prefix = join(cell, 'prefix');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !/^npm_config_/i.test(key)));
  Object.assign(env, { HOME: join(cell, 'home'), XDG_CONFIG_HOME: join(cell, 'config'), XDG_RUNTIME_DIR: join(cell, 'runtime'), COTAL_HOME: join(cell, 'cotal'), TMPDIR: join(cell, 'tmp'), npm_config_prefix: prefix, npm_config_cache: join(cell, 'cache'), npm_config_registry: origin, npm_config_update_notifier: 'false', COTAL_NO_UPDATE_CHECK: '1', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', NO_COLOR: '1' });
  if (scenario === 'auto-unsupported') env.COTAL_AUTO_UPDATE = '1';
  const run = async (label, file, args) => {
    const child = spawn(file, args, { cwd: cell, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => output += bytes);
    child.stderr.on('data', bytes => output += bytes);
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      writeFileSync(join(cell, `${label}.log`), `${output}\nEXIT_CODE=${code}\n`);
      return { code, output };
    } finally { clearTimeout(timer); }
  };
  try {
    const installed = await run('install', 'npm', ['install', '-g', `cotal-ai@${previous}`]);
    assert.equal(installed.code, 0, installed.output);
    const packageRoot = join(prefix, 'lib/node_modules/cotal-ai');
    const before = readFileSync(join(packageRoot, 'package.json'), 'utf8');
    const entry = join(packageRoot, 'dist/cotal.js');
    const beforeEntry = readFileSync(entry, 'utf8');
    requests.length = 0;
    let argv = ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'bin/smoke/update-node-engine.fixture.ts')];
    let publicEntry, publicBefore;
    if (scenario === 'public-unsupported') {
      // The installed POSIX binary checks the engine before staging or its host process census.
      const cli = join(cell, 'cli/lib/node_modules/cotal-ai');
      cpSync(join(repo, 'bin/dist'), join(cli, 'dist'), { recursive: true });
      cpSync(join(repo, 'bin/package.json'), join(cli, 'package.json'));
      symlinkSync(join(repo, 'bin/node_modules'), join(cli, 'node_modules'), 'junction');
      publicEntry = join(cli, 'dist/cotal.js');
      publicBefore = readFileSync(publicEntry, 'utf8');
      argv = [publicEntry];
    }
    const update = await run('update', process.execPath, [...argv, 'update', '--self']);
    const selected = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    const version = await run('version-after', process.execPath, [entry, '--version']);
    if (publicEntry) {
      assert.equal(readFileSync(publicEntry, 'utf8'), publicBefore, 'the invoked binary was not replaced');
      const publicVersion = await run('public-version-after', process.execPath, [publicEntry, '--version']);
      assert.equal(publicVersion.code, 0, publicVersion.output);
      assert.equal(publicVersion.output.trim(), `cotal-ai ${previous}`);
    }
    writeFileSync(join(cell, 'observed.json'), JSON.stringify({ scenario, node: process.version, range, update, selected, version, requests }, null, 2));
    console.log(`${scenario}: update=${update.code}, selected=${selected}, version=${version.code}`);
    if (scenario === 'supported') {
      assert.equal(update.code, 0, update.output);
      assert.equal(selected, target);
      assert.match(update.output, /installed globally and reconciled/);
      assert(requests.includes(`/${target}.tgz`));
    } else {
      assert.notEqual(update.code, 0, update.output);
      assert.equal(selected, previous, 'incompatible or invalid engines must not replace the installed CLI');
      assert.equal(readFileSync(join(packageRoot, 'package.json'), 'utf8'), before);
      assert.equal(readFileSync(entry, 'utf8'), beforeEntry);
      assert.equal(requests.includes(`/${target}.tgz`), false, 'refuse before downloading the incompatible archive');
      assert.match(update.output, incompatible ? /requires Node\.js >=99\.0\.0.*current.*v\d+/ : /invalid.*engines\.node/);
      assert.doesNotMatch(update.output, /release is still reaching the registry|again in a few minutes/);
      assert.equal(existsSync(join(cell, 'cotal/update-recovery.json')), false, 'no replacement recovery journal was needed');
    }
    assert.equal(version.code, 0, version.output);
    assert.match(version.output, new RegExp(`cotal-ai ${selected.replaceAll('.', '\\.')}`));
    if (scenario === 'auto-unsupported') {
      const attempt = JSON.parse(readFileSync(join(cell, 'cotal/update-attempt.json'), 'utf8'));
      assert.equal(attempt.failures, 0, 'compatibility refusal never begins a replacement attempt');
      assert.equal(attempt.next, Number.MAX_SAFE_INTEGER, 'waiting cannot fix an incompatible runtime');
      assert.match(attempt.result, /requires Node\.js >=99\.0\.0/);
    }
    if (scenario === 'supported' || scenario === 'public-unsupported') {
      const strictPrefix = join(cell, 'strict-prefix');
      const strict = await run('strict-latest-install', 'npm', ['install', '-g', '--engine-strict', '--prefix', strictPrefix, 'cotal-ai@latest']);
      if (scenario === 'supported') {
        assert.equal(strict.code, 0, strict.output);
        assert.equal(JSON.parse(readFileSync(join(strictPrefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version, target);
      } else {
        assert.notEqual(strict.code, 0, strict.output);
        assert.match(strict.output, /EBADENGINE/);
        assert.equal(existsSync(join(strictPrefix, 'lib/node_modules/cotal-ai')), false, 'strict latest does not select the compatible old release');
      }
    }
    passed++;
  } finally { await new Promise(done => server.close(done)); }
}
emitSentinel({ passed, failed: 0 });
