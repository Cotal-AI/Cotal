#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
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
const binary = join(native, 'binaries', `cotal-node-${target}${process.platform === 'win32' ? '.exe' : ''}`);
if (existsSync(output) || existsSync(binary)) throw new Error('A staged desktop runtime already exists. Use a clean build checkout; a possibly running runtime is never replaced.');
if (!existsSync(join(repo, 'bin', 'dist', 'cotal.js')) || !existsSync(join(repo, 'bin', 'seeded-connectors'))) throw new Error('Build the workspace and run pnpm --filter cotal-ai seeded-connectors first.');
const version = JSON.parse(readFileSync(join(repo, 'bin', 'package.json'), 'utf8')).version;
const staging = mkdtempSync(join(native, '.runtime-stage-'));
const deploy = join(staging, 'runtime');
const result = spawnSync(process.execPath, [pnpm, '--filter', 'cotal-ai', '--config.node-linker=hoisted', 'deploy', '--prod', '--ignore-scripts', deploy], { cwd: repo, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`pnpm deploy failed; retained staging is ${staging}`);
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
const probe = spawnSync(process.execPath, [join(deploy, 'dist', 'cotal.js'), '--version'], {
  encoding: 'utf8', timeout: 30_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))),
});
if (probe.status !== 0 || !probe.stdout.trim().startsWith(`cotal-ai ${version}`)) throw new Error('The deployed stock CLI did not report the expected version.');
writeFileSync(join(deploy, 'desktop-runtime.json'), JSON.stringify({ schema: 1, version, target, node: process.versions.node, files: hashes }, null, 2) + '\n');
mkdirSync(dirname(binary), { recursive: true });
cpSync(process.execPath, binary, { errorOnExist: true, force: false });
renameSync(deploy, output);
console.log(`Prepared stock cotal-ai ${version} and Node ${process.versions.node} for ${target}. No service was installed or started.`);
