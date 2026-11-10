#!/usr/bin/env node
// Run `pnpm build` first, then:
// node bin/smoke/build-daemon-upgrade-fixture.mjs <new-output-directory>
// Both private fixture versions contain the SAME current source, not historical releases.
// Requires installed workspace dependencies, pnpm, npm and the local TypeScript compiler.
// Deployment is offline. --workspace-source copies the installed workspace dependency closure.
// Native dependencies remain specific to the build host.
// No cleanup is performed on failure: retain the output for inspection, then use a new path.
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const versions = ['0.151.2', '0.151.3'];
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || args[0].startsWith('-') || (args[1] !== undefined && args[1] !== '--workspace-source')) {
  throw new Error('Usage: node bin/smoke/build-daemon-upgrade-fixture.mjs <new-output-directory> [--workspace-source] (run pnpm build first)');
}
const out = resolve(args[0]);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function stat(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function run(command, argv, cwd = repo) {
  execFileSync(command, argv, { cwd, stdio: 'inherit', env: process.env });
}

// Resolve package names from this checkout, never from the lane's output tree.
const workspace = new Map();
for (const group of ['packages', 'extensions', 'implementations']) {
  for (const entry of readdirSync(join(repo, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(repo, group, entry.name);
    if (stat(join(root, 'package.json'))) workspace.set(json(join(root, 'package.json')).name, root);
  }
}
for (const name of ['@cotal-ai/cli', '@cotal-ai/auth']) {
  if (!stat(join(workspace.get(name), 'dist'))) throw new Error(`Missing ${name} dist. Run pnpm build first.`);
}
// Exclusive mkdir rejects existing directories AND symlinks, including dangling ones.
// All descendants below are created by this invocation. Never merge into an old tree.
mkdirSync(out);
const fromWorkspace = args[1] === '--workspace-source';
const deployed = fromWorkspace ? join(repo, 'bin') : join(out, 'deployment');
if (!fromWorkspace) run('pnpm', ['--filter', 'cotal-ai', 'deploy', '--legacy', '--prod', '--offline', deployed]);

function locate(root, name) {
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (stat(join(candidate, 'package.json'))) {
      const target = realpathSync(candidate);
      if (!fromWorkspace && !target.startsWith(`${realpathSync(deployed)}${sep}`)) throw new Error(`Dependency escapes deployment: ${candidate}`);
      if (fromWorkspace && !target.startsWith(`${realpathSync(repo)}${sep}`)) throw new Error(`Dependency escapes workspace install: ${candidate}`);
      return target;
    }
    // Stop at the explicitly selected source boundary, never borrow host dependencies.
    if (dir === out || (fromWorkspace && dir === repo)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
const closure = new Map();
const graph = new Map();
function collect(root) {
  if (graph.has(root)) return;
  const edges = new Map();
  graph.set(root, edges);
  const meta = json(join(root, 'package.json'));
  const deps = { ...meta.peerDependencies, ...meta.dependencies, ...meta.optionalDependencies };
  for (const name of Object.keys(deps)) {
    const src = locate(root, name);
    if (!src) {
      if (name in (meta.optionalDependencies ?? {}) || meta.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`Missing deployed dependency ${name} required by ${meta.name}`);
    }
    const previous = closure.get(name);
    if (previous && previous !== src && workspace.has(name)) {
      throw new Error(`Cannot hoist multiple first-party copies of ${name}: ${previous} and ${src}`);
    }
    edges.set(name, src);
    if (!previous) closure.set(name, src);
    collect(src);
  }
}
collect(deployed);

// Copy each entry once. Symlinks are copied verbatim, never traversed. No writes
// occur beneath copied links. Manifests and replacement dist trees are excluded
// before copying, so subsequent writes always target fresh, owned regular files.
function copyTree(src, dst, skip = new Set()) {
  const info = lstatSync(src);
  if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dst);
  } else if (info.isDirectory()) {
    mkdirSync(dst);
    for (const name of readdirSync(src)) {
      if (name === 'node_modules' || skip.has(name)) continue;
      copyTree(join(src, name), join(dst, name));
    }
  } else if (info.isFile()) {
    copyFileSync(src, dst, 1 /* COPYFILE_EXCL */);
  } else {
    throw new Error(`Unsupported package entry: ${src}`);
  }
}
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
function copyPackage(src, dst, version, isRoot = false, nested = []) {
  const meta = json(join(src, 'package.json'));
  const local = workspace.get(meta.name);
  const freshDist = local && stat(join(local, 'dist'));
  if (local && !freshDist) throw new Error(`Missing ${meta.name} dist. Run pnpm build first.`);
  copyTree(src, dst, new Set(['package.json', ...(isRoot || freshDist ? ['dist'] : [])]));
  if (freshDist) {
    if (!freshDist.isDirectory() || freshDist.isSymbolicLink()) throw new Error(`Expected regular dist directory: ${local}`);
    copyTree(join(local, 'dist'), join(dst, 'dist'));
    const current = json(join(local, 'package.json'));
    if (current.exports !== undefined) meta.exports = current.exports;
  }
  delete meta.devDependencies;
  delete meta.scripts;
  if (isRoot) {
    const payload = join(dst, 'seeded-connectors');
    for (const entry of readdirSync(payload, { withFileTypes: true })) {
      const manifest = join(payload, entry.name, 'package.json');
      if (!entry.isDirectory() || !stat(manifest)) continue;
      const connector = json(manifest);
      connector.version = version;
      writeFileSync(manifest, `${JSON.stringify(connector, null, 2)}\n`);
    }
  }
  if (isRoot || local) meta.version = version;
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(meta[key] ?? {})) meta[key][name] = '*';
  }
  if (isRoot) {
    meta.private = true;
    meta.dependencies = Object.fromEntries([...closure.keys()].sort().map((name) => [name, '*']));
    meta.bundledDependencies = [...closure.keys()].sort();
    delete meta.bundleDependencies;
  }
  if (!isRoot && nested.length) {
    meta.bundledDependencies = nested;
    delete meta.bundleDependencies;
  }
  writeJson(join(dst, 'package.json'), meta);
}
const artifacts = [];
for (const version of versions) {
  const build = join(out, `hoisted-fix2-${version}`);
  copyPackage(deployed, build, version, true);
  mkdirSync(join(build, 'node_modules'));
  // Hoist one default per name, then materialize only conflicting edges under
  // their consumer. The inherited map models Node's nearest node_modules lookup.
  // Reusing an ancestor's identical copy also terminates dependency cycles.
  function materialize(src, dst, inherited) {
    const visible = new Map(inherited);
    const nested = [];
    for (const [name, dependency] of graph.get(src)) {
      if (visible.get(name) !== dependency) {
        nested.push(name);
        visible.set(name, dependency);
      }
    }
    copyPackage(src, dst, version, false, nested);
    for (const name of nested) {
      const child = join(dst, 'node_modules', name);
      mkdirSync(dirname(child), { recursive: true });
      materialize(visible.get(name), child, visible);
    }
  }
  for (const [name, src] of closure) {
    const dst = join(build, 'node_modules', name);
    mkdirSync(dirname(dst), { recursive: true });
    materialize(src, dst, closure);
  }
  run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(repo, 'bin/tsconfig.json'), '--outDir', join(build, 'dist')]);
  run('npm', ['pack', '--ignore-scripts', '--offline', '--pack-destination', out], build);
  const tgz = join(out, `cotal-ai-${version}.tgz`);
  if (!stat(tgz)?.isFile()) throw new Error(`npm pack did not produce ${tgz}`);
  artifacts.push({ version, build, tgz });
}
console.log(JSON.stringify({ sameSource: true, privateFixtures: true, artifacts }, null, 2));
