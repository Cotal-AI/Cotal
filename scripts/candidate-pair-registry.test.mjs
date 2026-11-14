import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { candidatePairRegistry } from './candidate-pair-registry.mjs';

const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat();
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'candidate-pair-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const dirs = [join(root, 'a'), join(root, 'b')];
  const manifests = [];
  for (const [index, dir] of dirs.entries()) {
    mkdirSync(dir);
    const version = index ? '0.164.1010' : '0.164.10';
    const manifest = { source: 'a'.repeat(40), packages: [] };
    for (const [i, name] of names.entries()) {
      const staging = join(dir, String(i));
      mkdirSync(join(staging, 'package/dist'), { recursive: true });
      writeFileSync(join(staging, 'package/package.json'), JSON.stringify({ name, version, type: 'module' }));
      writeFileSync(join(staging, 'package/dist/index.js'), `export const version = '${version}';\n`);
      const archive = `${i}.tgz`;
      await create({ cwd: staging, file: join(dir, archive), gzip: true }, ['package']);
      manifest.packages.push({ name, version, archive, sha256: hash(readFileSync(join(dir, archive))),
        files: Object.fromEntries(['package.json', 'dist/index.js'].map(file => [file, hash(readFileSync(join(staging, 'package', file)))])) });
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    manifests.push(manifest);
  }
  return { dirs, manifests, cleanup };
}

test('real public metadata plus 48 original archives, explicit recovery selectors and controlled latest', { timeout: 180000 }, async t => {
  const { dirs, manifests, cleanup } = await fixture();
  // The composed registry deliberately refuses local upstreams. This is a real
  // public npm metadata test, not an offline network substitute or native proof.
  let registry;
  t.after(async () => { try { await registry?.close(); } finally { cleanup(); } });
  registry = await candidatePairRegistry(...dirs);
  const get = async path => {
    const response = await fetch(`${registry.url}/${path}`, { signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  assert.deepEqual(registry.identity, {
    source: 'a'.repeat(40), sourceVersion: '0.164.10', targetVersion: '0.164.1010',
    sourceManifestSha256: hash(readFileSync(join(dirs[0], 'manifest.json'))),
    targetManifestSha256: hash(readFileSync(join(dirs[1], 'manifest.json'))),
    sourceArchives: manifests[0].packages.map(({ name, sha256 }) => ({ name, sha256 })),
    targetArchives: manifests[1].packages.map(({ name, sha256 }) => ({ name, sha256 })),
    sourcePackages: manifests[0].packages, targetPackages: manifests[1].packages,
  });
  for (const active of ['0.164.10', '0.164.1010']) {
    for (const name of names) {
      const path = encodeURIComponent(name), metadata = await get(path);
      assert.equal(metadata['dist-tags'].latest, active);
      assert.equal((await get(`${path}/latest`)).version, active);
      for (const [i, manifest] of manifests.entries()) {
        const pkg = manifest.packages.find(pkg => pkg.name === name);
        const selected = await get(`${path}/${pkg.version}`);
        assert.deepEqual(selected, metadata.versions[pkg.version]);
        assert.equal(selected.name, name);
        assert.match(selected.dist.tarball, /^http:\/\/127\.0\.0\.1:\d+\/__candidate\//);
        const response = await fetch(selected.dist.tarball);
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(bytes, readFileSync(join(dirs[i], pkg.archive)));
        assert.equal(hash(bytes), pkg.sha256);
        assert.equal(selected.dist.integrity, `sha512-${hash(bytes, 'sha512', 'base64')}`);
        assert.equal(selected.dist.shasum, hash(bytes, 'sha1'));
      }
    }
    for (const selector of ['0.0.999999', 'A', 'B']) {
      assert.equal((await fetch(`${registry.url}/cotal-ai/${selector}`)).status, 404);
    }
    registry.activateTarget();
  }
  assert.equal((await fetch(`${registry.url}/cotal-ai/0.0.999999`)).status, 404);
  assert.equal((await fetch(`${registry.url}/cotal-ai`, { method: 'PUT', body: '{}' })).status, 405);
  assert(registry.requests.some(row => row.path === 'cotal-ai/0.164.10'));
  await registry.close();
  await registry.close();
  assert.throws(() => registry.activateTarget(), /closing/);
});

test('rejects source, census, ordering, version, archive hash and nonpublic upstream mismatches', async t => {
  const { dirs, manifests, cleanup } = await fixture();
  t.after(cleanup);
  const original = structuredClone(manifests[1]);
  async function reject(change, pattern) {
    const value = structuredClone(original);
    change(value);
    writeFileSync(join(dirs[1], 'manifest.json'), JSON.stringify(value));
    await assert.rejects(candidatePairRegistry(...dirs), pattern);
  }
  await reject(m => { m.source = 'b'.repeat(40); }, /share source/);
  await reject(m => { m.packages.pop(); }, /census/);
  await reject(m => { m.packages[0] = m.packages[1]; }, /census/);
  await reject(m => { m.packages[0].version = '0.164.1011'; }, /lockstep/);
  await reject(m => { for (const p of m.packages) p.version = '0.164.9'; }, /patch\+1000/);
  await reject(m => { for (const p of m.packages) p.version = '0.164.11'; }, /patch\+1000/);
  await reject(m => { m.packages[0].sha256 = '0'.repeat(64); }, /archive hash/);
  writeFileSync(join(dirs[1], 'manifest.json'), JSON.stringify(original));
  await assert.rejects(candidatePairRegistry(...dirs, 'http://127.0.0.1:1/'), /public registry/);
});
