import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packCandidateNext, nextCandidateVersion, NEXT_PATCH_OFFSET, FOLLOW_ON_PATCH_OFFSET } from './pack-candidate-next.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const source = 'a'.repeat(40);
function fixture(t, failure, offset = NEXT_PATCH_OFFSET) {
  const expectedVersion = offset === FOLLOW_ON_PATCH_OFFSET ? '1.2.2003' : '1.2.1003';
  const base = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'candidate-next-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'source'), candidate = join(base, 'A'), output = join(base, 'B');
  for (const path of [root, candidate, join(root, '.changeset'), join(root, 'scripts')]) mkdirSync(path, { recursive: true });
  const names = Array.from({ length: 24 }, (_, i) => `pkg${i}`);
  save(join(root, '.changeset/config.json'), { fixed: [names] });
  writeFileSync(join(root, 'install.sh'), 'installer');
  const rows = names.map((name, i) => {
    const path = join(root, name); mkdirSync(path);
    save(join(path, 'package.json'), { name, version: '1.2.3', dependencies: { [names[(i + 1) % 24]]: '1.2.3' } });
    return { name, path };
  });
  const originals = rows.map(row => readFileSync(join(row.path, 'package.json'), 'utf8'));
  const make = (dir, version) => {
    const packages = names.map((name, i) => {
      const metadata = { name, version, peerDependencies: { [names[(i + 1) % 24]]: i % 2 ? '>=0.1.0' : '*' }, dependencies: { [names[(i + 1) % 24]]: version } };
      const files = { 'package.json': JSON.stringify(metadata), 'dist/index.js': `version=${version}` };
      const archive = `${name}.tgz`;
      save(join(dir, archive), files);
      return { name, version, archive, sha256: hash(readFileSync(join(dir, archive))), files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, hash(value)])), sourceManifest: JSON.stringify(metadata) };
    });
    const manifest = { source, packages };
    save(join(dir, 'manifest.json'), manifest);
    return manifest;
  };
  make(candidate, '1.2.3');
  save(join(candidate, 'bootstrap.json'), { source, version: '1.2.3' });
  writeFileSync(join(candidate, 'installer.sh'), 'installer');
  save(join(candidate, 'installer.json'), { source, sha256: hash('installer') });
  // Deliberately synthetic pack adapter. Real source-owned pack/prepublish and native
  // guards are not executed by this test, and require the core-owned pack runner.
  writeFileSync(join(root, 'scripts/pack-cold-candidate.mjs'), `export function packColdCandidate(options) { return options.exec('synthetic-pack', [], options); }`);
  const calls = [];
  const exec = (file, args, options) => {
    calls.push([file, args]);
    if (file === 'git') {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'status') return failure === 'dirty' ? ' M tracked' : '';
      return failure === 'source' ? 'b'.repeat(40) : source;
    }
    if (file === 'tar') {
      const files = JSON.parse(readFileSync(args[1]));
      const value = files[args[2].slice('package/'.length)];
      return options.encoding === 'buffer' ? Buffer.from(value) : value;
    }
    if (file === 'pnpm' && args[0] === 'list') return JSON.stringify(rows);
    if (file === 'pnpm') {
      assert.deepEqual(args, ['--workspace-concurrency', '3', 'build']);
      for (const row of rows) {
        const info = JSON.parse(readFileSync(join(row.path, 'package.json')));
        assert.equal(info.version, expectedVersion);
        assert(Object.values(info.dependencies).every(value => value === expectedVersion));
      }
      if (failure === 'build') throw new Error('build failed');
      return '';
    }
    if (file === 'synthetic-pack') {
      if (failure === 'pack') throw new Error('pack failed');
      mkdirSync(options.output); return make(options.output, expectedVersion);
    }
    assert.equal(file, process.execPath);
    assert(args[0].startsWith(join(realpathSync(root), 'packages')));
    if (failure === 'native') throw new Error('source native guard failed');
    return '';
  };
  return { root, candidate, output, rows, originals, calls, exec };
}

test('deterministic patch offset and stable safe numeric ordering', () => {
  assert.equal(NEXT_PATCH_OFFSET, 1000);
  assert.equal(FOLLOW_ON_PATCH_OFFSET, 2000);
  assert.equal(nextCandidateVersion('0.164.10'), '0.164.1010');
  assert.equal(nextCandidateVersion('0.164.10', FOLLOW_ON_PATCH_OFFSET), '0.164.2010');
  for (const version of ['1.2.3-beta', '01.2.3', '1.2.9007199254740991', 'latest']) assert.throws(() => nextCandidateVersion(version));
  assert.throws(() => nextCandidateVersion('0.164.10', 3000));
});

test('synthetic full contract stamps before build, preserves A, restores source', async t => {
  for (const offset of [NEXT_PATCH_OFFSET, FOLLOW_ON_PATCH_OFFSET]) {
    const f = fixture(t, undefined, offset);
    const before = readFileSync(join(f.candidate, 'manifest.json'));
    const manifest = await packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, offset, exec: f.exec });
    assert.equal(manifest.packages.length, 24);
    assert.deepEqual(readFileSync(join(f.candidate, 'manifest.json')), before);
    for (const [i, row] of f.rows.entries()) assert.equal(readFileSync(join(row.path, 'package.json'), 'utf8'), f.originals[i]);
    assert.equal(JSON.parse(readFileSync(join(f.output, 'next.json'))).rule, `A.patch+${offset}`);
    assert.equal(f.calls.filter(([file]) => file === process.execPath).length, 4);
  }
});

for (const failure of ['dirty', 'source', 'build', 'native', 'pack']) test(`refuses ${failure} and restores manifests`, async t => {
  const f = fixture(t, failure);
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec }));
  for (const [i, row] of f.rows.entries()) assert.equal(readFileSync(join(row.path, 'package.json'), 'utf8'), f.originals[i]);
});

test('rejects tampered A archive before build', async t => {
  const f = fixture(t);
  writeFileSync(join(f.candidate, 'pkg0.tgz'), 'tampered');
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec }), /archive hash/);
  assert(!f.calls.some(([file, args]) => file === 'pnpm' && args.includes('build')));
});
