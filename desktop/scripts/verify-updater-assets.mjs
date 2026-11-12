import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest } from './generate-updater-manifest.mjs';

async function plain(path, directory = false) {
  const info = await lstat(path);
  if (await realpath(path) !== path || (directory ? !info.isDirectory() : !info.isFile() || !info.size)) {
    throw new Error(`Expected ${directory ? 'directory' : 'nonempty regular file'} without symlinks: ${path}`);
  }
}
async function digest(path) {
  await plain(path);
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Compare a validated merged source inventory with a separate, flat release download. */
export async function verifyUpdaterAssets(inventoryPath, downloadedDir) {
  const input = resolve(inventoryPath);
  const root = dirname(input);
  const remote = resolve(downloadedDir);
  await plain(root, true);
  await plain(input);
  await plain(remote, true);
  if (remote === root || remote.startsWith(`${root}${sep}`) || root.startsWith(`${remote}${sep}`)) {
    throw new Error('Source inventory and downloaded assets must have separate roots');
  }
  const inventory = JSON.parse(await readFile(input, 'utf8'));
  await generateManifest(inventory, root);
  const expected = new Map();
  const aliases = new Set();
  for (const { file } of inventory.artifacts) {
    for (const source of [file, `${file}.sig`]) {
      const name = basename(source);
      const alias = name.toLowerCase();
      if (aliases.has(alias)) throw new Error(`Duplicate asset alias: ${name}`);
      aliases.add(alias);
      expected.set(name, resolve(root, source));
    }
  }
  const downloadedAliases = new Set();
  for (const name of await readdir(remote)) {
    await plain(resolve(remote, name));
    const alias = name.toLowerCase();
    if (downloadedAliases.has(alias) || (aliases.has(alias) && !expected.has(name))) {
      throw new Error(`Downloaded asset alias collision: ${name}`);
    }
    downloadedAliases.add(alias);
  }
  const files = [];
  for (const [name, source] of expected) {
    const local = await digest(source);
    const downloaded = await digest(resolve(remote, name));
    if (local.bytes !== downloaded.bytes || local.sha256 !== downloaded.sha256) {
      throw new Error(`Downloaded asset differs: ${name}`);
    }
    files.push({ name, ...local });
  }
  return { version: inventory.version, artifacts: inventory.artifacts.length, signatures: inventory.artifacts.length, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node desktop/scripts/verify-updater-assets.mjs <inventory.json> <downloaded-dir>');
    console.log(JSON.stringify(await verifyUpdaterAssets(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
