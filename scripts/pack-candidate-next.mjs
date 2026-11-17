#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { inspectCandidateArchive } from './inspect-candidate-archive.mjs';
import { isMainEntry } from './main-entry.mjs';

export const NEXT_PATCH_OFFSET = 1000;
export const FOLLOW_ON_PATCH_OFFSET = 2000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const phase = (label, work) => {
  console.log(`Candidate next: ${label} started`);
  const start = performance.now();
  try {
    const result = work();
    console.log(`Candidate next: ${label} completed in ${((performance.now() - start) / 1000).toFixed(3)}s`);
    return result;
  } catch (error) {
    console.log(`Candidate next: ${label} failed after ${((performance.now() - start) / 1000).toFixed(3)}s`);
    throw error;
  }
};

export function nextCandidateVersion(version, offset = NEXT_PATCH_OFFSET) {
  assert([NEXT_PATCH_OFFSET, FOLLOW_ON_PATCH_OFFSET].includes(offset), 'offset must be 1000 or 2000');
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'A must have a stable numeric version');
  const parts = version.split('.').map(Number);
  assert(parts.every(Number.isSafeInteger) && Number.isSafeInteger(parts[2] + offset), 'version exceeds safe ordering');
  return `${parts[0]}.${parts[1]}.${parts[2] + offset}`;
}

// The caller supplies a separate clean checkout at A.source, installed dependencies,
// and the normal assembled seat/workspace native closure and receipts. This does
// not download, assemble or start native services. Source-owned guards remain mandatory.
export async function packCandidateNext({ sourceRoot, candidate, output, offset = NEXT_PATCH_OFFSET, exec = execFileSync } = {}) {
  assert(sourceRoot && candidate && output, 'sourceRoot, candidate and output are required');
  offset = Number(offset);
  assert([NEXT_PATCH_OFFSET, FOLLOW_ON_PATCH_OFFSET].includes(offset), 'offset must be 1000 or 2000');
  const root = realpathSync(resolve(sourceRoot));
  candidate = realpathSync(resolve(candidate));
  output = join(realpathSync(resolve(output, '..')), resolve(output).split(/[\\/]/).at(-1));
  assert(!inside(root, candidate) && !inside(root, output) && !inside(candidate, output) && !inside(output, candidate), 'source, A and B must be separate directories');
  assert(!existsSync(output), 'B output must not exist');
  const run = (file, args, options = {}) => exec(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  const git = args => String(run('git', args)).trim();
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), root, 'source must be the Git root');
  const source = git(['rev-parse', '--verify', 'HEAD']);
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']), '', 'source inputs must be clean before stamping');
  const expected = json(join(root, '.changeset/config.json')).fixed.flat().sort();
  assert.equal(expected.length, 24, 'expected all 24 fixed-group packages');
  assert.equal(new Set(expected).size, 24);
  const verify = (directory, version) => {
    const bytes = readFileSync(join(directory, 'manifest.json'));
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.source, source, 'candidate source must match source H');
    assert.deepEqual(manifest.packages.map(pkg => pkg.name).sort(), expected, 'complete 24-package closure');
    for (const pkg of manifest.packages) {
      assert.equal(pkg.version, version, 'lockstep candidate version');
      assert.match(pkg.archive, /^[^/\\]+\.tgz$/);
      assert.equal(sha(readFileSync(join(directory, pkg.archive))), pkg.sha256, `archive hash ${pkg.name}`);
      const { metadata, files } = inspectCandidateArchive(join(directory, pkg.archive), 32 * 1024 * 1024);
      assert.equal(metadata.name, pkg.name);
      assert.equal(metadata.version, version);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(metadata[field] ?? {})) {
          if (expected.includes(name)) assert(range === version || (field === 'peerDependencies' && (range === '*' || (range === '>=0.1.0' && version.split('.').slice(0, 2).some(part => Number(part) > 0)))), `packed fixed-group dependency ${pkg.name}/${field}/${name}=${range}`);
        }
      }
      assert.equal(pkg.files?.['package.json'], files['package.json'], 'package metadata file hash');
      assert(pkg.files && Object.keys(pkg.files).some(name => name.startsWith('dist/')), 'built distribution hashes required');
      for (const [name, hash] of Object.entries(pkg.files)) {
        assert(!name.split('/').includes('..') && !isAbsolute(name) && !name.includes('\\'), 'safe archive member');
        assert.equal(files[name], hash, `file hash ${pkg.name}/${name}`);
      }
      assert.deepEqual(Object.keys(files).sort(), Object.keys(pkg.files).sort(), `archive member census ${pkg.name}`);
      const stamped = JSON.parse(pkg.sourceManifest);
      assert.equal(stamped.name, pkg.name);
      assert.equal(stamped.version, version);
    }
    const bootstrap = json(join(directory, 'bootstrap.json'));
    assert.equal(bootstrap.source, source);
    assert.equal(bootstrap.version, version);
    const installer = json(join(directory, 'installer.json'));
    assert.equal(installer.source, source);
    assert.equal(installer.sha256, sha(readFileSync(join(directory, 'installer.sh'))));
    assert.equal(installer.sha256, sha(readFileSync(join(root, 'install.sh'))), 'installer must match source H');
    return { manifest, sha256: sha(bytes), bootstrapSha256: sha(readFileSync(join(directory, 'bootstrap.json'))), installerSha256: sha(readFileSync(join(directory, 'installer.json'))) };
  };
  const aVersion = json(join(candidate, 'manifest.json')).packages?.[0]?.version;
  const version = nextCandidateVersion(aVersion, offset);
  const a = phase('verify A', () => verify(candidate, aVersion));
  const rows = JSON.parse(run('pnpm', ['list', '-r', '--include-workspace-root', '--depth', '-1', '--json']));
  const manifests = rows.map(row => {
    const path = realpathSync(join(row.path, 'package.json'));
    assert(inside(root, path), 'workspace manifest must belong to source checkout');
    return { path, original: readFileSync(path, 'utf8') };
  });
  assert.deepEqual(manifests.map(row => JSON.parse(row.original).name).filter(name => expected.includes(name)).sort(), expected);
  const guards = () => {
    for (const pkg of ['seat', 'workspace']) run(process.execPath, [join(root, 'packages', pkg, 'scripts/assert-shipped-natives.mjs')], { stdio: 'inherit' });
  };
  phase('native guards before build', guards);
  const changes = [];
  try {
    for (const row of manifests) {
      const before = JSON.parse(row.original), after = structuredClone(before);
      if (expected.includes(before.name)) after.version = version;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(after[field] ?? {})) {
          if (expected.includes(name) && !after[field][name].startsWith('workspace:')) after[field][name] = version;
        }
      }
      changes.push({ path: row.path, before, after });
      writeFileSync(row.path, JSON.stringify(after, null, 2) + '\n');
    }
    const guardedExec = (file, args, options) => exec(file, args, { ...options, env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'warn', PNPM_CONFIG_WORKSPACE_CONCURRENCY: '3' } });
    phase(`build ${version}`, () => guardedExec('pnpm', ['--workspace-concurrency', '3', 'build'], { cwd: root, stdio: 'inherit', timeout: 1_800_000 }));
    phase('native guards after build', guards);
    assert.equal(git(['rev-parse', 'HEAD']), source, 'source HEAD changed during build');
    const { packColdCandidate } = await import(pathToFileURL(join(root, 'scripts/pack-cold-candidate.mjs')).href);
    const manifest = phase(`pack ${version}`, () => packColdCandidate({ root, output, exec: guardedExec }));
    assert.equal(manifest.source, source);
    copyFileSync(join(root, 'install.sh'), join(output, 'installer.sh'));
    save(join(output, 'installer.json'), { source, sha256: sha(readFileSync(join(output, 'installer.sh'))) });
    save(join(output, 'bootstrap.json'), { source, version, label: 'candidate-only version metadata; no installed file edits; never publish', changes });
    const b = phase('verify output', () => verify(output, version));
    assert.notEqual(a.sha256, b.sha256, 'distinct A/B manifests required');
    assert.deepEqual(phase('recheck unchanged A', () => verify(candidate, aVersion)), a, 'A must remain unchanged');
    save(join(output, 'next.json'), { source, rule: `A.patch+${offset}`, offset, candidate: { version: aVersion, manifestSha256: a.sha256 }, next: { version, manifestSha256: b.sha256 } });
    return manifest;
  } finally {
    for (const row of manifests) writeFileSync(row.path, row.original);
  }
}

if (isMainEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { 'source-root': { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' }, offset: { type: 'string' } } });
  await packCandidateNext({ sourceRoot: values['source-root'], candidate: values.candidate, output: values.output, ...(values.offset === undefined ? {} : { offset: Number(values.offset) }) });
}
