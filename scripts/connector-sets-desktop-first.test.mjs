import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireHostedLinux, parseOptions, inside, preparedRuntime, stableDistinctRoots, ownedProcessCensus, matchedSet, measureDesktopFirst } from './connector-sets-desktop-first.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
function scratch(t) { const root = mkdtempSync(join(tmpdir(), 'desktop-first-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function put(root, path, value) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
test('admission requires both hosted markers and Linux', () => {
  requireHostedLinux(hosted, 'linux');
  for (const [env, platform] of [[{}, 'linux'], [hosted, 'darwin'], [{ GITHUB_ACTIONS: 'true' }, 'linux']]) assert.throws(() => requireHostedLinux(env, platform));
});
test('nonhosted measurement refuses before input resolution or writes', async () => {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  await assert.rejects(measureDesktopFirst(null), /requires disposable/);
});
test('options are explicit, complete and unique', () => {
  const args = ['cli-candidate', 'desktop-runtime', 'desktop-candidate-A', 'desktop-next', 'desktop-node', 'output'].flatMap(key => [`--${key}`, `/owned/${key}`]);
  assert.equal(parseOptions(args)['desktop-next'], '/owned/desktop-next');
  assert.throws(() => parseOptions(args.slice(0, -2)), /missing/);
  assert.throws(() => parseOptions([...args, '--output', '/other']), /unique/);
  assert.throws(() => parseOptions(['--wat', '/x']), /unique/);
});
test('containment excludes root and traversal', () => {
  assert(inside('/a', '/a/b')); assert(!inside('/a', '/a')); assert(!inside('/a', '/ab')); assert(!inside('/a', '/b'));
});
test('prepared product receipt checks hashes, core and entry inventory', t => {
  const root = scratch(t);
  put(root, 'package.json', { version: '0.1.0' }); put(root, 'node_modules/@cotal-ai/core/package.json', { version: '0.1.0' }); put(root, 'dist/cotal.js', 'stock');
  const receipt = { schema: 1, version: '0.1.0', target: 'x86_64-unknown-linux-gnu', node: '24.1.0', files: [{ path: 'dist/cotal.js', sha256: createHash('sha256').update('stock').digest('hex') }] };
  put(root, 'desktop-runtime.json', receipt);
  assert.equal(preparedRuntime(root).version, '0.1.0');
  put(root, 'dist/cotal.js', 'changed'); assert.throws(() => preparedRuntime(root), /hash/);
  receipt.files[0].path = '../escape'; put(root, 'desktop-runtime.json', receipt); assert.throws(() => preparedRuntime(root), /inventory path/);
});
test('desktop identity stays stable but distinct from CLI across changed sets', () => {
  const cli = { id: 'a' }, before = { id: 'b', version: '1', root: '/one' }, after = { id: 'b', version: '2', root: '/two' };
  assert(stableDistinctRoots(cli, before, after));
  assert(!stableDistinctRoots({ id: 'b' }, before, after));
  assert(!stableDistinctRoots(cli, before, { ...after, id: 'c' }));
  assert(!stableDistinctRoots(cli, before, { ...after, version: '1' }));
});
test('extension inventory requires installed first-party/core match', t => {
  const root = scratch(t); put(root, 'extensions.json', { extensions: [{ pkg: '@cotal-ai/pi', version: '1' }] });
  put(root, 'node_modules/@cotal-ai/pi/package.json', { version: '1' }); put(root, 'node_modules/@cotal-ai/pi/node_modules/@cotal-ai/core/package.json', { version: '1' });
  assert.equal(matchedSet({ root, id: 'a', version: '1' }, '1').extensions.length, 1);
  put(root, 'node_modules/@cotal-ai/pi/package.json', { version: '2' }); assert.throws(() => matchedSet({ root, id: 'a', version: '1' }, '1'), /skew/);
});
test('process census only attributes cwd inside owned root, without reading foreign command lines', t => {
  const proc = scratch(t);
  for (const [pid, cwd] of [['1', '/owned/project'], ['2', '/owned-other/project']]) {
    mkdirSync(join(proc, pid));
    symlinkSync(cwd, join(proc, pid, 'cwd'));
    put(proc, `${pid}/stat`, `${pid} (node) S`);
  }
  assert.deepEqual(ownedProcessCensus('/owned', proc).map(row => row.pid), [1]);
});
