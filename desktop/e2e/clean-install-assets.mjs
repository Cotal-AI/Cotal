import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [output, format, version] = process.argv.slice(2);
assert.ok(output && ['deb', 'rpm', 'dmg', 'exe'].includes(format));
const dir = resolve(output);
mkdirSync(dir, { recursive: true });
const win = process.platform === 'win32';
const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const broker = '2.15.1';
const archive = `nats-server-v${broker}-${os}-${arch}`;
const extension = win ? 'zip' : 'tar.gz';

async function release(repo, tag) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read release ${tag}: HTTP ${response.status}`);
  return (await response.json()).assets;
}
async function download(assets, name) {
  const asset = assets.find(item => item.name === name);
  assert.ok(asset, `Release is missing ${name}.`);
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) });
  assert.ok(response.ok && response.body, `Could not download ${name}: HTTP ${response.status}`);
  const path = join(dir, name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  if (asset.digest) await verify(path, asset.digest.replace(/^sha256:/, ''));
  return path;
}
async function verify(path, expected) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  assert.equal(digest.digest('hex'), expected, 'Release asset SHA-256 mismatch.');
}
const brokerAssets = await release('nats-io/nats-server', `v${broker}`);
assert.match(brokerAssets.find(item => item.name === `${archive}.${extension}`)?.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'The broker release must publish an archive digest.');
const archivePath = await download(brokerAssets, `${archive}.${extension}`);
if (win) execFileSync('tar.exe', ['-xf', archivePath, '-C', dir]);
else execFileSync('tar', ['-xf', archivePath, '-C', dir]);
if (version) {
  assert.match(version, /^0\.\d+\.\d+$/);
  const name = {
    deb: `Cotal_${version}_amd64.deb`, rpm: `Cotal-${version}-1.x86_64.rpm`,
    dmg: `Cotal_${version}_${arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`, exe: `Cotal_${version}_x64-setup.exe`,
  }[format];
  const assets = await release('Cotal-AI/Cotal', `v${version}`);
  const path = await download(assets, name);
  if (!assets.find(item => item.name === name).digest) console.log(`GitHub did not supply a SHA-256 digest for ${name}.`);
  if (format === 'dmg') execFileSync('/usr/bin/hdiutil', ['verify', path], { stdio: 'ignore' });
  if (format === 'exe') {
    const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:OLD_DESKTOP_INSTALLER; if ($s.Status -eq 'NotSigned') { 'The published installer is unsigned.' } elseif ($s.Status -ne 'Valid') { exit 1 }";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, OLD_DESKTOP_INSTALLER: path }, stdio: ['ignore', 'inherit', 'ignore'] });
  }
}
