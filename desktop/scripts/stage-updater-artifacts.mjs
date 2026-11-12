import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_PLATFORMS } from './generate-updater-manifest.mjs';

// Inputs identify the trusted build job, not an architecture inferred from a filename.
const targets = Object.freeze({
  'macOS/ARM64': [['darwin-aarch64', 'macos']],
  'macOS/X64': [['darwin-x86_64', 'macos']],
  'Linux/X64': [['linux-x86_64-appimage', 'appimage'], ['linux-x86_64-deb', 'deb'], ['linux-x86_64-rpm', 'rpm']],
  'Windows/X64': [['windows-x86_64-nsis', 'nsis'], ['windows-x86_64-msi', 'msi']],
});
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function plain(path, directory = false) {
  const stat = await lstat(path);
  if (await realpath(path) !== path || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size === 0)) {
    throw new Error(`Expected ${directory ? 'directory' : 'nonempty regular file'} without symlinks: ${path}`);
  }
}

/** Stage native Tauri bundle files and their opaque sidecars, without changing bytes. */
export async function stageUpdaterArtifacts({ os, arch, version, bundleRoot, outputDir }) {
  const selected = targets[`${os}/${arch}`];
  if (!selected) throw new Error(`Unsupported build platform: ${os}/${arch}`);
  if (typeof version !== 'string' || !semver.test(version)) throw new Error('Invalid release version');
  if (typeof bundleRoot !== 'string' || !bundleRoot || typeof outputDir !== 'string' || !outputDir) {
    throw new Error('Explicit bundle root and output directory required');
  }
  const root = resolve(bundleRoot);
  const output = resolve(outputDir);
  await plain(root, true);
  const inside = relative(root, output);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) {
    throw new Error('Output directory must be outside bundle root');
  }
  const sources = [];
  // Tauri places each bundle kind directly in its named directory. Do not walk
  // application contents, which may legitimately contain framework symlinks.
  for (const [platform, directory] of selected) {
    const folder = join(root, directory);
    await plain(folder, true);
    const suffix = RELEASE_PLATFORMS[platform];
    const candidates = (await readdir(folder)).filter(name => name.endsWith(suffix));
    if (candidates.length !== 1) throw new Error(`Expected one ${platform} artifact, found ${candidates.length}`);
    const source = join(folder, candidates[0]);
    await plain(source);
    await plain(`${source}.sig`);
    const file = `Cotal_${version}_${platform}${suffix}`;
    sources.push({ platform, file, source });
  }
  // Validate inputs before reserving the output. mkdir is exclusive, including
  // for existing empty directories or symlinks. Copies never overwrite assets.
  await plain(resolve(output, '..'), true);
  await mkdir(output);
  for (const { source, file } of sources) {
    await copyFile(source, join(output, file), constants.COPYFILE_EXCL);
    await copyFile(`${source}.sig`, join(output, `${file}.sig`), constants.COPYFILE_EXCL);
  }
  const inventory = { version, artifacts: sources.map(({ platform, file }) => ({ platform, file })) };
  await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 7) throw new Error('Usage: node desktop/scripts/stage-updater-artifacts.mjs <os> <arch> <version> <bundle-root> <output-dir>');
    const [os, arch, version, bundleRoot, outputDir] = process.argv.slice(2);
    await stageUpdaterArtifacts({ os, arch, version, bundleRoot, outputDir });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
