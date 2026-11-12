import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle-specific keys prevent an MSI installation from receiving NSIS, or a deb
// installation from receiving an AppImage. Requires tauri-plugin-updater >= 2.14.
export const RELEASE_PLATFORMS = Object.freeze({
  'darwin-aarch64': '.app.tar.gz',
  'darwin-x86_64': '.app.tar.gz',
  'windows-x86_64-nsis': '-setup.exe',
  'windows-x86_64-msi': '.msi',
  'linux-x86_64-appimage': '.AppImage',
  'linux-x86_64-deb': '.deb',
  'linux-x86_64-rpm': '.rpm',
});
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`Invalid ${label} fields`);
  }
}
async function regularFile(root, file) {
  if (typeof file !== 'string' || isAbsolute(file)) throw new Error('Artifact path must be relative');
  const path = resolve(root, file);
  const inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Artifact path escapes root');
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0 || await realpath(path) !== path) throw new Error(`Expected nonempty regular file: ${file}`);
  return path;
}
function signatureContent(text) {
  const encoded = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
    throw new Error('Invalid signature encoding');
  }
  const lines = Buffer.from(encoded, 'base64').toString('utf8').trimEnd().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid minisign signature content');
  }
  for (const [line, length] of [[lines[1], 74], [lines[3], 64]]) {
    const bytes = Buffer.from(line, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== line) throw new Error('Invalid minisign signature payload');
  }
  return encoded;
}

/** Build a complete manifest from an explicit inventory, never from an asset glob. */
export async function generateManifest(inventory, artifactRoot) {
  fields(inventory, ['version', 'artifacts', 'notes'], 'inventory');
  const { version, artifacts, notes } = inventory;
  if (typeof version !== 'string' || !semver.test(version)) throw new Error('Missing or invalid release version');
  if (notes !== undefined && typeof notes !== 'string') throw new Error('Invalid release notes');
  if (!Array.isArray(artifacts)) throw new Error('Missing release artifacts');
  const root = await realpath(artifactRoot);
  const platforms = {};
  const names = new Set();
  for (const artifact of artifacts) {
    fields(artifact, ['platform', 'file'], 'artifact');
    const { platform, file } = artifact;
    if (!Object.hasOwn(RELEASE_PLATFORMS, platform)) throw new Error(`Unsupported platform: ${platform}`);
    if (Object.hasOwn(platforms, platform)) throw new Error(`Duplicate platform: ${platform}`);
    const path = await regularFile(root, file);
    const name = basename(path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || !name.endsWith(RELEASE_PLATFORMS[platform])) {
      throw new Error(`Unexpected artifact format for ${platform}`);
    }
    if (names.has(name)) throw new Error(`Duplicate release asset name: ${name}`);
    names.add(name);
    const signature = signatureContent(await readFile(await regularFile(root, `${file}.sig`), 'utf8'));
    platforms[platform] = {
      url: `https://github.com/Cotal-AI/Cotal/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
      signature,
    };
  }
  for (const platform of Object.keys(RELEASE_PLATFORMS)) {
    if (!Object.hasOwn(platforms, platform)) throw new Error(`Missing platform: ${platform}`);
  }
  return { version, ...(notes === undefined ? {} : { notes }), platforms };
}

// Inventory paths are relative to the inventory file. Validate everything before
// writing, so failure cannot publish a partial manifest. Output must be new.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node desktop/scripts/generate-updater-manifest.mjs <inventory.json> <latest.json>');
    const input = resolve(process.argv[2]);
    const manifest = await generateManifest(JSON.parse(await readFile(input, 'utf8')), dirname(input));
    await writeFile(resolve(process.argv[3]), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
