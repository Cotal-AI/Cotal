import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { shell } from './proc.mjs';

const dist = 'https://nodejs.org/dist/latest-v24.x/';

/** Version of the npm a person would run, or null when there is none on PATH. */
export async function npmOnPath() {
  const found = await shell('npm --version', { timeout: 60_000 });
  return found.code === 0 ? found.stdout.trim() : null;
}

/** Downloads the current Node 24 installer for this OS from nodejs.org and checks it against SHASUMS256.txt. */
export async function nodeInstaller(pattern, directory) {
  const sums = await (await fetch(`${dist}SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) })).text();
  const row = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, name]) => pattern.test(name ?? ''));
  if (!row) throw new Error(`nodejs.org lists no Node 24 file matching ${pattern}`);
  const [sha256, name] = row;
  const file = join(directory, name);
  const response = await fetch(`${dist}${name}`, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`download of ${name} failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) throw new Error(`${name} does not match nodejs.org's SHASUMS256.txt`);
  return file;
}
