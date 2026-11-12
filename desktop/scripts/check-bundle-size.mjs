#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = process.env.COTAL_DESKTOP_NATIVE_DIR || fileURLToPath(new URL('../src-tauri/', import.meta.url));
const release = join(native, 'target', 'release');
const bundle = join(release, 'bundle');

const CEILINGS = {
  installedFileMB: 195,
  installed4kMB: 210,
  runtimeFileMB: 62,
  runtime4kMB: 75,
  nodeBinaryMB: 112,
  desktopBinaryMB: 18,
  downloadInstallerMB: 75,
};

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).split(sep).join('/');
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      walk(abs, root, out);
    } else {
      const size = st.size;
      const blocks4k = size === 0 ? 0 : Math.ceil(size / 4096) * 4096;
      out.push({ rel, size, blocks4k });
    }
  }
  return out;
}

function findFirst(dir, pred) {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (pred(entry, abs)) return abs;
    if (entry.isDirectory()) {
      const found = findFirst(abs, pred);
      if (found) return found;
    }
  }
  return undefined;
}

let installedLabel;
let files = [];
let nodeSize = 0;
let desktopSize = 0;
let runtimeFiles = [];

if (process.platform === 'darwin') {
  const macosDir = join(bundle, 'macos');
  const app = readdirSync(macosDir).find((name) => name.endsWith('.app'));
  assert.ok(app, `no .app bundle found under ${macosDir}`);
  const appRoot = join(macosDir, app);
  installedLabel = `macOS ${process.arch} (${app})`;
  files = walk(appRoot);
  nodeSize = statSync(join(appRoot, 'Contents/MacOS/cotal-node')).size;
  desktopSize = statSync(join(appRoot, 'Contents/MacOS/cotal-desktop')).size;
  runtimeFiles = files
    .filter((f) => f.rel.startsWith('Contents/Resources/runtime/'))
    .map((f) => ({ ...f, rel: f.rel.slice('Contents/Resources/runtime/'.length) }));
} else if (process.platform === 'linux') {
  const debData = findFirst(join(bundle, 'deb'), (entry, abs) => entry.isDirectory() && entry.name === 'data' && existsSync(join(abs, 'usr/bin/cotal-desktop')));
  assert.ok(debData, `no unpacked deb data tree found under ${join(bundle, 'deb')}`);
  installedLabel = `Linux ${process.arch} (deb data/)`;
  files = walk(debData);
  nodeSize = statSync(join(debData, 'usr/bin/cotal-node')).size;
  desktopSize = statSync(join(debData, 'usr/bin/cotal-desktop')).size;
  runtimeFiles = files
    .filter((f) => f.rel.startsWith('usr/lib/Cotal/runtime/'))
    .map((f) => ({ ...f, rel: f.rel.slice('usr/lib/Cotal/runtime/'.length) }));
} else if (process.platform === 'win32') {
  installedLabel = `Windows ${process.arch} (release + staged runtime)`;
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const nodeBin = join(native, 'binaries', `node-${target}.exe`);
  const desktopBin = join(release, 'cotal-desktop.exe');
  nodeSize = statSync(nodeBin).size;
  desktopSize = statSync(desktopBin).size;
  runtimeFiles = walk(join(native, 'runtime'));
  files = [
    { rel: 'node.exe', size: nodeSize, blocks4k: Math.ceil(nodeSize / 4096) * 4096 },
    { rel: 'cotal-desktop.exe', size: desktopSize, blocks4k: Math.ceil(desktopSize / 4096) * 4096 },
    ...runtimeFiles.map((f) => ({ ...f, rel: `runtime/${f.rel}` })),
  ];
} else {
  throw new Error(`Unsupported platform: ${process.platform}`);
}

const installers = [];
for (const sub of ['dmg', 'deb', 'rpm', 'nsis', 'msi']) {
  const dir = join(bundle, sub);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(?:dmg|deb|rpm|exe|msi)$/.test(entry.name)) continue;
    installers.push({ name: `${sub}/${entry.name}`, size: statSync(join(dir, entry.name)).size });
  }
}
assert.ok(installers.length > 0, `no installer artifacts found under ${bundle}`);

const mb = (bytes) => bytes / 1e6;
const fmt = (bytes) => `${mb(bytes).toFixed(2).padStart(7)} MB`;

const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
const total4k = files.reduce((sum, f) => sum + f.blocks4k, 0);
const runtimeBytes = runtimeFiles.reduce((sum, f) => sum + f.size, 0);
const runtime4k = runtimeFiles.reduce((sum, f) => sum + f.blocks4k, 0);

const byItem = new Map();
const byItem4k = new Map();
const byItemCount = new Map();
for (const f of runtimeFiles) {
  let key = f.rel.split('/')[0];
  if (key === 'node_modules') {
    const parts = f.rel.slice('node_modules/'.length).split('/');
    key = `node_modules/${parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]}`;
  }
  byItem.set(key, (byItem.get(key) || 0) + f.size);
  byItem4k.set(key, (byItem4k.get(key) || 0) + f.blocks4k);
  byItemCount.set(key, (byItemCount.get(key) || 0) + 1);
}

console.log(`\n=== Desktop Bundle Size Report: ${installedLabel} ===`);
console.log(`Installed total:   ${fmt(totalBytes)} (4K-allocated: ${fmt(total4k)}, ${files.length} files) [ceiling: ${CEILINGS.installedFileMB} MB / ${CEILINGS.installed4kMB} MB 4K]`);
console.log(`Bundled Node:      ${fmt(nodeSize)} [ceiling: ${CEILINGS.nodeBinaryMB} MB]`);
console.log(`Tauri shell:       ${fmt(desktopSize)} [ceiling: ${CEILINGS.desktopBinaryMB} MB]`);
console.log(`Staged runtime:    ${fmt(runtimeBytes)} (4K-allocated: ${fmt(runtime4k)}, ${runtimeFiles.length} files) [ceiling: ${CEILINGS.runtimeFileMB} MB / ${CEILINGS.runtime4kMB} MB 4K]`);

console.log('\n--- Installer / Download Artifacts ---');
for (const inst of installers) {
  console.log(`  ${fmt(inst.size)}  ${inst.name} [ceiling: ${CEILINGS.downloadInstallerMB} MB]`);
}

console.log('\n--- Largest Runtime Items (by 4K-allocated size) ---');
for (const [key, b4k] of [...byItem4k.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const bytes = byItem.get(key);
  const count = byItemCount.get(key);
  console.log(`  ${fmt(bytes)} | 4K: ${fmt(b4k)} | ${String(count).padStart(5)} files | ${key}`);
}

const failures = [];
if (mb(totalBytes) > CEILINGS.installedFileMB) failures.push(`installed file size ${mb(totalBytes).toFixed(2)} MB exceeds ceiling ${CEILINGS.installedFileMB} MB`);
if (mb(total4k) > CEILINGS.installed4kMB) failures.push(`installed 4K-allocated size ${mb(total4k).toFixed(2)} MB exceeds ceiling ${CEILINGS.installed4kMB} MB`);
if (mb(runtimeBytes) > CEILINGS.runtimeFileMB) failures.push(`runtime file size ${mb(runtimeBytes).toFixed(2)} MB exceeds ceiling ${CEILINGS.runtimeFileMB} MB`);
if (mb(runtime4k) > CEILINGS.runtime4kMB) failures.push(`runtime 4K-allocated size ${mb(runtime4k).toFixed(2)} MB exceeds ceiling ${CEILINGS.runtime4kMB} MB`);
if (mb(nodeSize) > CEILINGS.nodeBinaryMB) failures.push(`bundled Node size ${mb(nodeSize).toFixed(2)} MB exceeds ceiling ${CEILINGS.nodeBinaryMB} MB`);
if (mb(desktopSize) > CEILINGS.desktopBinaryMB) failures.push(`Tauri shell size ${mb(desktopSize).toFixed(2)} MB exceeds ceiling ${CEILINGS.desktopBinaryMB} MB`);
for (const inst of installers) {
  if (mb(inst.size) > CEILINGS.downloadInstallerMB) failures.push(`installer ${inst.name} size ${mb(inst.size).toFixed(2)} MB exceeds ceiling ${CEILINGS.downloadInstallerMB} MB`);
}

if (failures.length > 0) {
  console.error('\nFAIL desktop bundle size budget exceeded:');
  for (const msg of failures) console.error(`  - ${msg}`);
  process.exit(1);
}
console.log('\nPASS desktop bundle size is within all stated budgets');
