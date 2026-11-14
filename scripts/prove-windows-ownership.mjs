import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [harnessRoot, candidate, product, output] = process.argv.slice(2).map(value => resolve(value));
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
mkdirSync(output, { recursive: true });
const manifest = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
assert.equal(manifest.source, '968309d61e7a430e0b9163337c0a6b053aeacf9f');
assert.equal(manifest.packages.length, 24);
const version = manifest.packages.find(p => p.name === 'cotal-ai').version;
assert.ok(manifest.packages.every(p => p.version === version));
const { candidateRegistry } = await import(pathToFileURL(join(harnessRoot, 'scripts/automatic-update-platform-baseline.mjs')).href);
const registry = await candidateRegistry(candidate, 'B', 'https://registry.npmjs.org');
const report = { source: manifest.source, version, registry: registry.identity, calls: [], suites: [] };
const save = () => writeFileSync(join(output, 'proof.json'), JSON.stringify(report, null, 2));
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
assert.ok(existsSync(npmCli), 'use the installed Node distribution npm CLI');
async function call(label, file, args, options = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => child.kill(), 600_000);
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); }).finally(() => clearTimeout(timer));
  report.calls.push({ label, startedAt, endedAt: new Date().toISOString(), ...result, stdout, stderr }); save();
  assert.equal(result.signal, null, `${label}: terminated`);
  assert.equal(result.code, 0, `${label}: ${stderr.slice(-3000)}\n${stdout.slice(-3000)}`);
  return stdout;
}
const prefixes = [];
let completed = false;
try {
  for (const [label, selected, npmRegistry] of [['published', '0.164.6', 'https://registry.npmjs.org'], ['fixed', version, registry.url]]) {
    const prefix = join(process.env.RUNNER_TEMP, `ownership-${label}`);
    const env = { ...process.env, npm_config_registry: npmRegistry, npm_config_cache: join(process.env.RUNNER_TEMP, `ownership-cache-${label}`), COTAL_SKIP_CONNECTOR_SEED: '1' };
    await call(`${label}-install`, process.execPath, [npmCli, 'install', '-g', '--prefix', prefix, `cotal-ai@${selected}`], { env });
    prefixes.push({ prefix, env });
    const pkg = join(prefix, 'node_modules', 'cotal-ai');
    assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, selected);
    if (label === 'fixed') {
      const expected = manifest.packages.find(p => p.name === 'cotal-ai').files['dist/daemon/ownership-win32.js'];
      assert.equal(createHash('sha256').update(readFileSync(join(pkg, 'dist/daemon/ownership-win32.js'))).digest('hex'), expected);
    }
    await call(`${label}-timing`, process.execPath, [resolve('scripts/measure-windows-ownership.mjs'), 'run', pkg, output, label], { env });
    if (label === 'fixed') {
      const fixtureEnv = { ...env, COTAL_TEST_REAL_SERVICE: '1', COTAL_TEST_PACKAGE_ROOT: pkg };
      try {
        await call('daemon-install-real.smoke.mjs', process.execPath, [join(product, 'bin/smoke/daemon-install-real.smoke.mjs')], { env: fixtureEnv });
      } finally {
        const result = join(process.env.RUNNER_TEMP, 'daemon-service-result.json');
        if (existsSync(result)) writeFileSync(join(output, 'daemon-service-result.json'), readFileSync(result));
      }
      report.suites.push({ name: 'daemon-install-real.smoke.mjs', passed: true }); save();
      for (const suite of ['daemon-ownership-imports.smoke.ts', 'daemon-ownership-win32.smoke.ts', 'daemon-install-native.smoke.ts']) {
        await call(suite, process.execPath, [join(product, 'node_modules/tsx/dist/cli.mjs'), join(product, 'bin/smoke', suite)], { env });
        report.suites.push({ name: suite, passed: true }); save();
      }
    }
  }
  completed = true;
} finally {
  try {
    if (completed) for (const { prefix, env } of prefixes.reverse()) await call('package-uninstall', process.execPath, [npmCli, 'uninstall', '-g', '--prefix', prefix, 'cotal-ai'], { env });
    else report.retainedPrefixes = prefixes.map(p => p.prefix);
  } finally { await registry.close(); save(); }
}
