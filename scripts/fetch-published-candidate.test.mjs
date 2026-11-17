import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { fetchPublishedCandidate } from './fetch-published-candidate.mjs';

const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat().sort();
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const source = 'a'.repeat(40), version = '0.164.11';
async function fixture(t, failure) {
  const version = failure === 'peer-floor' ? '0.0.9' : '0.164.11';
  const base = realpathSync(mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'published-candidate-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'source'), output = join(base, 'A');
  mkdirSync(root); writeFileSync(join(root, 'install.sh'), 'source installer\n');
  const responses = new Map(), archives = new Map(), calls = [];
  for (const [index, name] of names.entries()) {
    const dir = join(base, String(index));
    mkdirSync(join(dir, 'package/dist'), { recursive: true });
    const info = { name, version, dependencies: { [names[(index + 1) % names.length]]: failure === 'dependency' && index === 0 ? '0.0.1' : version } };
    info.peerDependencies = { [names[(index + 1) % names.length]]: failure === 'peer-range' ? '>=0.2.0' : failure === 'peer-exact' ? '0.164.9' : index % 2 || failure === 'peer-floor' ? '>=0.1.0' : '*' };
    if (failure === 'runtime-floor') info.dependencies[names[(index + 1) % names.length]] = '>=0.1.0';
    if (failure === 'runtime-wildcard') info.dependencies[names[(index + 1) % names.length]] = '*';
    writeFileSync(join(dir, 'package/package.json'), JSON.stringify(info));
    writeFileSync(join(dir, 'package/dist/index.js'), `export const version = '${version}';\n`);
    const file = join(dir, 'archive.tgz');
    await create({ cwd: dir, file, gzip: true }, ['package']);
    const bytes = readFileSync(file);
    archives.set(name, bytes);
    const tarball = `https://registry.npmjs.org/fixture/-/${index}.tgz`;
    responses.set(tarball, bytes);
    responses.set(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
      name: failure === 'name' && index === 0 ? 'wrong' : name, version,
      dist: { tarball: failure === 'private' && index === 0 ? 'https://example.com/private.tgz' : tarball,
        integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`, shasum: failure === 'sha1' && index === 0 ? '0'.repeat(40) : hash(bytes, 'sha1') },
    });
  }
  const request = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    const body = responses.get(url);
    assert(body, `unexpected URL ${url}`);
    if (failure === 'network') return new Response('offline', { status: 503 });
    if (Buffer.isBuffer(body)) return new Response(failure === 'sri' ? Buffer.from('tampered') : body);
    return Response.json(body);
  };
  const exec = (command, args) => {
    assert.equal(command, 'git');
    if (args.includes('--show-toplevel')) return root;
    if (args[0] === 'status') return failure === 'dirty' ? ' M file' : '';
    return failure === 'source' ? 'b'.repeat(40) : source;
  };
  return { base, root, output, archives, calls, options: { source, version, sourceRoot: root, output, fetch: request, exec } };
}

test('synthetic public URL responses preserve all 24 real TGZ fixture bytes and file identities without rebuilding', async t => {
  const f = await fixture(t);
  const manifest = await fetchPublishedCandidate(f.options);
  assert.equal(manifest.source, source);
  assert.deepEqual(manifest.packages.map(row => row.name), names);
  assert.equal(f.calls.length, 48);
  for (const pkg of manifest.packages) {
    assert.deepEqual(readFileSync(join(f.output, pkg.archive)), f.archives.get(pkg.name));
    assert.equal(pkg.sha256, hash(f.archives.get(pkg.name)));
    assert.equal(pkg.files['package.json'], hash(pkg.sourceManifest));
    assert.equal(JSON.parse(pkg.sourceManifest).version, version);
    assert.match(pkg.published.integrity, /^sha512-/);
  }
  assert.equal(JSON.parse(readFileSync(join(f.output, 'bootstrap.json'))).label, 'published npm bytes');
  assert.equal(JSON.parse(readFileSync(join(f.output, 'installer.json'))).sha256, hash(readFileSync(join(f.output, 'installer.sh'))));
  await assert.rejects(fetchPublishedCandidate(f.options), /must not exist/);
});

for (const failure of ['name', 'private', 'sha1', 'sri', 'dependency', 'runtime-wildcard', 'runtime-floor', 'peer-floor', 'peer-range', 'peer-exact', 'network', 'dirty', 'source']) {
  test(`synthetic ${failure} rejection leaves no partial A`, async t => {
    const f = await fixture(t, failure);
    await assert.rejects(fetchPublishedCandidate(f.options));
    assert(!existsSync(f.output));
    assert(!readdirSync(f.base).some(name => name.startsWith('.A-')));
  });
}
