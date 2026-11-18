import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSentinel, skipSuite } from './sentinel.mjs';

if (process.platform !== 'linux' && process.platform !== 'darwin') skipSuite('private global npm prefix requires POSIX');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(join(tmpdir(), 'update-node-engine-'));
const current = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const target = '99.0.0';
const nodeMajor = Number(process.versions.node.split('.')[0]);
const incompatible = `>=${nodeMajor + 1}.0.0`;
const compatible = `>=${nodeMajor}.0.0 <${nodeMajor + 1}.0.0`;
const archives = new Map<string, Buffer>();
let engine = compatible;
let origin: string;
process.umask(0o077);
for (const directory of ['payload/package/dist', 'home', 'config', 'cotal', 'runtime', 'tmp', 'prefix', '.cotal', 'native']) {
  mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
}
for (const command of ['systemctl', 'launchctl', 'schtasks']) {
  writeFileSync(join(root, 'native', command), '#!/bin/sh\necho "unexpected native service command" >&2\nexit 99\n', { mode: 0o755 });
}
// The test has no Managers. Keep the CLI's install-wide census away from host argv.
const isolation = join(root, 'isolation.mjs');
writeFileSync(isolation, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readdir = fs.readdirSync, read = fs.readFileSync;
fs.readdirSync = function(path, ...args) { return String(path) === '/proc' ? [] : readdir.call(this, path, ...args); };
fs.readFileSync = function(path, ...args) {
  if (/^\\/proc\\/[^/]+\\/(cmdline|environ)$/.test(String(path))) throw new Error('host process inspection is forbidden in this smoke');
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
function pack(version: string): void {
  writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' },
    ...(version === target ? { engines: { node: engine } } : {}) }));
  writeFileSync(join(root, 'payload/package/dist/cotal.js'), `#!/usr/bin/env node
if (${version === target} && Number(process.versions.node.split('.')[0]) < ${engine === incompatible ? nodeMajor + 1 : nodeMajor}) {
  console.error('cotal-ai requires Node.js ${engine}'); process.exit(1);
}
console.log('cotal-ai ${version}');
`, { mode: 0o755 });
  const packed = spawnSync('tar', ['-czf', join(root, `${version}.tgz`), '-C', join(root, 'payload'), 'package']);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  archives.set(version, readFileSync(join(root, `${version}.tgz`)));
}
pack(current);
pack(target);
const server = createServer((request, response) => {
  if (request.url?.endsWith('.tgz')) return response.end(archives.get(request.url.slice(1, -4)));
  const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, {
    name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' },
    ...(version === target ? { engines: { node: engine } } : {}),
    dist: { tarball: `${origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
  }]));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: target }, versions }));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COTAL_') && !name.toLowerCase().startsWith('npm_config_')));
const env = { ...clean, NODE_OPTIONS: `--import=${isolation}`, PATH: `${join(root, 'native')}:${clean.PATH}`, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: join(root, 'runtime'), COTAL_HOME: join(root, 'cotal'), TMPDIR: join(root, 'tmp'),
  npm_config_registry: origin, npm_config_prefix: join(root, 'prefix'), npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
const run = (file: string, args: string[]) => new Promise<{ code: number | null; output: string }>((done, reject) => {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => output += bytes);
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); done({ code, output }); });
});
const records: { scenario: string; code: number | null; output: string }[] = [];
try {
  const installed = await run('npm', ['install', '-g', `cotal-ai@${current}`]);
  assert.equal(installed.code, 0, installed.output);
  const packageRoot = join(root, 'prefix/lib/node_modules/cotal-ai');
  const before = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  writeFileSync(join(packageRoot, 'preserve'), 'unchanged');
  // Exercise the positive control first, so a baseline rejection cannot hide a broken harness.
  const control = await run(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
  writeFileSync(join(root, 'compatible.log'), control.output);
  records.push({ scenario: 'compatible', ...control });
  assert.equal(control.code, 0, control.output);
  assert.match(control.output, /installed globally and reconciled/);
  assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, target);
  const strictControl = await run('npm', ['install', '-g', 'cotal-ai@latest', '--engine-strict']);
  assert.equal(strictControl.code, 0, strictControl.output);
  const restore = await run('npm', ['install', '-g', `cotal-ai@${current}`]);
  assert.equal(restore.code, 0, restore.output);
  writeFileSync(join(packageRoot, 'preserve'), 'unchanged');
  engine = incompatible;
  pack(target);
  const strictRefusal = await run('npm', ['install', '-g', 'cotal-ai@latest', '--engine-strict', '--prefer-online']);
  writeFileSync(join(root, 'strict-install.log'), strictRefusal.output);
  assert.equal(strictRefusal.code, 1, strictRefusal.output);
  assert.match(strictRefusal.output, /EBADENGINE/);
  assert.equal(readFileSync(join(packageRoot, 'package.json'), 'utf8'), before);
  const refused = await run(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
  writeFileSync(join(root, 'incompatible.log'), refused.output);
  records.push({ scenario: 'incompatible', ...refused });
  writeFileSync(join(root, 'observed.json'), JSON.stringify({ revision: process.env.COTAL_TEST_REVISION, node: process.version, engine, records }, null, 2));
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.output, /requires Node\.js/);
  assert.ok(refused.output.includes(incompatible), refused.output);
  assert.doesNotMatch(refused.output, /release is still reaching the registry|installed globally|Saving update recovery snapshot/);
  assert.equal(readFileSync(join(packageRoot, 'package.json'), 'utf8'), before);
  assert.equal(readFileSync(join(packageRoot, 'preserve'), 'utf8'), 'unchanged');
  const recovery = join(root, 'cotal/update-recovery.json');
  assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, 'utf8')) : null, null);
  const stillRuns = await run(process.execPath, [join(packageRoot, 'dist/cotal.js'), '--version']);
  assert.equal(stillRuns.code, 0, stillRuns.output);
  assert.equal(stillRuns.output.trim(), `cotal-ai ${current}`);
  console.log('compatible target installed and reconciled; incompatible target refused before replacement; previous entry still runs');
  emitSentinel({ passed: 4, failed: 0 });
} finally {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  console.log(`Retained Node engine evidence: ${root}`);
}
