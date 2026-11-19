import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create as createTar, replace as replaceTar } from 'tar';
import { gzipSync } from 'node:zlib';
import { inspectCandidateArchive } from './inspect-candidate-archive.mjs';
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
      const input = join(base, 'archive-input');
      mkdirSync(join(input, 'dist'), { recursive: true });
      for (const [path, value] of Object.entries(files)) writeFileSync(join(input, path), value);
      createTar({ file: join(dir, archive), cwd: input, prefix: 'package', gzip: true, portable: true, sync: true }, Object.keys(files));
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
    assert(!f.calls.some(([file]) => file === 'tar'), 'each archive is inspected without per-member children');
  }
});

test('each expensive phase logs its start and measured completion', async t => {
  const f = fixture(t);
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  await packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec });
  const labels = ['verify A', 'native guards before build', 'build 1.2.1003', 'native guards after build', 'pack 1.2.1003', 'verify output', 'recheck unchanged A'];
  assert.equal(lines.length, labels.length * 2);
  for (const [i, label] of labels.entries()) {
    assert.equal(lines[i * 2], `Candidate next: ${label} started`);
    assert.match(lines[i * 2 + 1], new RegExp(`^Candidate next: ${label} completed in \\d+\\.\\d{3}s$`));
  }
});

test('a failed phase is named and never reported complete', async t => {
  const f = fixture(t, 'build');
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec }), /build failed/);
  assert.match(lines.at(-1), /^Candidate next: build 1\.2\.1003 failed after \d+\.\d{3}s$/);
  assert(!lines.some(line => line.includes('build 1.2.1003 completed')));
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

for (const [label, alter, expected] of [
  ['file hash', m => { m.packages[0].files['dist/index.js'] = '0'.repeat(64); }, /file hash/],
  ['omitted member', m => { delete m.packages[0].files['package.json']; }, /package metadata file hash/],
  ['unrecorded member', m => { m.packages[0].files = { 'package.json': m.packages[0].files['package.json'], 'dist/missing.js': hash('missing') }; }, /file hash/],
  ['incomplete closure', m => { m.packages.pop(); }, /complete 24-package closure/],
  ['unsafe manifest member', m => { m.packages[0].files['../escape'] = '0'.repeat(64); }, /safe archive member/],
]) test(`rejects ${label} before build`, async t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(join(f.candidate, 'manifest.json')));
  alter(manifest);
  save(join(f.candidate, 'manifest.json'), manifest);
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec }), expected);
  assert(!f.calls.some(([file, args]) => file === 'pnpm' && args.includes('build')));
});

test('rejects an archive member omitted from the recorded census', async t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(join(f.candidate, 'manifest.json')));
  const pkg = manifest.packages[0];
  const input = join(f.root, 'extra-input');
  mkdirSync(join(input, 'dist'), { recursive: true });
  writeFileSync(join(input, 'package.json'), pkg.sourceManifest);
  writeFileSync(join(input, 'dist/index.js'), 'version=1.2.3');
  writeFileSync(join(input, 'dist/extra.js'), 'unrecorded');
  const archive = join(f.candidate, pkg.archive);
  // Keep the archive hash valid without recording the extra member in the manifest.
  createTar({ file: archive, cwd: input, prefix: 'package', gzip: true, sync: true }, ['package.json', 'dist/index.js', 'dist/extra.js']);
  pkg.sha256 = hash(readFileSync(archive));
  save(join(f.candidate, 'manifest.json'), manifest);
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec: f.exec }), /archive member census/);
});

test('single-pass inspection retains long member names and refuses malformed archives', t => {
  const f = fixture(t);
  const input = join(f.root, 'inspection-input');
  mkdirSync(input);
  const long = 'long-name-'.repeat(15) + '.js';
  writeFileSync(join(input, 'package.json'), JSON.stringify({ name: 'probe' }));
  writeFileSync(join(input, long), 'distribution');
  const archive = join(f.root, 'probe.tgz');
  const options = { file: archive, cwd: input, prefix: 'package', gzip: true, sync: true };
  createTar(options, ['package.json', long]);
  const result = inspectCandidateArchive(archive);
  assert.equal(result.metadata.name, 'probe');
  assert.equal(result.files[long], hash('distribution'));
  assert.throws(() => inspectCandidateArchive(archive, 4), /inspection limit/);
  writeFileSync(archive, 'not an archive');
  assert.throws(() => inspectCandidateArchive(archive));

  for (const path of ['../escape', '/absolute', 'package/../escape', 'package/./alias', 'package/back\\slash']) {
    createTar({ ...options, onWriteEntry(entry) { entry.path = path; } }, [long]);
    assert.throws(() => inspectCandidateArchive(archive), /package prefix|unsafe archive member/);
  }
  createTar({ ...options, onWriteEntry(entry) { entry.type = 'SymbolicLink'; entry.linkpath = 'target'; } }, [long]);
  assert.throws(() => inspectCandidateArchive(archive), /unsupported archive entry/);

  const plain = archive + '.tar';
  const duplicate = { file: plain, cwd: input, prefix: 'package', sync: true };
  createTar(duplicate, ['package.json', long]);
  replaceTar(duplicate, ['package.json']);
  writeFileSync(archive, gzipSync(readFileSync(plain)));
  assert.throws(() => inspectCandidateArchive(archive), /repeated archive entry/);
});

test('output member hashes are verified and source is restored on refusal', async t => {
  const f = fixture(t);
  const exec = (file, args, options) => {
    const result = f.exec(file, args, options);
    if (file === 'synthetic-pack') {
      result.packages[0].files['dist/index.js'] = '0'.repeat(64);
      save(join(f.output, 'manifest.json'), result);
    }
    return result;
  };
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec }), /file hash/);
  for (const [i, row] of f.rows.entries()) assert.equal(readFileSync(join(row.path, 'package.json'), 'utf8'), f.originals[i]);
});

test('A is reverified after packing, including its archive hashes', async t => {
  const f = fixture(t);
  const exec = (file, args, options) => {
    const result = f.exec(file, args, options);
    if (file === 'synthetic-pack') writeFileSync(join(f.candidate, 'pkg0.tgz'), 'changed during pack');
    return result;
  };
  await assert.rejects(packCandidateNext({ sourceRoot: f.root, candidate: f.candidate, output: f.output, exec }), /archive hash/);
  for (const [i, row] of f.rows.entries()) assert.equal(readFileSync(join(row.path, 'package.json'), 'utf8'), f.originals[i]);
});
