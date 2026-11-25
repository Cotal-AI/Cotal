import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export function selectPublishedInstaller(releases) {
  assert.ok(Array.isArray(releases), 'GitHub releases response must be an array');
  for (const release of releases.slice(0, 3)) {
    if (release.draft || release.prerelease) continue;
    const version = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name)?.[1];
    if (!version) continue;
    assert.ok(Array.isArray(release.assets), `Published assets unavailable for ${version}`);
    const name = `Cotal_${version}_x64-setup.exe`;
    const assets = release.assets.filter(asset => asset.name === name);
    if (assets.length === 0) continue;
    assert.equal(assets.length, 1, `Duplicate published installer for ${version}`);
    assert.match(assets[0].digest ?? '', /^sha256:[a-f0-9]{64}$/, `Published asset digest unavailable for ${version}`);
    assert.equal(typeof assets[0].browser_download_url, 'string', `Published installer URL unavailable for ${version}`);
    return { version, name, digest: assets[0].digest, browser_download_url: assets[0].browser_download_url };
  }
  throw new Error('No verified Windows installer in the newest three GitHub releases');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.RELEASE_METADATA_TOKEN) headers.Authorization = `Bearer ${process.env.RELEASE_METADATA_TOKEN}`;
  const response = await fetch('https://api.github.com/repos/Cotal-AI/Cotal/releases?per_page=3', {
    headers, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub release listing failed: HTTP ${response.status}`);
  console.log(JSON.stringify(selectPublishedInstaller(await response.json())));
}
