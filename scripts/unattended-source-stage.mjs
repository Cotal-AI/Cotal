import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { closureFromConfig } from './verify-publish-closure.mjs';

export function stageSource(c, evidence, env) {
  const sourceRoot = resolve(import.meta.dirname, '..');
  const destination = resolve(c.sourceDirectory);
  assert(destination.startsWith('/home/david/f26/tmp/u6385/') && realpathSync(dirname(destination)) === dirname(destination), 'source copy must be physical owned u6385 TMP');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', source], { cwd: sourceRoot, encoding: 'utf8' }).trim().split('\n');
  const archive = execFileSync('git', ['archive', '--format=tar', source], { cwd: sourceRoot, maxBuffer: 128 * 1024 * 1024 });
  mkdirSync(destination, { mode: 0o700 });
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
  const names = closureFromConfig(readFileSync(join(destination, '.changeset/config.json'), 'utf8'));
  const rows = [];
  for (const path of paths.filter(path => path.endsWith('/package.json'))) {
    const file = join(destination, path), original = readFileSync(file);
    const info = JSON.parse(original);
    if (!names.includes(info.name)) continue;
    assert(!info.private, 'fixed public group contains private package');
    info.version = c.candidate;
    // Keep workspace protocols: pnpm resolves them to this version during its normal pack.
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) for (const [name, range] of Object.entries(info[field] ?? {})) {
      if (names.includes(name) && !range.startsWith('workspace:')) info[field][name] = c.candidate;
    }
    info.publishConfig = { ...info.publishConfig, registry: c.registry, provenance: false };
    const prepared = JSON.stringify(info, null, 2) + '\n';
    writeFileSync(file, prepared);
    rows.push({ name: info.name, path, beforeSha256: createHash('sha256').update(original).digest('hex'), afterSha256: createHash('sha256').update(prepared).digest('hex') });
  }
  assert.deepEqual(rows.map(row => row.name).sort(), names);
  // A minimal local Git identity lets the unchanged cold packer record the immutable source.
  // The staged manifests remain uncommitted release metadata, never a substitute source commit.
  execFileSync('git', ['init', '--quiet', destination], { env });
  execFileSync('git', ['-C', destination, 'fetch', '--quiet', '--no-tags', sourceRoot, source], { env });
  execFileSync('git', ['-C', destination, 'update-ref', 'HEAD', source], { env });
  execFileSync('git', ['-C', destination, 'read-tree', source], { env });
  writeFileSync(join(evidence, 'source-stage.json'), JSON.stringify({ source, destination, candidate: c.candidate, archiveSha256: createHash('sha256').update(archive).digest('hex'), changedManifests: rows }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Staged ${rows.length} release manifests at ${destination}. Coordinator: run normal pnpm install to synchronize the lockfile, then build, assemble verified natives, and prepare.`);
}
