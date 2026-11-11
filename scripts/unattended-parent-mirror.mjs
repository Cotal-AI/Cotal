import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publisherNpmrc } from './unattended-path-guards.mjs';
import { closureFromConfig } from './verify-publish-closure.mjs';
import { list as listTar } from 'tar';

export function verifyParentIntegrity(bytes, integrity) {
  assert(typeof integrity === 'string', 'upstream integrity required');
  const tokens = integrity.split(/\s+/).map(token => /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token)).filter(Boolean);
  assert(tokens.length, 'supported upstream SRI required');
  const algorithm = tokens.some(token => token[1] === 'sha512') ? 'sha512' : 'sha256';
  const digest = createHash(algorithm).update(bytes).digest('base64');
  assert(tokens.some(token => token[1] === algorithm && token[2] === digest), 'parent archive SRI mismatch');
}
export function parentArchiveManifest(file, name, version, registry) {
  let manifest, count = 0;
  listTar({ file, sync: true, strict: true, onReadEntry(entry) {
    if (entry.path !== 'package/package.json') { entry.resume(); return; }
    assert.equal(entry.type, 'File'); assert.equal(++count, 1);
    const chunks = []; let size = 0;
    entry.on('data', chunk => { size += chunk.length; assert(size < 1024 * 1024, 'oversized parent manifest'); chunks.push(chunk); });
    entry.on('end', () => { manifest = JSON.parse(Buffer.concat(chunks).toString()); });
  } });
  assert.equal(manifest?.name, name); assert.equal(manifest.version, version);
  assert(!manifest.publishConfig?.registry || manifest.publishConfig.registry === registry, 'unaltered parent tarball overrides private publication registry');
  return manifest;
}
export async function mirrorParents(c, root, env) {
  assert(Array.isArray(c.parentVersions) && c.parentVersions.length && new Set(c.parentVersions).size === c.parentVersions.length, 'explicit unique parentVersions required');
  assert(c.parentVersions.every(version => /^\d+\.\d+\.\d+$/.test(version) && version !== c.candidate), 'invalid parent version');
  publisherNpmrc(c.publishNpmrc);
  const directory = join(root, 'parents'); mkdirSync(directory, { mode: 0o700 });
  const command = (args, publish = false) => execFileSync('npm', args, { cwd: root, env: { ...env, npm_config_userconfig: publish ? c.publishNpmrc : env.npm_config_userconfig }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const latestBefore = command(['view', 'cotal-ai', 'dist-tags.latest', '--registry', c.registry]).trim();
  assert.equal(latestBefore, c.candidate, 'candidate latest must be established before parent mirroring');
  const rows = [];
  for (const version of c.parentVersions) {
    const pending = new Set(closureFromConfig(readFileSync(new URL('../.changeset/config.json', import.meta.url), 'utf8')));
    for (const name of pending) {
      const spec = `${name}@${version}`;
      const metadata = JSON.parse(command(['view', spec, '--json', '--registry=https://registry.npmjs.org/', '--fetch-retries=0', '--fetch-timeout=15000']));
      assert.equal(metadata.name, name); assert.equal(metadata.version, version);
      const origin = new URL(metadata.dist?.tarball);
      assert(origin.protocol === 'https:' && origin.hostname === 'registry.npmjs.org' && !origin.username && !origin.password && !origin.search && !origin.hash, 'unexpected parent archive origin');
      const response = await fetch(origin, { redirect: 'error', signal: AbortSignal.timeout(180000) });
      assert(response.ok, `parent download failed: ${spec}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(bytes.length < 200 * 1024 * 1024, 'oversized parent archive');
      verifyParentIntegrity(bytes, metadata.dist.integrity);
      const archive = `${name.replaceAll('/', '-')}-${version}.tgz`, file = join(directory, archive);
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      const manifest = parentArchiveManifest(file, name, version, c.registry);
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.deepEqual(manifest[field], metadata[field], 'upstream metadata and archive dependency policy differ');
        for (const [dependency, range] of Object.entries(manifest[field] ?? {})) if (dependency.startsWith('@cotal-ai/')) {
          assert(/^@cotal-ai\/[a-z0-9][a-z0-9._-]*$/.test(dependency));
          assert(field === 'peerDependencies' || range === version, 'parent closure has skewed dependency'); pending.add(dependency);
        }
      }
      rows.push({ name, version, archive, origin: origin.href, integrity: metadata.dist.integrity, sha256: createHash('sha256').update(bytes).digest('hex'), metadata, state: 'not-started' });
    }
  }
  const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ registry: c.registry, packages: rows }, null, 2) + '\n', { mode: 0o600 });
  save();
  // Download and inspect every parent closure before the first private write.
  for (const row of rows.sort((a, b) => Number(a.name === 'cotal-ai') - Number(b.name === 'cotal-ai'))) {
    const file = join(directory, row.archive), bytes = readFileSync(file);
    verifyParentIntegrity(bytes, row.integrity);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    parentArchiveManifest(file, row.name, row.version, c.registry);
    try {
      const present = JSON.parse(command(['view', `${row.name}@${row.version}`, '--json', '--registry', c.registry]));
      assert.equal(present.name, row.name); assert.equal(present.version, row.version);
      assert.equal(present.dist?.integrity, row.integrity, 'existing private parent differs from authenticated upstream archive');
      const tags = JSON.parse(command(['view', row.name, 'dist-tags', '--json', '--registry', c.registry]));
      assert.equal(tags[`parent-${row.version}`], row.version, 'existing identical parent lacks its expected tag, inspect before retry');
      row.state = 'already-verified'; save(); continue;
    } catch (error) {
      // Only a registry E404 proves that a new write is appropriate.
      assert(/E404/.test(String(error.stderr ?? '')), 'cannot prove parent absent or identical, inspect private registry before retry');
    }
    row.state = 'publishing'; save();
    try {
      const output = command(['publish', file, '--registry', c.registry, '--userconfig', c.publishNpmrc, '--ignore-scripts', '--provenance=false', '--tag', `parent-${row.version}`, '--access=public'], true);
      writeFileSync(join(directory, `${row.archive}.publish.log`), output, { flag: 'wx', mode: 0o600 });
      row.state = 'accepted'; save();
      assert.equal(command(['view', 'cotal-ai', 'dist-tags.latest', '--registry', c.registry]).trim(), latestBefore, 'parent mirroring changed candidate latest');
    } catch (error) { row.state = 'unknown'; save(); throw error; }
  }
  assert.equal(command(['view', 'cotal-ai', 'dist-tags.latest', '--registry', c.registry]).trim(), latestBefore, 'candidate latest changed during parent mirroring');
}
