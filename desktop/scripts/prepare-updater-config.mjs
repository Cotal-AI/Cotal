import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_ENDPOINT = 'https://github.com/Cotal-AI/Cotal/releases/latest/download/desktop-latest.json';
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function decode(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid public key encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid public key encoding');
  return bytes;
}

// Tauri's helpers/updater_signature.rs encodes the entire minisign PublicKeyBox
// as base64. rust-minisign src/public_key.rs serializes two algorithm bytes,
// eight key-id bytes and 32 public-key bytes inside that box. This checks shape
// only, not key ownership, private/public correspondence or signing ability.
// Sources: https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs
// https://github.com/jedisct1/rust-minisign/blob/master/src/public_key.rs
export function publicKeyContents(value) {
  try {
    const encoded = value.trim();
    const bytes = decode(encoded);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (lines.length !== 2 || !/^untrusted comment: [^\r\n]+$/.test(lines[0])) throw new Error();
    const payload = decode(lines[1]);
    if (payload.length !== 42 || payload.subarray(0, 2).toString('ascii') !== 'Ed') throw new Error();
    return encoded;
  } catch {
    throw new Error('TAURI_SIGNING_PUBLIC_KEY must contain a base64-encoded minisign public key box');
  }
}

/** Write a merge overlay, preserving platform configuration in other overlays. */
export async function prepareUpdaterConfig(tag, version, output, env = process.env) {
  if (typeof version !== 'string' || !semver.test(version) || version.trim() !== version || tag !== `v${version}`) {
    throw new Error('Release tag must be exactly v<bin-version> with a valid bin version');
  }
  for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PUBLIC_KEY']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`Missing required ${name}`);
  }
  const pubkey = publicKeyContents(env.TAURI_SIGNING_PUBLIC_KEY);
  if (typeof output !== 'string' || !output) throw new Error('Missing output path');
  const contents = `${JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey, requireSignedVersion: true, endpoints: [UPDATE_ENDPOINT] } },
  }, null, 2)}\n`;
  // wx refuses existing files, directories and symlinks, including dangling ones.
  const file = await open(output, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(output);
    throw error;
  }
  return { COTAL_UPDATER_PUBLIC_KEY: pubkey };
}

// Usage: node desktop/scripts/prepare-updater-config.mjs <tag> <bin-version> <output.json>
// Supply bin/package.json's version as the second argument. Export the returned
// COTAL_UPDATER_PUBLIC_KEY for the same build that consumes this Tauri overlay.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: prepare-updater-config.mjs <tag> <bin-version> <output.json>');
    const guidance = await prepareUpdaterConfig(...process.argv.slice(2));
    console.log(JSON.stringify(guidance));
  } catch (error) {
    // Environment contents and private key material never enter diagnostics.
    console.error(error.code ? `Updater config output failed (${error.code})` : error.message);
    process.exitCode = 1;
  }
}
