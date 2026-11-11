#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { list as listTar } from 'tar';
import { isMainEntry } from './main-entry.mjs';
import { mirrorParents } from './unattended-parent-mirror.mjs';
import { packColdCandidate } from './pack-cold-candidate.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function privateRegistry(value) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'registry must be a credential-free private HTTP origin');
  assert(/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname), 'registry must use an explicit private IPv4 address');
  return url.origin;
}
export function validateConfig(c) {
  assert(c.optIn === 'unattended-prepublish-6385', 'explicit opt-in required');
  privateRegistry(c.registry);
  assert(/^\d+\.\d+\.\d+$/.test(c.candidate), 'candidate must be a stable semver');
  assert(Array.isArray(c.allowHosts) && c.allowHosts.length && Array.isArray(c.machines) && c.machines.length, 'explicit host allowlist and machines required');
  for (const host of [...c.allowHosts, ...c.machines.map(m => m.host)]) assert(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) && !host.toLowerCase().includes('isaac24'), 'unsafe or forbidden host');
  assert(new Set(c.machines.map(m => m.host)).size === c.machines.length, 'duplicate machines');
  for (const m of c.machines) {
    assert(c.allowHosts.includes(m.host), 'machine outside explicit allowlist');
    assert(/^[a-z_][a-z0-9_-]*$/.test(m.user), 'explicit SSH user required');
    assert(m.existingMachine === 'authorized-disposable-6385' && m.user === 'ubuntu', 'explicit existing disposable machine authorization required');
    assert(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(m.hostname) && !m.hostname.toLowerCase().includes('isaac24'), 'expected fixture hostname required');
    for (const path of [m.root, m.prefix, m.cli, m.node]) assert(typeof path === 'string' && /^\/home\/ubuntu\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..'), 'paths must belong to disposable ubuntu account');
    assert.equal(m.unit, 'cotal-daemon.service', 'use the existing native daemon unit');
    assert(/^[a-zA-Z0-9_.@-]+\.service$/.test(m.unit) && !m.unit.includes('..'), 'explicit test unit required');
    assert(['success', 'rollback'].includes(m.mode) && /^\d+\.\d+\.\d+$/.test(m.parent), 'parent and success/rollback mode required');
    assert(m.parent !== c.candidate, 'candidate must differ from parent');
    const a = c.candidate.split('.').map(Number), b = m.parent.split('.').map(Number);
    assert(a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]), 'candidate must exceed parent');
  }
  assert(c.key?.startsWith('/') && c.knownHosts?.startsWith('/'), 'explicit SSH key and pinned known_hosts paths required');
  return c;
}
const exec = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 180000, ...options });
export function isolatedEnv(root) {
  return { PATH: process.env.PATH, HOME: join(root, 'home'), COTAL_HOME: join(root, 'home/.cotal'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: join(root, 'tmp'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), npm_config_cache: join(root, 'npm-cache') };
}
function prepare(c, root, env) {
  const original = join(root, 'original');
  const manifest = packColdCandidate({ output: original, exec: (file, args, options) => execFileSync(file, args, { ...options, env }) });
  const names = new Set(manifest.packages.map(p => p.name));
  const staged = [];
  const output = join(root, 'candidate'); mkdirSync(output);
  for (const pkg of manifest.packages) {
    const directory = join(root, 'stage', pkg.name.replaceAll('/', '-')); mkdirSync(directory, { recursive: true });
    assert.equal(sha256(readFileSync(join(original, pkg.archive))), pkg.sha256);
    exec('tar', ['-xzf', join(original, pkg.archive), '-C', directory]);
    const file = join(directory, 'package/package.json');
    const info = JSON.parse(readFileSync(file)); info.version = c.candidate;
    // Tarball publishConfig can override npm's CLI registry. Pin only the private copy.
    info.publishConfig = { ...info.publishConfig, registry: privateRegistry(c.registry), provenance: false };
    for (const [name, expected] of Object.entries(pkg.files)) if (name !== 'package.json') assert.equal(sha256(readFileSync(join(directory, 'package', name))), expected, `built bytes changed: ${pkg.name}/${name}`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(info[field] ?? {})) if (names.has(name)) info[field][name] = c.candidate;
    writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
    const result = JSON.parse(exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: dirname(file), env }));
    const archive = result[0].filename;
    const packedFiles = {};
    listTar({ file: join(output, archive), sync: true, strict: true, onReadEntry(entry) {
      if (entry.type === 'Directory') { entry.resume(); return; }
      assert.equal(entry.type, 'File');
      assert(entry.path.startsWith('package/') && !entry.path.split('/').includes('..'));
      const name = entry.path.slice(8), hash = createHash('sha256');
      assert(!Object.hasOwn(packedFiles, name)); packedFiles[name] = '';
      entry.on('data', chunk => hash.update(chunk));
      entry.on('end', () => { packedFiles[name] = hash.digest('hex'); });
    } });
    assert.deepEqual(Object.keys(packedFiles).sort(), Object.keys(pkg.files).sort(), 'repacking changed file census');
    for (const [name, expected] of Object.entries(pkg.files)) if (name !== 'package.json') assert.equal(packedFiles[name], expected, `repacking changed ${pkg.name}/${name}`);
    staged.push({ name: pkg.name, version: c.candidate, archive, sha256: sha256(readFileSync(join(output, archive))), originalSha256: pkg.sha256, files: packedFiles });
  }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ source: manifest.source, packages: staged }, null, 2) + '\n', { flag: 'wx' });
}
export async function main(action, configFile) {
  const c = validateConfig(JSON.parse(readFileSync(configFile)));
  const root = resolve(c.evidence);
  assert(root.startsWith('/home/david/f26/tmp/') && realpathSync(dirname(root)).startsWith('/home/david/f26/tmp/'), 'evidence must be on physical f26 TMP');
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  assert(realpathSync(root) === root, 'evidence root must not be a symlink');
  const env = isolatedEnv(root);
  for (const path of Object.values(env).filter(v => v?.startsWith(root) && !v.endsWith('npmrc'))) mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig]) if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  if (action === 'mirror-parents') return mirrorParents(c, root, env);
  if (action === 'prepare') return prepare(c, root, env);
  if (action === 'config') {
    const rules = "    access: $all\n    publish: $authenticated\n    unpublish: []\n";
    writeFileSync(join(root, 'verdaccio.yaml'), `storage: ./storage\nmax_body_size: 200mb\nauth:\n  htpasswd:\n    file: ./htpasswd\n    max_users: -1\nuplinks:\n  npmjs:\n    url: https://registry.npmjs.org/\npackages:\n  '@cotal-ai/*':\n${rules}  'cotal-ai':\n${rules}  '**':\n    access: $all\n    proxy: npmjs\nlog:\n  type: stdout\n  format: json\n  level: http\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Coordinator: run unchanged verdaccio --config ${join(root, 'verdaccio.yaml')} --listen ${new URL(c.registry).host} as a plain process on the private test network only.`);
    return;
  }
  if (action === 'publish') {
    assert(typeof c.publishNpmrc === 'string' && c.publishNpmrc.startsWith('/home/david/f26/tmp/'), 'coordinator-created private publish npmrc required');
    env.npm_config_userconfig = c.publishNpmrc;
    const directory = join(root, 'candidate');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
    for (const p of manifest.packages) {
      assert.equal(p.version, c.candidate); assert(/^[^/\\]+\.tgz$/.test(p.archive));
      assert.equal(sha256(readFileSync(join(directory, p.archive))), p.sha256);
    }
    for (const p of [...manifest.packages].sort((a, b) => Number(a.name === 'cotal-ai') - Number(b.name === 'cotal-ai'))) {
      const log = exec('npm', ['publish', join(directory, p.archive), '--ignore-scripts', '--registry', privateRegistry(c.registry), '--tag', 'latest', '--access', 'public'], { cwd: root, env });
      writeFileSync(join(root, `publish-${p.name.replaceAll('/', '-')}.log`), log, { flag: 'wx', mode: 0o600 });
    }
    return;
  }
  assert.equal(action, 'run', 'expected config, prepare, publish, or run');
  const script = readFileSync(new URL('./unattended-prepublish-remote.mjs', import.meta.url), 'utf8');
  const results = [];
  for (const machine of c.machines) {
    const payload = Buffer.from(JSON.stringify({ ...machine, candidate: c.candidate, registry: privateRegistry(c.registry) })).toString('base64');
    const log = join(root, `${machine.host}-${machine.mode}.log`);
    assert(!existsSync(log), 'refusing to overwrite evidence');
    try {
      const output = exec('ssh', ['-i', c.key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHosts}`, '-o', 'ConnectTimeout=15', `${machine.user}@${machine.host}`, `${machine.node} --input-type=module - ${payload}`], { input: script, timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(log, output, { mode: 0o600, flag: 'wx' }); results.push({ host: machine.host, passed: true, sha256: sha256(output) });
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}\n`;
      writeFileSync(log, output, { mode: 0o600, flag: 'wx' }); results.push({ host: machine.host, passed: false, sha256: sha256(output) });
    }
  }
  writeFileSync(join(root, 'results.json'), JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assert(results.every(r => r.passed), 'machine acceptance failed, inspect retained logs');
}
if (isMainEntry(import.meta.url)) main(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
