import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest, RELEASE_PLATFORMS } from './generate-updater-manifest.mjs';

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${label} fields`);
  }
}
function contained(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file)) throw new Error('Path must be nonempty and relative');
  const path = resolve(root, file);
  const tail = relative(root, path);
  if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('Path escapes root');
  return path;
}
async function plain(path, directory = false) {
  const info = await lstat(path);
  if (await realpath(path) !== path || (directory ? !info.isDirectory() : !info.isFile() || !info.size)) {
    throw new Error(`Expected ${directory ? 'directory' : 'nonempty regular file'} without symlinks: ${path}`);
  }
}

/** Merge explicit fragments, with artifact paths relative to each fragment's directory. */
export async function mergeUpdaterInventories({ artifactRoot, fragments, version, tag }) {
  if (typeof version !== 'string' || !version || tag !== `v${version}`) throw new Error('Tag must match release version');
  if (typeof artifactRoot !== 'string' || !artifactRoot) throw new Error('Explicit artifact root required');
  if (!Array.isArray(fragments) || !fragments.length) throw new Error('Explicit fragment paths required');
  const root = resolve(artifactRoot);
  await plain(root, true);
  const artifacts = [];
  const seen = new Set();
  for (const fragment of fragments) {
    const path = contained(root, fragment);
    if (seen.has(path)) throw new Error('Duplicate fragment path');
    seen.add(path);
    await plain(path);
    const inventory = JSON.parse(await readFile(path, 'utf8'));
    exact(inventory, ['version', 'artifacts'], 'fragment');
    if (inventory.version !== version) throw new Error('Fragment version mismatch');
    if (!Array.isArray(inventory.artifacts) || !inventory.artifacts.length) throw new Error('Fragment artifacts required');
    for (const artifact of inventory.artifacts) {
      exact(artifact, ['platform', 'file'], 'artifact');
      const asset = contained(dirname(path), artifact.file);
      contained(root, relative(root, asset));
      artifacts.push({ platform: artifact.platform, file: relative(root, asset).split(sep).join('/') });
    }
  }
  const order = Object.keys(RELEASE_PLATFORMS);
  artifacts.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform) || a.file.localeCompare(b.file, 'en'));
  const inventory = { version, artifacts };
  // The generator checks the seven-platform set, unique names, files and sidecar shapes.
  await generateManifest(inventory, root);
  return inventory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 7) throw new Error('Usage: node desktop/scripts/merge-updater-inventories.mjs <artifact-root> <version> <tag> <output.json> <fragment.json> [...]');
    const [artifactRoot, version, tag, output, ...fragments] = process.argv.slice(2);
    const inventory = await mergeUpdaterInventories({ artifactRoot, version, tag, fragments });
    const destination = contained(resolve(artifactRoot), relative(resolve(artifactRoot), resolve(output)));
    await plain(dirname(destination), true);
    await writeFile(destination, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
