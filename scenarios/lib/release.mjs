import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const api = 'https://api.github.com/repos/Cotal-AI/Cotal/releases?per_page=40';
const semver = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/** The desktop package this machine installs, named as the release publishes it. */
export function assetName(version, kind) {
  if (kind === 'deb') return `Cotal_${version}_amd64.deb`;
  if (kind === 'rpm') return `Cotal-${version}-1.x86_64.rpm`;
  if (kind === 'dmg') return `Cotal_${version}_${process.arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`;
  if (kind === 'exe') return `Cotal_${version}_x64-setup.exe`;
  throw new Error(`no desktop package kind '${kind}'`);
}

async function listReleases() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cotal-scenarios' };
  // A test VM gets the token as a file, so it never appears on a command line.
  const file = process.env.GITHUB_TOKEN_FILE;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(api, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GitHub release listing failed: HTTP ${response.status}`);
  return response.json();
}

function compare(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Published releases that carry this machine's package, newest first. `back` 0 is the target
 * (latest, or `version` when given); `back` N is the Nth older release that has the package.
 */
export async function pickRelease(kind, { version = 'latest', back = 0 } = {}) {
  const rows = [];
  for (const release of await listReleases()) {
    const v = semver.exec(release.tag_name)?.[1];
    if (!v || release.draft || release.prerelease) continue;
    const asset = release.assets.find((a) => a.name === assetName(v, kind));
    if (asset) rows.push({ version: v, asset });
  }
  rows.sort((a, b) => compare(b.version, a.version));
  const start = version === 'latest' ? 0 : rows.findIndex((row) => row.version === version);
  if (start < 0) throw new Error(`release ${version} has no published ${assetName(version, kind)}`);
  const row = rows[start + back];
  if (!row) throw new Error(`no release ${back} back from ${rows[start].version} has a ${kind} package`);
  return { version: row.version, name: row.asset.name, url: row.asset.browser_download_url, digest: row.asset.digest };
}

/** Downloads a release package and refuses it unless its sha256 matches the published digest. */
export async function download(release, directory) {
  if (!/^sha256:[0-9a-f]{64}$/.test(release.digest ?? '')) throw new Error(`${release.name} has no published sha256 digest`);
  const file = join(directory, release.name);
  if (!existsSync(file)) {
    const response = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`download of ${release.name} failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  }
  const actual = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  if (actual !== release.digest) throw new Error(`${release.name} digest ${actual} does not match published ${release.digest}`);
  return file;
}
