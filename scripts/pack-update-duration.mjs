import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { packCandidate } from './automatic-update-platform-baseline.mjs';
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
for (const [name, version] of [['source', '0.164.7'], ['target', '0.164.8']]) {
  const manifest = await packCandidate(join(output, name), version, resolve(import.meta.dirname, '..'));
  assert.equal(manifest.packages.length, 24);
  assert(manifest.packages.every(pkg => pkg.version === version));
}
writeFileSync(join(output, 'identity.json'), JSON.stringify({ source: '0.164.7', target: '0.164.8', implementation: JSON.parse(readFileSync(join(output, 'source/manifest.json'))).source,
  kind: 'packed fixed implementation, synthetic exact-version registry overlay, never published' }, null, 2));
