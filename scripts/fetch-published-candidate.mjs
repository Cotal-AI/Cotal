#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { list } from 'tar';
import { isMainEntry } from './main-entry.mjs';

const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const expected = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat().sort();
function publicUrl(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port && !url.username && !url.password && !url.hash, 'only public npm HTTPS URLs are allowed');
  return url.href;
}

/** Fetch published bytes, not a Git attestation of npm's contents. The caller binds release H. */
export async function fetchPublishedCandidate({ version, source, sourceRoot, output, fetch: request = globalThis.fetch, exec = execFileSync } = {}) {
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'stable version required');
  assert.match(source ?? '', /^[a-f0-9]{40}$/, 'immutable source H required');
  assert(sourceRoot && output, 'sourceRoot and output required');
  const root = realpathSync(resolve(sourceRoot));
  output = resolve(output);
  assert(!existsSync(output), 'output must not exist');
  const git = args => String(exec('git', args, { cwd: root, encoding: 'utf8' })).trim();
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), root, 'source must be Git root');
  assert.equal(git(['rev-parse', 'HEAD']), source, 'source checkout must match H');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']), '', 'source must be clean');
  assert.equal(expected.length, 24);
  assert.equal(new Set(expected).size, 24);
  const staging = mkdtempSync(join(dirname(output), `.${basename(output)}-`));
  const save = (name, value) => writeFileSync(join(staging, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const get = async url => {
    const response = await request(publicUrl(url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
    assert(response.ok, `npm request failed: ${url}: ${response.status}`);
    if (response.url) publicUrl(response.url);
    return response;
  };
  try {
    const manifest = { source, packages: [] };
    for (const [index, name] of expected.entries()) {
      const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
      const metadata = await (await get(registryUrl)).json();
      assert.equal(metadata.name, name, 'npm package identity');
      assert.equal(metadata.version, version, 'npm exact version');
      const { integrity, shasum, tarball } = metadata.dist ?? {};
      assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, 'sha512 SRI required');
      assert.match(shasum ?? '', /^[a-f0-9]{40}$/, 'sha1 shasum required');
      const bytes = Buffer.from(await (await get(tarball)).arrayBuffer());
      assert.equal(`sha512-${digest(bytes, 'sha512', 'base64')}`, integrity, 'npm tarball SRI mismatch');
      assert.equal(digest(bytes, 'sha1'), shasum, 'npm tarball sha1 mismatch');
      const archive = `${index}.tgz`, file = join(staging, archive);
      writeFileSync(file, bytes, { flag: 'wx' });
      const files = {};
      let sourceManifest;
      await list({ file, strict: true, onReadEntry(entry) {
        assert(entry.path.startsWith('package/'), 'archive must use package prefix');
        const member = entry.path.slice(8);
        assert(!member.includes('\\') && !member.split('/').some(part => part === '..' || part === '.') && !member.startsWith('/'), 'unsafe archive member');
        if (entry.type === 'Directory') { entry.resume(); return; }
        assert.equal(entry.type, 'File', 'unsupported archive entry');
        assert(member && !Object.hasOwn(files, member), 'duplicate archive member');
        files[member] = null;
        const hash = createHash('sha256'), chunks = [];
        let size = 0;
        entry.on('data', chunk => {
          size += chunk.length;
          assert(size <= (member === 'package.json' ? 1024 * 1024 : 64 * 1024 * 1024), 'archive entry too large');
          hash.update(chunk);
          if (member === 'package.json') chunks.push(chunk);
        });
        entry.on('end', () => {
          files[member] = hash.digest('hex');
          if (member === 'package.json') sourceManifest = Buffer.concat(chunks).toString('utf8');
        });
      } });
      const packed = JSON.parse(sourceManifest);
      assert.equal(packed.name, name, 'packed package name');
      assert.equal(packed.version, version, 'packed package version');
      assert(Object.keys(files).some(file => file.startsWith('dist/')), 'built distribution required');
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [dependency, range] of Object.entries(packed[field] ?? {})) {
          if (expected.includes(dependency)) assert(range === version || (field === 'peerDependencies' && (range === '*' || (range === '>=0.1.0' && version.split('.').slice(0, 2).some(part => Number(part) > 0)))), `first-party dependency must be lockstep or an explicit compatible peer: ${name}/${field}/${dependency}=${range}`);
        }
      }
      manifest.packages.push({ name, version, archive, sha256: digest(bytes), files, sourceManifest,
        published: { registryUrl, tarball, integrity, shasum } });
    }
    assert.equal(git(['rev-parse', 'HEAD']), source, 'source H changed');
    assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']), '', 'source changed during fetch');
    const installer = readFileSync(join(root, 'install.sh'));
    writeFileSync(join(staging, 'installer.sh'), installer, { flag: 'wx' });
    save('installer.json', { source, sha256: digest(installer) });
    save('bootstrap.json', { source, version, label: 'published npm bytes', sourceEvidence: 'Caller-bound release source H. npm archive bytes are not a Git source attestation.' });
    save('manifest.json', manifest);
    assert(!existsSync(output), 'output appeared during fetch');
    renameSync(staging, output);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, source: { type: 'string' }, 'source-root': { type: 'string' }, output: { type: 'string' } } });
  await fetchPublishedCandidate({ version: values.version, source: values.source, sourceRoot: values['source-root'], output: values.output });
}
