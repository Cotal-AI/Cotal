#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = dirname(root);
const native = join(root, 'src-tauri');
const output = join(native, 'runtime');
const triples = {
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
};
const target = triples[`${process.platform}-${process.arch}`];
if (!target || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Build the desktop runtime on a supported native target using Node 24 LTS.');
const pnpm = process.env.npm_execpath;
if (!pnpm || !isAbsolute(pnpm) || !existsSync(pnpm)) throw new Error('Run this script through pnpm prepare:runtime.');
const sidecar = process.platform === 'win32' ? 'node' : 'cotal-node';
const binary = join(native, 'binaries', `${sidecar}-${target}${process.platform === 'win32' ? '.exe' : ''}`);
if (existsSync(output) || existsSync(binary)) throw new Error('A staged desktop runtime already exists. Use a clean build checkout; a possibly running runtime is never replaced.');
if (!existsSync(join(repo, 'bin', 'dist', 'cotal.js')) || !existsSync(join(repo, 'bin', 'seeded-connectors'))) throw new Error('Build the workspace and run pnpm --filter cotal-ai seeded-connectors first.');
const version = JSON.parse(readFileSync(join(repo, 'bin', 'package.json'), 'utf8')).version;
const staging = mkdtempSync(join(native, '.runtime-stage-'));
const deploy = join(staging, 'runtime');
const result = spawnSync(process.execPath, [pnpm, '--filter', 'cotal-ai', '--config.node-linker=hoisted', 'deploy', '--prod', '--ignore-scripts', deploy], { cwd: repo, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`pnpm deploy failed; retained staging is ${staging}`);

function traceEsm(entry) {
  const visited = new Set();
  if (!existsSync(entry)) return visited;
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const src = readFileSync(cur, 'utf8');
    for (const match of src.matchAll(/(?:(?:import|export)\s+[^"']*from\s+|import\s+)["']([^"']+)["']/g)) {
      if (match[1].startsWith('.')) {
        const next = resolve(dirname(cur), match[1]);
        if (existsSync(next) && statSync(next).isFile()) queue.push(next);
      }
    }
  }
  return visited;
}
const esToolkitKeep = traceEsm(join(deploy, 'node_modules', 'es-toolkit', 'dist', 'compat', 'index.mjs'));

function shouldPruneFile(rel, abs) {
  if (rel.startsWith('seeded-connectors/')) return false;
  if (rel.startsWith('node_modules/@cotal-ai/cli/cotal-skills/')) return false;
  if (rel.startsWith('node_modules/@eplightning/nats-server-')) return true;
  const base = basename(rel);
  const lower = base.toLowerCase();
  if (rel.endsWith('.map') || rel.endsWith('.d.ts') || rel.endsWith('.d.mts') || rel.endsWith('.d.cts') || rel.endsWith('.pdb') || rel.endsWith('.tsbuildinfo')) return true;
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return true;
  if (!rel.startsWith('node_modules/')) return false;
  if (/\/(test|tests|__tests__|spec)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]s$/.test(base)) return true;
  if (rel.endsWith('.ts') || rel.endsWith('.tsx') || rel.endsWith('.mts') || rel.endsWith('.cts') || rel.endsWith('.c') || rel.endsWith('.cc') || rel.endsWith('.cpp') || rel.endsWith('.h') || rel.endsWith('.hpp')) return true;
  if (rel.startsWith('node_modules/@cotal-ai/workspace/scripts/')) return true;
  if (rel.startsWith('node_modules/ses/dist/') || rel.startsWith('node_modules/ses/src-xs/')) return true;
  if (rel.startsWith('node_modules/@modelcontextprotocol/sdk/dist/cjs/')) return true;
  if (rel.startsWith('node_modules/es-toolkit/') && rel !== 'node_modules/es-toolkit/package.json' && rel !== 'node_modules/es-toolkit/LICENSE' && !esToolkitKeep.has(abs)) return true;
  return false;
}

function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(deploy, abs).split(sep).join('/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      prune(abs);
      if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
    } else if (entry.isFile() && shouldPruneFile(rel, abs)) {
      rmSync(abs, { force: true });
    }
  }
}
prune(deploy);

const contained = (path) => { const r = relative(deploy, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const hashes = [];
function inspect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path)) || !contained(realpathSync(path))) throw new Error(`Deployed dependency escapes its packaged closure: ${relative(deploy, path)}`);
    } else if (entry.isDirectory()) inspect(path);
    else if (entry.isFile()) hashes.push({ path: relative(deploy, path).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    else throw new Error('The deployment contains a non-file resource.');
  }
}
inspect(deploy);
mkdirSync(dirname(binary), { recursive: true });
const stagedBinary = join(staging, basename(binary));
cpSync(process.execPath, stagedBinary, { errorOnExist: true, force: false });
if (process.platform === 'darwin' || process.platform === 'linux') {
  chmodSync(stagedBinary, 0o755);
  const stripArgs = process.platform === 'darwin' ? ['-x', stagedBinary] : ['--strip-unneeded', stagedBinary];
  const stripped = spawnSync('strip', stripArgs, { encoding: 'utf8' });
  if (stripped.status !== 0) throw new Error(`strip failed for bundled Node: ${stripped.stderr || stripped.stdout}`);
}
const probe = spawnSync(stagedBinary, [join(deploy, 'dist', 'cotal.js'), '--version'], {
  encoding: 'utf8', timeout: 30_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))),
});
if (probe.status !== 0 || !probe.stdout.trim().startsWith(`cotal-ai ${version}`)) throw new Error('The deployed stock CLI did not report the expected version.');
writeFileSync(join(deploy, 'desktop-runtime.json'), JSON.stringify({ schema: 1, version, target, node: process.versions.node, files: hashes }, null, 2) + '\n');
renameSync(stagedBinary, binary);
renameSync(deploy, output);
rmSync(staging, { recursive: true, force: true });
console.log(`Prepared stock cotal-ai ${version} and Node ${process.versions.node} for ${target}. No service was installed or started.`);
